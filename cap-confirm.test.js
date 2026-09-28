'use strict';
const assert = require('assert');
const { decideAtFill, hedgeCap } = require('./engine');
const {
  CLOSED_CONTEXT_TTL_MS,
  capAtConfirmEnabled,
  createCapBook,
  createClosedContext,
  confirmAgainstCap,
  maxPolymarketFillSize,
  overfillOf,
  formatOverfillAlert,
  formatMissingContext,
} = require('./cap-confirm');

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX = 116;
const SIZE = 43;
const P = 'lock-1';

function decide(filled, outstanding, rfqContracts = SIZE) {
  return decideAtFill({
    parlayStake: 100,
    parlayAmerican: 400,
    fillAmerican: 350,
    rfqContracts,
    hedgeMode: '1x',
    maxContracts: MAX,
    filledSoFar: filled,
    outstanding,
  });
}

assert.strictEqual(capAtConfirmEnabled({}), false);
assert.strictEqual(capAtConfirmEnabled({ COMBO_CAP_AT_CONFIRM: '0' }), false);
assert.strictEqual(capAtConfirmEnabled({ COMBO_CAP_AT_CONFIRM: '1' }), true);
assert.strictEqual(capAtConfirmEnabled({ COMBO_CAP_AT_CONFIRM: 'true' }), true);
assert.strictEqual(CLOSED_CONTEXT_TTL_MS, 60_000);

// Flag off: open quotes still reserve. Two 43s leave a third oversized.
{
  const book = createCapBook({ enabled: false });
  book.hold(P, 'ignored', 100);
  const open = SIZE * 2;
  assert.strictEqual(book.exposure(open, P), open, 'flag off ignores in-flight and keeps open quotes');
  const third = decide(0, book.exposure(open, P));
  assert.strictEqual(third.ok, false);
  assert.strictEqual(third.reason, 'rfq_too_large');
  assert.strictEqual(third.outstanding, 86);
  assert.strictEqual(decide(0, book.exposure(0, P), 500).reason, 'rfq_too_large');
}

// Flag on: open quotes do not reserve. A single RFQ bigger than the cap still skips.
// In-flight confirms do reserve.
{
  const book = createCapBook({ enabled: true });
  const open = SIZE * 2;
  assert.strictEqual(book.exposure(open, P), 0);
  const third = decide(0, book.exposure(open, P));
  assert.strictEqual(third.ok, true);
  assert.strictEqual(third.contracts, SIZE);
  assert.strictEqual(decide(0, 0, 500).ok, false);
  assert.strictEqual(decide(0, 0, 500).reason, 'rfq_too_large');
  book.hold(P, 'c1', 80);
  const blocked = decide(0, book.exposure(open, P));
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.reason, 'rfq_too_large');
  assert.strictEqual(decide(116, book.exposure(0, P)).reason, 'limit_reached');
}

// Flag on: open quotes do not reserve, so an RFQ up to riskfree_open is accepted.
// The same hedgeCap is the per-fill ceiling. 1× would still decline it.
{
  const book = createCapBook({ enabled: true });
  const stake = 100;
  const boost = 2000;
  const fill = 1200;
  const openCap = hedgeCap({
    stake, boostAmerican: boost, fillAmerican: fill, mode: 'riskfree_open',
  });
  assert.strictEqual(openCap, 2166);
  const openQuotes = 2100;
  assert.strictEqual(book.exposure(openQuotes, P), 0);
  const accepted = decideAtFill({
    parlayStake: stake,
    parlayAmerican: boost,
    fillAmerican: fill,
    rfqContracts: openCap,
    hedgeMode: 'riskfree_open',
    maxContracts: openCap,
    filledSoFar: 0,
    outstanding: book.exposure(openQuotes, P),
  });
  assert.strictEqual(accepted.ok, true);
  assert.strictEqual(accepted.contracts, 2166);
  assert.strictEqual(accepted.cap, 2166);
  const oneX = decideAtFill({
    parlayStake: stake,
    parlayAmerican: boost,
    fillAmerican: fill,
    rfqContracts: openCap,
    hedgeMode: '1x',
    maxContracts: openCap,
    outstanding: book.exposure(openQuotes, P),
  });
  assert.strictEqual(oneX.ok, false);
  assert.strictEqual(oneX.reason, 'rfq_too_large');
  assert.strictEqual(oneX.cap, 2100);
}

