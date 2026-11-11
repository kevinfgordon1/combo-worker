'use strict';
// Polymarket US combo maker fee: $0 before 2026-11-14 12:00 AM ET, then
// 0.03 × C × p × (1 − p), banker's-rounded to the cent. Quotes price it in.
const assert = require('assert');
const { impliedProb, decideAtFill, americanFromProb } = require('./engine');
const { buildPolymarketQuote } = require('./polymarket-quote');
const { positionFillEvent } = require('./polymarket-fill-reconcile');
const {
  POLY_COMBO_MAKER_FEE_EFFECTIVE_AT,
  POLY_COMBO_MAKER_RATE,
  polyComboMakerRate,
  polyComboMakerFeeDollars,
  polyComboMakerFeePerContract,
  polyComboMakerFeeForFill,
  roundHalfEvenCents,
} = require('./poly-combo-fee');

const BEFORE = '2026-11-14T04:59:59.999Z';
const AT = '2026-11-14T05:00:00.000Z';

assert.strictEqual(POLY_COMBO_MAKER_FEE_EFFECTIVE_AT, Date.parse('2026-11-14T05:00:00Z'));
assert.strictEqual(POLY_COMBO_MAKER_RATE, 0.03);
assert.strictEqual(polyComboMakerRate(BEFORE), 0);
assert.strictEqual(polyComboMakerRate(AT), 0.03);
assert.strictEqual(polyComboMakerRate(Date.parse(BEFORE)), 0);
assert.strictEqual(polyComboMakerRate(new Date(AT)), 0.03);

// Docs example: 100 contracts at $0.10 = $0.27, and $0 the millisecond before.
assert.strictEqual(polyComboMakerFeeDollars(100, 0.10, BEFORE), 0);
assert.strictEqual(polyComboMakerFeeDollars(100, 0.10, AT), 0.27);

// Fee-schedule table (100-lot, banker's cent). 0.01 → 0.0297 → $0.03; 0.25 → 0.5625 → $0.56.
assert.strictEqual(polyComboMakerFeeDollars(100, 0.01, AT), 0.03);
assert.strictEqual(polyComboMakerFeeDollars(100, 0.05, AT), 0.14);
assert.strictEqual(polyComboMakerFeeDollars(100, 0.22, AT), 0.51);
assert.strictEqual(polyComboMakerFeeDollars(100, 0.25, AT), 0.56);
assert.strictEqual(polyComboMakerFeeDollars(100, 0.50, AT), 0.75);
assert.strictEqual(roundHalfEvenCents(0.025), 0.02);
assert.strictEqual(roundHalfEvenCents(0.035), 0.04);

// Single-market maker fills stay $0. Combo slugs (caoc and crossd) pay the schedule.
assert.strictEqual(polyComboMakerFeeForFill({ contracts: 100, price: 0.10, at: AT, market: 'aec-nfl-buf-nyj-2026-11-15' }), 0);
assert.strictEqual(polyComboMakerFeeForFill({ contracts: 100, price: 0.10, at: AT, market: 'caoc-abc' }), 0.27);
assert.strictEqual(polyComboMakerFeeForFill({ contracts: 100, price: 0.10, at: AT, market: 'crossd-abc' }), 0.27);
assert.strictEqual(polyComboMakerFeeForFill({ contracts: 100, price: 0.10, at: BEFORE, market: 'caoc-abc' }), 0);
// No slug and not a known combo path → do not invent a combo fee.
assert.strictEqual(polyComboMakerFeeForFill({ contracts: 100, price: 0.10, at: AT }), 0);

// A 1-lot at $0.10 is 0.27¢ and rounds to $0, so the quote does not move.
assert.strictEqual(polyComboMakerFeeDollars(1, 0.10, AT), 0);
const oneBefore = buildPolymarketQuote({ fillAmerican: 900, qtyDecimal: 1, tickSize: 0.0001, exact: true, at: BEFORE });
const oneAfter = buildPolymarketQuote({ fillAmerican: 900, qtyDecimal: 1, tickSize: 0.0001, exact: true, at: AT });
assert.strictEqual(oneAfter.buyPrice, oneBefore.buyPrice);

