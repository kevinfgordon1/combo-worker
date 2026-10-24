// NFL player ANYTIME-TD leg prices for the no-boost PAPER run. Read-only, no orders.
//
// Source: Kalshi public orderbooks (GET /markets/orderbooks, unauthenticated, so it does NOT
// spend the shared Kalshi_combo_key's rate limit) for every open KXNFLTD anytime market
// (ticker suffix "-1"), refreshed in the background. The RFQ path is lookup only.
//
// Per-leg fair (Kevin's "inverse bet" + $500 depth convention):
//   noV  = fee-included VWAP to BUY $500 of No  (crosses the Yes bids: No ask = 1 − yes bid)
//   yesV = fee-included VWAP to BUY $500 of Yes (crosses the No bids:  Yes ask = 1 − no bid)
//   fee  = Kalshi taker θ·p·(1−p), θ = 0.07 (KXNFLTD multiplier 1)
//   mid      = yesV / (yesV + noV)            (devig Yes vs No at $500 depth)  -> fair_mid
//   inverse  = 1 − noV                         (sign-flip of the $500 No bet) -> fair_inverse
//   lockCost = yesV                            (cost to rebuild the Yes leg)
// Either side with < $500 of depth, a book older than staleMs, or an overround
// (yesV + noV − 1) above maxOverround => leg unpriceable => the RFQ is skipped.
// A "no" side leg (player NOT to score) swaps Yes/No.
// legStats (Kalshi only) is unchanged and still feeds the PRIMARY / LOCKCF / leg_fairs paths.
//
// Multi-venue inverse (Combo Sniper pm_inverse, legMulti): the same inverse bet, the same
// $500 depth, 15% overround and 15s staleness rules, applied to EACH venue on its own:
//   kalshi      the public orderbooks above (fee 0.07·p·(1−p))
//   polymarket  Polymarket US book from the odds relay's US markets socket (/td), fee 0.0695·p·(1−p)
//   novig       Novig book from the relay's signed Novig socket (/td), no fee pregame
//               (fee.coefficient·p·(1−p) once the game is live)
// A venue that is missing, older than staleMs, short of $500 on either side, or over the
// overround cap is dropped for that leg (reason kept). The leg's inverse = 1 − the cheapest
// surviving opposite-side $500 VWAP. If the relay is down its venues go stale and the leg
// prices from Kalshi alone, exactly as before.
'use strict';
const { parseKalshiUnhedgedTicker } = require('../unhedged-rfq');
const { normTeam } = require('../leg-identity');
const { teamCode, etDate } = require('../mm-paper-odds');

const THETA = 0.07;
const DEPTH_USD = 500;
const TD_RE = /^KXNFLTD-([0-9]{2}[A-Z]{3}[0-9]{2}[A-Z]+)-([A-Z0-9]+)-1$/;

const fee = (p) => THETA * p * (1 - p);
const POLY_THETA = 0.0695;
// levels: [[askPrice, contracts], ...] best (cheapest) first. VWAP of fee-included cost until the
// bet can WIN $usd (depth = potential PROFIT, not stake — Kevin). availUsd is profit $; topUsd
// stays the $ stake at the top level (display only).
// feeFn defaults to Kalshi's taker fee (unchanged behaviour for the Kalshi book).
function vwapFor(levels, usd = DEPTH_USD, feeFn = fee) {
  let spent = 0; let got = 0; let won = 0;
  for (const [p, q] of levels) {
    if (!(p > 0 && p < 1) || !(q > 0)) continue;
    const c = p + feeFn(p);
    const per = 1 - c;
    if (!(per > 0)) continue;
    const take = Math.min(q, (usd - won) / per);
    spent += take * c; got += take; won += take * per;
    if (won >= usd - 1e-9) return { vwap: spent / got, stakeUsd: spent, top: levels[0][0] + feeFn(levels[0][0]), topUsd: levels[0][1] * (levels[0][0] + feeFn(levels[0][0])), availUsd: levels.reduce((s, [pp, qq]) => (pp > 0 && pp <= p + 1e-9 && qq > 0 ? s + qq * Math.max(0, 1 - (pp + feeFn(pp))) : s), 0) }; // profit $ at or better than the marginal price used
  }
  return null; // not enough depth
}

