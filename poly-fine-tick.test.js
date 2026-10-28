'use strict';
// Sharper longshot pricing: quote on the RFQ's own tickSize (combos are 0.0001) so the price is the
// closest tick that still never beats the lock.
const assert = require('assert');
const Q = require('./polymarket-quote');
const { impliedProb } = require('./engine');
const env = {};
const am = (p) => (p < 0.5 ? (100 * (1 - p)) / p : (-100 * p) / (1 - p));

// resolveTick: trust 0.0001-lattice ticks in [0.0001, 0.01]; anything else -> 0.001.
assert.strictEqual(Q.resolveTick(0.0001, env), 0.0001);
assert.strictEqual(Q.resolveTick('0.0001', env), 0.0001);
assert.strictEqual(Q.resolveTick(0.001, env), 0.001);
assert.strictEqual(Q.resolveTick(0.01, env), 0.01);
for (const bad of [null, undefined, '', 0, -1, 0.00001, 0.00015, 0.5, 'abc']) assert.strictEqual(Q.resolveTick(bad, env), 0.001, String(bad));
// Kill switch.
assert.strictEqual(Q.resolveTick(0.0001, { POLY_FINE_TICK: '0' }), 0.001);
assert.strictEqual(Q.polyFineTickEnabled({}), true);
assert.strictEqual(Q.polyFineTickEnabled({ POLY_FINE_TICK: 'off' }), false);

// Pinned before/after.
const cases = [
  [375, '0.211', '0.2106'],
  [416, '0.194', '0.1938'],
  [1160, '0.080', '0.0794'],
  [2300, '0.042', '0.0417'],
  [5000, '0.020', '0.0197'],
];
for (const [lock, before, after] of cases) {
  assert.strictEqual(Q.buildPolymarketQuote({ fillAmerican: lock, qtyDecimal: '10', exact: true, env }).buyPrice, before, `no tick ${lock}`);
  assert.strictEqual(Q.buildPolymarketQuote({ fillAmerican: lock, qtyDecimal: '10', exact: true, env, tickSize: 0.001 }).buyPrice, before, `0.001 ${lock}`);
  assert.strictEqual(Q.buildPolymarketQuote({ fillAmerican: lock, qtyDecimal: '10', exact: true, env, tickSize: 0.0001 }).buyPrice, after, `0.0001 ${lock}`);
  assert.strictEqual(Q.buildPolymarketQuote({ fillAmerican: lock, qtyDecimal: '10', exact: true, env: { POLY_FINE_TICK: '0' }, tickSize: 0.0001 }).buyPrice, before, `switch off ${lock}`);
}

// Property: for every lock +100..+20000 and -110..-2000, the 0.0001 price is on-grid, never beats the lock
// (price >= implied prob), and is within one tick of it. Never worse than the 0.001 price.
const locks = [];
for (let a = 100; a <= 20000; a += 7) locks.push(a);
for (let a = -110; a >= -2000; a -= 3) locks.push(a);
for (const lock of locks) {
  const target = impliedProb(lock);
  const fine = Q.buildPolymarketQuote({ fillAmerican: lock, qtyDecimal: '10', exact: true, env, tickSize: 0.0001 });
  const coarse = Q.buildPolymarketQuote({ fillAmerican: lock, qtyDecimal: '10', exact: true, env, tickSize: 0.001 });
  const p = parseFloat(fine.buyPrice);
  assert.ok(/^0\.\d{4}$/.test(fine.buyPrice), fine.buyPrice);
  assert.ok(p + 1e-12 >= target, `beats lock ${lock}: ${p} < ${target}`);
  assert.ok(p - target < 0.0001 + 1e-12, `more than a tick off ${lock}`);
  assert.ok(p <= parseFloat(coarse.buyPrice) + 1e-12, `fine worse than coarse ${lock}`);
  assert.ok(am(p) <= lock + 1e-6, `American beats lock ${lock}: ${am(p)}`);
}

// Cash RFQ sizing follows the price actually sent.
const cash = Q.buildPolymarketQuote({ fillAmerican: 2300, cashOrderQty: '10', exact: true, env, tickSize: 0.0001 });
assert.strictEqual(cash.estimatedContracts, Q.polyCashContracts(10, 0.0417));
assert.strictEqual(cash.estimatedContracts, 214.62); // floor(10 / 0.0417) = 239 ignored the taker fee

// normalizePolymarketRfq keeps tickSize.
const { normalizePolymarketRfq } = require('./polymarket-rfq');
assert.strictEqual(normalizePolymarketRfq({ id: 'r', symbol: 'caoc-x', tickSize: 0.0001 }).tickSize, 0.0001);
assert.strictEqual(normalizePolymarketRfq({ rfq: { id: 'r', tick_size: '0.0001' } }).tickSize, '0.0001');
assert.strictEqual(normalizePolymarketRfq({ id: 'r' }).tickSize, null);
console.log('poly-fine-tick ok');
