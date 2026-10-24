'use strict';
const assert = require('assert');
const S = require('./auto-sniper');
const NOW = Date.parse('2026-10-21T12:00:00-04:00');
const env = (o = {}) => ({ SNIPER_ENABLED: '1', ...o });
const leg = (t, side, fair, extra = {}) => ({ ticker: t, side, league: 'nfl', fair_yes: fair, date: '2026-10-25', ...extra });
const row = (id, legs, o = {}) => ({ rfq_id: id, venue: 'kalshi', status: 'seen', legs, contracts: 50, ...o });
const L1 = [leg('KXNFLGAME-26OCT25BUFNYJ-BUF', 'yes', 0.5), leg('KXNFLGAME-26OCT25KCLV-KC', 'yes', 0.5)];
let n = 0; const t = (name, fn) => { fn(); n++; };
const ev = (r, cfg, ledger, o = {}) => S.evaluateSnipe(r, { config: cfg, ledger, nowMs: NOW, ...o });

t('defaults: dry run on, kill switch off', () => {
  const c = S.sniperConfig({});
  assert.strictEqual(c.dryRun, true); assert.strictEqual(c.enabled, false);
  assert.strictEqual(c.minRoi, 0.04); assert.strictEqual(c.maxPayout, 100); assert.strictEqual(c.totalExposureCap, 10000);
  assert.strictEqual(ev(row('a', L1), c, S.createSniperLedger()).reason, 'kill_switch');
});
t('quotes lowest price clearing 4% ROI (default) after fee', () => {
  const c = S.sniperConfig(env()); const d = ev(row('a', L1), c, S.createSniperLedger());
  assert.strictEqual(d.action, 'quote');
  assert.ok(d.roi >= 0.04); assert.strictEqual(d.quoteYes, 0.286); assert.strictEqual(d.makerRate, 0.035);
  const lower = S.snipeEconomics({ fair: 0.25, q: 0.285, n: 50, makerRate: 0.035 });
  assert.ok(lower.roi < 0.04);
});
t('maker fee counted for non-NFL legs', () => {
  const c = S.sniperConfig(env());
  const d = ev(row('a', L1), c, S.createSniperLedger());
  assert.strictEqual(d.fee, Math.ceil(0.035 * 50 * d.quoteYes * (1 - d.quoteYes) * 1e4 - 1e-7) / 1e4);
  const nfl0 = ev(row('z', L1), c, S.createSniperLedger(), { makerRate: 0 });
  assert.strictEqual(nfl0.fee, 0); assert.ok(nfl0.quoteYes <= d.quoteYes);
  assert.ok(d.fee > 0); assert.ok(d.ev / d.risk >= 0.03);
});
t('payout over $100 skipped (no partial quotes)', () => {
  const c = S.sniperConfig(env());
  assert.strictEqual(ev(row('a', L1, { contracts: 101 }), c, S.createSniperLedger()).reason, 'payout_over_cap');
  assert.strictEqual(ev(row('b', L1, { contracts: null, cash_size: 40 }), c, S.createSniperLedger()).reason, 'payout_over_cap');
});
t('missing leg fair → skip', () => {
  const c = S.sniperConfig(env());
  assert.strictEqual(ev(row('a', [L1[0], { ...L1[1], fair_yes: null }]), c, S.createSniperLedger()).reason, 'leg_no_fair');
});
t('no double dipping: same rfq, same combo', () => {
  const c = S.sniperConfig(env()); const lg = S.createSniperLedger();
  assert.strictEqual(ev(row('a', L1), c, lg).action, 'quote');
  assert.strictEqual(ev(row('a', L1), c, lg).reason, 'dup_rfq');
  assert.strictEqual(ev(row('b', [L1[1], L1[0]]), c, lg).reason, 'already_hold_combo');
});
t('combo lock overlap skipped', () => {
  const c = S.sniperConfig(env());
  assert.strictEqual(ev(row('a', L1), c, S.createSniperLedger(), { lockOverlap: 1 }).reason, 'overlaps_combo_lock');
});
t('per-leg / per-game / total / daily caps bind', () => {
  const lg = S.createSniperLedger();
  const c = S.sniperConfig(env({ SNIPER_PER_LEG_CAP: '50' }));
  assert.strictEqual(ev(row('a', L1), c, lg).action, 'quote');
  const other = [L1[0], leg('KXNFLGAME-26OCT25DALPHI-DAL', 'yes', 0.5)];
  assert.strictEqual(ev(row('b', other), c, lg).reason, 'leg_cap');
  const c2 = S.sniperConfig(env({ SNIPER_TOTAL_EXPOSURE_CAP: '30' }));
  assert.strictEqual(ev(row('c', L1), c2, S.createSniperLedger()).reason, 'total_cap');
  const c3 = S.sniperConfig(env({ SNIPER_DAILY_RISK_CAP: '30' }));
  assert.strictEqual(ev(row('d', L1), c3, S.createSniperLedger()).reason, 'daily_risk_cap');
  const lg4 = S.createSniperLedger(); lg4.recordRealizedLoss(2000, NOW);
  assert.strictEqual(ev(row('e', L1), S.sniperConfig(env()), lg4).reason, 'daily_loss_halt');
});
t('exposure released after games settle', () => {
  const c = S.sniperConfig(env({ SNIPER_TOTAL_EXPOSURE_CAP: '40' })); const lg = S.createSniperLedger();
  assert.strictEqual(ev(row('a', L1, { contracts: 50 }), S.sniperConfig(env()), lg).action, 'quote');
  const later = Date.parse('2026-10-28T12:00:00-04:00');
  const other = [leg('KXNFLGAME-26NOV01X-A', 'yes', 0.5, { date: '2026-11-01' }), leg('KXNFLGAME-26NOV01Y-B', 'yes', 0.5, { date: '2026-11-01' })];
  assert.strictEqual(S.evaluateSnipe(row('b', other, { contracts: 50 }), { config: c, ledger: lg, nowMs: later }).action, 'quote');
});
t('started / filled status skipped', () => {
  assert.strictEqual(ev(row('a', L1, { status: 'started' }), S.sniperConfig(env()), S.createSniperLedger()).reason, 'status_started');
});
t('createAutoSniper dry run never calls postQuote', async () => {
  let posted = 0; const logs = [];
  const s = S.createAutoSniper({ env: env(), log: (m) => logs.push(m), notify: null, postQuote: () => { posted++; }, now: () => NOW });
  return s.consider(row('a', L1)).then((d) => {
    assert.strictEqual(d.action, 'quote'); assert.strictEqual(posted, 0);
    assert.ok(logs.some((m) => m.includes('WOULD_QUOTE')));
  });
});
t('venue gating: polymarket shares ledger but not wired', () => {
  assert.strictEqual(ev(row('p', L1, { venue: 'polymarket' }), S.sniperConfig(env()), S.createSniperLedger()).reason, 'venue_off');
  assert.strictEqual(ev(row('p', L1, { venue: 'polymarket' }), S.sniperConfig(env({ SNIPER_VENUES: 'kalshi,polymarket' })), S.createSniperLedger()).reason, 'venue_not_wired');
});
const F = require('./sniper-fair');
t('depth VWAP walks book until the bet can WIN $1000 (depth = profit); thin book → null', () => {
  const asks = F.yesAsksFromKalshiBook({ orderbook: { no: [[60, 1000], [58, 5000]] } }); // yes asks .40, .42
  assert.deepStrictEqual(asks.map((a) => a[0]), [0.4, 0.42]);
  const v = F.vwapForDepth(asks, 1000); // 1000 ct @.40 wins $600, then 400/.58 ct @.42 wins $400
  const q2 = 400 / 0.58;
  assert.ok(Math.abs(v - (400 + q2 * 0.42) / (1000 + q2)) < 1e-9);
  assert.strictEqual(F.vwapForDepth([[0.4, 10]], 1000), null);
  const v500 = F.vwapForDepth(asks, 500); assert.ok(v500 < v);
});
t('sniper fair: inverse of depth-weighted opponent ask with taker fee', async () => {
  const pc = { opponentQuotes: () => [{ venue: 'kalshi', key: 'KXNFLGAME-26OCT25BUFNYJ-NYJ' }] };
  const kg = async () => ({ json: { orderbook: { no: [[60, 100000]] } } });
  const f = F.createSniperFair({ kalshiGet: kg, priceCache: pc, depthUsd: 1000 });
  const p = await f.legFair({ ticker: 'KXNFLGAME-26OCT25BUFNYJ-BUF', side: 'yes' });
  const am = require('./engine').americanFromProb(0.4 * (1 + 0.07 * 0.6));
  assert.ok(Math.abs(p - (1 - 100 / (am + 100))) < 1e-9);
});
t('series fee: fee_type mapping matches our fills', () => {
  const { makerRateFromSeries } = require('./series-fee');
  assert.strictEqual(makerRateFromSeries('quadratic_with_combo_maker_fees', 1), 0.035);
  assert.strictEqual(makerRateFromSeries('quadratic', 1), 0);
  // Real fill 2026-10-20: 158.94 @ 0.206 charged $0.90994
  const f = S.snipeEconomics({ fair: 0.2, q: 0.206, n: 158.94, makerRate: 0.035 }).fee;
  assert.ok(Math.abs(f - 0.90994) < 0.0002);
});
t('max legs 10 + independent games', () => {
  const c = S.sniperConfig(env());
  const many = (k) => Array.from({ length: k }, (_, i) => leg(`KXNFLGAME-26OCT25G${i}-T${i}`, 'yes', 0.7));
  assert.strictEqual(ev(row('m10', many(10), { contracts: 10 }), c, S.createSniperLedger()).action, 'quote');
  assert.strictEqual(ev(row('m11', many(11), { contracts: 10 }), c, S.createSniperLedger()).reason, 'too_many_legs');
  assert.strictEqual(ev(row('sg', [L1[0], { ...L1[0], ticker: 'KXNFLGAME-26OCT25BUFNYJ-NYJ' }]), c, S.createSniperLedger()).reason, 'same_game');
  const { unhedgedMaxLegs } = require('./unhedged-rfq');
  assert.strictEqual(unhedgedMaxLegs({}), 4); assert.strictEqual(unhedgedMaxLegs({ SNIPER_ENABLED: '1' }), 10);
});
console.log(`auto-sniper.test.js: ${n} passed`);
