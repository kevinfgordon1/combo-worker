// Identical-RFQ fingerprint for Combo Locks History grouping.
// Fingerprint = sorted legs + contracts + target_cost (+ creator when present).
// The repeat-request cooldown (8 quotes then 300s dark per creator) was REMOVED
// (Kevin Nov 4 2026): Combo Locks' only limits are the user's contract cap and
// the cash in their prediction-market account. Fingerprints are still written
// to combo_submissions.rfq_fingerprint; nothing here skips a quote.
// REPEAT_SKIP_REASON stays so old rfq_repeat Miss-tape rows still classify.
'use strict';
const { normalizeLegKey } = require('./rfq');

const REPEAT_SKIP_REASON = 'rfq_repeat';

function compactNum(n) {
  if (n == null || n === '') return '';
  const x = typeof n === 'string' ? parseFloat(n) : Number(n);
  if (!Number.isFinite(x)) return '';
  return Math.abs(x - Math.round(x)) < 1e-9 ? String(Math.round(x)) : String(x);
}

function normalizedCreatorId(rfq) {
  if (!rfq || typeof rfq !== 'object') return '';
  const raw = rfq.creatorId != null && rfq.creatorId !== ''
    ? rfq.creatorId
    : rfq.creator_id;
  if (raw == null || raw === '') return '';
  const s = String(raw).trim();
  return s;
}

function fingerprintRfq(rfq) {
  if (!rfq) return null;
  const legs = (rfq.legKeys || []).map(normalizeLegKey).filter(Boolean).sort();
  if (!legs.length) return null;
  const contracts = compactNum(rfq.contracts);
  const target = compactNum(rfq.targetCostDollars);
  const creator = normalizedCreatorId(rfq);
  return `v1|${legs.join(',')}|c=${contracts}|t=${target}|u=${creator}`;
}

function isAnonymousFingerprint(fingerprint) {
  return !fingerprint || /\|u=$/.test(String(fingerprint));
}

function creatorIdFromQuoteResponse(result) {
  if (!result || typeof result !== 'object') return null;
  const quote = result.quote && typeof result.quote === 'object' ? result.quote : null;
  const nested = result.rfq && typeof result.rfq === 'object' ? result.rfq : null;
  const raw = result.rfq_creator_id
    ?? result.creator_id
    ?? result.creatorId
    ?? (quote && (quote.rfq_creator_id ?? quote.creator_id ?? quote.creatorId))
    ?? (nested && (nested.rfq_creator_id ?? nested.creator_id ?? nested.creatorId));
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  return s || null;
}

module.exports = {
  REPEAT_SKIP_REASON,
  compactNum,
  normalizedCreatorId,
  fingerprintRfq,
  isAnonymousFingerprint,
  creatorIdFromQuoteResponse,
};