// Polymarket can fill more than we quoted. Cap against the larger number.
{
  const quoted = { contracts: 209, estimatedContracts: 377.5, label: 'MIA+IND+TEN' };
  assert.strictEqual(maxPolymarketFillSize(quoted, null), 377.5);
  const cash = { contracts: 227.25, cashOrderQty: '200', buyPrice: '0.3532' };
  const cashMax = maxPolymarketFillSize(cash, null);
  assert.ok(cashMax > 566 && cashMax < 567, `cash/price max was ${cashMax}`);
  const fromAccept = maxPolymarketFillSize(
    { contracts: 227.25 },
    { quote: { acceptedQty: '566.2' } },
  );
  assert.strictEqual(fromAccept, 566.2);
  assert.strictEqual(maxPolymarketFillSize({ contracts: 10 }, { quote: { id: 'q' } }), 10);
}

{
  const over = overfillOf(209, 377.5);
  assert.deepStrictEqual(over, { quoted: 209, filled: 377.5 });
  assert.strictEqual(overfillOf(227.25, 566.2).filled, 566.2);
  assert.strictEqual(overfillOf(209, 192), null, '8% underfill is not an overfill');
  assert.strictEqual(overfillOf(209, 209), null);
  const alert = formatOverfillAlert({
    venue: 'polymarket', label: 'MIA+IND+TEN', quoteShort: 'q377', quoted: 209, filled: 377.5,
  });
  assert.ok(alert.startsWith('⚠️ OVERFILL (Polymarket)'));
  assert.ok(alert.includes('quoted 209'));
  assert.ok(alert.includes('filled 377.5'));
  assert.ok(formatMissingContext('POLY', 'q1', 'r1').includes('not confirming'));
}

// Closed-context TTL. A late accept inside the window still has the lock.
{
  let now = 1_000_000;
  const closed = createClosedContext({ ttlMs: CLOSED_CONTEXT_TTL_MS, now: () => now });
  closed.put('q-keep', { label: 'MIA+IND+TEN', contracts: 209, parlayId: P, maxContracts: 400 });
  now += CLOSED_CONTEXT_TTL_MS - 1;
  assert.strictEqual(closed.get('q-keep').label, 'MIA+IND+TEN');
  now += 1;
  assert.strictEqual(closed.get('q-keep'), null);
}

function confirmCall(book, fields) {
  return confirmAgainstCap(book, fields);
}

