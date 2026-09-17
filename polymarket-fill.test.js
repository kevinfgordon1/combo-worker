'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { liveRunnerFillRow, resolveFillLookup, findPendingFill, submissionAlreadyFilled, claimFillKey } = require('./fills-attr');
const { parsePrivateMessage } = require('./polymarket-client');
const { decideAtFill } = require('./engine');
const {
  orderIdFromExecution,
  quoteIdFromExecution,
  rfqIdFromExecution,
  executionFillId,
  normalizeExecutionType,
  isOrderFillExecution,
  isOrderCancelExecution,
  contractsFromExecution,
  findPendingForOrderExecution,
  orderFillEvent,
  startPolymarketRfqLoop,
} = require('./polymarket-rfq');

const SEED_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const pending = {
  parlayId: 'p-jets',
  userId: 'u1',
  contracts: 107.68,
  label: 'Jets + Rams + Ravens',
  rfqId: 'rfq-jets',
  maxContracts: 200,
  creatorOrderId: 'poly-order-1',
};

{
  const ex = {
    type: 'EXECUTION_TYPE_FILL',
    lastShares: '107.68',
    order: { id: 'poly-order-1', quoteId: 'quote-jets' },
    executionId: 'exec-1',
  };
  assert.strictEqual(orderIdFromExecution(ex), 'poly-order-1');
  assert.strictEqual(quoteIdFromExecution(ex), 'quote-jets');
  assert.strictEqual(rfqIdFromExecution({ order: { rfqId: 'rfq-jets' } }), 'rfq-jets');
  assert.strictEqual(executionFillId(ex, 'poly-order-1', 'quote-jets'), 'exec-1');
  assert.ok(isOrderFillExecution('EXECUTION_TYPE_PARTIAL_FILL'));
  assert.ok(isOrderFillExecution('execution_type_fill'));
  assert.ok(isOrderCancelExecution('EXECUTION_TYPE_CANCELED'));
  assert.ok(!isOrderFillExecution('quoteExecuted'));
  assert.strictEqual(normalizeExecutionType(1), 'EXECUTION_TYPE_PARTIAL_FILL');
  assert.strictEqual(normalizeExecutionType(2), 'EXECUTION_TYPE_FILL');
  assert.strictEqual(normalizeExecutionType('2'), 'EXECUTION_TYPE_FILL');
  assert.strictEqual(normalizeExecutionType('PARTIAL_FILL'), 'EXECUTION_TYPE_PARTIAL_FILL');
  assert.strictEqual(normalizeExecutionType('FILL'), 'EXECUTION_TYPE_FILL');
  assert.ok(isOrderFillExecution(1));
  assert.ok(isOrderFillExecution(2));
  assert.ok(isOrderFillExecution('1'));
  assert.ok(isOrderCancelExecution(3));
  assert.ok(isOrderCancelExecution(5));
  assert.ok(!isOrderFillExecution(0), 'NEW is not a fill');
}

{
  assert.strictEqual(contractsFromExecution({ lastShares: '50' }, pending), 50);
  assert.strictEqual(
    contractsFromExecution({ type: 'EXECUTION_TYPE_FILL' }, pending),
    107.68,
    'missing lastShares falls back to quoted size'
  );
  // FILL lastShares looks like a cumulative total after a 50-contract partial.
  assert.strictEqual(
    contractsFromExecution(
      { type: 'EXECUTION_TYPE_FILL', lastShares: '107.68' },
      { ...pending, filledContracts: 50 }
    ),
    57.68
  );
  assert.strictEqual(
    contractsFromExecution(
      { type: 'EXECUTION_TYPE_FILL', lastShares: '107.68' },
      { ...pending, filledContracts: 107.68 }
    ),
    0,
    'replay of a completed cumulative FILL must not add again'
  );
}

