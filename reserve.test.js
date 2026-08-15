'use strict';
const assert = require('assert');
const { decideAtFill, fillView } = require('./engine');
const {
  sumOutstanding,
  mergeOutstanding,
  remainingAfterReserve,
  wouldExceedCap,
  isCapExhausted,
  isReserveKey,
} = require('./reserve');

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

console.log('reserve.test.js ok');
