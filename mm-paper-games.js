// Map Kalshi single-game moneylines and Polymarket US slugs onto one game,
// then attach odds_cache rows. Uses leg-identity for NFL/MLB (the Combo
// Locks parser). NCAAF/CFB tickers are parsed here so Combo Locks' series
// table stays unchanged.
'use strict';

const {
  parseKalshiTicker,
  kalshiTickerPieces,
  normTeam,
  makeIdentity,
  identityKey,
  identityFromPolymarketSlug,
} = require('./leg-identity');
const { teamCode, etDate, etMinutes, SPORT_LEAGUE, bestTeamPrice } = require('./mm-paper-odds');
const { parseKalshiTickerStart } = require('./started');

// Kickoff clock for the paper cutoff.
//
// Checked against live markets on 2026-09-28:
//   Polymarket US `gameStartTime` on aec-nfl-lar-den-2026-09-27 is
//   2026-09-28T00:20:00Z (Sun Sep 27, 8:20 PM ET) — the scheduled kickoff.
//   `startDate` on that market is 2026-09-13, when the market was listed.
//   It is not kickoff.
//   Kalshi NFL tickers are date-only (KXNFLGAME-26SEP27LARDEN). The ticker
//   clock below is null for them. MLB tickers do embed HHMM ET.
//   Kalshi open_time is listing time. close_time, expected_expiration_time,
//   and occurrence_datetime sit hours after kickoff (LAR/DEN occurrence
//   2026-09-28T03:20:00Z, expected expiration 06:20Z, close Sep 30). None of
//   those are kickoff, so they are not read.
//   odds_cache commence_time is The Odds API scheduled start, already matched
//   onto the game. It cross-checks Polymarket.
//
// chooseKickoff prefers Polymarket gameStartTime, then Odds API commence_time,
// then a Kalshi ticker clock when the ticker has one. Sources more than 10
// minutes apart: use the earlier time so quoting stops before the first
// claimed kickoff. No source at all means the game is not quotable.

const SERIES_LEAGUE = {
  KXNFLGAME: 'nfl',
  KXMLBGAME: 'mlb',
  KXNCAAFGAME: 'ncaaf',
};

function gameIdOf(league, date, teams) {
  const uniq = [...new Set((teams || []).map((t) => normTeam(league, t)).filter(Boolean))].sort();
  if (!league || !date || uniq.length < 2) return null;
  return `${league}|${date}|${uniq.join('+')}`;
}

// Minutes-of-day from a Kalshi ticker clock. Used only to sort the watch
// list and to reject an odds_cache row whose commence_time is hours away.
// NFL tickers have no clock, so this is null. It is not a kickoff cutoff.
function tickerStartMinutes(ticker) {
  const m = /-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/i.exec(String(ticker || ''));
  if (!m) return null;
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

const KICKOFF_AGREE_MS = 10 * 60 * 1000;

function finiteMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

// Full kickoff instant from a ticker that encodes HHMM America/New_York.
// Date-only NFL tickers return null. Market close/expiration fields are ignored.
function kalshiTickerKickoffMs(marketOrTicker) {
  const ticker = typeof marketOrTicker === 'string'
    ? marketOrTicker
    : (marketOrTicker && (marketOrTicker.ticker || marketOrTicker.event_ticker));
  return parseKalshiTickerStart(ticker);
}

// Polymarket US game start. gameStartTime is kickoff. startDate is listing time.
function polyKickoffMs(market) {
  if (!market || typeof market !== 'object') return null;
  return finiteMs(market.gameStartTime || market.game_start_time || null);
}

function formatKickoffEt(ms) {
  const t = finiteMs(ms);
  if (t == null) return null;
  const d = new Date(t);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type) => {
    const hit = parts.find((p) => p.type === type);
    return hit ? hit.value : '';
  };
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
  return `${date} ${time} ET`;
}

