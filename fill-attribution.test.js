'use strict';
const assert = require('assert');
const A = require('./fills-attr');
const CEL = { id: 'cel', combo_ticker: 'KXMVECROSSCATEGORY-S2026AMUHH3V564DCY2EW-YUSMDOJOE', mve_collection: 'KXMVESPORTSMULTIGAMEEXTENDED-R', active: true, fill_american: 325 };
const JAZ = { id: 'jaz', combo_ticker: 'KXMVECROSSCATEGORY-S2026WLU4ZGGXYKRTQA3M-AZYHRFA77', mve_collection: 'KXMVESPORTSMULTIGAMEEXTENDED-R', active: true, fill_american: 335 };
const fill = { fill_id: '0724098b', order_id: '01a15782', ticker: CEL.combo_ticker, count: 7, no_price: 0.758, kalshi_created_time: '2026-10-20T04:11:58.386Z' };
const subs = [
  { id: 's-cel', parlay_id: 'cel', quote_id: '42e13e74', order_id: null, contracts: 8, status: 'quoted', created_at: '2026-10-20T04:11:54.025Z' },
  { id: 's-jaz', parlay_id: 'jaz', quote_id: '7e0af3df', order_id: null, contracts: 67, status: 'quoted', created_at: '2026-10-20T04:12:20.700Z' },
];
// Oct 20 case: fill on Celtics' market goes to Celtics; Jazz's quote (posted 22s later) never stamped.
let r = A.attributeComboFill(fill.ticker, fill, [JAZ, CEL], { submissions: subs, existingFills: [] });
assert.strictEqual(r.parlay.id, 'cel');
assert.ok(!r.submission || r.submission.parlay_id === 'cel');
// Window path alone: quote posted after the fill is not a candidate; other-market lock excluded.
assert.strictEqual(A.attributeFromSubmissions({ ...fill, ticker: 'OTHER' }, [subs[1]], [JAZ]), null);
assert.strictEqual(A.attributeFromSubmissions(fill, [{ ...subs[1], created_at: '2026-10-20T04:11:50Z' }], [JAZ]), null);
// Price fallback cannot pick a lock whose combo_ticker is a different market.
assert.strictEqual(A.attributeParlay(fill.ticker, fill, [JAZ]), null);
// Stamp guards: other lock's quote, or a quote posted after the fill.
assert.strictEqual(A.canStampSubmission(subs[1], fill, 'cel'), false);
assert.strictEqual(A.canStampSubmission({ ...subs[1], parlay_id: 'cel' }, fill, 'cel'), false);
assert.strictEqual(A.canStampSubmission(subs[0], fill, 'cel'), true);
// Filled size recorded (quote 8, filled 7).
assert.strictEqual(A.submissionFilledPatch(fill, { filledContracts: 7 }).filled_contracts, 7);
// Unknown combo_ticker locks still attribute as before (shard tickers).
assert.strictEqual(A.parlayTickerConflicts({ id: 'x' }, fill.ticker), false);
// Lock storing a Polymarket slug still owns its Kalshi fills.
const POLYLOCK = { id: 'pl', combo_ticker: 'caoc-d0f39fbb8444abd5', mve_collection: 'KXMVESPORTSMULTIGAMEEXTENDED-R', active: true, fill_american: 325 };
assert.strictEqual(A.parlayTickerConflicts(POLYLOCK, 'KXMVECROSSCATEGORY0-S2026E57DF40B830-4AD83C37EE0'), false);
assert.strictEqual(A.attributeParlay('KXMVECROSSCATEGORY0-S2026E57DF40B830-4AD83C37EE0', { no_price: 0.758 }, [POLYLOCK]).id, 'pl');
console.log('fill-attribution tests ok');
