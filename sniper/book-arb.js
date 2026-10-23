// Sportsbook arb check for sniper FILLS (alert-only — this module never places a bet anywhere).
// We sold the taker a parlay on Kalshi, so we hold NO on n contracts for risk R (cost + fee).
// If a domestic sportsbook pays MORE for the same parlay's YES (decimal D), betting S = n / D
// there locks the same profit whichever way it goes:
//   parlay hits : S·(D−1) − R          parlay misses: n − R − S
//   equal when S·D = n  →  locked = n·(1 − 1/D) − R,  ROI = locked / (R + S)
// Arb exists iff 1/D < 1 − R/n (book's implied YES is below the price we effectively sold at).
//
// Book prices come from data we already pull (no new API spend):
//   anytime TD Yes: Supabase player_prop_cache (Odds API us/us2 books, ~5 min)
//   moneyline:      Supabase odds_cache h2h (Odds API featured)
//   NFL spread/total: odds_cache spreads/totals. Kalshi strike rule: number − 0.5 (HOU11 = HOU −10.5,
//                   DALPHI-45 = 44.5). A book counts ONLY when its line is exactly that number.
//   NCAAF (FBS) ML/spread/total: odds_cache americanfootball_ncaaf; team identity through the verified
//                   ncaaf-crosswalk names (sniper/ncaaf codeForName, mascots stripped). Kalshi dates college
//                   tickers a day early, so the ticker date OR the next ET day is accepted (#241 rule) and the
//                   game is used only when EXACTLY ONE odds_cache game matches.
// Limits (reported per fill, never guessed):
//   • TD "No" legs: US books don't offer "no touchdown" → that parlay isn't hedgeable there.
//   • Same-game legs: books price SGP correlation themselves; the product of leg prices is only
//     an estimate, so those rows are flagged "SGP — check the book's own price".
//   • A book counts only if it quotes EVERY leg.
'use strict';
const L = require('./lines');
const N = require('./ncaaf');
const X = require('../ncaaf-crosswalk');
const { ncaafCandidates } = require('./kickoff');
const { etDate } = require('../mm-paper-odds');
const BOOKS = {
  draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', williamhill_us: 'Caesars', fanatics: 'Fanatics',
  espnbet: 'ESPN BET', thescore: 'theScore', betrivers: 'BetRivers', hardrockbet: 'Hard Rock', ballybet: 'Bally Bet',
  betparx: 'betPARX', bovada: 'Bovada', betonlineag: 'BetOnline', mybookieag: 'MyBookie', lowvig: 'LowVig', betus: 'BetUS',
};
const EXCHANGES = new Set(['kalshi', 'polymarket', 'novig', 'prophetx', 'underdog', 'underdog_predict', 'betfair_ex_us']);
const NFL = {
  'Arizona Cardinals': 'ARI', 'Atlanta Falcons': 'ATL', 'Baltimore Ravens': 'BAL', 'Buffalo Bills': 'BUF', 'Carolina Panthers': 'CAR',
  'Chicago Bears': 'CHI', 'Cincinnati Bengals': 'CIN', 'Cleveland Browns': 'CLE', 'Dallas Cowboys': 'DAL', 'Denver Broncos': 'DEN',
  'Detroit Lions': 'DET', 'Green Bay Packers': 'GB', 'Houston Texans': 'HOU', 'Indianapolis Colts': 'IND', 'Jacksonville Jaguars': 'JAC',
  'Kansas City Chiefs': 'KC', 'Las Vegas Raiders': 'LV', 'Los Angeles Chargers': 'LAC', 'Los Angeles Rams': 'LAR', 'Miami Dolphins': 'MIA',
  'Minnesota Vikings': 'MIN', 'New England Patriots': 'NE', 'New Orleans Saints': 'NO', 'New York Giants': 'NYG', 'New York Jets': 'NYJ',
  'Philadelphia Eagles': 'PHI', 'Pittsburgh Steelers': 'PIT', 'San Francisco 49ers': 'SF', 'Seattle Seahawks': 'SEA',
  'Tampa Bay Buccaneers': 'TB', 'Tennessee Titans': 'TEN', 'Washington Commanders': 'WAS',
};
const ALIAS = { JAX: 'JAC', LA: 'LAR', WSH: 'WAS' };
const canon = (a) => ALIAS[String(a || '').toUpperCase()] || String(a || '').toUpperCase();
const letters = (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
const decOf = (am) => { const a = Number(am); if (!Number.isFinite(a) || a === 0) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; };
const amOf = (dec) => { if (!(dec > 1)) return null; return dec >= 2 ? Math.round((dec - 1) * 100) : -Math.round(100 / (dec - 1)); };
const fmtAm = (a) => (a == null ? '—' : a > 0 ? `+${a}` : `${a}`);

// KXNFLTD-26OCT25CINBAL-BALDHENRY22-1:no → { kind:'td', game:'CINBAL', team:'BAL', code:'DHENRY', side:'no' }
function parseLeg(key) {
  const [tk, sideRaw] = String(key || '').split(':'); const t = tk.toUpperCase(); const p = t.split('-');
  const side = String(sideRaw || 'yes').toLowerCase();
  const game = (p[1] || '').replace(/^\d{2}[A-Z]{3}\d{2}/, '');
  if (t.startsWith('KXNFLTD-')) {
    const code = (p[2] || '').replace(/\d+$/, '');
    // team prefix: 2–3 letters that appear at the start or end of the game code
    const team = [3, 2].map((n) => code.slice(0, n)).find((x) => game.startsWith(x) || game.endsWith(x)) || code.slice(0, 3);
    return { kind: 'td', ticker: t, game, team, player: code.slice(team.length), side };
  }
  if (t.startsWith('KXNFLGAME-')) return { kind: 'ml', ticker: t, game, team: p[2] || '', side };
  if (L.isLineTicker(t)) {
    const g = L.parseLineTicker(t);
    if (!g) return { kind: 'other', type: `${String(p[0]).includes('NCAAF') ? 'ncaaf' : 'nfl'}_${String(p[0]).includes('TOTAL') ? 'total' : 'spread'}`, ticker: t, game, side };
    return { kind: 'line', league: g.league, market: g.market, ticker: t, game, side, date: g.date, teams: g.teams, gameId: g.gameId, fbs: g.fbs, line: g.line, sel: g.sel };
  }
  if (N.isNcaafTicker(t)) {
    const g = N.parseNcaafMl(t);
    if (!g) return { kind: 'other', type: 'ncaaf_ml', ticker: t, game, side };
    return { kind: 'ncaaf_ml', ticker: t, game, side, date: g.date, teams: g.codes, gameId: g.gameId, team: g.selection, fbs: g.codes.every(N.isFbs) };
  }
  return { kind: 'other', ticker: t, game, side };
}
// Leg type for the coverage line: nfl_ml, nfl_td_yes, nfl_td_no, nfl_spread, nfl_total, ncaaf_ml, ncaaf_spread, ncaaf_total, other.
function legType(leg) {
  if (leg.kind === 'td') return leg.side === 'no' ? 'nfl_td_no' : 'nfl_td_yes';
  if (leg.kind === 'ml') return 'nfl_ml';
  if (leg.kind === 'line') return `${leg.league}_${leg.market}`;
  if (leg.kind === 'ncaaf_ml') return 'ncaaf_ml';
  return leg.type || 'other';
}
const TYPE_LABEL = { nfl_ml: 'NFL ML', nfl_td_yes: 'TD Yes', nfl_td_no: 'TD No (unhedgeable)', nfl_spread: 'NFL spread', nfl_total: 'NFL total', ncaaf_ml: 'NCAAF ML', ncaaf_spread: 'NCAAF spread', ncaaf_total: 'NCAAF total', other: 'Other' };

// Odds API college name ("Miami (OH) RedHawks") -> Kalshi code via the crosswalk names, dropping the
// mascot one word at a time (longest known prefix wins). Names "miami" alone are ambiguous => aliases.
const NCAAF_ODDS_ALIASES = { 'miami hurricanes': 'MIA', 'miami oh redhawks': 'MOH' };
function ncaafCodeOfOddsName(name) {
  const n = X.norm(name); if (NCAAF_ODDS_ALIASES[n]) return NCAAF_ODDS_ALIASES[n];
  const w = n.split(' ');
  for (let k = w.length; k > 0; k -= 1) { const c = N.codeForName(w.slice(0, k).join(' ')); if (c) return c; }
  return null;
}
// Exactly one odds_cache game for this Kalshi college gameId (ticker date or next ET day).
function findNcaafEvent(gameId, ncaafOdds) {
  const want = new Set(ncaafCandidates(gameId));
  const hits = (ncaafOdds || []).filter((ev) => {
    const a = ncaafCodeOfOddsName(ev.away_team); const h = ncaafCodeOfOddsName(ev.home_team); const d = etDate(ev.commence_time);
    return a && h && a !== h && d && want.has(`ncaaf|${d}|${[a, h].sort().join('+')}`);
  });
  if (hits.length !== 1) return { ev: null, reason: hits.length ? 'ncaaf_game_ambiguous' : 'game_not_found' };
  const ev = hits[0];
  return { ev, nameOf: (code) => (ncaafCodeOfOddsName(ev.away_team) === code ? ev.away_team : ncaafCodeOfOddsName(ev.home_team) === code ? ev.home_team : null) };
}
// Book prices for one outcome of an Odds API event. point: exact number required (null = h2h).
function eventPrices(ev, mkey, outName, point) {
  const prices = {};
  for (const b of ev.bookmakers || []) {
    if (EXCHANGES.has(b.key) || !BOOKS[b.key]) continue; // US sportsbooks only
    const m = (b.markets || []).find((x) => x.key === mkey); if (!m) continue;
    const o = (m.outcomes || []).find((x) => x.name === outName && (point == null || Number(x.point) === point));
    if (o && Number.isFinite(Number(o.price))) prices[b.key] = Number(o.price);
  }
  return prices;
}
const fmtLine = (x) => (x > 0 ? `+${x}` : `${x}`);
function linePrices(leg, ev, nameOf) {
  if (leg.market === 'total') {
    const over = leg.side === 'yes'; const prices = eventPrices(ev, 'totals', over ? 'Over' : 'Under', leg.line);
    return { prices, name: `${over ? 'Over' : 'Under'} ${leg.line}`, reason: Object.keys(prices).length ? 'ok' : 'no_book_on_exact_line' };
  }
  // Yes = sel −line ; No = other team +line
  const opp = leg.teams.find((x) => x !== leg.sel); const team = leg.side === 'yes' ? leg.sel : opp;
  const pt = leg.side === 'yes' ? -leg.line : leg.line; const full = nameOf(team);
  if (!full) return { prices: {}, reason: 'game_not_found' };
  const prices = eventPrices(ev, 'spreads', full, pt);
  return { prices, name: `${team} ${fmtLine(pt)}`, reason: Object.keys(prices).length ? 'ok' : 'no_book_on_exact_line' };
}

const gameHas = (game, a) => { const x = canon(a); return game.startsWith(x) || game.endsWith(x) || game.includes(x); };

// "DHENRY" vs "Derrick Henry"; "ASTBROWN" vs "Amon-Ra St. Brown"; "JSMITHNJIGBA" vs "Jaxon Smith-Njigba"
function nameMatches(code, name) {
  const parts = String(name || '').replace(/\b(Jr|Sr|II|III|IV)\.?$/i, '').trim().split(/\s+/);
  if (parts.length < 2) return false;
  const first = letters(parts[0]); const last = letters(parts.slice(1).join(''));
  return code === first[0] + last || code === first + last || (code.endsWith(last) && code[0] === first[0]);
}

// Book YES prices for one leg → { [book]: american } (sportsbooks only, not exchanges).
function bookPricesForLeg(leg, { props = [], odds = [], ncaafOdds = [] }) {
  if (leg.kind === 'td') {
    if (leg.side !== 'yes') return { prices: {}, reason: 'td_no_not_offered' };
    for (const g of props) {
      const d = g.data || g; const [a, h] = String(d.gameKey || '').split('|');
      if (!(gameHas(leg.game, a) && gameHas(leg.game, h))) continue;
      const pl = (d.players || []).find((x) => canon(x.team) === canon(leg.team) && nameMatches(leg.player, x.name));
      if (!pl) return { prices: {}, reason: 'player_not_found' };
      const offers = (((pl.markets || {}).anytime || {}).offers) || [];
      const prices = {};
      for (const o of offers) if (!EXCHANGES.has(o.book) && Number.isFinite(Number(o.price))) prices[o.book] = Number(o.price);
      return { prices, name: pl.name, reason: Object.keys(prices).length ? 'ok' : 'no_books' };
    }
    // player_prop_cache only pulls games within 72h of kickoff; the re-check picks it up later.
    return { prices: {}, reason: 'td_props_not_posted_yet' };
  }
  if (leg.kind === 'ml') {
    for (const ev of odds) {
      const a = NFL[ev.away_team]; const h = NFL[ev.home_team];
      if (!(a && h && gameHas(leg.game, a) && gameHas(leg.game, h))) continue;
      const pick = leg.side === 'yes' ? canon(leg.team) : (canon(leg.team) === a ? h : a);
      const full = Object.keys(NFL).find((k) => NFL[k] === pick);
      const prices = eventPrices(ev, 'h2h', full, null);
      return { prices, name: `${pick} ML`, reason: Object.keys(prices).length ? 'ok' : 'no_books' };
    }
    return { prices: {}, reason: 'game_not_found' };
  }
  if (leg.kind === 'line' && leg.league === 'nfl') {
    for (const ev of odds) {
      const a = canon(NFL[ev.away_team]); const h = canon(NFL[ev.home_team]);
      const tm = leg.teams.map(canon);
      if (!(a && h && tm.includes(a) && tm.includes(h))) continue;
      const nameOf = (code) => Object.keys(NFL).find((k) => canon(NFL[k]) === canon(code)) || null;
      return linePrices({ ...leg, sel: leg.sel && canon(leg.sel), teams: tm }, ev, nameOf);
    }
    return { prices: {}, reason: 'game_not_found' };
  }
  if ((leg.kind === 'line' && leg.league === 'ncaaf') || leg.kind === 'ncaaf_ml') {
    if (!leg.fbs) return { prices: {}, reason: 'ncaaf_fcs' };
    const f = findNcaafEvent(leg.gameId, ncaafOdds);
    if (!f.ev) return { prices: {}, reason: f.reason };
    if (leg.kind === 'line') return linePrices(leg, f.ev, f.nameOf);
    const pick = leg.side === 'yes' ? leg.team : leg.teams.find((x) => x !== leg.team);
    const full = f.nameOf(pick); if (!full) return { prices: {}, reason: 'game_not_found' };
    const prices = eventPrices(f.ev, 'h2h', full, null);
    return { prices, name: `${pick} ML`, reason: Object.keys(prices).length ? 'ok' : 'no_books' };
  }
  return { prices: {}, reason: 'unsupported_leg' };
}

// fill: { legs: ['TICKER:side', ...], contracts, cost, fee }
function checkFill(fill, data, { minProfit = 0.01 } = {}) {
  const n = Number(fill.contracts) || 0; const R = (Number(fill.cost) || 0) + (Number(fill.fee) || 0);
  const legs = (fill.legs || []).map(parseLeg);
  const games = new Set(legs.map((l) => l.game)); const sgp = games.size < legs.length;
  const legInfo = legs.map((l) => ({ ...l, ...bookPricesForLeg(l, data) }));
  const blocked = legInfo.filter((l) => l.reason !== 'ok');
  const soldYes = n > 0 ? 1 - R / n : null; // effective YES price we sold at (fee included)
  const base = { contracts: n, risk: R, soldAmerican: soldYes ? amOf(1 / soldYes) : null, sgp, legs: legInfo.map((l) => ({ ticker: l.ticker, side: l.side, type: legType(l), name: l.name || null, reason: l.reason, prices: l.prices })) };
  if (blocked.length) {
    const why = blocked.some((l) => l.reason === 'td_no_not_offered') ? 'td_no_not_offered' : blocked[0].reason;
    return { ...base, hedgeable: false, reason: why, books: [], best: null };
  }
  const bookSet = Object.keys(legInfo[0].prices).filter((b) => legInfo.every((l) => l.prices[b] != null));
  const books = bookSet.map((b) => {
    const D = legInfo.reduce((x, l) => x * decOf(l.prices[b]), 1);
    const stake = n / D; const locked = n * (1 - 1 / D) - R;
    return { book: b, label: BOOKS[b] || b, decimal: D, american: amOf(D), stake, locked, roi: locked / (R + stake), arb: locked >= minProfit };
  }).sort((x, y) => y.locked - x.locked);
  if (!books.length) return { ...base, hedgeable: false, reason: 'no_book_has_every_leg', books: [], best: null };
  const best = books[0];
  return { ...base, hedgeable: true, reason: best.arb ? 'arb' : 'no_arb', books, best };
}

// Coverage over a set of checkFill results: which fills (and leg types) a sportsbook can price.
// A fill is priceable when at least one book quotes EVERY leg. TD "No" legs are never priceable
// (US books don't sell "no touchdown") and are counted explicitly so the blind spot stays visible.
function coverage(results) {
  const byType = {}; let priceable = 0; let tdNoFills = 0; const why = {};
  for (const r of results || []) {
    if (!r) continue;
    if (r.hedgeable) priceable += 1; else why[r.reason] = (why[r.reason] || 0) + 1;
    if ((r.legs || []).some((l) => l.type === 'nfl_td_no')) tdNoFills += 1;
    for (const l of r.legs || []) {
      const t = byType[l.type] || (byType[l.type] = { legs: 0, priced: 0, fills: 0, fillsPriceable: 0 });
      t.legs += 1; if (l.reason === 'ok') t.priced += 1;
    }
    for (const ty of new Set((r.legs || []).map((l) => l.type))) { byType[ty].fills += 1; if (r.hedgeable) byType[ty].fillsPriceable += 1; }
  }
  return { fills: (results || []).filter(Boolean).length, priceable, tdNoFills, byType, unpriceableReasons: why };
}
const ORDER = Object.keys(TYPE_LABEL);
function formatCoverage(c) {
  const parts = Object.keys(c.byType).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
    .map((t) => `${TYPE_LABEL[t] || t} ${c.byType[t].priced}/${c.byType[t].legs} legs`);
  return `Coverage: ${c.priceable} of ${c.fills} open fills priceable at a US book · ${parts.join(' · ')}${c.tdNoFills ? ` · ${c.tdNoFills} fill(s) blocked by TD No legs` : ''}`;
}
function formatCoverageSummary(c, arbs = []) {
  const lines = ['📊 SNIPER ARB-OUT COVERAGE (alert only)', formatCoverage(c), ''];
  for (const t of Object.keys(c.byType).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))) {
    const v = c.byType[t]; lines.push(`${TYPE_LABEL[t] || t}: ${v.priced}/${v.legs} legs priced · ${v.fillsPriceable}/${v.fills} fills priceable`);
  }
  const why = Object.entries(c.unpriceableReasons).sort((a, b) => b[1] - a[1]);
  if (why.length) lines.push('', `Not priceable: ${why.map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  lines.push('', arbs.length ? `Arbs open now: ${arbs.length} (best ${usd(Math.max(...arbs.map((a) => a.best.locked)))} locked)` : 'Arbs open now: none');
  return lines.join('\n');
}

const usd = (x) => `$${Number(x || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Telegram alert, same style as the fill alert. Returns null when there's nothing to alert.
function formatArbAlert(r, { legLabel = (t) => t, coverageLine = null } = {}) {
  if (!r || !r.best || !r.best.arb) return null;
  const b = r.best; const others = r.books.filter((x) => x.arb && x !== b).slice(0, 3);
  const lines = ['💰 SNIPER ARB (alert only — no bet placed)', `A sportsbook pays more for the parlay we just sold (${r.legs.length} legs)`, ''];
  r.legs.forEach((l, i) => lines.push(`${i + 1}. ${legLabel(l.ticker, l.side, l.name)}  ${fmtAm(l.prices[b.book])} at ${b.label}`));
  lines.push('', `Book: ${b.label}`, `Book odds: ${fmtAm(b.american)}`, `We sold at: ${fmtAm(r.soldAmerican)}`,
    `Bet: ${usd(b.stake)} on the parlay at ${b.label}`, `Locked profit: ${usd(b.locked)} either way (${(b.roi * 100).toFixed(1)}% ROI)`);
  if (others.length) lines.push(`Also: ${others.map((o) => `${o.label} ${fmtAm(o.american)} (${usd(o.locked)})`).join(' · ')}`);
  if (r.sgp) lines.push('', '⚠️ Same-game legs: the book prices correlation itself. Check the book’s own parlay price first.');
  lines.push('', 'Lines move: confirm the price in the book before betting.');
  if (coverageLine) lines.push(coverageLine);
  return lines.join('\n');
}

// Supabase reads (service key from env; never logged).
async function loadBookData({ url, key, fetchImpl = fetch }) {
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  const since = new Date(Date.now() - 6 * 3600e3).toISOString();
  const [p, o, c] = await Promise.all([
    fetchImpl(`${url}/rest/v1/player_prop_cache?sport=eq.americanfootball_nfl&commence_time=gte.${since}&select=data,fetched_at`, { headers: h }),
    fetchImpl(`${url}/rest/v1/odds_cache?sport=eq.americanfootball_nfl&select=data,fetched_at&order=fetched_at.desc&limit=1`, { headers: h }),
    fetchImpl(`${url}/rest/v1/odds_cache?sport=eq.americanfootball_ncaaf&select=data,fetched_at&order=fetched_at.desc&limit=1`, { headers: h }),
  ]);
  if (!p.ok) throw new Error(`player_prop_cache ${p.status}`);
  if (!o.ok) throw new Error(`odds_cache ${o.status}`);
  if (!c.ok) throw new Error(`odds_cache ncaaf ${c.status}`);
  const props = await p.json(); const oj = await o.json(); const cj = await c.json();
  return { props, odds: (oj[0] && oj[0].data) || [], ncaafOdds: (cj[0] && cj[0].data) || [] };
}

module.exports = { coverage, formatCoverage, formatCoverageSummary, legType, ncaafCodeOfOddsName, findNcaafEvent, checkFill, formatArbAlert, loadBookData, parseLeg, nameMatches, bookPricesForLeg, decOf, amOf, BOOKS };
