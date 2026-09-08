// Shared Unhedged shadow wiring — price cache, fill tracker, persist.
// Used by unhedged-runner (always) and live-runner when UNHEDGED_IN_PROCESS
// is on. Never POSTs. Combo Locks quote / miss-tape / reserve stay elsewhere.
'use strict';
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
const { matchParlay } = require('./rfq');

function createPolyUnhedgedHttp(env = process.env) {
  const keyId = env && env.POLYMARKET_KEY_ID;
  const secretKey = env && env.POLYMARKET_SECRET_KEY;
  if (!keyId || !secretKey) return null;
  return createPolymarketHttp({ keyId, secretKey });
}

// Kalshi firehose → shadow only when the combo does not match Combo Locks.
// Same-slate different games are OK (unhedged-rfq classify). Lock match is not.
function considerKalshiUnhedged(rfq, parlays) {
  if (!rfq || !rfq.isCombo) return { action: 'skip', reason: 'not_combo' };
  if (rfq.contracts == null && (rfq.targetCostDollars == null || !(rfq.targetCostDollars > 0))) {
    return { action: 'skip', reason: 'no_size' };
  }
  const p = matchParlay(rfq, parlays || []);
  if (p) return { action: 'skip', reason: 'lock_match', parlay: p };
  return { action: 'shadow', reason: 'lock_miss' };
}

function createUnhedgedRuntime(opts = {}) {
  const env = opts.env || process.env;
  const supabase = opts.supabase || null;
  const polyHttp = opts.polyHttp !== undefined
    ? opts.polyHttp
    : createPolyUnhedgedHttp(env);
  const fetchKalshiRfq = opts.fetchKalshiRfq;
  const fetchKalshiTrades = opts.fetchKalshiTrades;

  async function fetchVenueRfq(rfqId, row) {
    if (row && row.venue === 'polymarket') {
      if (!polyHttp) return null;
      return fetchPolymarketUnhedgedRfq(polyHttp, rfqId);
    }
    if (typeof fetchKalshiRfq !== 'function') return null;
    return fetchKalshiRfq(rfqId);
  }

  async function fetchVenueTrades(ticker, minTs, maxTs, row) {
    if (row && row.venue === 'polymarket') {
      if (!polyHttp) return [];
      return fetchPolymarketUnhedgedTrades(polyHttp, ticker, minTs, maxTs, row);
    }
    if (typeof fetchKalshiTrades !== 'function') return [];
    return fetchKalshiTrades(ticker, minTs, maxTs);
  }

  const prices = createUnhedgedPriceCache({
    env,
    shouldPause: opts.shouldPause,
    fetchKalshiMarkets: opts.fetchKalshiMarkets,
  });

  const fills = createUnhedgedFillTracker({
    supabase,
    persist: opts.persist,
    env,
    fetchRfq: fetchVenueRfq,
    fetchTrades: fetchVenueTrades,
  });

  function persistRow(row, meta) {
    if (row) fills.remember(row);
    if (typeof opts.persist === 'function') return opts.persist(row, meta);
    if (!supabase) return Promise.resolve(null);
    return persistUnhedgedRfq(supabase, row).then((out) => {
      if (out && out.alreadyFilled && row) {
        fills.remember({ venue: row.venue, rfq_id: row.rfq_id, status: 'filled' });
      }
      return out;
    });
  }

  function shadowKalshiMiss(rfq, extra) {
    const missExtra = extra && extra.msg ? { msg: extra.msg } : extra || null;
    shadowUnhedgedMiss(rfq, {
      venue: 'kalshi',
      extra: missExtra,
      persist: persistRow,
      supabase,
      env,
      priceCache: prices,
      onPersisted: (row) => {
        fills.remember({
          ...row,
          market_ticker: (rfq && (rfq.marketTicker || rfq.market_ticker)) || null,
        });
      },
    });
  }

  function onKalshiClosed(evt, extra) {
    const rfqId = evt && evt.rfqId;
    if (!rfqId) return Promise.resolve();
    return fills.onClosed({
      venue: 'kalshi',
      rfqId,
      extra,
      rfq: evt,
    });
  }

  function start() {
    if (prices && typeof prices.start === 'function') prices.start();
    if (fills && typeof fills.hydrate === 'function') {
      fills.hydrate().catch((e) => console.error('[UNHEDGED] fill hydrate', e && e.message));
    }
  }

  function stop() {
    try { prices && prices.stop && prices.stop(); } catch (_) {}
    try { polyHttp && polyHttp.close && polyHttp.close(); } catch (_) {}
  }

  function tick() {
    return fills.tick();
  }

  return {
    prices,
    fills,
    polyHttp,
    persistRow,
    shadowKalshiMiss,
    onKalshiClosed,
    start,
    stop,
    tick,
    fetchVenueRfq,
    fetchVenueTrades,
  };
}

module.exports = {
  createPolyUnhedgedHttp,
  createUnhedgedRuntime,
  considerKalshiUnhedged,
  DEFAULT_FILL_TICK_MS,
};
