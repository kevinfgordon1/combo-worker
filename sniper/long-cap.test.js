'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { settleAtMs } = require('./engine');
const { sniperConfig, } = require('../auto-sniper');
const { capsFrom } = require('./ledger-store');
test('settleAtMs = latest kickoff + game hours', () => {
  const ko = { A: 1000, B: 5000 };
  assert.strictEqual(settleAtMs(['A:yes', 'B:no'], (t) => ko[t], 4), 5000 + 4 * 3600e3);
  assert.strictEqual(settleAtMs(['A:yes', 'C:no'], (t) => ko[t], 4), null);
  assert.strictEqual(settleAtMs(['A:yes'], () => 0, 4), null); // started/unknown -> long
});
test('caps carry long_total + short_settle_hours from env', () => {
  const c = sniperConfig({ SNIPER_TOTAL_EXPOSURE_CAP: '10000', SNIPER_LONG_EXPOSURE_CAP: '5000', SNIPER_SHORT_SETTLE_HOURS: '32' });
  const caps = capsFrom(c, '2026-10-23T04:00:00Z', true);
  assert.strictEqual(caps.total, 10000); assert.strictEqual(caps.long_total, 5000); assert.strictEqual(caps.short_settle_hours, 32);
});
