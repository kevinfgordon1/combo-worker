// Inverse-bet fair at SNIPER_FAIR_DEPTH_USD ($1,000), best opposite price across Kalshi,
// Polymarket US, Novig and ProphetX, each with its own fee (pm-live / td-book FEES).
// A venue counts only with REAL depth (reason 'ok'; top-of-book-only quotes ignored) and
// fresh (15s). No qualifying venue => no fair (leg skipped).
//   moneyline: opponent's Yes ask ladder (Kalshi also No on own team)
//   TD Yes: walk the player's No side; TD No: walk Yes.
'use strict';
const { rogueGuard, rogueConfig } = require('./rogue');
let ENV_ROGUE = null;
const envRogue = () => (ENV_ROGUE || (ENV_ROGUE = rogueConfig(process.env)));
const { midGuard, midGuardConfig } = require('./mid-guard');
let ENV_MID = null;
const envMid = () => (ENV_MID || (ENV_MID = midGuardConfig(process.env)));
const MID_GUARD_REASONS = new Set(['fair_below_mid', 'single_venue_thin', 'book_overround']);
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
// Best depth venue after the rogue-line guard (sniper/rogue.js). skip → leg has no fair.
function guarded(sources, venues, rogue, noVenueReason, mid, own) {
  const g = rogueGuard(sources || [], venues, rogue || envRogue(), bestCost);
  const rogueEv = g.events.filter((e) => e.kind !== 'no_ref');
  if (g.skip) return { p: null, reason: g.skip, rogue: rogueEv };
  if (!g.best) return { p: null, reason: noVenueReason };
  const b = g.best;
  const mcfg = mid || envMid();
  const m = midGuard(1 - b.cost, b.venue, sources, venues, mcfg, own);
  if (m.skip && mcfg.mode === 'enforce') return { p: null, reason: m.skip, guard: m.ev, rogue: rogueEv.length ? rogueEv : undefined };
  return { p: 1 - b.cost, ref: m.ref != null ? m.ref : null, guardShadow: m.ev || undefined, best: `${b.venue}${b.via && b.via !== 'td_opposite' ? ':' + b.via : ''}`, venue: b.venue, depthUsd: b.availUsd != null ? b.availUsd : null, rogue: rogueEv.length ? rogueEv : undefined };
}
function legFairDepth(leg, { pmLive, tdBook, venues, ncaafBook, linesBook = null, nbaBook = null, rogue, mid }) {
  if (leg.kind === 'nba') { // NBA moneyline (sniper/nba.js); NBA spreads/totals are kind 'line'
    if (!nbaBook) return { p: null, reason: 'no_nba_book' };
    const f = nbaBook.legFair(leg.gameId, leg.team);
    if (!f) return { p: null, reason: 'no_game' };
    return guarded(f.sources, venues, rogue, 'no_venue_depth', mid, f.own);
  }
  if (leg.kind === 'line') { // main spread / total (sniper/lines.js)
    if (!linesBook) return { p: null, reason: 'lines_off' };
    const f = linesBook.legFair(leg);
    if (f.p == null && f.reason) return { p: null, reason: f.reason };
    return guarded(f.sources, venues, rogue, 'no_venue_depth', mid, f.own);
  }
  if (leg.kind === 'ncaaf') {
    if (!ncaafBook) return { p: null, reason: 'no_ncaaf_book' };
    const f = ncaafBook.legFair(leg.gameId, leg.team);
    if (!f) return { p: null, reason: 'no_game' };
    return guarded(f.sources, venues, rogue, 'no_venue_depth', mid, f.own);
  }
  if (leg.kind === 'td') {
    if (!tdBook) return { p: null, reason: 'td_no_book' };
    const m = tdBook.legMulti({ id: leg.id, side: leg.side });
    return guarded(m && m.sources, venues, rogue, 'td_no_venue_depth', mid);
  }
  if (!pmLive) return { p: null, reason: 'no_ml_book' };
  const f = pmLive.legFair(leg.gameId, leg.team);
  if (!f) return { p: null, reason: 'no_game' };
  return guarded(f.sources, venues, rogue, 'no_venue_depth', mid, f.own);
}
module.exports = { MID_GUARD_REASONS, ALL_VENUES, venuesFromEnv, bestCost, legFairDepth };
