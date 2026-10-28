// Kalshi quote POST gate (Oct 18 hotfix).
//
// Sunday load: quote POSTs piled up behind each other for 20-170s, then died
// as 401 header_timestamp_expired / 409 rfq_closed. This gate:
//   - caps concurrent quote POSTs at the quote pool's socket count (so undici
//     never queues a request that was signed long before it hits the wire);
//   - drops a send (STALE_DROP) if the RFQ is already older than maxRfqAgeMs
//     or the send waited in this queue longer than maxQueueMs;
//   - coalesces duplicate in-flight sends for the same rfq_id.
// The request itself is signed inside fn(), i.e. right before it is sent.
'use strict';

const DEFAULT_MAX_CONCURRENT = 16;
const DEFAULT_MAX_QUEUE_MS = 2000;
const DEFAULT_MAX_RFQ_AGE_MS = 3000;

function rfqAgeMs(createdTs, nowMs) {
  if (createdTs == null || createdTs === '') return null;
  const t = typeof createdTs === 'number'
    ? (createdTs < 1e12 ? createdTs * 1000 : createdTs)
    : Date.parse(createdTs);
  if (!Number.isFinite(t)) return null;
  return nowMs - t;
}

function staleError(reason, extra) {
  const e = new Error(`STALE_DROP ${reason}${extra ? ' ' + extra : ''}`);
  e.staleDrop = true;
  e.staleReason = reason;
  return e;
}

function isStaleDrop(errOrMsg) {
  if (!errOrMsg) return false;
  if (errOrMsg.staleDrop) return true;
  return /STALE_DROP/.test(String(errOrMsg.message || errOrMsg));
}

