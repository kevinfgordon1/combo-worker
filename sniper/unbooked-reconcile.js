'use strict';
// Confirmed-but-unbooked reconcile (Oct 30 2026; Polymarket equivalent: combo-worker #310).
//
// A sniper quote we CONFIRMED sits in sniper_ledger as phase 'accepted' until its quote_executed event
// books the fills (sniper/live.js onExecuted). If the fills were not visible when the event came, or the
// event never came, the row stayed 'accepted' forever at full risk (Oct 29: 3 rows, $139.95 of cap).
// The old 60-minute stale-accepted sweep released such rows WITHOUT asking Kalshi, which would silently
// drop a real position if Kalshi had in fact filled it.
//
// Every cycle (SNIPER_UNBOOKED_RECONCILE_MS, default 5 min) this checks up to maxPerCycle (15) open
// 'accepted' live rows with nothing filled and older than minAgeMs (10 min), oldest first, read-only:
//   1. GET /communications/quotes/{quote_id}   -> status, executed_ts, creator_order_id
//   2. GET /portfolio/fills?order_id=…           (order id from the ledger row, else from the quote)
// and then
//   * fills found                         -> BOOK them (phase 'filled', same fields as onExecuted) + alert
//   * quote executed, no fill after noFillGraceMs (30 min) -> release ('declined'): Kalshi executed the
//     quote but the taker side produced no fill, so we hold nothing
//   * quote cancelled / expired / deleted / 404 and no fill -> release ('declined')
//   * anything else (open, read error, executed < grace)  -> leave it; next cycle tries again
// Only reads Kalshi. Every outcome is logged and written to sniper_decisions (action unbooked_reconcile).

const TERMINAL = /^(cancel|expired|deleted|rejected|void)/i;

function quoteOrderId(q) {
  if (!q) return null;
  return q.creator_order_id || q.order_id || q.creatorOrderId || null;
}
function executedAtMs(q) {
  if (!q) return null;
  for (const k of ['executed_ts', 'executed_time', 'last_updated_ts', 'updated_ts']) {
    const t = Date.parse(q[k] || ''); if (Number.isFinite(t)) return t;
  }
  return null;
}

function createUnbookedReconcile({
  supabase, trader, store, liveSniper = null, log = console.log, alert = () => {}, decision = () => {},
  now = () => Date.now(), minAgeMs = 10 * 60000, noFillGraceMs = 30 * 60000, maxPerCycle = 15,
} = {}) {
  if (!supabase || !trader || !store) throw new Error('unbooked reconcile needs supabase, trader, store');
  const stats = { cycles: 0, checked: 0, booked: 0, released: 0, left: 0, errors: 0 };
  let running = false;

  async function candidates() {
    const cut = new Date(now() - minAgeMs).toISOString();
    const { data, error } = await supabase.from('sniper_ledger')
      .select('rfq_id,quote_id,order_id,market_ticker,legs,risk,contracts,created_at,updated_at')
      .eq('status', 'open').eq('phase', 'accepted').eq('dry_run', false)
      .or('filled_contracts.is.null,filled_contracts.eq.0').lt('updated_at', cut)
      .order('created_at', { ascending: true }).limit(Math.max(1, maxPerCycle));
    if (error) throw new Error(`unbooked candidates: ${error.message}`);
    return data || [];
  }

  function note(r, outcome, details = {}) {
    try { decision({ rfq_id: r.rfq_id, action: 'unbooked_reconcile', reason: outcome, details: { quote_id: r.quote_id, order_id: r.order_id, risk: Number(r.risk) || 0, ...details } }); } catch (_) { /* audit only */ }
  }

  async function one(r) {
    stats.checked += 1;
    let q = null; let quoteErr = null;
    if (r.quote_id && typeof trader.getQuote === 'function') {
      try { q = await trader.getQuote(r.quote_id); } catch (e) { quoteErr = e; }
    }
    const orderId = r.order_id || quoteOrderId(q);
    if (orderId) {
      let book;
      try { book = await trader.fillsForOrder(orderId); } catch (e) { stats.errors += 1; stats.left += 1; log(`[SNIPER] unbooked reconcile rfq=${r.rfq_id}: fills read failed (${e.message}); left as is`); return 'left_read_error'; }
      if (book && book.reason === 'confirmed' && book.contracts > 0) {
        const cost = book.book.reduce((s, x) => s + x.count * (Number(x.no_price) || 0), 0);
        const fee = book.book.reduce((s, x) => s + (Number(x.fee) || 0), 0);
        await store.update(r.rfq_id, {
          phase: 'filled', order_id: orderId, filled_contracts: book.contracts,
          filled_cost: Math.round(cost * 1e4) / 1e4, filled_fee: Math.round(fee * 1e4) / 1e4,
          fill_ids: book.book.map((x) => x.fill_id), market_ticker: r.market_ticker || (book.book[0] && book.book[0].ticker) || null,
        });
        if (liveSniper && typeof liveSniper.forgetRfq === 'function') liveSniper.forgetRfq(r.rfq_id);
        stats.booked += 1;
        log(`[SNIPER] unbooked reconcile BOOKED rfq=${r.rfq_id} order=${orderId} contracts=${book.contracts} cost=$${cost.toFixed(2)} fee=$${fee.toFixed(2)}`);
        alert(`🎯 SNIPER (not Combo Locks) ✅ Late fill booked: a confirmed ${Array.isArray(r.legs) ? r.legs.length : '?'}-leg parlay quote had filled on Kalshi but wasn't recorded. Now booked: ${book.contracts} contracts, $${(cost + fee).toFixed(2)} risk.`);
        note(r, 'booked', { order_id: orderId, contracts: book.contracts, cost, fee });
        return 'booked';
      }
    }
    if (quoteErr) { stats.errors += 1; stats.left += 1; log(`[SNIPER] unbooked reconcile rfq=${r.rfq_id}: quote read failed (${quoteErr.message}); left as is`); return 'left_read_error'; }
    const status = q ? String(q.status || '').toLowerCase() : 'not_found';
    let release = null;
    if (!q) release = 'quote_not_found_no_fill';
    else if (status === 'executed') {
      const at = executedAtMs(q);
      if (at != null && now() - at >= noFillGraceMs) release = 'executed_no_fill';
    } else if (TERMINAL.test(status)) release = `not_executed_${status}`;
    if (!release) { stats.left += 1; return `left_${status || 'unknown'}`; }
    await store.release(r.rfq_id, 'declined', {});
    if (liveSniper && typeof liveSniper.forgetRfq === 'function') liveSniper.forgetRfq(r.rfq_id);
    stats.released += 1;
    log(`[SNIPER] unbooked reconcile RELEASED rfq=${r.rfq_id} quote=${r.quote_id} order=${orderId || '-'} reason=${release} risk=$${(Number(r.risk) || 0).toFixed(2)} (Kalshi shows no fill)`);
    note(r, release, { order_id: orderId || null, quote_status: status });
    return release;
  }

  async function tick() {
    if (running) return { skipped: true };
    running = true; stats.cycles += 1;
    const out = [];
    try {
      const rows = await candidates();
      for (const r of rows) {
        try { out.push([r.rfq_id, await one(r)]); } catch (e) { stats.errors += 1; log(`[SNIPER] unbooked reconcile rfq=${r.rfq_id} error: ${e.message}`); }
      }
    } finally { running = false; }
    return { results: out };
  }
  return { tick, stats: () => ({ ...stats }), _one: one };
}

module.exports = { createUnbookedReconcile, quoteOrderId, executedAtMs };
