// ─────────────────────────────────────────────────────────────────────────
// unhedged-runner.js — Unhedged RFQ shadow worker (paper only)
//
// Separate Railway job from Combo Locks. Owns markets GETs, shadow tape,
// fill tracking, and the Unhedged side of the Kalshi/Poly firehose so those
// cannot delay Combo Lock quote POSTs.
//
// NEVER posts Kalshi or Polymarket quotes. UNHEDGED_RFQ_LIVE stays off —
// even if that env is mistakenly on, this process does not POST.
// Combo Locks Miss tape (combo_submissions) is not written here.
//
// Scope: unmatched MLB/NFL full-game moneylines (no NCAAF). Same-slate
// different games OK; no same-game / SGP. No Polymarket maker rebates.
// Loads combo_parlays only to classify lock-match vs lock-miss.
//
// Env: KALSHI_KEY_ID, Kalshi_combo_key, SUPABASE_URL, SUPABASE_SERVICE_KEY
//      POLYMARKET_KEY_ID, POLYMARKET_SECRET_KEY (Poly shadow + fill lookup)
//      UNHEDGED_RFQ_SHADOW (default on), UNHEDGED_RFQ_LIVE (must stay off)
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { createKalshiWs } = require('./kalshi-ws');
const { normalizePem, clockOffset, signedRequest } = require('./kalshi-auth');
const { createKalshiClient } = require('./kalshi-http');
const { startHeartbeat } = require('./heartbeat');
const { startPolymarketRfqLoop } = require('./polymarket-rfq');
const { applyRefreshParlays, querySoftFailed } = require('./refresh-state');
const { isUnhedgedRfqShadow, isUnhedgedRfqLive } = require('./unhedged-rfq');
const {
  createUnhedgedRuntime,
  considerKalshiUnhedged,
  DEFAULT_FILL_TICK_MS,
} = require('./unhedged-runtime');
const { workerRole } = require('./unhedged-mode');

const MODE = 'UNHEDGED';
const KEY_ID = process.env.KALSHI_KEY_ID;
const PEM = normalizePem(process.env.Kalshi_combo_key || process.env.KALSHI_PRIVATE_KEY || '');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const kalshiHttp = createKalshiClient({ connections: 4 });
const FILL_TICK_MS = DEFAULT_FILL_TICK_MS;

const counts = {
  rfqs: 0, combos: 0, matched: 0, lockMiss: 0, wouldQuote: 0,
  declined: 0, noLock: 0, posted: 0, postFailed: 0, dollarRfqs: 0,
  limitReached: 0,
};

let parlays = [];
let unhedged = null;
let lastLockFingerprint = '';

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

async function fetchKalshiRfq(rfqId) {
  const { statusCode, json } = await kalshiGet(`/trade-api/v2/communications/rfqs/${rfqId}`);
  if (statusCode === 404 || !json) return null;
  return json.rfq || json;
}

async function fetchKalshiTrades(ticker, minTs, maxTs) {
  const qs = new URLSearchParams({
    ticker: String(ticker),
    min_ts: String(minTs),
    max_ts: String(maxTs),
    limit: '100',
  });
  const { json } = await kalshiGet('/trade-api/v2/markets/trades', qs.toString());
  return (json && json.trades) || [];
}

async function refreshParlays() {
  try {
    const parlaysQ = await supabase.from('combo_parlays').select('*').eq('active', true);
    const refreshLog = { error: (msg) => console.error(`[${MODE}] ${msg}`) };
    const failed = querySoftFailed(parlaysQ);
    parlays = applyRefreshParlays(parlays, parlaysQ, refreshLog);
    const bits = parlays.map((row) => row.label || row.id);
    const fingerprint = bits.join(' || ');
    if (failed) {
      console.log(
        `[${MODE}] refreshed — ${parlays.length} active parlay(s) RETAINED after soft-fail — ${bits.join(', ') || 'none'}`
      );
    } else {
      console.log(`[${MODE}] refreshed — ${parlays.length} active parlay(s)`);
    }
    if (fingerprint !== lastLockFingerprint) {
      lastLockFingerprint = fingerprint;
      for (const bit of bits) console.log(`[${MODE}] lock ${bit}`);
    }
  } catch (e) {
    console.error(`[${MODE}] refresh failed`, e && e.message);
  }
}

function onKalshiRfq(rfq, env) {
  counts.rfqs++;
  const decision = considerKalshiUnhedged(rfq, parlays);
  if (decision.reason === 'not_combo' || decision.reason === 'no_size') return decision;
  counts.combos++;
  if (rfq && rfq.targetCostDollars > 0) counts.dollarRfqs++;
  if (decision.reason === 'lock_match') {
    counts.matched++;
    return decision;
  }
  counts.lockMiss++;
  if (unhedged) {
    unhedged.shadowKalshiMiss(rfq, env && env.msg ? { msg: env.msg } : null);
  }
  return decision;
}

