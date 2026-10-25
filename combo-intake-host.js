// Main-thread side of the Combo Locks RFQ intake worker (COMBO_INTAKE_WORKER=1, default off).
// Same surface live-runner.js uses on createKalshiFirehose (start/stop/health/takeThroughput/
// takeReconnects), so the runner swaps it in with one switch. Off => byte-for-byte the old
// in-thread firehose.
//
// Bounded: an RFQ that arrives while MAX_INFLIGHT onRfq handlers are still running, or that
// is already older than the stale limit when main gets to it, is dropped and counted instead
// of queued (the stale limit is the same KALSHI_STALE_RFQ_MS = 15s main already applies).
'use strict';
const path = require('path');

function on(raw) { return /^(1|true|yes|on)$/i.test(String(raw || '').trim()); }
function comboIntakeWorkerEnabled(env = process.env) { return on(env && env.COMBO_INTAKE_WORKER); }

function intEnv(raw, dflt, min, max) {
  const n = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function createdMs(createdTs) {
  if (createdTs == null || createdTs === '') return null;
  const t = typeof createdTs === 'number' ? (createdTs < 1e12 ? createdTs * 1000 : createdTs) : Date.parse(createdTs);
  return Number.isFinite(t) ? t : null;
}

// Pure filter run in the worker: combo only, not older than maxAgeMs (0 = no age gate).
function intakeCandidate(rfq, { maxAgeMs = 15000, now = Date.now(), bump = () => {} } = {}) {
  if (!rfq || !rfq.isCombo) { bump('not_combo'); return null; }
  const t = createdMs(rfq.createdTs);
  if (maxAgeMs > 0 && t != null && now - t > maxAgeMs) { bump('stale_at_intake'); return null; }
  return { ...rfq, workerAt: now };
}

function mergeReconnects(acc, r) {
  if (!r) return acc;
  const out = acc || { count: 0, byReason: {}, maxGapMs: null };
  out.count += Number(r.count) || 0;
  if (r.maxGapMs != null && (out.maxGapMs == null || r.maxGapMs > out.maxGapMs)) out.maxGapMs = r.maxGapMs;
  for (const [k, v] of Object.entries(r.byReason || {})) out.byReason[k] = (out.byReason[k] || 0) + v;
  return out;
}

function createComboIntakeHost({
  env = process.env, shardFactor, plan, maxAgeMs = 15000, dropDeleted = true,
  onRfqCreated, onRfqDeleted, onQuoteAccepted, onQuoteExecuted, onStatus = () => {},
  openIds = () => [], syncMs = 100, log = console.log, now = () => Date.now(),
  WorkerImpl, file = path.join(__dirname, 'combo-intake-worker.js'),
} = {}) {
  const Worker = WorkerImpl || require('worker_threads').Worker;
  const maxInflight = intEnv(env && env.COMBO_INTAKE_MAX_INFLIGHT, 256, 8, 10_000);
  let w = null; let stopped = false; let restarts = 0; let syncTimer = null;
  let lastHealth = null; let lastThroughput = null; let reconnects = null; let inflight = 0;
  let curPlan = plan || null;
  const stats = { rfqs: 0, deleted: 0, accepted: 0, executed: 0, restarts: 0, droppedBusy: 0, droppedStale: 0, workerSkips: {} };

  function handleRfq(rfq, msg) {
    const t = createdMs(rfq && rfq.createdTs);
    if (maxAgeMs > 0 && t != null && now() - t > maxAgeMs) { stats.droppedStale += 1; return; }
    if (inflight >= maxInflight) { stats.droppedBusy += 1; return; }
    stats.rfqs += 1;
    inflight += 1;
    let r;
    try { r = onRfqCreated(rfq, msg ? { msg } : {}); } catch (e) { inflight -= 1; throw e; }
    if (r && typeof r.then === 'function') r.then(() => { inflight -= 1; }, () => { inflight -= 1; });
    else inflight -= 1;
  }

  function onMessage(m) {
    if (!m) return;
    if (m.t === 'rfq') handleRfq(m.rfq, m.msg);
    else if (m.t === 'deleted') { stats.deleted += 1; onRfqDeleted(m.evt, {}); }
    else if (m.t === 'accepted') { stats.accepted += 1; onQuoteAccepted(m.evt); }
    else if (m.t === 'executed') { stats.executed += 1; onQuoteExecuted(m.evt); }
    else if (m.t === 'health') lastHealth = m.h;
    else if (m.t === 'throughput') lastThroughput = m.snap;
    else if (m.t === 'reconnects') reconnects = mergeReconnects(reconnects, m.r);
    else if (m.t === 'skips') for (const [k, v] of Object.entries(m.skips || {})) stats.workerSkips[k] = (stats.workerSkips[k] || 0) + v;
    else if (m.t === 'status') onStatus(m.s, m.info ? JSON.parse(m.info) : undefined);
    else if (m.t === 'ready') onStatus('intake-worker ready', { shardFactor });
  }

  function spawn() {
    w = new Worker(file, { workerData: { shardFactor, plan: curPlan, maxAgeMs, dropDeleted } });
    w.on('message', onMessage);
    w.on('error', (e) => log(`[intake] combo intake worker error: ${e && e.message}`));
    w.on('exit', (code) => {
      w = null;
      if (stopped) return;
      restarts += 1; stats.restarts = restarts;
      const delay = Math.min(30_000, 500 * 2 ** Math.min(restarts, 6));
      log(`[intake] combo intake worker exited code=${code}; restarting in ${delay}ms`);
      const t = setTimeout(() => { if (!stopped) spawn(); }, delay); if (t.unref) t.unref();
    });
  }
  const sync = () => { try { if (w) w.postMessage({ t: 'open', ids: [...openIds()].filter(Boolean) }); } catch (_) {} };

  return {
    intakeWorker: true,
    start() { spawn(); syncTimer = setInterval(sync, syncMs); if (syncTimer.unref) syncTimer.unref(); },
    async stop() { stopped = true; if (syncTimer) clearInterval(syncTimer); if (w) await w.terminate(); },
    setPlan(p) { curPlan = p || null; try { if (w) w.postMessage({ t: 'plan', plan: curPlan }); } catch (_) {} },
    addOpen(id) { try { if (w && id) w.postMessage({ t: 'open+', ids: [id] }); } catch (_) {} },
    health() { return lastHealth ? { ...lastHealth, intakeWorker: true, hostInflight: inflight } : null; },
    takeThroughput() { const s = lastThroughput; lastThroughput = null; return s; },
    takeReconnects() { const r = reconnects; reconnects = null; return r || { count: 0, byReason: {}, maxGapMs: null }; },
    stats() { const s = { ...stats, inflight, workerSkips: { ...stats.workerSkips } }; stats.droppedBusy = 0; stats.droppedStale = 0; stats.workerSkips = {}; return s; },
    _onMessage: onMessage,
  };
}

module.exports = { createComboIntakeHost, comboIntakeWorkerEnabled, intakeCandidate, mergeReconnects };
