// Rogue-line guard for the sniper's per-leg inverse-bet fair (Kevin, Oct 23).
//
// WHY ONE-SIDED. The sniper always SELLS the parlay's Yes (we hold No) and each leg's fair is
// the BEST (highest) our-side probability across venues: p = 1 − cheapest opposite cost at depth.
// So a venue that is rogue HIGH (too-cheap opposite) can only make us quote higher — we lose
// fills, never money. Dropping it would LOWER our fair and quote more aggressively, which is the
// wrong way round if that venue was simply first to move on news. The dangerous case is the
// chosen fair being rogue LOW: the winning venue (often the only venue with depth) prices the leg
// well below where the other venues' markets sit, so we'd sell too cheap. That is what we block.
//
// Per leg, using every FRESH source (depth-qualified or not):
//   pBest  = chosen fair (best depth-qualified venue, unchanged method)
//   ref    = median over the OTHER venues of each venue's best indication
//            (its depth fair if it qualifies, else 1 − its top-of-book opposite price)
//   gap    = ref − pBest  (positive = our fair is below the market)
//   rogue  if gap ≥ maxDev (pp)  OR  (logit(ref) − logit(pBest) ≥ maxLogit AND gap ≥ minDev)
// pp alone misses longshots (3% vs 6% is +3233 vs +1567 but only 3pp); logit alone over-fires
// near 50% and on tiny 1–2 cent ticks — the floor keeps it to real gaps.
//   • rogue low  → leg has no fair → RFQ skipped (reason rogue_fair_low), logged with detail.
//   • rogue high (a depth venue ≥ threshold ABOVE the others) → logged only. Optional
//     SNIPER_ROGUE_DROP_HIGH=1 drops it (re-picks best among the rest) — off by default, see above.
//   • no other venue has a fresh price → no reference → unchanged behaviour (logged 'no_ref').
// SNIPER_ROGUE_MODE: enforce (default) | shadow (compute + log, never change the fair) | off.
'use strict';

const clampP = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logit = (p) => { const q = clampP(p); return Math.log(q / (1 - q)); };
const probFromAmerican = (a) => { const n = Number(a); if (!Number.isFinite(n) || n === 0) return null; return n > 0 ? 100 / (n + 100) : -n / (-n + 100); };
const americanOf = (p) => (p > 0 && p < 1 ? (p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p)) : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function num(v, d) { if (v == null || String(v).trim() === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; }
function rogueConfig(env = process.env) {
  const mode = String(env.SNIPER_ROGUE_MODE || 'enforce').toLowerCase();
  return {
    mode: ['enforce', 'shadow', 'off'].includes(mode) ? mode : 'enforce',
    maxDev: num(env.SNIPER_ROGUE_MAX_DEV, 0.04),     // 4 percentage points
    maxLogit: num(env.SNIPER_ROGUE_MAX_LOGIT, 0.30), // ≈ 7.4pp at 50%, 2.6pp at 10%, 0.9pp at 3%
    minDev: num(env.SNIPER_ROGUE_MIN_DEV, 0.015),    // floor for the logit test (ignore tick noise)
    dropHigh: String(env.SNIPER_ROGUE_DROP_HIGH || '0') === '1',
  };
}

function deviates(a, b, cfg) { // is b above a by a rogue amount?
  const gap = b - a;
  if (!(gap > 0)) return false;
  return gap >= cfg.maxDev - 1e-12 || (logit(b) - logit(a) >= cfg.maxLogit && gap >= cfg.minDev - 1e-12);
}

// Each venue's indication: { venue, p, depth:boolean, src }
function venueIndications(sources, venues) {
  const by = new Map();
  for (const s of sources || []) {
    if (!s || !venues.includes(s.venue) || s.reason === 'stale') continue;
    let p = null; let depth = false;
    if (s.used && s.reason === 'ok' && s.cost > 0 && s.cost < 1) { p = 1 - s.cost; depth = true; } else {
      const top = probFromAmerican(s.topAmerican);
      if (top != null) p = 1 - top;
    }
    if (!(p > 0 && p < 1)) continue;
    const cur = by.get(s.venue);
    // depth beats top-only; within a class keep the highest (most conservative for us).
    if (!cur || (depth && !cur.depth) || (depth === cur.depth && p > cur.p)) by.set(s.venue, { venue: s.venue, p, depth, src: s });
  }
  return [...by.values()];
}

// -> { pBest, best (source) | null, events:[...], skip:null|'rogue_fair_low' }
function rogueGuard(sources, venues, cfg, pickBest) {
  let best = pickBest(sources, venues);
  const events = [];
  if (!best || cfg.mode === 'off') return { best, events, skip: null };
  let inds = venueIndications(sources, venues);
  const depthInds = inds.filter((i) => i.depth);
  // High outliers among depth venues (vs median of the other venues' indications).
  for (const d of depthInds) {
    const others = inds.filter((i) => i.venue !== d.venue).map((i) => i.p);
    const ref = median(others);
    if (ref != null && deviates(ref, d.p, cfg)) events.push({ kind: 'rogue_high', venue: d.venue, p: d.p, ref, devPp: d.p - ref, nOthers: others.length });
  }
  if (cfg.dropHigh && cfg.mode === 'enforce' && events.length) {
    const drop = new Set(events.map((e) => e.venue));
    const rest = pickBest(sources.filter((s) => !drop.has(s.venue)), venues);
    if (rest) { for (const e of events) e.dropped = true; best = rest; inds = inds.filter((i) => !drop.has(i.venue)); }
  }
  const pBest = 1 - best.cost;
  const others = inds.filter((i) => i.venue !== best.venue).map((i) => i.p);
  const ref = median(others);
  if (ref == null) { events.push({ kind: 'no_ref', venue: best.venue, p: pBest }); return { best, events, skip: null }; }
  if (deviates(pBest, ref, cfg)) {
    events.push({ kind: 'rogue_low', venue: best.venue, p: pBest, ref, devPp: pBest - ref, nOthers: others.length, others: inds.filter((i) => i.venue !== best.venue).map((i) => `${i.venue}${i.depth ? '' : '(top)'}:${americanOf(i.p)}`) });
    if (cfg.mode === 'enforce') return { best: null, events, skip: 'rogue_fair_low' };
  }
  return { best, events, skip: null };
}

module.exports = { rogueConfig, rogueGuard, venueIndications, deviates, logit, probFromAmerican, americanOf, median };
