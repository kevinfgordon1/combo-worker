// Supabase persistence for the LIVE Polymarket sniper (poly_sniper_ledger, poly_sniper_control).
// Writes are write-behind and never block quoting or confirms: a failed write is retried a few times
// and logged. The in-memory ledger (poly-sniper/live.js) is authoritative while the process runs and
// is rebuilt from poly_sniper_ledger on boot. Reads that gate trading (control switch) fail CLOSED.
'use strict';

const OPEN_PHASES = ['quoted', 'accepted', 'confirmed', 'filled'];

function createPolySniperStore({ supabase, log = console.log, retries = 3, retryMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!supabase) throw new Error('poly-sniper store needs supabase');
  const chains = new Map(); // quote_id -> promise (writes for one quote stay in order)
  const stats = { writes: 0, failed: 0, retried: 0 };
  let warned = 0;
  async function attempt(fn, what) {
    for (let i = 0; i <= retries; i += 1) {
      try {
        const { error } = await fn();
        if (!error) { stats.writes += 1; return true; }
        if (i === retries) throw new Error(error.message);
      } catch (e) {
        if (i === retries) {
          stats.failed += 1;
          if (warned++ < 20 || warned % 100 === 0) log(`[POLY-SNIPER] ledger ${what} failed: ${e.message}`);
          return false;
        }
      }
      stats.retried += 1;
      await sleep(retryMs * (i + 1));
    }
    return false;
  }
  function enqueue(quoteId, fn, what) {
    const prev = chains.get(quoteId) || Promise.resolve();
    const next = prev.then(() => attempt(fn, what)).catch(() => false);
    chains.set(quoteId, next);
    next.finally(() => { if (chains.get(quoteId) === next) chains.delete(quoteId); });
    return next;
  }
  return {
    stats: () => ({ ...stats, pending: chains.size }),
    insertQuote(row) {
      return enqueue(row.quote_id, () => supabase.from('poly_sniper_ledger').upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'quote_id' }), 'insert');
    },
    patch(quoteId, patch) {
      return enqueue(quoteId, () => supabase.from('poly_sniper_ledger').update({ ...patch, updated_at: new Date().toISOString() }).eq('quote_id', quoteId), 'update');
    },
    async flush() { await Promise.all([...chains.values()]); },
    // Throws on error (caller fails closed).
    async readControl() {
      const { data, error } = await supabase.from('poly_sniper_control').select('live,updated_at,updated_by,note').eq('id', 1).limit(1);
      if (error) throw new Error(error.message);
      const r = data && data[0];
      return { live: !!(r && r.live === true), updatedAt: r ? r.updated_at : null, updatedBy: r ? r.updated_by : null };
    },
    async hydrateOpen() {
      const { data, error } = await supabase.from('poly_sniper_ledger')
        .select('quote_id,rfq_id,symbol,combo_key,games,legs,leg_detail,phase,buy_price,fair,contracts,accepted_contracts,filled_contracts,filled_cost,risk,order_id,fill_ids,settle_at,created_at,filled_at')
        .in('phase', OPEN_PHASES).limit(5000);
      if (error) throw new Error(`hydrate: ${error.message}`);
      return data || [];
    },
    // Today's (ET) realized P&L and new filled risk, for the daily loss stop and the daily risk cap.
    async dayTotals(dayStartIso) {
      const out = { realized: 0, filledRisk: 0 };
      const a = await supabase.from('poly_sniper_ledger').select('realized_pnl').gte('settled_at', dayStartIso).limit(5000);
      if (a.error) throw new Error(a.error.message);
      for (const r of a.data || []) out.realized += Number(r.realized_pnl) || 0;
      const b = await supabase.from('poly_sniper_ledger').select('filled_contracts,buy_price').gte('filled_at', dayStartIso).limit(5000);
      if (b.error) throw new Error(b.error.message);
      for (const r of b.data || []) out.filledRisk += (Number(r.filled_contracts) || 0) * (1 - (Number(r.buy_price) || 0));
      return out;
    },
  };
}

module.exports = { createPolySniperStore, OPEN_PHASES };
