// Cross-venue sports-leg identity for Combo Locks (Kalshi tickers) vs
// Polymarket comboLegs (market metadata).
//
// Combo Locks in this worker only persist Kalshi `TICKER:yes|no` / legs[].ticker
// — there is no team/date column. Tickers encode series + ET date + teams +
// selection, so we derive identity from that rather than waiting on a
// site-side polymarket_symbol column.
//
// Polymarket identity comes from market metadata (market_sport_type,
// event_start_time, long/short_participant_id), NOT from parsing the slug.
// Skip when metadata is missing, the market type is not a full-game moneyline
// Combo Locks can price, or more than one parlay matches.
'use strict';
const { parseKalshiTickerStart, parseTs } = require('./started');

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const SERIES = {
  KXMLBGAME: { league: 'mlb', marketType: 'moneyline', period: 'full', teamLen: 3 },
  KXNBAGAME: { league: 'nba', marketType: 'moneyline', period: 'full', teamLen: 3 },
  KXNHLGAME: { league: 'nhl', marketType: 'moneyline', period: 'full', teamLen: 3 },
  KXNFLGAME: { league: 'nfl', marketType: 'moneyline', period: 'full', teamLen: null },
};

const PRICEABLE_SPORT_TYPES = new Set([
  'baseball_team_full_game_winner',
  'basketball_team_full_game_winner',
  'football_team_full_game_winner',
  'hockey_team_full_game_winner',
]);

const SUBCATEGORY_LEAGUE = {
  BASEBALL: 'mlb',
  BASKETBALL: 'nba',
  FOOTBALL: 'nfl',
  HOCKEY: 'nhl',
};

// League-scoped aliases only — do not invent cross-league maps (CHI is Cubs, not Sox).
const TEAM_ALIASES = {
  mlb: { chw: 'cws', wsh: 'was', tbr: 'tb', sdp: 'sd', sfg: 'sf', kcr: 'kc' },
  nfl: { gnb: 'gb', jac: 'jax', wsh: 'was' },
  nba: { uta: 'utah', pho: 'phx', gsw: 'gs', nyk: 'ny', nop: 'no' },
  nhl: {},
};

const NFL_CODES = [
  'ari', 'atl', 'bal', 'buf', 'car', 'chi', 'cin', 'cle', 'dal', 'den', 'det',
  'gb', 'gnb', 'hou', 'ind', 'jac', 'jax', 'kc', 'lac', 'lar', 'lv', 'mia',
  'min', 'ne', 'no', 'nyg', 'nyj', 'phi', 'pit', 'sea', 'sf', 'tb', 'ten',
  'was', 'wsh',
].sort((a, b) => b.length - a.length);

const DT_RE = /^(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{4})(.*)$/i;

function normTeam(league, code) {
  const raw = String(code || '').trim().toLowerCase();
  if (!raw) return '';
  const aliases = TEAM_ALIASES[league] || {};
  return aliases[raw] || raw;
}

function participantCode(id) {
  const s = String(id || '').trim().toLowerCase();
  if (!s) return '';
  const i = s.lastIndexOf('-');
  return i === -1 ? s : s.slice(i + 1);
}

function leagueFromParticipant(id) {
  const s = String(id || '').trim().toLowerCase();
  const i = s.indexOf('-');
  if (i <= 0) return '';
  const prefix = s.slice(0, i);
  if (prefix === 'mlb' || prefix === 'nba' || prefix === 'nfl' || prefix === 'nhl') return prefix;
  return '';
}

function etDateFromMs(ms) {
  if (!Number.isFinite(ms)) return null;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(ms));
}

function etDateFromValue(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
  const raw = typeof v === 'string' ? v.trim().replace(' ', 'T') : v;
  const ms = parseTs(raw);
  return etDateFromMs(ms);
}

