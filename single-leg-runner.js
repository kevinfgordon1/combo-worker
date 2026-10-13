// Runtime for single-leg locks (see single-leg.js for the rules).
// One instance per live-runner process = one user's keys (Kevin or a tester).
// State lives in public.combo_single_orders (one row per venue order) so a
// restart re-adopts resting orders instead of double-placing.
'use strict';

const crypto = require('crypto');
const SL = require('./single-leg');

const K_CREATE = '/trade-api/v2/portfolio/events/orders';
const kCancelPath = (id) => `/trade-api/v2/portfolio/events/orders/${encodeURIComponent(id)}`;
const kDecreasePath = (id) => `/trade-api/v2/portfolio/events/orders/${encodeURIComponent(id)}/decrease`;
const kGetPath = (id) => `/trade-api/v2/portfolio/orders/${encodeURIComponent(id)}`;
const kBookPath = (t) => `/trade-api/v2/markets/${encodeURIComponent(t)}/orderbook?depth=20`;
const POLY_GATEWAY = 'https://gateway.polymarket.us';
const TABLE = 'combo_single_orders';
const PLACE_BACKOFF_MS = 60_000;
const REJECT_ALERT_AFTER = 3;
const KALSHI_BOOK_MS = 3000;
const POLY_BOOK_MS = 10_000; // Poly gateway locks out after ~6 quick book reads
const CANCEL_FAILED = 'cancel failed';
const num = (v) => { const n = parseFloat(v && typeof v === 'object' ? v.value : v); return Number.isFinite(n) ? n : 0; };
const am = (c) => SL.fmtAmerican(SL.americanFromCost(c));

function kalshiOrderState(o) {
  const st = String((o && o.status) || '').toLowerCase();
  return {
    filled: num(o && (o.fill_count_fp != null ? o.fill_count_fp : o.fill_count)),
    open: st === 'resting' ? num(o && (o.remaining_count_fp != null ? o.remaining_count_fp : o.remaining_count)) : 0,
    dead: st === 'canceled' || st === 'cancelled' || st === 'executed',
  };
}
function polyOrderState(o) {
  const st = String((o && o.state) || '').toUpperCase();
  const qty = num(o && (o.quantity != null ? o.quantity : o.qty));
  const filled = num(o && (o.cumQuantity != null ? o.cumQuantity : o.cum_quantity));
  const leaves = o && (o.leavesQuantity != null ? num(o.leavesQuantity) : Math.max(0, qty - filled));
  const dead = /FILLED$|CANCEL|REJECT|EXPIRED/.test(st) && !/PARTIALLY/.test(st);
  return { filled, open: dead ? 0 : leaves, dead };
}
// Which side the hedge actually bought (combo_fills.outcome_side).
function hedgeSide(row) {
  const h = String((row && row.hedge) || '').toUpperCase();
  if (h === 'YES' || h === 'ORDER_INTENT_BUY_LONG') return 'yes';
  return 'no';
}

