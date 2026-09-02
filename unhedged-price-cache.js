// In-memory MLB/NFL moneyline cache for unhedged RFQ shadow pricing.
// Refresh on a short interval. Lookups are synchronous — never HTTP on the
// RFQ path. Kalshi: signed GET /markets for KXMLBGAME / KXNFLGAME (NCAAF is
// out of unhedged scope). Polymarket: getMarketBySlug for watched aec-* slugs.
// Poly RFQ legs add their symbol; Kalshi MLB/NFL ML legs also watch synthesized
// game slugs aec-{mlb|nfl}-{t1}-{t2}-{YYYY-MM-DD} (both team orders) plus
// suffixed aec-…-{pick} variants if US lists them. Watch-list only — do not
// crawl the Poly RFQ firehose.
// Production US full-game ML is one slug with two team outcomes
// (long_participant_id = which YES pays). Ingest splits those into per-team
// YES — never one mid-market price. Suffixed 1-team slugs stay as-is.
// The Odds API is not the quote clock.
//
// Fair lookups use the *opponent* YES (other ticker in the same Kalshi event;
// other team's Poly YES in the same game). Hitting that ask is taker:
// convert raw YES with the series taker coeff (MLB 0.035, NFL 0.07,
// Poly 0.06, no rebate). ourTrue is the sign-flip of the best Kalshi/Poly
// fee-included opponent American. Same-side last is never fair.
'use strict';

const {
  normTeam,
  kalshiTickerPieces,
  identityFromMarket,
  participantCode,
  teamsFromRetailSides,
  unwrapMarket,
} = require('./leg-identity');
const { parseKalshiUnhedgedTicker, parsePmUnhedgedSlug } = require('./unhedged-rfq');
const { ourTrueFromOpponents, takerThetaForVenue } = require('./unhedged-quote');

const KALSHI_ML_SERIES = ['KXMLBGAME', 'KXNFLGAME'];
const DEFAULT_REFRESH_MS = 4000;
const KALSHI_PAGE_LIMIT = 200;
const PM_ML_PREFIX = 'aec-';

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function asProb(raw) {
  const n = numOrNull(raw);
  if (n == null) return null;
  if (n > 1 && n <= 100) {
    const cents = n / 100;
    return cents > 0 && cents < 1 ? cents : null;
  }
  return n > 0 && n < 1 ? n : null;
}

function amountValue(q) {
  if (q == null) return null;
  if (typeof q === 'object') return asProb(q.value != null ? q.value : q.price);
  return asProb(q);
}

function pickYesProb(bid, ask, last, extras) {
  const b = asProb(bid);
  const a = asProb(ask);
  if (b != null && a != null) return (b + a) / 2;
  if (b != null) return b;
  if (a != null) return a;
  const l = asProb(last);
  if (l != null) return l;
  for (const x of extras || []) {
    const p = asProb(x);
    if (p != null) return p;
  }
  return null;
}

function kalshiYesProb(market) {
  if (!market || typeof market !== 'object') return null;
  return pickYesProb(
    market.yes_bid_dollars != null ? market.yes_bid_dollars : market.yes_bid,
    market.yes_ask_dollars != null ? market.yes_ask_dollars : market.yes_ask,
    market.last_price_dollars != null ? market.last_price_dollars : market.last_price
  );
}

function parseOutcomePrices(raw) {
  if (raw == null) return [];
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch (_) { return []; }
  }
  return Array.isArray(arr) ? arr : [];
}

function isPmFullGameMl(market, slug) {
  const s = String((market && market.slug) || slug || '').toLowerCase();
  if (s.startsWith(PM_ML_PREFIX)) return true;
  const t = String(
    (market && (market.sportsMarketType || market.marketType || market.sports_market_type)) || ''
  ).toLowerCase();
  if (/spread|total|prop/.test(t)) return false;
  const meta = (market && market.metadata) || {};
  const st = String(meta.market_sport_type || '').toLowerCase();
  if (st && !/full_game_winner|moneyline/.test(st)) return false;
  if (/moneyline/.test(t) || st.includes('full_game_winner')) return true;
  return false;
}

