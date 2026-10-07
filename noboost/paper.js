// Paper run bookkeeping for the no-boost quoter — PURE state machine, no I/O.
// Three shadow quoters share ONE in-memory book:
//   primary  = env config (service: margin 10% over fairMethod=mid, lock guardrail OFF)
//   lockcf   = same config but lock guardrail ON (the counterfactual)
//   promo    = Promo-Builder-style trusted-book consensus fair (optional; NOBOOST_PROMO=1)
// For every in-scope RFQ we keep a record; when the combo market prints a taker
// trade we decide whether each variant's quote would have won (strictly cheaper
// than the print, not pulled before it) and simulate the paper position against
// the caps. Persistence is injected (persist(row)).
//
// Trade -> RFQ matching (the public trade feed carries NO rfq/quote id):
//   • window: a trade can only match an RFQ when  seen_ms < trade_ms <= seen_ms + ttl + grace
//     (we cannot have quoted before we saw the RFQ; our quote is dead after its lifetime).
//   • a FILL is credited only when trade_ms <= our quote's expiry (registered + ttl) and the
//     quote was not pulled/evicted before the trade.
//   • size: the print must be consistent with the RFQ size (contracts ±2%, or a dollar RFQ's
//     notional count·price within [-15%, +2%] of target cost — the taker fee comes out of it).
//     Size-inconsistent prints never match (a 93k-contract print is not a 50-contract RFQ).
//   • one trade -> at most one RFQ; if several in-window, size-consistent RFQs on the same combo
//     are candidates we take the most recently seen and flag the row match_ambiguous.
//   • prints at the exchange minimum ($0.001) are ignored.
//   • a pending RFQ is finalized as no_trade once  now > seen + ttl + grace + tradeLagMs  (the lag
//     only covers trade-feed polling delay; it never widens the match window) and dropped from memory.
'use strict';
const { winsPrint, fmtAm, americanFromProb } = require('./quote');
const { classifyNfl } = require('./shadow');
const { createTtlSet } = require('./ttl-set');

const HIST_EDGES = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 60000];
function emptyHist() { return new Array(HIST_EDGES.length + 1).fill(0); }
function histAdd(h, v) {
  let i = 0;
  while (i < HIST_EDGES.length && v > HIST_EDGES[i]) i += 1;
  h[i] += 1;
}
function legBucket(n) { return n <= 3 ? '2-3' : n <= 6 ? '4-6' : n <= 8 ? '7-8' : n <= 10 ? '9-10' : '11+'; }
function emptyDelta() {
  return {
    seen: 0, out_of_scope: 0, skips: {}, by_legs: {}, dec_ms: emptyHist(), leg_age_ms: emptyHist(), detect_lag_ms: emptyHist(),
    trades: {}, // trades_seen, matched, no_candidate, size_mismatch, min_price_print, ambiguous, dup_rfq
  };
}

// Is a print of `count` contracts at `yes` consistent with this RFQ's requested size?
//   -> 'ok' | 'mismatch' | 'unknown' (RFQ carried neither contracts nor target cost)
function sizeCheck(rec, count, yes, tol = {}) {
  const cTol = tol.contracts != null ? tol.contracts : 0.02;
  const lo = tol.costLo != null ? tol.costLo : 0.15;
  const hi = tol.costHi != null ? tol.costHi : 0.02;
  const c = Number(rec.rfq_contracts) || 0;
  const tc = Number(rec.rfq_target_cost) || 0;
  if (!(count > 0)) return { verdict: 'mismatch', ratio: null };
  if (c > 0) {
    const ratio = count / c;
    return { verdict: Math.abs(count - c) <= Math.max(0.01, c * cTol) ? 'ok' : 'mismatch', ratio };
  }
  if (tc > 0 && yes > 0) {
    const notional = count * yes;
    const ratio = notional / tc;
    return { verdict: notional >= tc * (1 - lo) - 0.02 && notional <= tc * (1 + hi) + 0.01 ? 'ok' : 'mismatch', ratio };
  }
  return { verdict: 'unknown', ratio: null };
}
function bump(o, k, d = 1) { o[k] = (o[k] || 0) + d; }
function hash100(s) { let h = 0; for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 100; }

