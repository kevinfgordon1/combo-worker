// ─────────────────────────────────────────────────────────────────────────
// unhedged-runner.js — Unhedged RFQ job (paper / shadow only)
//
// Own process. Own Kalshi WS + REST. Own /markets price cache + fill tracker.
// Must NOT share the Combo Locks Node event loop or Kalshi quote HTTP pool.
//
// Records in-scope unmatched MLB/NFL full-game moneyline combos to
// unhedged_rfqs. Combo Lock matches (matchParlay vs combo_parlays) are
// skipped — that accounting stays on live-runner.
// Never POSTs / confirms a Combo Lock quote. UNHEDGED_RFQ_LIVE stays off.
// Quote-watcher is not wired.
//
// Env: same Kalshi + Supabase (+ optional Poly / Telegram) as Combo Locks.
//      WORKER_MODE=unhedged (start-unhedged.js sets this).
//      UNHEDGED_RFQ_SHADOW default on. UNHEDGED_RFQ_LIVE must stay off.
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { Agent, fetch: undiciFetch } = require('undici');
const { createKalshiWs } = require('./kalshi-ws');
const { normalizePem, clockOffset, signedRequest } = require('./kalshi-auth');
const { createKalshiClient } = require('./kalshi-http');
const { startHeartbeat } = require('./heartbeat');
const { startPolymarketRfqLoop } = require('./polymarket-rfq');
const { isUnhedgedRfqShadow, isUnhedgedRfqLive } = require('./unhedged-rfq');
const { startUnhedgedSide, handleKalshiUnhedgedCreated } = require('./unhedged-boot');
const { querySoftFailed, applyRefreshParlays } = require('./refresh-state');
const {
  createUnhedgedSupabaseClient,
  isTransientSupabaseFailure,
  formatSupabaseFailure,
  createRateLimitedLogger,
} = require('./supabase-http');

const MODE = 'UNHEDGED';
const KEY_ID = process.env.KALSHI_KEY_ID;
const PEM = normalizePem(process.env.Kalshi_combo_key || process.env.KALSHI_PRIVATE_KEY || '');
const supabase = createUnhedgedSupabaseClient({
  createClient,
  env: process.env,
  fetch: undiciFetch,
  Agent,
});
const unhandledLog = createRateLimitedLogger();
process.on('unhandledRejection', (err) => {
  if (isTransientSupabaseFailure(err) || /fetch failed/i.test(String(err && err.message))) {
    unhandledLog.log(
      'unhandled',
      `[${MODE}] unhandled fetch ${formatSupabaseFailure(err)}`
    );
    return;
  }
  console.error(`[${MODE}] unhandledRejection`, err);
});
const kalshiHttp = createKalshiClient();
const WARM_PATH = '/trade-api/v2/exchange/status';

async function kalshiSigned(method, signPath, opts = {}) {
  const http = opts.http || kalshiHttp;
  return signedRequest(async ({ method: m, path, headers, body }) => {
    const req = { method: m, path, headers };
    if (body != null) req.body = body;
    const { statusCode, headers: resHeaders, body: resBody } = await http.request(req);
    const text = await resBody.text();
    return { statusCode, headers: resHeaders, text };
  }, {
    keyId: KEY_ID,
    pem: PEM,
    method,
    signPath,
    path: opts.path,
    headers: opts.headers,
    body: opts.body,
  });
}

