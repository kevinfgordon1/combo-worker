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
// Limits (reported per fill, never guessed):
//   • TD "No" legs: US books don't offer "no touchdown" → that parlay isn't hedgeable there.
//   • Same-game legs: books price SGP correlation themselves; the product of leg prices is only
//     an estimate, so those rows are flagged "SGP — check the book's own price".
//   • A book counts only if it quotes EVERY leg.
'use strict';
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
  return { kind: 'other', ticker: t, game, side };
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
function bookPricesForLeg(leg, { props = [], odds = [] }) {
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
      const prices = {};
      for (const b of ev.bookmakers || []) {
        if (EXCHANGES.has(b.key)) continue;
        const m = (b.markets || []).find((x) => x.key === 'h2h'); const o = m && m.outcomes.find((x) => x.name === full);
        if (o && Number.isFinite(Number(o.price))) prices[b.key] = Number(o.price);
      }
      return { prices, name: `${pick} ML`, reason: Object.keys(prices).length ? 'ok' : 'no_books' };
    }
    return { prices: {}, reason: 'game_not_found' };
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
  const base = { contracts: n, risk: R, soldAmerican: soldYes ? amOf(1 / soldYes) : null, sgp, legs: legInfo.map((l) => ({ ticker: l.ticker, side: l.side, name: l.name || null, reason: l.reason, prices: l.prices })) };
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

const usd = (x) => `$${Number(x || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Telegram alert, same style as the fill alert. Returns null when there's nothing to alert.
function formatArbAlert(r, { legLabel = (t) => t } = {}) {
  if (!r || !r.best || !r.best.arb) return null;
  const b = r.best; const others = r.books.filter((x) => x.arb && x !== b).slice(0, 3);
  const lines = ['💰 SNIPER ARB (alert only — no bet placed)', `A sportsbook pays more for the parlay we just sold (${r.legs.length} legs)`, ''];
  r.legs.forEach((l, i) => lines.push(`${i + 1}. ${legLabel(l.ticker, l.side, l.name)}  ${fmtAm(l.prices[b.book])} at ${b.label}`));
  lines.push('', `Book: ${b.label}`, `Book odds: ${fmtAm(b.american)}`, `We sold at: ${fmtAm(r.soldAmerican)}`,
    `Bet: ${usd(b.stake)} on the parlay at ${b.label}`, `Locked profit: ${usd(b.locked)} either way (${(b.roi * 100).toFixed(1)}% ROI)`);
  if (others.length) lines.push(`Also: ${others.map((o) => `${o.label} ${fmtAm(o.american)} (${usd(o.locked)})`).join(' · ')}`);
  if (r.sgp) lines.push('', '⚠️ Same-game legs: the book prices correlation itself. Check the book’s own parlay price first.');
  lines.push('', 'Lines move: confirm the price in the book before betting.');
  return lines.join('\n');
}

// Supabase reads (service key from env; never logged).
async function loadBookData({ url, key, fetchImpl = fetch }) {
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  const since = new Date(Date.now() - 6 * 3600e3).toISOString();
  const [p, o] = await Promise.all([
    fetchImpl(`${url}/rest/v1/player_prop_cache?sport=eq.americanfootball_nfl&commence_time=gte.${since}&select=data,fetched_at`, { headers: h }),
    fetchImpl(`${url}/rest/v1/odds_cache?sport=eq.americanfootball_nfl&select=data,fetched_at&order=fetched_at.desc&limit=1`, { headers: h }),
  ]);
  if (!p.ok) throw new Error(`player_prop_cache ${p.status}`);
  if (!o.ok) throw new Error(`odds_cache ${o.status}`);
  const props = await p.json(); const oj = await o.json();
  return { props, odds: (oj[0] && oj[0].data) || [] };
}

module.exports = { checkFill, formatArbAlert, loadBookData, parseLeg, nameMatches, bookPricesForLeg, decOf, amOf, BOOKS };