function splitTeams(blob, league, teamLen) {
  const s = String(blob || '').toLowerCase();
  if (!s) return null;
  if (teamLen && s.length === teamLen * 2) {
    return [s.slice(0, teamLen), s.slice(teamLen)];
  }
  if (league === 'nfl') {
    for (const a of NFL_CODES) {
      if (!s.startsWith(a)) continue;
      const rest = s.slice(a.length);
      if (NFL_CODES.includes(rest)) return [a, rest];
    }
  }
  if (s.length === 6) return [s.slice(0, 3), s.slice(3)];
  if (s.length === 4) return [s.slice(0, 2), s.slice(2)];
  return null;
}

function identityKey(id) {
  if (!id || !id.league || !id.date || !id.selection || !id.side || !id.marketType) return null;
  if (!Array.isArray(id.teams) || id.teams.length < 2) return null;
  const teams = id.teams.map((t) => normTeam(id.league, t)).filter(Boolean).sort();
  if (teams.length < 2) return null;
  return [
    id.league,
    id.date,
    teams.join('+'),
    id.marketType,
    id.period || 'full',
    normTeam(id.league, id.selection),
    id.side,
  ].join('|');
}

function makeIdentity(partial) {
  const id = {
    league: partial.league,
    date: partial.date,
    teams: (partial.teams || []).map((t) => normTeam(partial.league, t)).filter(Boolean),
    marketType: partial.marketType,
    period: partial.period || 'full',
    selection: normTeam(partial.league, partial.selection),
    side: partial.side,
  };
  if (id.teams.length >= 2) {
    const uniq = [...new Set(id.teams)].sort();
    id.teams = uniq;
  }
  return identityKey(id) ? id : null;
}

function parseKalshiTicker(text, sideOverride) {
  if (text == null || text === '') return null;
  let raw = String(text).trim();
  let side = sideOverride ? String(sideOverride).toLowerCase() : '';
  const sideAt = raw.lastIndexOf(':');
  if (sideAt > 0) {
    const maybe = raw.slice(sideAt + 1).toLowerCase();
    if (maybe === 'yes' || maybe === 'no') {
      if (!side) side = maybe;
      raw = raw.slice(0, sideAt);
    }
  }
  if (!side) side = 'yes';
  if (side !== 'yes' && side !== 'no') return null;

  let series = '';
  let rest = raw;
  const dash = raw.indexOf('-');
  if (dash > 0 && /^KX[A-Z]+$/i.test(raw.slice(0, dash))) {
    series = raw.slice(0, dash).toUpperCase();
    rest = raw.slice(dash + 1);
  }
  const spec = SERIES[series];
  if (!spec) return null;

  const m = DT_RE.exec(rest);
  if (!m) return null;
  const startMs = parseKalshiTickerStart(m[1] + m[2] + m[3] + m[4]);
  const date = etDateFromMs(startMs);
  if (!date) return null;

  let teamsBlob = m[5] || '';
  let selection = '';
  const selDash = teamsBlob.lastIndexOf('-');
  if (selDash > 0) {
    selection = teamsBlob.slice(selDash + 1);
    teamsBlob = teamsBlob.slice(0, selDash);
  }
  const pair = splitTeams(teamsBlob, spec.league, spec.teamLen);
  if (!pair) return null;
  if (!selection) selection = pair[0];

  return makeIdentity({
    league: spec.league,
    date,
    teams: pair,
    marketType: spec.marketType,
    period: spec.period,
    selection,
    side,
  });
}

function identityFromLockFields(leg, sideFallback) {
  if (!leg || typeof leg !== 'object') {
    return typeof leg === 'string' ? parseKalshiTicker(leg, sideFallback) : null;
  }
  const side = (leg.side || sideFallback || 'yes').toString().toLowerCase();
  const league = String(leg.league || leg.sport || '').toLowerCase();
  const date = etDateFromValue(leg.date || leg.event_date || leg.commence_time || leg.starts_at);
  const selection = leg.selection || leg.team || leg.selected;
  const teams = [];
  if (Array.isArray(leg.teams)) teams.push(...leg.teams);
  if (leg.home) teams.push(leg.home);
  if (leg.away) teams.push(leg.away);
  if (league && date && selection && teams.length >= 2) {
    const marketType = String(leg.market_type || leg.marketType || 'moneyline').toLowerCase();
    if (marketType !== 'moneyline' && marketType !== 'ml') return null;
    return makeIdentity({
      league,
      date,
      teams,
      marketType: 'moneyline',
      period: 'full',
      selection,
      side,
    });
  }
  return parseKalshiTicker(
    leg.ticker || leg.market_ticker || leg.event_ticker || leg.gameKey || leg.game_key,
    side
  );
}

