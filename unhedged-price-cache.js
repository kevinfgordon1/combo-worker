// In-memory MLB/NFL/NCAAF moneyline cache for unhedged RFQ shadow pricing.
// Refreshed on an interval (same idea as Combo Locks staging) — never a per-RFQ
// Odds API / market GET on the handleRfq hot path. Lookups are sync.
//
// Kalshi: list open KXMLBGAME / KXNFLGAME / KXNCAAFGAME via existing signed auth.
// Polymarket: getMarketBySlug for remembered aec-* ML slugs only.
//
// Do not POST / confirm / fill. engine.js KFEE (Combo Locks) is not used here.
'use strict';
const { americanFromProb } = require('./engine');

const KALSHI_ML_SERIES = ['KXMLBGAME', 'KXNFLGAME', 'KXNCAAFGAME'];
const KALSHI_COMBO_MAKER = 0.035; // 0.5 × taker 0.07. Unhedged only — not engine.js KFEE.
const YES_MARGIN = 1.05; // Kevin: quote YES = 1.05 × net_cost. We sell YES — never fair minus.
const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_MAX_PM_SLUGS = 128;
const KALSHI_PAGE_LIMIT = 200;
const KALSHI_MAX_PAGES = 8;

const NON_ML_TICKER = /SPREAD|TOTAL|PROP|PLAYER|1H|1Q|F5/;

