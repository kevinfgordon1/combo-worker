// Shadow tape for the Combo Sniper. OFF unless SNIPER_SHADOW_MIN_EDGE is a
// probability in (0, 1), for example 0.03. For an RFQ that already cleared the
// sniper's staleness, age, and inverse-bet fair gates, this prices the quote
// we WOULD send at that edge and, beside it, at the live minimum (8% since
// 2026-11-01). It writes rows. It has no quote client and cannot post.
//
// Fair is the product of per-leg inverse-bet prices (best opposing ask across
// Kalshi, Polymarket US, Novig, and ProphetX, each with its own fee). This
// file does not reprice from a midpoint.
'use strict';
const { minQuotePrice } = require('../auto-sniper');
const { productFair, validProb } = require('../unhedged-quote');
const { americanFromProb } = require('../engine');

const TRADE_KEYS = ['postQuote', 'send', 'createQuote', 'confirmQuote', 'deleteQuote', 'acceptQuote', 'insertOrder', 'trader', 'live', 'http'];
// Gates that mean we would not price this RFQ. A live-minimum miss (roi_below_min*)
// is not in here: that is the RFQ the 3% tape exists to record.
const BLOCK_REASONS = new Set([
  'prices_stale', 'game_started', 'no_kickoff', 'nba_beyond_horizon', 'ncaab_beyond_horizon',
  'leg_beyond_max_days', 'kill_switch', 'bad_rfq', 'leg_mismatch', 'leg_no_fair',
  'leg_fair_out_of_range', 'combo_fair_too_low', 'no_size', 'too_many_legs', 'not_combo',
  'fair_below_mid', 'single_venue_thin', 'book_overround', 'rogue_fair_low',
]);

function shadowMinEdge(env = process.env) {
  const raw = env && env.SNIPER_SHADOW_MIN_EDGE;
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!(n > 0 && n < 1)) return null;
  return n;
}

