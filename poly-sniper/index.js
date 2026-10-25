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

// Batched inserts: drains the whole buffer in chunks of maxBatch every batchMs, and flushes early
// once a chunk is full, so ~100+ rows/sec bursts are written instead of silently dropped.
// One flush at a time; rows are only dropped past maxBuffer (counted, logged once a minute).
// Skip rows (~400/s, ~99% of traffic, never read) are NOT inserted. They're counted per reason and
// flushed once a minute as one action='skip_summary' row per reason (count in contracts, no legs) plus
// a log line. skipSample (0..1, env POLY_SNIPER_SKIP_SAMPLE / SNIPER_SKIP_SAMPLE, default 0) keeps a
// random fraction of full skip rows for debugging. Non-skip rows are inserted as before (batched).
function createDecisionLogger({ supabase, log = console.log, batchMs = 1000, maxBatch = 500, maxBuffer = 20000, logSkips = true, skipSample = 0, summaryMs = 60000, random = Math.random, now = () => Date.now() }) {
  let buf = []; let warned = false; let busy = false; let inflight = null;
  const stats = { pushed: 0, written: 0, dropped: 0, failed: 0, skipped: 0, sampled: 0, summaries: 0 };
  let skipCounts = new Map(); let windowStart = now();
  function enqueue(row) {
    stats.pushed += 1; buf.push(row);
    if (buf.length > maxBuffer) { const n = buf.length - maxBuffer; buf.splice(0, n); stats.dropped += n; }
    if (buf.length >= maxBatch && !busy) setImmediate(flush);
  }
  function summarize() {
    const counts = skipCounts; const t0 = windowStart; skipCounts = new Map(); windowStart = now();
    if (!counts.size) return 0;
    const tot = [...counts.values()].reduce((a, b) => a + b, 0);
    log(`[POLY-SNIPER] skip summary ${Math.round((windowStart - t0) / 1000)}s total=${tot} ${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    if (logSkips) {
      for (const [reason, c] of counts) {
        enqueue({ rfq_id: `skip_summary:${new Date(t0).toISOString()}`, venue: 'polymarket', dry_run: true, action: 'skip_summary', reason, contracts: c, legs: null, rfq_created_at: new Date(t0).toISOString() });
        stats.summaries += 1;
      }
    }
    return counts.size;
  }
  // Concurrent callers share the in-flight drain and then drain anything that arrived meanwhile.
  function flush() {
    if (inflight) return inflight.then(() => (buf.length && supabase ? flush() : undefined));
    inflight = drain().finally(() => { inflight = null; });
    return inflight;
  }
  async function drain() {
    busy = true;
    try {
      while (buf.length) {
        if (!supabase) { buf = []; break; }
        const rows = buf.splice(0, maxBatch);
        try {
          const { error } = await supabase.from('poly_sniper_decisions').insert(rows);
          if (error) { stats.failed += rows.length; if (!warned) { warned = true; log(`[POLY-SNIPER] poly_sniper_decisions insert failed (table missing?): ${error.message}`); } break; }
          stats.written += rows.length;
        } catch (e) { stats.failed += rows.length; if (!warned) { warned = true; log(`[POLY-SNIPER] insert threw: ${e.message}`); } break; }
      }
    } finally { busy = false; }
  }
  const t = setInterval(flush, batchMs); if (t.unref) t.unref();
  const st = setInterval(summarize, summaryMs); if (st.unref) st.unref();
  return {
    stats, flush,
    push(row) {
      if (row && row.action === 'skip') {
        stats.skipped += 1;
        const k = row.reason || 'unknown'; skipCounts.set(k, (skipCounts.get(k) || 0) + 1);
        if (logSkips && skipSample > 0 && random() < skipSample) { stats.sampled += 1; enqueue(row); }
        return;
      }
      if (!logSkips && row.action !== 'quote') return;
      enqueue(row);
    },
    summarize,
    skipCounts: () => Object.fromEntries(skipCounts),
    size: () => buf.length,
  };
}

function skipSampleFrom(env) {
  const v = Number(env.POLY_SNIPER_SKIP_SAMPLE != null ? env.POLY_SNIPER_SKIP_SAMPLE : env.SNIPER_SKIP_SAMPLE);
  return Number.isFinite(v) && v > 0 ? Math.min(1, v) : 0;
}

// Per-leg record for the tape: every Poly leg with whether it matched a Kalshi-equivalent leg.
function legRows(rfq, d) {
  if (Array.isArray(d.legs) && d.legs.length) return d.legs.map((l) => ({ ...l, matched: true }));
  const hit = new Map(((d.matched) || []).map((m) => [`${m.polySymbol}|${m.polySide}`, m]));
  return (rfq.comboLegs || []).map((l) => {
    const m = hit.get(`${l.symbol}|${l.side}`);
    return m ? { polySymbol: l.symbol, polySide: l.side, ticker: m.ticker, side: m.side, matched: true } : { polySymbol: l.symbol, polySide: l.side, matched: false };
  });
}

function createPolySniper({ env = process.env, supabase = null, log = console.log, feed = null, now = () => Date.now() } = {}) {
  if (!enabled(env)) return null;
  if (!dryRunOn(env)) throw new Error('POLY_SNIPER_DRY_RUN must be exactly 1: Phase 1 is dry run only (no live mode exists yet)');
  assertNoTradingClient({ feed });
  const config = polySniperConfig(env);
  const f = feed || createPolySniperFeed({ env, log });
  const ledger = createVenueLedger('polymarket');
  const logger = createDecisionLogger({ supabase, log, logSkips: String(env.POLY_SNIPER_LOG_SKIPS || '1') !== '0', skipSample: skipSampleFrom(env) });
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
      legs: legRows(rfq, d),
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
    log(`[POLY-SNIPER] DRY RUN seen=${counts.seen} would_quote=${counts.quote} index=${f.index.size()} td_index=${f.index.tdStats ? `${f.index.tdStats().indexed}/${f.index.tdStats().seen}` : '?'} tape=${logger.stats.written}w/${logger.stats.dropped}d healthy=${f.pricesHealthy()} venues=${f.venues.join('+')} ${top}`);
  }, 60000);
  if (hb.unref) hb.unref();
  return { start: () => { if (!feed) f.start(); log(`[POLY-SNIPER] DRY RUN started (posts nothing). fair venues=${f.venues.join('+')} depth game=$${f.depths ? f.depths.game : '?'} td=$${f.depths ? f.depths.td : '?'} minEdge=ml:${(config.minRoiNflMl * 100).toFixed(1)}%,nfl:${(config.minRoiNfl * 100).toFixed(1)}%,ncaaf:${(config.minRoiNcaaf * 100).toFixed(1)}%,td:${(config.minRoiTd * 100).toFixed(1)}%`); }, observe, counts, ledger, flush: logger.flush };
}
module.exports = { createPolySniper, normalizePolymarketRfq, createDecisionLogger, legRows, skipSampleFrom };
