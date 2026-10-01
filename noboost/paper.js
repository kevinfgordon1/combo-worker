// Paper run bookkeeping for the no-boost quoter — PURE state machine, no I/O.
// Two shadow quoters share ONE in-memory book:
//   primary  = env config (service: margin 10% over fairMethod=mid, lock guardrail OFF)
//   lockcf   = same config but lock guardrail ON (the counterfactual)
// For every in-scope RFQ we keep a record; when the combo market prints a taker
// trade after the RFQ we decide whether each variant's quote would have won
// (strictly cheaper than the print, not pulled before it) and simulate the
// paper position against the caps. Persistence is injected (persist(row)).
'use strict';
const { winsPrint, fmtAm, americanFromProb } = require('./quote');

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
  };
}
function bump(o, k, d = 1) { o[k] = (o[k] || 0) + d; }
function hash100(s) { let h = 0; for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 100; }

function createPaperRun({
  book, primary, lockcf, now = () => Date.now(), persist = () => {}, persistStats = () => {},
  samplePct = 2, pendingMs = 10 * 60 * 1000, margin = null,
} = {}) {
  const byTicker = new Map(); // market_ticker -> [rec]
  const byId = new Map();
  const openFills = []; // recs with a simulated fill awaiting settlement
  const seenTrades = new Set();
  let delta = emptyDelta();
  const variants = { primary, lockcf };

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
    const seenAt = now();
    delta.seen += 1;
    const d1 = primary.onRfq(rfq, { venue: 'kalshi' });
    if (d1.action === 'skip' && /^(flag_off|not_|correlated|no_game|team_parse|poly_team)/.test(d1.reason || '')) {
      delta.out_of_scope += 1;
      return null;
    }
    const d2 = lockcf.onRfq(rfq, { venue: 'kalshi' });
    const P = decisionOf(d1); const L = decisionOf(d2);
    const pr = (d1.priced && d1.priced.ok) ? d1.priced : (d2.priced && d2.priced.ok ? d2.priced : null);
    const rec = {
      rfq_id: rfq.rfqId, market_ticker: rfq.marketTicker || null, legs: rfq.legKeys, n_legs: rfq.legKeys.length,
      rfq_created_ms: rfq.createdMs || null, seen_ms: seenAt,
      detect_lag_ms: rfq.createdMs ? Math.max(0, seenAt - rfq.createdMs) : null,
      contracts: d1.contracts || d2.contracts || rfq.contracts || null,
      margin,
      primary: P, lockcf: L,
      fair_mid_american: pr && pr.fair_mid_american != null ? Math.round(pr.fair_mid_american) : null,
      fair_inverse_american: pr && pr.fair_inverse_american != null ? Math.round(pr.fair_inverse_american) : null,
      fair_ref_american: pr && pr.ref_american != null ? Math.round(pr.ref_american) : null,
      lock_american: pr && pr.lock_american != null ? Math.round(pr.lock_american) : null,
      fairMid: pr ? pr.fairMid : null,
      decision_ms: d1.decisionMs, decision_ms_lockcf: d2.decisionMs,
      max_leg_age_ms: pr ? Math.round(pr.maxLegAgeMs || 0) : null,
      leg_ages_ms: pr ? pr.legAgesMs : null,
      cls: d1.legs || d2.legs || null,
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
    byId.set(rec.rfq_id, rec);
    if (rec.market_ticker) {
      if (!byTicker.has(rec.market_ticker)) byTicker.set(rec.market_ticker, []);
      byTicker.get(rec.market_ticker).push(rec);
    }
    return rec;
  }

  // Call after shadow.sweep() for each variant to attribute pulls.
  function sweep() {
    for (const [name, sh] of Object.entries(variants)) {
      for (const p of sh.sweep()) {
        const rec = byId.get(p.rfqId);
        if (rec && rec[name] && !rec[name].pulled) rec[name].pulled = { reason: p.reason, at: now() };
        if (rec) bump(lb(rec), `${name}_pulled`);
      }
    }
  }

  function fillSim(rec, name, tradedYes, tradeMs, tradeContracts) {
    const v = rec[name];
    if (v.action !== 'would_quote') return { beat: 'no_quote' };
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
    sh.risk.dropQuote(rec.rfq_id);
    return { beat: 'win', fill: chk.ok, pos };
  }

  // tr: { id, ticker, yes, count, takerSide, ms }
  function onTrade(tr) {
    if (!tr || seenTrades.has(tr.id)) return null;
    seenTrades.add(tr.id);
    if (seenTrades.size > 300000) seenTrades.clear();
    const list = byTicker.get(tr.ticker);
    if (!list) return null;
    let rec = null;
    for (const r of list) if (r.outcome === 'pending' && (!r.rfq_created_ms || r.rfq_created_ms - 2000 <= tr.ms)) rec = r;
    if (!rec) return null;
    const b = lb(rec);
    rec.traded_ms = tr.ms; rec.traded_contracts = tr.count; rec.traded_yes = tr.yes;
    if (tr.takerSide !== 'yes') { rec.outcome = 'taker_no'; bump(b, 'taker_no'); finalize(rec); return rec; }
    rec.outcome = 'traded'; bump(b, 'traded');
    for (const name of Object.keys(variants)) {
      const r = fillSim(rec, name, tr.yes, tr.ms, tr.count);
      rec[name].beat = r.beat;
      if (r.beat === 'win') { bump(b, `${name}_win`); rec[name].fill = !!r.fill; rec[name].position = r.pos; if (r.fill) bump(b, `${name}_fill`); }
      else if (r.beat === 'tie') bump(b, `${name}_tie`);
    }
    if ((rec.primary.fill) || (rec.lockcf.fill)) openFills.push(rec);
    finalize(rec);
    return rec;
  }

  function finalize(rec) { rec.final = true; persist(rec, 'upsert'); }

  // expire pending recs: drop from memory; persist sampled ones
  function expire() {
    const t = now();
    for (const [id, rec] of byId) {
      const age = t - rec.seen_ms;
      if (rec.outcome === 'pending' && age > pendingMs) {
        rec.outcome = 'no_trade';
        bump(lb(rec), 'no_trade');
        for (const name of Object.keys(variants)) variants[name].risk.dropQuote(id);
        if (hash100(id) < samplePct) persist(rec, 'upsert');
      }
      if (rec.outcome !== 'pending' && age > pendingMs) {
        byId.delete(id);
        const l = byTicker.get(rec.market_ticker);
        if (l) { const i = l.indexOf(rec); if (i >= 0) l.splice(i, 1); if (!l.length) byTicker.delete(rec.market_ticker); }
      }
    }
  }

  // legResult(ticker) -> 'yes'|'no'|null  (finalized result of the leg market)
  async function settle(legResult) {
    let n = 0;
    for (let i = openFills.length - 1; i >= 0; i -= 1) {
      const rec = openFills[i];
      let hit = true; let loser = false; let unknown = false;
      for (const k of rec.legs) {
        const idx = k.lastIndexOf(':');
        const tk = k.slice(0, idx); const side = k.slice(idx + 1);
        const res = await legResult(tk);
        if (res == null) { unknown = true; continue; }
        if (res !== side) { loser = true; break; }
      }
      if (loser) hit = false; else if (unknown) continue;
      openFills.splice(i, 1);
      const out = { rfq_id: rec.rfq_id, settled: true, hit };
      for (const name of Object.keys(variants)) {
        if (rec[name].fill) {
          const pnl = variants[name].risk.settle(rec.rfq_id, hit);
          out[`${name === 'primary' ? 'primary' : 'lock'}_pnl`] = pnl == null ? null : +pnl.toFixed(2);
        }
      }
      persist(out, 'patch');
      n += 1;
    }
    return n;
  }

  // restore open simulated fills after a restart: rows from the table.
  function restoreFill(name, row, legs) {
    const pos = row[`${name === 'primary' ? 'primary' : 'lock'}_position`];
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
      ...d, hist_edges: HIST_EDGES,
      dec_ms_p50: pct(d.dec_ms, 0.5), dec_ms_p99: pct(d.dec_ms, 0.99),
      leg_age_ms_p50: pct(d.leg_age_ms, 0.5), leg_age_ms_p99: pct(d.leg_age_ms, 0.99),
      detect_lag_ms_p50: pct(d.detect_lag_ms, 0.5), detect_lag_ms_p99: pct(d.detect_lag_ms, 0.99),
      positions: { primary: primary.risk.snapshot(), lockcf: lockcf.risk.snapshot() },
      pending: [...byId.values()].filter((r) => r.outcome === 'pending').length,
      open_fills: openFills.length,
    };
    persistStats(payload);
    return payload;
  }

  return { onRfq, onTrade, sweep, expire, settle, restoreFill, flushStats, byId, byTicker, openFills, variants, _delta: () => delta };
}

// DB row from a record (all odds American; *_yes are dollar prices per $1 payout)
function toRow(rec) {
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const P = rec.primary; const L = rec.lockcf;
  const american = (y) => (y == null ? null : y);
  return {
    rfq_id: rec.rfq_id,
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
  };
}

module.exports = { createPaperRun, toRow, HIST_EDGES, legBucket, hash100 };
