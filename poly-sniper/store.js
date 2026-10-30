// Supabase persistence for the LIVE Polymarket sniper (poly_sniper_ledger, poly_sniper_control).
// Writes are write-behind and never block quoting or confirms: a failed write is retried a few times
// and logged. The in-memory ledger (poly-sniper/live.js) is authoritative while the process runs and
// is rebuilt from poly_sniper_ledger on boot. Reads that gate trading (control switch) fail CLOSED.
'use strict';

const OPEN_PHASES = ['quoted', 'accepted', 'confirmed', 'filled'];
const EXPOSURE_PHASES = ['accepted', 'confirmed', 'filled'];

function createPolySniperStore({ supabase, log = console.log, retries = 3, retryMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!supabase) throw new Error('poly-sniper store needs supabase');
  const chains = new Map(); // quote_id -> promise (writes for one quote stay in order)
  const stats = { writes: 0, failed: 0, retried: 0 };
  let warned = 0;
  // quoted_risk needs migrations/20261029c_poly_sniper_quoted_risk.sql. Until it is applied, drop the field
  // (once, then for the life of the process) instead of losing the whole ledger row.
  let quotedRiskColumn = true;
  const missingQuotedRisk = (error) => /quoted_risk/i.test(String((error && (error.message || error.details || error.hint)) || ''));
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
    stats: () => ({ ...stats, pending: chains.size, quotedRiskColumn }),
    insertQuote(row) {
      return enqueue(row.quote_id, async () => {
        const write = (r) => supabase.from('poly_sniper_ledger').upsert({ ...r, updated_at: new Date().toISOString() }, { onConflict: 'quote_id' });
        if (!quotedRiskColumn || !('quoted_risk' in row)) { const { quoted_risk: _q, ...rest } = row; return write(quotedRiskColumn ? row : rest); }
        const res = await write(row);
        if (res && res.error && missingQuotedRisk(res.error)) {
          quotedRiskColumn = false;
          log('[POLY-SNIPER] ledger quoted_risk column missing: writing rows without it (run migrations/20261029c_poly_sniper_quoted_risk.sql)');
          const { quoted_risk: _q, ...rest } = row;
          return write(rest);
        }
        return res;
      }, 'insert');
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
    // Startup load (Oct 30 fix): every EXPOSURE row (accepted / confirmed / filled), ordered and paged so a
    // pile of stale 'quoted' rows can never push a real position past a row limit (was one unordered
    // .limit(5000) over all open phases). 'quoted' rows are loaded only when younger than
    // staleQuotedMs (still possibly resting on the venue -> startup DELETE); older ones are left to
    // expireStaleQuoted. Throws on any page error (caller fails closed: sniper stays off).
    async hydrateOpen({ staleQuotedMs = 15 * 60000, nowMs = Date.now(), pageSize = 1000, maxPages = 200 } = {}) {
      const cols = 'quote_id,rfq_id,symbol,combo_key,games,legs,leg_detail,phase,buy_price,fair,contracts,accepted_contracts,filled_contracts,filled_cost,risk,order_id,fill_ids,settle_at,created_at,filled_at';
      const paged = async (build, what) => {
        const out = [];
        for (let page = 0; page < maxPages; page += 1) {
          const from = page * pageSize;
          const { data, error } = await build().order('created_at', { ascending: true }).order('quote_id', { ascending: true }).range(from, from + pageSize - 1);
          if (error) throw new Error(`hydrate ${what}: ${error.message}`);
          const rows = data || [];
          out.push(...rows);
          if (rows.length < pageSize) return out;
        }
        throw new Error(`hydrate ${what}: more than ${maxPages * pageSize} rows (refusing a partial load)`);
      };
      const exposure = await paged(() => supabase.from('poly_sniper_ledger').select(cols).in('phase', EXPOSURE_PHASES), 'exposure');
      const sinceIso = new Date(nowMs - staleQuotedMs).toISOString();
      const quoted = await paged(() => supabase.from('poly_sniper_ledger').select(cols).eq('phase', 'quoted').gte('created_at', sinceIso), 'quoted');
      return [...exposure, ...quoted];
    },
    // Stale 'quoted' rows (older than staleQuotedMs: past every TTL / cancel retry, so not live in this
    // process) -> phase 'expired'. These are rows a previous process left behind (e.g. quotes inserted
    // during a deploy after the new process had already loaded). Returns the expired rows' ids so the
    // caller can best-effort DELETE them on the venue. Ids in keepIds (live in memory) are never touched.
    async expireStaleQuoted({ staleQuotedMs = 15 * 60000, nowMs = Date.now(), keepIds = new Set(), batch = 500 } = {}) {
      const beforeIso = new Date(nowMs - staleQuotedMs).toISOString();
      const { data, error } = await supabase.from('poly_sniper_ledger').select('quote_id,rfq_id,created_at')
        .eq('phase', 'quoted').lt('created_at', beforeIso).order('created_at', { ascending: true }).limit(batch);
      if (error) throw new Error(`stale quoted read: ${error.message}`);
      const rows = (data || []).filter((r) => r.quote_id && !keepIds.has(r.quote_id));
      if (!rows.length) return [];
      const ids = rows.map((r) => r.quote_id);
      const done = [];
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        // phase guard: a row that moved on (accepted / filled) between the read and this write is left alone.
        const res = await supabase.from('poly_sniper_ledger').update({ phase: 'expired', cancel_reason: 'stale_quoted_sweep', updated_at: new Date(nowMs).toISOString() })
          .in('quote_id', chunk).eq('phase', 'quoted');
        if (res && res.error) throw new Error(`stale quoted expire: ${res.error.message}`);
        done.push(...rows.filter((r) => chunk.includes(r.quote_id)));
      }
      return done;
    },
    // Sniper accepts in the decline window (for the decline-rate pause after a restart). Every accept
    // sets accepted_at; a declined one ends in phase 'declined'. Throws on error (caller stays paused).
    async recentOutcomes(sinceIso, { pageSize = 1000, maxPages = 20 } = {}) {
      const out = [];
      for (let page = 0; page < maxPages; page += 1) {
        const from = page * pageSize;
        const { data, error } = await supabase.from('poly_sniper_ledger').select('quote_id,phase,accepted_at')
          .gte('accepted_at', sinceIso).order('accepted_at', { ascending: true }).range(from, from + pageSize - 1);
        if (error) throw new Error(`decline history: ${error.message}`);
        const rows = data || [];
        out.push(...rows);
        if (rows.length < pageSize) return out;
      }
      return out;
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

module.exports = { createPolySniperStore, OPEN_PHASES, EXPOSURE_PHASES };
