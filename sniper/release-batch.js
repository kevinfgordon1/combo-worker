'use strict';
// Batches routine ledger releases (cancelled / declined / failed, no extra columns) into one
// UPDATE ... WHERE rfq_id IN (...) per phase every flushMs, so ~30 cancels/s don't each take a
// Supabase round trip on the shared client (Oct 25 2026 reserve stall). flushMs<=0 = off.
function createReleaseBatcher({ supabase, flushMs = 250, maxBatch = 200, log = console.log, now = () => Date.now(), fallback } = {}) {
  const q = new Map(); // phase -> [{ rfqId, resolve }]
  let timer = null; const stats = { queued: 0, flushes: 0, rows: 0, failed: 0 };
  async function flushPhase(phase, items) {
    const ids = items.map((i) => i.rfqId);
    let ok = false;
    try {
      const { error } = await supabase.from('sniper_ledger').update({ status: 'released', phase, updated_at: new Date(now()).toISOString() }).in('rfq_id', ids);
      if (error) log(`[SNIPER] batched release (${ids.length}) failed: ${error.message}`); else ok = true;
    } catch (e) { log(`[SNIPER] batched release (${ids.length}) threw: ${e.message}`); }
    if (!ok) { stats.failed += ids.length; if (fallback) { for (const i of items) i.resolve(await fallback(i.rfqId, phase)); return; } }
    stats.flushes += 1; stats.rows += ids.length;
    for (const i of items) i.resolve(ok);
  }
  async function flush() {
    timer = null;
    const work = [];
    for (const [phase, items] of q) { q.delete(phase); for (let k = 0; k < items.length; k += maxBatch) work.push(flushPhase(phase, items.slice(k, k + maxBatch))); }
    await Promise.all(work);
  }
  function release(rfqId, phase) {
    return new Promise((resolve) => {
      if (!q.has(phase)) q.set(phase, []);
      q.get(phase).push({ rfqId, resolve }); stats.queued += 1;
      if (!timer) { timer = setTimeout(() => { flush().catch(() => {}); }, flushMs); }
    });
  }
  const BATCHABLE = new Set(['cancelled', 'declined', 'failed']);
  const canBatch = (phase, extra) => BATCHABLE.has(phase) && (!extra || Object.keys(extra).length === 0);
  return { release, canBatch, flush, stats: () => ({ ...stats, waiting: [...q.values()].reduce((s, a) => s + a.length, 0) }) };
}

// Races a reserve against timeoutMs. On timeout -> { ok:false, reason:'timeout' } right away; if the
// late DB reserve then succeeds, onLate(rfqId) releases the orphan row. timeoutMs<=0 = no timeout.
function withReserveTimeout(p, timeoutMs, onLate = () => {}) {
  if (!(timeoutMs > 0) || !p || typeof p.then !== 'function') return p;
  let timedOut = false; let t;
  const timeout = new Promise((r) => { t = setTimeout(() => { timedOut = true; r({ ok: false, reason: 'timeout' }); }, timeoutMs); });
  const real = Promise.resolve(p).then((res) => { clearTimeout(t); if (timedOut && res && res.ok) { try { onLate(); } catch (_) { /* best effort */ } } return res; },
    (e) => { clearTimeout(t); return { ok: false, reason: 'db_error', error: e }; });
  return Promise.race([real, timeout]);
}

// Runs fn over items with at most n in flight.
async function mapLimit(items, n, fn) {
  const out = []; let i = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } });
  await Promise.all(lanes); return out;
}

// Decision rows for RFQs we never quoted (aborted before/at POST, rogue-line notes). ~50% of rows.
const SKIP_ACTIONS = new Set(['aborted', 'rogue_line']);
const isSkipDecision = (rec) => !!rec && SKIP_ACTIONS.has(rec.action);

module.exports = { createReleaseBatcher, withReserveTimeout, mapLimit, isSkipDecision };
