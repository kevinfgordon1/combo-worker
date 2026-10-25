// Worker-thread side of the sniper RFQ intake (SNIPER_INTAKE_WORKER=1).
// Owns the Kalshi communications WebSocket: frame decode, NFL/NBA needle drop, rfq_deleted drop,
// JSON.parse, age gate and leg-scope gate. Only candidate RFQs + quote_accepted / quote_executed /
// closes of RFQs we hold are posted to the main thread, which keeps pricing, sends, reservations,
// caps and the ledger. Credentials come from this process's env (worker_threads share a copy of
// process.env); they are never posted or logged.
'use strict';
const { parentPort, workerData } = require('worker_threads');
const { createKalshiFirehose, summarizeThroughput } = require('../kalshi-ws');
const { normalizePem, signedNow } = require('../kalshi-auth');
const { createNflFrameFilter, createDeletedIdFilter, NFL_NEEDLES, NBA_NEEDLES } = require('./intake');
const { createCandidateFilter } = require('./intake-filter');
const { maybeStartCpuProfile } = require('./cpu-prof');

const cfg = workerData || {};
const env = process.env;
const open = new Set(); // RFQ ids main holds a quote / POST / cancel on (mirrored)
let skips = {};
const bump = (k) => { skips[k] = (skips[k] || 0) + 1; };
const post = (m) => { try { parentPort.postMessage(m); } catch (_) { /* main gone */ } };

parentPort.on('message', (m) => {
  if (!m) return;
  if (m.t === 'open') { open.clear(); for (const id of m.ids || []) open.add(id); }
  else if (m.t === 'open+') { for (const id of m.ids || []) open.add(id); }
  else if (m.t === 'throughput') post({ t: 'throughput', id: m.id, value: safeThroughput() });
});

const candidate = createCandidateFilter(cfg, { clock: () => signedNow(), bump });

const ws = createKalshiFirehose({
  env,
  shardFactor: cfg.shardFactor,
  keyId: env.SNIPER_KALSHI_KEY_ID,
  pem: normalizePem(env.SNIPER_KALSHI_PRIVATE_KEY),
  shouldDropCreated: cfg.fastDrop ? createNflFrameFilter(cfg.nba ? [...NFL_NEEDLES, ...NBA_NEEDLES] : NFL_NEEDLES) : undefined,
  shouldDropDeleted: cfg.fastDrop ? createDeletedIdFilter((id) => open.has(id)) : undefined,
  onRfqCreated: (rfq) => { const c = candidate(rfq); if (c) post({ t: 'rfq', rfq: c }); },
  onRfqDeleted: (evt) => post({ t: 'deleted', evt }),
  onQuoteAccepted: (evt) => post({ t: 'accepted', evt }),
  onQuoteExecuted: (evt) => post({ t: 'executed', evt }),
  onStatus: (s, info) => post({ t: 'status', s: typeof s === 'string' ? s : JSON.stringify(s), info: info ? JSON.stringify(info) : '' }),
});
function safeThroughput() { try { if (!ws || typeof ws.takeThroughput !== 'function') return null; const t = summarizeThroughput(ws.takeThroughput()); delete t.perShard; return t; } catch (_) { return null; } }

setInterval(() => { if (Object.keys(skips).length) { post({ t: 'skips', skips }); skips = {}; } }, 1000).unref();
maybeStartCpuProfile('intake', env, (m) => post({ t: 'status', s: m, info: '' }));
if (ws && typeof ws.start === 'function') ws.start(); else if (ws && typeof ws.connect === 'function') ws.connect();
post({ t: 'ready' });
