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
  sizesEqual,
  orderQtyMatchesQuoted,
  activityAlreadyReconciled,
  bookedReconcileKeys,
  quotedSizesByLock,
  lockLabelMatchesMarket,
  uniqueLockForMarket,
  normalizeMarketSlug,
  isComboActivitySlug,
  slugMapFromRecords,
  slugMapFromQuotes,
  buildActivitySlugMap,
  tradeFromActivity,
  matchActivitiesToLocks,
  matchPositionsToLocks,
  listAllActivities,
  reconcileLockActivityEvents,
  lockTeamNicknames,
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
  assert.ok(sizesEqual(43, 43));
  assert.ok(sizesEqual(629.82, 629.82000001));
  assert.ok(!sizesEqual(43, 629.82));
  assert.ok(orderQtyMatchesQuoted(43, 43, 'ORDER_STATE_FILLED'));
  assert.ok(orderQtyMatchesQuoted(50, 70, 'ORDER_STATE_PARTIALLY_FILLED'));
  assert.ok(!orderQtyMatchesQuoted(629.82, 43, 'ORDER_STATE_FILLED'));
  assert.ok(!orderQtyMatchesQuoted(629.82, 43, 'ORDER_STATE_PARTIALLY_FILLED'));
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

  assert.strictEqual(
    fillEventFromReconcile({
      quote: { id: 'q-43', creatorOrderId: 'o-junk', buyQtyDecimal: '43' },
      order: { id: 'o-junk', cumQuantity: 629.82, state: 'ORDER_STATE_FILLED' },
      pending: { parlayId: LOCK.id, contracts: 43, label: LOCK.label },
    }),
    null,
    'poly-reconcile must not attach a 629.82 trade to a 43-contract quote'
  );
  assert.strictEqual(
    fillEventFromReconcile({
      quote: { id: 'q-43', creatorOrderId: 'o-ex', buyQtyDecimal: '629.82' },
      order: { id: 'o-ex', cumQuantity: 629.82, state: 'ORDER_STATE_FILLED' },
      pending: { parlayId: LOCK.id, contracts: 43, label: LOCK.label },
    }),
    null,
    'exchange buyQty ≠ posted contracts is not this lock quote'
  );
}

{
  assert.deepStrictEqual(lockTeamNicknames(LOCK.label), ['GUARDIANS', 'YANKEES', 'GIANTS']);
  assert.ok(lockLabelMatchesMarket(
    LOCK.label,
    'Chicago White Sox vs Cleveland Guardians / San Francisco Giants vs St Louis / New York Yankees',
    'combo-cle-nyy-sf'
  ));
  assert.ok(lockLabelMatchesMarket(
    LOCK.label,
    'Combo 3 Markets',
    'white-sox-guardians giants-cardinals yankees-twins'
  ), 'screenshot-style per-game titles still identify the lock');
  assert.ok(!lockLabelMatchesMarket(LOCK.label, 'Yankees only', 'nyy'));
  assert.strictEqual(uniqueLockForMarket([LOCK, { id: 'other', label: 'Bills ML + Chiefs ML' }], LOCK.label, ''), LOCK);
  assert.strictEqual(uniqueLockForMarket([LOCK, { ...LOCK, id: 'dup' }], LOCK.label, ''), null);
  assert.strictEqual(normalizeMarketSlug('  '), null);
  assert.strictEqual(normalizeMarketSlug('caoc-1d16e8345207a66c'), 'caoc-1d16e8345207a66c');
  assert.ok(isComboActivitySlug('caoc-1d16e8345207a66c'));
  assert.ok(!isComboActivitySlug('aec-mlb-cle-cws-2026-09-16'));
}

const CAOC_SLUG = 'caoc-1d16e8345207a66c';
const CLE_CASHOUTS = [
  { id: 'CHFYRFW40VAY', cost: '285.25' },
  { id: 'CHFXQ9XHEVAY', cost: '47.58' },
  { id: 'CHG1HTPY6VAY', cost: '4.75' },
];

function emptyTitleCaocTrade(id, cost, { aggressor = true } = {}) {
  return {
    type: 'ACTIVITY_TYPE_TRADE',
    trade: {
      id,
      marketSlug: CAOC_SLUG,
      cost: { value: String(cost), currency: 'USD' },
      isAggressor: aggressor,
      state: 'TRADE_STATE_CLEARED',
      marketMetadata: { title: '', slug: CAOC_SLUG },
    },
  };
}

