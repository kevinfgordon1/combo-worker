// Combo Locks Miss tape for Polymarket reconcile → combo_submissions.
//
// Same persist rule as Kalshi: only after a real lock match.
//   - quotes / shadow / unfilled: insert once (rfq+lock+status)
//   - matched-lock declines: oversized, limit_reached, game_started,
//     insufficient_balance, and other post-match skips
//   - no_lock_overlap* (leg_count, no_shared_game, missing_team,
//     same_games_no_match, …): engine still SKIPs; do not insert.
//     Hourly aggregates of those codes are also not written.
// Does not change quote matching. UNHEDGED_RFQ_LIVE stays off (different table).
'use strict';

const { classifySkip, skipPersistExtra } = require('./skip-tape');

// Overlap codes used by reconcile SKIP logs / histogram — not Miss-tape rows.
const NEAR_MISS_CODES = Object.freeze([
  'leg_count',
  'missing_team',
  'same_games_no_match',
  'doubleheader',
]);

const NOISE_CODES = Object.freeze(['no_shared_game', 'no_rfq_tokens']);
const QUOTE_STATUSES = new Set(['quoted', 'shadow', 'unfilled']);
const DEDUPE_MAX = 512;

function isNearMissCode(code) {
  return NEAR_MISS_CODES.includes(code);
}

function isNoiseCode(code) {
  return NOISE_CODES.includes(code);
}

function overlapCodeOf(evaluation) {
  return evaluation && evaluation.overlap && evaluation.overlap.code
    ? evaluation.overlap.code
    : null;
}

function isOverlapSkipReason(reason) {
  if (!reason) return false;
  return reason === 'no_lock_overlap' || String(reason).startsWith('no_lock_overlap:');
}

function polySkipReason(evaluation, status) {
  if (QUOTE_STATUSES.has(status)) return null;
  if (evaluation && evaluation.decision) {
    const classified = classifySkip(evaluation.decision);
    if (classified) return classified;
  }
  if (evaluation && evaluation.reason === 'no_lock_overlap') {
    const code = overlapCodeOf(evaluation);
    return code ? `no_lock_overlap:${code}` : 'no_lock_overlap';
  }
  return (evaluation && evaluation.reason) || null;
}

function missTapeKind(evaluation, status) {
  if (QUOTE_STATUSES.has(status)) return 'quote';
  if (evaluation && evaluation.reason === 'no_lock_overlap') return 'overlap_skip';
  if (evaluation && evaluation.parlay) return 'matched_skip';
  return 'drop';
}

function parlayForMiss(evaluation) {
  if (evaluation && evaluation.parlay && evaluation.parlay.id) return evaluation.parlay;
  const overlap = evaluation && evaluation.overlap;
  if (overlap && overlap.parlay && overlap.parlay.id) return overlap.parlay;
  return null;
}

function dedupeKey({ parlayId, rfqId, status, skipReason }) {
  return `${parlayId || ''}|${rfqId || ''}|${status || ''}|${skipReason || ''}`;
}

function createLruSet(max = DEDUPE_MAX) {
  const map = new Map();
  return {
    has(key) { return map.has(key); },
    add(key) {
      if (!key) return;
      if (map.has(key)) map.delete(key);
      map.set(key, 1);
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest == null) break;
        map.delete(oldest);
      }
    },
    get size() { return map.size; },
  };
}

function decidePolyMissWrite(evaluation, status, state = {}, extra = {}) {
  const kind = missTapeKind(evaluation, status);
  if (kind === 'drop') {
    return { write: false, kind, reason: 'no_parlay' };
  }
  if (kind === 'overlap_skip') {
    return { write: false, kind, reason: 'overlap_skip' };
  }
  const skipReason = extra.skip_reason != null
    ? extra.skip_reason
    : polySkipReason(evaluation, status);
  if (isOverlapSkipReason(skipReason)) {
    return { write: false, kind: 'overlap_skip', reason: 'overlap_skip' };
  }
  const parlay = parlayForMiss(evaluation);
  if (!parlay || !parlay.id) {
    return { write: false, kind, reason: 'no_parlay' };
  }
  const rfq = (evaluation && evaluation.rfq) || {};
  const rfqId = extra.rfqId || rfq.rfqId || rfq.id || null;
  const key = dedupeKey({ parlayId: parlay.id, rfqId, status, skipReason });
  if (state.seen && state.seen.has(key)) {
    return { write: false, kind, reason: 'deduped', key, parlay };
  }
  return { write: true, kind, key, parlay, rfqId, skipReason, status };
}

function createPolyMissTape({
  logAsync,
} = {}) {
  const seen = createLruSet();

  function persist(evaluation, status, extra = {}) {
    if (typeof logAsync !== 'function') {
      return { persisted: false, reason: 'no_logger' };
    }
    const decision = decidePolyMissWrite(evaluation, status, { seen }, extra);

    if (!decision.write) {
      return { persisted: false, kind: decision.kind, reason: decision.reason };
    }

    const rfq = (evaluation && evaluation.rfq) || {};
    const rfqId = extra.rfqId || rfq.rfqId || rfq.id;
    const contracts =
      extra.contracts != null ? extra.contracts
        : evaluation && evaluation.decision && evaluation.decision.contracts != null
          ? evaluation.decision.contracts
          : evaluation && evaluation.quote && evaluation.quote.estimatedContracts;
    const persistExtra = {
      ...skipPersistExtra({
        skipReason: decision.skipReason,
        contracts,
        remaining: evaluation && evaluation.decision ? evaluation.decision.remaining : null,
      }),
      ...extra,
    };
    delete persistExtra.locks;
    delete persistExtra.rfqId;

    seen.add(decision.key);
    logAsync(
      decision.parlay,
      { rfqId, contracts },
      evaluation && evaluation.decision,
      status,
      persistExtra
    );
    return {
      persisted: true,
      kind: decision.kind,
      key: decision.key,
      skipReason: decision.skipReason,
    };
  }

  // Kept so reconcile can still call it; overlap noise is never taped.
  function flushNoise() {
    return [];
  }

  return { persist, flushNoise, seen };
}

module.exports = {
  NEAR_MISS_CODES,
  NOISE_CODES,
  DEDUPE_MAX,
  isNearMissCode,
  isNoiseCode,
  isOverlapSkipReason,
  polySkipReason,
  missTapeKind,
  parlayForMiss,
  dedupeKey,
  decidePolyMissWrite,
  createPolyMissTape,
};
