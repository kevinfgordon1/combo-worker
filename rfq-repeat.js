// Identical-RFQ fingerprint + in-memory cooldown for Combo Locks quotes.
// History fingerprint = sorted legs + contracts + target_cost (+ creator when
// present). Cooldown / skip rfq_repeat ONLY when creator_id is non-empty —
// Kalshi WS often omits it, and two real people requesting the same Ari+Jax
// 6-contract must both quote. Does not change matchParlay / exact-lock matching.
'use strict';
const { normalizeLegKey } = require('./rfq');

const DEFAULT_COOLDOWN_MS = 90_000;
const REPEAT_SKIP_REASON = 'rfq_repeat';
const MAX_ENTRIES = 256;

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

// Cooldown key is creator-primary. Empty/missing creator → null (always quote).
function cooldownFingerprint(rfq) {
  const creator = normalizedCreatorId(rfq);
  if (!creator) return null;
  return fingerprintRfq(rfq);
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

function readCooldownMs(env = process.env) {
  const raw = env && env.RFQ_REPEAT_COOLDOWN_MS;
  if (raw == null || raw === '') return DEFAULT_COOLDOWN_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_COOLDOWN_MS;
  return n;
}

function formatRepeatSkipAlert({ label, contracts, cooldownMs, skipCount } = {}) {
  const secs = Math.max(0, Math.round((cooldownMs || 0) / 1000));
  const n = contracts != null && contracts !== '' ? String(contracts) : '?';
  let text =
    `⏭️ RFQ REPEAT — ${label || '(unknown)'}\n` +
    `same ${n}-contract fingerprint · cooling ${secs}s\n` +
    `further identical RFQs skipped (Miss tape: ${REPEAT_SKIP_REASON})`;
  if (skipCount > 1) text += `\n×${skipCount} this window`;
  return text;
}

function createRepeatGuard({
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = () => Date.now(),
  maxEntries = MAX_ENTRIES,
} = {}) {
  const map = new Map();
  const nowMs = () => (typeof now === 'function' ? now() : now);

  function prune(t) {
    if (!(cooldownMs > 0)) {
      map.clear();
      return;
    }
    for (const [k, v] of map) {
      if (t - v.at >= cooldownMs) map.delete(k);
    }
    while (map.size > maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest == null) break;
      map.delete(oldest);
    }
  }

  function claim(fingerprint, at) {
    const t = at != null ? at : nowMs();
    if (!fingerprint || isAnonymousFingerprint(fingerprint) || !(cooldownMs > 0)) {
      return { skip: false, cooldownMs, gated: false };
    }
    const prev = map.get(fingerprint);
    if (prev && t - prev.at < cooldownMs) {
      prev.skipCount += 1;
      const alert = !prev.skipAlerted;
      prev.skipAlerted = true;
      return {
        skip: true,
        remainingMs: cooldownMs - (t - prev.at),
        skipCount: prev.skipCount,
        alert,
        cooldownMs,
        firstAt: prev.at,
        gated: true,
      };
    }
    map.set(fingerprint, { at: t, skipCount: 0, skipAlerted: false });
    prune(t);
    return { skip: false, first: true, cooldownMs, gated: true };
  }

  return {
    claim,
    get size() { return map.size; },
    cooldownMs,
  };
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  REPEAT_SKIP_REASON,
  MAX_ENTRIES,
  compactNum,
  normalizedCreatorId,
  fingerprintRfq,
  cooldownFingerprint,
  isAnonymousFingerprint,
  creatorIdFromQuoteResponse,
  readCooldownMs,
  formatRepeatSkipAlert,
  createRepeatGuard,
};
