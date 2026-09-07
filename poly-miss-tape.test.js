'use strict';
const assert = require('assert');
const { decideAtFill } = require('./engine');
const {
  NEAR_MISS_CODES,
  NOISE_CODES,
  MAX_NEAR_MISS_PER_WINDOW,
  DEDUPE_MAX,
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
  label: 'Arizona + Jacksonville',
  fill_american: 400,
};

function nearMissEval(rfqId, code = 'same_games_no_match') {
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

{
  assert.ok(NEAR_MISS_CODES.includes('same_games_no_match'));
  assert.ok(NEAR_MISS_CODES.includes('leg_count'));
  assert.ok(NOISE_CODES.includes('no_shared_game'));
  assert.strictEqual(missTapeKind(quoteEval('q1'), 'quoted'), 'quote');
  assert.strictEqual(missTapeKind(quoteEval('q1'), 'shadow'), 'quote');
  assert.strictEqual(missTapeKind(quoteEval('q1'), 'unfilled'), 'quote');
  assert.strictEqual(missTapeKind(nearMissEval('n1'), 'declined'), 'near_miss');
  assert.strictEqual(missTapeKind({
    reason: 'no_lock_overlap',
    overlap: { code: 'no_shared_game' },
  }, 'declined'), 'noise');
  assert.strictEqual(missTapeKind({
    reason: 'game_started',
    parlay: lock,
  }, 'declined'), 'matched_skip');
  assert.strictEqual(missTapeKind({ reason: 'unmatched' }, 'declined'), 'drop');
}

{
  assert.strictEqual(polySkipReason(quoteEval('q1'), 'quoted'), null);
  assert.strictEqual(
    polySkipReason(nearMissEval('n1'), 'declined'),
    'no_lock_overlap:same_games_no_match'
  );
  const oversized = decideAtFill({
    parlayStake: 100,
    parlayAmerican: 400,
    fillAmerican: 350,
    hedgeMode: '1x',
    maxContracts: 116,
    rfqContracts: 8000,
  });
  assert.strictEqual(
    polySkipReason({ reason: 'rfq_too_large', decision: oversized, parlay: lock }, 'declined'),
    'oversized'
  );
  assert.strictEqual(
    polySkipReason({ reason: 'game_started', parlay: lock }, 'declined'),
    'game_started'
  );
  assert.strictEqual(parlayForMiss(nearMissEval('n1')).id, lock.id);
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

  const miss = decidePolyMissWrite(nearMissEval('rfq_m'), 'declined');
  assert.strictEqual(miss.write, true);
  assert.strictEqual(miss.kind, 'near_miss');
  assert.strictEqual(miss.skipReason, 'no_lock_overlap:same_games_no_match');

  const noise = decidePolyMissWrite({
    reason: 'no_lock_overlap',
    overlap: { code: 'no_shared_game' },
    rfq: { rfqId: 'rfq_noise' },
  }, 'declined');
  assert.strictEqual(noise.write, false);
  assert.strictEqual(noise.kind, 'noise');
  assert.strictEqual(noise.aggregate, true);

  const seen = new Set([miss.key]);
  const again = decidePolyMissWrite(nearMissEval('rfq_m'), 'declined', { seen });
  assert.strictEqual(again.write, false);
  assert.strictEqual(again.reason, 'deduped');

  const capped = decidePolyMissWrite(nearMissEval('rfq_cap'), 'declined', {
    now: 5_000,
    nearMissWindowStart: 4_000,
    nearMissWindowCount: MAX_NEAR_MISS_PER_WINDOW,
  });
  assert.strictEqual(capped.write, false);
  assert.strictEqual(capped.reason, 'capped');
  assert.strictEqual(capped.aggregate, true);

  const nextWindow = decidePolyMissWrite(nearMissEval('rfq_next'), 'declined', {
    now: 8_000,
    nearMissWindowStart: 4_000,
    nearMissWindowCount: MAX_NEAR_MISS_PER_WINDOW,
  });
  assert.strictEqual(nextWindow.write, true);
}

{
  const rows = [];
  let t = 1_000;
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
    now: () => t,
    noiseWindowMs: 60_000,
  });

  assert.strictEqual(tape.persist(quoteEval('rfq_quote'), 'quoted', {
    quote_id: 'q1', is_live: true, contracts: 10,
  }).persisted, true);
  assert.strictEqual(tape.persist(quoteEval('rfq_quote'), 'quoted', {
    quote_id: 'q1', is_live: true, contracts: 10,
  }).persisted, false, 'quote deduped');

  assert.strictEqual(tape.persist(nearMissEval('rfq_miss'), 'declined').persisted, true);
  assert.strictEqual(tape.persist(nearMissEval('rfq_miss'), 'declined').persisted, false);
  assert.strictEqual(
    tape.persist(nearMissEval('rfq_miss', 'leg_count'), 'declined').persisted,
    true,
    'same rfq different reason is a new row'
  );

  const quoted = rows.find((r) => r.rfq_id === 'rfq_quote');
  assert.ok(quoted);
  assert.strictEqual(quoted.parlay_id, lock.id);
  assert.strictEqual(quoted.status, 'quoted');
  assert.strictEqual(quoted.quote_id, 'q1');
  assert.strictEqual(quoted.skip_reason, undefined);
  assert.strictEqual(quoted.venue, 'polymarket');

  const skipped = rows.find((r) => r.rfq_id === 'rfq_miss' && r.skip_reason === 'no_lock_overlap:same_games_no_match');
  assert.ok(skipped);
  assert.strictEqual(skipped.status, 'declined');
  assert.strictEqual(skipped.label, 'Arizona + Jacksonville');

  const beforeNoise = rows.length;
  for (let i = 0; i < 80; i++) {
    const out = tape.persist({
      action: 'skip',
      reason: 'no_lock_overlap',
      rfq: { rfqId: `rfq_tennis_${i}` },
      overlap: { code: 'no_shared_game' },
    }, 'declined', { locks: [lock] });
    assert.strictEqual(out.persisted, false);
    assert.strictEqual(out.reason, 'noise');
  }
  assert.strictEqual(rows.length, beforeNoise, 'noise RFQs must not insert per-row');
  const flushed = tape.flushNoise();
  assert.strictEqual(flushed.length, 1);
  assert.ok(flushed[0].skipReason.startsWith('no_lock_overlap:no_shared_game'));
  assert.ok(flushed[0].skipReason.includes('x80'));
  assert.strictEqual(rows.length, beforeNoise + 1);
  const agg = rows[rows.length - 1];
  assert.strictEqual(agg.status, 'declined');
  assert.strictEqual(agg.parlay_id, lock.id);
  assert.ok(String(agg.rfq_id).startsWith('poly-agg:no_shared_game:'));

  tape.flushNoise();
  assert.strictEqual(rows.length, beforeNoise + 1, 'second flush inside window is a no-op');

  t = 1_000 + 60_000;
  for (let i = 0; i < 3; i++) {
    tape.persist({
      action: 'skip',
      reason: 'no_lock_overlap',
      rfq: { rfqId: `rfq_tennis_later_${i}` },
      overlap: { code: 'no_shared_game' },
    }, 'declined', { locks: [lock] });
  }
  tape.flushNoise();
  assert.strictEqual(rows.length, beforeNoise + 2, 'one aggregate per lock per window');
}

{
  const rows = [];
  const tape = createPolyMissTape({
    logAsync: (p, rfq, d, status, extra) => {
      rows.push({ rfq_id: rfq.rfqId, skip_reason: extra && extra.skip_reason });
    },
    now: () => 10_000,
  });
  for (let i = 0; i < MAX_NEAR_MISS_PER_WINDOW + 8; i++) {
    tape.persist(nearMissEval(`rfq_burst_${i}`), 'declined');
  }
  assert.strictEqual(rows.length, MAX_NEAR_MISS_PER_WINDOW);
  const flushed = tape.flushNoise();
  assert.strictEqual(flushed.length, 1);
  assert.ok(flushed[0].skipReason.includes('x8'));
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
