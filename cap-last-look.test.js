'use strict';
// Last-look at confirm, unresolved holds, live-fill twin window, fast watchdog.
// Replays the 2026-10-02 Padres/Yankees/Dodgers over-fill (cap 1251 -> 1309.48).
const assert = require('assert');
const {
  createCapBook,
  createHoldResolver,
  confirmAgainstCap,
  releaseConfirmedFill,
  isFinalFill,
  IN_FLIGHT_TTL_MS,
  IN_FLIGHT_HARD_TTL_MS,
} = require('./cap-confirm');
const { findPolyEconomicTwin, quoteFillAlreadyBooked } = require('./polymarket-fill-reconcile');
const { startPolymarketRfqLoop } = require('./polymarket-rfq');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = 'lock-padres';
const MAX = 1251;

async function holdsSurviveTheSoftTtl() {
  let t = 1_000_000;
  const forced = [];
  const book = createCapBook({ enabled: true, now: () => t, onForced: (i) => forced.push(i) });
  book.hold(P, 'q1', 91.61, undefined, { venue: 'polymarket' });
  t += IN_FLIGHT_TTL_MS + 1;
  assert.strictEqual(book.sum(P), 91.61, 'a 90s-old hold still counts (it used to vanish here)');
  assert.strictEqual(book.stale({ parlayId: P }).length, 1, 'but it is flagged stale for the resolver');
  t += 20 * 60_000;
  assert.strictEqual(book.sum(P), 91.61, 'still held at ~21 min');
  t += IN_FLIGHT_HARD_TTL_MS;
  assert.strictEqual(book.sum(P), 0, 'hard ttl is the only silent-exit, and it is loud');
  assert.strictEqual(forced.length, 1);
  assert.strictEqual(forced[0].quoteId, 'q1');
}

async function finalFillReleasesTheWholeHold() {
  const book = createCapBook({ enabled: true });
  // Kalshi 2:30 PM: quoted 247, accepted/filled 232.77 (94%). It used to "reduce" and leave 14.23 pinned.
  book.hold(P, 'k1', 247);
  releaseConfirmedFill(book, { parlayId: P, quoteId: 'k1', partial: true, contracts: 232.77 });
  assert.strictEqual(book.sum(P), 0, '94% fill is the whole accept');
  // Poly: hold 101.01 for a 91.61 fill (90.7%).
  book.hold(P, 'p1', 101.01);
  releaseConfirmedFill(book, { parlayId: P, quoteId: 'p1', partial: true, contracts: 91.61 });
  assert.strictEqual(book.sum(P), 0);
  // A genuinely partial fill still only reduces; the resolver settles the rest.
  book.hold(P, 'k2', 100);
  releaseConfirmedFill(book, { parlayId: P, quoteId: 'k2', partial: true, contracts: 40 });
  assert.strictEqual(book.sum(P), 60);
  assert.strictEqual(isFinalFill(100, 85), true);
  assert.strictEqual(isFinalFill(100, 84), false);
}

async function lastLookStopsTheIncidentConfirm() {
  // Worker believed filled=985.10 (an unbooked 91.61 Poly fill hid capacity);
  // the books said 1076.71. The 247 quote fit the belief (985.10+247=1232.10)
  // but not the truth (1076.71+247=1323.71 > 1251).
  const book = createCapBook({ enabled: true });
  let confirmed = 0;
  const base = {
    parlayId: P, quoteId: 'k-247', maxContracts: MAX, size: 247,
    getFilled: () => 985.10, getOpenHeld: () => 0,
    confirm: async () => { confirmed += 1; },
  };
  const blind = await confirmAgainstCap(createCapBook({ enabled: true }), { ...base });
  assert.strictEqual(blind.ok, true, 'without last look the old guard confirms (the bug)');

  const raised = [];
  const seen = await confirmAgainstCap(book, {
    ...base,
    quoteId: 'k-247b',
    lastLook: async () => 1076.71,
    onLastLookRaise: (i) => raised.push(i),
  });
  assert.strictEqual(seen.ok, false, 'last look blocks it');
  assert.strictEqual(seen.reason, 'cap_exceeded');
  assert.strictEqual(seen.filled, 1076.71);
  assert.deepStrictEqual(raised, [{ memory: 985.10, fresh: 1076.71 }]);
  assert.strictEqual(confirmed, 1, 'only the blind confirm ran');
  assert.strictEqual(book.sum(P), 0, 'nothing held for the rejected accept');

  // A failing last look never loosens or breaks the gate.
  const ok = await confirmAgainstCap(createCapBook({ enabled: true }), {
    ...base, quoteId: 'k-ok', size: 100, lastLook: async () => { throw new Error('db down'); },
  });
  assert.strictEqual(ok.ok, true);
  // A lower fresh count never lowers memory.
  const keep = await confirmAgainstCap(createCapBook({ enabled: true }), {
    ...base, quoteId: 'k-keep', getFilled: () => 1100, lastLook: async () => 0,
  });
  assert.strictEqual(keep.ok, false);
}

