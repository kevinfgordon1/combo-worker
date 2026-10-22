// ProphetX live main-market prices for the odds relay (PROPHETX_RELAY=1).
//
// READ-ONLY. Uses only: /auth/login, /auth/refresh, /websocket/connection-config,
// /mm/get_sport_events, /v2/mm/get_markets and /v4/mm/websocket (push registration).
// It never calls an order endpoint, even though the key can trade.
//
// Flow (docs.prophetx.co "Integration with Websockets"):
//   1. login with PROPHETX_ACCESS_KEY + PROPHETX_SECRET_KEY -> access_token (~10 min), refreshed
//      with refresh_token before it expires (re-login on failure).
//   2. discover NFL / NCAAF / MLB events (get_sport_events by tournament id).
//   3. connect to the Talaria (Pusher wire protocol) host from connection-config, register the
//      event channels via POST /v4/mm/websocket (X-CFTC-Terminology: true), sign in, subscribe,
//      and consume v2.market_selections (base64 JSON: market_id, sport_event_id, info.selections).
//   4. REST get_markets snapshot per event at <= PROPHETX_REST_RPS (default 0.8/s), then the same
//      loop keeps cycling slowly as a backup/reconcile while push carries live updates.
//
// Selections: selections[i] is one side's ladder, best price first. `price` (v2) / `odds` (REST)
// is the American price a taker gets; `value` is the taker's max stake at that price (USD) and
// `quantity`/`stake` is what that stake wins. We publish size = value (stake available).
'use strict';

const DEFAULT_BASE = 'https://cash.api.prophetx.co/partner';
const TOURNAMENTS = Object.freeze({ NFL: 31, NCAAF: 27653, MLB: 109 });
const MAIN_SUBTYPES = new Set(['moneyline', 'spread', 'total']);
const DONE_STATUS = /ended|closed|cancel|settled|complete|finished|abandon/i;

function probFromAmerican(am) {
  const n = Number(am);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
}
function round4(n) { return Math.round(n * 10000) / 10000; }

// One side's ladder -> [{american, odds, size, to_win}], best (highest American) first.
function ladder(rows) {
  const out = [];
  for (const s of rows || []) {
    if (!s) continue;
    const american = Number(s.price != null ? s.price : s.odds);
    const size = Number(s.value);
    const p = probFromAmerican(american);
    if (p == null || !(size > 0)) continue;
    out.push({ american, odds: round4(p), size: Math.round(size * 100) / 100, to_win: Number(s.quantity != null ? s.quantity : s.stake) || null });
  }
  out.sort((a, b) => b.american - a.american);
  return out;
}
function sideMeta(rows) {
  const s = (rows || []).find(Boolean);
  if (!s) return null;
  const line = s.strike != null ? Number(s.strike) : (s.line != null ? Number(s.line) : null);
  return { name: String(s.name || s.display_name || ''), outcome_id: s.outcome_id, competitor_id: s.competitor_id, line: Number.isFinite(line) ? line : null };
}
function maxUpdatedNs(selections) {
  let m = 0;
  for (const side of selections || []) for (const s of side || []) if (s && Number(s.updated_at) > m) m = Number(s.updated_at);
  return m;
}
function nsToMs(n) {
  const v = Number(n);
  if (!(v > 0)) return 0;
  if (v > 1e17) return Math.floor(v / 1e6); // ns
  if (v > 1e14) return Math.floor(v / 1e3); // us
  if (v > 1e11) return v; // ms
  return v * 1000; // s
}

// REST v2 get_markets -> [{marketId, subType, type, lines:[{strike, selections}]}] for main markets.
function mainMarketsFromRest(markets) {
  const out = [];
  for (const m of markets || []) {
    const sub = String(m.sub_type || '').toLowerCase();
    if (!MAIN_SUBTYPES.has(sub)) continue;
    const lines = [];
    if (Array.isArray(m.market_lines)) {
      for (const ln of m.market_lines) lines.push({ strike: Number(ln.line), selections: ln.selections || [] });
    } else {
      lines.push({ strike: Number(m.line) || 0, selections: m.selections || [] });
    }
    out.push({ marketId: Number(m.id), subType: sub, type: String(m.type || sub), lines });
  }
  return out;
}