async function kalshiGet(path, query) {
  const fullPath = query ? `${path}?${query}` : path;
  const { statusCode, text } = await kalshiSigned('GET', path, { path: fullPath });
  if (statusCode === 404) return { statusCode, json: null };
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Kalshi GET ${path} ${statusCode}: ${text}`);
  }
  return { statusCode, json: text ? JSON.parse(text) : null };
}

let parlays = [];
let side = null;
let polyLoop = null;
const counts = {
  rfqs: 0, combos: 0, lockSkip: 0, shadowed: 0,
  matched: 0, wouldQuote: 0, declined: 0, noLock: 0,
  posted: 0, postFailed: 0, dollarRfqs: 0, limitReached: 0,
};

async function refresh() {
  try {
    const parlaysQ = await supabase.from('combo_parlays').select('*').eq('active', true);
    const refreshLog = { error: (msg) => console.error(`[${MODE}] ${msg}`) };
    const parlaysFailed = querySoftFailed(parlaysQ);
    parlays = applyRefreshParlays(parlays, parlaysQ, refreshLog);
    if (parlaysFailed) {
      console.log(
        `[${MODE}] refreshed — ${parlays.length} active parlay(s) RETAINED after soft-fail`
      );
    } else {
      console.log(`[${MODE}] refreshed — ${parlays.length} active parlay(s) (lock-skip snapshot)`);
    }
  } catch (e) {
    console.error(`[${MODE}] refresh failed`, e.message);
  }
}

function onRfq(rfq, env) {
  counts.rfqs++;
  const out = handleKalshiUnhedgedCreated(rfq, {
    getParlays: () => parlays,
    persist: side && side.persist,
    supabase,
    env: process.env,
    priceCache: side && side.prices,
    fills: side && side.fills,
    extra: env && env.msg ? { msg: env.msg } : null,
  });
  if (rfq && rfq.isCombo) counts.combos++;
  if (out.action === 'skip' && out.reason === 'combo_lock') counts.lockSkip++;
  if (out.action === 'shadow') counts.shadowed++;
}

function onRfqDeleted(evt, env) {
  const rfqId = evt && evt.rfqId;
  if (!rfqId || !side || !side.fills) return;
  side.fills.onClosed({
    venue: 'kalshi',
    rfqId,
    extra: env,
    rfq: evt,
  }).catch((e) => console.error('[UNHEDGED] fill close', e && e.message));
}

async function warmRest() {
  try {
    const { statusCode } = await kalshiSigned('GET', WARM_PATH);
    const offset = clockOffset();
    console.log(`[${MODE}] connection warm rest ok status=${statusCode} clockOffset=${offset}ms`);
  } catch (e) {
    console.error(`[${MODE}] connection warm rest failed`, e.message);
  }
}

async function main() {
  if (!KEY_ID || !PEM || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error(
      `[${MODE}] missing env: need KALSHI_KEY_ID, Kalshi_combo_key, SUPABASE_URL, SUPABASE_SERVICE_KEY`
    );
    process.exit(1);
  }
  if (isUnhedgedRfqLive(process.env)) {
    console.warn(
      `[${MODE}] UNHEDGED_RFQ_LIVE is on but this job is paper-only — posting is not wired.`
    );
  }
  console.log(
    `[${MODE}] starting — paper/shadow only. Own Kalshi WS + /markets cache + fill tracker. ` +
    `No Combo Lock quote POST/confirm. MLB/NFL full-game moneylines. ` +
    `UNHEDGED_RFQ_SHADOW=${isUnhedgedRfqShadow(process.env) ? 'on' : 'off'}, ` +
    `UNHEDGED_RFQ_LIVE=${isUnhedgedRfqLive(process.env) ? 'on' : 'off'}. ` +
    `Lock matches skip (shared combo_parlays).`
  );

  side = startUnhedgedSide({
    supabase,
    env: process.env,
    kalshiGet,
  });

  await refresh();
  setInterval(refresh, 30000);

  await warmRest();
  setInterval(warmRest, 45000);

  startHeartbeat(supabase, MODE, counts, () => parlays.length);

  polyLoop = startPolymarketRfqLoop({
    enableLocks: false,
    enableUnhedged: true,
    getParlays: () => parlays,
    startedFor: () => ({ started: false }),
    filledSoFarFor: () => 0,
    getOutstanding: () => 0,
    pendingQuotes: new Map(),
    supabase,
    env: process.env,
    unhedgedPrices: side.prices,
    unhedgedFills: side.fills,
    persistUnhedged: side.persist,
    http: side.polyHttp || undefined,
  });

  let lastWsAlertAt = 0;
  function noteWsStatus(s, info) {
    console.log(`[${MODE}] ws:${s}`, info || '');
    if (s !== 'stalled' && s !== 'error') return;
    if (Date.now() - lastWsAlertAt < 5 * 60_000) return;
    lastWsAlertAt = Date.now();
    const detail = info && typeof info === 'object' ? JSON.stringify(info) : String(info || s);
    console.error(`[${MODE}] Kalshi WS ${s} ${detail} — paper tape paused until communications resume.`);
  }

  const client = createKalshiWs({
    keyId: KEY_ID,
    pem: PEM,
    onStatus: noteWsStatus,
    onRfqCreated: (rfq, env) => {
      try { onRfq(rfq, env); } catch (e) { console.error('onRfq', e); }
    },
    onRfqDeleted: (evt, env) => {
      try { onRfqDeleted(evt, env); } catch (e) { console.error('onRfqDeleted', e); }
    },
  });

  setInterval(() => {
    const h = client.health ? client.health() : null;
    const age = h && h.lastCommAt ? Date.now() - h.lastCommAt : null;
    console.log(`[${MODE}] tallies`, { ...counts, kalshiWsAgeMs: age, kalshiWsStallMs: h && h.stallMs });
  }, 60000);

  process.on('SIGINT', () => {
    client.stop();
    try { polyLoop && polyLoop.stop && polyLoop.stop(); } catch (_) {}
    try { side && side.stop && side.stop(); } catch (_) {}
    try { kalshiHttp.close(); } catch (_) {}
    console.log(`[${MODE}] final`, counts);
    process.exit(0);
  });
  client.start();
}

main();
