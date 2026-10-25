// Worker-thread side of the Combo Locks RFQ intake (COMBO_INTAKE_WORKER=1, default off).
// Mirrors sniper/intake-worker.js (PR #266) for live-runner.js: this thread owns the Kalshi
// communications WebSocket(s): TLS + frame decode, the lock-needle pre-parse drop, the
// rfq_deleted drop for RFQs we hold nothing on, JSON.parse, and the 15s stale gate
// (same KALSHI_STALE_RFQ_MS as the main thread). Only candidate combo RFQs, quote_accepted /
// quote_executed and closes for RFQs main holds are posted to the main thread, which keeps
// matching, pricing, reservations, caps, sends and the ledger unchanged.
// Credentials come from this process's env copy; they are never posted or logged.
'use strict';
const { parentPort, workerData } = require('worker_threads');
const { createKalshiFirehose } = require('./kalshi-ws');
const { normalizePem } = require('./kalshi-auth');
const { createQuoteHot, createDeletedFilter } = require('./quote-hot');
const { intakeCandidate } = require('./combo-intake-host');

const cfg = workerData || {};
const env = process.env;
const open = new Set();
let skips = {};
const bump = (k) => { skips[k] = (skips[k] || 0) + 1; };
const post = (m) => { try { parentPort.postMessage(m); } catch (_) { /* main gone */ } };
const hot = createQuoteHot();
if (cfg.plan) hot.setPlan(cfg.plan);

parentPort.on('message', (m) => {
  if (!m) return;
  if (m.t === 'plan') hot.setPlan(m.plan);
  else if (m.t === 'open') { open.clear(); for (const id of m.ids || []) open.add(id); }
  else if (m.t === 'open+') { for (const id of m.ids || []) open.add(id); }
});

const ws = createKalshiFirehose({
  env,
  shardFactor: cfg.shardFactor,
  keyId: env.KALSHI_KEY_ID,
  pem: normalizePem(env.Kalshi_combo_key || env.KALSHI_PRIVATE_KEY || ''),
  shouldDropCreated: (raw) => hot.shouldDropCreated(raw),
  shouldDropDeleted: cfg.dropDeleted ? createDeletedFilter((cb) => { open.forEach((id) => cb(id)); }) : undefined,
  onRfqCreated: (rfq, e) => {
    const c = intakeCandidate(rfq, { maxAgeMs: cfg.maxAgeMs, bump });
    if (c) post({ t: 'rfq', rfq: c, msg: e && e.msg ? e.msg : null });
  },
  onRfqDeleted: (evt) => post({ t: 'deleted', evt }),
  onQuoteAccepted: (evt) => post({ t: 'accepted', evt }),
  onQuoteExecuted: (evt) => post({ t: 'executed', evt }),
  onStatus: (s, info) => post({ t: 'status', s: typeof s === 'string' ? s : JSON.stringify(s), info: info ? JSON.stringify(info) : '' }),
});

const safe = (f) => { try { return f(); } catch (_) { return null; } };
setInterval(() => { post({ t: 'health', h: safe(() => ws.health && ws.health()) }); }, 500).unref();
setInterval(() => { post({ t: 'reconnects', r: safe(() => ws.takeReconnects && ws.takeReconnects()) }); }, 5000).unref();
setInterval(() => { post({ t: 'throughput', snap: safe(() => ws.takeThroughput && ws.takeThroughput()) }); }, 30_000).unref();
setInterval(() => { if (Object.keys(skips).length) { post({ t: 'skips', skips }); skips = {}; } }, 1000).unref();
if (!cfg.noStart) ws.start(); // noStart: tests only (no network)
post({ t: 'ready' });
