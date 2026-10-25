// Kalshi websocket order-book feed for the sniper (replaces the REST /markets/orderbooks pulls
// behind kalshi_ml_books / kalshi_books when live; REST stays as the fallback).
//
// - Subscribes `orderbook_delta` (snapshot + deltas) on the sniper's OWN read key.
// - Sharded: tickers are split across `shards` sockets of at most `perShard` tickers each so no
//   single subscription hits Kalshi's per-subscription buffer (error 25 overflow at peak). An
//   overflow / seq gap on one shard only resets that shard.
// - snapshot(tickers) returns REST-shaped books ({ ticker, orderbook_fp: { yes_dollars, no_dollars } })
//   so the existing ingestKalshiOrderbooks / tdBook.ingest sinks are unchanged.
// - live(tickers): true only when every requested ticker's shard is open, has its snapshot, and
//   has heard a frame or pong within quietMs. Callers treat !live as "use REST".
'use strict';

const OPEN = 1;

function lvlPx(v) { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return null; const p = n >= 1 ? n / 100 : n; return p > 0 && p < 1 ? p : null; }
function rowsOf(msg, side) {
  for (const k of [`${side}_dollars_fp`, `${side}_dollars`, side]) if (Array.isArray(msg[k])) return msg[k];
  return [];
}
function loadLevels(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const px = lvlPx(Array.isArray(r) ? r[0] : (r && (r.price_dollars != null ? r.price_dollars : r.price)));
    const q = Number(Array.isArray(r) ? r[1] : (r && (r.size != null ? r.size : r.count)));
    if (px != null && Number.isFinite(q) && q > 0) m.set(px.toFixed(4), q);
  }
  return m;
}
const asRows = (m) => [...m.entries()].map(([p, q]) => [p, String(q)]).sort((a, b) => Number(a[0]) - Number(b[0]));

function splitShards(tickers, perShard, maxShards) {
  const list = [...new Set(tickers)].sort();
  const n = Math.max(1, Math.min(maxShards, Math.ceil(list.length / perShard) || 1));
  const out = Array.from({ length: n }, () => []);
  list.forEach((t, i) => out[i % n].push(t));
  return out.filter((s) => s.length);
}