function createSingleLegRunner({
  env = process.env,
  supabase,
  kalshiSigned,           // (method, signPath, {path, body}) => {statusCode, text}
  polyHttp = null,        // createPolymarketHttp(...) or null when no Poly key
  fetchImpl = (typeof fetch === 'function' ? fetch : null), // keyless Poly gateway reads
  seriesFees,
  getParlays,             // () => active, unpaused, allowlisted locks
  userIds = null,         // this process's users (worker-scope); null = no filter (tests)
  isBlocked,              // (userId, lock) => true when kill switch / caps / credits block
  sendAlert,
  log = console.log,
  now = Date.now,
} = {}) {
  const mode = SL.readMode(env);
  const live = mode === 'live';
  const pollMs = Math.max(1000, Number(env.SINGLE_LEG_POLL_MS) || 1500);
  const kalshiShare = env.SINGLE_LEG_KALSHI_SHARE != null && env.SINGLE_LEG_KALSHI_SHARE !== '' ? Number(env.SINGLE_LEG_KALSHI_SHARE) : 0.5;
  const orders = new Map();   // rowKey -> row (combo_single_orders shape + runtime)
  const polyMarkets = new Map(); // ticker -> { slug, intent, tick } | { miss: true, at }
  const placeBackoff = new Map(); // `${lock}:${venue}` -> until ms
  const rejects = new Map(); // `${lock}:${venue}` -> consecutive failures
  const books = new Map(); // `${venue}:${market}` -> { at, asks }
  const dryLast = new Map(); // lockId -> last dry summary
  const overAlerted = new Set();
  let timer = null;
  let busy = false;
  let loaded = false;
  const polySlugsUsed = new Set();
  const alert = (m) => { Promise.resolve(sendAlert && sendAlert(m)).catch(() => {}); };

  const L = (m) => log(`[SINGLE] ${m}`);

  async function kCall(method, path, body) {
    const { statusCode, text } = await kalshiSigned(method, path.split('?')[0], { path, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : undefined });
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { statusCode, json, text };
  }
  async function gateway(path) {
    if (!fetchImpl) return null;
    const r = await fetchImpl(`${POLY_GATEWAY}${path}`, { headers: { accept: 'application/json' } });
    if (!r || !r.ok) return null;
    return r.json();
  }

  async function saveRow(row) {
    if (!live) return;
    const rec = {
      parlay_id: row.parlay_id, user_id: row.user_id, venue: row.venue, order_id: row.order_id,
      market: row.market, hedge: row.hedge, price: row.price, size: row.size, filled: row.filled,
      open: row.open, status: row.status, last_error: row.last_error || null, updated_at: new Date(now()).toISOString(),
    };
    try {
      const { error } = await supabase.from(TABLE).upsert(rec, { onConflict: 'venue,order_id' });
      if (error) L(`save ${row.venue} ${row.order_id}: ${error.message}`);
    } catch (e) { L(`save ${row.venue}: ${e && e.message}`); }
  }

  async function loadOpen() {
    try {
      let q = supabase.from(TABLE).select('*').eq('status', 'resting');
      if (userIds && q.in) q = q.in('user_id', [...userIds]);
      const { data, error } = await q;
      if (error) { L(`load: ${error.message}`); return false; }
      for (const r of (data || []).filter((x) => !userIds || userIds.includes(x.user_id))) {
        const row = { ...r, pending: String(r.last_error || '').startsWith(CANCEL_FAILED) };
        orders.set(`${r.venue}:${r.order_id}`, row);
        if (r.venue === 'polymarket') polySlugsUsed.add(r.market);
      }
      return true;
    } catch (e) { L(`load: ${e && e.message}`); return false; }
  }

  const filledTotals = new Map(); // `${lock}:${venue}` -> filled across closed orders
  async function loadClosedFilled(lockId) {
    const key = `${lockId}:loaded`;
    if (filledTotals.has(key)) return;
    const { data } = await supabase.from(TABLE).select('venue,filled,status,order_id').eq('parlay_id', lockId);
    for (const r of data || []) {
      if (r.status === 'resting' && orders.has(`${r.venue}:${r.order_id}`)) continue;
      const k = `${lockId}:${r.venue}`;
      filledTotals.set(k, (filledTotals.get(k) || 0) + (Number(r.filled) || 0));
    }
    filledTotals.set(key, true);
  }

  async function recordFill(row, delta, lock) {
    const cost = Number(row.price);
    const side = hedgeSide(row);
    const fillId = row.venue === 'polymarket'
      ? `poly-act:sl:${row.order_id}:${row.filled}`
      : `sl-k:${row.order_id}:${row.filled}`;
    // no_price = what we paid per contract for the hedge (the convention every
    // History / tape reader uses); outcome_side = the side actually bought.
    const fill = {
      fill_id: fillId, order_id: row.order_id, parlay_id: row.parlay_id, user_id: row.user_id,
      ticker: row.market, count: delta, is_combo: true, is_taker: !!row.taker,
      outcome_side: side, action: 'buy', no_price: cost, yes_price: Math.round((1 - cost) * 1e6) / 1e6,
      kalshi_created_time: new Date(now()).toISOString(),
      raw: { source: 'single-leg', venue: row.venue, hedge: row.hedge, hedge_side: side, taker: !!row.taker, label: lock && lock.label },
    };
    try {
      const { error } = await supabase.from('combo_fills').insert(fill);
      if (error && !/duplicate/i.test(error.message)) L(`fill insert ${fillId}: ${error.message}`);
    } catch (e) { L(`fill insert: ${e && e.message}`); }
    const venue = row.venue === 'polymarket' ? 'Polymarket' : 'Kalshi';
    const odds = lock && lock.fill_american != null ? ` · lock ${SL.fmtAmerican(Number(lock.fill_american))}` : '';
    alert(`✅ FILL (${venue}, single leg${row.taker ? ', taker' : ''}) — ${(lock && lock.label) || row.market}\n${delta} contracts ${side.toUpperCase()} @ ${am(cost)}${odds} · filled ${row.filled}/${row.size}`);
  }

  function closeRow(row) {
    orders.delete(`${row.venue}:${row.order_id}`);
    const k = `${row.parlay_id}:${row.venue}`;
    filledTotals.set(k, (filledTotals.get(k) || 0) + (Number(row.filled) || 0));
  }

  // Returns true when the read succeeded.
  async function refreshOrder(row, lock) {
    let st;
    try {
      if (row.venue === 'kalshi') {
        const r = await kCall('GET', kGetPath(row.order_id));
        if (r.statusCode === 404) st = { filled: Number(row.filled) || 0, open: 0, dead: true };
        else if (r.statusCode >= 300) throw new Error(`GET ${r.statusCode}`);
        else st = kalshiOrderState((r.json && r.json.order) || r.json);
      } else {
        const o = await polyHttp.getOrder(row.order_id);
        st = o ? polyOrderState(o) : { filled: Number(row.filled) || 0, open: 0, dead: true };
      }
    } catch (e) {
      row.stale = true; // unknown => counted as fully open (never re-placed on top)
      return false;
    }
    row.stale = false;
    const delta = Math.round((st.filled - (Number(row.filled) || 0)) * 100) / 100;
    row.filled = st.filled;
    row.open = st.open;
    if (st.dead || st.open <= 0) {
      row.status = st.filled >= Number(row.size) ? 'filled' : 'canceled';
      row.pending = false;
    }
    if (delta > 0) await recordFill(row, delta, lock);
    if (delta > 0 || row.status !== 'resting') await saveRow(row);
    if (row.status !== 'resting') closeRow(row);
    return true;
  }

  async function polyMarketFor(leg) {
    if (!polyHttp || !leg) return null;
    const hit = polyMarkets.get(leg.ticker);
    if (hit && !hit.miss) return hit;
    if (hit && hit.miss && now() - hit.at < 10 * 60_000) return null;
    const prop = SL.propPolyRef(leg);
    if (prop) {
      for (const es of prop.eventSlugs) {
        try {
          const j = await gateway(`/v1/events/slug/${encodeURIComponent(es)}`);
          const ev = j && (j.event || j);
          const m = ev && SL.findPropMarket(ev, prop);
          if (!m || !m.slug) continue;
          const tick = Number(m.orderPriceMinTickSize) > 0 ? Number(m.orderPriceMinTickSize) : 0.01;
          const out = { slug: m.slug, intent: SL.propIntent(leg), tick: Math.max(tick, 0.001) };
          polyMarkets.set(leg.ticker, out);
          return out;
        } catch (_) { /* try next */ }
      }
    } else {
      for (const slug of SL.polySlugCandidates(leg.ticker)) {
        try {
          const m = await polyHttp.getMarketBySlug(slug);
          if (!m) continue;
          const h = SL.polyHedgeIntent(leg, m);
          if (!h) continue;
          const tick = Number(m.orderPriceMinTickSize) > 0 ? Number(m.orderPriceMinTickSize) : 0.01;
          const out = { slug, intent: h.intent, tick: Math.max(tick, 0.001) };
          polyMarkets.set(leg.ticker, out);
          return out;
        } catch (_) { /* try next */ }
      }
    }
    polyMarkets.set(leg.ticker, { miss: true, at: now() });
    return null;
  }

  // Asks on the hedge side, cost per contract, best first. Cached per venue.
  async function asksFor(venue, market, buy) {
    const key = `${venue}:${market}:${buy}`;
    const hit = books.get(key);
    const ttl = venue === 'kalshi' ? KALSHI_BOOK_MS : POLY_BOOK_MS;
    if (hit && now() - hit.at < ttl) return hit.asks;
    let asks = null;
    try {
      if (venue === 'kalshi') {
        const r = await kCall('GET', kBookPath(market));
        if (r.statusCode < 300 && r.json) asks = SL.kalshiAsks(r.json, buy);
      } else {
        const j = await gateway(`/v1/markets/${encodeURIComponent(market)}/book`);
        if (j) asks = SL.polyAsks(j, buy);
      }
    } catch (_) { asks = null; }
    books.set(key, { at: now(), asks: asks || (hit && hit.asks) || null });
    return asks || (hit && hit.asks) || null;
  }

  // Everything we need to price one venue for a lock right now.
  async function venueQuote(lock, venue) {
    const leg = lock.legs.filter((l) => l && l.ticker)[0];
    const target = SL.hedgeTarget(lock.fill_american);
    if (target == null) return null;
    if (venue === 'kalshi') {
      const k = seriesFees ? seriesFees.rateForTicker(leg.ticker) : 0.035;
      const h = SL.kalshiHedge(leg, lock.fill_american, k);
      if (!h) return null;
      const lockCost = h.priceCents / 100;
      const asks = await asksFor('kalshi', h.ticker, h.side);
      const rest = SL.restCost(lockCost, asks, 0.01);
      return {
        venue, market: h.ticker, side: h.side, tick: 0.01, makerK: k, takerK: SL.KALSHI_TAKER_K,
        target, lockCost, restCost: rest, asks,
        take: asks ? SL.takePlan(asks, target, SL.KALSHI_TAKER_K, Infinity) : null,
      };
    }
    const pm = await polyMarketFor(leg);
    if (!pm) return null;
    const lockCost = SL.polyHedgeCost(lock.fill_american, pm.tick);
    if (lockCost == null) return null;
    const asks = await asksFor('polymarket', pm.slug, pm.intent);
    return {
      venue, market: pm.slug, side: pm.intent, intent: pm.intent, tick: pm.tick, makerK: 0, takerK: SL.POLY_TAKER_THETA,
      target, lockCost, restCost: SL.restCost(lockCost, asks, pm.tick), asks,
      take: asks ? SL.takePlan(asks, target, SL.POLY_TAKER_THETA, Infinity) : null,
    };
  }

  function priceNote(q, cost) {
    const fee = q.venue === 'kalshi' ? SL.takerFee(q.makerK, cost) : 0;
    return `${am(cost)} before fees / ${am(cost + fee)} after (lock needs ${am(q.target)})`;
  }

  async function cancelRow(row, why, plan) {
    if (!live) { plan.push(`cancel ${row.venue} ${row.order_id} (${why})`); return true; }
    let ok = true;
    try {
      if (row.venue === 'kalshi') {
        const r = await kCall('DELETE', `${kCancelPath(row.order_id)}?exchange_index=0`);
        if (r.statusCode >= 300 && r.statusCode !== 404) throw new Error(`${r.statusCode} ${r.text}`);
      } else {
        await polyHttp.cancelOrder(row.order_id, row.market);
      }
      L(`cancel ${row.venue} ${row.market} ${row.order_id} (${why})`);
    } catch (e) {
      ok = false;
      if (!row.pending) alert(`🚨 CRITICAL single-leg cancel failed (${row.venue}) ${row.market} order ${row.order_id}: ${e && e.message}. Still tracked; retrying every poll.`);
      row.pending = true;
      row.last_error = `${CANCEL_FAILED}: ${e && e.message}`;
    }
    // Final read books any fill that landed first. The row only leaves
    // tracking when the venue says it is closed.
    const read = await refreshOrder(row, null);
    if (ok && row.status === 'resting') {
      if (read) { row.pending = true; row.last_error = `${CANCEL_FAILED}: still resting after cancel`; }
      else { row.pending = true; row.last_error = `${CANCEL_FAILED}: unconfirmed`; }
    }
    if (row.status === 'resting') await saveRow(row);
    return row.status !== 'resting';
  }

  async function resizeRow(row, size, lock, plan) {
    if (!live) { plan.push(`shrink ${row.venue} ${row.order_id} -> ${size}`); return; }
    if (row.venue === 'kalshi') {
      try {
        const r = await kCall('POST', kDecreasePath(row.order_id), { reduce_to: size.toFixed(2), exchange_index: 0 });
        if (r.statusCode >= 300) throw new Error(`${r.statusCode} ${r.text}`);
        row.open = size; await saveRow(row);
        L(`shrink kalshi ${row.market} -> ${size}`);
      } catch (e) { await cancelRow(row, `shrink failed: ${e && e.message}`, plan); }
      return;
    }
    // Polymarket: cancel; the next poll re-rests whatever room is left.
    await cancelRow(row, 'shrink', plan);
  }

  function noteReject(lock, venue, msg) {
    const bk = `${lock.id}:${venue}`;
    const n = (rejects.get(bk) || 0) + 1;
    rejects.set(bk, n);
    placeBackoff.set(bk, now() + PLACE_BACKOFF_MS);
    L(`place ${venue} ${lock.label || lock.id} failed (${n}x): ${msg}`);
    if (n === REJECT_ALERT_AFTER) alert(`🚨 CRITICAL single-leg ${venue} order rejected ${n}x in a row — ${lock.label || lock.id}: ${msg}. Lock is not hedged on ${venue}.`);
  }

  // kind: 'rest' (maker-only) | 'take' (IOC)
  async function placeVenue(lock, q, size, kind, plan) {
    const bk = `${lock.id}:${q.venue}`;
    if ((placeBackoff.get(bk) || 0) > now()) return;
    const qty = Math.floor(size);
    if (qty < 1) return;
    const taker = kind === 'take';
    const cost = taker ? q.take.worstCost : q.restCost;
    if (cost == null) { plan.push(`${q.venue}: no price that doesn't cross`); return; }
    const px = taker
      ? `${am(cost)} worst before fees / ${am(q.take.avgNet)} avg after (lock needs ${am(q.target)})`
      : priceNote(q, cost, false);
    const desc = `${taker ? 'TAKE' : 'rest'} ${q.venue} ${q.market} ${q.venue === 'kalshi' ? q.side.toUpperCase() : q.side.replace('ORDER_INTENT_', '')} ${qty} @ ${Math.round(cost * 10000) / 100}¢ · ${px}`;
    let row;
    try {
      if (q.venue === 'kalshi') {
        const cents = Math.round(cost * 100);
        // V2 orders quote the YES book: buying NO at c == ask YES at 1-c.
        const body = {
          ticker: q.market, client_order_id: crypto.randomUUID(),
          side: q.side === 'yes' ? 'bid' : 'ask',
          count: qty.toFixed(2),
          price: ((q.side === 'yes' ? cents : 100 - cents) / 100).toFixed(4),
          time_in_force: taker ? 'immediate_or_cancel' : 'good_till_canceled',
          self_trade_prevention_type: 'maker', exchange_index: 0,
        };
        if (!taker) body.post_only = true;
        if (!live) { plan.push(desc); return; }
        const r = await kCall('POST', K_CREATE, body);
        if (r.statusCode >= 300) throw new Error(`${r.statusCode} ${String(r.text).slice(0, 200)}`);
        const id = r.json && (r.json.order_id || (r.json.order && r.json.order.order_id));
        if (!id) throw new Error('no order_id');
        row = { venue: q.venue, order_id: String(id), market: q.market, hedge: q.side, price: cents / 100 };
      } else {
        const body = SL.polyOrderBody({ slug: q.market, intent: q.intent, cost, qty, tick: q.tick, taker });
        if (!live) { plan.push(desc); return; }
        const created = await polyHttp.createOrder(body);
        const id = created && (created.id || (created.order && created.order.id));
        if (!id) throw new Error('no order id');
        row = { venue: q.venue, order_id: String(id), market: q.market, hedge: q.intent, price: cost };
      }
    } catch (e) {
      noteReject(lock, q.venue, e && e.message);
      return;
    }
    rejects.delete(bk);
    // IOC orders are tracked as open until the next read says how much filled.
    Object.assign(row, { parlay_id: lock.id, user_id: lock.user_id, size: qty, filled: 0, open: qty, status: 'resting', taker });
    orders.set(`${q.venue}:${row.order_id}`, row);
    if (q.venue === 'polymarket') polySlugsUsed.add(row.market);
    await saveRow(row);
    L(desc);
  }

  function venueState(lockId, v, rows, want, enabled) {
    return {
      filled: (filledTotals.get(`${lockId}:${v}`) || 0) + rows.reduce((n, r) => n + (Number(r.filled) || 0), 0),
      // stale / cancel-failed orders count as fully open so we never stack on them.
      open: rows.reduce((n, r) => n + ((r.stale || r.pending) ? Math.max(0, Number(r.size) - Number(r.filled || 0)) : Number(r.open) || 0), 0),
      pending: rows.filter((r) => r.pending || r.stale).reduce((n, r) => n + Math.max(0, Number(r.size) - Number(r.filled || 0)), 0),
      price: rows.filter((r) => !r.pending && !r.taker).length ? Number(rows.filter((r) => !r.pending && !r.taker)[0].price) : null,
      wantPrice: want,
      enabled,
    };
  }

  async function processLock(lockId, lock) {
    const plan = [];
    await loadClosedFilled(lockId);
    for (const r of [...orders.values()].filter((x) => x.parlay_id === lockId)) await refreshOrder(r, lock);
    // Retry cancels that failed before (the order stays tracked meanwhile).
    for (const r of [...orders.values()].filter((x) => x.parlay_id === lockId && x.pending && x.status === 'resting')) {
      await cancelRow(r, 'retry failed cancel', plan);
    }
    const startMs = lock ? SL.lockStartMs(lock) : null;
    const active = !!lock && SL.isSingleLegLock(lock) && !SL.cancelHeld(lock)
      && !(startMs != null && now() >= startMs) && !isBlocked(lock.user_id, lock);

    const quotes = {};
    if (active) {
      quotes.kalshi = await venueQuote(lock, 'kalshi').catch(() => null);
      quotes.polymarket = polyHttp ? await venueQuote(lock, 'polymarket').catch(() => null) : null;
    }
    const build = () => {
      const liveRows = [...orders.values()].filter((r) => r.parlay_id === lockId);
      const venues = {};
      for (const v of ['kalshi', 'polymarket']) {
        const q = quotes[v];
        venues[v] = venueState(lockId, v, liveRows.filter((r) => r.venue === v), q ? q.restCost : null, !!(q && q.restCost != null));
      }
      return { liveRows, venues };
    };
    let { liveRows, venues } = build();
    let plan0 = SL.planCrossVenue({ cap: lock ? lock.max_contracts : 0, venues, active, kalshiShare });
    if (plan0.over > 0 && !overAlerted.has(lockId)) {
      overAlerted.add(lockId);
      alert(`🚨 CRITICAL single-leg OVER-HEDGED ${(lock && lock.label) || lockId}: filled ${plan0.filled} vs cap ${lock && lock.max_contracts} (+${plan0.over}). Resting orders cancelled; excess NOT sold back — review now.`);
    }

    // 1) Taker: best acceptable venue first, only into room no other order holds.
    if (active && plan0.remaining > 0) {
      const takers = ['kalshi', 'polymarket'].map((v) => quotes[v]).filter((q) => q && q.take && q.take.qty >= 1)
        .sort((a, b) => a.take.avgNet - b.take.avgNet);
      if (takers.length) {
        const pendingAny = Object.values(venues).some((s) => s.pending > 0);
        if (pendingAny) plan.push('taker skipped: an order is waiting on a failed cancel');
        else {
          // Pull our resting orders first so take + resting never exceeds the cap.
          for (const r of liveRows.filter((x) => x.status === 'resting' && !x.taker)) await cancelRow(r, 'taking instead', plan);
          ({ liveRows, venues } = build());
          plan0 = SL.planCrossVenue({ cap: lock.max_contracts, venues, active: false });
          let room = plan0.remaining - Object.values(venues).reduce((n, s) => n + s.open, 0);
          if (!Object.values(venues).some((s) => s.pending > 0)) {
            for (const q of takers) {
              if (room < 1) break;
              const qty = Math.min(q.take.qty, room);
              await placeVenue(lock, q, qty, 'take', plan);
              room -= qty;
            }
          }
          return finish(lockId, lock, plan);
        }
      }
    }

    // 2) Maker rests, split across venues so a double fill can't pass the cap.
    for (const a of plan0.actions) {
      const rows = liveRows.filter((r) => r.venue === a.venue && r.status === 'resting' && !r.pending && !r.stale);
      if (a.op === 'cancel') {
        for (const r of rows) await cancelRow(r, a.reprice ? 'reprice' : (active ? 'cap' : 'inactive'), plan);
      } else if (a.op === 'resize') {
        // Shrink rows one by one until the venue's open size equals a.size.
        let keep = a.size;
        for (const r of rows) {
          const o = Number(r.open) || 0;
          if (o <= keep) { keep -= o; continue; }
          if (keep > 0) { await resizeRow(r, keep, lock, plan); keep = 0; } else await cancelRow(r, 'cap', plan);
        }
      }
    }
    // Re-plan after the shrinks so a failed cancel (now pending) blocks any
    // place on top of it, and only room that is really free gets used.
    if (plan0.actions.some((a) => a.op !== 'place')) {
      ({ liveRows, venues } = build());
      plan0 = SL.planCrossVenue({ cap: lock ? lock.max_contracts : 0, venues, active, kalshiShare });
    }
    for (const a of plan0.actions.filter((x) => x.op === 'place')) {
      const q = quotes[a.venue];
      if (q) await placeVenue(lock, q, a.size, 'rest', plan);
    }
    if (active && !quotes.polymarket && polyHttp) plan.push('polymarket: no matching market');
    return finish(lockId, lock, plan);
  }

  // Dry mode: one summary line per lock, only when the intended action changes.
  function finish(lockId, lock, plan) {
    if (live) return;
    const s = plan.length ? plan.join(' | ') : 'no action';
    if (dryLast.get(lockId) === s) return;
    dryLast.set(lockId, s);
    L(`DRY ${(lock && lock.label) || lockId} (cap ${lock ? lock.max_contracts : 0}, lock ${lock ? SL.fmtAmerican(Number(lock.fill_american)) : '?'}): ${s}`);
  }

  async function tick() {
    if (busy || mode === 'off') return;
    busy = true;
    try {
      if (!loaded) loaded = await loadOpen();
      if (!loaded) return;
      const locks = (getParlays() || []).filter(SL.isSingleLegLock);
      const byId = new Map(locks.map((p) => [p.id, p]));
      const ids = new Set([...byId.keys(), ...[...orders.values()].map((r) => r.parlay_id)]);
      if (seriesFees) await seriesFees.prefetchTickers(locks.map((p) => p.legs[0] && p.legs[0].ticker)).catch(() => {});
      for (const id of ids) {
        try { await processLock(id, byId.get(id) || null); } catch (e) { L(`lock ${id}: ${e && e.message}`); }
      }
    } finally { busy = false; }
  }

  function start() {
    if (mode === 'off') { L('SINGLE_LEG_LIVE off — 1-leg locks are not rested'); return; }
    L(`started mode=${mode} poll=${pollMs}ms poly=${polyHttp ? 'on' : 'off (no key)'} kalshiShare=${kalshiShare}`);
    timer = setInterval(() => { tick().catch((e) => L(`tick ${e && e.message}`)); }, pollMs);
    if (timer.unref) timer.unref();
  }

  // Poly slugs we rest on (the Desk fill watcher skips these; we alert ourselves).
  const ownsSlug = (slug) => polySlugsUsed.has(String(slug || ''))
    || [...orders.values()].some((r) => r.venue === 'polymarket' && r.market === slug);

  return { start, tick, ownsSlug, _orders: orders, mode };
}

module.exports = { createSingleLegRunner, kalshiOrderState, polyOrderState, hedgeSide };