function pmYesProb(market) {
  if (!market || typeof market !== 'object') return null;
  const sides = Array.isArray(market.marketSides) ? market.marketSides : [];
  const longSide = sides.find((s) => s && s.long === true);
  const outcomes = parseOutcomePrices(market.outcomePrices);
  const prices = market.prices && typeof market.prices === 'object' ? market.prices : {};
  return pickYesProb(
    amountValue(market.bestBidQuote) != null ? amountValue(market.bestBidQuote) : (market.bestBid != null ? market.bestBid : prices.bestBid),
    amountValue(market.bestAskQuote) != null ? amountValue(market.bestAskQuote) : (market.bestAsk != null ? market.bestAsk : prices.bestAsk),
    market.lastTradePrice != null ? market.lastTradePrice : prices.lastTradePrice,
    [
      longSide && (amountValue(longSide.quote) != null ? amountValue(longSide.quote) : longSide.price),
      outcomes[0],
    ]
  );
}

function sideTeamCode(side) {
  if (!side || typeof side !== 'object') return '';
  const team = side.team || {};
  return String(team.abbreviation || team.displayAbbreviation || side.identifier || '').trim().toLowerCase();
}

function sideYesProb(side) {
  if (!side || typeof side !== 'object') return null;
  return pickYesProb(
    amountValue(side.bestBidQuote) != null ? amountValue(side.bestBidQuote) : (side.bestBid != null ? side.bestBid : side.bid),
    amountValue(side.bestAskQuote) != null ? amountValue(side.bestAskQuote) : (side.bestAsk != null ? side.bestAsk : side.ask),
    side.lastTradePrice != null ? side.lastTradePrice : side.last,
    [
      amountValue(side.quote) != null ? amountValue(side.quote) : side.price,
    ]
  );
}

// Production US full-game ML: one slug, two team outcomes. long_participant_id
// (and marketSides[].long) is the team whose YES is outcomes[0] / the book.
// Reuses identityFromMarket / teamsFromRetailSides — same Retail payload as
// getMarketBySlug. Do not invent 1-p for the other team.
function pmTeamYesProbs(market, slug) {
  if (!market || typeof market !== 'object') return null;
  const raw = unwrapMarket(market) || market;
  const sides = Array.isArray(raw.marketSides)
    ? raw.marketSides
    : (Array.isArray(raw.market_sides) ? raw.market_sides : []);
  const outcomes = parseOutcomePrices(raw.outcomePrices);
  const meta = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
  const got = identityFromMarket(raw, 'yes');
  const id = got && got.identity;
  const retail = teamsFromRetailSides(raw);
  const slugParsed = parsePmUnhedgedSlug(slug || raw.slug, 'yes');
  const league = (id && id.league)
    || retail.league
    || (slugParsed && slugParsed.league);
  const date = (id && id.date) || (slugParsed && slugParsed.date);
  const longId = meta.long_participant_id || raw.long_participant_id;
  const shortId = meta.short_participant_id || raw.short_participant_id;
  const longTeam = (id && id.selection) || participantCode(longId) || retail.long;
  const shortFromId = id && Array.isArray(id.teams)
    ? id.teams.find((t) => normTeam(league, t) !== normTeam(league, longTeam))
    : '';
  const shortFromRetail = (retail.teams || []).find((t) => (
    normTeam(league, t) !== normTeam(league, longTeam)
  ));
  const shortTeam = participantCode(shortId) || shortFromId || shortFromRetail;
  const teamsForKey = (id && id.teams)
    || [...new Set([longTeam, shortTeam].filter(Boolean).map((t) => String(t).toLowerCase()))];

  const rows = [];
  const seen = new Set();
  function addRow(team, yesProb) {
    const t = String(team || '').trim().toLowerCase();
    const p = asProb(yesProb);
    if (!t || /^\d+$/.test(t) || p == null) return;
    const norm = league ? normTeam(league, t) : t;
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    rows.push({ team: t, yesProb: p, league, date, teams: teamsForKey });
  }

  if (sides.length >= 2) {
    for (const s of sides) {
      let team = sideTeamCode(s);
      if (!team && s && s.long) team = longTeam;
      if (!team && s && !s.long) team = shortTeam;
      let yes = sideYesProb(s);
      if (yes == null && s && s.long) {
        yes = asProb(outcomes[0]) != null ? asProb(outcomes[0]) : pmYesProb(raw);
      }
      if (yes == null && s && !s.long) yes = asProb(outcomes[1]);
      addRow(team, yes);
    }
  }
  if (rows.length >= 2) return rows;

  if (longTeam && shortTeam && normTeam(league, longTeam) !== normTeam(league, shortTeam)) {
    const longYes = asProb(outcomes[0]) != null ? asProb(outcomes[0]) : pmYesProb(raw);
    addRow(longTeam, longYes);
    addRow(shortTeam, asProb(outcomes[1]));
  }
  return rows.length >= 2 ? rows : null;
}

