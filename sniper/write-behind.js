// Write-behind ledger for the sniper hot path.
//
// The in-memory ledger (decide() + memoryCapReason) is the hot-path cap gate; the Supabase
// sniper_reserve RPC no longer blocks the quote POST. Every DB op for one RFQ is chained on a
// per-RFQ promise, so update/release/confirmCheck always run AFTER that RFQ's reserve row lands.
// Fill safety: sniper_confirm_check (DB, all caps, advisory lock) still runs at accept time; if the
// background reserve failed it returns reserve_failed and the fill is declined (fail closed).
'use strict';

function createWriteBehindStore(store, {
  concurrency = 8, retries = 3, backoffMs = 250, log = console.log, alert = () => {},
  onReserveFailed = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const tails = new Map(); // rfqId -> promise of last op
  const failed = new Map(); // rfqId -> reason (bounded)
  const stats = { reserves: 0, ok: 0, retried: 0, failed: 0, inflight: 0, queued: 0, maxMs: 0 };
  let active = 0; const waiters = [];
  const acquire = () => (active < concurrency ? (active += 1, Promise.resolve()) : new Promise((r) => { stats.queued += 1; waiters.push(r); }));
  const releaseSlot = () => { const w = waiters.shift(); if (w) { stats.queued -= 1; w(); } else active -= 1; };

  function chain(rfqId, fn) {
    const prev = tails.get(rfqId) || Promise.resolve();
    const p = prev.catch(() => {}).then(fn);
    tails.set(rfqId, p);
    p.finally(() => { if (tails.get(rfqId) === p) tails.delete(rfqId); }).catch(() => {});
    return p;
  }

  async function doReserve(d, opts) {
    await acquire(); stats.inflight += 1; const t0 = Date.now();
    try {
      let res;
      for (let i = 0; i < retries; i += 1) {
        res = await store.reserve(d, opts);
        if (res && res.ok) break;
        if (!res || res.reason !== 'db_error') break; // cap reasons are final
        stats.retried += 1; if (i < retries - 1) await sleep(backoffMs * (i + 1));
      }
      if (res && res.ok) { stats.ok += 1; return res; }
      const reason = (res && res.reason) || 'db_unknown';
      stats.failed += 1; failed.set(d.rfqId, reason);
      if (failed.size > 5000) failed.delete(failed.keys().next().value);
      log(`[SNIPER] write-behind reserve FAILED rfq=${d.rfqId} reason=${reason} — cancelling quote, freeing memory reservation`);
      if (reason === 'db_error') alert(`[SNIPER] ledger reserve write failed after ${retries} tries (rfq ${d.rfqId}); quote cancelled.`);
      try { await onReserveFailed(d.rfqId, reason); } catch (e) { log(`[SNIPER] onReserveFailed error: ${e.message}`); }
      return res || { ok: false, reason };
    } finally {
      stats.inflight -= 1; stats.maxMs = Math.max(stats.maxMs, Date.now() - t0); releaseSlot();
    }
  }

  return {
    ...store,
    // Synchronous for the caller: returns { ok: true, pending } immediately.
    reserve(d, opts) { stats.reserves += 1; const pending = chain(d.rfqId, () => doReserve(d, opts)); return { ok: true, pending }; },
    reserveFailed: (rfqId) => failed.get(rfqId) || null,
    update: (rfqId, patch) => chain(rfqId, () => (failed.has(rfqId) ? false : store.update(rfqId, patch))),
    release: (rfqId, phase, extra) => chain(rfqId, () => (failed.has(rfqId) ? true : store.release(rfqId, phase, extra))),
    confirmCheck: (rfqId, risk, caps) => chain(rfqId, () => (failed.has(rfqId) ? { ok: false, reason: 'reserve_failed' } : store.confirmCheck(rfqId, risk, caps))),
    backlog: () => stats.inflight + stats.queued,
    flush: () => Promise.allSettled([...tails.values()]),
    wbStats: () => { const s = { ...stats }; stats.maxMs = 0; return s; },
  };
}

// In-memory long-settle cap (the DB has it; evaluateSnipe does not). Unknown settle = long.
function isLongPos(settleAt, createdAt, hours) {
  if (!Number.isFinite(settleAt)) return true;
  return settleAt - createdAt > hours * 3600e3;
}
function memoryCapReason(ledger, rfqId, { risk, settleAt, nowMs, longCap, shortHours }) {
  if (!(longCap > 0)) return null;
  if (!isLongPos(settleAt, nowMs, shortHours)) return null;
  let long = 0;
  for (const [id, p] of ledger.positions) if (id !== rfqId && p.long) long += p.risk;
  return long + risk > longCap + 1e-9 ? 'long_cap' : null;
}

// Default OFF (v49/v50 rollout: zero LIVE QUOTEs with write-behind on; ~3s pre-POST stall).
// SNIPER_WRITE_BEHIND=1 opts in once the stall is understood.
function writeBehindEnabled(env) { return /^(1|true|yes|on)$/i.test(String((env && env.SNIPER_WRITE_BEHIND) || '')); }

module.exports = { writeBehindEnabled, createWriteBehindStore, memoryCapReason, isLongPos };
