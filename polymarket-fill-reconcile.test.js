'use strict';
const assert = require('assert');
const {
  isExecutedQuoteStatus,
  isFilledOrderState,
  isPartialOrderState,
  cumQuantityOf,
  incrementFromCum,
  reconcileFillId,
  fillEventFromReconcile,
  lockLabelMatchesMarket,
  uniqueLockForMarket,
  tradeFromActivity,
  matchActivitiesToLocks,
  matchPositionsToLocks,
  pendingFromSubmission,
  mergeQuoteCandidates,
  pickReconcileCandidates,
  resolveQuoteFill,
  reconcilePolymarketLockFills,
  orderFromResponse,
} = require('./polymarket-fill-reconcile');
const { claimFillKey } = require('./fills-attr');

const LOCK = {
  id: 'aee3b29d-2a4b-4dd6-8dd5-37358b0aa294',
  label: 'Cleveland Guardians ML + New York Yankees ML + San Francisco Giants ML',
  user_id: 'u1',
  max_contracts: 479,
};

{
  assert.ok(isExecutedQuoteStatus('QUOTE_STATUS_EXECUTED'));
  assert.ok(isExecutedQuoteStatus('executed'));
  assert.ok(!isExecutedQuoteStatus('QUOTE_STATUS_CONFIRMED'));
  assert.ok(isFilledOrderState('ORDER_STATE_FILLED'));
  assert.ok(isFilledOrderState('ORDER_STATE_PARTIALLY_FILLED'));
  assert.ok(isPartialOrderState('ORDER_STATE_PARTIALLY_FILLED'));
  assert.ok(!isFilledOrderState('ORDER_STATE_NEW'));
  assert.strictEqual(cumQuantityOf({ cumQuantity: '50.5' }), 50.5);
  assert.strictEqual(cumQuantityOf(orderFromResponse({ order: { cum_quantity: 10 } })), 10);
  assert.strictEqual(incrementFromCum(107.68, 50), 57.68);
  assert.strictEqual(incrementFromCum(107.68, 107.68), 0);
  assert.strictEqual(incrementFromCum(0, 0), 0);
  assert.strictEqual(reconcileFillId('q1', 'o1', 50), 'poly-recon:q1:50');
  assert.strictEqual(reconcileFillId('q1', 'o1', 50), reconcileFillId('q1', 'o1', 50));
}

{
  const seen = new Set();
  assert.strictEqual(claimFillKey(seen, 'exec-1'), true);
  assert.strictEqual(claimFillKey(seen, 'exec-1'), false, 'duplicate execution is idempotent');
  assert.strictEqual(claimFillKey(seen, 'exec-2'), true);
  assert.strictEqual(claimFillKey(seen, null), true, 'missing key must not block persist');
}

{
  const pending = pendingFromSubmission({
    quote_id: 'q1',
    parlay_id: LOCK.id,
    label: LOCK.label,
    contracts: 70,
    user_id: 'u1',
    rfq_id: 'rfq-1',
    status: 'unfilled',
  });
  const partial = fillEventFromReconcile({
    quote: { id: 'q1', rfqId: 'rfq-1', creatorOrderId: 'o1', buyQtyDecimal: '70' },
    order: { id: 'o1', cumQuantity: 50, state: 'ORDER_STATE_PARTIALLY_FILLED' },
    pending,
    alreadyFilled: 0,
  });
  assert.ok(partial);
  assert.strictEqual(partial.contracts, 50);
  assert.strictEqual(partial.isPartial, true);
  assert.strictEqual(partial.venue, 'polymarket');
  assert.strictEqual(partial.fillId, 'poly-recon:q1:50');
  assert.strictEqual(partial.parlayId, LOCK.id);

  const rest = fillEventFromReconcile({
    quote: { id: 'q1', creatorOrderId: 'o1', buyQtyDecimal: '70' },
    order: { id: 'o1', cumQuantity: 70, state: 'ORDER_STATE_FILLED' },
    pending,
    alreadyFilled: 50,
  });
  assert.strictEqual(rest.contracts, 20);
  assert.strictEqual(rest.isPartial, false);

  const replay = fillEventFromReconcile({
    quote: { id: 'q1', creatorOrderId: 'o1', buyQtyDecimal: '70' },
    order: { id: 'o1', cumQuantity: 70, state: 'ORDER_STATE_FILLED' },
    pending,
    alreadyFilled: 70,
  });
  assert.strictEqual(replay, null, 'replay of a completed cum qty must not add again');

  const executedOnly = fillEventFromReconcile({
    quote: { id: 'q1', status: 'QUOTE_STATUS_EXECUTED', buyQtyDecimal: '70' },
    pending,
    allowExecutedWithoutOrder: true,
  });
  assert.strictEqual(executedOnly.contracts, 70);
  assert.strictEqual(
    fillEventFromReconcile({
      quote: { id: 'q1', status: 'QUOTE_STATUS_EXECUTED', buyQtyDecimal: '70' },
      pending,
      allowExecutedWithoutOrder: false,
    }),
    null,
    'EXECUTED without an order snapshot is not a fill'
  );
}

{
  assert.ok(lockLabelMatchesMarket(
    LOCK.label,
    'Chicago White Sox vs Cleveland Guardians / San Francisco Giants vs St Louis / New York Yankees',
    'combo-cle-nyy-sf'
  ));
  assert.ok(!lockLabelMatchesMarket(LOCK.label, 'Yankees only', 'nyy'));
  assert.strictEqual(uniqueLockForMarket([LOCK, { id: 'other', label: 'Bills ML + Chiefs ML' }], LOCK.label, ''), LOCK);
  assert.strictEqual(uniqueLockForMarket([LOCK, { ...LOCK, id: 'dup' }], LOCK.label, ''), null);
}

