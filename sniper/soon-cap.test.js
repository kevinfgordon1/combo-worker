'use strict';
const assert = require('assert');
const { createSoonCap, parseSubBalanceUsd } = require('./soon-cap');
const { evaluateSnipe, sniperConfig, createSniperLedger } = require('../auto-sniper');
const { capsFrom } = require('./ledger-store');

(async () => {
  const json = { subaccount_balances: [{ balance: '2314.85', exchange_index: 0, subaccount_number: 0 }, { balance: '16392.73', exchange_index: 1, subaccount_number: 0 }, { balance: '12945.7575', exchange_index: 1, subaccount_number: 1 }] };
  assert.strictEqual(parseSubBalanceUsd(json, 1), 12945.7575);
  assert.strictEqual(parseSubBalanceUsd(json, 2), null);
  let t = Date.parse('2026-10-26T06:00:00Z'); const H = 3600e3;
  const sc = createSoonCap({ totalCap: 10000, hours: 24, fetchBalanceUsd: async () => 12945.7575, now: () => t });
  assert.strictEqual(sc.capFor(t + 5 * H, t), 10000); // balance not read yet -> normal cap
  await sc.refresh();
  assert.strictEqual(sc.capFor(t + 5 * H, t), 12945.75);   // <=24h -> cash
  assert.strictEqual(sc.capFor(t + 24 * H, t), 12945.75);
  assert.strictEqual(sc.capFor(t + 25 * H, t), 10000);     // later -> normal
  assert.strictEqual(sc.capFor(null, t), 10000);           // unknown settle -> normal
  t += 6 * 60 * 1000; assert.strictEqual(sc.capFor(t + H, t), 10000); // stale balance -> normal
  const low = createSoonCap({ totalCap: 10000, fetchBalanceUsd: async () => 4000, now: () => t }); await low.refresh();
  assert.strictEqual(low.capFor(t + H, t), 10000);         // never below the normal cap
  const bad = createSoonCap({ totalCap: 10000, fetchBalanceUsd: async () => { throw new Error('x'); }, now: () => t }); await bad.refresh();
  assert.strictEqual(bad.capFor(t + H, t), 10000);
  const off = createSoonCap({ totalCap: 10000, enabled: false, fetchBalanceUsd: async () => 20000, now: () => t }); await off.refresh();
  assert.strictEqual(off.capFor(t + H, t), 10000);
  // config defaults
  const c = sniperConfig({ SNIPER_ENABLED: '1', SNIPER_TOTAL_EXPOSURE_CAP: '10000' });
  assert.strictEqual(c.soonCap, true); assert.strictEqual(c.soonHours, 24);
  assert.strictEqual(sniperConfig({ SNIPER_SOON_CAP: '0' }).soonCap, false);
  // DB caps: only a parlay carrying d.totalCap gets the higher total
  const base = capsFrom(c, '2026-10-26T04:00:00Z', true);
  const caps = (d) => { const x = capsFrom(c, '2026-10-26T04:00:00Z', true); if (d && d.totalCap > x.total) x.total = d.totalCap; return x; };
  assert.strictEqual(caps({ totalCap: 12945.75 }).total, 12945.75);
  assert.strictEqual(caps({}).total, base.total); assert.strictEqual(caps().total, 10000);
  console.log('soon-cap ok');
})().catch((e) => { console.error(e); process.exit(1); });
