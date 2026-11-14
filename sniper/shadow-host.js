// Shadow tape that rides feeds this process already has.
//
// kaygo-combo-worker already reads the Kalshi RFQ firehose. kaygo-poly-worker
// already reads Polymarket US RFQs. With SNIPER_SHADOW_MIN_EDGE set (and the
// sniper enable flags left off), this host prices those RFQs and writes
// sniper_shadow_quotes. It never builds a quote client and attachTrading()
// throws.
//
// Books are the same read-only inverse-bet books as the Polymarket sniper
// (public Kalshi orderbooks + the odds relay). No Kalshi trading key, no
// Polymarket trading key.
'use strict';
const { sniperConfig } = require('../auto-sniper');
const { createSeriesFeeCache, seriesOfTicker } = require('../series-fee');
const { rfqAgeMs } = require('../quote-sender');
const { decide } = require('./engine');
const { shadowMinEdge, shadowThenLive, createShadowLogger } = require('./shadow');
const { decidePoly, polySniperConfig, polyMinRoi, createVenueLedger } = require('../poly-sniper/engine');
const { createPolySniperFeed } = require('../poly-sniper/feed');
const { assertNoTradingClient } = require('../poly-sniper/guard');
const { polyComboMakerFeeDollars } = require('../poly-combo-fee');

// Live minimums from fly/sniper.toml and fly/poly-worker.toml (Kevin Nov 1: 8%).
// An explicit env value still wins. Enable flags are forced off on the copy
// this host prices with; process.env is not written.
const LIVE_DEFAULTS = {
  SNIPER_MIN_ROI: '0.08',
  SNIPER_MIN_ROI_TD: '0.08',
  SNIPER_MIN_ROI_NCAAF: '0.08',
  SNIPER_MIN_ROI_LINES: '0.08',
  SNIPER_MIN_ROI_NBA: '0.08',
  SNIPER_MIN_ROI_NCAAB: '0.08',
  SNIPER_NBA: '1',
  SNIPER_LINES: '1',
  SNIPER_NCAAB: '0',
  SNIPER_NCAAF: '1',
  POLY_SNIPER_MIN_ROI_NFL_ML: '0.08',
  POLY_SNIPER_MIN_ROI_NFL: '0.08',
  POLY_SNIPER_MIN_ROI_TD: '0.08',
  POLY_SNIPER_MIN_ROI_NCAAF: '0.08',
  POLY_SNIPER_MIN_ROI_NBA: '0.08',
  POLY_SNIPER_MIN_ROI_NCAAB: '0.08',
  POLY_SNIPER_NCAAB: '0',
  SNIPER_ODDS_RELAY_URL: 'http://kaygo-odds-relay.internal:8787',
};

function shadowPricingEnv(env = {}) {
  const out = { ...LIVE_DEFAULTS };
  for (const [k, v] of Object.entries(env || {})) {
    if (v == null || String(v).trim() === '') continue;
    if (k.startsWith('SNIPER_') || k.startsWith('POLY_SNIPER_')) out[k] = v;
  }
  out.SNIPER_ENABLED = '0';
  out.SNIPER_DRY_RUN = '1';
  delete out.SNIPER_LIVE_CONFIRM;
  delete out.POLY_SNIPER_ENABLED;
  out.POLY_SNIPER_DRY_RUN = '1';
  return out;
}

function normalizePoly(raw) {
  const r = raw && raw.rfq && typeof raw.rfq === 'object' ? raw.rfq : raw;
  if (!r || typeof r !== 'object') return null;
  const legs = r.comboLegs || r.combo_legs || r.legs || null;
  return {
    rfqId: r.id || r.rfqId || r.rfq_id || null,
    symbol: r.symbol || null,
    qtyDecimal: r.qtyDecimal != null ? r.qtyDecimal : r.qty_decimal,
    cashOrderQty: r.cashOrderQty != null ? r.cashOrderQty : r.cash_order_qty,
    comboLegs: Array.isArray(legs) ? legs : null,
    createdTime: r.createdTime || r.created_time || null,
    tickSize: r.tickSize != null ? r.tickSize : (r.tick_size != null ? r.tick_size : null),
    quotes: Array.isArray(r.quotes) ? r.quotes : (Array.isArray(r.competingQuotes) ? r.competingQuotes : null),
    tradedYes: r.tradedYes != null ? r.tradedYes : (r.traded_yes != null ? r.traded_yes : null),
    status: r.status || null,
    filled: r.filled === true ? true : (r.filled === false ? false : null),
  };
}