// sources: { polymarket, odds, kalshiTicker, restored } as ms or ISO.
function chooseKickoff(sources) {
  const specs = [
    ['polymarket', 'polymarket'],
    ['odds', 'odds'],
    ['kalshiTicker', 'kalshi_ticker'],
    ['restored', 'restored'],
  ];
  const rows = [];
  for (const [key, source] of specs) {
    const at = finiteMs(sources && sources[key]);
    if (at != null) rows.push({ source, at });
  }
  if (!rows.length) return null;
  const primary = rows[0];
  let chosen = primary;
  const disagreements = [];
  for (const row of rows) {
    if (row === primary) continue;
    if (Math.abs(row.at - primary.at) <= KICKOFF_AGREE_MS) continue;
    const deltaMin = Math.round((row.at - primary.at) / 60000);
    disagreements.push(`${row.source} ${deltaMin > 0 ? '+' : ''}${deltaMin}m`);
    if (row.at < chosen.at) chosen = row;
  }
  let note = null;
  if (disagreements.length) {
    note = chosen === primary
      ? `cross-check ${disagreements.join(', ')}`
      : `using earlier ${chosen.source}; cross-check ${disagreements.join(', ')}`;
  }
  return {
    kickoffMs: chosen.at,
    source: chosen.source,
    note,
    agreed: disagreements.length === 0,
  };
}

function splitBySelection(blob, selection) {
  const b = String(blob || '').toLowerCase();
  const sel = String(selection || '').toLowerCase();
  if (!b || !sel || b.length <= sel.length) return null;
  if (b.startsWith(sel)) return [sel, b.slice(sel.length)];
  if (b.endsWith(sel)) return [b.slice(0, -sel.length), sel];
  return null;
}

// KXNCAAFGAME-26SEP03MASSRUTG-MASS → mass + rutg. Not wired into leg-identity,
// so Combo Locks matching is unchanged.
function parseNcaafTicker(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const noSide = raw.split(':')[0];
  const dash = noSide.indexOf('-');
  if (dash <= 0) return null;
  const series = noSide.slice(0, dash).toUpperCase();
  if (series !== 'KXNCAAFGAME') return null;
  const rest = noSide.slice(dash + 1);
  const timed = /^(\d{2})([A-Z]{3})(\d{2})(\d{4})(.*)$/i.exec(rest);
  const dated = !timed ? /^(\d{2})([A-Z]{3})(\d{2})(?!\d)(.*)$/i.exec(rest) : null;
  const hit = timed || dated;
  if (!hit) return null;
  const months = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
  };
  const year = 2000 + Number(hit[1]);
  const month = months[hit[2].toUpperCase()];
  const day = Number(hit[3]);
  if (!month || !day) return null;
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  let teamsBlob = timed ? (hit[5] || '') : (hit[4] || '');
  const selDash = teamsBlob.lastIndexOf('-');
  if (selDash <= 0) return null;
  const selection = teamsBlob.slice(selDash + 1);
  teamsBlob = teamsBlob.slice(0, selDash);
  if (!selection || /\d/.test(selection)) return null;
  const pair = splitBySelection(teamsBlob, selection);
  if (!pair) return null;
  const id = makeIdentity({
    league: 'ncaaf',
    date,
    teams: pair,
    marketType: 'moneyline',
    period: 'full',
    selection,
    side: 'yes',
  });
  if (!id) return null;
  return {
    league: 'ncaaf',
    date: id.date,
    teams: id.teams.slice(),
    selection: id.selection,
    ticker: noSide.toUpperCase(),
    rawTeams: pair.map((t) => String(t).toLowerCase()),
  };
}

function parseMoneylineTicker(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const ticker = raw.split(':')[0].toUpperCase();
  const series = ticker.split('-')[0];
  const league = SERIES_LEAGUE[series];
  if (!league) return null;
  if (league === 'ncaaf') return parseNcaafTicker(ticker);
  const id = parseKalshiTicker(ticker);
  if (!id || id.league !== league || id.marketType !== 'moneyline') return null;
  const pieces = kalshiTickerPieces(ticker);
  return {
    league: id.league,
    date: id.date,
    teams: id.teams.slice(),
    selection: id.selection,
    ticker,
    rawTeams: pieces && pieces.teams ? pieces.teams.map((t) => String(t).toLowerCase()) : id.teams.slice(),
  };
}

