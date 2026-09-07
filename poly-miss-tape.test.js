'use strict';
const assert = require('assert');
const { decideAtFill } = require('./engine');
const {
  NEAR_MISS_CODES,
  NOISE_CODES,
  DEDUPE_MAX,
  isOverlapSkipReason,
  polySkipReason,
  missTapeKind,
  parlayForMiss,
  dedupeKey,
  decidePolyMissWrite,
  createPolyMissTape,
} = require('./poly-miss-tape');

const lock = {
  id: '98d3e355-4a1d-4f60-91ed-a7c1517c60ad',
  user_id: 'u1',
  label: 'Chicago Bears + Eagles + Rams',
};

function overlapEval(rfqId, code = 'same_games_no_match') {
  return {
    action: 'skip',
    reason: 'no_lock_overlap',
    rfq: { rfqId, id: rfqId },
    overlap: { code, lock: lock.label, parlay: lock },
    parlay: lock,
  };
}

function quoteEval(rfqId) {
  return {
    action: 'quoteable',
    reason: null,
    rfq: { rfqId, id: rfqId },
    parlay: lock,
    decision: { contracts: 10, remaining: 140, fillAmerican: 400, worst: 2 },
    quote: { estimatedContracts: 10, buyPrice: 0.2, sellPrice: 0.8 },
  };
}

function oversizedDecision() {
  return decideAtFill({
    parlayStake: 100,
    parlayAmerican: 400,
    fillAmerican: 350,
    hedgeMode: '1x',
    maxContracts: 116,
    rfqContracts: 8000,
  });
}

function capDecision() {
  return decideAtFill({
    parlayStake: 100,
    parlayAmerican: 400,
    fillAmerican: 350,
    hedgeMode: '1x',
    maxContracts: 10,
    filledSoFar: 10,
    rfqContracts: 5,
  });
}

{
  assert.ok(NEAR_MISS_CODES.includes('same_games_no_match'));
  assert.ok(NEAR_MISS_CODES.includes('leg_count'));
  assert.ok(NOISE_CODES.includes('no_shared_game'));
  assert.ok(isOverlapSkipReason('no_lock_overlap'));
  assert.ok(isOverlapSkipReason('no_lock_overlap:leg_count'));
  assert.ok(isOverlapSkipReason('no_lock_overlap:no_shared_game x80'));
  assert.ok(!isOverlapSkipReason('oversized'));
  assert.ok(!isOverlapSkipReason('game_started'));
  assert.strictEqual(missTapeKind(quoteEval('q1'), 'quoted'), 'quote');
  assert.strictEqual(missTapeKind(quoteEval('q1'), 'shadow'), 'quote');
  assert.strictEqual(missTapeKind(quoteEval('q1'), 'unfilled'), 'quote');
  assert.strictEqual(missTapeKind(overlapEval('n1'), 'declined'), 'overlap_skip');
  assert.strictEqual(missTapeKind(overlapEval('n1', 'leg_count'), 'declined'), 'overlap_skip');
  assert.strictEqual(missTapeKind({
    reason: 'no_lock_overlap',
    overlap: { code: 'no_shared_game' },
  }, 'declined'), 'overlap_skip');
  assert.strictEqual(missTapeKind({
    reason: 'game_started',
    parlay: lock,
  }, 'declined'), 'matched_skip');
  assert.strictEqual(missTapeKind({ reason: 'unmatched' }, 'declined'), 'drop');
}

{
  assert.strictEqual(polySkipReason(quoteEval('q1'), 'quoted'), null);
  assert.strictEqual(
    polySkipReason(overlapEval('n1'), 'declined'),
    'no_lock_overlap:same_games_no_match'
  );
  assert.strictEqual(
    polySkipReason({ reason: 'rfq_too_large', decision: oversizedDecision(), parlay: lock }, 'declined'),
    'oversized'
  );
  assert.strictEqual(
    polySkipReason({ reason: 'limit_reached', decision: capDecision(), parlay: lock }, 'declined'),
    'limit_reached'
  );
  assert.strictEqual(
    polySkipReason({ reason: 'game_started', parlay: lock }, 'declined'),
    'game_started'
  );
  assert.strictEqual(parlayForMiss(overlapEval('n1')).id, lock.id);
  assert.strictEqual(parlayForMiss({
    reason: 'no_lock_overlap',
    overlap: { code: 'leg_count', parlay: lock },
  }).id, lock.id);
}