function refreshMsFromEnv(env = process.env) {
  const n = numOrNull(env && env.UNHEDGED_PRICE_REFRESH_MS);
  if (n == null) return DEFAULT_REFRESH_MS;
  return n >= 1000 && n <= 60_000 ? n : DEFAULT_REFRESH_MS;
}

function normKalshiKey(key) {
  const s = String(key || '').trim();
  if (!s) return '';
  const i = s.lastIndexOf(':');
  const ticker = i === -1 ? s : s.slice(0, i);
  return ticker.toUpperCase();
}

function normPmKey(key) {
  const s = String(key || '').trim();
  if (!s) return '';
  const i = s.lastIndexOf(':');
  const slug = i === -1 ? s : s.slice(0, i);
  return slug.toLowerCase();
}

function kalshiEventKeyFromTicker(ticker) {
  const key = normKalshiKey(ticker);
  const i = key.lastIndexOf('-');
  return i > 0 ? key.slice(0, i) : key;
}

function pmGamePrefix(slug) {
  const key = normPmKey(slug);
  const i = key.lastIndexOf('-');
  return i > 0 ? key.slice(0, i) : key;
}

// Production US ML slug is pair+date (no pick). Last token is a team only on
// the suffixed test / RFQ shape. Date fragments (02) are not teams.
function isPmGameSlug(slug) {
  const key = normPmKey(slug);
  if (!key.startsWith(PM_ML_PREFIX)) return false;
  const parsed = parsePmUnhedgedSlug(key, 'yes');
  if (!parsed || parsed.skip) return false;
  const i = key.lastIndexOf('-');
  if (i <= 0) return true;
  const last = key.slice(i + 1);
  if (!last || /^\d+$/.test(last)) return true;
  const league = String(parsed.league || '').toLowerCase();
  const lastNorm = normTeam(league, last);
  return !(parsed.teams || []).some((t) => t === last || normTeam(league, t) === lastNorm);
}

function pmGameSlugOf(slug) {
  const key = normPmKey(slug);
  if (!key.startsWith(PM_ML_PREFIX)) return null;
  if (isPmGameSlug(key)) return key;
  const i = key.lastIndexOf('-');
  return i > 0 ? key.slice(0, i) : key;
}

function gameKeyFromParsed(parsed) {
  if (!parsed || !parsed.league || !parsed.date) return null;
  const league = String(parsed.league).toLowerCase();
  const teams = (parsed.teams || []).map((t) => normTeam(league, t)).filter(Boolean);
  const uniq = [...new Set(teams)].sort();
  if (uniq.length < 2) return null;
  return `${league}|${parsed.date}|${uniq.join('+')}`;
}

function opponentTeamOf(parsed) {
  if (!parsed) return null;
  const league = String(parsed.league || '').toLowerCase();
  const sel = normTeam(league, parsed.selection);
  if (!sel) return null;
  const teams = (parsed.teams || []).map((t) => normTeam(league, t)).filter(Boolean);
  const others = [...new Set(teams)].filter((t) => t !== sel);
  return others.length === 1 ? others[0] : null;
}

// Inverse of parsePmUnhedgedSlug for US sports ML.
// Production: aec-{league}-{t1}-{t2}-{YYYY-MM-DD} (no pick). Suffixed
// aec-…-{pick} stay as extra candidates. Codes (cin), not spoken names.
// Team order is not in the ticker identity, so watch both orders. Also
// watch the identity-normalized pair (chw→cws) when it differs from raw codes.
function addPmMlPairSlugs(out, league, date, teamA, teamB) {
  const a = String(teamA || '').toLowerCase();
  const b = String(teamB || '').toLowerCase();
  const lg = String(league || '').toLowerCase();
  const dt = String(date || '');
  if (!a || !b || a === b || (lg !== 'mlb' && lg !== 'nfl') || !/^\d{4}-\d{2}-\d{2}$/.test(dt)) return;
  for (const [left, right] of [[a, b], [b, a]]) {
    const game = `aec-${lg}-${left}-${right}-${dt}`;
    const parsedGame = parsePmUnhedgedSlug(game, 'yes');
    if (parsedGame && !parsedGame.skip) out.add(game);
    for (const pick of [left, right]) {
      const slug = `${game}-${pick}`;
      const parsed = parsePmUnhedgedSlug(slug, 'yes');
      if (parsed && !parsed.skip) out.add(slug);
    }
  }
}

