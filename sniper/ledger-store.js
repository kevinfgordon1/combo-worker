// Persistent exposure ledger for the isolated sniper (sniper_ledger / sniper_decisions; no other
// job reads or writes them). Caps are enforced IN THE DATABASE by sniper_reserve /
// sniper_confirm_check (one advisory lock, so concurrent RFQs cannot both pass). Any DB error
// fails closed (no quote / no confirm).
'use strict';
const { isLongPos } = require('./write-behind');
const { netRiskOf, hedgePnl } = require('./hedge');

function capsFrom(config, dayStartIso, live = false) {
  return {
    live: !!live,
    total: config.totalExposureCap, long_total: config.longExposureCap, short_settle_hours: config.shortSettleHours, game: config.perGameCap, leg: config.perLegCap,
    daily_risk: config.dailyRiskCap, daily_loss: config.dailyLossCap,
    per_hour: config.maxQuotesPerHour, day_start: dayStartIso,
  };
}

function createLedgerStore({ supabase, log = console.log, now = () => Date.now() } = {}) {
  if (!supabase) throw new Error('ledger store needs supabase');
  async function hydrate(ledger, etDayStartIso, { live = false } = {}) {
    const { data, error } = await supabase.from('sniper_ledger')
      .select('rfq_id,combo_key,games,legs,risk,release_at,created_at,settle_at,phase,quote_id,market_ticker,contracts,filled_contracts,filled_cost,filled_fee,dry_run')
      .eq('status', 'open').eq('dry_run', !live).limit(20000);
    if (error) throw new Error(`hydrate: ${error.message}`);
    const rows = [];
    const t = now();
    for (const r of data || []) {
      const rel = Date.parse(r.release_at);
      if (!(rel > t) && r.phase !== 'accepted' && r.phase !== 'filled') continue;
      const settleMs = r.settle_at ? Date.parse(r.settle_at) : NaN; const createdMs = Date.parse(r.created_at);
      ledger.positions.set(r.rfq_id, { combo: r.combo_key, games: r.games || [], legs: r.legs || [], risk: Number(r.risk) || 0, grossRisk: Number(r.risk) || 0, releaseAt: Math.max(rel, r.phase === 'filled' || r.phase === 'accepted' ? t + 7 * 864e5 : rel),
        long: ledger.shortSettleHours != null ? isLongPos(settleMs, Number.isFinite(createdMs) ? createdMs : t, ledger.shortSettleHours) : false });
      ledger.seenRfqs.add(r.rfq_id);
      rows.push(r);
    }
    await applyHedges(ledger, rows);
    if (ledger.setDayExposure) ledger.setDayExposure(await dayExposure(etDayStartIso, { live }), t);
    return rows;
  }
  // Active sportsbook hedges (sniper_hedges, logged from My Fills) by rfq_id. Throws on error.
  async function activeHedges(rfqIds = null) {
    let q = supabase.from('sniper_hedges').select('rfq_id,american,stake,status').eq('status', 'active').limit(5000);
    if (rfqIds) { if (!rfqIds.length) return new Map(); q = q.in('rfq_id', rfqIds); }
    const { data, error } = await q;
    if (error) throw new Error(`hedges: ${error.message}`);
    const m = new Map(); for (const h of data || []) { if (!m.has(h.rfq_id)) m.set(h.rfq_id, []); m.get(h.rfq_id).push(h); }
    return m;
  }
  // In-memory pre-check mirrors the DB cap: hedged open fills count at net worst-case loss (sniper/hedge.js).
  // rows: open ledger rows with phase/filled_*; on any error positions keep GROSS risk (conservative).
  async function applyHedges(ledger, rows) {
    let hs; try { hs = await activeHedges(); } catch (e) {
      log(`[SNIPER] hedge refresh failed (back to gross risk): ${e.message}`);
      for (const pos of ledger.positions.values()) if (pos.grossRisk != null) pos.risk = pos.grossRisk;
      return 0;
    }
    const byId = new Map((rows || []).map((r) => [r.rfq_id, r]));
    let freed = 0;
    for (const [id, pos] of ledger.positions) {
      const gross = pos.grossRisk != null ? pos.grossRisk : pos.risk;
      const r = byId.get(id);
      const net = r && hs.has(id) ? netRiskOf(r, hs.get(id)) : gross;
      pos.grossRisk = gross; pos.risk = net; freed += gross - net;
    }
    return freed;
  }
  async function refreshHedges(ledger, { live = false } = {}) {
    const ids = [...ledger.positions.keys()]; if (!ids.length) return 0;
    const { data, error } = await supabase.from('sniper_ledger').select('rfq_id,risk,phase,filled_contracts,filled_cost,filled_fee').in('rfq_id', ids.slice(0, 2000)).eq('dry_run', !live);
    if (error) { log(`[SNIPER] hedge refresh ledger read failed (back to gross risk): ${error.message}`); for (const pos of ledger.positions.values()) if (pos.grossRisk != null) pos.risk = pos.grossRisk; return 0; }
    return applyHedges(ledger, data || []);
  }
  // Same function the DB daily cap uses: { filled, fills, pending }. Throws on error.
  async function dayExposure(dayStartIso, { live = false } = {}) {
    const { data, error } = await supabase.rpc('sniper_day_exposure', { p_day_start: dayStartIso, p_live: !!live });
    if (error) throw new Error(`day exposure: ${error.message}`);
    const o = data || {};
    return { filled: Number(o.filled) || 0, fills: Number(o.fills) || 0, pending: Number(o.pending) || 0 };
  }
  // -> { ok:true } | { ok:false, reason }
  async function reserve(d, { releaseAt, dryRun, caps, marketTicker = null }) {
    const row = {
      rfq_id: d.rfqId, combo_key: d.combo, games: d.games, legs: d.legs, dry_run: !!dryRun,
      phase: dryRun ? 'dry_run' : 'reserved',
      risk: d.risk, ev: d.ev, roi: d.roi, quote_yes: d.quoteYes, quote_american: d.quoteAmerican,
      fair_yes: d.fairYes, fair_american: d.fairAmerican, contracts: d.contracts, fee: d.fee, maker_rate: d.makerRate,
      market_ticker: marketTicker, release_at: new Date(releaseAt).toISOString(),
      settle_at: Number.isFinite(d.settleAt) ? new Date(d.settleAt).toISOString() : null,
    };
    try {
      const { data, error } = await supabase.rpc('sniper_reserve', { p_row: row, p_caps: caps });
      if (error) { log(`[SNIPER] sniper_reserve failed: ${error.message}`); return { ok: false, reason: 'db_error' }; }
      return data === 'ok' ? { ok: true } : { ok: false, reason: String(data || 'db_unknown') };
    } catch (e) { log(`[SNIPER] sniper_reserve threw: ${e.message}`); return { ok: false, reason: 'db_error' }; }
  }
  async function confirmCheck(rfqId, risk, caps) {
    try {
      const { data, error } = await supabase.rpc('sniper_confirm_check', { p_rfq: rfqId, p_risk: risk, p_caps: caps });
      if (error) return { ok: false, reason: 'db_error' };
      return data === 'ok' ? { ok: true } : { ok: false, reason: String(data || 'db_unknown') };
    } catch (_) { return { ok: false, reason: 'db_error' }; }
  }
  async function update(rfqId, patch) {
    try {
      const { error } = await supabase.from('sniper_ledger').update({ ...patch, updated_at: new Date(now()).toISOString() }).eq('rfq_id', rfqId);
      if (error) { log(`[SNIPER] ledger update ${rfqId} failed: ${error.message}`); return false; }
      return true;
    } catch (e) { log(`[SNIPER] ledger update ${rfqId} threw: ${e.message}`); return false; }
  }
  // Release = exposure stops counting (cancelled / declined / failed / settled).
  const release = (rfqId, phase, extra = {}) => update(rfqId, { status: 'released', phase, ...extra });
  async function openFilled() {
    const { data, error } = await supabase.from('sniper_ledger')
      .select('rfq_id,market_ticker,filled_contracts,filled_cost,filled_fee,risk,phase')
      .eq('status', 'open').eq('phase', 'filled').eq('dry_run', false).limit(5000);
    if (error) throw new Error(error.message);
    return data || [];
  }
  // Realized P&L today = Kalshi realized + P&L of active book hedges on those settled fills
  // (same as the DB daily-loss check). Throws on error (hedge read included) so the stop never under-counts.
  async function dayRealized(dayStartIso) {
    const { data, error } = await supabase.from('sniper_ledger').select('rfq_id,realized_pnl,market_result')
      .gte('settled_at', dayStartIso).eq('dry_run', false).limit(20000);
    if (error) throw new Error(error.message);
    const rows = data || [];
    const hs = await activeHedges(rows.map((r) => r.rfq_id));
    return rows.reduce((s, r) => s + (Number(r.realized_pnl) || 0) + (hs.has(r.rfq_id) ? hedgePnl(r.market_result, hs.get(r.rfq_id)) : 0), 0);
  }
  // Day recap inputs: quotes (decisions) + ledger rows touched since dayStartIso, for one book.
  async function dayRecap(dayStartIso, { live = false } = {}) {
    const acts = live ? ['quoted'] : ['would_quote'];
    const dq = await supabase.from('sniper_decisions').select('action', { count: 'exact', head: true })
      .gte('created_at', dayStartIso).in('action', acts);
    if (dq.error) throw new Error(dq.error.message);
    const fl = await supabase.from('sniper_ledger').select('rfq_id,phase,status,risk,filled_contracts,filled_cost,filled_fee,realized_pnl,settled_at,updated_at,created_at')
      .eq('dry_run', !live).or(`updated_at.gte.${dayStartIso},settled_at.gte.${dayStartIso}`).limit(20000);
    if (fl.error) throw new Error(fl.error.message);
    return { quotes: dq.count || 0, rows: fl.data || [] };
  }
  // Book-arb re-check: open live fills with their legs.
  // Each row carries hedges: [] (active sportsbook hedges already logged) so the watch can skip alerts.
  async function openFilledWithLegs() {
    const { data, error } = await supabase.from('sniper_ledger')
      .select('rfq_id,legs,filled_contracts,filled_cost,filled_fee')
      .eq('status', 'open').eq('phase', 'filled').eq('dry_run', false).gt('filled_contracts', 0).limit(500);
    if (error) throw new Error(error.message);
    let hs = new Map(); try { hs = await activeHedges((data || []).map((r) => r.rfq_id)); } catch (e) { log(`[SNIPER] book_arb hedge read failed: ${e.message}`); }
    return (data || []).map((r) => ({ ...r, hedges: hs.get(r.rfq_id) || [] }));
  }
  // Open live rows left in 'reserved' / 'quoted' by an earlier process (restart / crash): the
  // startup sweep cancels their Kalshi quotes and releases them.
  async function staleOpen() {
    const { data, error } = await supabase.from('sniper_ledger')
      .select('rfq_id,quote_id,phase,risk').eq('status', 'open').eq('dry_run', false)
      .in('phase', ['reserved', 'quoted']).limit(5000);
    if (error) throw new Error(`stale open: ${error.message}`);
    return data || [];
  }
  async function decision(rec) {
    try { await supabase.from('sniper_decisions').insert(rec); } catch (_) { /* audit only */ }
  }
  return { hydrate, refreshHedges, activeHedges, staleOpen, dayExposure, reserve, confirmCheck, update, release, openFilled, openFilledWithLegs, dayRealized, dayRecap, decision };
}

module.exports = { createLedgerStore, capsFrom };
