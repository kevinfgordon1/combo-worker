'use strict';
const assert = require('assert');
const { decideAtFill, fillView } = require('./engine');
const {
  RESERVE_TTL_MS,
  sumOutstanding,
  mergeOutstanding,
  remainingAfterReserve,
  wouldExceedCap,
  isCapExhausted,
  isReserveKey,
  postedAtMs,
  isFreshOutstanding,
  dropPendingForRfq,
  sweepStalePending,
} = require('./reserve');
const { isRfqClosed, normalizeRfqClosed, parseEnvelope } = require('./rfq');

// Tonight: White Sox ML + Pirates ML, max_contracts = 116.
// $10 dollar RFQ at +350 fill → no_bid 0.77 → yes ~0.23 → 43 contracts.
const MAX = 116;
const SIZE = 43;
const P = 'ae7a56e8-8ee3-478d-96fa-7c167c20d46e';

const dollarNoBid = parseFloat(fillView(350).noBid);
const dollarYes = Math.max(0.01, 1 - dollarNoBid);
assert.strictEqual(Math.floor(10 / dollarYes), SIZE);

const decide = (filledSoFar, outstanding, rfqContracts = SIZE) => decideAtFill({
  parlayStake: 100,
  parlayAmerican: 400,
  fillAmerican: 350,
  rfqContracts,
  hedgeMode: '1x',
  maxContracts: MAX,
  filledSoFar,
  outstanding,
});

// ── remaining vs reserved ──────────────────────────────────────────────
assert.strictEqual(remainingAfterReserve(MAX, 0, 0), 116);
assert.strictEqual(remainingAfterReserve(MAX, 0, SIZE), 73);
assert.strictEqual(remainingAfterReserve(MAX, 0, SIZE * 2), 30);
assert.strictEqual(remainingAfterReserve(MAX, 0, SIZE * 3), 0);
assert.strictEqual(remainingAfterReserve(MAX, 86, 0), 30);
assert.strictEqual(remainingAfterReserve(MAX, 116, 0), 0);
assert.strictEqual(remainingAfterReserve(MAX, 116, SIZE), 0);
assert.strictEqual(remainingAfterReserve(null, 0, SIZE), null);

// ── first 43s fit; later ones do not ───────────────────────────────────
const pending = new Map();
assert.strictEqual(wouldExceedCap(MAX, 0, sumOutstanding(pending, P), SIZE), false);
const first = decide(0, sumOutstanding(pending, P));
assert.ok(first.ok);
assert.strictEqual(first.contracts, SIZE);
assert.strictEqual(first.outstanding, 0);
assert.strictEqual(first.remaining, 73);
pending.set('q1', { parlayId: P, contracts: SIZE });

assert.strictEqual(wouldExceedCap(MAX, 0, sumOutstanding(pending, P), SIZE), false);
const second = decide(0, sumOutstanding(pending, P));
assert.ok(second.ok);
assert.strictEqual(second.outstanding, SIZE);
assert.strictEqual(second.remaining, 30);
pending.set('q2', { parlayId: P, contracts: SIZE });

assert.strictEqual(sumOutstanding(pending, P), 86);
assert.strictEqual(wouldExceedCap(MAX, 0, sumOutstanding(pending, P), SIZE), true);
const third = decide(0, sumOutstanding(pending, P));
assert.strictEqual(third.ok, false);
assert.strictEqual(third.reason, 'rfq_too_large');
assert.strictEqual(third.remaining, 30);
assert.strictEqual(third.outstanding, 86);

// A fourth / fifth (the 225-contract overfill) also skip.
pending.set('reserve:pre-post', { parlayId: P, contracts: SIZE }); // in-flight POST
assert.strictEqual(isReserveKey('reserve:pre-post'), true);
assert.strictEqual(sumOutstanding(pending, P), 129);
const fourth = decide(0, sumOutstanding(pending, P));
assert.strictEqual(fourth.ok, false);
assert.strictEqual(fourth.reason, 'limit_reached');
assert.strictEqual(fourth.remaining, 0);
pending.delete('reserve:pre-post');

