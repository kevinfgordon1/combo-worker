// VENDORED from aibetbuilder origin/main e2e6697 src/promoOppGuard.js (ESM→CJS, logic unchanged; includes #550 ladderTopLooksRogue).
"use strict";
// Promo true-odds sanity: reject inverted / wrong-side opponent quotes.
//
// 2-way ML true prob is 1 − implied(opponent Yes). If Kalshi (or any book)
// attaches the favorite's own Yes to the other team, that inverse becomes a
// huge underdog "true" (+2000-class vs a −20000 book) and EV collapses to ~−95%.
//
// A real +EV dog (book +150 vs fair −110) flips signs too — only absurd
// |edge| / same-sign heavy favorites are rejected. Extreme UD longshots
// (+8628 vs true −107 / +107) are the same-sign 47pt case: drop them.

const ABSURD_TRUE_EDGE = 0.40;
const DECISIVE_IMPLIED_DEV = 0.25; // ~−200 / +200
const TWO_WAY_SUM_MIN = 0.80;
const TWO_WAY_SUM_MAX = 1.22;

function impliedFromAmerican(odds) {
  const n = Number(odds);
  if (!isFinite(n) || n === 0) return null;
  if (n < 0) return Math.abs(n) / (Math.abs(n) + 100);
  return 100 / (n + 100);
}

function probToAmericanOdds(prob) {
  if (prob == null || !isFinite(prob) || prob <= 0 || prob >= 1) return null;
  if (prob >= 0.5) return Math.round((-100 * prob) / (1 - prob));
  return Math.round((100 * (1 - prob)) / prob);
}

function americanSign(odds) {
  const n = Number(odds);
  if (!isFinite(n) || n === 0) return 0;
  return n > 0 ? 1 : -1;
}

// Same-selection quotes: Fanatics Iowa −20000 vs Kalshi Iowa +2042.
function quoteLooksWrongSideOf(reference, candidate) {
  const a = Number(reference);
  const b = Number(candidate);
  if (!isFinite(a) || a === 0 || !isFinite(b) || b === 0) return false;
  if (americanSign(a) === americanSign(b)) return false;
  const pa = impliedFromAmerican(a);
  const pb = impliedFromAmerican(b);
  if (pa == null || pb == null) return false;
  return Math.abs(pa - pb) >= ABSURD_TRUE_EDGE;
}

// Sign-agnostic implied gap. +8628 vs +110 is the same side but 46pts of p —
// the sign-only guard lets that rank as a free-bet BEST PICK.
function quoteLooksAbsurdVsReference(reference, candidate, edge = ABSURD_TRUE_EDGE) {
  const pa = impliedFromAmerican(reference);
  const pb = impliedFromAmerican(candidate);
  if (pa == null || pb == null) return false;
  return Math.abs(pa - pb) >= edge;
}

// A live depth ladder whose BEST ask beats the feed's quoted best price by
// 20+ points of implied probability is not this market's book: a wrong-game
// match or a closed market's leftover asks. Blackhawks ML (2026-10-29): feed
// Polymarket +134 (≈43%), ladder from the closed MLB Tigers/Cubs market
// +426/+2244/+9256 (≤19%) → Red Wings "true" −337 vs BetMGM −160. Deeper
// levels being WORSE than the quote is normal; better by this much is not.
const LADDER_TOP_MAX_IMPROVE = 0.20;

// Points of probability miss longshots: Texas A&M-CC ML (2026-11-02) feed Novig
// +456 (≈18%) vs a wrong-game ladder topped at +9900 (1%) is only 17 points,
// yet 22x the odds. A top whose odds (p/(1−p)) beat the quote's by 3x or more
// is rogue too, and so is a ≤2c top (+4900 or longer) when the quote is not.
const LADDER_TOP_MAX_ODDS_RATIO = 3;
const LADDER_PENNY_TOP_PROB = 0.02;

function oddsOf(p) { return p / (1 - p); }