{
  const quote = decidePolyMissWrite(quoteEval('rfq_q'), 'quoted');
  assert.strictEqual(quote.write, true);
  assert.strictEqual(quote.kind, 'quote');
  assert.strictEqual(quote.parlay.id, lock.id);
  assert.strictEqual(quote.skipReason, null);

  const oversized = decidePolyMissWrite({
    reason: 'rfq_too_large',
    decision: oversizedDecision(),
    parlay: lock,
    rfq: { rfqId: 'rfq_over' },
  }, 'declined');
  assert.strictEqual(oversized.write, true);
  assert.strictEqual(oversized.kind, 'matched_skip');
  assert.strictEqual(oversized.skipReason, 'oversized');

  const cap = decidePolyMissWrite({
    reason: 'limit_reached',
    decision: capDecision(),
    parlay: lock,
    rfq: { rfqId: 'rfq_cap' },
  }, 'declined');
  assert.strictEqual(cap.write, true);
  assert.strictEqual(cap.skipReason, 'limit_reached');

  const started = decidePolyMissWrite({
    reason: 'game_started',
    parlay: lock,
    rfq: { rfqId: 'rfq_started' },
  }, 'declined');
  assert.strictEqual(started.write, true);
  assert.strictEqual(started.skipReason, 'game_started');

  const funded = decidePolyMissWrite(quoteEval('rfq_fund'), 'declined', {}, {
    skip_reason: 'insufficient_balance',
  });
  assert.strictEqual(funded.write, true);
  assert.strictEqual(funded.skipReason, 'insufficient_balance');

  for (const code of ['leg_count', 'no_shared_game', 'missing_team', 'same_games_no_match', 'doubleheader']) {
    const miss = decidePolyMissWrite(overlapEval(`rfq_${code}`, code), 'declined');
    assert.strictEqual(miss.write, false, `${code} must not persist`);
    assert.strictEqual(miss.kind, 'overlap_skip');
    assert.strictEqual(miss.reason, 'overlap_skip');
  }

  const forcedOverlap = decidePolyMissWrite(quoteEval('rfq_forced'), 'declined', {}, {
    skip_reason: 'no_lock_overlap:leg_count',
  });
  assert.strictEqual(forcedOverlap.write, false);
  assert.strictEqual(forcedOverlap.reason, 'overlap_skip');

  const seen = new Set([quote.key]);
  const again = decidePolyMissWrite(quoteEval('rfq_q'), 'quoted', { seen });
  assert.strictEqual(again.write, false);
  assert.strictEqual(again.reason, 'deduped');
}