function createPaperRun({
  book, primary, lockcf, promo = null, now = () => Date.now(), persist = () => {}, persistStats = () => {},
  samplePct = 2, margin = null, runId = null,
  quoteTtlMs = null, graceMs = 2000, tradeLagMs = 15000, minPrintYes = 0.001, sizeTol = {},
} = {}) {
  const byTicker = new Map(); // market_ticker -> [rec]
  const byId = new Map();
  const openFills = []; // recs with a simulated fill awaiting settlement
  const ttlMs = quoteTtlMs != null ? quoteTtlMs : ((primary && primary.risk && primary.risk.cfg && primary.risk.cfg.ttlMs) || 20000);
  const seenTrades = createTtlSet({ ttlMs: 10 * 60 * 1000, now });
  let delta = emptyDelta();
  const variants = promo ? { primary, lockcf, promo } : { primary, lockcf };
  const col = (name) => (name === 'lockcf' ? 'lock' : name);

  function lb(rec) { return delta.by_legs[legBucket(rec.n_legs)] || (delta.by_legs[legBucket(rec.n_legs)] = {}); }

  function decisionOf(d, name) {
    if (!d) return { action: 'none' };
    const pr = d.priced;
    return {
      action: d.action, reason: d.reason || null,
      quoteYes: d.action === 'would_quote' && pr ? pr.quoteYes : null,
      quote_american: pr && pr.ok ? Math.round(pr.quote_american) : null,
      binding: pr ? !!pr.binding : null,
      pulled: null,
      contracts: d.contracts || null,
      decision_ms: d.decisionMs,
      pr,
    };
  }

  // rfq: { rfqId, marketTicker, legKeys, contracts, targetCostDollars, createdMs }
  function onRfq(rfq) {
    if (rfq && byId.has(rfq.rfqId)) { bump(delta.trades, 'dup_rfq'); return null; } // never reprocess (would orphan the first record)
    const seenAt = now();
    delta.seen += 1;
    const d1 = primary.onRfq(rfq, { venue: 'kalshi' });
    if (d1.action === 'skip' && /^(flag_off|not_|correlated|no_game|team_parse|poly_team)/.test(d1.reason || '')) {
      delta.out_of_scope += 1;
      return null;
    }
    const d2 = lockcf.onRfq(rfq, { venue: 'kalshi' });
    const d3 = promo ? promo.onRfq(rfq, { venue: 'kalshi' }) : null;
    const P = decisionOf(d1); const L = decisionOf(d2); const M = d3 ? decisionOf(d3) : null;
    const pp = d3 && d3.priced && d3.priced.ok ? d3.priced : null;
    const pr = (d1.priced && d1.priced.ok) ? d1.priced : (d2.priced && d2.priced.ok ? d2.priced : null);
    const cls = classifyNfl(rfq, 'kalshi');
    const rec = {
      run_id: runId,
      rfq_id: rfq.rfqId, market_ticker: rfq.marketTicker || null, legs: rfq.legKeys, n_legs: rfq.legKeys.length,
      rfq_created_ms: rfq.createdMs || null, seen_ms: seenAt,
      quote_expires_ms: seenAt + ttlMs, window_end_ms: seenAt + ttlMs + graceMs,
      rfq_contracts: Number(rfq.contracts) > 0 ? Number(rfq.contracts) : null,
      rfq_target_cost: Number(rfq.targetCostDollars) > 0 ? Number(rfq.targetCostDollars) : null,
      detect_lag_ms: rfq.createdMs ? Math.max(0, seenAt - rfq.createdMs) : null,
      contracts: d1.contracts || d2.contracts || rfq.contracts || null,
      margin,
      primary: P, lockcf: L, ...(M ? { promo: M } : {}),
      fair_promo_american: pp && pp.fair_promo_american != null ? Math.round(pp.fair_promo_american) : null,
      fair_promo_best_american: pp && pp.fair_promo_best_american != null ? Math.round(pp.fair_promo_best_american) : null,
      fairPromo: pp ? pp.fairPromo : null,
      promo_n_books: pp ? pp.promoBooks : null,
      promo_max_age_ms: pp ? Math.round(pp.promoAgeMs || 0) : null,
      fair_mid_american: pr && pr.fair_mid_american != null ? Math.round(pr.fair_mid_american) : null,
      fair_inverse_american: pr && pr.fair_inverse_american != null ? Math.round(pr.fair_inverse_american) : null,
      fair_ref_american: pr && pr.ref_american != null ? Math.round(pr.ref_american) : null,
      lock_american: pr && pr.lock_american != null ? Math.round(pr.lock_american) : null,
      fairMid: pr ? pr.fairMid : null,
      decision_ms: d1.decisionMs, decision_ms_lockcf: d2.decisionMs,
      max_leg_age_ms: pr ? Math.round(pr.maxLegAgeMs || 0) : null,
      leg_ages_ms: pr ? pr.legAgesMs : null,
      // classified legs for EVERY in-scope RFQ (not only when PRIMARY/LOCKCF quote) so a PROMO-only
      // quote still runs the per-game / per-team caps and its fill books game/team exposure
      cls: cls.ok ? cls.legs : (d1.legs || d2.legs || (d3 && d3.legs) || null),
      outcome: 'pending',
    };
    delta.dec_ms && histAdd(delta.dec_ms, d1.decisionMs);
    if (pr) histAdd(delta.leg_age_ms, pr.maxLegAgeMs || 0);
    if (rec.detect_lag_ms != null) histAdd(delta.detect_lag_ms, rec.detect_lag_ms);
    const b = lb(rec);
    bump(b, 'inscope');
    if (!pr) { bump(b, 'unpriceable'); bump(delta.skips, d1.reason || 'unpriced'); }
    if (P.action === 'would_quote') bump(b, 'primary_wq');
    else if (P.reason && /^risk:/.test(P.reason)) bump(b, 'primary_risk_blocked');
    if (L.action === 'would_quote') bump(b, 'lockcf_wq');
    if (M && M.action === 'would_quote') bump(b, 'promo_wq');
    byId.set(rec.rfq_id, rec);
    if (rec.market_ticker) {
      if (!byTicker.has(rec.market_ticker)) byTicker.set(rec.market_ticker, []);
      byTicker.get(rec.market_ticker).push(rec);
    }
    return rec;
  }

  // Call after shadow.sweep() for each variant to attribute pulls.
  // Pull time = when the quote actually stopped being live (TTL expiry / eviction time), not sweep time.
  function sweep() {
    for (const [name, sh] of Object.entries(variants)) {
      for (const p of sh.sweep()) {
        const rec = byId.get(p.rfqId);
        if (rec && rec[name] && !rec[name].pulled) rec[name].pulled = { reason: p.reason, at: p.at != null ? p.at : now() };
        if (rec) bump(lb(rec), `${name}_pulled`);
      }
    }
  }

  function fillSim(rec, name, tradedYes, tradeMs, tradeContracts) {
    const v = rec[name];
    if (v.action !== 'would_quote') return { beat: 'no_quote' };
    if (!(tradeMs > rec.seen_ms)) return { beat: 'before_seen' };
    if (tradeMs > rec.quote_expires_ms) return { beat: 'expired' };
    if (v.pulled && v.pulled.at <= tradeMs) return { beat: 'pulled' };
    const beat = winsPrint(v.quoteYes, tradedYes);
    if (beat !== 'win') return { beat };
    const sh = variants[name];
    const contracts = v.contracts > 0 ? v.contracts : tradeContracts;
    const legs = rec.cls || [];
    const chk = sh.risk.check(legs, v.quoteYes, contracts);
    const pos = {
      contracts, price: v.quoteYes, premium: +(contracts * v.quoteYes).toFixed(2),
      max_loss: +(contracts * (1 - v.quoteYes)).toFixed(2),
      ev_vs_mid: rec.fairMid ? +(contracts * (v.quoteYes - rec.fairMid)).toFixed(2) : null,
      ev_vs_promo: rec.fairPromo ? +(contracts * (v.quoteYes - rec.fairPromo)).toFixed(2) : null,
      caps_ok: chk.ok, reason: chk.ok ? null : chk.reason,
    };
    if (chk.ok) {
      sh.onPaperFill(rec.rfq_id, legs, v.quoteYes, contracts);
      const snap = sh.risk.snapshot();
      pos.total_after = +snap.totalLoss.toFixed(2);
      pos.top_game_after = snap.topGame[0] ? +snap.topGame[0][1].toFixed(2) : 0;
      pos.top_selection_after = snap.topSelection[0] ? +snap.topSelection[0][1].toFixed(2) : 0;
      pos.util_after = +sh.risk.utilization(legs).toFixed(3);
      pos.leg_kick_ms = legs.map((l) => book.kickoffMs(l.gameId));
    }
    return { beat: 'win', fill: chk.ok, pos };
  }

  // Candidate RFQs for a print: same combo, still pending, print strictly after we saw the RFQ and
  // no later than the quote lifetime + grace. Returns { rec, n, sizeVerdict, ratio } or a reason.
  function matchTrade(tr) {
    const list = byTicker.get(tr.ticker);
    if (!list) return { reason: 'no_candidate' };
    const ok = []; const unknown = []; let mismatch = 0;
    for (const r of list) {
      if (r.outcome !== 'pending') continue;
      if (!(tr.ms > r.seen_ms && tr.ms <= r.window_end_ms)) continue;
      const sc = sizeCheck(r, tr.count, tr.yes, sizeTol);
      if (sc.verdict === 'ok') ok.push([r, sc]); else if (sc.verdict === 'unknown') unknown.push([r, sc]); else mismatch += 1;
    }
    const pool = ok.length ? ok : unknown;
    if (!pool.length) return { reason: mismatch ? 'size_mismatch' : 'no_candidate' };
    let best = pool[0];
    for (const c of pool) if (c[0].seen_ms > best[0].seen_ms) best = c; // most recently seen
    return { rec: best[0], n: pool.length, sizeVerdict: best[1].verdict, ratio: best[1].ratio, mismatch };
  }

  // tr: { id, ticker, yes, count, takerSide, ms }
  function onTrade(tr) {
    if (!tr || !seenTrades.addIfNew(tr.id)) return null;
    bump(delta.trades, 'trades_seen');
    if (!byTicker.has(tr.ticker)) return null; // not a combo we have an RFQ for
    if (!(tr.yes > minPrintYes + 1e-12)) { bump(delta.trades, 'min_price_print'); return null; }
    const m = matchTrade(tr);
    if (!m.rec) { bump(delta.trades, m.reason); return null; }
    const rec = m.rec;
    const b = lb(rec);
    bump(delta.trades, 'matched');
    rec.traded_ms = tr.ms; rec.traded_contracts = tr.count; rec.traded_yes = tr.yes;
    rec.match_candidates = m.n; rec.size_ratio = m.ratio == null ? null : +m.ratio.toFixed(4);
    rec.match_ambiguous = m.n > 1 || m.sizeVerdict === 'unknown';
    rec.match_note = m.sizeVerdict === 'unknown' ? 'size_unknown' : (m.n > 1 ? `${m.n}_candidates_latest_taken` : null);
    if (rec.match_ambiguous) bump(delta.trades, 'ambiguous');
    // the RFQ is done either way: no variant keeps a live quote on it
    for (const name of Object.keys(variants)) variants[name].risk.dropQuote(rec.rfq_id);
    if (tr.takerSide !== 'yes') { rec.outcome = 'taker_no'; bump(b, 'taker_no'); finalize(rec); return rec; }
    rec.outcome = 'traded'; bump(b, 'traded');
    for (const name of Object.keys(variants)) {
      const r = fillSim(rec, name, tr.yes, tr.ms, tr.count);
      rec[name].beat = r.beat;
      if (r.beat === 'win') { bump(b, `${name}_win`); rec[name].fill = !!r.fill; rec[name].position = r.pos; if (r.fill) bump(b, `${name}_fill`); }
      else if (r.beat === 'tie') bump(b, `${name}_tie`);
    }
    if (Object.keys(variants).some((n) => rec[n] && rec[n].fill)) openFills.push(rec);
    finalize(rec);
    return rec;
  }

  function finalize(rec) { rec.final = true; persist(rec, 'upsert'); }

  // Finalize + drop every record whose match window (+ trade-feed lag) is over. Pending ones become
  // no_trade (sampled persist); traded ones were persisted when they matched. Memory stays ~ the
  // RFQs of the last ttl+grace+lag seconds.
  function expire() {
    const t = now();
    for (const [id, rec] of byId) {
      if (t <= rec.window_end_ms + tradeLagMs) continue;
      if (rec.outcome === 'pending') {
        rec.outcome = 'no_trade';
        bump(lb(rec), 'no_trade');
        for (const name of Object.keys(variants)) variants[name].risk.dropQuote(id);
        if (hash100(id) < samplePct) persist(rec, 'upsert');
      }
      byId.delete(id);
      const l = byTicker.get(rec.market_ticker);
      if (l) { const i = l.indexOf(rec); if (i >= 0) l.splice(i, 1); if (!l.length) byTicker.delete(rec.market_ticker); }
    }
  }

  // legResult(ticker) -> 'yes'|'no'|'void'|null  (finalized result of the leg market)
  // Void / push legs are removed from the parlay (standard parlay push rule): the combo hits when
  // every NON-void leg won; if every leg voided it is a push (P&L 0). Rows record void_legs so
  // the assumption is auditable against how Kalshi actually settled the combo.
  async function settle(legResult) {
    let n = 0;
    for (let i = openFills.length - 1; i >= 0; i -= 1) {
      const rec = openFills[i];
      let hit = true; let loser = false; let unknown = false; let voids = 0;
      for (const k of rec.legs) {
        const idx = k.lastIndexOf(':');
        const tk = k.slice(0, idx); const side = k.slice(idx + 1);
        const res = await legResult(tk);
        if (res == null) { unknown = true; continue; }
        if (res === 'void') { voids += 1; continue; }
        if (res !== side) { loser = true; break; }
      }
      if (loser) hit = false; else if (unknown) continue;
      const push = !loser && voids === rec.legs.length;
      if (push) hit = false;
      openFills.splice(i, 1);
      const out = { rfq_id: rec.rfq_id, settled: true, hit, void_legs: voids, ...(push ? { push: true } : {}) };
      for (const name of Object.keys(variants)) {
        if (rec[name] && rec[name].fill) {
          const pnl = variants[name].risk.settle(rec.rfq_id, hit, { push });
          out[`${col(name)}_pnl`] = pnl == null ? null : +pnl.toFixed(2);
        }
      }
      persist(out, 'patch');
      n += 1;
    }
    return n;
  }

  // restore open simulated fills after a restart: rows from the table.
  function restoreFill(name, row, legs) {
    const pos = row[`${col(name)}_position`];
    if (!pos || !pos.caps_ok) return false;
    variants[name].onPaperFill(row.rfq_id, legs, pos.price, pos.contracts);
    return true;
  }

  function flushStats() {
    const d = delta; delta = emptyDelta();
    const pct = (h, p) => {
      const tot = h.reduce((a, b) => a + b, 0); if (!tot) return null;
      let c = 0; for (let i = 0; i < h.length; i += 1) { c += h[i]; if (c >= tot * p) return i < HIST_EDGES.length ? HIST_EDGES[i] : null; }
      return null;
    };
    const payload = {
      ...d, run_id: runId, hist_edges: HIST_EDGES,
      dec_ms_p50: pct(d.dec_ms, 0.5), dec_ms_p99: pct(d.dec_ms, 0.99),
      leg_age_ms_p50: pct(d.leg_age_ms, 0.5), leg_age_ms_p99: pct(d.leg_age_ms, 0.99),
      detect_lag_ms_p50: pct(d.detect_lag_ms, 0.5), detect_lag_ms_p99: pct(d.detect_lag_ms, 0.99),
      positions: Object.fromEntries(Object.entries(variants).map(([n, v]) => [n, v.risk.snapshot()])),
      pending: [...byId.values()].filter((r) => r.outcome === 'pending').length,
      in_memory: byId.size,
      seen_trades: seenTrades.size(),
      open_fills: openFills.length,
    };
    persistStats(payload);
    return payload;
  }

  return { onRfq, onTrade, sweep, expire, settle, restoreFill, flushStats, byId, byTicker, openFills, variants, ttlMs, _delta: () => delta };
}