function onKalshiClosed(evt, env) {
  if (!unhedged) return;
  unhedged.onKalshiClosed(evt, env).catch((e) => {
    console.error('[UNHEDGED] fill close', e && e.message);
  });
}

async function main() {
  if (workerRole(process.env) === 'locks') {
    console.error(
      `[${MODE}] WORKER_ROLE=locks — this entrypoint is unhedged-only. Use start-live.js for Combo Locks.`
    );
    process.exit(1);
  }
  if (!KEY_ID || !PEM || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error(
      `[${MODE}] missing env: need KALSHI_KEY_ID, Kalshi_combo_key, SUPABASE_URL, SUPABASE_SERVICE_KEY`
    );
    process.exit(1);
  }
  if (isUnhedgedRfqLive(process.env)) {
    console.error(
      `[${MODE}] UNHEDGED_RFQ_LIVE is on but this process never POSTs. ` +
      `Live unhedged trading is not wired — leaving LIVE off in practice.`
    );
  }

  console.log(
    `[${MODE}] starting — paper/shadow only. MLB/NFL full-game ML. ` +
    `No Combo Lock POSTs, no quote-watcher, no Polymarket maker rebates. ` +
    `UNHEDGED_RFQ_SHADOW=${isUnhedgedRfqShadow(process.env) ? 'on' : 'off'} ` +
    `UNHEDGED_RFQ_LIVE=${isUnhedgedRfqLive(process.env) ? 'on' : 'off'} ` +
    `(live stays unwired). Shared unhedged_rfqs table.`
  );

  unhedged = createUnhedgedRuntime({
    supabase,
    env: process.env,
    fetchKalshiRfq,
    fetchKalshiTrades,
    fetchKalshiMarkets: async (series, cursor) => {
      const qs = new URLSearchParams({
        series_ticker: series,
        status: 'open',
        limit: String(200),
      });
      if (cursor) qs.set('cursor', String(cursor));
      return kalshiGet('/trade-api/v2/markets', qs.toString());
    },
  });
  unhedged.start();
  setInterval(() => {
    unhedged.tick().catch((e) => console.error('[UNHEDGED] fill tick', e && e.message));
  }, FILL_TICK_MS);

  await refreshParlays();
  setInterval(() => { refreshParlays(); }, 30000);

  startHeartbeat(supabase, MODE, counts, () => parlays.length);

  const poly = startPolymarketRfqLoop({
    getParlays: () => parlays,
    supabase,
    env: process.env,
    quoteLocks: false,
    unhedgedEnabled: true,
    unhedgedPrices: unhedged.prices,
    unhedgedFills: unhedged.fills,
    persistUnhedged: (row, meta) => unhedged.persistRow(row, meta),
    http: unhedged.polyHttp || undefined,
    startedFor: () => ({ started: false }),
    filledSoFarFor: () => 0,
    getOutstanding: () => 0,
    pendingQuotes: new Map(),
  });

  try {
    const { statusCode } = await kalshiSigned('GET', '/trade-api/v2/exchange/status');
    const offset = clockOffset();
    console.log(`[${MODE}] connection warm ok status=${statusCode} clockOffset=${offset}ms`);
  } catch (e) {
    console.error(`[${MODE}] connection warm failed`, e && e.message);
  }

  const client = createKalshiWs({
    keyId: KEY_ID,
    pem: PEM,
    onStatus: (s, info) => console.log(`[${MODE}] ws:${s}`, info || ''),
    onRfqCreated: (rfq, env) => {
      try { onKalshiRfq(rfq, env); } catch (e) { console.error('[UNHEDGED] onRfq', e && e.message); }
    },
    onRfqDeleted: (evt, env) => {
      try { onKalshiClosed(evt, env); } catch (e) { console.error('[UNHEDGED] onRfqDeleted', e && e.message); }
    },
  });

  setInterval(() => {
    const h = client.health ? client.health() : null;
    const age = h && h.lastCommAt ? Date.now() - h.lastCommAt : null;
    console.log(`[${MODE}] tallies`, { ...counts, kalshiWsAgeMs: age, kalshiWsStallMs: h && h.stallMs });
  }, 60000);

  process.on('SIGINT', () => {
    client.stop();
    try { poly && poly.stop && poly.stop(); } catch (_) {}
    try { unhedged && unhedged.stop(); } catch (_) {}
    try { kalshiHttp.close(); } catch (_) {}
    console.log(`[${MODE}] final`, counts);
    process.exit(0);
  });
  client.start();
}

if (require.main === module) {
  main();
}

module.exports = {
  MODE,
  onKalshiRfq,
  onKalshiClosed,
  considerKalshiUnhedged,
  main,
};
