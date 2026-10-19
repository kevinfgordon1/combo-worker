// Matcher thread (COMBO_MATCH_THREADS>0). Pure CPU: JSON.parse + normalizeRfq +
// matchParlay against a lock snapshot pushed by the main thread. It never sends
// quotes, reserves, or touches the DB/network; the main thread stays the single
// owner of order sends and reservations.
'use strict';
const { parentPort } = require('worker_threads');
const { parseEnvelope, isRfqCreated, normalizeRfq, matchParlay } = require('./rfq');

let locks = [];
let version = 0;
const stats = { rfqs: 0, combos: 0, dollar: 0, matched: 0, parseErr: 0 };

function handleFrame(raw, recvTs) {
  let env;
  try { env = parseEnvelope(raw); } catch (_) { stats.parseErr++; return; }
  if (!env || !isRfqCreated(env)) return;
  const rfq = normalizeRfq(env);
  stats.rfqs++;
  if (!rfq.isCombo) return;
  if (rfq.contracts == null && !(rfq.targetCostDollars > 0)) return;
  stats.combos++;
  if (rfq.targetCostDollars > 0) stats.dollar++;
  const p = matchParlay(rfq, locks);
  if (!p) return;
  stats.matched++;
  // Only matches cross back (~0.1% of frames).
  parentPort.postMessage({ t: 'match', rfq, parlayId: p.id, version, recvTs });
}

parentPort.on('message', (m) => {
  if (!m) return;
  if (m.t === 'locks') { locks = Array.isArray(m.locks) ? m.locks : []; version = m.version; return; }
  if (m.t === 'frame') { handleFrame(m.raw, m.recvTs); return; }
  if (m.t === 'stats') { parentPort.postMessage({ t: 'stats', stats: { ...stats } }); for (const k in stats) stats[k] = 0; }
});