// Quote adjustment on the combo 0.0001 grid. 100 contracts, fee does not round away.
const examples = [];
for (const am of [100, 300, 900]) {
  const before = buildPolymarketQuote({ fillAmerican: am, qtyDecimal: 100, tickSize: 0.0001, exact: true, at: BEFORE });
  const after = buildPolymarketQuote({ fillAmerican: am, qtyDecimal: 100, tickSize: 0.0001, exact: true, at: AT });
  const target = impliedProb(am);
  const px = parseFloat(after.buyPrice);
  const drag = polyComboMakerFeePerContract(px, 100, AT);
  assert.ok(parseFloat(before.buyPrice) + 1e-12 >= target, `before +${am}`);
  assert.ok(px - drag + 1e-12 >= target, `after net +${am}: ${px} - ${drag} < ${target}`);
  assert.ok(px > parseFloat(before.buyPrice) + 1e-12, `quote did not rise +${am}`);
  // One tick cheaper would miss the lock after the fee.
  const lower = Math.round((px - 0.0001) * 10000) / 10000;
  const lowerDrag = polyComboMakerFeePerContract(lower, 100, AT);
  assert.ok(lower - lowerDrag < target - 1e-12, `+${am} tick ${lower} still clears`);
  examples.push({
    lock: am > 0 ? `+${am}` : String(am),
    before: americanFromProb(parseFloat(before.buyPrice)),
    after: americanFromProb(px),
    beforePx: before.buyPrice,
    afterPx: after.buyPrice,
  });
}
// Locked American odds for the PR (0.0001 combo tick, 100 contracts).
// +100 is exactly $0.50. americanFromProb labels that −100 (even money); the
// quote after the fee is a favorite, −103.
assert.deepStrictEqual(examples.map((e) => [e.lock, e.before, e.after, e.beforePx, e.afterPx]), [
  ['+100', -100, -103, '0.5000', '0.5075'],
  ['+300', 300, 291, '0.2500', '0.2557'],
  ['+900', 900, 873, '0.1000', '0.1028'],
]);

// Break-even lock: stake $10 at +900, sell 100 contracts. At the net price both
// sides are $0. Quoting the old price after the fee is negative; the adjusted
// quote is not.
function profitAt(buyPrice, at) {
  return decideAtFill({
    parlayStake: 10,
    parlayAmerican: 900,
    fillAmerican: 900,
    rfqContracts: 100,
    maxContracts: 1000,
    polyQuote: { buyPrice, credit: 0, enforce: false, at },
  });
}
const oldPx = buildPolymarketQuote({ fillAmerican: 900, qtyDecimal: 100, tickSize: 0.0001, exact: true, at: BEFORE }).buyPrice;
const newPx = buildPolymarketQuote({ fillAmerican: 900, qtyDecimal: 100, tickSize: 0.0001, exact: true, at: AT }).buyPrice;
const beforeFee = profitAt(oldPx, BEFORE);
assert.strictEqual(beforeFee.ok, true);
assert.ok(beforeFee.worstAtQuote >= 0, `pre-fee worst ${beforeFee.worstAtQuote}`);
const stale = profitAt(oldPx, AT);
assert.strictEqual(stale.ok, true);
assert.ok(stale.worstAtQuote < 0, `stale quote should be negative, got ${stale.worstAtQuote}`);
const adjusted = profitAt(newPx, AT);
assert.strictEqual(adjusted.ok, true);
assert.ok(adjusted.worstAtQuote >= 0, `adjusted worst ${adjusted.worstAtQuote}`);
const enforced = decideAtFill({
  parlayStake: 10, parlayAmerican: 900, fillAmerican: 900,
  rfqContracts: 100, maxContracts: 1000,
  polyQuote: { buyPrice: newPx, credit: 0, enforce: true, at: AT },
});
assert.strictEqual(enforced.ok, true, enforced.reason);

// Position recovery of a combo slug uses the same cutoff. A single-market slug stays $0.
const comboPos = positionFillEvent({
  pos: { marketSlug: 'caoc-s', netPosition: '100' }, lock: { id: 'L' }, yesPrice: 0.10, at: AT,
});
assert.strictEqual(comboPos.fee, 0.27);
const earlyPos = positionFillEvent({
  pos: { marketSlug: 'caoc-s', netPosition: '100' }, lock: { id: 'L' }, yesPrice: 0.10, at: BEFORE,
});
assert.strictEqual(earlyPos.fee, 0);
const singlePos = positionFillEvent({
  pos: { marketSlug: 'aec-nfl-buf-nyj-2026-11-15', netPosition: '100' }, lock: { id: 'L' }, yesPrice: 0.10, at: AT,
});
assert.strictEqual(singlePos.fee, 0);

console.log('poly-combo-fee.test.js ok', examples.map((e) => `${e.lock} ${e.before} → ${e.after} (${e.beforePx} → ${e.afterPx})`).join('; '));
