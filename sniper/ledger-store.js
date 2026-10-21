// Persistent exposure ledger for the isolated sniper (Supabase tables sniper_ledger /
// sniper_decisions, written by NOTHING else and read by nothing else).
// Idempotent: rfq_id is the primary key; a second open position on the same combo is
// blocked by a partial unique index (combo_key where status='open').
'use strict';

function createLedgerStore({ supabase, log = console.log, now = () => Date.now() } = {}) {
  if (!supabase) throw new Error('ledger store needs supabase');
  // Load open positions (not yet released) + today's opened risk, to rebuild the in-memory ledger.
  async function hydrate(ledger, etDayStartIso) {
    const nowIso = new Date(now()).toISOString();
    const { data, error } = await supabase.from('sniper_ledger')
      .select('rfq_id,combo_key,games,legs,risk,release_at,created_at')
      .eq('status', 'open').gt('release_at', nowIso).limit(20000);
    if (error) throw new Error(`hydrate: ${error.message}`);
    for (const r of data || []) {
      ledger.positions.set(r.rfq_id, { combo: r.combo_key, games: r.games || [], legs: r.legs || [], risk: Number(r.risk) || 0, releaseAt: Date.parse(r.release_at) });
      ledger.seenRfqs.add(r.rfq_id);
      if (r.created_at >= etDayStartIso) ledger.day.risk += Number(r.risk) || 0;
    }
    return (data || []).length;
  }
  // -> { ok:true } | { ok:false, reason:'duplicate'|'db_error' }
  async function reserve(d, { releaseAt, dryRun }) {
    const row = {
      rfq_id: d.rfqId, combo_key: d.combo, games: d.games, legs: d.legs, status: 'open', dry_run: !!dryRun,
      risk: d.risk, ev: d.ev, roi: d.roi, quote_yes: d.quoteYes, quote_american: d.quoteAmerican,
      fair_yes: d.fairYes, fair_american: d.fairAmerican, contracts: d.contracts, fee: d.fee, maker_rate: d.makerRate,
      release_at: new Date(releaseAt).toISOString(),
    };
    // free an expired open row on the same combo so the unique index doesn't block forever
    try {
      await supabase.from('sniper_ledger').update({ status: 'released' })
        .eq('combo_key', d.combo).eq('status', 'open').lt('release_at', new Date(now()).toISOString());
    } catch (_) { /* best effort */ }
    const { error } = await supabase.from('sniper_ledger').insert(row);
    if (!error) return { ok: true };
    if (error.code === '23505' || /duplicate|unique/i.test(error.message || '')) return { ok: false, reason: 'duplicate' };
    log(`[SNIPER] ledger insert failed: ${error.message}`);
    return { ok: false, reason: 'db_error' };
  }
  async function decision(rec) {
    try { await supabase.from('sniper_decisions').insert(rec); } catch (_) { /* audit only */ }
  }
  return { hydrate, reserve, decision };
}

module.exports = { createLedgerStore };
