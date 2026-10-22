// Inverse-bet fair at SNIPER_FAIR_DEPTH_USD ($1,000), best opposite price across Kalshi,
// Polymarket US, Novig and ProphetX, each with its own fee (pm-live / td-book FEES).
// A venue counts only with REAL depth (reason 'ok'; top-of-book-only quotes ignored) and
// fresh (15s). No qualifying venue => no fair (leg skipped).
//   moneyline: opponent's Yes ask ladder (Kalshi also No on own team)
//   TD Yes: walk the player's No side; TD No: walk Yes.
'use strict';
const ALL_VENUES = ['kalshi', 'polymarket', 'novig', 'prophetx'];
function venuesFromEnv(env) {
  const v = String(env.SNIPER_FAIR_VENUES || ALL_VENUES.join(',')).toLowerCase().split(',').map((x) => x.trim()).filter((x) => ALL_VENUES.includes(x));
  return v.length ? v : ALL_VENUES;
}
function bestCost(sources, venues) {
  let best = null;
  for (const s of sources || []) {
    if (!s || !s.used || s.reason !== 'ok' || !venues.includes(s.venue)) continue;
    if (!(s.cost > 0 && s.cost < 1)) continue;
    if (!best || s.cost < best.cost) best = s;
  }
  return best;
}
function legFairDepth(leg, { pmLive, tdBook, venues }) {
  if (leg.kind === 'td') {
    if (!tdBook) return { p: null, reason: 'td_no_book' };
    const m = tdBook.legMulti({ id: leg.id, side: leg.side });
    const b = bestCost(m && m.sources, venues);
    if (!b) return { p: null, reason: 'td_no_venue_depth' };
    return { p: 1 - b.cost, best: b.venue, venue: b.venue, depthUsd: b.availUsd != null ? b.availUsd : null };
  }
  if (!pmLive) return { p: null, reason: 'no_ml_book' };
  const f = pmLive.legFair(leg.gameId, leg.team);
  if (!f) return { p: null, reason: 'no_game' };
  const b = bestCost(f.sources, venues);
  if (!b) return { p: null, reason: 'no_venue_depth' };
  return { p: 1 - b.cost, best: `${b.venue}${b.via ? ':' + b.via : ''}`, venue: b.venue, depthUsd: b.availUsd != null ? b.availUsd : null };
}
module.exports = { ALL_VENUES, venuesFromEnv, bestCost, legFairDepth };