{
  const emptyHay = matchActivitiesToLocks(
    [emptyTitleCaocTrade('CHFYRFW40VAY', '285.25')],
    [LOCK]
  );
  assert.strictEqual(emptyHay.length, 0, 'opaque caoc slug + empty title cannot use team tokens');

  const viaFillTicker = slugMapFromRecords([
    { ticker: CAOC_SLUG, parlay_id: LOCK.id, raw: { venue: 'polymarket' } },
  ]);
  assert.strictEqual(viaFillTicker.get(CAOC_SLUG), LOCK.id);

  const viaQuote = slugMapFromQuotes(
    [{ id: 'RV__Df859d3kQKJex6AkWCuzw1ZudaOra7T6Fp4cCf8', symbol: CAOC_SLUG }],
    [{ quote_id: 'RV__Df859d3kQKJex6AkWCuzw1ZudaOra7T6Fp4cCf8', parlay_id: LOCK.id }]
  );
  assert.strictEqual(viaQuote.get(CAOC_SLUG), LOCK.id);

  const mapped = matchActivitiesToLocks(
    [emptyTitleCaocTrade('CHFYRFW40VAY', '285.25')],
    [LOCK],
    { slugMap: viaFillTicker }
  );
  assert.strictEqual(mapped.length, 1, 'empty-title caoc activity matches via slug map');
  assert.strictEqual(mapped[0].parlayId, LOCK.id);
  assert.strictEqual(mapped[0].fillId, 'poly-act:CHFYRFW40VAY');
  assert.strictEqual(mapped[0].contracts, 285.25, 'CLE $285.25 cashout sizes from activity cost');
  assert.strictEqual(mapped[0].marketTicker, CAOC_SLUG);

  const lots = CLE_CASHOUTS.map((row) => emptyTitleCaocTrade(row.id, row.cost));
  const three = matchActivitiesToLocks(lots, [LOCK], { slugMap: viaQuote });
  assert.strictEqual(three.length, 3, 'multiple cashouts on the same caoc lock all book');
  assert.deepStrictEqual(three.map((e) => e.fillId).sort(), [
    'poly-act:CHFYRFW40VAY',
    'poly-act:CHFXQ9XHEVAY',
    'poly-act:CHG1HTPY6VAY',
  ].sort());
  assert.deepStrictEqual(three.map((e) => e.contracts).sort((a, b) => b - a), [285.25, 47.58, 4.75]);

  const seen = new Set(['poly-act:CHFYRFW40VAY']);
  const rest = matchActivitiesToLocks(lots, [LOCK], { slugMap: viaFillTicker, seenFillIds: seen });
  assert.strictEqual(rest.length, 2, 'already-booked CLE $285 row is skipped');
  assert.ok(rest.every((e) => e.fillId !== 'poly-act:CHFYRFW40VAY'));
  const replay = matchActivitiesToLocks(lots, [LOCK], { slugMap: viaFillTicker, seenFillIds: seen });
  assert.strictEqual(replay.length, 2, 'idempotent replay does not claim remaining keys early');
  seen.add('poly-act:CHFXQ9XHEVAY');
  seen.add('poly-act:CHG1HTPY6VAY');
  assert.strictEqual(
    matchActivitiesToLocks(lots, [LOCK], { slugMap: viaFillTicker, seenFillIds: seen }).length,
    0,
    'full replay of CLE cashouts is a no-op'
  );

  const ambiguous = buildActivitySlugMap({
    slugRecords: [
      { market_ticker: CAOC_SLUG, parlay_id: LOCK.id },
      { market_ticker: CAOC_SLUG, parlay_id: 'other-lock' },
    ],
  });
  assert.strictEqual(ambiguous.get(CAOC_SLUG), false);
  assert.strictEqual(
    matchActivitiesToLocks(lots, [LOCK, { id: 'other-lock', label: LOCK.label }], { slugMap: ambiguous }).length,
    0,
    'do not guess when two locks share a caoc slug'
  );

  const ravensLock = {
    id: '86917686-1ed3-4d3a-9d30-499c9f433b94',
    label: 'Baltimore Ravens ML + Tampa Bay Buccaneers ML + New York Jets ML',
    max_contracts: 505,
  };
  const ravensSlug = 'caoc-23f1fca1ea3441ed';
  const ravensMap = slugMapFromRecords([
    { market_ticker: ravensSlug, parlay_id: ravensLock.id, contracts: 43 },
  ]);
  const junkTrade = {
    type: 'ACTIVITY_TYPE_TRADE',
    trade: {
      id: 'poly-act-invent',
      marketSlug: ravensSlug,
      qtyDecimal: '629.82',
      isAggressor: false,
      state: 'TRADE_STATE_CLEARED',
      marketMetadata: { title: '', slug: ravensSlug },
    },
  };
  const reconBooked = [{
    parlayId: ravensLock.id,
    contracts: 629.82,
    source: 'poly-reconcile',
    fillId: 'poly-recon:q-43:629.82',
    marketTicker: ravensSlug,
  }];
  assert.strictEqual(
    matchActivitiesToLocks([junkTrade], [ravensLock], {
      slugMap: ravensMap,
      bookedFills: reconBooked,
    }).length,
    0,
    'poly-activity must not double-book a trade already booked via reconcile'
  );
  assert.ok(activityAlreadyReconciled(
    { qty: 629.82, marketSlug: ravensSlug },
    ravensLock,
    bookedReconcileKeys({ bookedFills: reconBooked })
  ));
  assert.strictEqual(
    matchActivitiesToLocks([junkTrade], [ravensLock], {
      slugMap: ravensMap,
      quotedByLock: quotedSizesByLock([{ parlay_id: ravensLock.id, contracts: 43 }]),
    }).length,
    0,
    'slug-only maker trade whose size ≠ posted quote must not invent a fill'
  );
  const matchedQuote = {
    type: 'ACTIVITY_TYPE_TRADE',
    trade: {
      id: 'poly-act-43',
      marketSlug: ravensSlug,
      qtyDecimal: '43',
      isAggressor: false,
      state: 'TRADE_STATE_CLEARED',
      marketMetadata: { title: '', slug: ravensSlug },
    },
  };
  const ok43 = matchActivitiesToLocks([matchedQuote], [ravensLock], {
    slugMap: ravensMap,
    quotedByLock: quotedSizesByLock([{ parlay_id: ravensLock.id, contracts: 43 }]),
  });
  assert.strictEqual(ok43.length, 1, 'slug-mapped maker fill may book when size equals the quote');
  assert.strictEqual(ok43[0].contracts, 43);
}