// Other parlays do not consume this ceiling.
pending.set('other', { parlayId: 'someone-else', contracts: 500 });
assert.strictEqual(sumOutstanding(pending, P), 86);

// ── confirm: first two OK; a 3rd already-posted quote cancels ──────────
assert.strictEqual(wouldExceedCap(MAX, 0, sumOutstanding(pending, P, 'q1'), SIZE), false);
assert.strictEqual(wouldExceedCap(MAX, 0, sumOutstanding(pending, P, 'q2'), SIZE), false);
pending.set('q3', { parlayId: P, contracts: SIZE });
assert.strictEqual(wouldExceedCap(MAX, 0, sumOutstanding(pending, P, 'q3'), SIZE), true);
pending.delete('q3');

// After two 43s execute, leftover 43 cannot confirm.
assert.strictEqual(wouldExceedCap(MAX, 86, 0, SIZE), true);
assert.strictEqual(decide(86, 0).ok, false);
assert.strictEqual(decide(86, 0).reason, 'rfq_too_large');

// ── cap full → leftover open quotes must be cancelled ──────────────────
assert.strictEqual(isCapExhausted(MAX, 0), false);
assert.strictEqual(isCapExhausted(MAX, 86), false);
assert.strictEqual(isCapExhausted(MAX, 116), true);
assert.strictEqual(isCapExhausted(MAX, 225.99), true);
assert.strictEqual(isCapExhausted(null, 116), false);

// ── combo_submissions rows merge without double-counting quote_id ──────
const rows = [
  { quote_id: 'q1', parlay_id: P, contracts: SIZE, is_live: true, order_id: null },
  { quote_id: 'q-db', parlay_id: P, contracts: SIZE, is_live: true, order_id: null },
];
assert.strictEqual(mergeOutstanding(pending, rows, P), 86 + SIZE); // q1 + q2 + q-db
assert.strictEqual(mergeOutstanding(pending, rows, P, 'q2'), SIZE + SIZE); // q1 + q-db
assert.strictEqual(sumOutstanding(rows, P), SIZE * 2);

// Filled + outstanding + this is the post/confirm gate (not filled alone).
assert.strictEqual(wouldExceedCap(MAX, 0, 86, SIZE), true);
assert.strictEqual(wouldExceedCap(MAX, 0, 43, SIZE), false);
assert.strictEqual(wouldExceedCap(MAX, 0, 0, SIZE), false);
assert.strictEqual(wouldExceedCap(MAX, 116, 0, 1), true);