function createQuoteSender({
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  maxQueueMs = DEFAULT_MAX_QUEUE_MS,
  maxRfqAgeMs = DEFAULT_MAX_RFQ_AGE_MS,
  now = () => Date.now(),
  // Kalshi-aligned wall clock for RFQ age (created_ts is Kalshi time).
  serverNow = () => Date.now(),
  log = () => {},
  // Optional: bound the queue. When full, the lowest-priority waiting send is dropped right away
  // (reason=queue_full) instead of aging out after maxQueueMs and wasting the wait.
  maxQueued = Infinity,
  // Opt-in hard per-RFQ deadline (sniper, Oct 27 2026; combo-worker leaves this off):
  //   { windowMs, safetyMs, rps: () => quote sends/s, postEstMs: () => ms, aheadExtra: () => n }
  // A send is admitted only if  age + (ahead / rps) + postEst + safety <= windowMs, where `ahead`
  // is its position in the priority queue + sends already in flight + higher-lane limiter waiters.
  // Otherwise it is rejected at arrival (reason=expired) instead of queued. The same test runs
  // again at dequeue, and fn() gets ctx.abortIf so the token wait can give up too. The queue is
  // bounded to what rps can clear inside the window; past that the lowest-EV send is dropped
  // (reason=low_priority). Admission is per send, so capacity frees up as the queue drains.
  deadline = null,
} = {}) {
  let active = 0;
  const queue = [];
  const inflightRfqs = new Set();
  const stats = { sent: 0, staleAge: 0, staleQueue: 0, dup: 0, queueFull: 0, expired: 0, expiredAtArrival: 0, expiredAtDequeue: 0, lowPriority: 0 };
  const dl = deadline && Number(deadline.windowMs) > 0 ? deadline : null;
  const fnum = (f, d) => { const v = typeof f === 'function' ? f() : f; return Number.isFinite(Number(v)) && v != null ? Number(v) : d; };
  const dlRps = () => Math.max(0.1, fnum(dl.rps, 1));
  const dlPost = () => Math.max(0, fnum(dl.postEstMs, 150));
  const dlSafety = () => Math.max(0, fnum(dl.safetyMs, 0));
  const dlExtra = () => Math.max(0, fnum(dl.aheadExtra, 0));
  // Max queued sends that rps can still put on the wire inside the window.
  function capacity() {
    if (!dl) return maxQueued;
    const budget = dl.windowMs - dlSafety() - dlPost();
    const cap = Math.max(1, Math.floor((dlRps() * Math.max(0, budget)) / 1000));
    return Math.min(maxQueued, cap);
  }
  // Projected RFQ age when this send's POST lands, given `ahead` sends in front of it.
  function projectedMs(createdTs, ahead) {
    const age = rfqAgeMs(createdTs, serverNow());
    if (age == null) return null;
    return age + (Math.max(0, ahead) / dlRps()) * 1000 + dlPost();
  }
  const late = (p) => p != null && p + dlSafety() > dl.windowMs;
  function admission(createdTs, priority = 0) {
    let i = queue.length;
    while (i > 0 && queue[i - 1].priority < priority) i -= 1;
    const ahead = i + active + (dl ? dlExtra() : 0);
    const projected = dl ? projectedMs(createdTs, ahead) : null;
    return { ok: !dl || !late(projected), projectedMs: projected, ahead, position: i, capacity: capacity() };
  }

  function drop(item, reason, extra) {
    if (reason === 'rfq_age') stats.staleAge += 1;
    else if (reason === 'queue_wait') stats.staleQueue += 1;
    else if (reason === 'queue_full') stats.queueFull += 1;
    else if (reason === 'low_priority') stats.lowPriority += 1;
    else if (reason === 'expired') stats.expired += 1;
    log(`STALE_DROP reason=${reason} rfq=${item.rfqId}${extra ? ' ' + extra : ''}`);
    item.reject(staleError(reason, extra));
  }

  function pump() {
    while (active < maxConcurrent && queue.length) {
      const item = queue.shift();
      const waited = now() - item.enqAt;
      if (waited > maxQueueMs) {
        inflightRfqs.delete(item.rfqId);
        drop(item, 'queue_wait', `waited=${Math.round(waited)}ms`);
        continue;
      }
      const age = rfqAgeMs(item.createdTs, serverNow());
      if (dl) {
        const p = age == null ? null : age + dlPost();
        if (late(p)) {
          inflightRfqs.delete(item.rfqId); stats.expiredAtDequeue += 1;
          drop(item, 'expired', `age=${Math.round(age)}ms at=dequeue`);
          continue;
        }
      } else if (age != null && age > maxRfqAgeMs) {
        inflightRfqs.delete(item.rfqId);
        drop(item, 'rfq_age', `age=${Math.round(age)}ms`);
        continue;
      }
      active += 1;
      stats.sent += 1;
      Promise.resolve()
        .then(() => item.fn({
          queueMs: waited, rfqAgeMs: age,
          // Deadline mode: true once the POST could no longer land inside the window (checked
          // while it waits for a rate-limit token). Never true without a deadline.
          abortIf: dl ? () => { const a = rfqAgeMs(item.createdTs, serverNow()); return a != null && late(a + dlPost()); } : null,
        }))
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          inflightRfqs.delete(item.rfqId);
          pump();
        });
    }
  }

  // opts.priority: higher sends first (e.g. expected $ edge); ties stay FIFO. Default 0.
  function send(rfqId, createdTs, fn, opts = {}) {
    return new Promise((resolve, reject) => {
      const priority = Number.isFinite(opts.priority) ? opts.priority : 0;
      const item = { rfqId, createdTs, fn, resolve, reject, enqAt: now(), priority };
      if (rfqId && inflightRfqs.has(rfqId)) {
        stats.dup += 1;
        log(`STALE_DROP reason=duplicate rfq=${rfqId}`);
        reject(staleError('duplicate'));
        return;
      }
      if (dl) {
        const a = admission(createdTs, priority);
        if (!a.ok) {
          stats.expiredAtArrival += 1;
          drop(item, 'expired', `projected=${Math.round(a.projectedMs)}ms ahead=${a.ahead} at=arrival`);
          return;
        }
      }
      if (rfqId) inflightRfqs.add(rfqId);
      let i = queue.length;
      while (i > 0 && queue[i - 1].priority < priority) i -= 1;
      queue.splice(i, 0, item);
      const cap = capacity();
      if (queue.length > cap) {
        const victim = queue.pop(); // lowest priority, newest among equals
        inflightRfqs.delete(victim.rfqId);
        drop(victim, dl ? 'low_priority' : 'queue_full', `queued=${queue.length + 1} cap=${cap}`);
      }
      pump();
    });
  }

  return {
    send,
    admission,
    capacity,
    get active() { return active; },
    get queued() { return queue.length; },
    stats() { return { ...stats, active, queued: queue.length, capacity: capacity() }; },
  };
}

module.exports = {
  createQuoteSender, isStaleDrop, rfqAgeMs,
  DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_QUEUE_MS, DEFAULT_MAX_RFQ_AGE_MS,
};
