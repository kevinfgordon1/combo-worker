// Polymarket "who beat us" tape — what price won a Polymarket RFQ we quoted but did not fill.
//
// Polymarket never says who won (RFQ trade prints carry no participant, account, order, RFQ or
// quote id). It does publish every RFQ-originated fill as an anonymous print to every RFQ
// subscriber: rfqEvent.rfqTrade { tradeId, symbol, price, qtyDecimal, aggressorSide, executedTime }.
// poly-worker already receives those on its existing RFQ websocket subscription, so this tape
// adds NO key, NO request and NO work on the quote path: every hook is called from setImmediate
// by polymarket-rfq.js and only touches in-memory maps; rows are written in the background.
//
// For each RFQ we QUOTED that closes without filling us we write ONE row (poly_lost_quotes):
//   lost_to_print — size-consistent print(s) on the same combo symbol inside the RFQ window
//                   (same rules as the noboost tracker: [created − 1s, close + 5s], qty ≤ RFQ
//                   contracts +2% or notional ≤ cash +2%; prints within 3s of the first are one order)
//   no_print      — no print in the window: the requester took no one.
// ambiguous = other RFQs for the same combo symbol were open in an overlapping window (a print
// could belong to any of them), or more than one separate fill time matched, or the RFQ had no size.
// RFQs we filled (our quote executed) write nothing. POLY_LOSS_TAPE=0 turns the tape off.
'use strict';
const { normalizePolyRfq, normalizePolyTrade, MATCH_DEFAULTS, printWindowEnd, printInWindow, printSizeOk } = require('./noboost/poly-rfq');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const americanOf = (p) => (p > 0 && p < 1 ? Math.round(p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p) : null);

function lossTapeEnabled(env = process.env) {
  return String(env.POLY_LOSS_TAPE == null ? '1' : env.POLY_LOSS_TAPE).trim() !== '0';
}

