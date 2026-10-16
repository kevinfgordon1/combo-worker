// Promo-Builder-style per-leg fair for NFL moneylines — PURE, no I/O.
//
// How aibetbuilder's Promo Builder (lib/promo-ev.js + lib/promo-opp-guard.js + src/blendAskLadder.js) prices a leg:
//   1. "True" prob of a leg = 1 − implied(BEST opposing price) among TRUSTED books + exchanges
//      (calcParlayEV: combinedProb = Π ourTrueProb(bestOpp)). Kalshi / Polymarket quotes are
//      fee-adjusted (p·(1+θ(1−p))), ProphetX has 2% commission.
//   2. pickBestAmericanQuote guards the pool: a quote on the wrong side of, or >25pt away from,
//      the median sportsbook price is dropped (ABSURD 0.40 / DECISIVE 0.25).
//   3. If there is no independent opposing line, true prob is the same book's two-way DE-VIGGED
//      price ("No independent line — devigged vs this book's own opposite side").
//   4. Exchange legs are VWAP-blended over the ask ladder to a $500-profit walk (needs a depth API;
//      NOT available from odds_cache, so not applied here — top-of-book only).
//   5. Post-blend EV = P·(boostedProfit) − (1−P)·stake with P the product of the leg true probs.
//
// This module computes, per team leg, BOTH
//   promoBest  = the literal Promo true prob (step 1+2): 1 − implied(best guarded opposing price)
//                [the line-shopped, HIGH estimate of the true prob]
//   consensus  = weighted no-vig consensus of the trusted books' two-way de-vigged probs, blended
//                with exchange mids (Kevin's description: trusted books + exchange mids, no-vig,
//                blended). This is the PROMO variant's fair (flag NOBOOST_FAIR_METHOD=promo).
// Trusted set = Kevin's list ∩ what The Odds API cache carries; Fliff/Courtside and everything
// else are excluded; no Betstamp. Books not present in our feeds (Bet105, BetCris/Prime/BookMaker,
// Circa, bet365) are listed but simply never appear — their weights apply if a feed adds them.
'use strict';

// weight = consensus weight; slow = lagging book (down-weighted)
const TRUSTED_BOOKS = Object.freeze({
  pinnacle: { w: 3 },
  bet105: { w: 2 },
  circa: { w: 2 },
  betcris: { w: 0.5, slow: true },   // lags ~38s behind Pinnacle/exchanges
  prime: { w: 0.5, slow: true },
  bookmaker: { w: 0.5, slow: true },
  draftkings: { w: 1 },
  fanduel: { w: 1 },
  williamhill_us: { w: 1 },          // Caesars
  fanatics: { w: 1 },
  bet365: { w: 1 },
  betonlineag: { w: 1 },
  betus: { w: 1 },
  espnbet: { w: 1 },                 // theScore Bet
  hardrockbet: { w: 1 },
  betmgm: { w: 1 },
  betrivers: { w: 1 },
  ballybet: { w: 1 },
  betparx: { w: 1 },
  bovada: { w: 0.75 },               // recreational/offshore: down-weighted
  mybookieag: { w: 0.75 },
  unibet_nl: { w: 1 },               // the ONE Kambi book (unibet_se etc. are the same Kambi line)
});
const EXCHANGES = Object.freeze({
  kalshi: { w: 2 },
  polymarket: { w: 2 },
  novig: { w: 1.5 },
  prophetx: { w: 1 },
});
const EXCLUDED = Object.freeze(['fliff', 'courtside']);

const ABSURD = 0.40;
const DECISIVE = 0.25;

