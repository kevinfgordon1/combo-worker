// Sportsbook prices for the paper maker.
//
// Source: public.odds_cache rows written by aibetbuilder /api/fetch-odds
// (The Odds API, regions us/us2/us_ex/eu, h2h american). The in-repo odds
// relay publishes Kalshi and Polymarket quotes, not Pinnacle, so the
// inverse-bet guardrail reads this cache. This module only parses it.
//
// Exchange books stored in that cache (kalshi, polymarket, prophetx) are
// fee-adjusted by the site and are not a sportsbook. They are ignored.
// "Best" price is the highest American odds a bettor can take. Staleness is
// the cache row's fetched_at (the cron is every 5 minutes; default max age
// is 6 minutes). Books far from Pinnacle's implied probability are dropped
// when Pinnacle itself is in the snapshot.
'use strict';

const { impliedProb } = require('./mm-paper-math');

const EXCHANGE_BOOKS = new Set([
  'kalshi',
  'polymarket',
  'prophetx',
  'underdog_predict',
  'underdog',
]);

const SPORT_LEAGUE = {
  americanfootball_nfl: 'nfl',
  baseball_mlb: 'mlb',
  americanfootball_ncaaf: 'ncaaf',
};

const LEAGUE_SPORT = {
  nfl: 'americanfootball_nfl',
  mlb: 'baseball_mlb',
  ncaaf: 'americanfootball_ncaaf',
};

// Odds API display name → code used by Kalshi tickers / leg-identity.
const TEAM_CODES = {
  nfl: {
    'arizona cardinals': 'ari',
    'atlanta falcons': 'atl',
    'baltimore ravens': 'bal',
    'buffalo bills': 'buf',
    'carolina panthers': 'car',
    'chicago bears': 'chi',
    'cincinnati bengals': 'cin',
    'cleveland browns': 'cle',
    'dallas cowboys': 'dal',
    'denver broncos': 'den',
    'detroit lions': 'det',
    'green bay packers': 'gb',
    'houston texans': 'hou',
    'indianapolis colts': 'ind',
    'jacksonville jaguars': 'jax',
    'kansas city chiefs': 'kc',
    'las vegas raiders': 'lv',
    'los angeles chargers': 'lac',
    'los angeles rams': 'lar',
    'miami dolphins': 'mia',
    'minnesota vikings': 'min',
    'new england patriots': 'ne',
    'new orleans saints': 'no',
    'new york giants': 'nyg',
    'new york jets': 'nyj',
    'philadelphia eagles': 'phi',
    'pittsburgh steelers': 'pit',
    'san francisco 49ers': 'sf',
    'seattle seahawks': 'sea',
    'tampa bay buccaneers': 'tb',
    'tennessee titans': 'ten',
    'washington commanders': 'was',
  },
  mlb: {
    'arizona diamondbacks': 'az',
    'atlanta braves': 'atl',
    'baltimore orioles': 'bal',
    'boston red sox': 'bos',
    'chicago cubs': 'chc',
    'chicago white sox': 'cws',
    'cincinnati reds': 'cin',
    'cleveland guardians': 'cle',
    'colorado rockies': 'col',
    'detroit tigers': 'det',
    'houston astros': 'hou',
    'kansas city royals': 'kc',
    'los angeles angels': 'laa',
    'los angeles dodgers': 'lad',
    'miami marlins': 'mia',
    'milwaukee brewers': 'mil',
    'minnesota twins': 'min',
    'new york mets': 'nym',
    'new york yankees': 'nyy',
    'oakland athletics': 'ath',
    athletics: 'ath',
    'philadelphia phillies': 'phi',
    'pittsburgh pirates': 'pit',
    'san diego padres': 'sd',
    'san francisco giants': 'sf',
    'seattle mariners': 'sea',
    'st louis cardinals': 'stl',
    'st. louis cardinals': 'stl',
    'tampa bay rays': 'tb',
    'texas rangers': 'tex',
    'toronto blue jays': 'tor',
    'washington nationals': 'was',
  },
};

function normName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamCode(league, name) {
  const map = TEAM_CODES[league];
  if (!map) return null;
  const key = normName(name).replace(/\./g, '');
  if (map[key]) return map[key];
  const dotted = normName(name);
  return map[dotted] || null;
}

function etDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type) => {
    const hit = parts.find((p) => p.type === type);
    return hit ? hit.value : '';
  };
  const y = get('year');
  const m = get('month');
  const d = get('day');
  if (!y || !m || !d) return null;
  return `${y}-${m}-${d}`;
}

function etMinutes(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type) => {
    const hit = parts.find((p) => p.type === type);
    return hit ? Number(hit.value) : NaN;
  };
  const hh = get('hour');
  const mm = get('minute');
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

function h2hOutcomes(bookmaker) {
  const markets = bookmaker && bookmaker.markets;
  if (!Array.isArray(markets)) return [];
  const h2h = markets.find((m) => m && (m.key === 'h2h' || m.key === 'moneyline'));
  if (!h2h || !Array.isArray(h2h.outcomes)) return [];
  return h2h.outcomes;
}

function outcomeAmerican(outcome) {
  if (!outcome) return null;
  const n = Number(outcome.price);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

// Best bettor price on `teamName` inside one game snapshot.
// `now` and `fetchedAt` gate the whole snapshot. Pinnacle, when present,
// drops books whose implied probability is more than maxDev away.
function bestTeamPrice(game, teamName, { fetchedAt, now, maxAgeMs, pinnacleMaxDev } = {}) {
  if (!game || !teamName) return null;
  const observed = Date.parse(fetchedAt);
  if (!Number.isFinite(observed)) return null;
  if (Number.isFinite(now) && Number.isFinite(maxAgeMs) && (now - observed) > maxAgeMs) {
    return null;
  }
  const want = normName(teamName);
  const quotes = [];
  for (const book of game.bookmakers || []) {
    const key = String(book && book.key || '').toLowerCase();
    if (!key || EXCHANGE_BOOKS.has(key)) continue;
    const outcome = h2hOutcomes(book).find((o) => normName(o && o.name) === want);
    const american = outcomeAmerican(outcome);
    if (american == null) continue;
    const prob = impliedProb(american);
    if (prob == null) continue;
    quotes.push({
      book: key,
      title: book.title || key,
      american,
      prob,
      at: book.last_update || fetchedAt,
    });
  }
  if (!quotes.length) return null;
  const pin = quotes.find((q) => q.book === 'pinnacle');
  let pool = quotes;
  if (pin && pinnacleMaxDev != null && Number(pinnacleMaxDev) >= 0) {
    const dev = Number(pinnacleMaxDev);
    pool = quotes.filter((q) => q.book === 'pinnacle' || Math.abs(q.prob - pin.prob) <= dev + 1e-12);
  }
  if (!pool.length) return null;
  pool.sort((a, b) => b.american - a.american);
  return {
    ...pool[0],
    fetchedAt,
    pinnacleAmerican: pin ? pin.american : null,
    pinnacleProb: pin ? pin.prob : null,
  };
}

function sportsForLeagues(leagues) {
  const sports = [];
  for (const league of leagues || []) {
    if (LEAGUE_SPORT[league]) sports.push(LEAGUE_SPORT[league]);
  }
  return sports;
}

module.exports = {
  EXCHANGE_BOOKS,
  SPORT_LEAGUE,
  LEAGUE_SPORT,
  TEAM_CODES,
  normName,
  teamCode,
  etDate,
  etMinutes,
  bestTeamPrice,
  sportsForLeagues,
};