async function resolverVerifiesStaleHolds() {
  let t = 5_000_000;
  const book = createCapBook({ enabled: true, now: () => t });
  const states = { a: 'booked', b: 'cancelled', c: 'open', d: 'unknown', e: 'filled_unbooked' };
  for (const id of Object.keys(states)) book.hold(P, id, 50, undefined, { venue: 'polymarket' });
  const rebooked = [];
  const logs = [];
  const resolver = createHoldResolver({
    book,
    now: () => t,
    check: async (row) => ({ state: states[row.quoteId], contracts: 91.61 }),
    onFilledUnbooked: async (row) => {
      rebooked.push(row.quoteId);
      states.e = 'booked'; // booking the fill makes the next check see it
    },
    log: (m) => logs.push(m),
    maxPerTick: 10,
  });
  t += 30_000;
  assert.deepStrictEqual(await resolver.tick(), [], 'young holds are in-flight confirms, not checked');
  t += IN_FLIGHT_TTL_MS;
  const out = await resolver.tick();
  assert.strictEqual(out.length, 5);
  assert.strictEqual(book.has(P, 'a'), false, 'booked -> released');
  assert.strictEqual(book.has(P, 'b'), false, 'order confirmed cancelled -> released');
  assert.strictEqual(book.has(P, 'c'), true, 'open order -> kept');
  assert.strictEqual(book.has(P, 'd'), true, 'cannot reach the venue -> kept, never guessed');
  assert.strictEqual(book.has(P, 'e'), true, 'filled but unbooked -> kept while it books');
  assert.deepStrictEqual(rebooked, ['e']);
  assert.deepStrictEqual(await resolver.tick(), [], 'rechecks are paced');
  t += 20_000;
  await resolver.tick();
  assert.strictEqual(book.has(P, 'e'), false, 'released once the fill is booked');
  assert.strictEqual(book.has(P, 'c'), true);
  assert.ok(logs.some((l) => /HOLD KEPT \(filled at venue, not booked\)/.test(l)));
  // Per-lock last look checks older holds only.
  const parlay = await resolver.resolveParlay(P, { minAgeMs: 10_000 });
  assert.ok(parlay.every((r) => r.row.parlayId === P));
}

function twinWindow() {
  const trade = { qty: 91.61, parlay_id: P, marketSlug: 'caoc-79728d3a93c908c6', fill_id: 'poly-recon:new' };
  const earlier = {
    fill_id: 'poly-act:CVRGEVAFJYHR', parlay_id: P, count: 91.61, ticker: 'caoc-79728d3a93c908c6',
    raw: { source: 'poly-activity', venue: 'polymarket' },
    recorded_at: '2026-10-02T15:45:48Z',
    // The 3:29 PM replay overwrote this on 36 rows; it must not make an old row look recent.
    kalshi_created_time: '2026-10-02T19:29:31Z',
  };
  const now = Date.parse('2026-10-02T17:46:29Z');
  assert.ok(findPolyEconomicTwin(trade, { id: P }, [earlier]), 'legacy size-only match is unchanged');
  assert.strictEqual(
    !!findPolyEconomicTwin(trade, { id: P }, [earlier], { live: true, nowMs: now }), false,
    'live: a same-size row booked 2h earlier is a different fill',
  );
  assert.strictEqual(
    quoteFillAlreadyBooked({ contracts: 91.61, parlayId: P, marketTicker: 'caoc-79728d3a93c908c6' }, { id: P }, [earlier], { nowMs: now }),
    false,
  );
  const same = { ...earlier, fill_id: 'poly-act:CVT7SFW46YHR', recorded_at: '2026-10-02T17:46:40Z' };
  assert.strictEqual(
    quoteFillAlreadyBooked({ contracts: 91.61, parlayId: P, marketTicker: 'caoc-79728d3a93c908c6' }, { id: P }, [earlier, same], { nowMs: now }),
    true,
    'live: the same fill already booked seconds ago by another path is a twin',
  );
  assert.strictEqual(
    quoteFillAlreadyBooked({ contracts: 91.62, parlayId: P }, { id: P }, [same], { nowMs: now }), false,
    'different size is never a twin',
  );
}

