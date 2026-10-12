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
const TABLE = 'combo_single_orders';
const PLACE_BACKOFF_MS = 60_000;
const num = (v) => { const n = parseFloat(v && typeof v === 'object' ? v.value : v); return Number.isFinite(n) ? n : 0; };
const fmtAm = (a) => (a > 0 ? `+${a}` : `${a}`);

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

function createSingleLegRunner({
  env = process.env,
  supabase,
  kalshiSigned,           // (method, signPath, {path, body}) => {statusCode, text}
  polyHttp = null,        // createPolymarketHttp(...) or null when no Poly key
  seriesFees,
  getParlays,             // () => active, unpaused, allowlisted locks
  userIds = null,         // this process's users (worker-scope); null = no filter (tests)
  isBlocked,              // (userId, lock) => true when kill switch / caps / credits block
  sendAlert,
  log = console.log,
  now = Date.now,
} = {}) {
  const mode = SL.readMode(env);
  const pollMs = Math.max(1000, Number(env.SINGLE_LEG_POLL_MS) || 1500);
  const orders = new Map();   // rowKey -> row (combo_single_orders shape + runtime)
  const polyMarkets = new Map(); // ticker -> { slug, intent, tick } | { miss: true, at }
  const placeBackoff = new Map(); // `${lock}:${venue}` -> until ms
  let timer = null;
  let busy = false;
  let loaded = false;
  const polySlugsUsed = new Set();

  const L = (m) => log(`[SINGLE] ${m}`);

  async function kCall(method, path, body) {
    const { statusCode, text } = await kalshiSigned(method, path.split('?')[0], { path, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : undefined });
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { statusCode, json, text };
  }

  async function saveRow(row) {
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
      // Each process only ever touches its own users' orders (own keys).
      for (const r of (data || []).filter((x) => !userIds || userIds.includes(x.user_id))) {
        orders.set(`${r.venue}:${r.order_id}`, { ...r });
        if (r.venue === 'polymarket') polySlugsUsed.add(r.market);
      }
      // Filled totals for every lock we touch, including finished orders.
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
    const fillId = row.venue === 'polymarket'
      ? `poly-act:sl:${row.order_id}:${row.filled}`
      : `sl-k:${row.order_id}:${row.filled}`;
    const fill = {
      fill_id: fillId, order_id: row.order_id, parlay_id: row.parlay_id, user_id: row.user_id,
      ticker: row.market, count: delta, is_combo: true, is_taker: false,
      outcome_side: 'no', action: 'sell', no_price: cost, yes_price: Math.round((1 - cost) * 1e6) / 1e6,
      kalshi_created_time: new Date(now()).toISOString(),
      raw: { source: 'single-leg', venue: row.venue, hedge: row.hedge, label: lock && lock.label },
    };
    try {
      const { error } = await supabase.from('combo_fills').insert(fill);
      if (error && !/duplicate/i.test(error.message)) L(`fill insert ${fillId}: ${error.message}`);
    } catch (e) { L(`fill insert: ${e && e.message}`); }
    const venue = row.venue === 'polymarket' ? 'Polymarket' : 'Kalshi';
    const odds = lock && lock.fill_american != null ? ` · ${fmtAm(lock.fill_american)}` : '';
    sendAlert(`✅ FILL (${venue}, single leg) — ${(lock && lock.label) || row.market}\n${delta} contracts${odds} · filled ${row.filled}/${row.size}`).catch(() => {});
  }

  async function refreshOrder(row, lock) {
    let st;
    try {
      if (row.venue === 'kalshi') {
        const r = await kCall('GET', kGetPath(row.order_id));
        if (r.statusCode === 404) st = { filled: row.filled, open: 0, dead: true };
        else if (r.statusCode >= 300) throw new Error(`GET ${r.statusCode}`);
        else st = kalshiOrderState((r.json && r.json.order) || r.json);
      } else {
        const o = await polyHttp.getOrder(row.order_id);
        st = o ? polyOrderState(o) : { filled: row.filled, open: 0, dead: true };
      }
    } catch (e) {
      row.stale = true; // unknown => planner treats current size as open (never re-places on top)
      return;
    }
    row.stale = false;
    const delta = Math.round((st.filled - (Number(row.filled) || 0)) * 100) / 100;
    row.filled = st.filled;
    row.open = st.open;
    if (st.dead || st.open <= 0) row.status = st.filled >= Number(row.size) ? 'filled' : 'canceled';
    if (delta > 0) await recordFill(row, delta, lock);
    if (delta > 0 || row.status !== 'resting') await saveRow(row);
    if (row.status !== 'resting') {
      orders.delete(`${row.venue}:${row.order_id}`);
      const k = `${row.parlay_id}:${row.venue}`;
      filledTotals.set(k, (filledTotals.get(k) || 0) + (Number(row.filled) || 0));
    }
  }

  async function polyMarketFor(leg) {
    if (!polyHttp) return null;
    const hit = polyMarkets.get(leg.ticker);
    if (hit && !hit.miss) return hit;
    if (hit && hit.miss && now() - hit.at < 10 * 60_000) return null;
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
    polyMarkets.set(leg.ticker, { miss: true, at: now() });
    return null;
  }

  async function cancelRow(row, why) {
    if (mode !== 'live') { L(`DRY cancel ${row.venue} ${row.order_id} (${why})`); return; }
    try {
      if (row.venue === 'kalshi') {
        const r = await kCall('DELETE', `${kCancelPath(row.order_id)}?exchange_index=0`);
        if (r.statusCode >= 300 && r.statusCode !== 404) throw new Error(`${r.statusCode} ${r.text}`);
      } else {
        await polyHttp.cancelOrder(row.order_id, row.market);
      }
      row.open = 0; row.status = 'canceled'; row.last_error = why;
      L(`cancel ${row.venue} ${row.market} ${row.order_id} (${why})`);
    } catch (e) {
      row.last_error = `cancel failed: ${e && e.message}`;
      sendAlert(`🚨 CRITICAL single-leg cancel failed (${row.venue}) ${row.market} order ${row.order_id}: ${e && e.message}`).catch(() => {});
    }
    // Final read so a fill that landed before the cancel is booked.
    await refreshOrder(row, null);
    if (row.status === 'resting') { row.status = 'canceled'; orders.delete(`${row.venue}:${row.order_id}`); }
    await saveRow(row);
  }

  async function resizeRow(row, size, lock) {
    if (mode !== 'live') { L(`DRY resize ${row.venue} ${row.order_id} -> ${size}`); return; }
    if (row.venue === 'kalshi') {
      try {
        const r = await kCall('POST', kDecreasePath(row.order_id), { reduce_to: size.toFixed(2), exchange_index: 0 });
        if (r.statusCode >= 300) throw new Error(`${r.statusCode} ${r.text}`);
        row.open = size; await saveRow(row);
        L(`shrink kalshi ${row.market} -> ${size}`);
      } catch (e) { await cancelRow(row, `shrink failed: ${e && e.message}`); }
      return;
    }
    // Polymarket: cancel + re-rest the remaining size (no amend endpoint used).
    await cancelRow(row, 'shrink');
    if (size > 0) await placeVenue(lock, 'polymarket', size);
  }

  async function placeVenue(lock, venue, size) {
    const leg = lock.legs.filter((l) => l && l.ticker)[0];
    const bk = `${lock.id}:${venue}`;
    if ((placeBackoff.get(bk) || 0) > now()) return;
    const qty = Math.floor(size);
    if (qty < 1) return;
    let row;
    try {
      if (venue === 'kalshi') {
        const h = SL.kalshiHedge(leg, lock.fill_american, seriesFees ? seriesFees.rateForTicker(leg.ticker) : 0.035);
        if (!h) return;
        // V2 orders quote the YES book: buying NO at c == ask YES at 1-c.
        const body = {
          ticker: h.ticker, client_order_id: crypto.randomUUID(),
          side: h.side === 'yes' ? 'bid' : 'ask',
          count: qty.toFixed(2),
          price: ((h.side === 'yes' ? h.priceCents : 100 - h.priceCents) / 100).toFixed(4),
          time_in_force: 'good_till_canceled', post_only: true,
          self_trade_prevention_type: 'maker', exchange_index: 0,
        };
        if (mode !== 'live') { L(`DRY place kalshi ${JSON.stringify(body)}`); return; }
        const r = await kCall('POST', K_CREATE, body);
        if (r.statusCode >= 300) throw new Error(`${r.statusCode} ${String(r.text).slice(0, 200)}`);
        const id = r.json && (r.json.order_id || (r.json.order && r.json.order.order_id));
        if (!id) throw new Error('no order_id');
        row = { venue, order_id: String(id), market: h.ticker, hedge: h.side, price: h.priceCents / 100 };
      } else {
        const pm = await polyMarketFor(leg);
        if (!pm) return;
        const cost = SL.polyHedgeCost(lock.fill_american, pm.tick);
        if (cost == null) return;
        const body = SL.polyOrderBody({ slug: pm.slug, intent: pm.intent, cost, qty, tick: pm.tick });
        if (mode !== 'live') { L(`DRY place poly ${JSON.stringify(body)}`); return; }
        const created = await polyHttp.createOrder(body);
        const id = created && (created.id || (created.order && created.order.id));
        if (!id) throw new Error('no order id');
        row = { venue, order_id: String(id), market: pm.slug, hedge: pm.intent, price: cost };
      }
    } catch (e) {
      placeBackoff.set(bk, now() + PLACE_BACKOFF_MS);
      L(`place ${venue} ${lock.label || lock.id} failed: ${e && e.message}`);
      return;
    }
    Object.assign(row, { parlay_id: lock.id, user_id: lock.user_id, size: qty, filled: 0, open: qty, status: 'resting' });
    orders.set(`${venue}:${row.order_id}`, row);
    if (venue === 'polymarket') polySlugsUsed.add(row.market);
    await saveRow(row);
    L(`rest ${venue} ${row.market} ${row.hedge} ${qty} @ ${row.price} (${lock.label || lock.id})`);
  }

  function wantPrice(lock, venue) {
    const leg = SL.isSingleLegLock(lock) ? lock.legs.filter((l) => l && l.ticker)[0] : null;
    if (!leg) return null;
    if (venue === 'kalshi') {
      const h = SL.kalshiHedge(leg, lock.fill_american, seriesFees ? seriesFees.rateForTicker(leg.ticker) : 0.035);
      return h ? h.priceCents / 100 : null;
    }
    const pm = polyMarkets.get(leg.ticker);
    return pm && !pm.miss ? SL.polyHedgeCost(lock.fill_american, pm.tick) : null;
  }

  async function processLock(lockId, lock) {
    await loadClosedFilled(lockId);
    const mine = [...orders.values()].filter((r) => r.parlay_id === lockId);
    for (const r of mine) await refreshOrder(r, lock);
    const live = [...orders.values()].filter((r) => r.parlay_id === lockId);
    const startMs = lock ? SL.lockStartMs(lock) : null;
    const active = !!lock && SL.isSingleLegLock(lock) && !SL.cancelHeld(lock)
      && !(startMs != null && now() >= startMs) && !isBlocked(lock.user_id, lock);
    if (lock) await polyMarketFor(lock.legs.filter((l) => l && l.ticker)[0]).catch(() => null);
    const venues = {};
    for (const v of ['kalshi', 'polymarket']) {
      const rows = live.filter((r) => r.venue === v);
      venues[v] = {
        filled: (filledTotals.get(`${lockId}:${v}`) || 0) + rows.reduce((n, r) => n + (Number(r.filled) || 0), 0),
        // stale (unreadable) orders count as fully open so we never stack a second one.
        open: rows.reduce((n, r) => n + (r.stale ? Number(r.size) - Number(r.filled || 0) : Number(r.open) || 0), 0),
        price: rows.length ? Number(rows[0].price) : null,
        wantPrice: lock ? wantPrice(lock, v) : null,
        enabled: v === 'kalshi' ? true : !!(lock && polyHttp && wantPrice(lock, v) != null),
      };
    }
    const plan = SL.planCrossVenue({ cap: lock ? lock.max_contracts : 0, venues, active });
    if (plan.over > 0) {
      sendAlert(`🚨 CRITICAL single-leg OVER-HEDGED ${(lock && lock.label) || lockId}: filled ${plan.filled} vs cap ${lock && lock.max_contracts} (+${plan.over}). Other venue cancelled — review now.`).catch(() => {});
    }
    for (const a of plan.actions) {
      const rows = live.filter((r) => r.venue === a.venue && r.status === 'resting');
      if (a.op === 'cancel') for (const r of rows) await cancelRow(r, a.reprice ? 'reprice' : (active ? 'cap' : 'inactive'));
      else if (a.op === 'resize') for (const r of rows) await resizeRow(r, a.size, lock);
      else if (a.op === 'place') await placeVenue(lock, a.venue, a.size);
    }
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
    L(`started mode=${mode} poll=${pollMs}ms poly=${polyHttp ? 'on' : 'off (no key)'}`);
    timer = setInterval(() => { tick().catch((e) => L(`tick ${e && e.message}`)); }, pollMs);
    if (timer.unref) timer.unref();
  }

  // Poly slugs we rest on (the Desk fill watcher skips these; we alert ourselves).
  const ownsSlug = (slug) => polySlugsUsed.has(String(slug || ''))
    || [...orders.values()].some((r) => r.venue === 'polymarket' && r.market === slug);

  return { start, tick, ownsSlug, _orders: orders, mode };
}

module.exports = { createSingleLegRunner, kalshiOrderState, polyOrderState };