function createKalshiBookFeed({
  WS, url, headers = () => ({}), perShard = 60, maxShards = 8, quietMs = 10000,
  pingMs = 5000, reconnectMs = 2000, now = () => Date.now(), log = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
} = {}) {
  const books = new Map(); // ticker -> { yes: Map, no: Map, shard }
  let shards = []; // { id, tickers:Set, ws, sid, seq, ready:Set, aliveAt, ping, retry, gen }
  let want = [];
  let stopped = false;
  const stats = { snapshots: 0, deltas: 0, gaps: 0, overflows: 0, reconnects: 0, shards: 0 };

  function resetShard(s) { s.sid = null; s.seq = null; s.ready = new Set(); for (const t of s.tickers) books.delete(t); }
  function closeShard(s) {
    s.dead = true; if (s.ping) clearIntervalFn(s.ping); if (s.retry) clearTimer(s.retry);
    try { if (s.ws) { s.ws.removeAllListeners && s.ws.removeAllListeners(); s.ws.terminate ? s.ws.terminate() : s.ws.close(); } } catch (_) {}
    s.ws = null; resetShard(s);
  }
  function reopen(s, why) {
    if (stopped || s.dead) return;
    stats.reconnects += 1; log(`[SNIPER] book-ws shard ${s.id} reconnect: ${why}`);
    if (s.ping) clearIntervalFn(s.ping); s.ping = null;
    try { if (s.ws) { s.ws.removeAllListeners && s.ws.removeAllListeners(); s.ws.terminate ? s.ws.terminate() : s.ws.close(); } } catch (_) {}
    s.ws = null; resetShard(s);
    if (s.retry) return;
    s.retry = setTimer(() => { s.retry = null; open(s); }, reconnectMs);
  }
  function open(s) {
    if (stopped || s.dead) return;
    let ws;
    try { ws = new WS(url, { headers: headers(), perMessageDeflate: false }); } catch (e) { reopen(s, `ctor ${e.message}`); return; }
    s.ws = ws;
    ws.on('open', () => {
      s.aliveAt = now();
      try { ws.send(JSON.stringify({ id: s.id + 1, cmd: 'subscribe', params: { channels: ['orderbook_delta'], market_tickers: [...s.tickers] } })); } catch (e) { reopen(s, 'subscribe_send'); return; }
      s.ping = setIntervalFn(() => { try { if (ws.ping) ws.ping(); } catch (_) {} }, pingMs);
      if (s.ping && s.ping.unref) s.ping.unref();
    });
    ws.on('pong', () => { s.aliveAt = now(); });
    ws.on('message', (data) => onFrame(s, data));
    ws.on('close', () => { if (s.ws === ws) reopen(s, 'close'); });
    ws.on('error', (e) => { if (s.ws === ws) reopen(s, `error ${e && e.message}`); });
  }
  function onFrame(s, data) {
    s.aliveAt = now();
    let m; try { m = JSON.parse(String(data)); } catch (_) { return; }
    const type = String((m && m.type) || '');
    if (type === 'error') {
      const code = m.msg && m.msg.code;
      if (Number(code) === 25) stats.overflows += 1;
      reopen(s, `error code=${code}`); return;
    }
    if (type !== 'orderbook_snapshot' && type !== 'orderbook_delta') return;
    const msg = m.msg || {};
    const t = String(msg.market_ticker || msg.ticker || '').toUpperCase();
    if (!s.tickers.has(t)) return;
    if (m.sid != null) {
      const sid = Number(m.sid); const seq = Number(m.seq);
      if (s.sid == null) s.sid = sid;
      if (Number.isFinite(seq)) {
        if (s.seq != null && seq <= s.seq) return; // dup
        if (s.seq != null && seq !== s.seq + 1) { stats.gaps += 1; reopen(s, `seq gap ${s.seq}->${seq}`); return; }
        s.seq = seq;
      }
    }
    if (type === 'orderbook_snapshot') {
      books.set(t, { yes: loadLevels(rowsOf(msg, 'yes')), no: loadLevels(rowsOf(msg, 'no')) });
      s.ready.add(t); stats.snapshots += 1; return;
    }
    const b = books.get(t); if (!b) return; // delta before snapshot: ignored until snapshot
    const side = String(msg.side || '').toLowerCase(); if (side !== 'yes' && side !== 'no') return;
    const px = lvlPx(msg.price_dollars != null ? msg.price_dollars : msg.price);
    const d = Number(msg.delta_fp != null ? msg.delta_fp : msg.delta);
    if (px == null || !Number.isFinite(d)) return;
    const k = px.toFixed(4); const lv = b[side]; const nx = (lv.get(k) || 0) + d;
    if (nx <= 1e-9) lv.delete(k); else lv.set(k, nx);
    stats.deltas += 1;
  }

  // (Re)shard when the wanted ticker set changes. Unchanged shards keep their sockets.
  function setTickers(tickers) {
    const next = [...new Set((tickers || []).map((t) => String(t).toUpperCase()))].sort();
    if (next.join(',') === want.join(',')) return false;
    want = next;
    const groups = splitShards(next, perShard, maxShards);
    const keep = []; const used = new Set();
    for (const g of groups) {
      const key = g.join(',');
      const old = shards.find((s) => !used.has(s) && [...s.tickers].join(',') === key);
      if (old) { used.add(old); keep.push(old); continue; }
      const s = { id: 0, tickers: new Set(g), ws: null, sid: null, seq: null, ready: new Set(), aliveAt: 0, ping: null, retry: null, dead: false };
      keep.push(s); open(s);
    }
    for (const s of shards) if (!used.has(s)) closeShard(s);
    shards = keep; shards.forEach((s, i) => { s.id = i; });
    stats.shards = shards.length;
    return true;
  }
  const shardOf = (t) => shards.find((s) => s.tickers.has(t));
  function shardLive(s, at = now()) { return !!(s && s.ws && s.ws.readyState === OPEN && at - s.aliveAt <= quietMs); }
  // Every requested ticker covered by a live shard with its snapshot loaded.
  function live(tickers, at = now()) {
    for (const raw of tickers || []) {
      const t = String(raw).toUpperCase(); const s = shardOf(t);
      if (!s || !shardLive(s, at) || !s.ready.has(t)) return false;
    }
    return true;
  }
  function snapshot(tickers) {
    const out = [];
    for (const raw of tickers || []) {
      const t = String(raw).toUpperCase(); const b = books.get(t); if (!b) continue;
      out.push({ ticker: t, orderbook_fp: { yes_dollars: asRows(b.yes), no_dollars: asRows(b.no) } });
    }
    return out;
  }
  function stop() { stopped = true; for (const s of shards) closeShard(s); shards = []; }
  return { setTickers, live, snapshot, stop, stats: () => ({ ...stats, liveShards: shards.filter((s) => shardLive(s)).length }), _shards: () => shards };
}

// Routes ws books into the existing sinks per group and decides when REST must take over.
// groups: name -> { tickers: () => [...], sink: (orderbooks) => void, onFresh: (ms) => void }
// flush(): for each group whose tickers are all live on the ws feed, push the ws books into the
//   sink and call onFresh(now) — the same health stamp a successful REST pull sets, so the
//   prices_stale gate (health.ml age < 30s) keeps its meaning.
// restNeeded(name): true when the ws has not refreshed that group within fallbackMs (feed off,
//   socket down, quiet past quietMs, missing snapshot, or a shard resetting) -> REST pull runs.
function createBookRouter({ feed, groups, fallbackMs = 5000, now = () => Date.now() }) {
  const wsAt = new Map(); const stats = { wsFlushes: 0, restPulls: 0 };
  function flush() {
    if (!feed) return;
    const t = now();
    for (const [name, g] of Object.entries(groups)) {
      const tickers = g.tickers() || [];
      if (!tickers.length || !feed.live(tickers, t)) continue;
      g.sink(feed.snapshot(tickers)); wsAt.set(name, t); stats.wsFlushes += 1;
      if (g.onFresh) g.onFresh(t);
    }
  }
  function restNeeded(name) {
    const a = wsAt.get(name);
    const need = !feed || a == null || now() - a > fallbackMs;
    if (need) stats.restPulls += 1;
    return need;
  }
  const source = (name) => { const a = wsAt.get(name); return a != null && now() - a <= fallbackMs ? 'ws' : 'rest'; };
  return { flush, restNeeded, source, stats: () => ({ ...stats, src: Object.fromEntries(Object.keys(groups).map((n) => [n, source(n)])) }) };
}

module.exports = { createKalshiBookFeed, createBookRouter, splitShards, loadLevels };
