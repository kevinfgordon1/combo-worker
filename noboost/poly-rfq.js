// Polymarket US parlay RFQs for Combo Sniper — PAPER ONLY, PURE state machine (no I/O).
// Never quotes: there is no quote/accept/confirm anywhere in this file or its imports.
//
// Every in-scope (NFL moneyline, one leg per game) Polymarket combo RFQ is logged to
// noboost_paper_rfqs with venue='polymarket'. The winning price comes from Polymarket's
// anonymous RFQ trade prints (WS rfqEvent.rfqTrade + GET /v1/rfqs/trades backfill), which
// carry no RFQ / quote id, so we match them:
//   • same caoc symbol, print executedTime within [created − 1s, close + closeGraceMs]
//     (no close seen ⇒ created + maxOpenMs);
//   • size-consistent: print qty ≤ RFQ contracts (+2%), or for a cash RFQ print notional ≤ cost (+2%).
//     One submitted order can produce several fills, so later prints inside the window add to
//     traded_contracts; the FIRST print sets traded_yes / traded_at;
//   • several pending, size-consistent RFQs on the same symbol in-window ⇒ the latest created
//     before the print is taken and the row is flagged match_ambiguous;
//   • trade ids are deduped (WS and REST overlap on purpose);
//   • closed with no print ⇒ outcome 'accepted_not_filled' (or 'no_trade' when the close status
//     says cancelled / expired, or it never closed).
// Printed prices EXCLUDE fees (Polymarket combo taker fee C·p·[0.0695(1−p) + 0.06(1−p)^4] is charged
// on top; combo makers pay $0 and get no rebate).
'use strict';
const { classifyNfl } = require('./shadow');
const { americanFromProb } = require('./quote');
const { createTtlSet } = require('./ttl-set');
const { legFairsWithInverse } = require('./leg-fairs');

const POLY_COMBO_TAKER = 0.0695;
const POLY_COMBO_TAKER_TAIL = 0.06;
/** Polymarket US combo taker fee per contract at combo price p (docs.polymarket.us/fees, Combo Taker Fees). */
function polyComboTakerFee(p) { return p > 0 && p < 1 ? p * (POLY_COMBO_TAKER * (1 - p) + POLY_COMBO_TAKER_TAIL * (1 - p) ** 4) : null; }

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const tsMs = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && v.seconds != null) return Number(v.seconds) * 1000 + Math.floor(Number(v.nanos || 0) / 1e6);
  const ms = Date.parse(String(v)); return Number.isFinite(ms) ? ms : null;
};

/** WS rfqCreated/rfqClosed payload or a GET /v1/rfqs row → plain RFQ. */
function normalizePolyRfq(raw, nowMs) {
  const r = raw && raw.rfq && typeof raw.rfq === 'object' ? raw.rfq : raw;
  if (!r || typeof r !== 'object') return null;
  const id = r.id || r.rfqId || r.rfq_id;
  if (!id) return null;
  return {
    rfqId: String(id),
    symbol: r.symbol || r.ticker || null,
    status: r.status || null,
    comboLegs: r.comboLegs || r.combo_legs || r.legs || null,
    contracts: num(r.qtyDecimal != null ? r.qtyDecimal : r.qty_decimal) || 0,
    targetCostDollars: num(r.cashOrderQty != null ? r.cashOrderQty : r.cash_order_qty) || 0,
    createdMs: tsMs(r.createdTime || r.created_time) || nowMs,
    tickSize: num(r.tickSize != null ? r.tickSize : r.tick_size),
  };
}

/** WS rfqEvent.rfqTrade.trade or a GET /v1/rfqs/trades row → plain trade. */
function normalizePolyTrade(t) {
  if (!t || typeof t !== 'object') return null;
  const id = t.tradeId || t.trade_id; const symbol = t.symbol;
  const price = num(t.price && typeof t.price === 'object' ? t.price.value : t.price);
  const qty = num(t.qtyDecimal != null ? t.qtyDecimal : t.qty_decimal);
  const ms = tsMs(t.executedTime || t.executed_time);
  if (!id || !symbol || price == null || qty == null || ms == null) return null;
  const side = String(t.aggressorSide || t.aggressor_side || '').toUpperCase();
  return { id: String(id), symbol: String(symbol), yes: price, count: qty, ms, takerSide: /BUY/.test(side) ? 'yes' : /SELL/.test(side) ? 'no' : 'unknown' };
}

