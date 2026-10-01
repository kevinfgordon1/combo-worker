// OPTIONAL, NOT STARTED, NOT WIRED: low-latency RFQ intake over Kalshi's `communications` WebSocket
// using a SEPARATE, read-only API key (Kalshi allows ONE communications WS per key; combo-worker's
// key is that live quoter's, so noboost must never take it). Nothing in runner.js requires this file.
//
// To use (needs Kevin's go-ahead + a NEW Kalshi key created for this purpose):
//   NOBOOST_WS=1  NOBOOST_KALSHI_KEY_ID=<new key id>  NOBOOST_KALSHI_PRIVATE_KEY=<its PEM>
// and in runner.js:  const ws = require('./ws-intake').start({ onRfq: run.onRfq, env })
// It only RECEIVES rfq_created events; it never creates/confirms/cancels quotes.
'use strict';
const { normalizePem } = require('../kalshi-auth');

function wsEnabled(env = process.env) {
  return ['1', 'true', 'on', 'yes'].includes(String(env.NOBOOST_WS || '').toLowerCase())
    && !!env.NOBOOST_KALSHI_KEY_ID && !!env.NOBOOST_KALSHI_PRIVATE_KEY
    && env.NOBOOST_KALSHI_KEY_ID !== env.KALSHI_KEY_ID; // never share combo-worker's key
}

function start({ onRfq, env = process.env, log = console.log, createKalshiWs = require('../kalshi-ws').createKalshiWs } = {}) {
  if (!wsEnabled(env)) { log('[NOBOOST][WS] disabled (needs NOBOOST_WS=1 and a SEPARATE NOBOOST_KALSHI_KEY_ID/NOBOOST_KALSHI_PRIVATE_KEY)'); return null; }
  const sock = createKalshiWs({
    keyId: env.NOBOOST_KALSHI_KEY_ID,
    pem: normalizePem(env.NOBOOST_KALSHI_PRIVATE_KEY),
    onRfqCreated: (rfq) => {
      if (!rfq || !rfq.rfqId || !Array.isArray(rfq.legKeys) || !rfq.legKeys.length) return;
      onRfq({ rfqId: rfq.rfqId, marketTicker: rfq.marketTicker, legKeys: rfq.legKeys, createdMs: Date.now(), contracts: Number(rfq.contracts) || 0, targetCostDollars: Number(rfq.targetCostDollars) || 0 });
    },
    onStatus: (s) => log(`[NOBOOST][WS] ${s}`),
  });
  sock.start();
  return sock;
}
module.exports = { start, wsEnabled };
