// Multi-core RFQ matching (PREVIEW, off unless COMBO_MATCH_THREADS>0).
//
// Main thread: Kalshi sockets, cheap needle fast-drop, then hands each surviving
// rfq_created raw frame to a matcher thread (round-robin). Matcher threads parse,
// normalize and match against a lock snapshot. Only matches come back; the main
// thread re-resolves the lock by id against its CURRENT locks and runs the
// existing quote path (reservation, caps, send). One owner for sends/reservations
// means threads cannot double-quote.
'use strict';
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

function readThreads(env = process.env) {
  const raw = String((env || {}).COMBO_MATCH_THREADS || '').trim().toLowerCase();
  if (!raw || raw === '0' || raw === 'off') return 0;
  if (raw === 'auto') return Math.max(1, Math.min(8, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1));
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 16) : 0;
}

// Lock fields the matcher needs (structured-clone safe, small).
function lockSnapshot(p) {
  return { id: p.id, label: p.label, leg_keys: p.leg_keys, legKeys: p.legKeys, legs: p.legs };
}

function createMatchPool({ threads, onMatch, onError, WorkerImpl = Worker, file = path.join(__dirname, 'match-worker.js') } = {}) {
  const n = Math.max(1, threads | 0);
  const workers = [];
  let rr = 0;
  let version = 0;
  let pendingStats = null;
  const totals = { rfqs: 0, combos: 0, dollar: 0, matched: 0, parseErr: 0 };
  for (let i = 0; i < n; i++) {
    const w = new WorkerImpl(file);
    w.on('message', (m) => {
      if (!m) return;
      if (m.t === 'match') { try { onMatch(m); } catch (e) { onError && onError(e); } return; }
      if (m.t === 'stats') { for (const k in totals) totals[k] += m.stats[k] || 0; if (pendingStats && --pendingStats.left === 0) { pendingStats.resolve({ ...totals }); for (const k in totals) totals[k] = 0; pendingStats = null; } }
    });
    w.on('error', (e) => onError && onError(e));
    workers.push(w);
  }
  return {
    size: n,
    setLocks(locks) {
      version++;
      const snap = (locks || []).map(lockSnapshot);
      for (const w of workers) w.postMessage({ t: 'locks', locks: snap, version });
      return version;
    },
    submit(raw, recvTs) {
      const w = workers[rr];
      rr = (rr + 1) % n;
      w.postMessage({ t: 'frame', raw, recvTs });
    },
    stats() {
      if (pendingStats) return pendingStats.promise;
      let resolve; const promise = new Promise((r) => { resolve = r; });
      pendingStats = { left: n, resolve, promise };
      for (const w of workers) w.postMessage({ t: 'stats' });
      return promise;
    },
    async stop() { await Promise.all(workers.map((w) => w.terminate())); },
  };
}

module.exports = { createMatchPool, readThreads, lockSnapshot };
