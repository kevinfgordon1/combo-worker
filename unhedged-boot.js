// Shared Unhedged RFQ side-car: price cache, venue fetchers, fill tracker.
// Used by unhedged-runner (its own Railway job) and by live-runner only when
// WORKER_MODE=all. Combo Locks default must not call startUnhedgedSide.
//
// Paper/shadow only. UNHEDGED_RFQ_LIVE stays off. No Combo Lock quote
// POST/confirm. Own Kalshi /markets cache + Poly last-trade fill lookup.
'use strict';
const { matchParlay } = require('./rfq');
const { createPolymarketHttp } = require('./polymarket-client');
const {
  fetchPolymarketUnhedgedRfq,
  fetchPolymarketUnhedgedTrades,
} = require('./polymarket-rfq');
const {
  persistUnhedgedRfq,
  shadowUnhedgedMiss,
  createUnhedgedFillTracker,
  DEFAULT_FILL_TICK_MS,
} = require('./unhedged-rfq');
const { createUnhedgedPriceCache } = require('./unhedged-price-cache');

function createPolyUnhedgedHttp(env = process.env) {
  const keyId = env.POLYMARKET_KEY_ID;
  const secretKey = env.POLYMARKET_SECRET_KEY;
  if (!keyId || !secretKey) return null;
  return createPolymarketHttp({ keyId, secretKey });
}

function createUnhedgedVenueFetchers({ fetchKalshiRfq, fetchKalshiTrades, polyHttp }) {
  async function fetchUnhedgedVenueRfq(rfqId, row) {
    if (row && row.venue === 'polymarket') {
      if (!polyHttp) return null;
      return fetchPolymarketUnhedgedRfq(polyHttp, rfqId);
    }
    return fetchKalshiRfq(rfqId);
  }

  async function fetchUnhedgedVenueTrades(ticker, minTs, maxTs, row) {
    if (row && row.venue === 'polymarket') {
      if (!polyHttp) return [];
      return fetchPolymarketUnhedgedTrades(polyHttp, ticker, minTs, maxTs, row);
    }
    return fetchKalshiTrades(ticker, minTs, maxTs);
  }

  return { fetchUnhedgedVenueRfq, fetchUnhedgedVenueTrades };
}

function persistUnhedgedRow(supabase, fills, row) {
  if (fills) fills.remember(row);
  return persistUnhedgedRfq(supabase, row).then((out) => {
    if (out && out.alreadyFilled && fills) {
      fills.remember({ venue: row.venue, rfq_id: row.rfq_id, status: 'filled' });
    }
    return out;
  });
}

// Combo-lock matches stay on the Combo Locks job. Unhedged only papers
// unmatched in-scope MLB/NFL full-game moneylines (classify in unhedged-rfq).
function handleKalshiUnhedgedCreated(rfq, opts = {}) {
  if (!rfq || !rfq.isCombo) return { action: 'skip', reason: 'not_combo' };
  if (rfq.contracts == null && !(rfq.targetCostDollars > 0)) {
    return { action: 'skip', reason: 'no_size' };
  }
  const locks = typeof opts.getParlays === 'function'
    ? (opts.getParlays() || [])
    : (opts.parlays || []);
  if (matchParlay(rfq, locks)) return { action: 'skip', reason: 'combo_lock' };

  const missRfq = rfq;
  shadowUnhedgedMiss(missRfq, {
    venue: 'kalshi',
    extra: opts.extra || null,
    persist: opts.persist,
    supabase: opts.supabase,
    env: opts.env,
    priceCache: opts.priceCache,
    onPersisted: (row) => {
      if (typeof opts.onPersisted === 'function') {
        try { opts.onPersisted(row); } catch (_) {}
      }
      if (opts.fills) {
        opts.fills.remember({
          ...row,
          market_ticker: missRfq.marketTicker || missRfq.market_ticker || null,
        });
      }
    },
  });
  return { action: 'shadow' };
}

function startUnhedgedSide(opts = {}) {
  const env = opts.env || process.env;
  const supabase = opts.supabase;
  const kalshiGet = opts.kalshiGet;
  if (typeof kalshiGet !== 'function') {
    throw new Error('startUnhedgedSide requires kalshiGet');
  }

  async function fetchKalshiMarkets(series, cursor) {
    const qs = new URLSearchParams({
      series_ticker: series,
      status: 'open',
      limit: String(200),
    });
    if (cursor) qs.set('cursor', String(cursor));
    return kalshiGet('/trade-api/v2/markets', qs.toString());
  }

  async function fetchKalshiRfq(rfqId) {
    const { statusCode, json } = await kalshiGet(`/trade-api/v2/communications/rfqs/${rfqId}`);
    if (statusCode === 404 || !json) return null;
    return json.rfq || json;
  }

  async function fetchKalshiTrades(ticker, minTs, maxTs) {
    const qs = new URLSearchParams({
      ticker: String(ticker),
      min_ts: String(minTs),
      max_ts: String(maxTs),
      limit: '100',
    });
    const { json } = await kalshiGet('/trade-api/v2/markets/trades', qs.toString());
    return (json && json.trades) || [];
  }

  const polyHttp = opts.polyHttp !== undefined ? opts.polyHttp : createPolyUnhedgedHttp(env);
  const prices = createUnhedgedPriceCache({
    env,
    shouldPause: opts.shouldPause,
    fetchKalshiMarkets,
  });
  if (opts.autoStart !== false) prices.start();

  const { fetchUnhedgedVenueRfq, fetchUnhedgedVenueTrades } = createUnhedgedVenueFetchers({
    fetchKalshiRfq: opts.fetchKalshiRfq || fetchKalshiRfq,
    fetchKalshiTrades: opts.fetchKalshiTrades || fetchKalshiTrades,
    polyHttp,
  });

  const fills = createUnhedgedFillTracker({
    supabase,
    env,
    fetchRfq: fetchUnhedgedVenueRfq,
    fetchTrades: fetchUnhedgedVenueTrades,
  });
  if (opts.autoHydrate !== false && fills && typeof fills.hydrate === 'function') {
    fills.hydrate().catch((e) => console.error('[UNHEDGED] fill hydrate', e && e.message));
  }

  const fillMs = opts.fillTickMs != null ? opts.fillTickMs : DEFAULT_FILL_TICK_MS;
  let fillTimer = null;
  if (opts.autoTick !== false) {
    fillTimer = setInterval(() => {
      if (typeof opts.shouldPause === 'function' && opts.shouldPause()) return;
      fills.tick().catch((e) => console.error('[UNHEDGED] fill tick', e && e.message));
    }, fillMs);
    if (fillTimer.unref) fillTimer.unref();
  }

  function persist(row) {
    return persistUnhedgedRow(supabase, fills, row);
  }

  function stop() {
    if (fillTimer) clearInterval(fillTimer);
    fillTimer = null;
    try { prices && prices.stop && prices.stop(); } catch (_) {}
    try { polyHttp && polyHttp.close && polyHttp.close(); } catch (_) {}
  }

  return {
    prices,
    fills,
    polyHttp,
    persist,
    fetchUnhedgedVenueRfq,
    fetchUnhedgedVenueTrades,
    fetchKalshiRfq,
    fetchKalshiTrades,
    stop,
  };
}

module.exports = {
  createPolyUnhedgedHttp,
  createUnhedgedVenueFetchers,
  persistUnhedgedRow,
  handleKalshiUnhedgedCreated,
  startUnhedgedSide,
};