function comboTrade(id, qty, { aggressor = false, payout } = {}) {
  return {
    type: 'ACTIVITY_TYPE_TRADE',
    trade: {
      id,
      marketSlug: 'chicago-white-sox-cleveland-guardians-san-francisco-giants-st-louis-new-york-yankees',
      qtyDecimal: qty,
      payout: payout ? { value: String(payout), currency: 'USD' } : undefined,
      price: { value: '0.859', currency: 'USD' },
      isAggressor: aggressor,
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

{
  const trade = tradeFromActivity(comboTrade('t1', '2394.34'));
  assert.strictEqual(trade.qty, 2394.34);
  const evts = matchActivitiesToLocks([comboTrade('t1', '2394.34')], [LOCK]);
  assert.strictEqual(evts.length, 1);
  assert.strictEqual(evts[0].parlayId, LOCK.id);
  assert.strictEqual(evts[0].contracts, 2394.34);
  assert.strictEqual(evts[0].fillId, 'poly-act:t1');
}

{
  const lots = [
    comboTrade('won-settlement', '2394.34', { aggressor: false, payout: '2394.34' }),
    comboTrade('sold-288', '288.36', { aggressor: true, payout: '288.36' }),
    comboTrade('sold-48', '48.06', { aggressor: true, payout: '48.06' }),
  ];
  const evts = matchActivitiesToLocks(lots, [LOCK]);
  assert.strictEqual(evts.length, 3, 'all three YOU WON / CASHED OUT lots must book');
  assert.deepStrictEqual(evts.map((e) => e.contracts).sort((a, b) => b - a), [2394.34, 288.36, 48.06]);
  assert.deepStrictEqual(evts.map((e) => e.fillId).sort(), [
    'poly-act:sold-288',
    'poly-act:sold-48',
    'poly-act:won-settlement',
  ]);
  assert.ok(evts.some((e) => e.source === 'poly-activity-sold'), 'sold/cashed lots use the sold source');
  const booked = new Set(['poly-act:won-settlement']);
  const rest = matchActivitiesToLocks(lots, [LOCK], { seenFillIds: booked });
  assert.strictEqual(rest.length, 2, 'already-persisted lot is skipped; remaining cashouts still book');
  assert.strictEqual(booked.size, 1, 'match must not claim persist keys before live-runner books');
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

  let pages = 0;
  const paged = await listAllActivities({
    async listActivities({ cursor }) {
      pages += 1;
      if (!cursor) {
        return {
          activities: [comboTrade('won-settlement', '2394.34')],
          nextCursor: 'p2',
        };
      }
      if (cursor === 'p2') {
        return {
          activities: [
            comboTrade('sold-288', '288.36', { aggressor: true }),
            comboTrade('sold-48', '48.06', { aggressor: true }),
          ],
          eof: true,
        };
      }
      throw new Error('should stop paging');
    },
  });
  assert.strictEqual(pages, 2);
  assert.strictEqual(paged.length, 3);

  const activityHttp = {
    async listActivities() {
      return {
        activities: [
          comboTrade('won-settlement', '2394.34'),
          comboTrade('sold-288', '288.36', { aggressor: true }),
          comboTrade('sold-48', '48.06', { aggressor: true }),
        ],
      };
    },
    async listPositions() {
      return {
        positions: [{
          marketSlug: 'cle-nyy-sf-combo',
          qtyBoughtDecimal: '9999',
          marketMetadata: { title: LOCK.label, slug: 'cle-nyy-sf-combo' },
        }],
      };
    },
  };
  const three = await reconcileLockActivityEvents(activityHttp, { locks: [LOCK] });
  assert.strictEqual(three.length, 3, 'positions must not add a fourth lot once activities covered the lock');
  assert.deepStrictEqual(three.map((e) => e.contracts).sort((a, b) => b - a), [2394.34, 288.36, 48.06]);

  const payoutOnly = tradeFromActivity({
    type: 'ACTIVITY_TYPE_TRADE',
    trade: {
      id: 'sold-payout',
      isAggressor: true,
      payout: { value: '48.06', currency: 'USD' },
      marketMetadata: {
        title: LOCK.label,
        slug: 'cle-nyy-sf-combo',
      },
    },
  });
  assert.strictEqual(payoutOnly.qty, 48.06, 'cashed-out cards without qtyDecimal still size from payout');

  const uncoveredHttp = {
    async listActivities() { return { activities: [] }; },
    async listPositions() {
      return {
        positions: [{
          marketSlug: 'cle-nyy-sf-combo',
          qtyBoughtDecimal: '2394.34',
          marketMetadata: { title: LOCK.label, slug: 'cle-nyy-sf-combo' },
        }],
      };
    },
  };
  const posOnly = await reconcileLockActivityEvents(uncoveredHttp, { locks: [LOCK] });
  assert.strictEqual(posOnly.length, 1, 'positions are a fallback only when the lock has no activity hits');
  assert.strictEqual(posOnly[0].source, 'poly-position');

  const caocHttp = {
    async listQuotes(query) {
      if (query && query.userFilter === 'USER_FILTER_SELF' && query.status === 'QUOTE_STATUS_EXECUTED') {
        return {
          quotes: [{
            id: 'RV__Df859d3kQKJex6AkWCuzw1ZudaOra7T6Fp4cCf8',
            symbol: CAOC_SLUG,
            status: 'QUOTE_STATUS_EXECUTED',
          }],
        };
      }
      return { quotes: [] };
    },
    async listActivities() {
      return {
        activities: CLE_CASHOUTS.map((row) => emptyTitleCaocTrade(row.id, row.cost)),
      };
    },
    async listPositions() { return { positions: [] }; },
  };
  const viaStoredQuotes = await reconcileLockActivityEvents(caocHttp, {
    locks: [LOCK],
    submissions: [{
      quote_id: 'RV__Df859d3kQKJex6AkWCuzw1ZudaOra7T6Fp4cCf8',
      parlay_id: LOCK.id,
    }],
  });
  assert.strictEqual(viaStoredQuotes.length, 3, 'reconcile joins executed quote symbol to activity caoc slug');
  assert.ok(viaStoredQuotes.some((e) => e.fillId === 'poly-act:CHFYRFW40VAY' && e.contracts === 285.25));

  console.log('polymarket-fill-reconcile.test.js ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
