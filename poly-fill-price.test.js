'use strict';
const assert = require('assert');
const { liveRunnerFillRow } = require('./fills-attr');
const { tradeFromActivity } = require('./polymarket-fill-reconcile');

const row = liveRunnerFillRow({ fillId: 'poly-act:X', parlayId: null, count: 26.19, venue: 'polymarket', yesPrice: 0.176, fee: 0 });
assert.strictEqual(row.yes_price, 0.176);
assert.strictEqual(row.no_price, 0.824);
assert.strictEqual(row.fee, 0);
const noPx = liveRunnerFillRow({ fillId: 'q', count: 1, venue: 'polymarket' });
assert.strictEqual(noPx.yes_price, null);
assert.strictEqual(noPx.no_price, null);
assert.strictEqual(noPx.fee, null);
const t = tradeFromActivity({ type: 'ACTIVITY_TYPE_TRADE', trade: { id: 'D2', qtyDecimal: '26.19', price: { value: '0.1760' }, marketSlug: 'caoc-x' } });
assert.strictEqual(t.price, 0.176);
console.log('poly-fill-price ok');
