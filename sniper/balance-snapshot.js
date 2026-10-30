'use strict';
// Kalshi sniper balance snapshot (Oct 30 2026). Every SNIPER_BALANCE_SNAPSHOT_MS (default 5 min, 0 = off)
// read the sniper subaccount's cash (GET /portfolio/subaccounts/balances, read lane) and insert one row
// into public.kalshi_account_snapshots (existing table, unused until now; no migration needed):
//   balance_cents        sniper subaccount cash
//   open_exposure_cents  sniper's own committed open risk (filled + accepted, from the in-memory ledger)
//   open_position_count  open positions in the in-memory ledger
//   raw_portfolio        { source: 'kalshi_sniper', subaccount, open_committed_usd, open_resting_usd, open_total_usd }
// Fail-soft: a read or insert error is logged (first few, then every 20th) and never touches trading.
function toCents(usd) { const n = Number(usd); return Number.isFinite(n) ? Math.round(n * 100) : null; }

function createBalanceSnapshot({ supabase, fetchBalanceUsd, totals = () => null, positions = () => null, subaccount = null, log = console.log, now = () => Date.now() } = {}) {
  if (!supabase || typeof fetchBalanceUsd !== 'function') throw new Error('balance snapshot needs supabase + fetchBalanceUsd');
  const stats = { ok: 0, failed: 0, last: null };
  async function tick() {
    let bal;
    try { bal = await fetchBalanceUsd(); } catch (e) { stats.failed += 1; if (stats.failed <= 3 || stats.failed % 20 === 0) log(`[SNIPER] balance snapshot read failed: ${e.message}`); return null; }
    const cents = toCents(bal);
    if (cents == null) { stats.failed += 1; return null; }
    let t = null; try { t = totals(); } catch (_) { t = null; }
    let n = null; try { n = positions(); } catch (_) { n = null; }
    const row = {
      snapshot_at: new Date(now()).toISOString(), balance_cents: cents,
      open_exposure_cents: t && Number.isFinite(Number(t.committed)) ? toCents(t.committed) : null,
      open_position_count: Number.isFinite(Number(n)) ? Number(n) : null,
      raw_portfolio: {
        source: 'kalshi_sniper', subaccount,
        open_committed_usd: t ? Number(t.committed) || 0 : null, open_resting_usd: t ? Number(t.resting) || 0 : null, open_total_usd: t ? Number(t.total) || 0 : null,
      },
    };
    const { error } = await supabase.from('kalshi_account_snapshots').insert(row);
    if (error) { stats.failed += 1; if (stats.failed <= 3 || stats.failed % 20 === 0) log(`[SNIPER] balance snapshot insert failed: ${error.message}`); return null; }
    stats.ok += 1; stats.last = { at: row.snapshot_at, balanceUsd: cents / 100 };
    return row;
  }
  return { tick, stats: () => ({ ...stats }) };
}

module.exports = { createBalanceSnapshot };
