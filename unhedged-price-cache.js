// In-memory MLB/NFL/NCAAF moneyline cache for unhedged RFQ shadow pricing.
// Refresh on a short interval. Lookups are synchronous — never HTTP on the
// RFQ path. Kalshi: signed GET /markets for KXMLBGAME / KXNFLGAME / KXNCAAFGAME.
// Polymarket: getMarketBySlug for watched aec-* slugs only.
// The Odds API is not the quote clock.
//
// Fair lookups use the *opponent* YES (other ticker in the same Kalshi event;
// other aec-* ML in the same Polymarket game). Hitting that ask is taker:
// convert raw YES with the series taker coeff (MLB 0.035, NFL/NCAAF 0.07,
// Poly 0.06). ourTrue is the sign-flip of the best Kalshi/Poly fee-included
// opponent American. Same-side last is never fair.
'use strict';

const { normTeam } = require('./leg-identity');
const { parseKalshiUnhedgedTicker, parsePmUnhedgedSlug } = require('./unhedged-rfq');
const { ourTrueFromOpponents, takerThetaForVenue } = require('./unhedged-quote');

const KALSHI_ML_SERIES = ['KXMLBGAME', 'KXNFLGAME', 'KXNCAAFGAME'];
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

  function writePm(slug, yesProb) {
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
    const league = parsed && parsed.league;
    const entry = {
      yesProb: p,
      at: now(),
      gamePrefix: pmGamePrefix(key),
      gameKey: parsed ? gameKeyFromParsed(parsed) : null,
      selection: parsed && parsed.selection,
      selectionNorm: parsed && league ? normTeam(league, parsed.selection) : null,
      league,
      date: parsed && parsed.date,
      teams: parsed && parsed.teams,
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
    const key = normPmKey(slug || (market && market.slug));
    if (!key || !key.startsWith(PM_ML_PREFIX)) return false;
    if (!isPmFullGameMl(market, key)) return false;
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
    if (typeof pmFetch !== 'function' || !pmWatch.size) return;
    const slugs = [...pmWatch];
    await Promise.all(slugs.map(async (slug) => {
      try {
        const market = await pmFetch(slug);
        if (market) ingestPmMarket(slug, market);
      } catch (e) {
        console.error('[UNHEDGED] pm market', slug, e && e.message);
      }
    }));
  }

  async function refresh() {
    if (refreshing) return { skipped: true };
    refreshing = true;
    try {
      await Promise.all([refreshKalshi(), refreshPm()]);
      return {
        skipped: false,
        kalshi: kalshi.size,
        polymarket: polymarket.size,
        watching: pmWatch.size,
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
};
