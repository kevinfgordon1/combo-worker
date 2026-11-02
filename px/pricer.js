// Leg pricing for ProphetX strikes — the inverse bet method:
//   leg fair = sign-flip of the BEST opposing $500-profit price across venues,
//   each venue's ladder fee-included:
//     kalshi      public orderbook via book-depth (taker 0.07·p·(1−p))
//     novig       public v3 book via book-depth (pregame $0; live fee per book-depth)
//     polymarket  Polymarket US ladder from the odds relay's read-only /board (0.0695·p·(1−p))
//     prophetx    ProphetX (production) ladder from the odds relay's read-only /board (2% of winnings)
//   This process never holds a production ProphetX key; the relay does (read-only).
// book-depth / blendAskLadder / promoOppGuard are vendored from aibetbuilder (e2e6697,
// includes #550: each team must match its own title words; best-scoring event before start time).
// A venue whose ladder cannot fund $500 is ignored. A ladder whose top looks rogue next to
// that venue's own feed price (or, with no feed, the other venues' tops) is dropped (#550 guard:
// 20+ points better, 3x+ better in odds terms, or a <=2c top when the reference isn't a long shot).
'use strict';
const { resolveLegsDepth } = require('./vendor/book-depth');
const { blendAskLadderToPayout, TARGET_PAYOUT_USD } = require('./vendor/blendAskLadder.cjs');
const { ladderTopLooksRogue } = require('./vendor/promoOppGuard.cjs');
const { ourTrueFromOpponents } = require('../unhedged-quote');
const { STALE_MS } = require('./quote');
const { createRelayDepth } = require('./relay-depth');

const DIRECT_VENUES = ['kalshi', 'novig']; // book-depth (public, keyless)
const RELAY_VENUES = ['polymarket', 'prophetx']; // odds relay /board (read-only GET)
const VENUES = [...DIRECT_VENUES, ...RELAY_VENUES];

function topAmerican(levels) {
  let top = null;
  for (const l of levels || []) { const a = Number(l && l.american); if (isFinite(a) && a !== 0 && (top == null || a > top)) top = a; }
  return top;
}
function median(xs) {
  const a = xs.filter((x) => isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}
function toImplied(a) { return a > 0 ? 100 / (a + 100) : -a / (-a + 100); }
function fromImplied(p) { return p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p); }

// Pure: drop ladders whose top is rogue vs the venue's own feed price (refs[venue]),
// else vs the median top of the other venues. Returns { kept, dropped:{venue:reason} }.
function guardLadders(byVenue, refs = {}) {
  const tops = {};
  for (const [v, lv] of Object.entries(byVenue || {})) tops[v] = topAmerican(lv);
  const kept = {};
  const dropped = {};
  for (const [v, lv] of Object.entries(byVenue || {})) {
    if (!lv || !lv.length) { kept[v] = lv || []; continue; }
    let ref = refs[v] != null ? refs[v] : null;
    let via = 'feed';
    if (ref == null) {
      const others = Object.entries(tops).filter(([k, t]) => k !== v && t != null).map(([, t]) => toImplied(t));
      const m = median(others);
      ref = m != null ? fromImplied(m) : null;
      via = 'venues';
    }
    if (ref != null && ladderTopLooksRogue(ref, lv)) { dropped[v] = `rogue_vs_${via}:${tops[v]}vs${ref}`; kept[v] = []; continue; }
    kept[v] = lv;
  }
  return { kept, dropped };
}

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

// Pure: draw-no-bet fair from the inverse method. Opponent = the other team's
// win (best $500 YES ask, fee-included); the draw's probability comes from the
// best $500 "Draw No" ask, inverted (same inverse rule). P(other | no draw) =
// pOther / (1 − pDraw); our fair = 1 − that.
function dnbFair(oppByVenue, drawNoByVenue, opts) {
  const o = fairFromLadders(oppByVenue, opts); // o.p = 1 − implied(best other-team ask)
  const d = fairFromLadders(drawNoByVenue, opts); // d.p = 1 − implied(best Draw-No ask) = pDraw
  if (o.p == null || d.p == null) return { p: null, venues: { opp: o.venues, drawNo: d.venues }, best: null };
  const pOther = 1 - o.p;
  const pDraw = d.p;
  if (!(pDraw > 0 && pDraw < 1) || !(pOther > 0) || pOther >= 1 - pDraw) return { p: null, venues: { opp: o.venues, drawNo: d.venues }, best: null };
  const p = 1 - pOther / (1 - pDraw);
  return { p, venues: { opp: o.venues, drawNo: d.venues }, best: { venue: `${o.best.venue}+${d.best.venue}`, american: o.best.american } };
}