function createPolyLossTape({
  persistRow = () => {}, now = () => Date.now(), finalizeLagMs = 30000, maxTracked = 200000,
  match = MATCH_DEFAULTS, log = () => {},
} = {}) {
  const rfqs = new Map(); // rfqId -> { id, symbol, createdMs, closeMs, contracts, cash }
  const bySymbol = new Map(); // symbol -> Set(rfqId) (every RFQ seen, for the ambiguity count)
  const quoted = new Map(); // rfqId -> our quote { quoteId, parlayId, label, buyPrice, contracts, quotedMs }
  const ours = new Set(); // rfqIds where our quote executed (we were filled / chosen)
  const prints = new Map(); // symbol -> [{ id, yes, count, ms, takerSide }]
  const seenPrints = new Set();
  const stats = { rfqs: 0, quoted: 0, prints: 0, lost_to_print: 0, no_print: 0, ours: 0, dropped: 0 };

  function remember(r) {
    if (!r || !r.rfqId) return null;
    let rec = rfqs.get(r.rfqId);
    if (!rec) {
      if (rfqs.size >= maxTracked) { stats.dropped += 1; return null; }
      rec = { id: r.rfqId, symbol: r.symbol || null, createdMs: r.createdMs || now(), closeMs: null, contracts: r.contracts || 0, cash: r.targetCostDollars || 0 };
      rfqs.set(rec.id, rec); stats.rfqs += 1;
      if (rec.symbol) { if (!bySymbol.has(rec.symbol)) bySymbol.set(rec.symbol, new Set()); bySymbol.get(rec.symbol).add(rec.id); }
    } else {
      if (!rec.symbol && r.symbol) { rec.symbol = r.symbol; if (!bySymbol.has(rec.symbol)) bySymbol.set(rec.symbol, new Set()); bySymbol.get(rec.symbol).add(rec.id); }
      if (!rec.contracts && r.contracts) rec.contracts = r.contracts;
      if (!rec.cash && r.targetCostDollars) rec.cash = r.targetCostDollars;
    }
    return rec;
  }

  // Every RFQ poly-worker sees (WS or crawl).
  function noteRfq(raw) { return remember(normalizePolyRfq(raw, now())); }
  // We posted a quote on this RFQ.
  function onQuoted(raw, q = {}) {
    const rec = remember(normalizePolyRfq(raw, now()));
    if (!rec) return null;
    if (!quoted.has(rec.id)) stats.quoted += 1;
    quoted.set(rec.id, {
      quoteId: q.quoteId || null, parlayId: q.parlayId || null, label: q.label || null,
      buyPrice: num(q.buyPrice), contracts: num(q.contracts), quotedMs: now(),
    });
    return rec;
  }
  function onClosed(raw) {
    const r = normalizePolyRfq(raw, now());
    const rec = r && rfqs.get(r.rfqId);
    if (rec && rec.closeMs == null) rec.closeMs = now();
    return rec || null;
  }
  // Our quote on this RFQ was accepted/executed: we won the auction, so no loss row.
  function onOurs({ quoteId, rfqId } = {}) {
    let id = rfqId ? String(rfqId) : null;
    if (!id && quoteId) for (const [rid, q] of quoted) if (q.quoteId === quoteId) { id = rid; break; }
    if (id && !ours.has(id)) { ours.add(id); stats.ours += 1; }
    return id;
  }
  function onTrade(rawTrade) {
    const t = normalizePolyTrade(rawTrade && rawTrade.trade ? rawTrade.trade : rawTrade);
    if (!t || seenPrints.has(t.id)) return null;
    seenPrints.add(t.id); stats.prints += 1;
    if (!bySymbol.has(t.symbol)) return null; // nobody we track asked for this combo
    if (!prints.has(t.symbol)) prints.set(t.symbol, []);
    prints.get(t.symbol).push(t);
    return t;
  }

  const windowEnd = (rec) => printWindowEnd(rec.createdMs, rec.closeMs, match);

  // -> the row we would write for a quoted RFQ (pure; used by sweep and tests)
  function evaluate(rec, q) {
    const list = (prints.get(rec.symbol) || []).filter((t) => printInWindow(rec.createdMs, rec.closeMs, t.ms, match));
    const fits = list.map((t) => ({ t, s: printSizeOk(rec.contracts, rec.cash, t.count, t.yes, match.sizeSlack) })).filter((x) => x.s.ok)
      .sort((a, b) => a.t.ms - b.t.ms);
    const others = [...(bySymbol.get(rec.symbol) || [])].filter((id) => {
      if (id === rec.id) return false;
      const o = rfqs.get(id); return !!o && o.createdMs <= windowEnd(rec) && rec.createdMs <= windowEnd(o);
    }).length;
    const base = {
      rfq_id: rec.id, venue: 'polymarket', symbol: rec.symbol,
      quote_id: q.quoteId, parlay_id: q.parlayId, label: q.label,
      rfq_created_at: new Date(rec.createdMs).toISOString(), rfq_closed_at: rec.closeMs != null ? new Date(rec.closeMs).toISOString() : null,
      close_seen: rec.closeMs != null,
      rfq_contracts: rec.contracts > 0 ? rec.contracts : null, rfq_cash: rec.cash > 0 ? rec.cash : null,
      our_buy_price: q.buyPrice, our_american: americanOf(q.buyPrice), our_contracts: q.contracts,
      other_open_requests: others, prints_in_window: list.length,
    };
    if (!fits.length) {
      return { ...base, outcome: 'no_print', won_price: null, won_american: null, won_contracts: null, won_side: null, won_at: null, gap: null, gap_cents: null, trade_ids: null, fill_groups: 0, ambiguous: others > 0, size_mismatch_prints: list.length };
    }
    // one submitted order can produce several prints: group prints within multiFillMs of the first
    const first = fits[0].t;
    const group = fits.filter((x) => x.t.ms - first.ms <= match.multiFillMs);
    const groups = 1 + new Set(fits.filter((x) => x.t.ms - first.ms > match.multiFillMs).map((x) => Math.floor((x.t.ms - first.ms) / match.multiFillMs))).size;
    const won = first.yes;
    const contracts = +group.reduce((a, x) => a + x.t.count, 0).toFixed(4);
    const gap = q.buyPrice != null ? +(q.buyPrice - won).toFixed(6) : null; // > 0: our price was higher (worse for the buyer)
    return {
      ...base, outcome: 'lost_to_print', won_price: won, won_american: americanOf(won), won_contracts: contracts,
      won_side: first.takerSide, won_at: new Date(first.ms).toISOString(), gap, gap_cents: gap == null ? null : +(gap * 100).toFixed(4),
      trade_ids: group.map((x) => x.t.id), fill_groups: groups,
      ambiguous: others > 0 || groups > 1 || !!fits[0].s.unknown, size_mismatch_prints: list.length - fits.length,
    };
  }

  function sweep() {
    const t = now();
    let wrote = 0;
    for (const [id, rec] of rfqs) {
      if (t <= windowEnd(rec) + finalizeLagMs) continue;
      const q = quoted.get(id);
      if (q && !ours.has(id)) {
        const row = evaluate(rec, q);
        stats[row.outcome] = (stats[row.outcome] || 0) + 1;
        try { persistRow(row); wrote += 1; } catch (e) { log(`[POLY-LOSS] persist: ${e.message}`); }
      }
      rfqs.delete(id); quoted.delete(id); ours.delete(id);
      const s = rec.symbol && bySymbol.get(rec.symbol);
      if (s) { s.delete(id); if (!s.size) { bySymbol.delete(rec.symbol); prints.delete(rec.symbol); } }
    }
    // prints no tracked RFQ can still claim
    let oldest = Infinity; for (const rec of rfqs.values()) oldest = Math.min(oldest, rec.createdMs);
    for (const [sym, list] of prints) { const keep = list.filter((x) => x.ms >= oldest - 2000); if (keep.length) prints.set(sym, keep); else prints.delete(sym); }
    if (seenPrints.size > 200000) seenPrints.clear();
    return wrote;
  }

  return { noteRfq, onQuoted, onClosed, onOurs, onTrade, sweep, evaluate, stats: () => ({ ...stats, tracked: rfqs.size, quotedOpen: quoted.size }), _rfqs: rfqs, _quoted: quoted };
}

