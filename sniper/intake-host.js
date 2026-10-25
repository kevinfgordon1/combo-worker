// Main-thread side of the worker-thread RFQ intake (SNIPER_INTAKE_WORKER=1, default off).
// Same callback surface as createKalshiFirehose, so the runner wires it in place of the socket.
'use strict';
const { Worker } = require('worker_threads');
const path = require('path');

function createIntakeWorker({ startedAll = () => [], workerData, onRfqCreated, onRfqDeleted, onQuoteAccepted, onQuoteExecuted, onStatus = () => {}, onSkips = () => {}, openIds = () => [], syncMs = 100, log = console.log, WorkerImpl = Worker, file = path.join(__dirname, 'intake-worker.js') }) {
  let w = null; let stopped = false; let restarts = 0; let reqId = 0; const waiting = new Map(); let syncTimer = null;
  const stats = { rfqs: 0, deleted: 0, accepted: 0, executed: 0, restarts: 0, hopMs: [] };
  function spawn() {
    w = new WorkerImpl(file, { workerData });
    w.on('message', (m) => {
      if (!m) return;
      if (m.t === 'rfq') { stats.rfqs += 1; if (m.rfq.workerAt) { stats.hopMs.push(Date.now() - m.rfq.workerAt); if (stats.hopMs.length > 2000) stats.hopMs.shift(); } onRfqCreated(m.rfq); }
      else if (m.t === 'deleted') { stats.deleted += 1; onRfqDeleted(m.evt); }
      else if (m.t === 'accepted') { stats.accepted += 1; onQuoteAccepted(m.evt); }
      else if (m.t === 'executed') { stats.executed += 1; onQuoteExecuted(m.evt); }
      else if (m.t === 'skips') onSkips(m.skips);
      else if (m.t === 'status') onStatus(`intake-worker ${m.s}`, m.info ? JSON.parse(m.info) : undefined);
      else if (m.t === 'throughput') { const r = waiting.get(m.id); if (r) { waiting.delete(m.id); r(m.value); } }
      else if (m.t === 'ready') { onStatus('intake-worker ready'); const all = startedAll(); if (all.length) { try { w.postMessage({ t: 'started', tickers: all }); } catch (_) {} } }
    });
    w.on('error', (e) => log(`[SNIPER] intake worker error: ${e && e.message}`));
    w.on('exit', (code) => {
      if (stopped) return;
      restarts += 1; stats.restarts = restarts;
      const delay = Math.min(30000, 500 * 2 ** Math.min(restarts, 6));
      log(`[SNIPER] intake worker exited code=${code}; restarting in ${delay}ms`);
      setTimeout(() => { if (!stopped) spawn(); }, delay).unref?.();
    });
  }
  // Mirror open RFQ ids so the worker keeps rfq_deleted frames for quotes we hold.
  const sync = () => { try { if (w) w.postMessage({ t: 'open', ids: [...openIds()] }); } catch (_) {} };
  return {
    start() { spawn(); syncTimer = setInterval(sync, syncMs); if (syncTimer.unref) syncTimer.unref(); },
    addStarted(tickers) { try { if (w && tickers && tickers.length) w.postMessage({ t: 'started', tickers }); } catch (_) {} },
    addOpen(id) { try { if (w && id) w.postMessage({ t: 'open+', ids: [id] }); } catch (_) {} },
    async stop() { stopped = true; if (syncTimer) clearInterval(syncTimer); if (w) await w.terminate(); },
    takeThroughputAsync(timeoutMs = 500) {
      if (!w) return Promise.resolve(null);
      const id = ++reqId;
      return new Promise((resolve) => { waiting.set(id, resolve); w.postMessage({ t: 'throughput', id }); setTimeout(() => { if (waiting.delete(id)) resolve(null); }, timeoutMs).unref?.(); });
    },
    stats() { const a = [...stats.hopMs].sort((x, y) => x - y); stats.hopMs = []; return { ...stats, hopMs: undefined, hopP50: a.length ? a[Math.floor(a.length / 2)] : null, hopP90: a.length ? a[Math.floor(a.length * 0.9)] : null }; },
  };
}

module.exports = { createIntakeWorker };