// ── rfq_deleted / TTL release (the Cardinals/Pirates leak) ─────────────
{
  const MAX_LOCK = 1347;
  const filled = 20;
  const now = Date.parse('2026-08-23T16:00:00Z');
  const live = new Map();

  // Two overlapping live quotes still reserve both.
  live.set('q-55', { parlayId: P, contracts: 55, rfqId: 'rfq-a', postedAt: now });
  live.set('q-61', { parlayId: P, contracts: 61, rfqId: 'rfq-b', postedAt: now });
  assert.strictEqual(sumOutstanding(live, P), 116);
  assert.strictEqual(wouldExceedCap(MAX_LOCK, filled, sumOutstanding(live, P), 55), false);

  // Just-posted quote is not swept immediately.
  const justSwept = sweepStalePending(live, now, RESERVE_TTL_MS);
  assert.strictEqual(justSwept.length, 0);
  assert.strictEqual(sumOutstanding(live, P), 116);
  assert.strictEqual(sweepStalePending(live, now + RESERVE_TTL_MS - 1, RESERVE_TTL_MS).length, 0);
  assert.strictEqual(sumOutstanding(live, P), 116);

  // rfq_deleted drops every entry for that rfq_id, including a pre-POST reserve: key.
  live.set('reserve:in-flight', { parlayId: P, contracts: 64, rfqId: 'rfq-c', postedAt: now });
  live.set('q-64', { parlayId: P, contracts: 64, rfqId: 'rfq-c', postedAt: now });
  assert.strictEqual(isReserveKey('reserve:in-flight'), true);
  assert.strictEqual(sumOutstanding(live, P), 116 + 64 + 64);
  const closedEnv = parseEnvelope(JSON.stringify({
    type: 'rfq_deleted',
    sid: 15,
    msg: { id: 'rfq-c', deleted_ts: '2026-08-23T16:00:08Z' },
  }));
  assert.strictEqual(isRfqClosed(closedEnv), true);
  assert.strictEqual(isRfqClosed({ type: 'rfq_created', msg: { id: 'rfq-c' } }), false);
  assert.strictEqual(isRfqClosed({ type: 'rfq_expired', msg: { id: 'rfq-c' } }), true);
  const closed = normalizeRfqClosed(closedEnv);
  assert.strictEqual(closed.rfqId, 'rfq-c');
  const droppedClosed = dropPendingForRfq(live, closed.rfqId);
  assert.strictEqual(droppedClosed.length, 2);
  assert.ok(droppedClosed.some((d) => d.id === 'reserve:in-flight'));
  assert.ok(droppedClosed.some((d) => d.id === 'q-64'));
  assert.strictEqual(live.has('q-55'), true);
  assert.strictEqual(live.has('q-61'), true);
  assert.strictEqual(sumOutstanding(live, P), 116);

  // Fill still deletes (quote_executed path) — the other live quote stays reserved.
  live.delete('q-55');
  assert.strictEqual(sumOutstanding(live, P), 61);
  assert.strictEqual(wouldExceedCap(MAX_LOCK, filled + 55, sumOutstanding(live, P), 61), false);

  // TTL sweep: dead 1298-contract cycle no longer pins remaining=29.
  const leak = new Map();
  leak.set('q-dead', {
    parlayId: P, contracts: 1298, rfqId: 'rfq-cycle', postedAt: now - 30_000, label: 'Cards/Pirates',
  });
  leak.set('q-fresh', { parlayId: P, contracts: 64, rfqId: 'rfq-live', postedAt: now });
  assert.strictEqual(wouldExceedCap(MAX_LOCK, filled, sumOutstanding(leak, P), 55), true);
  const expired = sweepStalePending(leak, now, RESERVE_TTL_MS);
  assert.strictEqual(expired.length, 1);
  assert.strictEqual(expired[0].id, 'q-dead');
  assert.strictEqual(sumOutstanding(leak, P), 64);
  assert.strictEqual(wouldExceedCap(MAX_LOCK, filled, sumOutstanding(leak, P), 55), false);
  const after = decideAtFill({
    parlayStake: 100,
    parlayAmerican: 400,
    fillAmerican: 350,
    rfqContracts: 55,
    hedgeMode: '1x',
    maxContracts: MAX_LOCK,
    filledSoFar: filled,
    outstanding: sumOutstanding(leak, P),
  });
  assert.ok(after.ok);
  assert.strictEqual(after.contracts, 55);
  assert.strictEqual(after.remaining, MAX_LOCK - filled - 64 - 55);

  // Restart seed: old combo_submissions rows must not re-pin remaining.
  assert.strictEqual(RESERVE_TTL_MS, 25_000);
  assert.strictEqual(postedAtMs({ created_at: '2026-08-23T15:59:50Z' }), Date.parse('2026-08-23T15:59:50Z'));
  assert.strictEqual(isFreshOutstanding({
    quote_id: 'old', is_live: true, order_id: null,
    created_at: new Date(now - 2 * 3600 * 1000).toISOString(),
  }, now), false);
  assert.strictEqual(isFreshOutstanding({
    quote_id: 'fresh', is_live: true, order_id: null,
    created_at: new Date(now - 5_000).toISOString(),
  }, now), true);
  assert.strictEqual(isFreshOutstanding({ quote_id: 'undated', is_live: true }, now), false);
}

console.log('reserve.test.js ok');
