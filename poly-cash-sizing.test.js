'use strict';
// Cash RFQs: Polymarket sizes C so that C·p + the requester's combo taker fee ≤ cash.
// floor(cash / p) ignored the fee and overstated the venue's size by 7–11%, so cash RFQs that
// really fit a lock's cap were skipped as rfq_too_large. Caps are unchanged; only the estimate moves.
const assert = require('assert');
const Q = require('./polymarket-quote');

const rawFee = (C, p) => C * p * (0.0695 * (1 - p) + 0.06 * (1 - p) ** 4);

// fee: docs.polymarket.us/fees (combo taker, schedule from 2026-10-19 1:00 PM ET), half-even cents
assert.strictEqual(Q.polyComboTakerFeeDollars(100, 0.25), 1.78);
assert.strictEqual(Q.polyComboTakerFeeDollars(0, 0.25), 0);
assert.strictEqual(Q.polyComboTakerFeeDollars(10, 0), 0);
assert.strictEqual(Q.polyComboTakerFeeDollars(10, 1), 0);

// REAL Polymarket cash fills (venue-recorded contracts):
assert.strictEqual(Q.polyCashContracts(5, 0.1471, {}), 31.13); // floor said 33
assert.strictEqual(Q.polyCashContracts(3, 0.138, {}), 19.86); // floor said 21

// largest fitting size on the 0.01 grid, at many prices (+100 … +5000)
for (let p = 0.02; p < 0.6; p += 0.0137) {
  for (const cash of [1, 2.5, 5, 10, 25, 100]) {
    const C = Q.polyCashContracts(cash, p, {});
    const cost = (c) => c * p + Q.polyComboTakerFeeDollars(c, p);
    assert.ok(cost(C) <= cash + 1e-9, `fits ${cash}@${p}`);
    assert.ok(cost(Math.round(C * 100 + 1) / 100) > cash + 1e-9, `largest ${cash}@${p}`);
    assert.ok(C < Math.floor(cash / p) + 1, 'never above the old estimate');
    assert.ok(Math.abs(C * 100 - Math.round(C * 100)) < 1e-9, '0.01 grid');
  }
}
// the overstatement is the 7–11% Kevin saw (+300 … +1900)
for (const [am, lo, hi] of [[300, 0.06, 0.08], [900, 0.09, 0.11], [1900, 0.10, 0.125]]) {
  const p = 100 / (am + 100);
  const C = Q.polyCashContracts(100, p, {});
  const over = (100 / p) / C - 1;
  assert.ok(over > lo && over < hi, `+${am}: ${over}`);
  assert.ok(Math.abs(rawFee(C, p) / (C * p) - (0.0695 * (1 - p) + 0.06 * (1 - p) ** 4)) < 1e-9);
}

// kill switch restores floor(cash / price)
for (const v of ['0', 'false', 'off', 'no']) assert.strictEqual(Q.polyCashContracts(5, 0.1471, { POLY_CASH_FEE_SIZING: v }), 33);
assert.ok(Q.polyCashFeeSizingEnabled({}));
assert.ok(!Q.polyCashFeeSizingEnabled({ POLY_CASH_FEE_SIZING: 'off' }));

// buildPolymarketQuote: qty RFQs untouched; cash RFQs use the fee-aware size; price unchanged
const qty = Q.buildPolymarketQuote({ fillAmerican: 350, qtyDecimal: '45', env: {} });
assert.strictEqual(qty.estimatedContracts, 45);
const cash = Q.buildPolymarketQuote({ fillAmerican: 350, cashOrderQty: '10', env: {} });
const legacy = Q.buildPolymarketQuote({ fillAmerican: 350, cashOrderQty: '10', env: { POLY_CASH_FEE_SIZING: '0' } });
assert.strictEqual(cash.buyPrice, legacy.buyPrice, 'pricing unchanged');
assert.strictEqual(cash.estimatedContracts, Q.polyCashContracts(10, parseFloat(cash.buyPrice), {}));
assert.strictEqual(legacy.estimatedContracts, Math.floor(10 / parseFloat(cash.buyPrice)));
assert.ok(cash.estimatedContracts < legacy.estimatedContracts * 0.95);
assert.strictEqual(Q.buildPolymarketQuote({ fillAmerican: 350, cashOrderQty: '0', env: {} }).estimatedContracts, 0);

console.log('poly-cash-sizing.test.js ok');