async function runAsync() {
// Flag off confirm still counts the other open quote (today's behavior).
{
  const book = createCapBook({ enabled: false });
  const confirms = [];
  const declines = [];
  const result = await confirmCall(book, {
    parlayId: P,
    quoteId: 'q3',
    maxContracts: MAX,
    size: SIZE,
    getFilled: () => 0,
    getOpenHeld: () => SIZE * 2,
    confirm: async () => { confirms.push('q3'); },
    onExceed: async (info) => { declines.push(info); },
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'cap_exceeded');
  assert.strictEqual(result.held, 86);
  assert.strictEqual(confirms.length, 0);
  assert.strictEqual(declines.length, 1);
}

// Oversized accept is declined and does not confirm.
{
  const book = createCapBook({ enabled: true });
  const confirms = [];
  const result = await confirmCall(book, {
    parlayId: P,
    quoteId: 'big',
    maxContracts: 100,
    size: 150,
    getFilled: () => 0,
    getOpenHeld: () => 999,
    confirm: async () => { confirms.push('big'); },
    onExceed: async () => {},
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(confirms.length, 0);
  assert.strictEqual(book.sum(P), 0, 'declined accept must not hold cap');
}

// Two near-simultaneous accepts on one lock cannot both pass. A different
// lock still confirms in parallel.
{
  const book = createCapBook({ enabled: true });
  let depth = 0;
  let maxDepth = 0;
  const confirms = [];
  const run = (parlayId, quoteId, size) => confirmCall(book, {
    parlayId,
    quoteId,
    maxContracts: 100,
    size,
    getFilled: () => 0,
    getOpenHeld: () => 0,
    confirm: async () => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      confirms.push(quoteId);
      await pause(30);
      depth -= 1;
    },
    onExceed: async () => {},
  });
  const [a, b, a2] = await Promise.all([
    run('A', 'a', 60),
    run('B', 'b', 60),
    run('A', 'a2', 60),
  ]);
  const aResults = [a, a2];
  assert.strictEqual(aResults.filter((r) => r.ok).length, 1, 'same lock cannot confirm 60+60 against 100');
  assert.strictEqual(aResults.filter((r) => !r.ok).length, 1);
  assert.strictEqual(b.ok, true);
  assert.ok(confirms.includes('a') || confirms.includes('a2'));
  assert.ok(confirms.includes('b'));
  assert.ok(!confirms.includes('a') || !confirms.includes('a2'));
  assert.ok(maxDepth >= 2, 'different locks must not share one global lock');
  assert.strictEqual(book.sum('A'), 60);
  assert.strictEqual(book.sum('B'), 60);
}

// Fills replace the in-flight hold. A later accept sees the actual size.
{
  const book = createCapBook({ enabled: true });
  const first = await confirmCall(book, {
    parlayId: P,
    quoteId: 'q',
    maxContracts: 100,
    size: 40,
    getFilled: () => 0,
    getOpenHeld: () => 0,
    confirm: async () => {},
  });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(book.sum(P), 40);
  let filled = 0;
  book.release(P, 'q');
  filled = 40;
  const second = await confirmCall(book, {
    parlayId: P,
    quoteId: 'q2',
    maxContracts: 100,
    size: 70,
    getFilled: () => filled,
    getOpenHeld: () => 0,
    confirm: async () => {},
    onExceed: async () => {},
  });
  assert.strictEqual(second.ok, false, '40 filled + 70 accept exceeds 100');
}

// Polymarket max size is what the hold uses, so a quoted 209 that can fill
// 377.5 blocks the next accept even when 209 alone would have fit.
{
  const book = createCapBook({ enabled: true });
  const size = maxPolymarketFillSize({ contracts: 209, estimatedContracts: 377.5 }, null);
  const first = await confirmCall(book, {
    parlayId: P,
    quoteId: 'mia',
    maxContracts: 400,
    size,
    getFilled: () => 0,
    getOpenHeld: () => 0,
    confirm: async () => {},
  });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(book.sum(P), 377.5);
  const next = await confirmCall(book, {
    parlayId: P,
    quoteId: 'mia2',
    maxContracts: 400,
    size: 50,
    getFilled: () => 0,
    getOpenHeld: () => 0,
    confirm: async () => {},
    onExceed: async () => {},
  });
  assert.strictEqual(next.ok, false);
  const tooBig = await confirmCall(book, {
    parlayId: 'other',
    quoteId: 'over',
    maxContracts: 300,
    size: maxPolymarketFillSize({ contracts: 209, rfqQty: 377.5 }, null),
    getFilled: () => 0,
    getOpenHeld: () => 0,
    confirm: async () => { throw new Error('must not confirm'); },
    onExceed: async () => {},
  });
  assert.strictEqual(tooBig.ok, false);
}
}

runAsync().then(() => {
  console.log('cap-confirm.test.js ok');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