// Push frame (Pusher-style: data is a JSON string; payload is base64 JSON) -> update or null.
function decodePushFrame(frame) {
  if (!frame || frame.event !== 'v2.market_selections') return null;
  let d = frame.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { return null; } }
  if (!d) return null;
  let p = d.payload;
  if (typeof p === 'string') {
    try { p = JSON.parse(Buffer.from(p, 'base64').toString('utf8')); } catch (_) {
      try { p = JSON.parse(p); } catch (__) { return null; }
    }
  }
  if (!p || !p.info) return null;
  const info = p.info;
  return {
    op: d.op || 'u',
    eventId: Number(p.sport_event_id),
    marketId: Number(p.market_id != null ? p.market_id : info.id),
    strike: Number(info.strike != null ? info.strike : 0) || 0,
    status: info.status || 'active',
    type: info.type,
    seq: info.sequence_number != null ? Number(info.sequence_number) : null,
    selections: info.selections || [],
    sentAtMs: nsToMs(d.timestamp) || nsToMs(maxUpdatedNs(info.selections)),
  };
}

// Mirror the main-line choice of the other venues: one line per market, the most balanced
// (both sides' best prices closest to even). Moneyline has a single line.
function pickMainLine(lines) {
  let best = null; let bestScore = Infinity;
  for (const ln of lines) {
    const a = ladder(ln.selections[0]); const b = ladder(ln.selections[1]);
    if (!a.length || !b.length) continue;
    const score = Math.abs(a[0].odds - 0.5) + Math.abs(b[0].odds - 0.5);
    if (score < bestScore) { bestScore = score; best = ln; }
  }
  return best;
}

function quotesForEvent(ev, markets, now = Date.now()) {
  const out = [];
  for (const m of markets.values()) {
    const ln = pickMainLine([...m.lines.values()]);
    if (!ln) continue;
    for (let i = 0; i < 2; i += 1) {
      const lv = ladder(ln.selections[i]);
      const meta = sideMeta(ln.selections[i]);
      if (!lv.length || !meta) continue;
      const isTotal = m.subType === 'total';
      let side = meta.name;
      if (isTotal) side = /^over/i.test(meta.name) ? 'Over' : (/^under/i.test(meta.name) ? 'Under' : meta.name);
      else if (m.subType === 'spread') side = ev.competitorName.get(meta.competitor_id) || meta.name.replace(/\s*[+-]?\d+(\.\d+)?$/, '');
      const q = {
        book: 'prophetx',
        book_id: null,
        league: ev.league,
        away: ev.away,
        home: ev.home,
        side,
        bet_type: m.subType,
        odds: lv[0].odds,
        american: lv[0].american,
        size: lv[0].size,
        depth: lv.slice(0, 5).map((l) => ({ odds: l.odds, american: l.american, size: l.size })),
        is_alt: false,
        is_live: ev.isLive,
        token_id: `px:${ev.id}:${m.marketId}:${meta.outcome_id}`,
        market_id: `${ev.id}:${m.marketId}`,
        event_id: ev.id,
        seq: ln.seq == null ? null : ln.seq,
        start: ev.start,
        feed: ln.via,
        updated_at: new Date(ln.changedAt || now).toISOString(),
      };
      if (m.subType !== 'moneyline') {
        const line = meta.line != null ? meta.line : (i === 0 ? ln.strike : -ln.strike);
        q.line = isTotal ? Math.abs(line) : line;
        if (isTotal) q.side_type = side;
      }
      out.push(q);
    }
  }
  return out;
}