function refuseTrading(ctx) {
  if (!ctx || typeof ctx !== 'object') return;
  for (const k of TRADE_KEYS) {
    if (ctx[k] != null) throw new Error(`sniper shadow refuses ${k}; it cannot send a quote`);
  }
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function legProb(leg) {
  if (!leg) return null;
  return validProb(Number(leg.fair_yes != null ? leg.fair_yes : leg.fair));
}

function legAge(leg) {
  if (!leg) return null;
  const a = leg.age_ms != null ? leg.age_ms : leg.ageMs;
  return a != null && Number.isFinite(Number(a)) ? Math.round(Number(a)) : null;
}

// Lowest YES already on the RFQ (the quote we would have to beat), if the
// payload included one. Missing quotes stay null. This does not fetch them.
function bestCompeting(rfq) {
  const list = rfq && (Array.isArray(rfq.quotes) ? rfq.quotes : (Array.isArray(rfq.competingQuotes) ? rfq.competingQuotes : null));
  let bestYes = null;
  if (list) {
    for (const q of list) {
      if (!q || typeof q !== 'object') continue;
      const st = String(q.status || 'open').toLowerCase();
      if (st !== 'open' && st !== 'quoted' && st !== '') continue;
      let yes = numOrNull(q.yes_bid_dollars != null ? q.yes_bid_dollars : q.yes_bid);
      if (yes == null) {
        const no = numOrNull(q.no_bid_dollars != null ? q.no_bid_dollars : q.no_bid);
        if (no > 0 && no < 1) yes = Math.round((1 - no) * 1e6) / 1e6;
      }
      if (!(yes > 0 && yes < 1)) continue;
      if (bestYes == null || yes < bestYes) bestYes = yes;
    }
  }
  if (bestYes == null) {
    const direct = numOrNull(rfq && (rfq.bestYes != null ? rfq.bestYes : rfq.best_yes));
    if (direct > 0 && direct < 1) bestYes = direct;
  }
  return { yes: bestYes, american: americanFromProb(bestYes) };
}

function knownFill(rfq) {
  const yes = numOrNull(rfq && (rfq.tradedYes != null ? rfq.tradedYes : (rfq.traded_yes != null ? rfq.traded_yes : rfq.tradeYes)));
  const status = String((rfq && rfq.status) || '').toLowerCase();
  let filled = null;
  if (yes != null) filled = true;
  else if (rfq && rfq.filled === true) filled = true;
  else if (rfq && rfq.filled === false) filled = false;
  else if (status === 'filled' || status === 'executed') filled = true;
  return { filled, tradeYes: yes, tradeAmerican: yes != null ? americanFromProb(yes) : null };
}

function ageBlocked(ctx) {
  if (!(Number(ctx.maxAgeMs) > 0)) return false;
  if (ctx.rfqAgeMs != null && Number.isFinite(Number(ctx.rfqAgeMs))) return Number(ctx.rfqAgeMs) > Number(ctx.maxAgeMs);
  return false;
}

function priceAt(fair, ctx, minRoi) {
  if (!(minRoi > 0 && minRoi < 1)) return null;
  const row = ctx.row || {};
  const contracts = row.contracts != null && Number(row.contracts) > 0 ? Number(row.contracts) : null;
  const cash = row.cash_size != null && Number(row.cash_size) > 0 ? Number(row.cash_size)
    : (row.cash != null && Number(row.cash) > 0 ? Number(row.cash) : null);
  if (contracts == null && cash == null) return null;
  return minQuotePrice({
    fair,
    contracts,
    cash,
    makerRate: ctx.makerRate != null ? ctx.makerRate : 0,
    minRoi,
    tick: ctx.tick > 0 ? ctx.tick : 0.001,
    feeDollars: ctx.feeDollars,
  });
}

function legRows(legs) {
  return legs.map((l) => {
    const p = legProb(l);
    return {
      ticker: l.ticker || null,
      side: l.side || 'yes',
      fair_yes: p,
      fair_american: americanFromProb(p),
      age_ms: legAge(l),
      venue: l.venue || null,
    };
  });
}

// -> insert row, or null when this RFQ would not be quoted at the shadow edge.
// Throws if ctx carries a trading function. Never calls one.
function considerShadow(ctx) {
  refuseTrading(ctx);
  const shadowEdge = ctx && ctx.shadowEdge != null ? ctx.shadowEdge : shadowMinEdge(ctx && ctx.env);
  if (!(shadowEdge > 0 && shadowEdge < 1)) return null;
  if (ctx.pricesHealthy === false) return null;
  if (ageBlocked(ctx)) return null;
  const d = ctx.decision;
  if (d && typeof d.reason === 'string' && (BLOCK_REASONS.has(d.reason) || d.reason.startsWith('scope_'))) return null;
  const legs = (ctx.row && Array.isArray(ctx.row.legs) && ctx.row.legs)
    || (d && Array.isArray(d.legs) ? d.legs : null);
  if (!legs || legs.length < 2) return null;
  const fair = productFair(legs.map(legProb));
  if (fair == null) return null;
  const shadow = priceAt(fair, ctx, shadowEdge);
  if (!shadow) return null;
  const liveEdge = ctx.liveEdge != null ? Number(ctx.liveEdge) : (d && d.minRoi != null ? Number(d.minRoi) : null);
  const live = priceAt(fair, ctx, liveEdge);
  const comp = bestCompeting(ctx.rfq);
  const fill = knownFill(ctx.rfq);
  const rfq = ctx.rfq || {};
  const seenMs = Number.isFinite(Number(ctx.nowMs)) ? Number(ctx.nowMs) : Date.now();
  return {
    seen_at: new Date(seenMs).toISOString(),
    rfq_id: String(rfq.rfqId || (d && d.rfqId) || ''),
    venue: ctx.venue === 'polymarket' ? 'polymarket' : 'kalshi',
    market_ticker: rfq.marketTicker || rfq.market_ticker || rfq.symbol || null,
    legs: legRows(legs),
    fair_yes: fair,
    fair_american: americanFromProb(fair),
    min_edge_shadow: shadowEdge,
    min_edge_live: liveEdge > 0 && liveEdge < 1 ? liveEdge : null,
    quote_yes_shadow: shadow.q,
    quote_american_shadow: americanFromProb(shadow.q),
    quote_yes_live: live ? live.q : null,
    quote_american_live: live ? americanFromProb(live.q) : null,
    contracts: shadow.n,
    contracts_live: live ? live.n : null,
    fee_shadow: shadow.fee,
    fee_live: live ? live.fee : null,
    best_competing_yes: comp.yes,
    best_competing_american: comp.american,
    filled: fill.filled,
    trade_yes: fill.tradeYes,
    trade_american: fill.tradeAmerican,
    rfq_age_ms: ctx.rfqAgeMs != null && Number.isFinite(Number(ctx.rfqAgeMs)) ? Math.round(Number(ctx.rfqAgeMs)) : null,
  };
}

// The runner calls this. posted is always false: there is no send from here.
function shadowThenLive(ctx, logger) {
  const row = considerShadow(ctx);
  if (row && row.rfq_id && logger && typeof logger.push === 'function') logger.push(row);
  return { row, posted: false };
}

function createShadowLogger({
  supabase, log = console.log, label = 'SNIPER', batchMs = 1000, maxBatch = 200, maxBuffer = 2000,
  table = 'sniper_shadow_quotes',
} = {}) {
  let buf = [];
  let disabled = false;
  let warned = false;
  let dropWarned = 0;
  let inflight = null;
  const stats = { pushed: 0, written: 0, dropped: 0, failed: 0 };
  function push(row) {
    if (!row || disabled) return;
    stats.pushed += 1;
    buf.push(row);
    if (buf.length > maxBuffer) {
      const n = buf.length - maxBuffer;
      buf.splice(0, n);
      stats.dropped += n;
      const now = Date.now();
      if (now - dropWarned > 60000) {
        dropWarned = now;
        log(`[${label}] shadow buffer full, dropped ${stats.dropped} row(s)`);
      }
    }
    if (buf.length >= maxBatch) setImmediate(() => { flush().catch(() => {}); });
  }
  function flush() {
    if (inflight) return inflight.then(() => (buf.length && !disabled ? flush() : undefined));
    inflight = drain().finally(() => { inflight = null; });
    return inflight;
  }
  async function drain() {
    if (disabled || !supabase) { buf = []; return; }
    while (buf.length && !disabled) {
      const rows = buf.splice(0, maxBatch);
      try {
        // No .select() after upsert: the client then asks PostgREST not to send the rows back.
        const { error } = await supabase.from(table).upsert(rows, {
          onConflict: 'venue,rfq_id', ignoreDuplicates: true, returning: 'minimal',
        });
        if (error) {
          stats.failed += rows.length;
          const msg = error.message || String(error);
          if (/does not exist|schema cache|sniper_shadow_quotes/i.test(msg)) {
            disabled = true;
            buf = [];
            if (!warned) {
              warned = true;
              log(`[${label}] shadow logging off: public.${table} is missing. Apply migrations/20261114_sniper_shadow_quotes.sql. This process does not apply it.`);
            }
            return;
          }
          if (!warned) { warned = true; log(`[${label}] shadow insert failed: ${msg}`); }
          return;
        }
        stats.written += rows.length;
      } catch (e) {
        stats.failed += rows.length;
        if (!warned) { warned = true; log(`[${label}] shadow insert threw: ${e.message}`); }
        return;
      }
    }
  }
  const t = setInterval(() => { flush().catch(() => {}); }, batchMs);
  if (t.unref) t.unref();
  return {
    push, flush, stats, stop: () => clearInterval(t),
  };
}

module.exports = {
  shadowMinEdge, considerShadow, shadowThenLive, createShadowLogger, bestCompeting, BLOCK_REASONS,
};