function pmMlSlugsFromKalshiLeg(leg) {
  const ticker = typeof leg === 'string'
    ? String(leg)
    : (leg && (leg.ticker || leg.market_ticker));
  if (!ticker) return [];
  const parsed = parseKalshiUnhedgedTicker(ticker, (leg && leg.side) || 'yes');
  if (!parsed || parsed.skip) return [];
  const league = String(parsed.league || '').toLowerCase();
  if (league !== 'mlb' && league !== 'nfl') return [];
  if (parsed.marketType && parsed.marketType !== 'moneyline') return [];
  const date = parsed.date;
  if (!date) return [];
  const out = new Set();
  const pieces = kalshiTickerPieces(ticker, (leg && leg.side) || 'yes');
  if (pieces && pieces.teams && pieces.teams.length === 2) {
    addPmMlPairSlugs(out, league, date, pieces.teams[0], pieces.teams[1]);
  }
  if (parsed.teams && parsed.teams.length === 2) {
    addPmMlPairSlugs(out, league, date, parsed.teams[0], parsed.teams[1]);
  }
  return [...out];
}

function parseLeg(leg) {
  if (!leg || typeof leg !== 'object') return null;
  if (leg.ticker) {
    const p = parseKalshiUnhedgedTicker(leg.ticker, leg.side || 'yes');
    if (p && !p.skip) {
      return {
        ...p,
        teams: Array.isArray(leg.teams) && leg.teams.length ? leg.teams : p.teams,
        selection: leg.selection || p.selection,
        date: leg.date || p.date,
        league: leg.league || p.league,
        ticker: p.ticker || leg.ticker,
        symbol: leg.symbol || p.symbol,
      };
    }
  }
  if (leg.symbol) {
    const p = parsePmUnhedgedSlug(leg.symbol, leg.side || 'yes');
    if (p && !p.skip) {
      return {
        ...p,
        teams: Array.isArray(leg.teams) && leg.teams.length ? leg.teams : p.teams,
        selection: leg.selection || p.selection,
        date: leg.date || p.date,
        league: leg.league || p.league,
        ticker: leg.ticker || p.ticker,
        symbol: p.symbol || leg.symbol,
      };
    }
  }
  if (leg.league && (leg.selection || (leg.teams && leg.teams.length))) {
    return {
      league: leg.league,
      date: leg.date,
      teams: leg.teams,
      selection: leg.selection,
      ticker: leg.ticker,
      symbol: leg.symbol,
    };
  }
  return null;
}