function createLatency() {
  const xs = [];
  return {
    add(ms) { if (Number.isFinite(ms) && ms >= 0 && ms < 600000) { xs.push(ms); if (xs.length > 2000) xs.shift(); } },
    stats() {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
      return { n: s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
    },
  };
}

function createProphetXFeed(opts = {}) {
  const env = opts.env || process.env;
  const fetchFn = opts.fetchFn || fetch;
  const WebSocketImpl = opts.WebSocket || require('ws');
  const log = opts.log || ((m) => console.log(m));
  const onQuotes = opts.onQuotes || (() => {});
  const base = env.PROPHETX_API_BASE_MM || env.PROPHETX_API_BASE || DEFAULT_BASE;
  const leagues = String(env.PROPHETX_LEAGUES || 'NFL,NCAAF,MLB').split(',').map((s) => s.trim().toUpperCase()).filter((l) => TOURNAMENTS[l]);
  const restGapMs = Math.max(1000 / Math.max(0.05, Math.min(1, Number(env.PROPHETX_REST_RPS) || 0.8)), 1000);
  const discoverMs = Number(env.PROPHETX_DISCOVER_MS) || 10 * 60 * 1000;
  const pushOn = String(env.PROPHETX_PUSH || '1') !== '0';

  const status = {
    rest: 'starting', ws: pushOn ? 'starting' : 'off', auth: 'starting',
    restCalls: 0, rest429: 0, restErrors: 0, lastRestError: null, lastRestAt: 0,
    wsMsgs: 0, wsUpdates: 0, wsIgnored: 0, wsConnects: 0, lastWsMsgAt: 0, lastWsUpdateAt: 0, lastWsError: null,
    channels: 0, channelLimit: null, rejected: 0, snapshotted: 0, lastCycleMs: null,
  };
  const latency = createLatency();
  const events = new Map(); // id -> ev
  let token = null; let refreshTok = null; let tokenExp = 0; let refreshExp = 0;
  let stopped = false; let ws = null; let socketId = null; let wsCfg = null;
  const subscribed = new Set(); // event ids with an authorized channel on this socket
  const timers = new Set();
  const dirty = new Set();
  let emitTimer = null;
  let lastRestCall = 0;

  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const sleep = (ms) => new Promise((r) => later(r, ms));

  async function login() {
    const r = await fetchFn(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_key: env.PROPHETX_ACCESS_KEY, secret_key: env.PROPHETX_SECRET_KEY }) });
    if (!r.ok) throw new Error(`login ${r.status}`);
    setTokens((await r.json()).data || {});
  }
  function setTokens(d) {
    if (!d.access_token) throw new Error('no access_token');
    token = d.access_token;
    if (d.refresh_token) refreshTok = d.refresh_token;
    const now = Date.now();
    tokenExp = d.access_expire_time ? nsToMs(d.access_expire_time) : now + 9 * 60 * 1000;
    if (!(tokenExp > now)) tokenExp = now + 9 * 60 * 1000;
    if (d.refresh_expire_time) refreshExp = nsToMs(d.refresh_expire_time);
    status.auth = 'ok';
  }
  async function ensureToken() {
    const now = Date.now();
    if (token && tokenExp - now > 90 * 1000) return token;
    if (refreshTok && (!refreshExp || refreshExp - now > 60 * 1000)) {
      try {
        const r = await fetchFn(`${base}/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: refreshTok }) });
        if (r.ok) { setTokens((await r.json()).data || {}); return token; }
      } catch (_) { /* fall through to login */ }
    }
    await login();
    return token;
  }
  async function api(path, init = {}, { rest = false } = {}) {
    if (rest) {
      const wait = lastRestCall + restGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastRestCall = Date.now();
    }
    const t = await ensureToken();
    const r = await fetchFn(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', ...(init.headers || {}) } });
    status.restCalls += 1;
    if (r.status === 429) { status.rest429 += 1; throw Object.assign(new Error(`429 ${path.split('?')[0]}`), { is429: true }); }
    if (r.status === 401) { token = null; }
    if (!r.ok) throw new Error(`${r.status} ${path.split('?')[0]}`);
    return r.json();
  }

  async function discover() {
    for (const league of leagues) {
      const j = await api(`/mm/get_sport_events?tournament_id=${TOURNAMENTS[league]}`, {}, { rest: true });
      const list = (j.data && (j.data.sport_events || j.data)) || [];
      const seen = new Set();
      for (const e of Array.isArray(list) ? list : []) {
        const id = Number(e.event_id);
        if (!id || DONE_STATUS.test(String(e.status || ''))) continue;
        seen.add(id);
        const comps = e.competitors || [];
        const home = comps.find((c) => c.side === 'home'); const away = comps.find((c) => c.side === 'away');
        if (!home || !away) continue;
        const prev = events.get(id);
        const ev = prev || { id, league, markets: new Map(), snapshotAt: 0 };
        ev.home = home.display_name || home.name; ev.away = away.display_name || away.name;
        ev.competitorName = new Map(comps.map((c) => [c.id, c.display_name || c.name]));
        ev.start = e.scheduled || null; ev.status = e.status; ev.isLive = /live|progress|started/i.test(String(e.status || '')) && !/not_started/i.test(String(e.status || ''));
        events.set(id, ev);
      }
      for (const [id, ev] of events) if (ev.league === league && !seen.has(id)) { events.delete(id); dirty.add(league); }
    }
    if (ws && socketId) await register().catch((e) => { status.lastWsError = e.message; });
  }

  function applyLines(ev, marketId, subType, type, lines, via, at, seq) {
    let m = ev.markets.get(marketId);
    if (!m) { m = { marketId, subType, type, lines: new Map() }; ev.markets.set(marketId, m); }
    for (const ln of lines) m.lines.set(String(ln.strike), { strike: ln.strike, selections: ln.selections, via, changedAt: at, seq: seq == null ? null : seq });
  }

  async function snapshot(ev) {
    const j = await api(`/v2/mm/get_markets?event_id=${ev.id}`, {}, { rest: true });
    const at = Date.now();
    const mains = mainMarketsFromRest((j.data && j.data.markets) || []);
    const keep = new Set(mains.map((m) => m.marketId));
    for (const id of ev.markets.keys()) if (!keep.has(id)) ev.markets.delete(id);
    for (const m of mains) {
      const cur = ev.markets.get(m.marketId);
      // A push from the last few seconds is newer than this REST read; keep it.
      const fresh = cur ? new Map([...cur.lines].filter(([, l]) => l.via === 'ws' && at - l.changedAt < 5000)) : new Map();
      if (cur) cur.lines = fresh;
      applyLines(ev, m.marketId, m.subType, m.type, m.lines.filter((l) => !fresh.has(String(l.strike))), 'rest', at, null);
      const mm = ev.markets.get(m.marketId);
      for (const [k] of mm.lines) if (!m.lines.some((l) => String(l.strike) === k) && !fresh.has(k)) mm.lines.delete(k);
    }
    ev.snapshotAt = at;
    status.snapshotted += 1;
    dirty.add(ev.league);
    scheduleEmit(0);
  }

  async function restLoop() {
    let lastDiscover = 0;
    while (!stopped) {
      const cycleStart = Date.now();
      try {
        if (!lastDiscover || Date.now() - lastDiscover > discoverMs) { await discover(); lastDiscover = Date.now(); }
        // never-snapshotted events first, then oldest.
        const order = [...events.values()].sort((a, b) => a.snapshotAt - b.snapshotAt);
        for (const ev of order) {
          if (stopped) return;
          if (!events.has(ev.id)) continue;
          try { await snapshot(ev); status.lastRestAt = Date.now(); status.rest = 'up'; } catch (e) {
            status.restErrors += 1; status.lastRestError = e.message;
            if (e.is429) await sleep(5000);
          }
          if (Date.now() - lastDiscover > discoverMs) break;
        }
        status.lastCycleMs = Date.now() - cycleStart;
      } catch (e) {
        status.restErrors += 1; status.lastRestError = e.message; status.rest = 'error';
        await sleep(e.is429 ? 10000 : 5000);
      }
      // While push is healthy REST is only a reconcile: wait between full cycles.
      const pushLive = status.ws === 'up' && Date.now() - status.lastWsMsgAt < 60000;
      await sleep(pushLive ? Number(env.PROPHETX_RECONCILE_GAP_MS) || 60000 : 1000);
    }
  }

  function scheduleEmit(ms = 250) {
    if (emitTimer) return;
    emitTimer = later(() => {
      emitTimer = null;
      const now = Date.now();
      for (const league of [...dirty]) {
        dirty.delete(league);
        const quotes = [];
        for (const ev of events.values()) if (ev.league === league) quotes.push(...quotesForEvent(ev, ev.markets, now));
        onQuotes(league, quotes, status.ws === 'up' ? 'ws' : 'rest');
      }
    }, ms);
  }

  function onPush(frame) {
    const u = decodePushFrame(frame);
    if (!u) return;
    const ev = events.get(u.eventId);
    const m = ev && ev.markets.get(u.marketId);
    if (!ev || !m) { status.wsIgnored += 1; return; } // not a main market (or not snapshotted yet)
    const now = Date.now();
    status.wsUpdates += 1; status.lastWsUpdateAt = now;
    if (u.sentAtMs) latency.add(now - u.sentAtMs);
    if (u.op === 'd' || !/active|open/i.test(String(u.status))) m.lines.delete(String(u.strike));
    else applyLines(ev, u.marketId, m.subType, m.type, [{ strike: u.strike, selections: u.selections }], 'ws', now, u.seq);
    dirty.add(ev.league);
    scheduleEmit();
  }

  async function register() {
    const ids = [...events.keys()].filter((id) => !subscribed.has(id));
    if (!ids.length || !ws || !socketId) return;
    const limit = status.channelLimit || 400;
    const room = Math.max(0, limit - status.channels);
    const want = ids.slice(0, room);
    if (!want.length) return;
    const all = [...subscribed, ...want].map(String);
    const j = await api('/v4/mm/websocket', { method: 'POST', headers: { 'X-CFTC-Terminology': 'true' }, body: JSON.stringify({ socket_id: socketId, service: 'pusher', subscriptions: [{ type: 'event', ids: all }] }) });
    const d = j.data || {};
    if (d.channel_limit) status.channelLimit = d.channel_limit;
    if (Array.isArray(d.rejected)) status.rejected += d.rejected.length;
    if (d.authenticated && !status.signedIn) { ws.send(JSON.stringify({ event: 'pusher:signin', data: d.authenticated })); status.signedIn = true; }
    for (const ch of d.authorized_channel || []) {
      const evId = ch.scope && ch.scope.event_id;
      if (!evId || subscribed.has(Number(evId))) continue; // only event channels (no private user / orders channel)
      ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: ch.auth, channel: ch.channel_name } }));
      subscribed.add(Number(evId));
    }
    status.channels = subscribed.size;
  }

  async function connect() {
    if (stopped || !pushOn) return;
    try {
      const cj = await api('/websocket/connection-config');
      wsCfg = cj.data || cj;
      const host = wsCfg.ws_host || `ws-${wsCfg.cluster}.pusher.com`;
      const url = `wss://${host}/app/${wsCfg.key}?protocol=7&client=js&version=8.4.0&flash=false`;
      subscribed.clear(); status.channels = 0; status.signedIn = false; socketId = null;
      ws = new WebSocketImpl(url);
      status.wsConnects += 1;
      const sock = ws;
      sock.on('message', (raw) => {
        let f; try { f = JSON.parse(String(raw)); } catch (_) { return; }
        status.lastWsMsgAt = Date.now(); status.wsMsgs += 1;
        if (f.event === 'pusher:connection_established') {
          try { socketId = JSON.parse(f.data).socket_id; } catch (_) { socketId = f.data && f.data.socket_id; }
          status.ws = 'up';
          register().catch((e) => { status.lastWsError = e.message; });
        } else if (f.event === 'pusher:ping') {
          sock.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
        } else if (f.event === 'pusher:error') {
          status.lastWsError = typeof f.data === 'string' ? f.data.slice(0, 200) : JSON.stringify(f.data).slice(0, 200);
        } else if (f.event === 'v2.market_selections') {
          onPush(f);
        }
      });
      const reconnect = (why) => {
        if (ws !== sock) return;
        ws = null; socketId = null; status.ws = 'down'; status.lastWsError = why;
        if (!stopped) later(connect, 3000);
      };
      sock.on('close', (code) => reconnect(`close ${code}`));
      sock.on('error', (e) => { status.lastWsError = e.message; try { sock.terminate(); } catch (_) { /* */ } reconnect(`error ${e.message}`); });
    } catch (e) {
      status.ws = 'down'; status.lastWsError = e.message;
      if (!stopped) later(connect, e.is429 ? 15000 : 5000);
    }
  }

  // Liveness: no frame for 90s -> reconnect. Every 30 min re-read connection-config.
  const watch = setInterval(async () => {
    if (!ws || stopped) return;
    if (status.lastWsMsgAt && Date.now() - status.lastWsMsgAt > 90000) { try { ws.terminate(); } catch (_) { /* */ } }
  }, 15000);
  const cfgWatch = setInterval(async () => {
    if (!ws || stopped) return;
    try {
      const cj = await api('/websocket/connection-config'); const c = cj.data || cj;
      if (wsCfg && (c.ws_host !== wsCfg.ws_host || c.key !== wsCfg.key)) { log('[prophetx] connection-config changed; reconnecting'); try { ws.terminate(); } catch (_) { /* */ } }
    } catch (_) { /* keep running */ }
  }, 30 * 60 * 1000);

  (async () => {
    try { await login(); } catch (e) { status.auth = `error: ${e.message}`; log(`[prophetx] login failed: ${e.message}`); }
    restLoop();
    connect();
  })();

  function health() {
    const counts = {}; const quotes = {};
    for (const l of leagues) { counts[l] = 0; quotes[l] = 0; }
    for (const ev of events.values()) { counts[ev.league] += 1; }
    const now = Date.now();
    return {
      ...status,
      leagues,
      events: counts,
      subscribedEvents: subscribed.size,
      lastWsMsgAgeMs: status.lastWsMsgAt ? now - status.lastWsMsgAt : null,
      lastWsUpdateAgeMs: status.lastWsUpdateAt ? now - status.lastWsUpdateAt : null,
      lastRestAgeMs: status.lastRestAt ? now - status.lastRestAt : null,
      pushLatencyMs: latency.stats(),
    };
  }

  return {
    status,
    health,
    stop() {
      stopped = true; clearInterval(watch); clearInterval(cfgWatch);
      for (const t of timers) clearTimeout(t);
      if (ws) { try { ws.close(); } catch (_) { /* */ } }
    },
  };
}

function prophetxRelayCreds(env = process.env) { return !!(env.PROPHETX_ACCESS_KEY && env.PROPHETX_SECRET_KEY); }

module.exports = { createProphetXFeed, prophetxRelayCreds, decodePushFrame, mainMarketsFromRest, quotesForEvent, ladder, pickMainLine, probFromAmerican, nsToMs, TOURNAMENTS };