function identitiesFromParlay(parlay) {
  const out = [];
  const keys = parlay && (parlay.leg_keys || parlay.legKeys);
  if (Array.isArray(keys) && keys.length) {
    for (const k of keys) {
      const id = parseKalshiTicker(k) || identityFromLockFields(k);
      if (!id) return { ok: false, identities: [], keys: [] };
      out.push(id);
    }
    const idKeys = out.map(identityKey).filter(Boolean).sort();
    if (idKeys.length !== out.length) return { ok: false, identities: [], keys: [] };
    return { ok: true, identities: out, keys: idKeys };
  }
  if (parlay && Array.isArray(parlay.legs) && parlay.legs.length) {
    for (const leg of parlay.legs) {
      const id = identityFromLockFields(leg);
      if (!id) return { ok: false, identities: [], keys: [] };
      out.push(id);
    }
    const idKeys = out.map(identityKey).filter(Boolean).sort();
    if (idKeys.length !== out.length) return { ok: false, identities: [], keys: [] };
    return { ok: true, identities: out, keys: idKeys };
  }
  return { ok: false, identities: [], keys: [] };
}

function unwrapMarket(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.metadata && typeof raw.metadata === 'object') return raw;
  if (raw.market && typeof raw.market === 'object') return raw.market;
  return raw;
}

function sportTypeOf(market) {
  const meta = market.metadata || {};
  return String(
    meta.market_sport_type || market.market_sport_type || ''
  ).trim();
}

function retailMoneyline(market) {
  const v2 = String(market.sportsMarketTypeV2 || market.sports_market_type_v2 || '').toUpperCase();
  if (v2 === 'SPORTS_MARKET_TYPE_MONEYLINE') return true;
  const v = String(market.sportsMarketType || market.sports_market_type || market.marketType || '').toLowerCase();
  return v === 'moneyline' || v === 'sports_market_type_moneyline';
}

function retailSpreadOrTotal(market) {
  const v2 = String(market.sportsMarketTypeV2 || '').toUpperCase();
  if (v2 === 'SPORTS_MARKET_TYPE_SPREAD' || v2 === 'SPORTS_MARKET_TYPE_TOTAL') return v2;
  const v = String(market.sportsMarketType || market.marketType || '').toLowerCase();
  if (v === 'spread' || v === 'spreads') return 'spread';
  if (v === 'total' || v === 'totals') return 'total';
  return null;
}

function classifySportType(st) {
  if (!st) return null;
  if (PRICEABLE_SPORT_TYPES.has(st)) return { marketType: 'moneyline', period: 'full' };
  if (/_full_game_spread$/.test(st) || /_full_game_total$/.test(st)) {
    return { marketType: st.endsWith('spread') ? 'spread' : 'total', period: 'full', priceable: false };
  }
  if (/_first_five_/.test(st) || /_winner$/.test(st) && !/_full_game_winner$/.test(st)) {
    return { marketType: 'other', period: 'other', priceable: false };
  }
  return { marketType: 'other', period: 'other', priceable: false };
}

function teamsFromRetailSides(market) {
  const sides = market.marketSides || market.market_sides;
  if (!Array.isArray(sides)) return { teams: [], long: '', league: '' };
  const teams = [];
  let long = '';
  let league = '';
  for (const s of sides) {
    const team = s && (s.team || {});
    const abbr = team.abbreviation || team.displayAbbreviation || s.identifier;
    if (abbr) teams.push(String(abbr));
    if (s && s.long && abbr) long = String(abbr);
    if (team.league) league = String(team.league).toLowerCase();
  }
  return { teams, long, league };
}