function ladderTopLooksRogue(quoted, levels, maxImprove = LADDER_TOP_MAX_IMPROVE) {
  const pq = impliedFromAmerican(quoted);
  if (pq == null) return false;
  let top = null;
  for (const l of levels || []) {
    const a = Number(l && l.american);
    if (!isFinite(a) || a === 0) continue;
    if (top == null || a > top) top = a;
  }
  const pt = impliedFromAmerican(top);
  if (pt == null) return false;
  if (pq - pt >= maxImprove) return true;
  if (pt < pq && oddsOf(pq) / oddsOf(pt) >= LADDER_TOP_MAX_ODDS_RATIO) return true;
  return pt <= LADDER_PENNY_TOP_PROB && pq > LADDER_PENNY_TOP_PROB * 2;
}

// Opposite-side Yes quotes whose implieds do not sum to a 2-way (~1).
// WKU +8628 (p≈0.011) vs Underdog −107 (p≈0.517) is 0.53 — not one contract.
function twoWayQuotesLookIncoherent(a, b, min = TWO_WAY_SUM_MIN, max = TWO_WAY_SUM_MAX) {
  const pa = impliedFromAmerican(a);
  const pb = impliedFromAmerican(b);
  if (pa == null || pb == null) return false;
  const sum = pa + pb;
  return sum < min || sum > max;
}

// Same-selection fair American implied by an other-side Yes (1 − opp).
function trueAmericanFromOpp(oppOdds) {
  const oppImp = impliedFromAmerican(oppOdds);
  if (oppImp == null) return null;
  return probToAmericanOdds(1 - oppImp);
}

// bookOdds = priced selection; oppOdds = other-side Yes used as the inverse.
// Rejects inverted favorites, same-sign junk, incoherent 2-ways, and
// +8628-class longshots whose inverse true is even-money (−107 / +100 class).
function oppQuoteLooksInverted(bookOdds, oppOdds) {
  const book = Number(bookOdds);
  const opp = Number(oppOdds);
  if (!isFinite(book) || book === 0 || !isFinite(opp) || opp === 0) return false;

  const bookImp = impliedFromAmerican(book);
  const oppImp = impliedFromAmerican(opp);
  if (bookImp == null || oppImp == null) return false;
  const ourTrue = 1 - oppImp;
  const edge = ourTrue - bookImp;
  const trueAm = probToAmericanOdds(ourTrue);
  if (trueAm != null && americanSign(book) !== 0 && americanSign(trueAm) !== 0
    && americanSign(book) !== americanSign(trueAm)
    && Math.abs(edge) >= ABSURD_TRUE_EDGE) {
    return true;
  }
  // Heavy favorite whose "opponent" is also a favorite — not 2-way juice.
  if (americanSign(book) === americanSign(opp) && Math.abs(bookImp - 0.5) >= DECISIVE_IMPLIED_DEV) {
    return true;
  }
  // Same-sign +8628 vs true +107 (opp −107): 47pts of p, not a real dog edge.
  if (Math.abs(edge) >= ABSURD_TRUE_EDGE) return true;
  // Two-way sum only when the quotes are opposite sides. +200 vs +200 is
  // the same-selection PM top, not a broken 2-way.
  if (americanSign(book) !== 0 && americanSign(book) !== americanSign(opp)
    && twoWayQuotesLookIncoherent(book, opp)) {
    return true;
  }
  return false;
}

