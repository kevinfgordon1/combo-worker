// Thin-book guard (Kevin Oct 27). The $depth inverse-bet fair walks deep into thin Kalshi books
// and can land far below where the market actually trades (UNM: fair 13% while Kalshi traded
// 85c). Two checks, using only the sources already in hand (no extra calls per RFQ):
//  1. fair_below_mid: our-side top-of-book price ref (Kalshi first; else median of other venues).
//     ref_v = 1 - (best opposing top ask incl. fee) = our side's best bid net of fee, which is
//     <= the true mid, so this is a slightly looser test than a pure mid. Skip if
//     fair < ref - SNIPER_MAX_FAIR_BELOW_MID (default 0.05).
//  1b. book_overround: a venue whose own-side top ask + opposing top ask > SNIPER_MAX_OVERROUND
//     (default 1.10, e.g. both sides at 99c) is junk; if the best price comes from it -> skip.
//     A lone venue (no other venue quoting) with fair < SNIPER_LONE_MIN_FAIR (0.05) -> single_venue_thin.
//  2. single_venue_thin: best price is Kalshi, the walk slipped more than SNIPER_THIN_SLIP
//     (default 0.03) from Kalshi's top (book thin vs $depth), and no other venue
//     (Poly/Novig/ProphetX, depth or top) prices our side within SNIPER_SECOND_VENUE_TOL (0.05).
// SNIPER_MID_GUARD = enforce (default) | shadow (log only) | off.
'use strict';
const { probFromAmerican } = require('./rogue');

function num(v, d) { if (v == null || String(v).trim() === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; }
function midGuardConfig(env = process.env) {
  const mode = String(env.SNIPER_MID_GUARD || 'enforce').toLowerCase();
  return {
    mode: ['enforce', 'shadow', 'off'].includes(mode) ? mode : 'enforce',
    maxBelow: num(env.SNIPER_MAX_FAIR_BELOW_MID, 0.05),
    thinSlip: num(env.SNIPER_THIN_SLIP, 0.03),
    secondTol: num(env.SNIPER_SECOND_VENUE_TOL, 0.05),
    maxOverround: num(env.SNIPER_MAX_OVERROUND, 1.10),
    loneMinFair: num(env.SNIPER_LONE_MIN_FAIR, 0.05),
  };
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Per venue: our-side top-of-book prob (highest = best opposing top ask), and depth prob if any.
function venueTops(sources, venues) {
  const by = new Map();
  for (const s of sources || []) {
    if (!s || !venues.includes(s.venue) || s.reason === 'stale') continue;
    const c = probFromAmerican(s.topAmerican);
    const top = c != null && c > 0 && c < 1 ? 1 - c : null;
    const dep = s.used && s.reason === 'ok' && s.cost > 0 && s.cost < 1 ? 1 - s.cost : null;
    const cur = by.get(s.venue) || { venue: s.venue, top: null, depth: null };
    if (top != null && (cur.top == null || top > cur.top)) cur.top = top;
    if (dep != null && (cur.depth == null || dep > cur.depth)) cur.depth = dep;
    by.set(s.venue, cur);
  }
  return by;
}

// fair: chosen leg fair; bestVenue: venue it came from. -> { skip:null|reason, ref, refVenue, ev? }
function midGuard(fair, bestVenue, sources, venues, cfg, own) {
  if (!cfg || cfg.mode === 'off' || !(fair > 0 && fair < 1)) return { skip: null };
  const tops = venueTops(sources, venues);
  const k = tops.get('kalshi');
  let ref = null; let refVenue = null;
  if (k && k.top != null) { ref = k.top; refVenue = 'kalshi'; } else {
    const o = [...tops.values()].map((t) => t.top).filter((x) => x != null);
    if (o.length) { ref = median(o); refVenue = 'others'; }
  }
  const out = { skip: null, ref, refVenue };
  const t = tops.get(bestVenue);
  for (const o of own || []) {
    if (o.venue !== bestVenue || !t || t.top == null) continue;
    const ownAsk = probFromAmerican(o.topAmerican); const oppAsk = 1 - t.top;
    if (ownAsk != null && ownAsk + oppAsk > cfg.maxOverround + 1e-12) { out.skip = 'book_overround'; out.overround = ownAsk + oppAsk; }
  }
  const othersQuote = [...tops.values()].some((x) => x.venue !== bestVenue && (x.top != null || x.depth != null));
  if (!out.skip && !othersQuote && fair < cfg.loneMinFair) out.skip = 'single_venue_thin';
  if (out.skip) { out.ev = { kind: out.skip, fair, ref, refVenue, gapPp: ref != null ? ref - fair : null, venue: bestVenue, overround: out.overround }; return out; }
  if (ref != null && fair < ref - cfg.maxBelow - 1e-12) out.skip = 'fair_below_mid';
  else if (bestVenue === 'kalshi' && k && k.top != null && k.top - fair > cfg.thinSlip + 1e-12) {
    const second = [...tops.values()].filter((t) => t.venue !== 'kalshi').map((t) => (t.depth != null ? t.depth : t.top)).filter((x) => x != null);
    if (!second.some((p) => p <= fair + cfg.secondTol + 1e-12)) out.skip = 'single_venue_thin';
  }
  if (out.skip) out.ev = { kind: out.skip, fair, ref, refVenue, gapPp: ref != null ? ref - fair : null, venue: bestVenue };
  return out;
}

module.exports = { midGuardConfig, midGuard, venueTops };