function identityFromMarket(marketRaw, rfqSide) {
  const market = unwrapMarket(marketRaw);
  if (!market) return { identity: null, reason: 'missing_metadata' };
  const meta = market.metadata && typeof market.metadata === 'object' ? market.metadata : {};
  const side = rfqSide === 'no' ? 'no' : 'yes';

  const st = sportTypeOf(market);
  let classified = st ? classifySportType(st) : null;
  if (!classified && retailMoneyline(market)) {
    classified = { marketType: 'moneyline', period: 'full' };
  }
  if (!classified) {
    const other = retailSpreadOrTotal(market);
    if (other) return { identity: null, reason: 'not_priceable' };
    return { identity: null, reason: 'missing_metadata' };
  }
  if (classified.priceable === false || classified.marketType !== 'moneyline') {
    return { identity: null, reason: 'not_priceable' };
  }

  const longId = meta.long_participant_id || market.long_participant_id;
  const shortId = meta.short_participant_id || market.short_participant_id;
  let league = leagueFromParticipant(longId) || leagueFromParticipant(shortId);
  if (!league && meta.event_id) league = leagueFromParticipant(String(meta.event_id).split('-').slice(0, 2).join('-'));
  if (!league && meta.event_series) league = String(meta.event_series).toLowerCase();
  if (!league && meta.event_subcategory) {
    league = SUBCATEGORY_LEAGUE[String(meta.event_subcategory).toUpperCase()] || '';
  }

  const retail = teamsFromRetailSides(market);
  if (!league) league = retail.league;
  if (!league && market.category === 'sports' && retail.league) league = retail.league;

  const date = etDateFromValue(
    meta.event_start_time || market.event_start_time
    || market.gameStartTime || market.game_start_time
    || market.startDate || market.start_date
  );

  const teams = [];
  const longCode = participantCode(longId) || retail.long;
  const shortCode = participantCode(shortId);
  if (longCode) teams.push(longCode);
  if (shortCode) teams.push(shortCode);
  for (const t of retail.teams) {
    if (t) teams.push(t);
  }

  const selection = longCode || retail.long;
  const id = makeIdentity({
    league,
    date,
    teams,
    marketType: 'moneyline',
    period: 'full',
    selection,
    side,
  });
  if (!id) return { identity: null, reason: 'missing_metadata' };
  return { identity: id, reason: null };
}

function identitiesFromPolymarketLegs(legs, markets) {
  if (!Array.isArray(legs) || !legs.length) {
    return { ok: false, reason: 'no_legs', identities: [], keys: [] };
  }
  const out = [];
  for (const leg of legs) {
    const symbol = (leg && (leg.symbol || leg.slug || leg.market_slug)) || '';
    const sideRaw = leg && (leg.side || 'SIDE_BUY');
    const side = String(sideRaw).toLowerCase().replace(/^side_/, '');
    const yesNo = side === 'sell' || side === 'no' || side === 'short' ? 'no' : (side === 'buy' || side === 'yes' || side === 'long' ? 'yes' : null);
    if (!yesNo) return { ok: false, reason: 'unmatched_leg', identities: out, keys: [] };

    const market = (leg && (leg.market || leg.metadata && { metadata: leg.metadata }))
      || (markets && (markets.get && markets.get(symbol) || markets[symbol]));
    const got = identityFromMarket(market, yesNo);
    if (!got.identity) {
      return { ok: false, reason: got.reason || 'missing_metadata', identities: out, keys: [] };
    }
    out.push(got.identity);
  }
  const keys = out.map(identityKey).filter(Boolean).sort();
  if (keys.length !== out.length) return { ok: false, reason: 'missing_metadata', identities: out, keys };
  return { ok: true, reason: null, identities: out, keys };
}

function sameIdentitySet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return false;
  const A = [...a].sort();
  const B = [...b].sort();
  return A.every((x, i) => x === B[i]);
}

module.exports = {
  SERIES,
  PRICEABLE_SPORT_TYPES,
  TEAM_ALIASES,
  normTeam,
  identityKey,
  makeIdentity,
  parseKalshiTicker,
  identityFromLockFields,
  identitiesFromParlay,
  identityFromMarket,
  identitiesFromPolymarketLegs,
  sameIdentitySet,
  etDateFromValue,
  etDateFromMs,
};
