// Identical-RFQ fingerprint + live-outstanding skip for Combo Locks quotes.
// History fingerprint = sorted legs + contracts + target_cost (+ creator when
// present). Skip rfq_repeat ONLY when creator_id is non-empty AND we already
// have a live unaccepted quote for that fingerprint. When that quote is
// released (RFQ dies / replaced / cancel / TTL / fill / POST fail) the next
// identical RFQ may quote immediately. Optional RFQ_REPEAT_COOLDOWN_MS is a
// tiny post-release anti-spam (≤10s; default 0). Legacy 90s values are
// ignored so production does not stay dark. Anonymous / missing creator_id
// always quotes — Kalshi WS often omits it, and two real people requesting
// the same Ari+Jax 6-contract must both quote. Does not change matchParlay
// / exact-lock matching.
'use strict';
const { normalizeLegKey } = require('./rfq');
const { formatAlertStatus } = require('./venue-alert');

const DEFAULT_COOLDOWN_MS = 0;
const MAX_ANTISPAM_MS = 10_000;
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

// Repeat key is creator-primary. Empty/missing creator → null (always quote).
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
  // Old default was 90s. Values above the anti-spam cap are ignored so an
  // existing Railway env of 90000 cannot keep Combo Locks dark after a quote.
  if (n > MAX_ANTISPAM_MS) return DEFAULT_COOLDOWN_MS;
  return n;
}

function formatRepeatSkipAlert({ label, contracts, cooldownMs, skipCount, venue = 'kalshi' } = {}) {
  const n = contracts != null && contracts !== '' ? String(contracts) : '?';
  const cooling = cooldownMs > 0
    ? ` · cooling ${Math.max(0, Math.round(cooldownMs / 1000))}s after release`
    : '';
  let text =
    `${formatAlertStatus('⏭️ RFQ REPEAT', venue)} — ${label || '(unknown)'}\n` +
    `same ${n}-contract fingerprint · live quote already out${cooling}\n` +
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

  function gated(fingerprint) {
    return !!(fingerprint && !isAnonymousFingerprint(fingerprint));
  }

  function prune(t) {
    for (const [k, v] of map) {
      if (v.outstanding) continue;
      if (!(cooldownMs > 0) || v.releasedAt == null || t - v.releasedAt >= cooldownMs) {
        map.delete(k);
      }
    }
    while (map.size > maxEntries) {
      let drop = null;
      for (const [k, v] of map) {
        if (!v.outstanding) {
          drop = k;
          break;
        }
      }
      if (drop == null) drop = map.keys().next().value;
      if (drop == null) break;
      map.delete(drop);
    }
  }

  function liveSkip(prev, t) {
    if (prev && prev.outstanding) {
      return {
        skip: true,
        remainingMs: 0,
        skipCount: prev.skipCount,
        skipAlerted: prev.skipAlerted,
        cooldownMs,
        firstAt: prev.at,
        gated: true,
        live: true,
      };
    }
    if (prev && cooldownMs > 0 && prev.releasedAt != null && t - prev.releasedAt < cooldownMs) {
      return {
        skip: true,
        remainingMs: cooldownMs - (t - prev.releasedAt),
        skipCount: prev.skipCount,
        skipAlerted: prev.skipAlerted,
        cooldownMs,
        firstAt: prev.at,
        gated: true,
        live: false,
      };
    }
    return null;
  }

  function peek(fingerprint, at) {
    const t = at != null ? at : nowMs();
    if (!gated(fingerprint)) {
      return { skip: false, cooldownMs, gated: false, live: false };
    }
    const blocked = liveSkip(map.get(fingerprint), t);
    if (blocked) return blocked;
    return { skip: false, cooldownMs, gated: true, live: false };
  }

  function noteSkip(fingerprint, at) {
    const seen = peek(fingerprint, at);
    if (!seen.skip) return seen;
    const prev = map.get(fingerprint);
    prev.skipCount += 1;
    const alert = !prev.skipAlerted;
    prev.skipAlerted = true;
    return {
      ...seen,
      skipCount: prev.skipCount,
      alert,
      gated: true,
    };
  }

  // Occupy the fingerprint for a live (or in-flight) quote. Call release
  // when that quote dies, is cancelled/TTL'd, fills, or POST fails — do not
  // leave a timer running. Claiming before send is safe because a 409
  // rfq_closed must release(); the next live auction can still quote.
  function claim(fingerprint, at) {
    const t = at != null ? at : nowMs();
    if (!gated(fingerprint)) {
      return { skip: false, cooldownMs, gated: false, live: false };
    }
    const blocked = liveSkip(map.get(fingerprint), t);
    if (blocked) {
      const prev = map.get(fingerprint);
      prev.skipCount += 1;
      const alert = !prev.skipAlerted;
      prev.skipAlerted = true;
      return {
        ...blocked,
        skipCount: prev.skipCount,
        alert,
        gated: true,
      };
    }
    map.set(fingerprint, {
      at: t,
      outstanding: true,
      releasedAt: null,
      skipCount: 0,
      skipAlerted: false,
    });
    prune(t);
    return { skip: false, first: true, cooldownMs, gated: true, live: true };
  }

  function release(fingerprint, at) {
    const t = at != null ? at : nowMs();
    if (!gated(fingerprint)) return { released: false, gated: false };
    const prev = map.get(fingerprint);
    if (!prev || !prev.outstanding) return { released: false, gated: true };
    if (cooldownMs > 0) {
      prev.outstanding = false;
      prev.releasedAt = t;
      prev.skipCount = 0;
      prev.skipAlerted = false;
      prune(t);
    } else {
      map.delete(fingerprint);
    }
    return { released: true, gated: true };
  }

  return {
    peek,
    noteSkip,
    claim,
    release,
    get size() { return map.size; },
    cooldownMs,
  };
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  MAX_ANTISPAM_MS,
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