// ---- player matching (port of aibetbuilder lib/player-td.cjs samePlayer / teamsCompatible)
function normalizePlayerName(name) {
  let x = String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  x = x.replace(/['\u2019.]/g, '');
  x = x.toLowerCase().replace(/[^a-z\s]/g, ' ');
  x = x.replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ');
  return x.replace(/\s+/g, ' ').trim();
}
const NICK = { kenny: 'kenneth', ken: 'kenneth', mike: 'michael', chris: 'christopher', matt: 'matthew', josh: 'joshua', nick: 'nicholas', will: 'william', bill: 'william', rob: 'robert', bob: 'robert', tony: 'anthony', dan: 'daniel', danny: 'daniel', joe: 'joseph', jon: 'jonathan', tom: 'thomas', tommy: 'thomas', zach: 'zachary', jake: 'jacob', alex: 'alexander', ben: 'benjamin', sam: 'samuel', dave: 'david', steve: 'steven', greg: 'gregory', pat: 'patrick', cam: 'cameron', jeff: 'jeffrey', drew: 'andrew', andy: 'andrew', ted: 'theodore', gabe: 'gabriel', nate: 'nathan', tim: 'timothy', ed: 'edward', eddie: 'edward', mitch: 'mitchell' };
// Players listed under a different first name on some venues (Kalshi "Bam Knight" = Novig / ProphetX "Zonovan Knight").
const ALIAS = { 'bam knight': 'zonovan knight', 'hollywood brown': 'marquise brown' };
function samePlayer(a, b) {
  let na = normalizePlayerName(a); let nb = normalizePlayerName(b);
  if (!na || !nb) return false;
  na = ALIAS[na] || na; nb = ALIAS[nb] || nb;
  if (na === nb) return true;
  const pa = na.split(' '); const pb = nb.split(' ');
  if (pa.length < 2 || pb.length < 2 || pa[pa.length - 1] !== pb[pb.length - 1]) return false;
  const fa = NICK[pa[0]] || pa[0]; const fb = NICK[pb[0]] || pb[0];
  if (fa === fb) return true; // Kenny / Kenneth
  // Initials ("J. Taylor", "KC Concepcion"): first letter must match.
  const ai = pa[0].length <= 2; const bi = pb[0].length <= 2;
  return (ai || bi) && pa[0][0] === pb[0][0];
}
const TEAM_ALIAS = { LA: 'LAR', ARZ: 'ARI', WSH: 'WAS', JAC: 'JAX' };
const canonAbbr = (a) => { const u = String(a || '').toUpperCase(); return TEAM_ALIAS[u] || u; };
function teamsCompatible(a, b) { const x = canonAbbr(a); const y = canonAbbr(b); return !x || !y || x === y; }
// Kalshi game key "2026-10-18|bal+cle" from the TD ticker; venue key from full team names + ET date.
function gameKeyFromTicker(ticker) {
  const p = parseTdTicker(ticker);
  if (!p) return null;
  const teams = p.gameId.split('|')[2].split('+').map((t) => normTeam('nfl', t.toUpperCase()) || t);
  return { key: `${p.date}|${teams.sort().join('+')}`, teams, player: p.player };
}
function venueGameKeys(away, home, start) {
  const a = teamCode('nfl', away); const h = teamCode('nfl', home);
  const d = etDate(start);
  if (!a || !h || !d) return [];
  const codes = [normTeam('nfl', a) || a, normTeam('nfl', h) || h].sort().join('+');
  const t = Date.parse(`${d}T12:00:00Z`);
  const shift = (n) => new Date(t + n * 86400000).toISOString().slice(0, 10);
  return [`${d}|${codes}`, `${shift(-1)}|${codes}`, `${shift(1)}|${codes}`];
}
const VENUE_FEE = {
  polymarket: (coef) => { const c = Number.isFinite(Number(coef)) && Number(coef) > 0 ? Number(coef) : POLY_THETA; return (p) => c * p * (1 - p); },
  novig: (coef, live) => (live && Number(coef) > 0 ? (p) => Number(coef) * p * (1 - p) : () => 0),
  prophetx: () => () => 0, // relay folds ProphetX's 2% commission into the level price
};
const american = (p) => (p > 0 && p < 1 ? (p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p)) : null);
// Kalshi orderbook_fp: yes_dollars / no_dollars are BIDS [[price, contracts]].
function laddersFromBook(ob) {
  const b = (ob && (ob.orderbook_fp || ob.orderbook)) || {};
  const rows = (a) => (Array.isArray(a) ? a.map((r) => [Number(r[0]), Number(r[1])]) : []);
  const yesBids = rows(b.yes_dollars); const noBids = rows(b.no_dollars);
  // buy No = cross yes bids (highest yes bid = cheapest No)
  const noAsks = yesBids.map(([p, q]) => [Math.round((1 - p) * 1e4) / 1e4, q]).sort((x, y) => x[0] - y[0]);
  const yesAsks = noBids.map(([p, q]) => [Math.round((1 - p) * 1e4) / 1e4, q]).sort((x, y) => x[0] - y[0]);
  return { yesAsks, noAsks };
}

// "KXNFLTD-26OCT18PITTB-PITKWETJEN10-1" -> { gameId:'nfl|2026-10-18|pit+tb', ticker, player }
function parseTdTicker(ticker) {
  const t = String(ticker || '').toUpperCase();
  const m = TD_RE.exec(t);
  if (!m) return null;
  const pair = m[1].slice(7);
  for (const n of [3, 2, 4]) {
    const team = pair.slice(0, n);
    const p = parseKalshiUnhedgedTicker(`KXNFLGAME-${m[1]}-${team}`, 'yes');
    if (p && !p.skip && p.gameId && p.league === 'nfl') return { gameId: p.gameId, ticker: t, player: m[2], date: p.date };
  }
  return null;
}
const isTdTicker = (t) => TD_RE.test(String(t || '').toUpperCase());

function createTdBook({ now = () => Date.now(), staleMs = 15000, depthUsd = DEPTH_USD, maxOverround = 0.15, venues = [] } = {}) {
  const books = new Map(); // ticker -> { stats, at, kickoffMs }
  const fails = { depth: 0, stale: 0, overround: 0, missing: 0 };
  const names = new Map(); // ticker -> player name (Kalshi market title)
  const venueBooks = new Map(); // venue -> Map(ticker -> { y, n, fail, at, key, fee })
  for (const v of venues) venueBooks.set(v, new Map());
  const matchStats = {}; // venue -> { matched, unmatched, ambiguous }

  function compute(ladders) {
    const y = vwapFor(ladders.yesAsks, depthUsd);
    const n = vwapFor(ladders.noAsks, depthUsd);
    if (!y || !n) return { fail: 'depth' };
    if (y.vwap + n.vwap - 1 > maxOverround) return { fail: 'overround', y, n };
    return { y, n };
  }
  function ingest(orderbooks, meta = {}) {
    let k = 0;
    for (const ob of orderbooks || []) {
      const t = String((ob && (ob.ticker || ob.market_ticker)) || '').toUpperCase();
      if (!isTdTicker(t)) continue;
      books.set(t, { ...compute(laddersFromBook(ob)), at: now(), kickoffMs: meta[t] != null ? meta[t] : (books.get(t) || {}).kickoffMs });
      k += 1;
    }
    return k;
  }
  // stats in the shape quote.priceCombo expects for one leg {id: ticker, side}
  function legStats(leg) {
    const e = books.get(String(leg.id || leg.ticker || '').toUpperCase());
    if (!e) { fails.missing += 1; return null; }
    const age = now() - e.at;
    if (age > staleMs) { fails.stale += 1; return null; }
    if (e.fail) { fails[e.fail] += 1; return null; }
    const own = leg.side === 'no' ? e.n : e.y;
    const opp = leg.side === 'no' ? e.y : e.n;
    return {
      mid: own.vwap / (own.vwap + opp.vwap),
      inverse: 1 - opp.vwap,
      lockCost: own.vwap,
      reference: null,
      promo: null,
      ageMs: age,
      td: { ownVwap: own.vwap, oppVwap: opp.vwap, ownTop: own.top, oppTop: opp.top },
    };
  }
  function kickoffMs(ticker) { const e = books.get(String(ticker).toUpperCase()); return e && Number.isFinite(e.kickoffMs) ? e.kickoffMs : null; }
  function tickers() { return [...books.keys()]; }
  function takeFails() { const f = { ...fails }; for (const k of Object.keys(fails)) fails[k] = 0; return f; }

  // Kalshi KXNFLTD market titles ("Derrick Henry: 1+ touchdowns") -> player names for matching.
  function setNames(markets) {
    let n = 0;
    for (const m of markets || []) {
      const t = String((m && m.ticker) || '').toUpperCase();
      if (!isTdTicker(t)) continue;
      const nm = String((m && (m.title || m.yes_sub_title)) || '').split(':')[0].trim();
      if (nm) { names.set(t, nm); n += 1; }
    }
    return n;
  }
  function kalshiIndex() {
    const idx = new Map(); // gameKey -> [{ ticker, name, team }]
    for (const [ticker, name] of names) {
      const g = gameKeyFromTicker(ticker);
      if (!g) continue;
      const team = g.teams.map((x) => x.toUpperCase()).sort((a, b) => b.length - a.length).find((x) => g.player.startsWith(x)) || '';
      if (!idx.has(g.key)) idx.set(g.key, []);
      idx.get(g.key).push({ ticker, name, team });
    }
    return idx;
  }

  // Relay /td rows for one venue -> per Kalshi ticker $500 VWAPs (each side, venue fee included).
  // A market matches when the game (teams + ET date) is the same and exactly one Kalshi player
  // in that game has the same name (suffixes / initials handled) and a compatible team.
  function ingestVenue(venue, rows, { polledAt = now() } = {}) {
    if (!venueBooks.has(venue)) venueBooks.set(venue, new Map());
    const vb = venueBooks.get(venue);
    const st = matchStats[venue] || (matchStats[venue] = { matched: 0, unmatched: 0, ambiguous: 0 });
    const idx = kalshiIndex();
    const seen = new Set();
    for (const r of rows || []) {
      if (!r || !r.player) continue;
      let cands = [];
      for (const k of venueGameKeys(r.away, r.home, r.start)) {
        const list = idx.get(k);
        if (!list) continue;
        cands = list.filter((c) => samePlayer(c.name, r.player) && teamsCompatible(c.team, r.team));
        if (cands.length) break;
      }
      if (cands.length !== 1) { st[cands.length ? 'ambiguous' : 'unmatched'] += 1; continue; }
      st.matched += 1;
      const ticker = cands[0].ticker;
      const startMs = Date.parse(r.start || '') || 0;
      const live = r.live === true || (startMs > 0 && polledAt >= startMs);
      const feeFn = VENUE_FEE[venue] ? VENUE_FEE[venue](r.fee_coefficient, live) : () => 0;
      const lv = (a) => (Array.isArray(a) ? a.map((x) => [Number(x.odds), Number(x.size)]).filter(([p, q]) => p > 0 && p < 1 && q > 0).sort((x, y) => x[0] - y[0]) : []);
      const y = vwapFor(lv(r.yes), depthUsd, feeFn);
      const n = vwapFor(lv(r.no), depthUsd, feeFn);
      const at = Math.min(polledAt, Math.max(Date.parse(r.confirmed_at || '') || 0, Date.parse(r.updated_at || '') || 0));
      let fail = null;
      if (!y || !n) fail = 'depth';
      else if (y.vwap + n.vwap - 1 > maxOverround) fail = 'overround';
      vb.set(ticker, { y, n, fail, at, key: r.market || null, live });
      seen.add(ticker);
    }
    return seen.size;
  }

  // Inverse bet across Kalshi + relay venues for one TD leg {id: ticker, side}.
  function legMulti(leg) {
    const t = String(leg.id || leg.ticker || '').toUpperCase();
    const isNo = leg.side === 'no';
    const sources = [];
    const evalEntry = (venue, e) => {
      if (!e) return null;
      const age = now() - e.at;
      const out = { venue, via: 'td_opposite', key: venue === 'kalshi' ? t : (e.key || null), ageMs: Math.round(age) };
      const opp = e.y && e.n ? (isNo ? e.y : e.n) : null;
      if (opp) { out.topAmerican = american(opp.top); out.topUsd = Math.round(opp.topUsd * 100) / 100; }
      if (age > staleMs) return { ...out, used: false, reason: 'stale' };
      if (e.fail) return { ...out, used: false, reason: e.fail };
      return { ...out, used: true, reason: 'ok', cost: opp.vwap, availUsd: opp.availUsd, costAmerican: american(opp.vwap) };
    };
    const k = books.get(t);
    const ks = evalEntry('kalshi', k);
    if (ks) sources.push(ks);
    for (const [venue, vb] of venueBooks) {
      const r = evalEntry(venue, vb.get(t));
      if (r) sources.push(r);
    }
    const used = sources.filter((x) => x.used);
    if (!used.length) return { p: null, best: null, sources };
    const best = used.reduce((a, b) => (b.cost < a.cost ? b : a));
    const p = 1 - best.cost;
    return { p: p > 0 && p < 1 ? p : null, best: best.venue, sources };
  }
  function takeMatchStats() { const out = JSON.parse(JSON.stringify(matchStats)); for (const k of Object.keys(matchStats)) delete matchStats[k]; return out; }
  function venueSize(v) { const vb = venueBooks.get(v); return vb ? vb.size : 0; }

  return { ingest, legStats, kickoffMs, tickers, takeFails, size: () => books.size, setNames, ingestVenue, legMulti, takeMatchStats, venueSize, names, _books: books, _venueBooks: venueBooks };
}

module.exports = { createTdBook, parseTdTicker, isTdTicker, vwapFor, laddersFromBook, samePlayer, normalizePlayerName, teamsCompatible, venueGameKeys, gameKeyFromTicker, DEPTH_USD, THETA, POLY_THETA };
