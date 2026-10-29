'use strict';
// Oct 26 6:51 PM ET: a Polymarket lock quote EXECUTED (61.87 @ +575) but was never booked. The recent-quotes
// loader returned an arbitrary 300 of ~40k rows, so the executed quote had no submission row in scope and
// reconcile dropped it. reconcilePolymarketLockFills now looks missing executed quote ids up by id.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { reconcilePolymarketLockFills } = require('./polymarket-fill-reconcile');
const { createSeriesFeeCache } = require('./series-fee');

const LOCK = { id: 'lock-jazz', label: 'Utah Jazz ML + Tampa Bay Rays ML + Cleveland Cavaliers ML' };
const http = {
  async listQuotes(query) {
    if (query && query.userFilter === 'USER_FILTER_SELF' && query.status === 'QUOTE_STATUS_EXECUTED') {
      return { quotes: [{ id: 'q-jazz', rfqId: 'rfq-jazz', status: 'QUOTE_STATUS_EXECUTED', creatorOrderId: 'o-jazz', buyQtyDecimal: '61.87', symbol: 'crossd-20a23b816da19144' }] };
    }
    return { quotes: [] };
  },
  async getOrder(id) { return { id, cumQuantity: 61.87, state: 'ORDER_STATE_FILLED' }; },
};
const row = { quote_id: 'q-jazz', rfq_id: 'rfq-jazz', parlay_id: LOCK.id, label: LOCK.label, contracts: 67, user_id: 'u1', status: 'unfilled', market_ticker: 'crossd-20a23b816da19144' };
const unrelated = { quote_id: 'q-old', rfq_id: 'rfq-old', parlay_id: 'lock-old', label: 'old', contracts: 5, user_id: 'u1', status: 'unfilled' };

(async () => {
  // Before: submission row not in the bounded list -> executed quote is out of scope -> nothing booked.
  const before = await reconcilePolymarketLockFills(http, { pendingQuotes: new Map(), submissions: [unrelated], hydrate: false });
  assert.strictEqual(before.length, 0, 'without the by-id lookup the executed quote is dropped (the bug)');

  // After: the loader is asked only for the missing executed ids and the fill is booked to the right lock.
  const asked = [];
  const after = await reconcilePolymarketLockFills(http, {
    pendingQuotes: new Map(),
    submissions: [unrelated],
    hydrate: false,
    loadSubmissionsForQuoteIds: async (ids) => { asked.push(...ids); return ids.includes('q-jazz') ? [row] : []; },
  });
  assert.deepStrictEqual(asked, ['q-jazz']);
  assert.strictEqual(after.length, 1, 'executed quote must be booked once its submission is looked up by id');
  assert.strictEqual(after[0].quoteId, 'q-jazz');
  assert.strictEqual(after[0].contracts, 61.87);
  assert.strictEqual(after[0].parlayId, LOCK.id);

  // Venue EXECUTED size wins over our cash-RFQ estimate (67 logged, 61.87 sized by the venue).
  const direct = await reconcilePolymarketLockFills(http, { pendingQuotes: new Map(), submissions: [row], hydrate: false });
  assert.strictEqual(direct.length, 1);
  assert.strictEqual(direct[0].contracts, 61.87);
  // A wrong-size order on that quote is still refused.
  const wrongOrder = { ...http, async getOrder(id) { return { id, cumQuantity: 629.82, state: 'ORDER_STATE_FILLED' }; } };
  const refused = await reconcilePolymarketLockFills(wrongOrder, { pendingQuotes: new Map(), submissions: [row], hydrate: false });
  assert.strictEqual(refused.length, 0, 'order size must still match the venue quote size');

  // Already in scope -> loader not called.
  let called = false;
  await reconcilePolymarketLockFills(http, { pendingQuotes: new Map(), submissions: [row], hydrate: false, loadSubmissionsForQuoteIds: async () => { called = true; return []; } });
  assert.strictEqual(called, false);

  // Loader failure is fail-soft.
  const soft = await reconcilePolymarketLockFills(http, { pendingQuotes: new Map(), submissions: [unrelated], hydrate: false, loadSubmissionsForQuoteIds: async () => { throw new Error('db down'); } });
  assert.strictEqual(soft.length, 0);

  // live-runner loaders: newest-first, scoped, and wired.
  const src = fs.readFileSync(path.join(__dirname, 'live-runner.js'), 'utf8');
  const unfilled = src.slice(src.indexOf('async function loadUnfilledPolyQuotes'), src.indexOf('async function loadPolySubmissionsForQuoteIds'));
  assert.ok(/\.order\('created_at', \{ ascending: false \}\)/.test(unfilled), 'unfilled quotes must be newest first');
  const recent = src.slice(src.indexOf('async function loadRecentLocks'), src.indexOf('async function loadPolySlugRecordsUncached'));
  assert.strictEqual((recent.match(/\.order\('created_at', \{ ascending: false \}\)/g) || []).length, 2, 'both recent-lock queries newest first');
  assert.ok(/from\('combo_parlays'\)[\s\S]*?\.in\('user_id', SCOPE\.userIds\)/.test(recent), 'recent locks scoped to this worker');
  assert.ok(/loadPolySubmissionsForQuoteIds,/.test(src), 'by-id loader passed to the Polymarket loop');
  const rfqSrc = fs.readFileSync(path.join(__dirname, 'polymarket-rfq.js'), 'utf8');
  assert.ok(/loadSubmissionsForQuoteIds: typeof ctx\.loadPolySubmissionsForQuoteIds === 'function'/.test(rfqSrc));

  // crossd- combo symbols are Polymarket: maker rate 0, no Kalshi /series lookup.
  let fetched = 0;
  const fees = createSeriesFeeCache({ fetchImpl: async () => { fetched += 1; return { ok: false, status: 404, json: async () => ({}) }; } });
  assert.strictEqual(fees.rateForTicker('crossd-20a23b816da19144'), 0);
  assert.strictEqual(fees.rateForTicker('caoc-abc'), 0);
  await fees.prefetchTickers(['crossd-20a23b816da19144']).catch(() => {});
  assert.strictEqual(fetched, 0, 'no Kalshi series lookup for crossd- symbols');
  console.log('poly-fill-reconcile-recent: ok');
})().catch((e) => { console.error(e); process.exit(1); });
