// Combo Locks Miss tape for Polymarket reconcile → combo_submissions.
//
// Kalshi only inserts when an RFQ matches a lock (quoted / declined / oversized).
// Poly reconcile polls ~100 open RFQs every 3s; most are no_shared_game noise
// that must not flood Postgres. Discipline:
//   - quotes + matched-lock skips: always insert once (rfq+lock+status+reason)
//   - near-miss overlap (same_games_no_match / leg_count / …): same, once
//   - pure noise (no_shared_game): at most one aggregate row per lock per hour
//   - hard cap on new near-miss inserts per 3s window (overflow → aggregate)
// Does not change quote matching. UNHEDGED_RFQ_LIVE stays off (different table).
'use strict';

const { classifySkip, skipPersistExtra } = require('./skip-tape');

const NEAR_MISS_CODES = Object.freeze([
  'leg_count',
  'missing_team',
  'same_games_no_match',
  'doubleheader',
]);

const NOISE_CODES = Object.freeze(['no_shared_game', 'no_rfq_tokens']);
const QUOTE_STATUSES = new Set(['quoted', 'shadow', 'unfilled']);
const DEDUPE_MAX = 512;
const NOISE_WINDOW_MS = 60 * 60 * 1000;
const MAX_NEAR_MISS_PER_WINDOW = 16;
const NEAR_MISS_WINDOW_MS = 3000;

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
  if (evaluation && evaluation.reason === 'no_lock_overlap') {
    const code = overlapCodeOf(evaluation);
    if (isNearMissCode(code)) return 'near_miss';
    return 'noise';
  }
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
  const now = state.now != null ? state.now : Date.now();
  const kind = missTapeKind(evaluation, status);
  if (kind === 'drop') {
    return { write: false, kind, reason: 'no_parlay' };
  }
  if (kind === 'noise') {
    return { write: false, kind, reason: 'noise', aggregate: true };
  }
  const parlay = parlayForMiss(evaluation);
  if (!parlay || !parlay.id) {
    return { write: false, kind, reason: 'no_parlay' };
  }
  const rfq = (evaluation && evaluation.rfq) || {};
  const rfqId = extra.rfqId || rfq.rfqId || rfq.id || null;
  const skipReason = extra.skip_reason != null
    ? extra.skip_reason
    : polySkipReason(evaluation, status);
  const key = dedupeKey({ parlayId: parlay.id, rfqId, status, skipReason });
  if (state.seen && state.seen.has(key)) {
    return { write: false, kind, reason: 'deduped', key, parlay };
  }
  if (kind === 'near_miss') {
    const windowStart = state.nearMissWindowStart || 0;
    const windowCount = state.nearMissWindowCount || 0;
    if (now - windowStart < NEAR_MISS_WINDOW_MS && windowCount >= MAX_NEAR_MISS_PER_WINDOW) {
      return { write: false, kind, reason: 'capped', key, parlay, aggregate: true };
    }
  }
  return { write: true, kind, key, parlay, rfqId, skipReason, status };
}

function createPolyMissTape({
  logAsync,
  now: nowFn,
  noiseWindowMs = NOISE_WINDOW_MS,
} = {}) {
  const seen = createLruSet();
  const noise = new Map();
  let nearMissWindowStart = 0;
  let nearMissWindowCount = 0;

  function now() {
    return typeof nowFn === 'function' ? nowFn() : Date.now();
  }

  function noteNoise(parlay, code) {
    if (!parlay || !parlay.id) return;
    let rec = noise.get(parlay.id);
    if (!rec) {
      rec = { parlay, code: code || 'no_shared_game', count: 0, lastFlush: 0 };
      noise.set(parlay.id, rec);
    }
    rec.parlay = parlay;
    rec.code = code || rec.code || 'no_shared_game';
    rec.count += 1;
  }

  function persist(evaluation, status, extra = {}) {
    if (typeof logAsync !== 'function') {
      return { persisted: false, reason: 'no_logger' };
    }
    const t = now();
    const code = overlapCodeOf(evaluation);
    const kind = missTapeKind(evaluation, status);

    if (kind === 'near_miss' && t - nearMissWindowStart >= NEAR_MISS_WINDOW_MS) {
      nearMissWindowStart = t;
      nearMissWindowCount = 0;
    }

    if (kind === 'noise') {
      const locks = extra.locks || [];
      if (evaluation && evaluation.parlay) noteNoise(evaluation.parlay, code);
      else {
        for (const p of locks) noteNoise(p, code);
      }
      return { persisted: false, kind, reason: 'noise' };
    }

    const decision = decidePolyMissWrite(evaluation, status, {
      now: t,
      seen,
      nearMissWindowStart,
      nearMissWindowCount,
    }, extra);

    if (!decision.write) {
      if (decision.aggregate && decision.parlay) noteNoise(decision.parlay, code);
      return { persisted: false, kind: decision.kind, reason: decision.reason };
    }

    if (decision.kind === 'near_miss') nearMissWindowCount += 1;

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

  function flushNoise() {
    if (typeof logAsync !== 'function') return [];
    const t = now();
    const flushed = [];
    for (const rec of noise.values()) {
      if (rec.count <= 0) continue;
      if (rec.lastFlush && t - rec.lastFlush < noiseWindowMs) continue;
      const skipReason = rec.count === 1
        ? `no_lock_overlap:${rec.code}`
        : `no_lock_overlap:${rec.code} x${rec.count}`;
      const rfqId = `poly-agg:${rec.code}:${rec.parlay.id}:${Math.floor(t / noiseWindowMs)}`;
      const key = dedupeKey({
        parlayId: rec.parlay.id,
        rfqId,
        status: 'declined',
        skipReason,
      });
      rec.count = 0;
      rec.lastFlush = t;
      if (seen.has(key)) continue;
      seen.add(key);
      logAsync(rec.parlay, { rfqId }, null, 'declined', { skip_reason: skipReason });
      flushed.push({ parlayId: rec.parlay.id, skipReason, rfqId });
    }
    return flushed;
  }

  return { persist, flushNoise, noteNoise, seen, noise };
}

module.exports = {
  NEAR_MISS_CODES,
  NOISE_CODES,
  DEDUPE_MAX,
  NOISE_WINDOW_MS,
  MAX_NEAR_MISS_PER_WINDOW,
  NEAR_MISS_WINDOW_MS,
  isNearMissCode,
  isNoiseCode,
  polySkipReason,
  missTapeKind,
  parlayForMiss,
  dedupeKey,
  decidePolyMissWrite,
  createPolyMissTape,
};