function medianAmerican(prices) {
  const s = prices.filter((p) => isFinite(Number(p)) && Number(p) !== 0).map(Number)
    .sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function isExchangeBookKey(bookKey, allBooks) {
  const meta = (allBooks || []).find((b) => b.key === bookKey);
  return !!(meta && meta.exchange);
}

function quoteConflictsWithSportsbookConsensus(price, sportsbookPrices) {
  const ref = medianAmerican(sportsbookPrices);
  if (ref == null) return false;
  return quoteLooksWrongSideOf(ref, price);
}

function quoteMagnitudeConflictsWithSportsbookConsensus(price, sportsbookPrices, edge = DECISIVE_IMPLIED_DEV) {
  const ref = medianAmerican(sportsbookPrices);
  if (ref == null) return false;
  return quoteLooksAbsurdVsReference(ref, price, edge);
}

// Highest American among quotes that match sportsbook consensus on side
// and magnitude. +8628 vs books +105 is same-sign but must not become
// the "best" true for that named team (or the other side's inverse).
function pickBestAmericanQuote(quotes, { allBooks } = {}) {
  const list = (quotes || []).filter((q) => q && isFinite(Number(q.price)) && Number(q.price) !== 0);
  if (!list.length) return { best: null, bestBook: null, bestSize: null };
  const sbPrices = list
    .filter((q) => !isExchangeBookKey(q.book, allBooks))
    .map((q) => q.price);
  const signOk = list.filter((q) => !quoteConflictsWithSportsbookConsensus(q.price, sbPrices));
  const usable = signOk.filter((q) => !quoteMagnitudeConflictsWithSportsbookConsensus(q.price, sbPrices));
  const pool = usable.length ? usable : (signOk.length ? signOk : list);
  let best = null;
  for (const q of pool) {
    if (best == null || q.price > best.price) best = q;
  }
  return {
    best: best.price,
    bestBook: best.book,
    bestSize: best.size ?? null,
    // Every depth venue's (fee-adjusted) quote that passed the same guards,
    // best-first. Only used by the owner-only blended Min depth per leg.
    venues: depthVenueQuotes(pool),
  };
}

const DEPTH_QUOTE_VENUES = new Set(["kalshi", "polymarket", "novig", "prophetx"]);
function depthVenueQuotes(pool) {
  return (pool || [])
    .filter((q) => DEPTH_QUOTE_VENUES.has(String(q.book || "").toLowerCase()))
    .map((q) => ({ book: q.book, american: Number(q.price), size: q.size ?? null }))
    .sort((a, b) => b.american - a.american);
}

function resolveOppWithSideGuard({
  trustedOpp,
  trustedBook,
  trustedCount,
  trustedSize,
  trustedVenues,
  sameBookOpp,
  sameBookKey,
  sameBookSize,
  bookOdds,
} = {}) {
  const trustedOk = trustedOpp != null && !oppQuoteLooksInverted(bookOdds, trustedOpp);
  if (trustedOk) {
    return {
      bestOpp: trustedOpp,
      bestOppBook: trustedBook,
      bestOppCount: trustedCount,
      bestOppSize: trustedSize ?? null,
      ...(Array.isArray(trustedVenues) && trustedVenues.length ? { bestOppVenues: trustedVenues } : {}),
      sameBookFallback: false,
    };
  }
  const sameOk = sameBookOpp != null && !oppQuoteLooksInverted(bookOdds, sameBookOpp);
  if (sameOk) {
    return {
      bestOpp: sameBookOpp,
      bestOppBook: sameBookKey,
      bestOppCount: 1,
      bestOppSize: sameBookSize ?? null,
      sameBookFallback: true,
    };
  }
  return {
    bestOpp: null,
    bestOppBook: trustedBook || sameBookKey || null,
    bestOppCount: trustedCount || 0,
    bestOppSize: trustedSize ?? null,
    sameBookFallback: false,
  };
}

function pickHasInvertedOpp(legs) {
  return (legs || []).some((l) => l && oppQuoteLooksInverted(l.dk, l.bestOpp));
}

// After $500 blend overlay, drop inverted-opp parlays when a sane one exists,
// then rank by EV so a −95% overlay cannot stay ★ BEST PICK.
function rankPicksAfterOppGuard(picks) {
  const list = picks || [];
  const sane = list.filter((p) => !pickHasInvertedOpp(p && p.legs));
  const pool = sane.length ? sane : list;
  return [...pool].sort((a, b) => (Number(b && b.ev) || 0) - (Number(a && a.ev) || 0));
}

module.exports = { ABSURD_TRUE_EDGE, DECISIVE_IMPLIED_DEV, TWO_WAY_SUM_MIN, TWO_WAY_SUM_MAX, impliedFromAmerican, probToAmericanOdds, quoteLooksWrongSideOf, quoteLooksAbsurdVsReference, LADDER_TOP_MAX_IMPROVE, LADDER_TOP_MAX_ODDS_RATIO, LADDER_PENNY_TOP_PROB, ladderTopLooksRogue, twoWayQuotesLookIncoherent, trueAmericanFromOpp, oppQuoteLooksInverted, isExchangeBookKey, quoteConflictsWithSportsbookConsensus, quoteMagnitudeConflictsWithSportsbookConsensus, pickBestAmericanQuote, depthVenueQuotes, resolveOppWithSideGuard, pickHasInvertedOpp, rankPicksAfterOppGuard };
