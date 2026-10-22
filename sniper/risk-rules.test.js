// Kevin's go-live risk rules for the sniper, checked against the production env values.
'use strict';
const assert = require('assert');
const S = require('../auto-sniper');
const { decide } = require('./engine');
const { bestCost, ALL_VENUES } = require('./fair');
const { createLiveSniper } = require('./live');
const { createNightlyRecap, summarize } = require('./recap');
const { liveGate } = require('./gates');
const { etDayStartIso } = require('./runner');

const ENV = {
  SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '1', SNIPER_KALSHI_SUBACCOUNT: '1',
  SNIPER_MAX_RISK: '100', SNIPER_MAX_PAYOUT: '100000', SNIPER_DAILY_LOSS_CAP: '5000',
  SNIPER_TOTAL_EXPOSURE_CAP: '5000', SNIPER_PER_GAME_CAP: '1500', SNIPER_PER_LEG_CAP: '100000',
  SNIPER_DAILY_RISK_CAP: '1000000', SNIPER_MAX_QUOTES_PER_HOUR: '100000', SNIPER_MIN_ROI: '0.03', SNIPER_FAIR_DEPTH_USD: '1000',
};
const config = S.sniperConfig(ENV);
const NOW = Date.parse('2026-10-22T16:00:00Z');
let id = 0;
const row = (legs, contracts, extra = {}) => ({ rfq_id: `r${++id}`, venue: 'kalshi', status: 'seen', contracts, legs: legs.map(([ticker, p]) => ({ ticker, side: 'yes', fair_yes: p, date: '2026-10-25' })), ...extra });
const G = (n) => `KXNFLGAME-26OCT25G${String(n).padStart(2, '0')}X-AAA`;
const ev = (r, ledger, opts = {}) => S.evaluateSnipe(r, { config, ledger, nowMs: NOW, makerRate: 0, ...opts });