function legFromKalshiMarket(market) {
  if (!market || !market.ticker) return null;
  const parsed = parseMoneylineTicker(market.ticker);
  if (!parsed) return null;
  const subtitle = market.yes_sub_title || market.subtitle || market.title || '';
  return {
    ...parsed,
    subtitle: String(subtitle || ''),
    title: String(market.title || ''),
    eventTicker: market.event_ticker || null,
    startMinutes: tickerStartMinutes(market.ticker),
  };
}

// Group the two team markets of one game.
function groupKalshiMarkets(markets, leagues) {
  const allow = leagues instanceof Set ? leagues : new Set(leagues || []);
  const byGame = new Map();
  for (const market of markets || []) {
    const leg = legFromKalshiMarket(market);
    if (!leg || (allow.size && !allow.has(leg.league))) continue;
    const gameId = gameIdOf(leg.league, leg.date, leg.teams);
    if (!gameId) continue;
    let g = byGame.get(gameId);
    if (!g) {
      g = {
        gameId,
        league: leg.league,
        date: leg.date,
        teams: leg.teams.slice(),
        startMinutes: leg.startMinutes,
        kickoffMs: null,
        labels: {},
        rawTeams: leg.rawTeams.slice(),
        kalshi: {},
      };
      byGame.set(gameId, g);
    }
    if (g.startMinutes == null && leg.startMinutes != null) g.startMinutes = leg.startMinutes;
    const kick = kalshiTickerKickoffMs(leg.ticker);
    if (kick != null && (g.kickoffMs == null || kick < g.kickoffMs)) g.kickoffMs = kick;
    const team = normTeam(leg.league, leg.selection);
    if (!team) continue;
    g.kalshi[team] = {
      ticker: leg.ticker,
      subtitle: leg.subtitle,
      team,
    };
    if (leg.subtitle) g.labels[team] = leg.subtitle;
    for (const raw of leg.rawTeams) {
      if (raw && !g.rawTeams.includes(raw)) g.rawTeams.push(raw);
    }
  }
  const games = [];
  for (const g of byGame.values()) {
    if (Object.keys(g.kalshi).length < 2) continue;
    games.push(g);
  }
  return games;
}

function polySlugCandidates(game) {
  const date = game && game.date;
  const raw = (game && game.rawTeams && game.rawTeams.length >= 2)
    ? game.rawTeams
    : (game && game.teams) || [];
  const a = String(raw[0] || '').toLowerCase();
  const b = String(raw[1] || '').toLowerCase();
  if (!a || !b || !date) return [];
  const leagues = game.league === 'ncaaf' ? ['cfb', 'ncaaf'] : [game.league];
  const out = [];
  for (const lg of leagues) {
    if (!lg) continue;
    out.push(`aec-${lg}-${a}-${b}-${date}`);
    out.push(`aec-${lg}-${b}-${a}-${date}`);
  }
  return [...new Set(out)];
}

function polySlugMatchesGame(slug, game) {
  const id = identityFromPolymarketSlug(slug, 'yes');
  if (!id || !game) return false;
  return identityKey(id) && gameIdOf(id.league, id.date, id.teams) === game.gameId;
}

function nameTokens(name) {
  const stop = new Set(['university', 'college', 'the']);
  return new Set(
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t && t.length >= 3 && !stop.has(t))
  );
}

function tokenOverlap(a, b) {
  let n = 0;
  for (const t of nameTokens(a)) if (nameTokens(b).has(t)) n += 1;
  return n;
}

function oddsTeams(league, game) {
  const home = teamCode(league, game.home_team);
  const away = teamCode(league, game.away_team);
  if (home && away && home !== away) return { home, away, byName: false };
  return { home: null, away: null, byName: true };
}

