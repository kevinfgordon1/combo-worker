'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { liveRunnerFillRow } = require('./fills-attr');
const {
  orderIdFromExecution,
  quoteIdFromExecution,
  rfqIdFromExecution,
  executionFillId,
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

function emptyHttp() {
  return {
    async getUserId() { return { rfqUserId: 'rfquser_test' }; },
    async listRfqs() { return { rfqs: [] }; },
    async listQuotes() { return { quotes: [] }; },
    async createQuote() { throw new Error('must not POST'); },
    async confirmQuote() { throw new Error('must not confirm'); },
    async deleteQuote() { return { statusCode: 200 }; },
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
