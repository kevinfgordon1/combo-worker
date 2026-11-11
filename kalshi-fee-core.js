// Kalshi public GET /series fee terms. No authenticated or trading endpoints.
// https://docs.kalshi.com/api-reference/market/get-series
// Expired entries are never extended on error: use a logged, conservative fallback
// for one minute, then retry. Successful terms live for at most fifteen minutes.
'use strict';
const DEFAULTS = Object.freeze({ KXMLBGAME: 0.5, KXMLBHR: 0.5 });
const TTL_MS = 15 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const FALLBACK_MAKER_RATE = 0.035;
const FEE_TYPES = new Set(['quadratic', 'quadratic_with_maker_fees', 'quadratic_with_combo_maker_fees']);

function seriesOfTicker(ticker) {
  const value = String(ticker || '').trim().toUpperCase();
  return value.startsWith('KX') ? value.split('-')[0].split(':')[0] : null;
}
function fallbackMakerRate(ticker) {
  return seriesOfTicker(ticker) === 'KXMVECROSSCATEGORY0' ? 0 : FALLBACK_MAKER_RATE;
}
function takerRateFromSeries(feeType, multiplier, ticker) {
  const m = multiplier == null || multiplier === '' ? NaN : Number(multiplier);
  return 0.07 * (Number.isFinite(m) && m >= 0 ? m : (DEFAULTS[seriesOfTicker(ticker)] ?? 1));
}
function makerRateFromSeries(feeType, multiplier) {
  const m = multiplier == null || multiplier === '' ? 1 : Number(multiplier);
  const mult = Number.isFinite(m) && m >= 0 ? m : 1;
  if (feeType === 'quadratic') return 0;
  if (feeType === 'quadratic_with_maker_fees') return 0.0175 * mult;
  if (feeType === 'quadratic_with_combo_maker_fees') return 0.035 * mult;
  return FALLBACK_MAKER_RATE;
}

function createSeriesFeeCache({
  fetchImpl = (...args) => fetch(...args),
  base = 'https://api.elections.kalshi.com/trade-api/v2',
  now = () => Date.now(),
  log = console.warn,
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  const warned = new Map();
  const fresh = (entry) => entry && now() - entry.at < (entry.ok ? TTL_MS : RETRY_MS);

  function fallback(series, error) {
    if (!warned.has(series) || now() - warned.get(series) >= RETRY_MS) {
      log(`Kalshi fee fallback ${series}: ${error || 'missing/expired terms'}`);
      warned.set(series, now());
    }
    return {
      rate: fallbackMakerRate(series),
      takerRate: takerRateFromSeries(null, null, series),
      ok: false,
      at: now(),
    };
  }

  async function prefetch(ticker) {
    const series = seriesOfTicker(ticker);
    if (!series) return null;
    if (fresh(cache.get(series))) return cache.get(series);
    if (inflight.has(series)) return inflight.get(series);
    const promise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetchImpl(`${base}/series/${encodeURIComponent(series)}`, {
          headers: { accept: 'application/json' }, signal: controller.signal,
        });
        if (!response || !response.ok) throw Error(`HTTP ${response && response.status}`);
        const json = await response.json();
        const terms = json.series || json;
        if (!FEE_TYPES.has(terms.fee_type)) throw Error('unsupported fee_type');
        const entry = {
          rate: makerRateFromSeries(terms.fee_type, terms.fee_multiplier),
          takerRate: takerRateFromSeries(terms.fee_type, terms.fee_multiplier, series),
          feeType: terms.fee_type,
          multiplier: terms.fee_multiplier,
          ok: true,
          at: now(),
        };
        cache.set(series, entry);
        return entry;
      } catch (error) {
        const entry = fallback(series, error.message);
        cache.set(series, entry);
        return entry;
      } finally {
        clearTimeout(timer);
        inflight.delete(series);
      }
    })();
    inflight.set(series, promise);
    return promise;
  }

  function entry(ticker) {
    const series = seriesOfTicker(ticker);
    if (!series) return fallback(series);
    const value = cache.get(series);
    if (!fresh(value)) {
      // Synchronous pricing callers never block on a network read.
      prefetch(series).catch(() => {});
      return fallback(series);
    }
    return value;
  }
  return {
    prefetch,
    prefetchTickers: (tickers) => Promise.all([...new Set((tickers || []).map(seriesOfTicker).filter(Boolean))].map(prefetch)),
    rateForTicker: (ticker) => entry(ticker).rate,
    takerRateForTicker: (ticker) => entry(ticker).takerRate,
    _cache: cache,
  };
}
module.exports = { TTL_MS, RETRY_MS, FALLBACK_MAKER_RATE, seriesOfTicker, fallbackMakerRate, makerRateFromSeries, takerRateFromSeries, createSeriesFeeCache };
