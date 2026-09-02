// In-memory MLB/NFL/NCAAF moneyline cache for unhedged RFQ shadow pricing.
// Refresh on a short interval. Lookups are synchronous — never HTTP on the
// RFQ path. Kalshi: signed GET /markets for KXMLBGAME / KXNFLGAME / KXNCAAFGAME.
// Polymarket: getMarketBySlug for watched aec-* slugs only.
// The Odds API is not the quote clock.
'use strict';

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
  const pmWatch = new Set();
  let timer = null;
  let refreshing = false;
  let pmFetch = fetchPmMarket;
  const refreshEvery = intervalMs != null ? intervalMs : refreshMsFromEnv(env);

  function writeKalshi(ticker, yesProb) {
    const key = normKalshiKey(ticker);
    if (!key) return;
    const p = asProb(yesProb);
    if (p == null) {
      kalshi.delete(key);
      return;
    }
    kalshi.set(key, { yesProb: p, at: now() });
  }

  function writePm(slug, yesProb) {
    const key = normPmKey(slug);
    if (!key) return;
    const p = asProb(yesProb);
    if (p == null) {
      polymarket.delete(key);
      return;
    }
    polymarket.set(key, { yesProb: p, at: now() });
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
      writeKalshi(ticker, p);
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

  function watch(venue, legs) {
    if (venue !== 'polymarket' || !Array.isArray(legs)) return;
    let added = false;
    for (const leg of legs) {
      const key = normPmKey(leg && (leg.symbol || leg.ticker));
      if (!key || !key.startsWith(PM_ML_PREFIX)) continue;
      if (!pmWatch.has(key)) {
        pmWatch.add(key);
        added = true;
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
  createUnhedgedPriceCache,
  kalshiYesProb,
  pmYesProb,
  isPmFullGameMl,
  asProb,
  refreshMsFromEnv,
};