// Batched background writer for poly_lost_quotes (one row per lost request; failures logged once).
function createLossRowWriter({ supabase, log = console.log, batchMs = 5000, maxBatch = 500, maxBuffer = 20000 } = {}) {
  let buf = []; let busy = false; let warned = false;
  const stats = { written: 0, failed: 0, dropped: 0 };
  async function flush() {
    if (busy || !buf.length || !supabase) return;
    busy = true;
    try {
      while (buf.length) {
        const rows = buf.splice(0, maxBatch);
        const { error } = await supabase.from('poly_lost_quotes').upsert(rows, { onConflict: 'rfq_id', ignoreDuplicates: true });
        if (error) { stats.failed += rows.length; if (!warned) { warned = true; log(`[POLY-LOSS] poly_lost_quotes write failed (table missing?): ${error.message}`); } break; }
        stats.written += rows.length;
      }
    } catch (e) { if (!warned) { warned = true; log(`[POLY-LOSS] write threw: ${e.message}`); } } finally { busy = false; }
  }
  const t = setInterval(() => { flush(); }, batchMs); if (t.unref) t.unref();
  return {
    push(row) { buf.push(row); if (buf.length > maxBuffer) { const n = buf.length - maxBuffer; buf.splice(0, n); stats.dropped += n; } },
    flush, stats: () => ({ ...stats, buffered: buf.length }),
  };
}

module.exports = { createPolyLossTape, createLossRowWriter, lossTapeEnabled };