const legKey = (l) => {
  const sym = String((l && (l.symbol || l.slug)) || l || '').toLowerCase();
  const side = /sell|no|short/i.test(String((l && l.side) || '')) ? 'no' : 'yes';
  return `${sym}:${side}`;
};

// ── Shared print-matching rules (also used by poly-loss-tape.js) ─────────────────────────────
const MATCH_DEFAULTS = Object.freeze({ closeGraceMs: 5000, maxOpenMs: 120000, preCreateMs: 1000, sizeSlack: 0.02, multiFillMs: 3000 });
/** End of an RFQ's print window: close (or created + maxOpenMs when no close was seen) + grace. */
function printWindowEnd(createdMs, closeMs, o = MATCH_DEFAULTS) {
  return (closeMs != null ? closeMs : createdMs + o.maxOpenMs) + o.closeGraceMs;
}
/** Print time inside [created − 1s, windowEnd]. */
function printInWindow(createdMs, closeMs, printMs, o = MATCH_DEFAULTS) {
  return printMs >= createdMs - (o.preCreateMs != null ? o.preCreateMs : 1000) && printMs <= printWindowEnd(createdMs, closeMs, o);
}
/** Size-consistent: qty ≤ RFQ contracts (+2%), or for a cash RFQ notional ≤ cost (+2%). */
function printSizeOk(contracts, targetCost, count, yes, slack = MATCH_DEFAULTS.sizeSlack) {
  if (contracts > 0) return count <= contracts * (1 + slack) + 0.01 ? { ok: true, ratio: count / contracts } : { ok: false };
  if (targetCost > 0) { const n = count * yes; return n <= targetCost * (1 + slack) + 0.01 ? { ok: true, ratio: n / targetCost } : { ok: false }; }
  return { ok: true, ratio: null, unknown: true };
}

function hash100(x) { let h = 0; for (let i = 0; i < x.length; i += 1) h = (h * 31 + x.charCodeAt(i)) >>> 0; return h % 100; }