function fakeLoop(extra = {}) {
  const booked = [];
  const pendingQuotes = new Map();
  const capBook = createCapBook({ enabled: true });
  const SEED_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  const http = {
    async getUserId() { return { rfqUserId: 'u' }; },
    async listRfqs() { return { rfqs: [] }; },
    async listQuotes() { return { quotes: [] }; },
    async getOrder() { return extra.order; },
    close() {},
  };
  const loop = startPolymarketRfqLoop({
    env: { POLYMARKET_KEY_ID: 'k', POLYMARKET_SECRET_KEY: SEED_B64, POLYMARKET_RFQ_LIVE: 'true', COMBO_CAP_AT_CONFIRM: '1' },
    http, startWs: false, crawl: false,
    getParlays: () => [], filledSoFarFor: () => 0, getOutstanding: () => 0,
    pendingQuotes, capBook, reconcileMs: 3_600_000, fillReconcileMs: 3_600_000,
    fastWatchMs: [20, 60, 120],
    loadPolySlugRecords: async () => extra.slugRecords || [],
    onQuoteExecuted: async (evt) => { booked.push(evt); },
    ...extra.ctx,
  });
  return { loop, booked, pendingQuotes, capBook };
}

async function watchdogBooksAFillTheFirstCheckMissed() {
  // Order is not filled at the quoteExecuted instant; it shows FILLED a beat later.
  const order = { id: 'ord-1', state: 'ORDER_STATE_NEW', cumQuantity: '0' };
  const { loop, booked, pendingQuotes, capBook } = fakeLoop({
    order,
    slugRecords: [{
      fill_id: 'poly-act:OLD', parlay_id: P, count: 91.61, ticker: 'caoc-x',
      raw: { source: 'poly-activity', venue: 'polymarket' },
      recorded_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    }],
  });
  const pending = {
    parlayId: P, label: 'Padres+Yankees+Dodgers', contracts: 91.61, rfqId: 'rfq-1', maxContracts: MAX,
    confirmed: true, quoteId: 'q-91',
  };
  pendingQuotes.set('q-91', pending);
  capBook.hold(P, 'q-91', 101.01, undefined, { venue: 'polymarket' });
  loop.handleQuoteExecuted({ type: 'quoteExecuted', quote: { id: 'q-91', rfqId: 'rfq-1', creatorOrderId: 'ord-1' } });
  await sleep(10);
  assert.strictEqual(booked.length, 0, 'not filled yet');
  order.state = 'ORDER_STATE_FILLED';
  order.cumQuantity = '91.61';
  await sleep(150);
  assert.strictEqual(booked.length, 1, 'watchdog booked it');
  assert.strictEqual(booked[0].contracts, 91.61, 'same size as a fill from 2h ago is NOT a twin');
  assert.strictEqual(booked[0].live, true);
  loop.stop();
}

async function checkHoldClassifiesTheOrder() {
  const order = { id: 'ord-2', state: 'ORDER_STATE_NEW', cumQuantity: '0' };
  const { loop, pendingQuotes } = fakeLoop({ order, slugRecords: [] });
  pendingQuotes.set('q-2', { parlayId: P, contracts: 91.61, creatorOrderId: 'ord-2', quoteId: 'q-2' });
  const row = { parlayId: P, quoteId: 'q-2', size: 101, at: Date.now() - 200_000, meta: { venue: 'polymarket' } };
  assert.strictEqual((await loop.checkHold(row)).state, 'open');
  order.state = 'ORDER_STATE_CANCELED';
  assert.strictEqual((await loop.checkHold(row)).state, 'cancelled');
  order.state = 'ORDER_STATE_FILLED'; order.cumQuantity = '91.61';
  assert.strictEqual((await loop.checkHold(row)).state, 'filled_unbooked');
  const booked = fakeLoop({
    order, slugRecords: [{ fill_id: 'poly-act:T', parlay_id: P, count: 91.61, raw: { source: 'poly-activity', venue: 'polymarket' }, recorded_at: new Date().toISOString() }],
  });
  booked.pendingQuotes.set('q-2', { parlayId: P, contracts: 91.61, creatorOrderId: 'ord-2', quoteId: 'q-2' });
  assert.strictEqual((await booked.loop.checkHold(row)).state, 'booked', 'a poly-act row for the same size after the hold is the booking');
  const noOrder = fakeLoop({ order: null });
  noOrder.pendingQuotes.set('q-3', { parlayId: P, contracts: 5, quoteId: 'q-3' });
  assert.strictEqual((await noOrder.loop.checkHold({ ...row, quoteId: 'q-3' })).state, 'unknown');
  loop.stop(); booked.loop.stop(); noOrder.loop.stop();
}

(async () => {
  await holdsSurviveTheSoftTtl();
  await finalFillReleasesTheWholeHold();
  await lastLookStopsTheIncidentConfirm();
  await resolverVerifiesStaleHolds();
  twinWindow();
  await watchdogBooksAFillTheFirstCheckMissed();
  await checkHoldClassifiesTheOrder();
  console.log('cap-last-look.test.js ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
