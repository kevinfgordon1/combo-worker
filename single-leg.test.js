'use strict';
const assert = require('assert');
const SL = require('./single-leg');
const { createSingleLegRunner, kalshiOrderState, polyOrderState, hedgeSide } = require('./single-leg-runner');
const noFetch = async () => ({ ok: false });

let n = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(() => { n++; }, (e) => { console.error('FAIL', name); throw e; });

(async () => {
  // ── pure helpers ──
  await t('1-leg detection + combo filter', () => {
    const one = { id: 'a', legs: [{ ticker: 'KXNHLGAME-26OCT12MINVGK-MIN', side: 'yes' }] };
    const two = { id: 'b', legs: [{ ticker: 'X1' }, { ticker: 'X2' }] };
    assert.ok(SL.isSingleLegLock(one));
    assert.ok(!SL.isSingleLegLock(two));
    assert.deepStrictEqual(SL.comboLocksOnly([one, two]).map((p) => p.id), ['b']);
  });

  await t('kalshi hedge side + price (no maker fee)', () => {
    // +100 fill => user pays 50c for the leg; hedge buys NO at 50c.
    const h = SL.kalshiHedge({ ticker: 'T', side: 'yes' }, 100, 0);
    assert.deepStrictEqual(h, { ticker: 'T', side: 'no', priceCents: 50 });
    assert.strictEqual(SL.kalshiHedge({ ticker: 'T', side: 'no' }, 100, 0).side, 'yes');
  });

  await t('kalshi maker fee lowers the hedge price (never worse for the user)', () => {
    const noFee = SL.kalshiHedge({ ticker: 'T' }, -110, 0).priceCents;
    const fee = SL.kalshiHedge({ ticker: 'T' }, -110, 0.0175).priceCents;
    assert.ok(fee <= noFee);
    // net to the user at the rested price is >= the lock's implied price
    const sNom = 1 - fee / 100;
    const sEff = sNom - 0.0175 * sNom * (1 - sNom);
    assert.ok(sEff >= 110 / 210 - 1e-9);
  });

  await t('poly hedge cost floors to tick', () => {
    assert.strictEqual(SL.polyHedgeCost(150, 0.01), 0.6); // implied 0.4 -> 0.60
    assert.strictEqual(SL.polyHedgeCost(-102, 0.01), 0.49); // 0.50495 -> 0.495 -> 0.49
    assert.strictEqual(SL.polyHedgeCost(-102, 0.001), 0.495);
  });

  await t('poly body: BUY_SHORT carries the long (yes) price', () => {
    const b = SL.polyOrderBody({ slug: 's', intent: 'ORDER_INTENT_BUY_SHORT', cost: 0.49, qty: 10.7 });
    assert.strictEqual(b.price.value, '0.51');
    assert.strictEqual(b.quantity, 10);
    assert.strictEqual(b.participateDontInitiate, true);
    const l = SL.polyOrderBody({ slug: 's', intent: 'ORDER_INTENT_BUY_LONG', cost: 0.49, qty: 5 });
    assert.strictEqual(l.price.value, '0.49');
  });

  await t('poly slug candidates map Kalshi codes to Poly codes', () => {
    const c = SL.polySlugCandidates('KXNHLGAME-26OCT12MINVGK-MIN');
    assert.ok(c.includes('aec-nhl-min-veg-2026-10-12') || c.includes('aec-nhl-veg-min-2026-10-12'), c.join(','));
    assert.deepStrictEqual(SL.polySlugCandidates('KXNFLSPREAD-26OCT12BUFLAR-BUF3'), []);
  });

  await t('cancel_open_at holds until the fill is edited', () => {
    assert.strictEqual(SL.cancelHeld({}), false);
    assert.strictEqual(SL.cancelHeld({ cancel_open_at: '2026-10-12T20:00:00Z' }), true);
    assert.strictEqual(SL.cancelHeld({ cancel_open_at: '2026-10-12T20:00:00Z', fill_edited_at: '2026-10-12T20:00:00Z' }), false);
    assert.strictEqual(SL.cancelHeld({ cancel_open_at: '2026-10-12T21:00:00Z', fill_edited_at: '2026-10-12T20:00:00Z' }), true);
  });

  // ── cross-venue cap plan ──
  const V = (o) => ({ filled: 0, open: 0, price: 0.5, wantPrice: 0.5, enabled: true, ...o });
  await t('fresh lock splits the cap across venues (combined open <= cap)', () => {
    const p = SL.planCrossVenue({ cap: 100, active: true, venues: { kalshi: V(), polymarket: V() } });
    assert.deepStrictEqual(p.actions.map((a) => [a.venue, a.op, a.size]), [['kalshi', 'place', 50], ['polymarket', 'place', 50]]);
    const one = SL.planCrossVenue({ cap: 100, active: true, venues: { kalshi: V(), polymarket: V({ enabled: false }) } });
    assert.deepStrictEqual(one.actions.map((a) => [a.venue, a.op, a.size]), [['kalshi', 'place', 100]]);
  });

  await t('partial fill on Kalshi shrinks the other venue to its share', () => {
    const p = SL.planCrossVenue({ cap: 100, active: true, venues: { kalshi: V({ filled: 30, open: 20 }), polymarket: V({ open: 50 }) } });
    assert.strictEqual(p.remaining, 70);
    assert.deepStrictEqual(p.actions, [{ venue: 'polymarket', op: 'resize', size: 35 }, { venue: 'kalshi', op: 'place', size: 15 }]);
  });

  await t('worst case (everything open fills at once) never passes the cap', () => {
    for (const [fk, ok, fp, op] of [[0, 0, 0, 0], [30, 20, 0, 50], [10, 40, 45, 5], [0, 50, 50, 0]]) {
      const v = { kalshi: V({ filled: fk, open: ok }), polymarket: V({ filled: fp, open: op }) };
      const p = SL.planCrossVenue({ cap: 100, active: true, venues: v });
      const open = { kalshi: ok, polymarket: op };
      for (const a of p.actions) open[a.venue] = a.op === 'cancel' ? 0 : a.op === 'resize' ? a.size : open[a.venue] + a.size;
      assert.ok(fk + fp + open.kalshi + open.polymarket <= 100, JSON.stringify([fk, ok, fp, op, p.actions]));
    }
  });

  await t('full fill on one venue cancels the other', () => {
    const p = SL.planCrossVenue({ cap: 100, active: true, venues: { kalshi: V({ filled: 0, open: 50 }), polymarket: V({ filled: 100, open: 0 }) } });
    assert.deepStrictEqual(p.actions, [{ venue: 'kalshi', op: 'cancel', size: 0 }]);
    assert.strictEqual(p.over, 0);
  });

  await t('over-hedge (e.g. manual order) flagged, rest cancelled', () => {
    const p = SL.planCrossVenue({ cap: 100, active: true, venues: { kalshi: V({ filled: 80, open: 20 }), polymarket: V({ filled: 60, open: 40 }) } });
    assert.strictEqual(p.over, 40);
    assert.deepStrictEqual(p.actions.map((a) => a.op), ['cancel', 'cancel']);
  });

  await t('inactive lock (start / cancel / kill) cancels everything, places nothing', () => {
    const p = SL.planCrossVenue({ cap: 100, active: false, venues: { kalshi: V({ open: 100 }), polymarket: V({ open: 100 }) } });
    assert.deepStrictEqual(p.actions.map((a) => a.op), ['cancel', 'cancel']);
  });

  await t('edited price => cancel then re-rest; disabled venue never placed', () => {
    const p = SL.planCrossVenue({ cap: 50, active: true, venues: { kalshi: V({ open: 50, price: 0.5, wantPrice: 0.48 }), polymarket: V({ enabled: false }) } });
    assert.deepStrictEqual(p.actions.map((a) => [a.venue, a.op]), [['kalshi', 'cancel'], ['kalshi', 'place']]);
  });

  await t('failed-cancel order: counted open, venue gets no new order on top', () => {
    const p = SL.planCrossVenue({ cap: 100, active: true, venues: { kalshi: V({ open: 100, pending: 100, price: 0.5, wantPrice: 0.48 }), polymarket: V() } });
    assert.ok(!p.actions.some((a) => a.venue === 'kalshi'));
    assert.ok(!p.actions.some((a) => a.op === 'place'), JSON.stringify(p.actions)); // no room left
  });

  await t('taker plan walks depth after fees; rest never crosses', () => {
    // McMichael: lock +500 -> NO target 0.8333. YES bids 0.19 (3568) -> NO ask 0.81.
    const asks = SL.kalshiAsks({ orderbook_fp: { yes_dollars: [['0.0800', '11'], ['0.1900', '3568.00']], no_dollars: [['0.8000', '5']] } }, 'no');
    assert.deepStrictEqual(asks[0], { cost: 0.81, qty: 3568 });
    const tp = SL.takePlan(asks, SL.hedgeTarget(500), SL.KALSHI_TAKER_K, 1750);
    assert.strictEqual(tp.qty, 1750);
    assert.strictEqual(tp.worstCost, 0.81);
    assert.ok(tp.avgNet < 0.8334 && tp.avgNet > 0.81);
    // 0.92 NO ask (+fee) is worse than target -> not taken
    assert.strictEqual(SL.takePlan([{ cost: 0.92, qty: 10 }], 0.8333, 0.07, 10), null);
    assert.strictEqual(SL.restCost(0.83, [{ cost: 0.81, qty: 1 }], 0.01), 0.8); // would cross -> one tick behind
    assert.strictEqual(SL.restCost(0.83, [{ cost: 0.86, qty: 1 }], 0.01), 0.83);
    assert.strictEqual(SL.americanFromCost(0.81), -426);
    assert.strictEqual(SL.americanFromCost(0.2), 400);
    const pa = SL.polyAsks({ marketData: { bids: [{ px: { value: '0.19' }, qty: '0.32' }], offers: [{ px: { value: '0.20' }, qty: '1080' }] } }, 'ORDER_INTENT_BUY_SHORT');
    assert.deepStrictEqual(pa, [{ cost: 0.81, qty: 0.32 }]);
  });

  await t('poly player props: event slug + unique player/line market', () => {
    const leg = { ticker: 'KXNHLGOAL-26OCT13STLOTT-STLCMCMICHAEL77-1', side: 'yes', label: 'Connor McMichael: 1+' };
    const ref = SL.propPolyRef(leg);
    assert.ok(ref.eventSlugs.includes('nhl-stl-ott-2026-10-13'), ref.eventSlugs.join(','));
    assert.strictEqual(ref.kind, 'hockey_player_goals');
    const ev = { markets: [
      { slug: 'a1', sportsMarketType: 'hockey_player_assists', line: 1, metadata: { playerName: 'Connor McMichael' } },
      { slug: 'g1', sportsMarketType: 'hockey_player_goals', line: 1, metadata: { playerName: 'Connor McMichael' } },
      { slug: 'g2', sportsMarketType: 'hockey_player_goals', line: 2, metadata: { playerName: 'Connor McMichael' } },
    ] };
    assert.strictEqual(SL.findPropMarket(ev, ref).slug, 'g1');
    assert.strictEqual(SL.propIntent(leg), 'ORDER_INTENT_BUY_SHORT');
    assert.strictEqual(SL.propPolyRef({ ticker: 'KXNFLTD-26OCT01PITCLE-CLEDWATSON4-1', label: 'Deshaun Watson: 1+' }).kind, 'football_player_touchdowns');
    assert.strictEqual(SL.propPolyRef({ ticker: 'KXNHLGAME-26OCT13STLOTT-STL' }), null);
  });

  await t('fill side recorded correctly', () => {
    assert.strictEqual(hedgeSide({ hedge: 'no' }), 'no');
    assert.strictEqual(hedgeSide({ hedge: 'yes' }), 'yes');
    assert.strictEqual(hedgeSide({ hedge: 'ORDER_INTENT_BUY_LONG' }), 'yes');
    assert.strictEqual(hedgeSide({ hedge: 'ORDER_INTENT_BUY_SHORT' }), 'no');
  });

  await t('order state readers', () => {
    assert.deepStrictEqual(kalshiOrderState({ status: 'resting', fill_count_fp: '3.00', remaining_count_fp: '7.00' }), { filled: 3, open: 7, dead: false });
    assert.deepStrictEqual(kalshiOrderState({ status: 'canceled', fill_count_fp: '3.00', remaining_count_fp: '0' }), { filled: 3, open: 0, dead: true });
    assert.deepStrictEqual(polyOrderState({ state: 'ORDER_STATE_PARTIALLY_FILLED', quantity: 10, cumQuantity: 4 }), { filled: 4, open: 6, dead: false });
    assert.strictEqual(polyOrderState({ state: 'ORDER_STATE_FILLED', quantity: 10, cumQuantity: 10 }).dead, true);
  });

  // ── runner end-to-end with fake venues ──
  await t('runner: Kalshi fill shrinks Poly, fills booked once, alert sent', async () => {
    const db = { combo_single_orders: [], combo_fills: [] };
    const supabase = {
      from(tbl) {
        const q = { _f: [] };
        q.select = () => q; q.eq = (k, v) => { q._f.push([k, v]); return q; };
        q.then = (res) => res({ data: db[tbl].filter((r) => q._f.every(([k, v]) => r[k] === v)), error: null });
        q.upsert = async (rec) => { const i = db[tbl].findIndex((r) => r.venue === rec.venue && r.order_id === rec.order_id); if (i >= 0) db[tbl][i] = rec; else db[tbl].push(rec); return { error: null }; };
        q.insert = async (rec) => { if (db[tbl].some((r) => r.fill_id === rec.fill_id)) return { error: { message: 'duplicate' } }; db[tbl].push(rec); return { error: null }; };
        return q;
      },
    };
    const k = { orders: {}, seq: 0 };
    const kalshiSigned = async (method, signPath, { path, body }) => {
      if (method === 'POST' && signPath.endsWith('/events/orders')) { const id = `k${++k.seq}`; const b = JSON.parse(body); k.orders[id] = { status: 'resting', fill: 0, rem: Number(b.count), body: b }; return { statusCode: 201, text: JSON.stringify({ order_id: id }) }; }
      const id = decodeURIComponent(signPath.split('/orders/')[1].split('/')[0]);
      const o = k.orders[id];
      if (method === 'GET') return { statusCode: 200, text: JSON.stringify({ order: { status: o.status, fill_count_fp: String(o.fill), remaining_count_fp: String(o.rem) } }) };
      if (method === 'POST' && signPath.endsWith('/decrease')) { o.rem = Number(JSON.parse(body).reduce_to); return { statusCode: 200, text: '{}' }; }
      if (method === 'DELETE') { o.status = 'canceled'; o.rem = 0; return { statusCode: 200, text: '{}' }; }
      return { statusCode: 400, text: '' };
    };
    const p = { orders: {}, seq: 0 };
    const polyHttp = {
      async getMarketBySlug(slug) {
        if (slug !== 'aec-nhl-min-veg-2026-10-12') return null;
        return { slug, metadata: { market_sport_type: 'hockey_team_full_game_winner', long_participant_id: 'nhl-min', short_participant_id: 'nhl-veg', event_start_time: '2026-10-12T23:00:00Z' }, orderPriceMinTickSize: 0.01 };
      },
      async createOrder(b) { const id = `p${++p.seq}`; p.orders[id] = { state: 'ORDER_STATE_NEW', quantity: b.quantity, cumQuantity: 0, body: b }; return { id }; },
      async getOrder(id) { return p.orders[id]; },
      async cancelOrder(id) { p.orders[id].state = 'ORDER_STATE_CANCELED'; },
    };
    const alerts = [];
    const lock = { id: 'L1', user_id: 'u1', label: 'Wild ML', fill_american: 100, max_contracts: 100, legs: [{ ticker: 'KXNHLGAME-26OCT12MINVGK-MIN', side: 'yes' }], starts_at: '2099-01-01T00:00:00Z' };
    let locks = [lock];
    const r = createSingleLegRunner({
      env: { SINGLE_LEG_LIVE: '1' }, fetchImpl: noFetch, supabase, kalshiSigned, polyHttp,
      seriesFees: { rateForTicker: () => 0, prefetchTickers: async () => {} },
      getParlays: () => locks, isBlocked: () => false,
      sendAlert: async (x) => { alerts.push(x); }, log: () => {}, now: () => Date.parse('2026-10-12T20:00:00Z'),
    });
    const exposure = () => {
      let tot = 0;
      for (const o of Object.values(k.orders)) tot += o.fill + (o.status === 'resting' ? o.rem : 0);
      for (const o of Object.values(p.orders)) tot += o.cumQuantity + (/CANCEL|FILLED$/.test(o.state) ? 0 : o.quantity - o.cumQuantity);
      return tot;
    };
    await r.tick();
    assert.strictEqual(k.orders.k1.body.side, 'ask'); // buy NO == ask YES
    assert.strictEqual(k.orders.k1.body.price, '0.5000');
    assert.strictEqual(k.orders.k1.body.post_only, true);
    assert.strictEqual(k.orders.k1.rem, 50);
    assert.strictEqual(p.orders.p1.body.intent, 'ORDER_INTENT_BUY_SHORT'); // user has MIN (long) -> hedge buys VEG
    assert.strictEqual(p.orders.p1.quantity, 50);
    assert.ok(exposure() <= 100);
    // Kalshi fills 30.
    k.orders.k1.fill = 30; k.orders.k1.rem = 20;
    await r.tick(); assert.ok(exposure() <= 100, `exp ${exposure()}`);
    assert.strictEqual(db.combo_fills.length, 1);
    assert.strictEqual(db.combo_fills[0].count, 30);
    assert.strictEqual(db.combo_fills[0].outcome_side, 'no');
    assert.strictEqual(p.orders.p1.state, 'ORDER_STATE_CANCELED');
    assert.ok(alerts.some((a) => /FILL \(Kalshi, single leg\)/.test(a)));
    await r.tick(); assert.ok(exposure() <= 100);
    await r.tick(); assert.ok(exposure() <= 100);
    assert.strictEqual(db.combo_fills.length, 1);
    assert.strictEqual(exposure(), 100); // fully working again
    const nOrders = Object.keys(k.orders).length + Object.keys(p.orders).length;
    await r.tick();
    assert.strictEqual(Object.keys(k.orders).length + Object.keys(p.orders).length, nOrders); // steady state
    // Everything open fills at once -> exactly the cap, no over-hedge.
    for (const o of Object.values(k.orders)) if (o.status === 'resting') { o.fill += o.rem; o.rem = 0; o.status = 'executed'; }
    for (const o of Object.values(p.orders)) if (!/CANCEL|FILLED$/.test(o.state)) { o.cumQuantity = o.quantity; o.state = 'ORDER_STATE_FILLED'; }
    await r.tick();
    assert.strictEqual(db.combo_fills.reduce((n, f) => n + f.count, 0), 100);
    assert.ok(!alerts.some((a) => /OVER-HEDGED/.test(a)));
    const after = Object.keys(k.orders).length + Object.keys(p.orders).length;
    locks = [];
    await r.tick();
    assert.strictEqual(Object.keys(k.orders).length + Object.keys(p.orders).length, after);
  });

  await t('runner: failed cancel stays tracked; nothing placed on top until confirmed closed', async () => {
    const mem = { combo_single_orders: [], combo_fills: [] };
    const supabase = { from(tbl) { const q = { _f: [] }; q.select = () => q; q.eq = (a, b) => { q._f.push([a, b]); return q; }; q.then = (res) => res({ data: mem[tbl].filter((r) => q._f.every(([x, y]) => r[x] === y)), error: null }); q.upsert = async (rec) => { const i = mem[tbl].findIndex((r) => r.order_id === rec.order_id); if (i >= 0) mem[tbl][i] = rec; else mem[tbl].push(rec); return {}; }; q.insert = async () => ({}); return q; } };
    const ko = {}; let ks = 0; let cancelBroken = true;
    const kalshiSigned = async (m, sp, { body }) => {
      if (m === 'POST' && sp.endsWith('/events/orders')) { const id = `k${++ks}`; ko[id] = { status: 'resting', rem: Number(JSON.parse(body).count), price: JSON.parse(body).price }; return { statusCode: 201, text: JSON.stringify({ order_id: id }) }; }
      const o = ko[sp.split('/orders/')[1]];
      if (m === 'DELETE') { if (cancelBroken) return { statusCode: 500, text: 'boom' }; o.status = 'canceled'; o.rem = 0; }
      return { statusCode: 200, text: JSON.stringify({ order: { status: o.status, fill_count_fp: '0', remaining_count_fp: String(o.rem) } }) };
    };
    const alerts = [];
    const lock = { id: 'L4', user_id: 'u', fill_american: 120, max_contracts: 5, legs: [{ ticker: 'KXNHLGAME-26OCT12MINVGK-MIN' }], starts_at: '2099-01-01T00:00:00Z' };
    const r = createSingleLegRunner({ env: { SINGLE_LEG_LIVE: '1' }, fetchImpl: noFetch, supabase, kalshiSigned, polyHttp: null, seriesFees: null, getParlays: () => [lock], isBlocked: () => false, sendAlert: async (x) => alerts.push(x), log: () => {}, now: () => Date.parse('2026-10-12T20:00:00Z') });
    await r.tick();
    assert.strictEqual(Object.keys(ko).length, 1);
    lock.fill_american = 130; // price edit => cancel + re-rest, but cancel fails
    for (let i = 0; i < 3; i++) await r.tick();
    assert.strictEqual(Object.keys(ko).length, 1, 'no order on top of the uncancelled one');
    assert.strictEqual(alerts.filter((a) => /cancel failed/.test(a)).length, 1);
    cancelBroken = false;
    await r.tick(); // retry cancel succeeds + confirmed
    await r.tick();
    assert.strictEqual(ko.k1.status, 'canceled');
    assert.strictEqual(Object.keys(ko).length, 2);
  });

  await t('runner: takes the book when it beats the lock after fees; dry logs only on change', async () => {
    const mem = { combo_single_orders: [], combo_fills: [] };
    const supabase = { from(tbl) { const q = { _f: [] }; q.select = () => q; q.eq = (a, b) => { q._f.push([a, b]); return q; }; q.then = (res) => res({ data: mem[tbl].filter((r) => q._f.every(([x, y]) => r[x] === y)), error: null }); q.upsert = async (rec) => { mem[tbl].push(rec); return {}; }; q.insert = async (rec) => { mem[tbl].push(rec); return {}; }; return q; } };
    const sent = [];
    const book = { orderbook_fp: { yes_dollars: [['0.1900', '3568.00']], no_dollars: [['0.8000', '5036.00']] } };
    const kalshiSigned = async (m, sp, { body }) => {
      if (sp.endsWith('/orderbook')) return { statusCode: 200, text: JSON.stringify(book) };
      if (m === 'POST') { sent.push(JSON.parse(body)); return { statusCode: 201, text: JSON.stringify({ order_id: `k${sent.length}` }) }; }
      return { statusCode: 200, text: JSON.stringify({ order: { status: 'executed', fill_count_fp: '1750', remaining_count_fp: '0' } }) };
    };
    const lock = { id: 'L5', user_id: 'u', label: 'Connor McMichael 1+ Goal', fill_american: 500, max_contracts: 1750, legs: [{ ticker: 'KXNHLGOAL-26OCT13STLOTT-STLCMCMICHAEL77-1', side: 'yes' }], starts_at: '2099-01-01T00:00:00Z' };
    const logs = [];
    let clock = Date.parse('2026-10-13T18:00:00Z');
    const dry = createSingleLegRunner({ env: { SINGLE_LEG_LIVE: 'dry' }, fetchImpl: noFetch, supabase, kalshiSigned, polyHttp: null, seriesFees: { rateForTicker: () => 0.0175, prefetchTickers: async () => {} }, getParlays: () => [lock], isBlocked: () => false, sendAlert: async () => {}, log: (m) => logs.push(m), now: () => clock });
    for (let i = 0; i < 5; i++) { clock += 1500; await dry.tick(); }
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(logs.length, 1, logs.join('\n'));
    assert.ok(/TAKE kalshi .* NO 1750 @ 81¢ · -426 worst before fees/.test(logs[0]), logs[0]);
    const lv = createSingleLegRunner({ env: { SINGLE_LEG_LIVE: '1' }, fetchImpl: noFetch, supabase, kalshiSigned, polyHttp: null, seriesFees: { rateForTicker: () => 0.0175, prefetchTickers: async () => {} }, getParlays: () => [lock], isBlocked: () => false, sendAlert: async () => {}, log: () => {}, now: () => clock });
    await lv.tick();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].time_in_force, 'immediate_or_cancel');
    assert.strictEqual(sent[0].side, 'ask');
    assert.strictEqual(sent[0].price, '0.1900');
    assert.strictEqual(sent[0].post_only, undefined);
    clock += 1500; await lv.tick(); // IOC read: 1750 filled -> done
    clock += 1500; await lv.tick();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(mem.combo_fills[0].is_taker, true);
  });

  await t('runner: both venues fill at once => trim + CRITICAL alert', async () => {
    const mem = { combo_single_orders: [], combo_fills: [] };
    const supabase = { from(tbl) { const q = { _f: [] }; q.select = () => q; q.eq = (k2, v) => { q._f.push([k2, v]); return q; }; q.then = (res) => res({ data: mem[tbl].filter((r) => q._f.every(([a, b]) => r[a] === b)), error: null }); q.upsert = async (rec) => { const i = mem[tbl].findIndex((r) => r.order_id === rec.order_id); if (i >= 0) mem[tbl][i] = rec; else mem[tbl].push(rec); return {}; }; q.insert = async (rec) => { mem[tbl].push(rec); return {}; }; return q; } };
    const ko = {}; let ks = 0;
    const kalshiSigned = async (m, sp, { body }) => {
      if (m === 'POST' && sp.endsWith('/events/orders')) { const id = `k${++ks}`; ko[id] = { status: 'resting', fill: 0, rem: Number(JSON.parse(body).count) }; return { statusCode: 201, text: JSON.stringify({ order_id: id }) }; }
      const id = sp.split('/orders/')[1].split('/')[0]; const o = ko[id];
      if (m === 'GET') return { statusCode: 200, text: JSON.stringify({ order: { status: o.status, fill_count_fp: String(o.fill), remaining_count_fp: String(o.rem) } }) };
      if (m === 'DELETE') { o.status = 'canceled'; o.rem = 0; } return { statusCode: 200, text: '{}' };
    };
    const po = {}; let ps = 0;
    const polyHttp = {
      getMarketBySlug: async (slug) => (slug === 'aec-nhl-min-veg-2026-10-12' ? { slug, metadata: { market_sport_type: 'hockey_team_full_game_winner', long_participant_id: 'nhl-min', short_participant_id: 'nhl-veg', event_start_time: '2026-10-12T23:00:00Z' } } : null),
      createOrder: async (b) => { const id = `p${++ps}`; po[id] = { state: 'ORDER_STATE_NEW', quantity: b.quantity, cumQuantity: 0 }; return { id }; },
      getOrder: async (id) => po[id], cancelOrder: async (id) => { po[id].state = 'ORDER_STATE_CANCELED'; },
    };
    const alerts = [];
    const lock = { id: 'L2', user_id: 'u', label: 'Wild ML', fill_american: 100, max_contracts: 10, legs: [{ ticker: 'KXNHLGAME-26OCT12MINVGK-MIN', side: 'yes' }], starts_at: '2099-01-01T00:00:00Z' };
    const r = createSingleLegRunner({ env: { SINGLE_LEG_LIVE: '1' }, fetchImpl: noFetch, supabase, kalshiSigned, polyHttp, seriesFees: null, getParlays: () => [lock], isBlocked: () => false, sendAlert: async (x) => alerts.push(x), log: () => {}, now: () => Date.parse('2026-10-12T20:00:00Z') });
    await r.tick();
    ko.k1.fill = 10; ko.k1.rem = 0; ko.k1.status = 'executed';
    po.p1.cumQuantity = 4;
    await r.tick();
    assert.strictEqual(po.p1.state, 'ORDER_STATE_CANCELED');
    assert.ok(alerts.some((a) => /CRITICAL single-leg OVER-HEDGED/.test(a) && /\+4/.test(a)));
  });

  await t('runner: game start and kill switch cancel resting orders', async () => {
    const mem = { combo_single_orders: [], combo_fills: [] };
    const supabase = { from(tbl) { const q = { _f: [] }; q.select = () => q; q.eq = (a, b) => { q._f.push([a, b]); return q; }; q.then = (res) => res({ data: mem[tbl].filter((r) => q._f.every(([x, y]) => r[x] === y)), error: null }); q.upsert = async (rec) => { const i = mem[tbl].findIndex((r) => r.order_id === rec.order_id); if (i >= 0) mem[tbl][i] = rec; else mem[tbl].push(rec); return {}; }; q.insert = async () => ({}); return q; } };
    const ko = {}; let ks = 0;
    const kalshiSigned = async (m, sp, { body }) => {
      if (m === 'POST') { const id = `k${++ks}`; ko[id] = { status: 'resting', rem: Number(JSON.parse(body).count) }; return { statusCode: 201, text: JSON.stringify({ order_id: id }) }; }
      const o = ko[sp.split('/orders/')[1]];
      if (m === 'DELETE') { o.status = 'canceled'; o.rem = 0; }
      return { statusCode: 200, text: JSON.stringify({ order: { status: o.status, fill_count_fp: '0', remaining_count_fp: String(o.rem) } }) };
    };
    let clock = Date.parse('2026-10-12T20:00:00Z');
    let blocked = false;
    const lock = { id: 'L3', user_id: 'u', fill_american: 120, max_contracts: 5, legs: [{ ticker: 'KXNHLGAME-26OCT12MINVGK-MIN' }], starts_at: '2026-10-12T23:00:00Z' };
    const r = createSingleLegRunner({ env: { SINGLE_LEG_LIVE: '1' }, fetchImpl: noFetch, supabase, kalshiSigned, polyHttp: null, seriesFees: null, getParlays: () => [lock], isBlocked: () => blocked, sendAlert: async () => {}, log: () => {}, now: () => clock });
    await r.tick();
    assert.strictEqual(ko.k1.status, 'resting');
    blocked = true; await r.tick();
    assert.strictEqual(ko.k1.status, 'canceled');
    blocked = false; await r.tick();
    assert.strictEqual(ko.k2.status, 'resting');
    clock = Date.parse('2026-10-12T23:00:01Z'); await r.tick();
    assert.strictEqual(ko.k2.status, 'canceled');
    await r.tick();
    assert.strictEqual(Object.keys(ko).length, 2);
  });

  console.log(`single-leg tests ok (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