function createPolyRfqTracker({
  book, priceFairs = () => ({}), persistRow = () => {}, now = () => Date.now(), runId = null,
  samplePct = 2, closeGraceMs = 5000, maxOpenMs = 120000, finalizeLagMs = 200000, multiFillMs = 3000, log = () => {},
} = {}) {
  const byId = new Map();
  const bySymbol = new Map();
  const seenTrades = createTtlSet({ ttlMs: 30 * 60 * 1000, now });
  const seenRfqs = createTtlSet({ ttlMs: 30 * 60 * 1000, now });
  let stats = {};
  const bump = (k, d = 1) => { stats[k] = (stats[k] || 0) + d; };

  function kalshiLegs(cls) {
    if (!book || typeof book.kalshiTickerFor !== 'function') return null;
    const out = [];
    for (const l of cls) { const t = book.kalshiTickerFor(l.gameId, l.team); if (!t) return null; out.push(`${t}:yes`); }
    return out;
  }

  const mo = { ...MATCH_DEFAULTS, closeGraceMs, maxOpenMs };
  function windowEnd(rec) { return printWindowEnd(rec.created_ms, rec.close_ms, mo); }

  // Every row carries the SAME key set (undefined -> null): PostgREST rejects a batch whose keys differ (PGRST102).
  function row(rec) {
    const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
    const out = {
      rfq_id: rec.rfq_id, venue: 'polymarket', run_id: runId,
      rfq_created_ts: iso(rec.created_ms), seen_at: iso(rec.seen_ms), detect_lag_ms: rec.detect_lag_ms,
      rfq_status: rec.close_status || null, rfq_closed_at: iso(rec.close_ms),
      market_ticker: rec.symbol, poly_symbol: rec.symbol, poly_tick_size: rec.tick_size,
      n_legs: rec.legs.length, legs: rec.legs, legs_kalshi: rec.legs_kalshi,
      contracts: rec.rfq_contracts, rfq_contracts: rec.rfq_contracts, rfq_target_cost: rec.rfq_target_cost,
      fair_mid_american: rec.fair_mid_american, fair_inverse_american: rec.fair_inverse_american,
      fair_ref_american: rec.fair_ref_american, lock_american: rec.lock_american,
      fair_promo_american: rec.fair_promo_american, fair_promo_best_american: rec.fair_promo_best_american,
      promo_n_books: rec.promo_n_books, promo_max_age_ms: rec.promo_max_age_ms,
      fair_pm_inverse_american: rec.fair_pm_inverse_american, pm_inverse_reason: rec.pm_inverse_reason, pm_inverse_legs: rec.pm_inverse_legs,
      leg_fairs: legFairsWithInverse(null, rec), // per-leg inverse values (logging only)
      max_leg_age_ms: rec.max_leg_age_ms,
      outcome: rec.outcome, taker_side: rec.taker_side || null,
      traded_yes: rec.traded_yes == null ? null : rec.traded_yes,
      traded_american: rec.traded_yes > 0 && rec.traded_yes < 1 ? Math.round(americanFromProb(rec.traded_yes)) : null,
      traded_contracts: rec.traded_contracts == null ? null : +rec.traded_contracts.toFixed(4),
      traded_at: iso(rec.traded_ms), poly_trade_ids: rec.trade_ids.length ? rec.trade_ids : null,
      match_candidates: rec.match_candidates == null ? null : rec.match_candidates,
      match_ambiguous: rec.match_ambiguous == null ? null : !!rec.match_ambiguous,
      match_note: rec.match_note || null, size_ratio: rec.size_ratio == null ? null : rec.size_ratio,
      primary_action: 'none', lock_action: 'none',
    };
    for (const k of Object.keys(out)) if (out[k] === undefined || (typeof out[k] === 'number' && !Number.isFinite(out[k]))) out[k] = null;
    return out;
  }
  const save = (rec) => persistRow(row(rec));

  // rfq: normalizePolyRfq() output (comboLegs required; hydrate before calling)
  function onRfq(rfq) {
    if (!rfq || !rfq.rfqId || !seenRfqs.addIfNew(rfq.rfqId)) { bump('dup_or_bad'); return null; }
    bump('rfqs');
    if (!Array.isArray(rfq.comboLegs) || !rfq.comboLegs.length) { bump('no_legs'); return null; }
    const cls = classifyNfl({ comboLegs: rfq.comboLegs }, 'polymarket');
    if (!cls.ok) { bump(`oos:${cls.reason}`); return null; }
    bump('inscope');
    const seen = now();
    const rec = {
      rfq_id: rfq.rfqId, symbol: rfq.symbol, created_ms: rfq.createdMs || seen, seen_ms: seen,
      detect_lag_ms: rfq.createdMs ? Math.max(0, seen - rfq.createdMs) : null, tick_size: rfq.tickSize,
      legs: rfq.comboLegs.map(legKey), legs_kalshi: kalshiLegs(cls.legs), cls: cls.legs,
      rfq_contracts: rfq.contracts > 0 ? rfq.contracts : null, rfq_target_cost: rfq.targetCostDollars > 0 ? rfq.targetCostDollars : null,
      close_ms: null, close_status: null, outcome: 'pending', trade_ids: [],
      ...priceFairs(cls.legs),
    };
    byId.set(rec.rfq_id, rec);
    if (rec.symbol) { if (!bySymbol.has(rec.symbol)) bySymbol.set(rec.symbol, []); bySymbol.get(rec.symbol).push(rec); }
    // Storage trim: no row at request time (was ~99% of the 18 GB). Rows are written when a trade
    // matches, on accepted_not_filled, and for a samplePct hash sample of no_trade (same as Kalshi).
    return rec;
  }

  function onClosed(raw) {
    const r = normalizePolyRfq(raw, now());
    const rec = r && byId.get(r.rfqId);
    if (!rec || rec.close_ms != null) return null;
    rec.close_ms = now(); rec.close_status = r.status || 'closed';
    return rec;
  }

  function sizeOk(rec, count, yes) { return printSizeOk(rec.rfq_contracts, rec.rfq_target_cost, count, yes); }

  // tr: normalizePolyTrade() output
  function onTrade(tr) {
    if (!tr || !seenTrades.addIfNew(tr.id)) return null;
    bump('trades_seen');
    const list = bySymbol.get(tr.symbol);
    if (!list) return null;
    bump('trades_on_logged_symbol');
    // extra fill of an order we already matched (one order → several prints)
    const prior = list.find((r) => r.outcome !== 'pending' && r.traded_ms != null && Math.abs(tr.ms - r.traded_ms) <= multiFillMs && tr.ms <= windowEnd(r));
    const cands = []; let mismatch = 0;
    for (const r of list) {
      if (r.outcome !== 'pending') continue;
      if (!printInWindow(r.created_ms, r.close_ms, tr.ms, mo)) continue;
      const s = sizeOk(r, tr.count, tr.yes);
      if (s.ok) cands.push([r, s]); else mismatch += 1;
    }
    if (prior && (!cands.length || prior.traded_ms <= tr.ms)) {
      if (tr.ms < prior.traded_ms) { prior.traded_ms = tr.ms; prior.traded_yes = tr.yes; }
      prior.traded_contracts += tr.count; prior.trade_ids.push(tr.id);
      prior.size_ratio = prior.rfq_contracts ? +(prior.traded_contracts / prior.rfq_contracts).toFixed(4) : prior.size_ratio;
      bump('multi_fill'); save(prior); return prior;
    }
    if (!cands.length) { bump(mismatch ? 'size_mismatch' : 'no_candidate'); return null; }
    let best = null;
    for (const c of cands) if (c[0].created_ms <= tr.ms && (!best || c[0].created_ms > best[0].created_ms)) best = c;
    if (!best) best = cands[0];
    const rec = best[0];
    // identical RFQ (same symbol, overlapping window) already matched or still pending ⇒ ambiguous
    const twins = list.filter((r) => r !== rec && r.created_ms <= windowEnd(rec) && rec.created_ms <= windowEnd(r)).length;
    rec.outcome = tr.takerSide === 'no' ? 'taker_no' : 'traded';
    rec.taker_side = tr.takerSide;
    rec.traded_ms = tr.ms; rec.traded_yes = tr.yes; rec.traded_contracts = tr.count; rec.trade_ids.push(tr.id);
    rec.match_candidates = cands.length; rec.size_ratio = best[1].ratio == null ? null : +best[1].ratio.toFixed(4);
    rec.match_ambiguous = cands.length > 1 || twins > 0 || !!best[1].unknown;
    rec.match_note = best[1].unknown ? 'size_unknown' : cands.length > 1 ? `${cands.length}_candidates_latest_taken` : twins ? 'overlapping_identical_rfq' : null;
    bump('matched'); if (rec.match_ambiguous) bump('ambiguous');
    save(rec);
    return rec;
  }

  function sweep() {
    const t = now();
    for (const [id, rec] of byId) {
      if (t <= windowEnd(rec) + finalizeLagMs) continue;
      if (rec.outcome === 'pending') {
        rec.outcome = rec.close_ms == null || /cancel|expire|delete|reject/i.test(String(rec.close_status || '')) ? 'no_trade' : 'accepted_not_filled';
        bump(rec.outcome);
        if (rec.outcome !== 'no_trade' || hash100(id) < samplePct) save(rec);
      }
      byId.delete(id);
      const l = bySymbol.get(rec.symbol);
      if (l) { const i = l.indexOf(rec); if (i >= 0) l.splice(i, 1); if (!l.length) bySymbol.delete(rec.symbol); }
    }
  }

  function takeStats() { const s = { ...stats, in_memory: byId.size }; stats = {}; return s; }
  return { onRfq, onClosed, onTrade, sweep, takeStats, byId, bySymbol, _row: row };
}

module.exports = {
  createPolyRfqTracker, normalizePolyRfq, normalizePolyTrade, polyComboTakerFee, legKey,
  MATCH_DEFAULTS, printWindowEnd, printInWindow, printSizeOk,
};