function imp(a) {
  const n = Number(a);
  if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
}
function toAm(p) {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? Math.round((-100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
}
function median(a) {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function sign(a) { return a > 0 ? 1 : a < 0 ? -1 : 0; }

// Port of promo-opp-guard.pickBestAmericanQuote (exchange flag instead of ALL_BOOKS).
// quotes: [{american, book, exchange}] → best (highest American) after the consensus guards, or null.
function pickBestAmerican(quotes) {
  const list = quotes.filter((q) => Number.isFinite(q.american) && q.american !== 0);
  if (!list.length) return null;
  const sbMed = median(list.filter((q) => !q.exchange).map((q) => q.american));
  const wrongSide = (q) => {
    if (sbMed == null || sign(sbMed) === sign(q.american)) return false;
    return Math.abs(imp(sbMed) - imp(q.american)) >= ABSURD;
  };
  const signOk = list.filter((q) => !wrongSide(q));
  const absurd = (q) => sbMed != null && Math.abs(imp(sbMed) - imp(q.american)) >= DECISIVE;
  const usable = signOk.filter((q) => !absurd(q));
  const pool = usable.length ? usable : (signOk.length ? signOk : list);
  return pool.reduce((b, q) => (b == null || q.american > b.american ? q : b), null);
}

// raw: [{ book, american, oppAmerican, at }] for ONE team (american = this team, oppAmerican = other side).
// live: optional { mid, at } fresh live exchange mid (Kalshi book) for this team.
// opts: { now, maxBookAgeMs, minBooks, outlier, liveOppProb (fee-included best opp from the live book) }
function legFair(raw, live, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const maxAge = opts.maxBookAgeMs != null ? opts.maxBookAgeMs : 30 * 60 * 1000;
  const minBooks = opts.minBooks != null ? opts.minBooks : 3;
  const outlier = opts.outlier != null ? opts.outlier : 0.06;
  const comps = [];
  const oppQuotes = [];
  const liveOk = !!(live && live.mid != null && now - live.at <= (opts.liveMaxAgeMs || 15000));
  for (const r of raw || []) {
    if (EXCLUDED.includes(r.book)) continue;
    if (liveOk && r.book === 'kalshi') continue; // the live Kalshi book replaces the cached (fee-adjusted) copy
    const meta = TRUSTED_BOOKS[r.book] || EXCHANGES[r.book];
    if (!meta) continue;
    if (now - r.at > maxAge) continue;
    const a = imp(r.american); const b = imp(r.oppAmerican);
    if (a == null || b == null) continue;
    const sum = a + b;
    if (sum < 0.9 || sum > 1.2) continue; // incoherent two-way (promo TWO_WAY_SUM guard, tightened for ML)
    comps.push({ book: r.book, p: a / sum, w: meta.w, exchange: !!EXCHANGES[r.book], at: r.at });
    oppQuotes.push({ american: r.oppAmerican, book: r.book, exchange: !!EXCHANGES[r.book] });
  }
  // drop outliers vs the weighted-by-count median
  const med = median(comps.map((c) => c.p));
  let used = comps.filter((c) => med == null || Math.abs(c.p - med) <= outlier);
  const nBooksCache = used.filter((c) => !c.exchange).length;
  if (liveOk) {
    if (med == null || Math.abs(live.mid - med) <= outlier * 1.5) used = used.concat([{ book: 'kalshi_live', p: live.mid, w: EXCHANGES.kalshi.w, exchange: true, at: live.at }]);
  }
  if (used.length < minBooks || nBooksCache < 1) return null;
  const W = used.reduce((a, c) => a + c.w, 0);
  const consensus = used.reduce((a, c) => a + c.w * c.p, 0) / W;
  const sharp = used.filter((c) => c.book === 'pinnacle').map((c) => c.p)[0];
  const best = pickBestAmerican(oppQuotes);
  let promoBest = best ? 1 - imp(best.american) : null;
  if (opts.liveOppProb != null && opts.liveOppProb > 0 && opts.liveOppProb < 1) {
    // live Kalshi fee-included opposite ask competes for "best opposing price" (lowest opposing implied)
    const cand = 1 - opts.liveOppProb;
    promoBest = promoBest == null ? cand : Math.max(promoBest, cand);
  }
  const oldest = Math.min(...used.map((c) => c.at));
  return {
    consensus, promoBest, n: used.length, nBooks: nBooksCache, nExchange: used.length - nBooksCache,
    pinnacle: sharp != null ? sharp : null, spread: Math.max(...used.map((c) => c.p)) - Math.min(...used.map((c) => c.p)),
    oldestAt: oldest, bestBook: best ? best.book : null,
    books: used.map((c) => c.book),
  };
}

// Port of blendAskLadderToPayout (src/blendAskLadder.js): VWAP walk of an ask ladder until PROFIT
// reaches target. levels [{american,size($ stake)}] → { american, complete, levelsUsed } | null.
// Used only when a background refresher supplies ladders; odds_cache has top-of-book size only.
function blendAskLadderToPayout(levels, target = 500) {
  const ladder = (levels || []).map((l) => ({ a: Number(l.american), s: Number(l.size) }))
    .filter((l) => Number.isFinite(l.a) && l.a !== 0 && l.s > 0 && imp(l.a) > 0 && imp(l.a) < 1)
    .map((l) => ({ ...l, p: imp(l.a) })).sort((x, y) => y.a - x.a);
  let profit = 0; let stake = 0; let used = 0;
  for (const l of ladder) {
    const rem = target - profit;
    if (rem <= 1e-9) break;
    const ppS = (1 - l.p) / l.p;
    if (!(ppS > 0)) continue;
    const take = Math.min(l.s * ppS, rem);
    profit += take; stake += take / ppS; used += 1;
  }
  if (!(profit > 0 && stake > 0)) return null;
  const p = stake / (stake + profit);
  return { american: toAm(p), impliedProb: p, complete: profit + 0.5 >= target, levelsUsed: used };
}

module.exports = { TRUSTED_BOOKS, EXCHANGES, EXCLUDED, legFair, pickBestAmerican, blendAskLadderToPayout, imp, toAm, median };
