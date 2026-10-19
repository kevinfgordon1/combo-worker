// Leg pricing for ProphetX strikes — the inverse bet method, unchanged:
//   leg fair = sign-flip of the opponent's best $500-depth price across venues.
// Depth books come from aibetbuilder's lib/book-depth.js (vendored verbatim):
// public, keyless Kalshi / Polymarket / Novig ladders, fee-included. Each
// venue's ladder is walked to $500 profit with blendAskLadderToPayout (the
// Promo blend, vendored verbatim). A venue whose ladder cannot fund $500 is
// ignored. ProphetX production depth needs a production key, which this
// sandbox process must never hold, so ProphetX is not a source here.
'use strict';
const { resolveLegsDepth } = require('./vendor/book-depth');
const { blendAskLadderToPayout, TARGET_PAYOUT_USD } = require('./vendor/blendAskLadder.cjs');
const { ourTrueFromOpponents } = require('../unhedged-quote');
const { STALE_MS } = require('./quote');

const VENUES = ['kalshi', 'polymarket', 'novig'];

// Pure: per-venue ladders → best complete $500 blend → our fair prob.
function fairFromLadders(byVenue, { target = TARGET_PAYOUT_USD } = {}) {
  let best = null;
  const venues = {};
  for (const [venue, levels] of Object.entries(byVenue || {})) {
    const b = levels && levels.length ? blendAskLadderToPayout(levels, { targetPayout: target }) : null;
    venues[venue] = b && b.complete ? b.american : null;
    if (b && b.complete && (best == null || b.american > best.american)) best = { venue, american: b.american };
  }
  if (!best) return { p: null, venues, best: null };
  const p = ourTrueFromOpponents([{ american: best.american }]);
  return { p, venues, best };
}

function createPricer({ resolve = resolveLegsDepth, venues = VENUES, staleMs = STALE_MS, now = Date.now, logger = console } = {}) {
  const cache = new Map(); // strikeId → { p, at, best, venues }
  const inflight = new Map();

  async function fetchLeg(info) {
    const mk = (v, game) => ({
      bestOppBook: v, market: info.kind || 'ML', bestOppName: info.oppLabel || info.opp, game, sport: info.sport,
      commence_time: info.startMs ? new Date(info.startMs).toISOString() : null,
    });
    const t0 = now();
    const res = await resolve(venues.map((v) => mk(v, info.game)));
    const byVenue = {};
    res.forEach((r, i) => { byVenue[venues[i]] = (r && r.levels) || []; });
    // Soccer: venues differ on club names ("Tottenham Hotspur" vs "... FC").
    // Retry empty venues with ProphetX's raw names for game matching (totals only;
    // team-named labels keep the cleaned name the venue matched on).
    if (info.gameAlt && info.kind === 'TOT') {
      const miss = venues.filter((v) => !byVenue[v].length);
      if (miss.length) {
        const res2 = await resolve(miss.map((v) => mk(v, info.gameAlt)));
        res2.forEach((r, i) => { if (r && r.levels && r.levels.length) byVenue[miss[i]] = r.levels; });
      }
    }
    const out = { ...fairFromLadders(byVenue), at: t0 };
    cache.set(info.strikeId, out);
    return out;
  }

  // Fresh (≤ staleMs) price for a strike; fetches on demand. Never older than 15s.
  async function legPrice(info) {
    const hit = cache.get(info.strikeId);
    if (hit && now() - hit.at <= staleMs - 3000) return hit;
    if (!inflight.has(info.strikeId)) {
      inflight.set(info.strikeId, fetchLeg(info).catch((e) => { logger.warn(`[PX-PRICE] ${info.label || info.team}: ${e.message}`); return null; })
        .finally(() => inflight.delete(info.strikeId)));
    }
    return inflight.get(info.strikeId);
  }

  return { legPrice, cache };
}

module.exports = { createPricer, fairFromLadders, VENUES };
