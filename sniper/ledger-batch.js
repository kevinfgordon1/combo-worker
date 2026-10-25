// Batched ledger writer for the sniper (SNIPER_LEDGER_BATCH, default on; 0 = old per-RFQ RPC path).
//
// Oct 25 2026: one sniper_reserve RPC + one UPDATE per RFQ through PostgREST exhausted the shared
// Supabase pool and took down aibetbuilder.io / Combo Locks / testers. Here the hot path never
// touches the DB: caps are enforced in memory (decide() + memoryCapReason, as before), and every
// ledger write for an RFQ is merged into ONE pending row that a single writer flushes every
// flushMs as at most one upsert (new rows) + one UPDATE per identical patch (existing rows).
// Bounded: past maxQueue new reservations are refused (fail closed, counted, logged), never dropped
// silently. Fill safety is unchanged: confirmCheck flushes first, then runs sniper_confirm_check
// (DB, global lock, full caps) — a fill can never pass the real cap.
'use strict';

function rowFor(d, { releaseAt, dryRun, marketTicker }) {
  return {
    rfq_id: d.rfqId, combo_key: d.combo, games: d.games, legs: d.legs, dry_run: !!dryRun, status: 'open',
    phase: dryRun ? 'dry_run' : 'reserved', risk: d.risk, ev: d.ev, roi: d.roi, quote_yes: d.quoteYes,
    quote_american: d.quoteAmerican, fair_yes: d.fairYes, fair_american: d.fairAmerican, contracts: d.contracts,
    fee: d.fee, maker_rate: d.makerRate, market_ticker: marketTicker || null,
    release_at: new Date(releaseAt).toISOString(),
    settle_at: Number.isFinite(d.settleAt) ? new Date(d.settleAt).toISOString() : null,
  };
}

function createBatchedLedgerStore(store, { supabase, flushMs = 300, maxQueue = 2000, maxBatch = 500, log = console.log, now = () => Date.now(), breaker = null, onRejected = null } = {}) {
  // rfqId -> { row (full insert row) | null, patch: {}, waiters: [] }
  const q = new Map();
  const stats = { reserves: 0, refused: 0, flushes: 0, inserted: 0, updated: 0, failed: 0, requeued: 0, maxQueue: 0 };
  let timer = null; let flushing = null; let lastDropLog = 0; const rejected = new Set();
  const ts = () => new Date(now()).toISOString();
  function entry(id) { let e = q.get(id); if (!e) { e = { row: null, patch: {}, waiters: [] }; q.set(id, e); } return e; }
  function arm() { if (!timer && !flushing) { timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, flushMs); } }

  async function writeBatch(batch) {
    const inserts = []; const groups = new Map(); rejected.clear();
    for (const [id, e] of batch) {
      if (e.row) inserts.push({ ...e.row, ...e.patch, updated_at: ts() });
      else if (Object.keys(e.patch).length) {
        const k = JSON.stringify(e.patch); if (!groups.has(k)) groups.set(k, { patch: e.patch, ids: [] }); groups.get(k).ids.push(id);
      }
    }
    let ok = true;
    if (inserts.length) {
      const { error } = await supabase.from('sniper_ledger').upsert(inserts, { onConflict: 'rfq_id' });
      if (!error) stats.inserted += inserts.length;
      else {
        // One bad row (e.g. open-combo unique index) must not wedge the batch: retry row by row,
        // drop rows that are permanently rejected (logged), requeue the rest.
        log(`[SNIPER] ledger batch upsert (${inserts.length}) failed: ${error.message} — retrying per row`);
        for (const r of inserts) {
          const one = await supabase.from('sniper_ledger').upsert([r], { onConflict: 'rfq_id' });
          if (!one.error) { stats.inserted += 1; continue; }
          if (/23505|duplicate|unique|violates/i.test(one.error.message || '')) { stats.rejected = (stats.rejected || 0) + 1; rejected.add(r.rfq_id); log(`[SNIPER] ledger row rejected rfq=${r.rfq_id}: ${one.error.message}`); }
          else ok = false;
        }
      }
    }
    for (const g of groups.values()) {
      const { error } = await supabase.from('sniper_ledger').update({ ...g.patch, updated_at: ts() }).in('rfq_id', g.ids);
      if (error) { ok = false; log(`[SNIPER] ledger batch update (${g.ids.length}) failed: ${error.message}`); } else stats.updated += g.ids.length;
    }
    return ok;
  }

  async function flush() {
    if (flushing) return flushing;
    if (!q.size) return true;
    flushing = (async () => {
      const ids = [...q.keys()].slice(0, maxBatch);
      const batch = ids.map((id) => { const e = q.get(id); q.delete(id); return [id, e]; });
      let ok = false;
      if (breaker && breaker.isOpen()) ok = false;
      else { try { ok = await writeBatch(batch); } catch (e) { log(`[SNIPER] ledger batch threw: ${e.message}`); ok = false; } }
      if (ok) { stats.flushes += 1; for (const [id, e] of batch) { const v = !rejected.has(id); if (!v && onRejected) onRejected(id); for (const w of e.waiters) w(v); } }
      else {
        // Put back (merged under anything queued since) for the next flush; bounded by maxQueue.
        stats.failed += batch.length;
        for (const [id, e] of batch) {
          const cur = q.get(id);
          if (cur) { cur.row = cur.row || e.row; cur.patch = { ...e.patch, ...cur.patch }; cur.waiters.push(...e.waiters); }
          else if (q.size < maxQueue * 2) { q.set(id, e); stats.requeued += 1; }
          else for (const w of e.waiters) w(false);
        }
      }
      return ok;
    })();
    try { return await flushing; } finally { flushing = null; if (q.size) arm(); }
  }

  function wait(id) { return new Promise((r) => { entry(id).waiters.push(r); arm(); }); }

  return {
    ...store,
    reserve(d, opts) {
      if (q.size >= maxQueue) {
        stats.refused += 1;
        if (now() - lastDropLog > 10000) { lastDropLog = now(); log(`[SNIPER] ledger batch queue full (${q.size}) — refusing new reservations (fail closed)`); }
        return { ok: false, reason: 'batch_full' };
      }
      stats.reserves += 1; const e = entry(d.rfqId); e.row = rowFor(d, opts); stats.maxQueue = Math.max(stats.maxQueue, q.size); arm();
      return { ok: true };
    },
    update(rfqId, patch) { Object.assign(entry(rfqId).patch, patch); return wait(rfqId); },
    release(rfqId, phase, extra = {}) { Object.assign(entry(rfqId).patch, { status: 'released', phase, ...extra }); return wait(rfqId); },
    async confirmCheck(rfqId, risk, caps) { if (q.has(rfqId)) await flush(); if (q.has(rfqId)) await flush(); return store.confirmCheck(rfqId, risk, caps); },
    flush, backlog: () => q.size,
    batchStats: () => ({ ...stats, queued: q.size }),
  };
}

const ledgerBatchEnabled = (env) => String((env && env.SNIPER_LEDGER_BATCH) || '1') !== '0';

module.exports = { createBatchedLedgerStore, ledgerBatchEnabled, rowFor };
