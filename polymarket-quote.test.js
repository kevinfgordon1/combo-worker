'use strict';
const assert = require('assert');
const { impliedProb } = require('./engine');
const {
  TICK,
  SELL_PRICE_DECLINE,
  fillAmericanToBuyPrice,
  buildPolymarketQuote,
  shouldConfirmPolymarketAccept,
  shouldPostPolymarketQuote,
} = require('./polymarket-quote');

assert.strictEqual(TICK, 0.001);
assert.strictEqual(SELL_PRICE_DECLINE, '0');

// +350 → 100/450 = 0.2222… → floor to 0.001, never round up to 0.223.
assert.strictEqual(impliedProb(350), 100 / 450);
assert.ok(impliedProb(350) > 0.222);
assert.ok(impliedProb(350) < 0.223);
assert.strictEqual(fillAmericanToBuyPrice(350), '0.222');
assert.strictEqual(fillAmericanToBuyPrice('+350'), '0.222');
assert.strictEqual(fillAmericanToBuyPrice(350.0), '0.222');

// +1000 → 100/1100 = 0.0909… → "0.090"
assert.strictEqual(fillAmericanToBuyPrice(1000), '0.090');
assert.strictEqual(fillAmericanToBuyPrice('+1000'), '0.090');

// Negative American (favorite): |-150| / (|-150|+100) = 0.6 → "0.600"
assert.strictEqual(fillAmericanToBuyPrice(-150), '0.600');

// Floor, not nearest-tick: +349 → 100/449 ≈ 0.2227 would round to 0.223.
assert.ok(impliedProb(349) > 0.2225);
assert.strictEqual(fillAmericanToBuyPrice(349), '0.222');

assert.strictEqual(fillAmericanToBuyPrice(null), null);
assert.strictEqual(fillAmericanToBuyPrice(undefined), null);
assert.strictEqual(fillAmericanToBuyPrice(''), null);
assert.strictEqual(fillAmericanToBuyPrice(0), null);
assert.strictEqual(fillAmericanToBuyPrice('0'), null);
assert.strictEqual(fillAmericanToBuyPrice(NaN), null);
assert.strictEqual(fillAmericanToBuyPrice(Infinity), null);
assert.strictEqual(fillAmericanToBuyPrice('nope'), null);

const cash = buildPolymarketQuote({ fillAmerican: 350, cashOrderQty: 10 });
assert.ok(cash);
assert.strictEqual(cash.buyPrice, '0.222');
assert.strictEqual(cash.sellPrice, '0');
assert.notStrictEqual(cash.sellPrice, '0.00');
assert.strictEqual(cash.estimatedContracts, Math.floor(10 / 0.222));
assert.strictEqual(cash.estimatedContracts, 45);
assert.ok(shouldPostPolymarketQuote(cash));

const cashStr = buildPolymarketQuote({ fillAmerican: 350, cashOrderQty: '10.0000' });
assert.strictEqual(cashStr.estimatedContracts, 45);
assert.strictEqual(cashStr.sellPrice, '0');

const qty = buildPolymarketQuote({ fillAmerican: 350, qtyDecimal: 10 });
assert.strictEqual(qty.buyPrice, '0.222');
assert.strictEqual(qty.sellPrice, '0');
assert.strictEqual(qty.estimatedContracts, 10);
assert.ok(shouldPostPolymarketQuote(qty));

const qtyStr = buildPolymarketQuote({ fillAmerican: 1000, qtyDecimal: '12.00' });
assert.strictEqual(qtyStr.buyPrice, '0.090');
assert.strictEqual(qtyStr.sellPrice, '0');
assert.strictEqual(qtyStr.estimatedContracts, 12);

// qtyDecimal wins when both are present (venue treats them as mutually exclusive).
const both = buildPolymarketQuote({ fillAmerican: 350, qtyDecimal: 8, cashOrderQty: 10 });
assert.strictEqual(both.estimatedContracts, 8);

assert.strictEqual(buildPolymarketQuote({ fillAmerican: 0, cashOrderQty: 10 }), null);
assert.strictEqual(buildPolymarketQuote({ fillAmerican: null, qtyDecimal: 10 }), null);
assert.strictEqual(buildPolymarketQuote({}), null);

const zeroCash = buildPolymarketQuote({ fillAmerican: 350, cashOrderQty: 0 });
assert.strictEqual(zeroCash.buyPrice, '0.222');
assert.strictEqual(zeroCash.sellPrice, '0');
assert.strictEqual(zeroCash.estimatedContracts, 0);
assert.strictEqual(shouldPostPolymarketQuote(zeroCash), false);

assert.strictEqual(shouldPostPolymarketQuote({ estimatedContracts: 45 }), true);
assert.strictEqual(shouldPostPolymarketQuote({ estimatedContracts: 0 }), false);
assert.strictEqual(shouldPostPolymarketQuote({ estimatedContracts: null }), false);
assert.strictEqual(shouldPostPolymarketQuote(null), false);
assert.strictEqual(shouldPostPolymarketQuote({ contracts: 10 }), false);

assert.strictEqual(shouldConfirmPolymarketAccept('SIDE_BUY'), true);
assert.strictEqual(shouldConfirmPolymarketAccept('buy'), true);
assert.strictEqual(shouldConfirmPolymarketAccept('BUY'), true);
assert.strictEqual(shouldConfirmPolymarketAccept('side_buy'), true);
assert.strictEqual(shouldConfirmPolymarketAccept(' SIDE_BUY '), true);

assert.strictEqual(shouldConfirmPolymarketAccept('SIDE_SELL'), false);
assert.strictEqual(shouldConfirmPolymarketAccept('sell'), false);
assert.strictEqual(shouldConfirmPolymarketAccept('SELL'), false);
assert.strictEqual(shouldConfirmPolymarketAccept('side_sell'), false);
assert.strictEqual(shouldConfirmPolymarketAccept(null), false);
assert.strictEqual(shouldConfirmPolymarketAccept(''), false);
assert.strictEqual(shouldConfirmPolymarketAccept('SIDE_UNSPECIFIED'), false);

console.log('polymarket-quote.test.js ok');