function matchOddsToGame(oddsGame, game, { fetchedAt, now, maxAgeMs, pinnacleMaxDev } = {}) {
  if (!oddsGame || !game) return null;
  const league = game.league;
  if (etDate(oddsGame.commence_time) !== game.date) return null;
  const mapped = oddsTeams(league, oddsGame);
  let homeTeam = mapped.home;
  let awayTeam = mapped.away;
  if (mapped.byName) {
    const labels = game.labels || {};
    const teams = game.teams || [];
    const scored = teams.map((team) => ({
      team,
      home: tokenOverlap(oddsGame.home_team, labels[team] || ''),
      away: tokenOverlap(oddsGame.away_team, labels[team] || ''),
    }));
    const homeHit = scored.slice().sort((a, b) => b.home - a.home)[0];
    const awayHit = scored.slice().sort((a, b) => b.away - a.away)[0];
    if (!homeHit || !awayHit || homeHit.home < 1 || awayHit.away < 1 || homeHit.team === awayHit.team) {
      return null;
    }
    homeTeam = homeHit.team;
    awayTeam = awayHit.team;
  }
  const id = gameIdOf(league, game.date, [homeTeam, awayTeam]);
  if (id !== game.gameId) return null;
  if (game.startMinutes != null) {
    const mins = etMinutes(oddsGame.commence_time);
    if (mins == null) return null;
    const diff = Math.abs(mins - game.startMinutes);
    const wrapped = Math.min(diff, 1440 - diff);
    if (wrapped > 120) return null;
  }
  const homePx = bestTeamPrice(oddsGame, oddsGame.home_team, { fetchedAt, now, maxAgeMs, pinnacleMaxDev });
  const awayPx = bestTeamPrice(oddsGame, oddsGame.away_team, { fetchedAt, now, maxAgeMs, pinnacleMaxDev });
  if (!homePx && !awayPx) return null;
  const odds = {};
  if (homePx) odds[homeTeam] = homePx;
  if (awayPx) odds[awayTeam] = awayPx;
  const commenceMs = finiteMs(oddsGame.commence_time);
  return { gameId: game.gameId, odds, commenceMs };
}

function attachOdds(games, cacheRows, opts) {
  const byId = new Map();
  for (const g of games || []) byId.set(g.gameId, { ...g, odds: {}, commenceMs: null });
  for (const row of cacheRows || []) {
    const league = SPORT_LEAGUE[row && row.sport];
    if (!league) continue;
    const data = Array.isArray(row.data) ? row.data : [];
    for (const oddsGame of data) {
      let best = null;
      let bestDiff = Infinity;
      for (const g of byId.values()) {
        if (g.league !== league) continue;
        const linked = matchOddsToGame(oddsGame, g, {
          fetchedAt: row.fetched_at,
          now: opts && opts.now,
          maxAgeMs: opts && opts.maxAgeMs,
          pinnacleMaxDev: opts && opts.pinnacleMaxDev,
        });
        if (!linked) continue;
        const mins = g.startMinutes;
        const om = etMinutes(oddsGame.commence_time);
        const diff = mins == null || om == null ? 0 : Math.abs(om - mins);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = linked;
        }
      }
      if (!best) continue;
      const g = byId.get(best.gameId);
      g.odds = { ...g.odds, ...best.odds };
      if (best.commenceMs != null && (g.commenceMs == null || best.commenceMs < g.commenceMs)) {
        g.commenceMs = best.commenceMs;
      }
    }
  }
  return [...byId.values()];
}

module.exports = {
  SERIES_LEAGUE,
  gameIdOf,
  parseMoneylineTicker,
  parseNcaafTicker,
  legFromKalshiMarket,
  groupKalshiMarkets,
  polySlugCandidates,
  polySlugMatchesGame,
  matchOddsToGame,
  attachOdds,
  tokenOverlap,
  kalshiTickerKickoffMs,
  polyKickoffMs,
  chooseKickoff,
  formatKickoffEt,
  finiteMs,
  KICKOFF_AGREE_MS,
};