{
  const trade = tradeFromActivity({
    type: 'ACTIVITY_TYPE_TRADE',
    trade: {
      id: 't1',
      marketSlug: 'cleveland-guardians-new-york-yankees-san-francisco-giants',
      qtyDecimal: '2394.34',
      price: { value: '0.859', currency: 'USD' },
      isAggressor: false,
      state: 'TRADE_STATE_CLEARED',
    },
  });
  assert.strictEqual(trade.qty, 2394.34);
  const evts = matchActivitiesToLocks([{ trade: trade }], [LOCK]);
  assert.strictEqual(evts.length, 1);
  assert.strictEqual(evts[0].parlayId, LOCK.id);
  assert.strictEqual(evts[0].contracts, 2394.34);
  assert.strictEqual(evts[0].fillId, 'poly-act:t1');
}

{
  const evts = matchPositionsToLocks([{
    marketSlug: 'cle-nyy-sf-combo',
    qtyBoughtDecimal: '2394.34',
    cost: { value: '2056.74', currency: 'USD' },
    marketMetadata: { title: LOCK.label, slug: 'cle-nyy-sf-combo' },
  }], [LOCK]);
  assert.strictEqual(evts.length, 1);
  assert.strictEqual(evts[0].contracts, 2394.34);
  assert.ok(evts[0].fillId.startsWith('poly-pos:'));
}

{
  const pendingQuotes = new Map();
  pendingQuotes.set('q-mem', { parlayId: LOCK.id, label: LOCK.label, contracts: 9, rfqId: 'rfq-m', creatorOrderId: 'o-mem' });
  const merged = mergeQuoteCandidates(
    [{ id: 'q-exec', status: 'QUOTE_STATUS_EXECUTED', creatorOrderId: 'o-exec' }],
    [{ quote_id: 'q-db', rfq_id: 'rfq-db', contracts: 70, parlay_id: LOCK.id, status: 'unfilled', label: LOCK.label }],
    pendingQuotes
  );
  const ids = merged.map((c) => c.id).sort();
  assert.deepStrictEqual(ids, ['q-db', 'q-exec', 'q-mem']);
  const seen = new Set(['q-exec']);
  const picked = pickReconcileCandidates(merged, { maxPerTick: 2, seenQuoteIds: seen });
  assert.ok(!picked.some((c) => c.id === 'q-exec'));
}

(async () => {
  const http = {
    async getOrder(id) {
      if (id === 'o-fill') return { order: { id, cumQuantity: 66, state: 'ORDER_STATE_FILLED' } };
      return null;
    },
    async listQuotes() { return { quotes: [] }; },
  };
  const evt = await resolveQuoteFill(http, {
    quote: { id: 'q-miss', status: 'QUOTE_STATUS_EXECUTED', creatorOrderId: 'o-fill', buyQtyDecimal: '66' },
    pending: { parlayId: LOCK.id, label: LOCK.label, contracts: 66, userId: 'u1' },
    alreadyFilled: 0,
  });
  assert.ok(evt);
  assert.strictEqual(evt.contracts, 66);
  assert.strictEqual(evt.quoteId, 'q-miss');
  assert.strictEqual(evt.orderId, 'o-fill');
  assert.strictEqual(evt.source, 'poly-reconcile');

  const recovered = [];
  const reconHttp = {
    async listQuotes(query) {
      if (query && query.userFilter === 'USER_FILTER_SELF' && query.status === 'QUOTE_STATUS_EXECUTED') {
        return {
          quotes: [{
            id: 'q-late',
            rfqId: 'rfq-late',
            status: 'QUOTE_STATUS_EXECUTED',
            creatorOrderId: 'o-late',
            buyQtyDecimal: '48.55',
          }],
        };
      }
      return { quotes: [] };
    },
    async getOrder(id) {
      assert.strictEqual(id, 'o-late');
      return { id, cumQuantity: 48.55, state: 'ORDER_STATE_FILLED' };
    },
  };
  const events = await reconcilePolymarketLockFills(reconHttp, {
    pendingQuotes: new Map(),
    submissions: [{
      quote_id: 'q-late',
      rfq_id: 'rfq-late',
      parlay_id: LOCK.id,
      label: LOCK.label,
      contracts: 48.55,
      user_id: 'u1',
      status: 'unfilled',
    }],
    hydrate: false,
  });
  assert.strictEqual(events.length, 1, 'reconcile must recover a fill the live WS path missed');
  assert.strictEqual(events[0].quoteId, 'q-late');
  assert.strictEqual(events[0].contracts, 48.55);
  recovered.push(events[0]);

  const again = await reconcilePolymarketLockFills(reconHttp, {
    pendingQuotes: new Map(),
    submissions: [{
      quote_id: 'q-late',
      rfq_id: 'rfq-late',
      parlay_id: LOCK.id,
      label: LOCK.label,
      contracts: 48.55,
      status: 'unfilled',
    }],
    alreadyFilledByQuote: { 'q-late': 48.55 },
    hydrate: false,
  });
  assert.strictEqual(again.length, 0, 'reconcile of an already-booked cum qty is a no-op');

  console.log('polymarket-fill-reconcile.test.js ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