{
  const map = new Map();
  map.set('quote-jets', pending);
  const byQuote = findPendingForOrderExecution(map, {
    type: 'EXECUTION_TYPE_FILL',
    order: { id: 'other', quoteId: 'quote-jets' },
  });
  assert.strictEqual(byQuote.pendingId, 'quote-jets');

  const byOrder = findPendingForOrderExecution(map, {
    type: 'EXECUTION_TYPE_FILL',
    order: { id: 'poly-order-1' },
  });
  assert.strictEqual(byOrder.pendingId, 'quote-jets');

  const byRfq = findPendingForOrderExecution(map, {
    type: 'EXECUTION_TYPE_FILL',
    order: { id: 'unknown', rfqId: 'rfq-jets' },
  });
  assert.strictEqual(byRfq.pendingId, 'quote-jets');

  assert.strictEqual(
    findPendingForOrderExecution(map, { order: { id: 'nope', rfqId: 'other' } }),
    null
  );
}

{
  const evt = orderFillEvent(
    {
      type: 'EXECUTION_TYPE_PARTIAL_FILL',
      lastShares: '50',
      order: { id: 'poly-order-1', quoteId: 'quote-jets' },
      executionId: 'exec-partial',
    },
    pending,
    'quote-jets'
  );
  assert.strictEqual(evt.venue, 'polymarket');
  assert.strictEqual(evt.quoteId, 'quote-jets');
  assert.strictEqual(evt.orderId, 'poly-order-1');
  assert.strictEqual(evt.fillId, 'exec-partial');
  assert.strictEqual(evt.contracts, 50);
  assert.strictEqual(evt.isPartial, true);
  assert.strictEqual(evt.pending.parlayId, 'p-jets');
  assert.strictEqual(evt.pending.userId, 'u1');
}

{
  const row = liveRunnerFillRow({
    quoteId: 'quote-jets',
    orderId: 'poly-order-1',
    fillId: 'exec-1',
    parlayId: 'p-jets',
    count: 107.68,
    venue: 'polymarket',
    rfqId: 'rfq-jets',
    label: pending.label,
  });
  assert.strictEqual(row.fill_id, 'exec-1');
  assert.strictEqual(row.order_id, 'poly-order-1');
  assert.strictEqual(row.parlay_id, 'p-jets');
  assert.strictEqual(row.count, 107.68);
  assert.strictEqual(row.is_combo, true);
  assert.strictEqual(row.is_taker, false);
  assert.strictEqual(row.raw.venue, 'polymarket');
  assert.strictEqual(row.raw.source, 'live-runner');
}

{
  const fromDocs = resolveFillLookup({
    orderId: 'poly-order-1',
    fillId: 'exec-1',
    pending: { quoteId: 'quote-jets', parlayId: 'p-jets' },
  });
  assert.strictEqual(fromDocs.quoteId, 'quote-jets');
  assert.strictEqual(fromDocs.orderId, 'poly-order-1');
  assert.strictEqual(resolveFillLookup({}).quoteId, null);
  assert.ok(!submissionAlreadyFilled({ status: 'unfilled', order_id: 'poly-order-1' }));
  assert.ok(submissionAlreadyFilled({ status: 'filled' }));

  const maps = [new Map(), new Map()];
  maps[1].set('quote-jets', { ...pending, creatorOrderId: 'poly-order-1' });
  const byOrder = findPendingFill(maps, null, 'poly-order-1');
  assert.strictEqual(byOrder.pendingId, 'quote-jets');
  assert.strictEqual(findPendingFill(maps, 'quote-jets', null).pendingId, 'quote-jets');
}

function emptyHttp() {
  return {
    async getUserId() { return { rfqUserId: 'rfquser_test' }; },
    async listRfqs() { return { rfqs: [] }; },
    async listQuotes() { return { quotes: [] }; },
    async createQuote() { throw new Error('must not POST'); },
    async confirmQuote() { throw new Error('must not confirm'); },
    async deleteQuote() { return { statusCode: 200 }; },
    async getOrder() { return null; },
    async listPositions() { return { positions: {} }; },
    async listActivities() { return { activities: [] }; },
    close() {},
  };
}