function floor2(x) {
  return Math.floor(x * 100 + 1e-9) / 100;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function refreshIntervalMs(env = process.env) {
  const v = env && env.UNHEDGED_PRICE_REFRESH_MS;
  if (v == null || String(v).trim() === '') return DEFAULT_INTERVAL_MS;
  const n = Number(v);
  return Number.isFinite(n) && n >= 5000 ? n : DEFAULT_INTERVAL_MS;
}

function isKalshiNflIndependent(legs) {
  return !!(legs && legs.length >= 2 && legs.every((l) => l && l.league === 'nfl'));
}

// Kalshi independent NFL-only: maker fee 0.
// Other Kalshi combos (MLB, mixed, NCAAF): combo maker 0.035 on fair p.
// Polymarket US: maker cost is 0 — do not apply the 0.0125 rebate in net_cost.
function makerFeeCoeff(venue, legs) {
  if (venue === 'kalshi') {
    return isKalshiNflIndependent(legs) ? 0 : KALSHI_COMBO_MAKER;
  }
  return 0;
}

function fairYesProb(yesProbs, sides) {
  if (!Array.isArray(yesProbs) || !yesProbs.length) return null;
  let p = 1;
  for (let i = 0; i < yesProbs.length; i++) {
    const yp = yesProbs[i];
    if (!(yp > 0 && yp < 1)) return null;
    const side = String((sides && sides[i]) || 'yes').toLowerCase();
    const lp = side === 'no' ? 1 - yp : yp;
    if (!(lp > 0 && lp < 1)) return null;
    p *= lp;
  }
  return p > 0 && p < 1 ? p : null;
}

function netCostYes(fairP, venue, legs) {
  if (!(fairP > 0 && fairP < 1)) return null;
  const k = makerFeeCoeff(venue, legs);
  return Math.round((fairP + k * fairP * (1 - fairP)) * 1e12) / 1e12;
}

// Floor NO like fillView so posted YES is never below 1.05×net (we sell YES).
function postedYesFromRaw(raw) {
  if (!(raw > 0 && raw < 1)) return null;
  const yes = Math.round((1 - floor2(1 - raw)) * 100) / 100;
  return yes > 0 && yes < 1 ? yes : null;
}

function wouldQuoteYesRaw(fairP, { venue, legs } = {}) {
  const net = netCostYes(fairP, venue, legs);
  if (net == null) return null;
  const raw = Math.round(YES_MARGIN * net * 1e12) / 1e12;
  return raw > 0 && raw < 1 ? raw : null;
}

function wouldQuoteYesProb(fairP, opts = {}) {
  return postedYesFromRaw(wouldQuoteYesRaw(fairP, opts));
}

function quoteUnhedged(venue, legs, yesProbs, sides) {
  const fairP = fairYesProb(yesProbs, sides);
  if (fairP == null) return { fairAmerican: null, quoteAmerican: null, fairP: null, quoteP: null };
  const fairAmerican = americanFromProb(fairP);
  const quoteP = wouldQuoteYesProb(fairP, { venue, legs });
  if (quoteP == null) return { fairAmerican, quoteAmerican: null, fairP, quoteP: null };
  return {
    fairAmerican,
    quoteAmerican: americanFromProb(quoteP),
    fairP,
    quoteP,
  };
}

function cleanProb(p) {
  if (p == null) return null;
  const r = Math.round(p * 1e6) / 1e6;
  return r > 0 && r < 1 ? r : null;
}

function dollarProb(v) {
  const n = numOrNull(v);
  if (n == null) return null;
  if (n > 0 && n < 1) return n;
  if (n >= 1 && n <= 99) return n / 100;
  return null;
}

function amountValue(v) {
  if (v == null) return null;
  if (typeof v === 'object') return dollarProb(v.value != null ? v.value : v.price);
  return dollarProb(v);
}

function yesProbFromKalshiMarket(m) {
  if (!m || typeof m !== 'object') return null;
  const bid = dollarProb(m.yes_bid_dollars != null ? m.yes_bid_dollars : m.yes_bid);
  const ask = dollarProb(m.yes_ask_dollars != null ? m.yes_ask_dollars : m.yes_ask);
  const last = dollarProb(m.last_price_dollars != null ? m.last_price_dollars : m.last_price);
  if (bid != null && ask != null) return cleanProb((bid + ask) / 2);
  if (last != null) return last;
  return bid != null ? bid : ask;
}

function yesProbFromPmMarket(m) {
  if (!m || typeof m !== 'object') return null;
  const src = m.market && typeof m.market === 'object' ? m.market : m;
  const bid = amountValue(src.bestBid != null ? src.bestBid : src.best_bid);
  const ask = amountValue(src.bestAsk != null ? src.bestAsk : src.best_ask);
  const last = amountValue(
    src.lastTradePrice != null ? src.lastTradePrice
      : src.last_trade_price != null ? src.last_trade_price
        : src.lastTradePx != null ? src.lastTradePx
          : src.currentPx != null ? src.currentPx
            : src.price
  );
  if (bid != null && ask != null) return cleanProb((bid + ask) / 2);
  if (last != null) return last;
  if (bid != null) return bid;
  if (ask != null) return ask;
  return null;
}

function isKalshiMlTicker(ticker, series) {
  const t = String(ticker || '').toUpperCase();
  if (!t.startsWith(String(series || '').toUpperCase() + '-')) return false;
  return !NON_ML_TICKER.test(t);
}

function kalshiKey(leg) {
  return String((leg && (leg.ticker || leg.symbol)) || '').trim().toUpperCase();
}

function pmKey(leg) {
  return String((leg && (leg.symbol || leg.ticker)) || '').trim().toLowerCase();
}

function createUnhedgedPriceCache(opts = {}) {
  const kalshi = new Map();
  const poly = new Map();
  const pendingPm = new Set();
  const maxPm = Number.isFinite(opts.maxPmSlugs) && opts.maxPmSlugs > 0
    ? opts.maxPmSlugs
    : DEFAULT_MAX_PM_SLUGS;
  let listKalshiMarkets = opts.listKalshiMarkets;
  let fetchPmMarket = opts.fetchPmMarket;
  let timer = null;
  let refreshing = false;

  function setListKalshiMarkets(fn) { listKalshiMarkets = fn; }
  function setFetchPmMarket(fn) { fetchPmMarket = fn; }

  function remember(venue, legs) {
    if (venue !== 'polymarket' || !Array.isArray(legs)) return;
    for (const leg of legs) {
      const slug = pmKey(leg);
      if (!slug || !slug.startsWith('aec-')) continue;
      if (pendingPm.has(slug)) pendingPm.delete(slug);
      pendingPm.add(slug);
    }
    while (pendingPm.size > maxPm) {
      const oldest = pendingPm.values().next().value;
      pendingPm.delete(oldest);
      poly.delete(oldest);
    }
  }

  function yesForLeg(venue, leg) {
    if (venue === 'kalshi') {
      const t = kalshiKey(leg);
      return t && kalshi.has(t) ? kalshi.get(t) : null;
    }
    const s = pmKey(leg);
    return s && poly.has(s) ? poly.get(s) : null;
  }

  function price(venue, legs, env) {
    if (!venue || !Array.isArray(legs) || !legs.length) {
      return { fairAmerican: null, quoteAmerican: null, fairP: null, quoteP: null };
    }
    const yesProbs = [];
    const sides = [];
    for (const leg of legs) {
      const yp = yesForLeg(venue, leg);
      if (yp == null) {
        return { fairAmerican: null, quoteAmerican: null, fairP: null, quoteP: null };
      }
      yesProbs.push(yp);
      sides.push(leg.side);
    }
    return quoteUnhedged(venue, legs, yesProbs, sides);
  }

  function seed(venue, key, yesProb) {
    if (!(yesProb > 0 && yesProb < 1)) return;
    if (venue === 'kalshi') kalshi.set(String(key).toUpperCase(), yesProb);
    else if (venue === 'polymarket') {
      const slug = String(key).toLowerCase();
      poly.set(slug, yesProb);
      pendingPm.add(slug);
    }
  }

  async function refreshKalshi() {
    if (typeof listKalshiMarkets !== 'function') return;
    const next = new Map();
    for (const series of KALSHI_ML_SERIES) {
      let cursor = undefined;
      for (let page = 0; page < KALSHI_MAX_PAGES; page++) {
        const res = await listKalshiMarkets(series, cursor);
        const markets = (res && res.markets) || [];
        for (const m of markets) {
          const ticker = String((m && m.ticker) || '').toUpperCase();
          if (!isKalshiMlTicker(ticker, series)) continue;
          const yp = yesProbFromKalshiMarket(m);
          if (yp != null) next.set(ticker, yp);
        }
        cursor = res && (res.cursor || res.next_cursor) || '';
        if (!cursor || !markets.length) break;
      }
    }
    kalshi.clear();
    for (const [k, v] of next) kalshi.set(k, v);
  }

  async function refreshPm() {
    if (typeof fetchPmMarket !== 'function') return;
    const slugs = [...pendingPm];
    for (const slug of slugs) {
      try {
        const m = await fetchPmMarket(slug);
        const yp = yesProbFromPmMarket(m);
        if (yp != null) poly.set(slug, yp);
        else poly.delete(slug);
      } catch (_) {
        // keep last good price
      }
    }
  }

  async function refresh() {
    if (refreshing) return { kalshi: kalshi.size, poly: poly.size, skipped: true };
    refreshing = true;
    try {
      await refreshKalshi();
      await refreshPm();
      return { kalshi: kalshi.size, poly: poly.size };
    } finally {
      refreshing = false;
    }
  }

  function start(env = process.env) {
    const ms = opts.intervalMs != null ? opts.intervalMs : refreshIntervalMs(env);
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      refresh().catch((e) => console.error('[UNHEDGED] price refresh', e && e.message));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    remember,
    price,
    seed,
    refresh,
    start,
    stop,
    yesForLeg,
    setListKalshiMarkets,
    setFetchPmMarket,
    _kalshi: kalshi,
    _poly: poly,
    _pendingPm: pendingPm,
  };
}

module.exports = {
  KALSHI_ML_SERIES,
  KALSHI_COMBO_MAKER,
  YES_MARGIN,
  DEFAULT_INTERVAL_MS,
  makerFeeCoeff,
  fairYesProb,
  netCostYes,
  wouldQuoteYesRaw,
  wouldQuoteYesProb,
  quoteUnhedged,
  yesProbFromKalshiMarket,
  yesProbFromPmMarket,
  createUnhedgedPriceCache,
};
