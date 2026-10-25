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
} = {}) {
  let active = 0;
  const queue = [];
  const inflightRfqs = new Set();
  const stats = { sent: 0, staleAge: 0, staleQueue: 0, dup: 0, queueFull: 0 };

  function drop(item, reason, extra) {
    if (reason === 'rfq_age') stats.staleAge += 1;
    else if (reason === 'queue_wait') stats.staleQueue += 1;
    else if (reason === 'queue_full') stats.queueFull += 1;
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
      if (age != null && age > maxRfqAgeMs) {
        inflightRfqs.delete(item.rfqId);
        drop(item, 'rfq_age', `age=${Math.round(age)}ms`);
        continue;
      }
      active += 1;
      stats.sent += 1;
      Promise.resolve()
        .then(() => item.fn({ queueMs: waited, rfqAgeMs: age }))
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
      if (rfqId) inflightRfqs.add(rfqId);
      let i = queue.length;
      while (i > 0 && queue[i - 1].priority < priority) i -= 1;
      queue.splice(i, 0, item);
      if (queue.length > maxQueued) {
        const victim = queue.pop(); // lowest priority, newest among equals
        inflightRfqs.delete(victim.rfqId);
        drop(victim, 'queue_full', `queued=${queue.length + 1}`);
      }
      pump();
    });
  }

  return {
    send,
    get active() { return active; },
    get queued() { return queue.length; },
    stats() { return { ...stats, active, queued: queue.length }; },
  };
}

module.exports = {
  createQuoteSender, isStaleDrop, rfqAgeMs,
  DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_QUEUE_MS, DEFAULT_MAX_RFQ_AGE_MS,
};