function startFillLoop(extra = {}) {
  const pendingQuotes = extra.pendingQuotes || new Map();
  if (!extra.skipSeed && !pendingQuotes.has('quote-jets')) {
    pendingQuotes.set('quote-jets', { ...pending });
  }
  const loop = startPolymarketRfqLoop({
    env: {
      POLYMARKET_KEY_ID: 'key-id-fixture',
      POLYMARKET_SECRET_KEY: SEED_B64,
      POLYMARKET_RFQ_LIVE: 'false',
    },
    http: emptyHttp(),
    startWs: false,
    enableLocks: true,
    enableUnhedged: false,
    getParlays: () => [],
    startedFor: () => ({ started: false }),
    filledSoFarFor: () => 0,
    getOutstanding: () => 0,
    pendingQuotes,
    reconcileMs: 60 * 60 * 1000,
    fillReconcileMs: 60 * 60 * 1000,
    skipInitialFillReconcile: true,
    ...extra,
  });
  return { loop, pendingQuotes };
}

(async () => {
  const executed = [];
  const sessionFilledByParlay = {};
  const { loop, pendingQuotes } = startFillLoop({
    sessionFilledByParlay,
    onQuoteExecuted: (evt) => { executed.push(evt); },
  });

  loop.handleQuoteExecuted({
    quote: { id: 'quote-jets', rfqId: 'rfq-jets', creatorOrderId: 'poly-order-1' },
  });
  assert.strictEqual(executed.length, 0, 'quoteExecuted is orders-submitted, not a fill');

  const partial = loop.handleOrderExecution({
    type: 'EXECUTION_TYPE_PARTIAL_FILL',
    lastShares: '50',
    order: { id: 'poly-order-1' },
    executionId: 'exec-a',
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(partial);
  assert.strictEqual(partial.venue, 'polymarket');
  assert.strictEqual(partial.contracts, 50);
  assert.strictEqual(partial.isPartial, true);
  assert.strictEqual(executed.length, 1);
  assert.strictEqual(executed[0].fillId, 'exec-a');
  assert.strictEqual(executed[0].quoteId, 'quote-jets');
  assert.strictEqual(executed[0].orderId, 'poly-order-1');
  assert.ok(pendingQuotes.has('quote-jets'), 'partial must keep the reserve until full fill');
  assert.strictEqual(sessionFilledByParlay['p-jets'], undefined, 'persist callback owns session count');

  const full = loop.handleOrderExecution({
    type: 'EXECUTION_TYPE_FILL',
    lastShares: '107.68',
    order: { id: 'poly-order-1', quoteId: 'quote-jets' },
    executionId: 'exec-b',
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(full.contracts, 57.68);
  assert.strictEqual(full.isPartial, false);
  assert.strictEqual(executed.length, 2);
  assert.strictEqual(executed[1].fillId, 'exec-b');
  assert.ok(!pendingQuotes.has('quote-jets'), 'full FILL drops the pending quote');
  loop.stop();

  const sessionOnly = {};
  const { loop: fallbackLoop } = startFillLoop({ sessionFilledByParlay: sessionOnly });
  fallbackLoop.handleOrderExecution({
    type: 'EXECUTION_TYPE_FILL',
    lastShares: '10',
    order: { id: 'poly-order-1', quoteId: 'quote-jets' },
    executionId: 'exec-fallback',
  });
  assert.strictEqual(sessionOnly['p-jets'], 10, 'without onQuoteExecuted, session tally still bumps');
  fallbackLoop.stop();

  const byQuote = [];
  const quoteMap = new Map();
  quoteMap.set('quote-only', { ...pending, creatorOrderId: null });
  const { loop: quoteLoop } = startFillLoop({
    pendingQuotes: quoteMap,
    onQuoteExecuted: (evt) => { byQuote.push(evt); },
  });
  quoteLoop.handleOrderExecution({
    type: 'EXECUTION_TYPE_FILL',
    lastShares: '107.68',
    order: { id: 'poly-order-new', quoteId: 'quote-only' },
    executionId: 'exec-quote',
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(byQuote.length, 1);
  assert.strictEqual(byQuote[0].quoteId, 'quote-only');
  assert.strictEqual(byQuote[0].orderId, 'poly-order-new');
  quoteLoop.stop();

  const recovered = [];
  const { loop: recoverLoop } = startFillLoop({
    skipSeed: true,
    pendingQuotes: new Map(),
    onQuoteExecuted: (evt) => { recovered.push(evt); },
  });
  recoverLoop.handleOrderExecution({
    type: 'EXECUTION_TYPE_FILL',
    lastShares: '107.68',
    order: { id: 'poly-order-restart', quoteId: 'quote-jets' },
    executionId: 'exec-restart',
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(recovered.length, 1, 'ORDER FILL with quoteId persists after pending map is empty');
  assert.strictEqual(recovered[0].quoteId, 'quote-jets');
  assert.strictEqual(recovered[0].orderId, 'poly-order-restart');
  assert.strictEqual(recovered[0].contracts, 107.68);
  recoverLoop.stop();

  const docsFills = [];
  const docsPending = new Map();
  docsPending.set('quote-jets', { ...pending });
  const { loop: docsLoop } = startFillLoop({
    pendingQuotes: docsPending,
    onQuoteExecuted: (evt) => { docsFills.push(evt); },
  });
  docsLoop.onWsEvent(parsePrivateMessage(JSON.stringify({
    request_id: 'order-sub-1',
    subscription_type: 1,
    order_subscription_update: {
      execution: {
        id: 'exec-docs',
        type: 2,
        last_shares: '107.68',
        trade_id: 'trade-docs',
        order: { id: 'poly-order-1', quote_id: 'quote-jets' },
      },
    },
  })));
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(docsFills.length, 1, 'snake_case + numeric FILL must persist');
  assert.strictEqual(docsFills[0].venue, 'polymarket');
  assert.strictEqual(docsFills[0].quoteId, 'quote-jets');
  assert.strictEqual(docsFills[0].orderId, 'poly-order-1');
  assert.strictEqual(docsFills[0].fillId, 'exec-docs');
  assert.strictEqual(docsFills[0].contracts, 107.68);
  assert.ok(!docsPending.has('quote-jets'));
  docsLoop.stop();

  const partialDocs = [];
  const partialMap = new Map();
  partialMap.set('quote-jets', { ...pending });
  const { loop: partialDocsLoop } = startFillLoop({
    pendingQuotes: partialMap,
    onQuoteExecuted: (evt) => { partialDocs.push(evt); },
  });
  partialDocsLoop.onWsEvent(parsePrivateMessage({
    order_subscription_update: {
      executions: [{
        id: 'exec-partial-docs',
        type: 1,
        last_shares: 50,
        order: { id: 'poly-order-1' },
      }],
    },
  }));
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(partialDocs.length, 1);
  assert.strictEqual(partialDocs[0].isPartial, true);
  assert.strictEqual(partialDocs[0].contracts, 50);
  assert.ok(partialMap.has('quote-jets'), 'PARTIAL_FILL keeps remaining reserved');
  partialDocsLoop.stop();

  const camelFills = [];
  const camelMap = new Map();
  camelMap.set('quote-jets', { ...pending });
  const { loop: camelLoop } = startFillLoop({
    pendingQuotes: camelMap,
    onQuoteExecuted: (evt) => { camelFills.push(evt); },
  });
  camelLoop.handleOrderExecution({
    type: 2,
    last_shares: '107.68',
    order: { id: 'poly-order-1', quoteId: 'quote-jets' },
    executionId: 'exec-num',
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(camelFills.length, 1);
  assert.strictEqual(camelFills[0].contracts, 107.68);
  camelLoop.stop();

  const ttlDeletes = [];
  const ttlMap = new Map();
  ttlMap.set('quote-executed', {
    ...pending,
    accepted: true,
    executed: true,
    creatorOrderId: 'poly-order-1',
    postedAt: Date.now() - 25_000,
  });
  ttlMap.set('quote-accepted-only', {
    ...pending,
    rfqId: 'rfq-accepted-only',
    accepted: true,
    creatorOrderId: null,
    executed: false,
    confirmed: false,
    postedAt: Date.now() - 25_000,
  });
  const { loop: ttlLoop } = startFillLoop({
    env: {
      POLYMARKET_KEY_ID: 'key-id-fixture',
      POLYMARKET_SECRET_KEY: SEED_B64,
      POLYMARKET_RFQ_LIVE: 'true',
    },
    pendingQuotes: ttlMap,
    http: {
      ...emptyHttp(),
      async deleteQuote(rfqId, quoteId) {
        ttlDeletes.push({ rfqId, quoteId });
        return { statusCode: 200 };
      },
    },
  });
  await ttlLoop.cancelUnaccepted();
  assert.ok(ttlMap.has('quote-executed'), 'executed resting order must stay reserved past 20s');
  assert.ok(!ttlMap.has('quote-accepted-only'), 'accepted-only last-look still TTLs');
  assert.ok(ttlDeletes.some((d) => d.quoteId === 'quote-accepted-only'));
  assert.ok(!ttlDeletes.some((d) => d.quoteId === 'quote-executed'));
  ttlLoop.stop();

  const sessionCap = {};
  const capPending = new Map();
  capPending.set('quote-jets', { ...pending, maxContracts: 200 });
  const { loop: capLoop } = startFillLoop({
    pendingQuotes: capPending,
    sessionFilledByParlay: sessionCap,
    onQuoteExecuted: (evt) => {
      sessionCap[evt.parlayId] = (sessionCap[evt.parlayId] || 0) + evt.contracts;
    },
  });
  capLoop.handleOrderExecution({
    type: 2,
    last_shares: '107.68',
    order: { id: 'poly-order-1', quote_id: 'quote-jets' },
    executionId: 'exec-cap',
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(sessionCap['p-jets'], 107.68);
  const leftover = decideAtFill({
    parlayStake: 50,
    parlayAmerican: 858,
    fillAmerican: 609,
    rfqContracts: 70,
    hedgeMode: '1x',
    maxContracts: 200,
    filledSoFar: sessionCap['p-jets'],
    outstanding: 0,
    allowPartial: true,
  });
  assert.ok(leftover.ok);
  assert.ok(leftover.remaining < 200);
  const over = decideAtFill({
    parlayStake: 50,
    parlayAmerican: 858,
    fillAmerican: 609,
    rfqContracts: 70,
    hedgeMode: '1x',
    maxContracts: 107.68,
    filledSoFar: sessionCap['p-jets'],
    outstanding: 0,
    allowPartial: true,
  });
  assert.strictEqual(over.ok, false, 'filled toward max_contracts must stop further Poly quotes');
  capLoop.stop();

  const stamped = [];
  const stampMap = new Map();
  stampMap.set('quote-jets', { ...pending });
  const { loop: stampLoop } = startFillLoop({
    pendingQuotes: stampMap,
    persistQuoteOrder: (quoteId, orderId) => { stamped.push({ quoteId, orderId }); },
  });
  stampLoop.handleQuoteExecuted({
    quote: { id: 'quote-jets', rfqId: 'rfq-jets', creatorOrderId: 'poly-order-1' },
  });
  assert.deepStrictEqual(stamped, [{ quoteId: 'quote-jets', orderId: 'poly-order-1' }]);
  assert.strictEqual(stampMap.get('quote-jets').executed, true);
  assert.strictEqual(stampMap.get('quote-jets').creatorOrderId, 'poly-order-1');
  stampLoop.stop();

  const evicted = [];
  const evictMap = new Map();
  evictMap.set('quote-jets', {
    ...pending,
    postedAt: Date.now() - 25_000,
    accepted: false,
    executed: false,
    confirmed: false,
    creatorOrderId: null,
  });
  const { loop: evictLoop } = startFillLoop({
    pendingQuotes: evictMap,
    onQuoteExecuted: (evt) => { evicted.push(evt); },
  });
  await evictLoop.cancelUnaccepted();
  assert.ok(!evictMap.has('quote-jets'), 'unaccepted quote is evicted from pending');
  evictLoop.handleOrderExecution({
    type: 'EXECUTION_TYPE_FILL',
    lastShares: '107.68',
    order: { id: 'poly-order-late', quoteId: 'quote-jets' },
    executionId: 'exec-after-ttl',
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(evicted.length, 1, 'FILL after pending eviction still persists via quoteId');
  assert.strictEqual(evicted[0].quoteId, 'quote-jets');
  assert.strictEqual(evicted[0].contracts, 107.68);
  evictLoop.stop();

  const seenKeys = new Set();
  const idempotent = [];
  const { loop: dupeLoop } = startFillLoop({
    onQuoteExecuted: (evt) => {
      const key = evt.fillId || evt.orderId || evt.quoteId;
      if (!claimFillKey(seenKeys, key)) return;
      idempotent.push(evt);
    },
  });
  const dupeEx = {
    type: 'EXECUTION_TYPE_FILL',
    lastShares: '107.68',
    order: { id: 'poly-order-1', quoteId: 'quote-jets' },
    executionId: 'exec-dupe',
  };
  dupeLoop.handleOrderExecution(dupeEx);
  dupeLoop.handleOrderExecution(dupeEx);
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(idempotent.length, 1, 'duplicate execution is idempotent at persist');
  dupeLoop.stop();

  const reconFills = [];
  const reconHttp = {
    ...emptyHttp(),
    async listQuotes(query) {
      if (query && query.status === 'QUOTE_STATUS_EXECUTED') {
        return {
          quotes: [{
            id: 'quote-missed',
            rfqId: 'rfq-missed',
            status: 'QUOTE_STATUS_EXECUTED',
            creatorOrderId: 'poly-order-missed',
            buyQtyDecimal: '48.55',
          }],
        };
      }
      return { quotes: [] };
    },
    async getOrder(id) {
      return { id, cumQuantity: 48.55, state: 'ORDER_STATE_FILLED' };
    },
  };
  const { loop: reconLoop } = startFillLoop({
    skipSeed: true,
    pendingQuotes: new Map(),
    http: reconHttp,
    loadUnfilledPolyQuotes: async () => [{
      quote_id: 'quote-missed',
      rfq_id: 'rfq-missed',
      parlay_id: pending.parlayId,
      label: pending.label,
      contracts: 48.55,
      user_id: pending.userId,
      status: 'unfilled',
    }],
    onQuoteExecuted: (evt) => { reconFills.push(evt); },
  });
  const recon = await reconLoop.reconcileLockFills();
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(recon.length, 1, 'reconcile recovers a fill the live path missed');
  assert.strictEqual(reconFills.length, 1);
  assert.strictEqual(reconFills[0].quoteId, 'quote-missed');
  assert.strictEqual(reconFills[0].contracts, 48.55);
  assert.strictEqual(reconFills[0].source, 'poly-reconcile');
  const reconAgain = await reconLoop.reconcileLockFills();
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(reconAgain.length, 0, 'second reconcile of the same full fill is a no-op');
  assert.strictEqual(reconFills.length, 1);
  reconLoop.stop();

  const LOCK = {
    id: 'aee3b29d-2a4b-4dd6-8dd5-37358b0aa294',
    label: 'Cleveland Guardians ML + New York Yankees ML + San Francisco Giants ML',
    user_id: 'u1',
    max_contracts: 479,
  };
  function comboLot(id, qty, aggressor) {
    return {
      type: 'ACTIVITY_TYPE_TRADE',
      trade: {
        id,
        qtyDecimal: String(qty),
        isAggressor: !!aggressor,
        state: 'TRADE_STATE_CLEARED',
        marketMetadata: {
          title: 'Combo 3 Markets',
          markets: [
            { title: 'Chicago White Sox vs. Cleveland Guardians Final' },
            { title: 'San Francisco Giants vs. St. Louis Cardinals Final' },
            { title: 'New York Yankees vs. Minnesota Twins Final' },
          ],
        },
      },
    };
  }
  const multiFills = [];
  const persistKeys = new Set();
  const multiHttp = {
    ...emptyHttp(),
    async listQuotes(query) {
      if (query && query.status === 'QUOTE_STATUS_EXECUTED') {
        return {
          quotes: [{
            id: 'quote-one',
            rfqId: 'rfq-one',
            status: 'QUOTE_STATUS_EXECUTED',
            creatorOrderId: 'poly-order-one',
            buyQtyDecimal: '70',
          }],
        };
      }
      return { quotes: [] };
    },
    async getOrder(id) {
      return { id, cumQuantity: 70, state: 'ORDER_STATE_FILLED' };
    },
    async listActivities() {
      return {
        activities: [
          comboLot('won-settlement', 2394.34, false),
          comboLot('sold-288', 288.36, true),
          comboLot('sold-48', 48.06, true),
        ],
      };
    },
    async listPositions() {
      return {
        positions: [{
          qtyBoughtDecimal: '9999',
          marketMetadata: { title: LOCK.label, slug: 'cle-nyy-sf-combo' },
        }],
      };
    },
  };
  const { loop: multiLoop } = startFillLoop({
    skipSeed: true,
    pendingQuotes: new Map(),
    http: multiHttp,
    seenFillIds: persistKeys,
    loadUnfilledPolyQuotes: async () => [{
      quote_id: 'quote-one',
      rfq_id: 'rfq-one',
      parlay_id: LOCK.id,
      label: LOCK.label,
      contracts: 70,
      user_id: LOCK.user_id,
      status: 'unfilled',
    }],
    loadRecentLocks: async () => [LOCK],
    onQuoteExecuted: (evt) => {
      const key = evt.fillId || evt.orderId || evt.quoteId;
      if (!claimFillKey(persistKeys, key)) return;
      multiFills.push(evt);
    },
  });
  const multi = await multiLoop.reconcileLockFills();
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(multi.length, 4, 'quote fill plus all three lock-matching cashout/settlement lots');
  assert.strictEqual(multiFills.length, 4, 'persist must not treat activity ids as already claimed');
  assert.ok(multiFills.some((e) => e.quoteId === 'quote-one' && e.contracts === 70));
  assert.deepStrictEqual(
    multiFills.filter((e) => String(e.fillId || '').startsWith('poly-act:')).map((e) => e.contracts).sort((a, b) => b - a),
    [2394.34, 288.36, 48.06]
  );
  const multiAgain = await multiLoop.reconcileLockFills();
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(multiAgain.length, 0, 'repeat reconcile of the same lots is silent');
  assert.strictEqual(multiFills.length, 4);
  multiLoop.stop();

  const caocFills = [];
  const caocKeys = new Set();
  const caocHttp = {
    ...emptyHttp(),
    async listQuotes(query) {
      if (query && query.status === 'QUOTE_STATUS_EXECUTED') {
        return {
          quotes: [{
            id: 'RV__Df859d3kQKJex6AkWCuzw1ZudaOra7T6Fp4cCf8',
            symbol: 'caoc-1d16e8345207a66c',
            status: 'QUOTE_STATUS_EXECUTED',
            creatorOrderId: 'CH6775WYRVB8',
            buyQtyDecimal: '2023.4',
          }],
        };
      }
      return { quotes: [] };
    },
    async getOrder() { return null; },
    async listActivities() {
      return {
        activities: [
          {
            type: 'ACTIVITY_TYPE_TRADE',
            trade: {
              id: 'CHFYRFW40VAY',
              marketSlug: 'caoc-1d16e8345207a66c',
              cost: { value: '285.25', currency: 'USD' },
              isAggressor: true,
              state: 'TRADE_STATE_CLEARED',
              marketMetadata: { title: '', slug: 'caoc-1d16e8345207a66c' },
            },
          },
        ],
      };
    },
  };
  const { loop: caocLoop } = startFillLoop({
    skipSeed: true,
    pendingQuotes: new Map(),
    http: caocHttp,
    seenFillIds: caocKeys,
    loadUnfilledPolyQuotes: async () => [],
    loadRecentLocks: async () => [LOCK],
    loadPolySlugRecords: async () => [{
      quote_id: 'RV__Df859d3kQKJex6AkWCuzw1ZudaOra7T6Fp4cCf8',
      parlay_id: LOCK.id,
      market_ticker: 'caoc-1d16e8345207a66c',
    }],
    onQuoteExecuted: (evt) => {
      const key = evt.fillId || evt.orderId || evt.quoteId;
      if (!claimFillKey(caocKeys, key)) return;
      caocFills.push(evt);
    },
  });
  const caoc = await caocLoop.reconcileLockFills();
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(caoc.some((e) => e.fillId === 'poly-act:CHFYRFW40VAY' && e.contracts === 285.25));
  assert.strictEqual(caocFills.filter((e) => e.fillId === 'poly-act:CHFYRFW40VAY').length, 1);
  const caocAgain = await caocLoop.reconcileLockFills();
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(caocAgain.filter((e) => e.fillId === 'poly-act:CHFYRFW40VAY').length, 0);
  caocLoop.stop();

  const polySrc = fs.readFileSync(path.join(__dirname, 'polymarket-rfq.js'), 'utf8');
  assert.ok(
    /function emitOrderFill/.test(polySrc) && /ctx\.onQuoteExecuted/.test(polySrc),
    'ORDER FILL must call onQuoteExecuted off the quote hot path'
  );
  assert.ok(
    /quoteExecuted orders submitted \(not a fill\)/.test(polySrc),
    'quoteExecuted must stay a non-fill'
  );
  const liveSrc = fs.readFileSync(path.join(__dirname, 'live-runner.js'), 'utf8');
  assert.ok(
    /onQuoteExecuted:\s*\(evt\) =>\s*onQuoteExecuted\(\{/.test(liveSrc),
    'live-runner Combo Locks Poly loop must persist fills'
  );
  assert.ok(
    /resolveFillLookup/.test(liveSrc) && /findPendingFill/.test(liveSrc),
    'Poly fills with orderId but no quoteId must still attribute'
  );
  assert.ok(
    /persistQuoteOrder/.test(liveSrc) && /stamp order_id failed/.test(liveSrc),
    'quoteExecuted must stamp creatorOrderId onto combo_submissions for restart recovery'
  );
  assert.ok(
    /loadUnfilledPolyQuotes/.test(liveSrc) && /getFilledForQuote/.test(liveSrc)
      && /loadPolySlugRecords/.test(liveSrc),
    'live-runner must feed Poly fill reconcile from combo_submissions / combo_fills / caoc slugs'
  );
  assert.ok(
    /function reconcileLockFills/.test(polySrc) && /RECONCILE/.test(polySrc)
      && /reconcileLockActivityEvents/.test(polySrc)
      && /loadRecentLocks/.test(polySrc)
      && /loadPolySlugRecords/.test(polySrc)
      && /slugRecords/.test(polySrc)
      && !/if\s*\(\s*!events\.length/.test(polySrc),
    'Poly loop must always scan lock-matching activities, not only when quote reconcile is empty'
  );
  assert.ok(
    /submissionAlreadyFilled/.test(liveSrc),
    'order_id stamped at quoteExecuted must not count as already filled'
  );
  const backfillSrc = fs.readFileSync(path.join(__dirname, 'scripts/backfill-poly-combo-fills.js'), 'utf8');
  assert.ok(
    /BACKFILL_PARLAY_ID/.test(backfillSrc) && /parlay=ALL/.test(backfillSrc) && /slugRecords/.test(backfillSrc),
    'backfill must cover all locks unless BACKFILL_PARLAY_ID is set'
  );
  assert.ok(/BACKFILL_DRY_RUN/.test(backfillSrc) && /BACKFILL_LOOKBACK_HOURS/.test(backfillSrc));
  const clientSrc = fs.readFileSync(path.join(__dirname, 'polymarket-client.js'), 'utf8');
  assert.ok(
    /order_subscription_update/.test(clientSrc) && /subscription_type:\s*1/.test(clientSrc),
    'private WS must accept documented snake_case order updates and subscribe with numeric ORDER type'
  );
  const unhedgedSrc = fs.readFileSync(path.join(__dirname, 'unhedged-runner.js'), 'utf8');
  assert.ok(
    !/onQuoteExecuted:/.test(unhedgedSrc),
    'parked unhedged-rfq must not write combo_fills / combo_submissions'
  );

  console.log('polymarket-fill.test.js ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
