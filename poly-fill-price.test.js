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
const { slugYesPrice, positionFillEvent } = require('./polymarket-fill-reconcile');
const acts = [
  { type: 'ACTIVITY_TYPE_TRADE', trade: { id: 'A', qtyDecimal: '12.41', price: { value: '0.091' }, marketSlug: 'caoc-s' } },
  { type: 'ACTIVITY_TYPE_TRADE', trade: { id: 'B', qtyDecimal: '79.66', price: { value: '0.091' }, marketSlug: 'caoc-s' } },
];
assert.strictEqual(slugYesPrice(acts, 'caoc-s'), 0.091);
assert.strictEqual(slugYesPrice(acts, 'caoc-x'), null);
const pe = positionFillEvent({ pos: { marketSlug: 'caoc-s', netPosition: '92.07' }, lock: { id: 'L' }, yesPrice: 0.091 });
if (pe) { assert.strictEqual(pe.yesPrice, 0.091); assert.strictEqual(pe.fee, 0); }
console.log('poly-pos price ok');
