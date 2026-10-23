// Polymarket combo sniper — Phase 1 DRY RUN inside poly-worker. Posts NOTHING.
// poly-worker calls observe(raw, src) for every RFQ it already received (WS or crawl).
// We price it, decide what we WOULD quote, and log to Supabase poly_sniper_decisions.
'use strict';
const { dryRunOn, enabled, assertNoTradingClient } = require('./guard');
const { createPolySniperFeed } = require('./feed');
const { decidePoly, polySniperConfig, createVenueLedger } = require('./engine');

// Local read-only normalizer (same fields as polymarket-rfq.js normalizePolymarketRfq). Kept here so
// this module never loads the Polymarket HTTP/trading client.
function normalizePolymarketRfq(raw) {
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
  };
}

function createDecisionLogger({ supabase, log = console.log, batchMs = 2000, maxBatch = 200, logSkips = true }) {
  let buf = []; let warned = false;
  async function flush() {
    if (!buf.length || !supabase) { buf = []; return; }
    const rows = buf.splice(0, maxBatch);
    try {
      const { error } = await supabase.from('poly_sniper_decisions').insert(rows);
      if (error && !warned) { warned = true; log(`[POLY-SNIPER] poly_sniper_decisions insert failed (table missing?): ${error.message}`); }
    } catch (e) { if (!warned) { warned = true; log(`[POLY-SNIPER] insert threw: ${e.message}`); } }
  }
  const t = setInterval(flush, batchMs); if (t.unref) t.unref();
  return { push(row) { if (!logSkips && row.action !== 'quote') return; buf.push(row); if (buf.length > 5000) buf.splice(0, buf.length - 5000); }, flush };
}

function createPolySniper({ env = process.env, supabase = null, log = console.log, feed = null, now = () => Date.now() } = {}) {
  if (!enabled(env)) return null;
  if (!dryRunOn(env)) throw new Error('POLY_SNIPER_DRY_RUN must be exactly 1: Phase 1 is dry run only (no live mode exists yet)');
  assertNoTradingClient({ feed });
  const config = polySniperConfig(env);
  const f = feed || createPolySniperFeed({ env, log });
  const ledger = createVenueLedger('polymarket');
  const logger = createDecisionLogger({ supabase, log, logSkips: String(env.POLY_SNIPER_LOG_SKIPS || '1') !== '0' });
  const seen = new Set();
  const counts = { seen: 0, quote: 0, skip: {} };
  function observe(raw, src) {
    const t0 = now();
    let rfq;
    try { rfq = normalizePolymarketRfq(raw); } catch (_) { rfq = null; }
    if (!rfq || !rfq.rfqId || seen.has(rfq.rfqId)) return null;
    seen.add(rfq.rfqId); if (seen.size > 100000) seen.clear();
    counts.seen += 1;
    let d;
    try { d = decidePoly(rfq, { feed: f, config, ledger, nowMs: t0 }); } catch (e) { d = { rfqId: rfq.rfqId, action: 'skip', reason: `error:${String(e.message).slice(0, 60)}` }; }
    const t1 = now();
    const created = Date.parse(rfq.createdTime || '');
    const ageMs = Number.isFinite(created) ? t1 - created : null;
    if (d.action === 'quote') counts.quote += 1; else counts.skip[d.reason] = (counts.skip[d.reason] || 0) + 1;
    logger.push({
      rfq_id: rfq.rfqId, venue: 'polymarket', dry_run: true, source: src || null, symbol: rfq.symbol || null,
      action: d.action, reason: d.reason || null,
      leg_count: Array.isArray(rfq.comboLegs) ? rfq.comboLegs.length : null,
      legs: d.legs || (rfq.comboLegs || []).map((l) => ({ polySymbol: l.symbol, polySide: l.side })),
      fair: d.fair != null ? d.fair : null, buy_price: d.buyPrice != null ? d.buyPrice : null,
      edge: d.roi != null && Number.isFinite(d.roi) ? d.roi : null, min_edge: d.minRoi != null ? d.minRoi : null,
      ev: d.ev != null ? d.ev : null, risk: d.risk != null ? d.risk : null, contracts: d.contracts != null ? d.contracts : null,
      qty_decimal: rfq.qtyDecimal != null ? Number(rfq.qtyDecimal) : null, cash_order_qty: rfq.cashOrderQty != null ? Number(rfq.cashOrderQty) : null,
      games: d.games || null, rfq_created_at: Number.isFinite(created) ? new Date(created).toISOString() : null,
      decide_ms: t1 - t0, rfq_age_ms: ageMs, within_target: ageMs != null ? ageMs <= config.latencyTargetMs : null,
    });
    return d;
  }
  const hb = setInterval(() => {
    const top = Object.entries(counts.skip).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}=${v}`).join(' ');
    log(`[POLY-SNIPER] DRY RUN seen=${counts.seen} would_quote=${counts.quote} index=${f.index.size()} healthy=${f.pricesHealthy()} venues=${f.venues.join('+')} ${top}`);
  }, 60000);
  if (hb.unref) hb.unref();
  return { start: () => { if (!feed) f.start(); log(`[POLY-SNIPER] DRY RUN started (posts nothing). fair venues=${f.venues.join('+')} depth game=$${f.depths ? f.depths.game : '?'} td=$${f.depths ? f.depths.td : '?'}`); }, observe, counts, ledger, flush: logger.flush };
}
module.exports = { createPolySniper, normalizePolymarketRfq };