(async () => {
  // (1) max $100 risk per quote
  let L = S.createSniperLedger();
  let d = ev(row([[G(1), 0.5], [G(2), 0.5]], 120), L); // fair .25 → NO cost ≈ 120×.74 ≈ $89
  assert.strictEqual(d.action, 'quote'); assert.ok(d.risk <= 100);
  d = ev(row([[G(3), 0.5], [G(4), 0.5]], 200), L); // ≈ $148 risk
  assert.strictEqual(d.reason, 'risk_over_cap');

  // (4) 3% min edge is hard: quote price always clears 3% ROI after fee; impossible → skip
  for (const mr of [0, 0.035]) {
    const px = S.minQuotePrice({ fair: 0.3, contracts: 50, makerRate: mr, minRoi: 0.03, tick: 0.001 });
    assert.ok(px.roi >= 0.03 - 1e-12);
    const below = S.snipeEconomics({ fair: 0.3, q: px.q - 0.001, n: 50, makerRate: mr });
    assert.ok(below.roi < 0.03, 'one tick cheaper would be under 3%');
  }
  assert.strictEqual(S.minQuotePrice({ fair: 0.995, contracts: 10, makerRate: 0.035, minRoi: 0.03, tick: 0.001 }), null);
  // send-time re-price below 3% aborts (live path)
  const released = [];
  const live = createLiveSniper({ config, trader: { live: true, postQuote: async () => { throw new Error('must not post'); } }, store: { release: async (r, ph) => released.push(ph), update: async () => true },
    coord: { blockReason: () => null, comboWorkerQuoting: async () => null }, caps: () => ({}), reprice: () => 0.299, log: () => {} });
  const sendRes = await live.send({ rfqId: 'x' }, { rfqId: 'x', quoteYes: 0.3, contracts: 50, makerRate: 0 });
  assert.strictEqual(sendRes.reason, 'reprice_below_min');

  // (2) daily loss $5,000 → stop; lifts at the next ET day
  L = S.createSniperLedger(); L.recordRealizedLoss(5000, NOW);
  assert.strictEqual(ev(row([[G(5), 0.5], [G(6), 0.5]], 50), L).reason, 'daily_loss_halt');
  assert.strictEqual(ev(row([[G(5), 0.5], [G(6), 0.5]], 50), L, { nowMs: NOW + 86400e3 }).action, 'quote');
  let t = Date.parse('2026-10-22T20:00:00Z'); const alerts = [];
  const ls = createLiveSniper({ config, trader: { live: true }, store: { openFilled: async () => [], dayRealized: async () => -5000.01 }, coord: {}, caps: () => ({}), reprice: () => null, now: () => t, alert: (m) => alerts.push(m), log: () => {} });
  await ls.settleOnce(async () => null, 'x');
  assert.ok(ls.halted()); assert.ok(!ls.resumeIfNewDay());
  t = Date.parse('2026-10-23T04:30:00Z'); // 12:30 AM ET Oct 23
  assert.ok(ls.resumeIfNewDay()); assert.ok(!ls.halted());
  ls.halt('rate_limit'); t += 86400e3; assert.ok(!ls.resumeIfNewDay(), 'rate-limit halt needs restart');

  // (3) total open risk $5,000 and (11) per-game $1,500
  L = S.createSniperLedger(); let n = 0; let last;
  for (let i = 0; i < 80; i += 1) { last = ev(row([[G(10 + 2 * i), 0.5], [G(11 + 2 * i), 0.5]], 120), L); if (last.action === 'quote') n += 1; else break; }
  assert.strictEqual(last.reason, 'total_cap'); assert.ok(L.totals().total <= 5000 && L.totals().total > 4900);
  L = S.createSniperLedger(); n = 0;
  for (let i = 0; i < 40; i += 1) { last = ev(row([[G(1), 0.5], [G(20 + i), 0.5]], 120), L); if (last.action === 'quote') n += 1; else break; }
  assert.strictEqual(last.reason, 'game_cap'); assert.ok(L.totals().games.get('26OCT25G01X') <= 1500); assert.ok(n >= 15);

  // (8) no double dip: same legs+sides (any order) skipped while quote/fill open
  L = S.createSniperLedger();
  assert.strictEqual(ev(row([[G(1), 0.5], [G(2), 0.5]], 20), L).action, 'quote');
  assert.strictEqual(ev(row([[G(2), 0.5], [G(1), 0.5]], 20), L).reason, 'already_hold_combo');
  const flip = row([[G(1), 0.5], [G(2), 0.5]], 20); flip.legs[0].side = 'no';
  assert.strictEqual(ev(flip, L).action, 'quote', 'different side = different parlay');

  // (5) NFL only (narrower than NFL+CFB): non-NFL legs rejected at scope
  const src = (venue, cost, reason = 'ok') => ({ venue, cost, reason, used: true });
  const pmLive = { legFair: () => ({ sources: [src('kalshi', 0.5)] }) };
  const base = { config, ledger: S.createSniperLedger(), pmLive, tdBook: null, venues: ALL_VENUES, kickoffFor: () => NOW + 3 * 864e5, makerRate: 0, nowMs: NOW };
  const nba = decide({ rfqId: 'n1', legKeys: ['KXNBAGAME-26OCT25LALBOS-LAL:yes', 'KXNFLGAME-26OCT25INDMIN-MIN:yes'], contracts: 10 }, base);
  assert.ok(/^scope_/.test(nba.decision.reason), nba.decision.reason);

  // (7) $1,000 depth at the fair price on the venue that sets it
  assert.strictEqual(config.fairDepthUsd, 1000);
  assert.strictEqual(bestCost([src('kalshi', 0.4, 'depth'), src('novig', 0.45, 'top_only')], ALL_VENUES), null);
  const thin = decide({ rfqId: 'd1', legKeys: ['KXNFLGAME-26OCT25INDMIN-MIN:yes', 'KXNFLGAME-26OCT25BUFNYJ-BUF:yes'], contracts: 10 },
    { ...base, pmLive: { legFair: () => ({ sources: [src('kalshi', 0.5, 'depth')] }) } });
  assert.strictEqual(thin.decision.reason, 'leg_no_fair');
  const { walk } = require('../noboost/pm-live')._test || {};
  if (walk) { assert.strictEqual(walk([[0.5, 1500]], 'novig', 1000).fail, 'depth'); assert.ok(walk([[0.5, 2100]], 'novig', 1000).vwap); }

  // (6) dry-run stays closed unless all gates; Telegram FILL alert on every fill
  assert.ok(!liveGate({ ...ENV, SNIPER_KALSHI_KEY_ID: 'k', SNIPER_KALSHI_PRIVATE_KEY: 'p' }).live);

  // (10) nightly recap at 11:59 PM ET, sent with no fills
  const sent = []; let clock = Date.parse('2026-10-23T03:58:00Z'); // 11:58 PM ET
  const R = createNightlyRecap({ store: { dayRecap: async () => ({ quotes: 0, rows: [] }) }, send: (m) => sent.push(m), dayStartIso: etDayStartIso, openRisk: () => 0, now: () => clock });
  assert.ok(!(await R.tick())); clock += 60e3; assert.ok(await R.tick()); assert.ok(!(await R.tick()), 'once per day');
  assert.ok(/Fills: 0/.test(sent[0]) && /P&L today: \$0.00/.test(sent[0]));
  const s = summarize({ quotes: 3, rows: [
    { phase: 'settled', filled_contracts: 10, filled_cost: 6, filled_fee: 0, realized_pnl: 4, settled_at: '2026-10-23T02:00:00Z', created_at: '2026-10-22T15:00:00Z', updated_at: '2026-10-23T02:00:00Z' },
    { phase: 'settled', filled_contracts: 10, filled_cost: 7, filled_fee: 0, realized_pnl: -7, settled_at: '2026-10-23T02:00:00Z', created_at: '2026-10-20T15:00:00Z', updated_at: '2026-10-23T02:00:00Z' },
  ] }, '2026-10-22T04:00:00.000Z');
  assert.deepStrictEqual([s.fills, s.wins, s.losses, s.pnl], [1, 1, 1, -3]);
  assert.strictEqual(etDayStartIso(Date.parse('2026-11-05T12:00:00Z')), '2026-11-05T05:00:00.000Z', 'EST midnight after DST ends');
  assert.strictEqual(etDayStartIso(NOW), '2026-10-22T04:00:00.000Z');
  // (9) started games: no new quote at/after commence; open quotes touching a started game are pulled
  const KO = NOW + 3600e3;
  const legs9 = ['KXNFLGAME-26OCT25INDMIN-MIN:yes', 'KXNFLGAME-26OCT25BUFNYJ-BUF:yes'];
  for (const at of [KO, KO + 60e3]) {
    const r9 = decide({ rfqId: `s${at}`, legKeys: legs9, contracts: 10 }, { ...base, kickoffFor: (tk) => (tk.includes('BUFNYJ') ? KO : KO + 864e5), nowMs: at });
    assert.strictEqual(r9.decision.reason, 'game_started');
  }
  let clk = NOW; const cancels = []; const rel = [];
  const { pregameCheck } = require('./engine');
  const L9 = createLiveSniper({ config, log: () => {}, now: () => clk, ttlMs: 1e9,
    trader: { live: true, postQuote: async () => ({ quoteId: 'Q1', noBid: '0.5' }), cancel: async (q) => cancels.push(q) },
    store: { release: async (r, ph) => rel.push(ph), update: async () => true },
    coord: { blockReason: () => null, comboWorkerQuoting: async () => null }, caps: () => ({}), reprice: () => 0.25,
    startedReason: (rfq) => pregameCheck(rfq.legKeys, () => KO, clk, 0) });
  assert.ok((await L9.send({ rfqId: 'p1', legKeys: legs9 }, { rfqId: 'p1', quoteYes: 0.3, contracts: 10, makerRate: 0 })).sent);
  assert.strictEqual(await L9.pullStarted(), 0);
  clk = KO; assert.strictEqual(await L9.pullStarted(), 1);
  assert.deepStrictEqual(cancels, ['Q1']); assert.strictEqual(L9.pending.size, 0);
  assert.strictEqual((await L9.send({ rfqId: 'p2', legKeys: legs9 }, { rfqId: 'p2', quoteYes: 0.3, contracts: 10, makerRate: 0 })).reason, 'game_started');
  console.log('sniper/risk-rules.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