function addToSetMap(map, key, value) {
  if (!key || !value) return;
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function removeFromSetMap(map, key, value) {
  if (!key || !value || !map.has(key)) return;
  const set = map.get(key);
  set.delete(value);
  if (!set.size) map.delete(key);
}

function createUnhedgedPriceCache({
  fetchKalshiMarkets,
  fetchPmMarket,
  intervalMs,
  env = process.env,
  seed = null,
  now = () => Date.now(),
} = {}) {
  const kalshi = new Map();
  const polymarket = new Map();
  const kalshiEvents = new Map();
  const kalshiGames = new Map();
  const pmByPrefix = new Map();
  const pmGames = new Map();
  const pmWatch = new Set();
  let timer = null;
  let refreshing = false;
  let pmFetch = fetchPmMarket;
  const refreshEvery = intervalMs != null ? intervalMs : refreshMsFromEnv(env);

  function unindexKalshi(key, entry) {
    if (!entry) return;
    removeFromSetMap(kalshiEvents, entry.eventKey, key);
    removeFromSetMap(kalshiGames, entry.gameKey, key);
  }

  function unindexPm(key, entry) {
    if (!entry) return;
    removeFromSetMap(pmByPrefix, entry.gamePrefix, key);
    removeFromSetMap(pmGames, entry.gameKey, key);
  }

  function writeKalshi(ticker, yesProb, market) {
    const key = normKalshiKey(ticker);
    if (!key) return;
    const prev = kalshi.get(key);
    if (prev) unindexKalshi(key, prev);
    const p = asProb(yesProb);
    if (p == null) {
      kalshi.delete(key);
      return;
    }
    const parsed = parseKalshiUnhedgedTicker(key, 'yes');
    const eventFromMarket = market && (market.event_ticker || market.eventTicker);
    const eventKey = eventFromMarket
      ? String(eventFromMarket).trim().toUpperCase()
      : kalshiEventKeyFromTicker(key);
    const league = parsed && parsed.league;
    const entry = {
      yesProb: p,
      at: now(),
      eventKey,
      gameKey: parsed ? gameKeyFromParsed(parsed) : null,
      selection: parsed && parsed.selection,
      selectionNorm: parsed && league ? normTeam(league, parsed.selection) : null,
      league,
      date: parsed && parsed.date,
      teams: parsed && parsed.teams,
    };
    kalshi.set(key, entry);
    addToSetMap(kalshiEvents, entry.eventKey, key);
    addToSetMap(kalshiGames, entry.gameKey, key);
  }

  function writePm(slug, yesProb, extra) {
    const key = normPmKey(slug);
    if (!key) return;
    const prev = polymarket.get(key);
    if (prev) unindexPm(key, prev);
    const p = asProb(yesProb);
    if (p == null) {
      polymarket.delete(key);
      return;
    }
    const parsed = parsePmUnhedgedSlug(key, 'yes');
    const league = (extra && extra.league) || (parsed && parsed.league);
    const date = (extra && extra.date) || (parsed && parsed.date);
    const teams = (extra && extra.teams) || (parsed && parsed.teams);
    const selection = (extra && extra.selection) || (parsed && parsed.selection);
    const entry = {
      yesProb: p,
      at: now(),
      gamePrefix: isPmGameSlug(key) ? key : pmGamePrefix(key),
      gameKey: gameKeyFromParsed({ league, date, teams, selection }),
      selection,
      selectionNorm: league && selection ? normTeam(league, selection) : null,
      league,
      date,
      teams,
    };
    polymarket.set(key, entry);
    addToSetMap(pmByPrefix, entry.gamePrefix, key);
    addToSetMap(pmGames, entry.gameKey, key);
  }

  if (seed && seed.kalshi) {
    for (const [k, v] of Object.entries(seed.kalshi)) writeKalshi(k, v);
  }
  if (seed && seed.polymarket) {
    for (const [k, v] of Object.entries(seed.polymarket)) writePm(k, v);
  }

  function ingestKalshiMarkets(markets) {
    if (!Array.isArray(markets)) return 0;
    let n = 0;
    for (const m of markets) {
      const ticker = m && (m.ticker || m.market_ticker);
      if (!ticker) continue;
      const series = String(ticker).split('-')[0].toUpperCase();
      if (!KALSHI_ML_SERIES.includes(series)) continue;
      const p = kalshiYesProb(m);
      if (p == null) continue;
      writeKalshi(ticker, p, m);
      n += 1;
    }
    return n;
  }

  function ingestPmMarket(slug, market) {
    const requested = normPmKey(slug);
    const fromMarket = normPmKey(market && market.slug);
    const key = (fromMarket && fromMarket.startsWith(PM_ML_PREFIX)) ? fromMarket : requested;
    if (!key || !key.startsWith(PM_ML_PREFIX)) return false;
    if (!isPmFullGameMl(market, key)) return false;
    const gameSlug = pmGameSlugOf(key);
    // Game slug (no pick): two team outcomes → store each team's YES.
    // Suffixed RFQ/test slugs stay one write via pmYesProb.
    if (gameSlug && gameSlug === key) {
      const teamRows = pmTeamYesProbs(market, key);
      if (!teamRows || teamRows.length < 2) return false;
      let n = 0;
      for (const row of teamRows) {
        if (!row.team || row.yesProb == null) continue;
        writePm(`${gameSlug}-${row.team}`, row.yesProb, {
          selection: row.team,
          league: row.league,
          date: row.date,
          teams: row.teams,
        });
        n += 1;
      }
      return n >= 2;
    }
    const p = pmYesProb(market);
    if (p == null) return false;
    writePm(key, p);
    return true;
  }

  function getYesProb(venue, key) {
    if (venue === 'kalshi') {
      const hit = kalshi.get(normKalshiKey(key));
      return hit ? hit.yesProb : null;
    }
    if (venue === 'polymarket') {
      const hit = polymarket.get(normPmKey(key));
      return hit ? hit.yesProb : null;
    }
    return null;
  }

  function addQuote(quotes, seen, venue, yesProb, key) {
    const p = asProb(yesProb);
    if (p == null || !key) return;
    const id = `${venue}:${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    quotes.push({ venue, yesProb: p, key, theta: takerThetaForVenue(venue, key) });
  }

  function opponentQuotes(leg) {
    const quotes = [];
    const seen = new Set();
    const parsed = parseLeg(leg);

    const kTicker = normKalshiKey(leg && (leg.ticker || (parsed && parsed.ticker)));
    if (kTicker) {
      const hit = kalshi.get(kTicker);
      const eventKey = (hit && hit.eventKey) || kalshiEventKeyFromTicker(kTicker);
      const members = kalshiEvents.get(eventKey);
      if (members) {
        for (const t of members) {
          if (t === kTicker) continue;
          const other = kalshi.get(t);
          if (other) addQuote(quotes, seen, 'kalshi', other.yesProb, t);
        }
      }
    }

    const pmSlug = normPmKey(leg && (leg.symbol || (parsed && parsed.symbol)));
    if (pmSlug) {
      const hit = polymarket.get(pmSlug);
      const prefix = (hit && hit.gamePrefix) || pmGamePrefix(pmSlug);
      const members = pmByPrefix.get(prefix);
      if (members) {
        for (const s of members) {
          if (s === pmSlug) continue;
          const other = polymarket.get(s);
          if (other) addQuote(quotes, seen, 'polymarket', other.yesProb, s);
        }
      }
    }

    if (parsed) {
      const gk = gameKeyFromParsed(parsed);
      const opp = opponentTeamOf(parsed);
      if (gk && opp) {
        const kMembers = kalshiGames.get(gk);
        if (kMembers) {
          for (const t of kMembers) {
            const other = kalshi.get(t);
            if (!other) continue;
            if (other.selectionNorm === opp) addQuote(quotes, seen, 'kalshi', other.yesProb, t);
          }
        }
        const pMembers = pmGames.get(gk);
        if (pMembers) {
          for (const s of pMembers) {
            const other = polymarket.get(s);
            if (!other) continue;
            if (other.selectionNorm === opp) addQuote(quotes, seen, 'polymarket', other.yesProb, s);
          }
        }
      }
    }

    return quotes;
  }

  function getOurTrue(leg) {
    return ourTrueFromOpponents(opponentQuotes(leg));
  }

  function derivePmOpponentSlug(slug, leg) {
    const key = normPmKey(slug);
    if (!key || !key.startsWith(PM_ML_PREFIX)) return null;
    const parsed = parsePmUnhedgedSlug(key, 'yes') || parseLeg(leg);
    const opp = opponentTeamOf(parsed);
    if (!opp || !parsed) return null;
    const i = key.lastIndexOf('-');
    if (i <= 0) return null;
    const rawTeams = parsed.teams || [];
    const league = String(parsed.league || '').toLowerCase();
    const rawOpp = rawTeams.find((t) => normTeam(league, t) === opp) || opp;
    return `${key.slice(0, i)}-${rawOpp}`;
  }

  function watch(venue, legs) {
    if (!Array.isArray(legs)) return;
    let added = false;
    function addWatch(key) {
      const k = normPmKey(key);
      if (!k || !k.startsWith(PM_ML_PREFIX)) return;
      if (!pmWatch.has(k)) {
        pmWatch.add(k);
        added = true;
      }
    }
    for (const leg of legs) {
      const pmKey = normPmKey(leg && (leg.symbol || (venue === 'polymarket' ? leg.ticker : '')));
      if (pmKey) {
        addWatch(pmKey);
        const game = pmGameSlugOf(pmKey);
        if (game) addWatch(game);
        const opp = derivePmOpponentSlug(pmKey, leg);
        if (opp) addWatch(opp);
        const prefix = pmGamePrefix(pmKey);
        const members = pmByPrefix.get(prefix);
        if (members) {
          for (const s of members) addWatch(s);
        }
      }
      const parsed = parseLeg(leg);
      const gk = parsed && gameKeyFromParsed(parsed);
      if (gk) {
        const slugs = pmGames.get(gk);
        if (slugs) {
          for (const s of slugs) {
            addWatch(s);
            const opp = derivePmOpponentSlug(s, null);
            if (opp) addWatch(opp);
          }
        }
      }
      // Kalshi RFQ legs have ticker (KXMLBGAME-…-CIN), not symbol. Synthesize
      // game slugs (both orders) plus suffixed pick variants so refreshPm
      // fills per-team YES. Do not crawl the Poly firehose.
      for (const s of pmMlSlugsFromKalshiLeg(leg)) addWatch(s);
    }
    if (added && timer) scheduleSoon();
  }

  function setPmFetch(fn) {
    if (typeof fn === 'function') pmFetch = fn;
  }

  async function refreshKalshi() {
    if (typeof fetchKalshiMarkets !== 'function') return;
    for (const series of KALSHI_ML_SERIES) {
      let cursor = '';
      for (let page = 0; page < 8; page += 1) {
        let res;
        try {
          res = await fetchKalshiMarkets(series, cursor);
        } catch (e) {
          console.error('[UNHEDGED] kalshi markets', series, e && e.message);
          break;
        }
        const json = res && res.json ? res.json : res;
        const markets = (json && json.markets) || (Array.isArray(json) ? json : []);
        ingestKalshiMarkets(markets);
        const next = (json && (json.cursor || json.next_cursor)) || '';
        if (!next || next === cursor) break;
        cursor = next;
      }
    }
  }

  async function refreshPm() {
    if (typeof pmFetch !== 'function' || !pmWatch.size) return 0;
    const slugs = [...pmWatch];
    let misses = 0;
    await Promise.all(slugs.map(async (slug) => {
      try {
        const market = await pmFetch(slug);
        if (!market || !ingestPmMarket(slug, market)) misses += 1;
      } catch (e) {
        misses += 1;
        console.error('[UNHEDGED] pm market', slug, e && e.message);
      }
    }));
    return misses;
  }

  async function refresh() {
    if (refreshing) return { skipped: true };
    refreshing = true;
    try {
      const [, pmMiss] = await Promise.all([refreshKalshi(), refreshPm()]);
      const missCount = pmMiss || 0;
      if (missCount) console.log(`[UNHEDGED] pm miss ${missCount}`);
      return {
        skipped: false,
        kalshi: kalshi.size,
        polymarket: polymarket.size,
        watching: pmWatch.size,
        pmMiss: missCount,
      };
    } finally {
      refreshing = false;
    }
  }

  let soonTimer = null;
  function scheduleSoon() {
    if (soonTimer) return;
    soonTimer = setTimeout(() => {
      soonTimer = null;
      refresh().catch((e) => console.error('[UNHEDGED] price refresh', e && e.message));
    }, 250);
    if (soonTimer.unref) soonTimer.unref();
  }

  function start() {
    if (timer) return;
    refresh().catch((e) => console.error('[UNHEDGED] price refresh', e && e.message));
    timer = setInterval(() => {
      refresh().catch((e) => console.error('[UNHEDGED] price refresh', e && e.message));
    }, refreshEvery);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (soonTimer) clearTimeout(soonTimer);
    soonTimer = null;
  }

  return {
    getYesProb,
    getOurTrue,
    opponentQuotes,
    watch,
    setPmFetch,
    ingestKalshiMarkets,
    ingestPmMarket,
    refresh,
    start,
    stop,
    refreshEvery,
    _kalshi: kalshi,
    _polymarket: polymarket,
    _pmWatch: pmWatch,
  };
}

module.exports = {
  KALSHI_ML_SERIES,
  DEFAULT_REFRESH_MS,
  KALSHI_PAGE_LIMIT,
  createUnhedgedPriceCache,
  kalshiYesProb,
  pmYesProb,
  isPmFullGameMl,
  asProb,
  refreshMsFromEnv,
  kalshiEventKeyFromTicker,
  pmGamePrefix,
  gameKeyFromParsed,
  opponentTeamOf,
  pmMlSlugsFromKalshiLeg,
  pmTeamYesProbs,
  isPmGameSlug,
  pmGameSlugOf,
};