function createSniperShadow({ env = process.env, supabase = null, log = console.log, feed = null, feeCache = null, now = () => Date.now() } = {}) {
  const edge = shadowMinEdge(env);
  if (edge == null) return null;
  assertNoTradingClient({ feed });
  const pricing = shadowPricingEnv(env);
  const config = sniperConfig(pricing);
  const polyConfig = polySniperConfig(pricing);
  const ownFeed = !feed;
  const f = feed || createPolySniperFeed({ env: pricing, log });
  assertNoTradingClient({ feed: f });
  const logger = createShadowLogger({ supabase, log, label: 'SNIPER-SHADOW' });
  const fees = feeCache || createSeriesFeeCache({ log });
  const seen = new Set();
  let warned = false;
  function warn(e) {
    if (warned) return;
    warned = true;
    log(`[SNIPER-SHADOW] note failed: ${e && e.message ? e.message : e}`);
  }
  function books() {
    return {
      pmLive: f.pmLive,
      tdBook: f.tdBook,
      ncaafBook: f.ncaafBook,
      linesBook: f.linesBook,
      nbaBook: f.nbaBook,
      ncaabBook: f.ncaabBook,
      venues: f.venues,
      kickoffFor: (t) => (f.kickoffs && f.kickoffs.kickoffFor ? f.kickoffs.kickoffFor(t) : null),
      pricesHealthy: (t) => (typeof f.pricesHealthy === 'function' ? f.pricesHealthy(t) : false),
    };
  }
  async function onKalshiRfq(rfq) {
    try {
      if (!rfq || !rfq.isCombo || !rfq.rfqId) return null;
      if (seen.has(`k:${rfq.rfqId}`)) return null;
      seen.add(`k:${rfq.rfqId}`);
      if (seen.size > 100000) seen.clear();
      const nowMs = now();
      const age = rfqAgeMs(rfq.createdTs, nowMs);
      let makerRate = 0.035;
      try {
        const entry = await fees.prefetch(seriesOfTicker(rfq.marketTicker));
        if (entry && entry.rate != null) makerRate = entry.rate;
      } catch (_) { /* conservative 0.035 */ }
      const b = books();
      const out = decide(rfq, {
        config, pmLive: b.pmLive, tdBook: b.tdBook, ncaafBook: b.ncaafBook, linesBook: b.linesBook,
        nbaBook: b.nbaBook, ncaabBook: b.ncaabBook, venues: b.venues, kickoffFor: b.kickoffFor,
        makerRate, nowMs, pricesHealthy: b.pricesHealthy(nowMs), shadow: true,
      });
      const maxAge = Number(pricing.SNIPER_MAX_RFQ_AGE_MS);
      return shadowThenLive({
        shadowEdge: edge,
        liveEdge: out.decision && out.decision.minRoi != null ? out.decision.minRoi : null,
        venue: 'kalshi',
        rfq,
        row: out.row,
        decision: out.decision,
        makerRate,
        tick: config.tick,
        nowMs,
        rfqAgeMs: age,
        maxAgeMs: maxAge > 0 ? maxAge : 2000,
        pricesHealthy: b.pricesHealthy(nowMs),
      }, logger);
    } catch (e) { warn(e); return null; }
  }
  function onPolyRfq(raw) {
    try {
      const rfq = normalizePoly(raw);
      if (!rfq || !rfq.rfqId) return null;
      if (seen.has(`p:${rfq.rfqId}`)) return null;
      seen.add(`p:${rfq.rfqId}`);
      if (seen.size > 100000) seen.clear();
      const nowMs = now();
      const created = Date.parse(rfq.createdTime || '');
      const age = Number.isFinite(created) ? nowMs - created : null;
      const b = books();
      const d = decidePoly(rfq, {
        feed: f, config: polyConfig, ledger: createVenueLedger('polymarket'), nowMs, skipLedger: true,
      });
      const legs = Array.isArray(d.legs) ? d.legs : null;
      const tick = Number(rfq.tickSize);
      return shadowThenLive({
        shadowEdge: edge,
        liveEdge: d.minRoi != null ? d.minRoi : (legs ? polyMinRoi(legs, polyConfig) : null),
        venue: 'polymarket',
        rfq: { ...rfq, marketTicker: rfq.symbol || null },
        row: legs ? {
          legs,
          contracts: Number(rfq.qtyDecimal) > 0 ? Number(rfq.qtyDecimal) : null,
          cash_size: Number(rfq.cashOrderQty) > 0 ? Number(rfq.cashOrderQty) : null,
        } : null,
        decision: d,
        makerRate: 0,
        feeDollars: (n, q) => polyComboMakerFeeDollars(n, q, nowMs),
        tick: tick > 0 && tick < 0.1 ? tick : 0.001,
        nowMs,
        rfqAgeMs: age,
        maxAgeMs: 0,
        pricesHealthy: b.pricesHealthy(nowMs),
      }, logger);
    } catch (e) { warn(e); return null; }
  }
  function start() {
    if (ownFeed && f.start) f.start();
    log(`[SNIPER-SHADOW] on at ${(edge * 100).toFixed(2)}% (inverse bet). No quote client. Sniper enable flags are not changed.`);
  }
  function attachTrading() {
    throw new Error('sniper shadow has no quote client and cannot send a quote');
  }
  return {
    edge, onKalshiRfq, onPolyRfq, start, attachTrading, flush: () => logger.flush(), stop: () => { if (logger.stop) logger.stop(); if (f.stop) f.stop(); },
  };
}

module.exports = { createSniperShadow, shadowPricingEnv, normalizePoly, LIVE_DEFAULTS };