{
  const rows = [];
  const tape = createPolyMissTape({
    logAsync: (p, rfq, d, status, extra) => {
      rows.push({
        user_id: p.user_id,
        parlay_id: p.id,
        label: p.label,
        rfq_id: rfq.rfqId,
        status,
        skip_reason: extra && extra.skip_reason,
        quote_id: extra && extra.quote_id,
        is_live: extra && extra.is_live,
        contracts: extra && extra.contracts,
        venue: 'polymarket',
      });
    },
  });

  assert.strictEqual(tape.persist(quoteEval('rfq_quote'), 'quoted', {
    quote_id: 'q1', is_live: true, contracts: 10,
  }).persisted, true);
  assert.strictEqual(tape.persist(quoteEval('rfq_quote'), 'quoted', {
    quote_id: 'q1', is_live: true, contracts: 10,
  }).persisted, false, 'quote deduped');

  const funded = tape.persist(quoteEval('rfq_fund'), 'declined', {
    skip_reason: 'insufficient_balance', contracts: 10,
  });
  assert.strictEqual(funded.persisted, true);
  assert.strictEqual(funded.skipReason, 'insufficient_balance');
  assert.strictEqual(funded.kind, 'matched_skip');

  assert.strictEqual(tape.persist({
    reason: 'rfq_too_large',
    decision: oversizedDecision(),
    parlay: lock,
    rfq: { rfqId: 'rfq_over' },
  }, 'declined').persisted, true);

  assert.strictEqual(tape.persist({
    reason: 'limit_reached',
    decision: capDecision(),
    parlay: lock,
    rfq: { rfqId: 'rfq_cap' },
  }, 'declined').persisted, true);

  assert.strictEqual(tape.persist({
    reason: 'game_started',
    parlay: lock,
    rfq: { rfqId: 'rfq_started' },
  }, 'declined').persisted, true);

  for (const code of ['leg_count', 'no_shared_game', 'missing_team', 'same_games_no_match']) {
    const out = tape.persist(overlapEval(`rfq_${code}`, code), 'declined', { locks: [lock] });
    assert.strictEqual(out.persisted, false);
    assert.strictEqual(out.reason, 'overlap_skip');
  }

  const quoted = rows.find((r) => r.rfq_id === 'rfq_quote');
  assert.ok(quoted);
  assert.strictEqual(quoted.parlay_id, lock.id);
  assert.strictEqual(quoted.status, 'quoted');
  assert.strictEqual(quoted.quote_id, 'q1');
  assert.strictEqual(quoted.skip_reason, undefined);
  assert.strictEqual(quoted.venue, 'polymarket');

  const fundRow = rows.find((r) => r.rfq_id === 'rfq_fund');
  assert.ok(fundRow);
  assert.strictEqual(fundRow.status, 'declined');
  assert.strictEqual(fundRow.skip_reason, 'insufficient_balance');
  assert.strictEqual(fundRow.contracts, 10);

  assert.strictEqual(rows.find((r) => r.rfq_id === 'rfq_over').skip_reason, 'oversized');
  assert.strictEqual(rows.find((r) => r.rfq_id === 'rfq_cap').skip_reason, 'limit_reached');
  assert.strictEqual(rows.find((r) => r.rfq_id === 'rfq_started').skip_reason, 'game_started');
  assert.ok(!rows.some((r) => r.skip_reason && String(r.skip_reason).startsWith('no_lock_overlap')));

  const beforeNoise = rows.length;
  for (let i = 0; i < 80; i++) {
    const out = tape.persist({
      action: 'skip',
      reason: 'no_lock_overlap',
      rfq: { rfqId: `rfq_cfb_${i}` },
      overlap: { code: 'leg_count' },
      parlay: lock,
    }, 'declined', { locks: [lock] });
    assert.strictEqual(out.persisted, false);
    assert.strictEqual(out.reason, 'overlap_skip');
  }
  assert.strictEqual(rows.length, beforeNoise, 'overlap SKIPs must not insert per-row');
  assert.deepStrictEqual(tape.flushNoise(), []);
  assert.strictEqual(rows.length, beforeNoise, 'flushNoise must not insert overlap aggregates');
}

{
  const rows = [];
  const tape = createPolyMissTape({
    logAsync: (p, rfq) => { rows.push(rfq.rfqId); },
  });
  for (let i = 0; i < DEDUPE_MAX + 40; i++) {
    tape.persist(quoteEval(`rfq_lru_${i}`), 'quoted');
  }
  assert.ok(tape.seen.size <= DEDUPE_MAX);
  assert.strictEqual(rows.length, DEDUPE_MAX + 40);
}

{
  const silent = createPolyMissTape({});
  assert.strictEqual(silent.persist(quoteEval('x'), 'quoted').reason, 'no_logger');
  assert.deepStrictEqual(silent.flushNoise(), []);
}

assert.strictEqual(
  dedupeKey({ parlayId: 'p', rfqId: 'r', status: 'declined', skipReason: 'game_started' }),
  'p|r|declined|game_started'
);

console.log('poly-miss-tape.test.js ok');