// DB row from a record (all odds American; *_yes are dollar prices per $1 payout)
function toRow(rec) {
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const P = rec.primary; const L = rec.lockcf; const M = rec.promo || null;
  const american = (y) => (y == null ? null : y);
  return {
    rfq_id: rec.rfq_id,
    run_id: rec.run_id || null,
    rfq_contracts: rec.rfq_contracts == null ? null : rec.rfq_contracts,
    rfq_target_cost: rec.rfq_target_cost == null ? null : rec.rfq_target_cost,
    quote_expires_at: iso(rec.quote_expires_ms),
    match_candidates: rec.match_candidates == null ? null : rec.match_candidates,
    match_ambiguous: rec.match_ambiguous == null ? null : !!rec.match_ambiguous,
    match_note: rec.match_note || null,
    size_ratio: rec.size_ratio == null ? null : rec.size_ratio,
    rfq_created_ts: iso(rec.rfq_created_ms), seen_at: iso(rec.seen_ms), detect_lag_ms: rec.detect_lag_ms,
    market_ticker: rec.market_ticker, n_legs: rec.n_legs, legs: rec.legs, contracts: rec.contracts,
    fair_mid_american: rec.fair_mid_american, fair_inverse_american: rec.fair_inverse_american,
    fair_ref_american: rec.fair_ref_american, lock_american: rec.lock_american,
    quote_primary_american: american(P.quote_american), quote_primary_yes: P.quoteYes, primary_action: P.action,
    primary_reason: P.reason, primary_pulled: P.pulled ? P.pulled.reason : null,
    quote_lock_american: american(L.quote_american), quote_lock_yes: L.quoteYes, lock_action: L.action,
    lock_reason: L.reason, lock_pulled: L.pulled ? L.pulled.reason : null,
    margin: rec.margin, decision_ms: rec.decision_ms == null ? null : +rec.decision_ms.toFixed(3),
    max_leg_age_ms: rec.max_leg_age_ms, leg_ages_ms: rec.leg_ages_ms,
    outcome: rec.outcome, traded_yes: rec.traded_yes == null ? null : rec.traded_yes,
    traded_american: rec.traded_yes > 0 && rec.traded_yes < 1 ? Math.round(americanFromProb(rec.traded_yes)) : null,
    traded_contracts: rec.traded_contracts == null ? null : rec.traded_contracts,
    traded_at: iso(rec.traded_ms),
    primary_beat: P.beat || null, lock_beat: L.beat || null,
    primary_fill: !!P.fill, primary_position: P.position || null,
    lock_fill: !!L.fill, lock_position: L.position || null,
    fair_promo_american: rec.fair_promo_american == null ? null : rec.fair_promo_american,
    fair_promo_best_american: rec.fair_promo_best_american == null ? null : rec.fair_promo_best_american,
    promo_n_books: rec.promo_n_books || null, promo_max_age_ms: rec.promo_max_age_ms == null ? null : rec.promo_max_age_ms,
    ...(M ? {
      quote_promo_american: M.quote_american, quote_promo_yes: M.quoteYes, promo_action: M.action, promo_reason: M.reason,
      promo_pulled: M.pulled ? M.pulled.reason : null, promo_beat: M.beat || null, promo_fill: !!M.fill, promo_position: M.position || null,
    } : {}),
  };
}

module.exports = { createPaperRun, toRow, sizeCheck, HIST_EDGES, legBucket, hash100 };