function createPricer({ resolve = resolveLegsDepth, relay = null, relayBase = '', relayPollMs = 5000, fetch: f, venues = VENUES, staleMs = STALE_MS, now = Date.now, logger = console } = {}) {
  const rd = relay || createRelayDepth({ base: relayBase, fetch: f, now, staleMs, pollMs: relayPollMs });
  if (rd.start) rd.start();
  const direct = venues.filter((v) => DIRECT_VENUES.includes(v));
  const viaRelay = venues.filter((v) => RELAY_VENUES.includes(v));
  // Direct venues via book-depth + relay venues, in `venues` order. rows[i] = { levels, reason }.
  async function resolveAll(leg) {
    const [a, b] = await Promise.all([
      resolve(direct.map((v) => ({ ...leg, bestOppBook: v }))),
      Promise.all(viaRelay.map((v) => rd.venueDepth(v, { ...leg, bestOppBook: v }).catch((e) => ({ levels: [], reason: `relay_error:${e.message}` })))),
    ]);
    const by = {};
    direct.forEach((v, i) => { by[v] = a[i] || { levels: [], reason: 'none' }; });
    viaRelay.forEach((v, i) => { by[v] = b[i] || { levels: [], reason: 'none' }; });
    return by;
  }
  // Feed reference per venue (top-of-book on the relay board) for the rogue-ladder guard.
  async function feedRefs(leg) {
    if (!rd.feedTop) return {};
    const refs = {};
    await Promise.all(direct.map(async (v) => { const t = await rd.feedTop(v, { ...leg, bestOppBook: v }).catch(() => null); if (t != null) refs[v] = t; }));
    return refs;
  }
  const cache = new Map(); // strikeId → { p, at, best, venues }
  const inflight = new Map();

  async function fetchLeg(info) {
    const mk = (v, game) => ({
      bestOppBook: v, market: info.kind || 'ML', bestOppName: info.oppLabel || info.opp, game, sport: info.sport,
      commence_time: info.startMs ? new Date(info.startMs).toISOString() : null,
    });
    const t0 = now();
    if (info.kind === 'DNB') {
      const [oppBy, dnBy] = await Promise.all([
        resolveAll({ ...mk(null, info.game), market: 'ML', bestOppName: info.oppLabel }),
        resolveAll({ ...mk(null, info.game), market: 'ML', bestOppName: info.drawLabel }),
      ]);
      const opp = {};
      const dn = {};
      for (const v of venues) { opp[v] = (oppBy[v] && oppBy[v].levels) || []; dn[v] = (dnBy[v] && dnBy[v].levels) || []; }
      const out = { ...dnbFair(guardLadders(opp).kept, guardLadders(dn).kept), at: t0 };
      cache.set(info.strikeId, out);
      return out;
    }
    const leg = mk(null, info.game);
    const [rows, refs] = await Promise.all([resolveAll(leg), feedRefs(leg)]);
    const byVenue = {};
    const reasons = {};
    for (const v of venues) { byVenue[v] = (rows[v] && rows[v].levels) || []; reasons[v] = (rows[v] && rows[v].reason) || 'none'; }
    // Soccer: venues differ on club names ("Tottenham Hotspur" vs "... FC").
    // Retry empty direct venues with ProphetX's raw names for game matching (totals only;
    // team-named labels keep the cleaned name the venue matched on).
    if (info.gameAlt && info.kind === 'TOT') {
      const miss = direct.filter((v) => !byVenue[v].length);
      if (miss.length) {
        const res2 = await resolve(miss.map((v) => mk(v, info.gameAlt)));
        res2.forEach((r, i) => { if (r && r.levels && r.levels.length) { byVenue[miss[i]] = r.levels; reasons[miss[i]] = r.reason || 'ok'; } });
      }
    }
    const g = guardLadders(byVenue, refs);
    for (const [v, why] of Object.entries(g.dropped)) reasons[v] = why;
    const out = { ...fairFromLadders(g.kept), reasons, at: t0 };
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

  return { legPrice, cache, stop: () => { if (rd.stop) rd.stop(); } };
}

module.exports = { createPricer, fairFromLadders, dnbFair, guardLadders, VENUES, DIRECT_VENUES, RELAY_VENUES };
