'use strict';
// ─────────────────────────────────────────────────────────────────────────
// partial-quote.js — oversized-RFQ "partial quote" gate + DRY-RUN counter.
//
// An RFQ is "oversized" when its size exceeds the lock's remaining cap
// (engine.decideAtFill → rfq_too_large). The idea: quote only up to the
// remaining cap at the same target price.
//
// VENUE SEMANTICS (checked against the docs):
//  • Kalshi RFQ quotes carry NO size field (CreateQuote = rfq_id, yes_bid,
//    no_bid, rest_remainder, post_only). A quote is implicitly for the FULL
//    RFQ size; only the requester may accept fewer contracts. A maker cannot
//    quote fewer contracts than the RFQ ⇒ real partial quoting is NOT possible.
//  • Polymarket US CreateQuote has no size field either (rfqId, buyPrice,
//    sellPrice, restRemainder, postOnly); the service derives the quote size
//    from the RFQ (qtyDecimal, or cashOrderQty / price). Partial sizing is
//    undocumented/unverified there.
//
// So this module NEVER changes what is sent to a venue. It (1) measures how
// many oversized RFQs a partial-quote mode WOULD have quoted (always, so the
// numbers exist before anyone turns anything on), (2) exposes the env flag
// COMBO_PARTIAL_QUOTE_OVERSIZED (default OFF) and, per venue, whether the flag
// may ever change behaviour. With every venue capability false, ON == OFF for
// order flow; ON only changes the log label from "dry-run" to "flag-on (no-op)".
// ─────────────────────────────────────────────────────────────────────────

const FLAG = 'COMBO_PARTIAL_QUOTE_OVERSIZED';

// Venue capability: can a maker quote FEWER contracts than the RFQ?
const VENUE_ALLOWS_PARTIAL_QUOTE = Object.freeze({
  kalshi: false,
  polymarket: false,
});

function isPartialQuoteFlagOn(env = process.env) {
  const v = String((env && env[FLAG]) || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

// Would a partial quote actually be sent for this venue? (flag AND venue support)
function partialQuoteActive(venue, env = process.env) {
  return isPartialQuoteFlagOn(env) && VENUE_ALLOWS_PARTIAL_QUOTE[String(venue || '').toLowerCase()] === true;
}

function hourKey(ms) {
  return new Date(ms).toISOString().slice(0, 13); // 2026-10-01T02 (UTC)
}

function createPartialQuoteDryRun({ now = () => Date.now(), env = process.env, keepHours = 24 } = {}) {
  const buckets = new Map(); // hour -> { would_quote, clip_contracts, rfq_contracts, venues:{}, parlays:Set }
  let lastEmitted = null;

  function bucketFor(ms) {
    const k = hourKey(ms);
    let b = buckets.get(k);
    if (!b) {
      b = { hour: k, would_quote: 0, clip_contracts: 0, rfq_contracts: 0, venues: {}, parlays: new Set() };
      buckets.set(k, b);
      while (buckets.size > keepHours + 1) buckets.delete(buckets.keys().next().value);
    }
    return b;
  }

  // Returns the would-quote clip size (contracts) or 0 when not eligible.
  // Eligible: oversized (rfq > remaining) with remaining > 0.
  function note({ venue = 'kalshi', parlayId = null, rfqContracts, remaining } = {}) {
    const rfq = Number(rfqContracts);
    const rem = Number(remaining);
    if (!(rem > 0) || !(rfq > rem)) return 0;
    const b = bucketFor(now());
    b.would_quote += 1;
    b.clip_contracts += rem;
    b.rfq_contracts += rfq;
    b.venues[venue] = (b.venues[venue] || 0) + 1;
    if (parlayId) b.parlays.add(parlayId);
    return rem;
  }

  function snapshot(hour = hourKey(now())) {
    const b = buckets.get(hour);
    if (!b) return { hour, would_quote: 0, clip_contracts: 0, rfq_contracts: 0, venues: {}, parlays: 0 };
    return { ...b, venues: { ...b.venues }, parlays: b.parlays.size };
  }

  function last24h() {
    const cutoff = now() - 24 * 3600 * 1000;
    let n = 0;
    let c = 0;
    for (const b of buckets.values()) {
      if (Date.parse(`${b.hour}:00:00Z`) + 3600 * 1000 <= cutoff) continue;
      n += b.would_quote;
      c += b.clip_contracts;
    }
    return { would_quote: n, clip_contracts: c };
  }

  function mode() {
    return isPartialQuoteFlagOn(env) ? 'flag-on-noop' : 'dry-run';
  }

  function formatLine(s) {
    const tot = last24h();
    return (
      `[LIVE] partial-quote ${mode()} hour=${s.hour}Z would_quote=${s.would_quote} ` +
      `clip_contracts=${s.clip_contracts} rfq_contracts=${s.rfq_contracts} ` +
      `locks=${s.parlays} venues=${Object.entries(s.venues).map(([k, n]) => `${k}:${n}`).join(',') || '-'} ` +
      `rolling_24h_would_quote=${tot.would_quote} rolling_24h_clip_contracts=${tot.clip_contracts} ` +
      `active=false (kalshi/polymarket cannot quote fewer contracts than the RFQ)`
    );
  }

  // Call periodically (every minute). Emits one line when an hour completes.
  function tick(log = console.log) {
    const cur = hourKey(now());
    if (lastEmitted == null) { lastEmitted = cur; return null; }
    if (cur === lastEmitted) return null;
    const done = snapshot(lastEmitted);
    lastEmitted = cur;
    log(formatLine(done));
    return done;
  }

  // jsonb for combo_worker_stats.partial_quote (current hour, cumulative).
  function statsJson() {
    const s = snapshot();
    return {
      hour: s.hour,
      mode: mode(),
      would_quote: s.would_quote,
      clip_contracts: s.clip_contracts,
      rfq_contracts: s.rfq_contracts,
      locks: s.parlays,
      venues: s.venues,
    };
  }

  return { note, snapshot, last24h, tick, formatLine, statsJson, mode };
}

module.exports = {
  FLAG,
  VENUE_ALLOWS_PARTIAL_QUOTE,
  isPartialQuoteFlagOn,
  partialQuoteActive,
  createPartialQuoteDryRun,
  hourKey,
};
