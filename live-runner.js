// ─────────────────────────────────────────────────────────────────────────
// live-runner.js — LIVE worker (latency-optimized)
//
// ACCOUNTING: POST → 'quoted'. Filled advances on quote_executed.
// RESERVE: outstanding live quotes (pendingQuotes + in-flight POST) count against
//   remaining so parallel RFQs cannot all clear the same ceiling.
//   remaining = max - filled - outstanding.
//   Polymarket Retail RFQ (polymarket-rfq.js) shares this ceiling via
//   polyPendingQuotes + outstandingFor — Kalshi yes_bid / dollar RFQ math is unchanged.
//   Released on fill, cancel, POST fail, rfq_deleted, or 20s unaccepted DELETE.
// PARTIAL-FILL: d.locks is informational; post while ceiling remains.
// LATENCY: Steps 0–4 — instrument, POST first, undici keep-alive, pre-stage.
// START GATE: never quote (and cancel open quotes) once any leg's start <= now.
//   Started still wins; the cap is a second gate.
//   Polymarket confirm + resting-quote cancel uses the same startedFor /
//   findStartedEvent (polymarket-rfq.js) — date-only PM slugs are not starts.
// SKIP TAPE: oversized / limit_reached skips persist a distinct reason on
//   combo_submissions, then one RFQ+ticker tape lookup after close (or pad).
//   Quote-watcher stays parked. We do not write combo_matches or watcher_debug.
// UNHEDGED SHADOW: unmatched in-scope MLB/NFL ML combos persist to
//   unhedged_rfqs (UNHEDGED_RFQ_SHADOW, default on). Never POSTs. Combo Locks
//   match / reserve / quote path is unchanged. Fair is inverse-bet ourTrue:
//   opponent YES → fee-included American (series taker: MLB 0.035, NFL 0.07,
//   Poly 0.06), best Kalshi/Poly, then sign-flip (not same-side last,
//   not Odds API). Combo WRAP is separate (NFL maker 0; else 0.035).
//   Lookups stay sync off the 4s in-memory cache. UNHEDGED_RFQ_LIVE stays off.
//   Started/live RFQs (findStartedEvent) are a silent skip — no insert, no
//   fill patch. When a persisted pregame row later fills (WS/REST leave-open
//   or one-shot tape after 45s pad), UPDATE status=filled. NCAAF is out of scope.
//
// Env: KALSHI_KEY_ID, Kalshi_combo_key, SUPABASE_URL, SUPABASE_SERVICE_KEY
//      TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID (optional)
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { Client } = require('undici');
const { createKalshiWs } = require('./kalshi-ws');
const { normalizePem, authHeaders } = require('./kalshi-auth');
const { matchParlay } = require('./rfq');
const { decideAtFill, fillView, buildQuoteBody, shouldPostQuote, isSilentQuoteFailure, YES_DECLINE, impliedYesBid, quoteYesBid, shouldConfirmAccept, contractsFromQuoteResponse } = require('./engine');
const { findStartedEvent } = require('./started');
const {
  RESERVE_TTL_MS,
  sumOutstanding,
  wouldExceedCap,
  isCapExhausted,
  isReserveKey,
  dropPendingForRfq,
  listStaleUnaccepted,
} = require('./reserve');
const { startHeartbeat } = require('./heartbeat');
const { startPolymarketRfqLoop } = require('./polymarket-rfq');
const { shortId } = require('./short-id');
const {
  classifySkip,
  skipPersistExtra,
  isSkipTapeEligible,
  resolveSkipTape,
} = require('./skip-tape');
const {
  isUnhedgedRfqShadow,
  isUnhedgedRfqLive,
  persistUnhedgedRfq,
  shadowUnhedgedMiss,
  createUnhedgedFillTracker,
} = require('./unhedged-rfq');
const { createUnhedgedPriceCache } = require('./unhedged-price-cache');

const MODE = 'LIVE';
const KEY_ID = process.env.KALSHI_KEY_ID;
const PEM = normalizePem(process.env.Kalshi_combo_key || process.env.KALSHI_PRIVATE_KEY || '');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Step 2 — one persistent HTTP client (warm socket)
const kalshiHttp = new Client('https://external-api.kalshi.com', {
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
});
const QUOTE_PATH = '/trade-api/v2/communications/quotes';
const WARM_PATH = '/trade-api/v2/exchange/status';
const cancelingQuotes = new Set();
const cancelledQuotes = new Set();
const confirmingQuotes = new Set(); // de-dupe accept + skip 20s TTL during confirm
let reserveSeq = 0;

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_ALERT_CHAT_ID;

async function sendAlert(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log(`[${MODE}] ALERT (telegram not configured): ${text.replace(/\n/g, ' | ')}`);
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text }),
    });
    if (!r.ok) console.error(`[${MODE}] telegram send failed`, r.status, await r.text());
  } catch (e) {
    console.error(`[${MODE}] telegram error`, e.message);
  }
}
const sgn = (n) => (n > 0 ? '+' + n : '' + n);

let parlays = [];
let killByUser = {};
let filledByParlay = {};
let sessionFilledByParlay = {};
const pendingQuotes = new Map();
const polyPendingQuotes = new Map();
let polyLoop = null;
let unhedgedPrices = null;

function outstandingFor(parlayId, excludeQuoteId) {
  return sumOutstanding(pendingQuotes, parlayId, excludeQuoteId)
    + sumOutstanding(polyPendingQuotes, parlayId, excludeQuoteId);
}

// Step 3 — pre-staged quote pieces per parlay (rebuilt every refresh)
// staged[id] = { noBid, yesBid, rest_remainder, fillAmerican, effTaker }
// yesBid stays YES_DECLINE (contract-count decline). Dollar RFQs pick
// implied YES at POST time from the no_bid actually sent — do not use this
// staged 0.00 on that path (Kalshi would derive ~1000 contracts).
let staged = {};

const counts = {
  rfqs: 0, combos: 0, matched: 0, wouldQuote: 0,
  declined: 0, noLock: 0, limitReached: 0,
  posted: 0, postFailed: 0, dollarRfqs: 0, filled: 0,
  tapeMatched: 0, tapeNone: 0,
};

const pendingSkipTapes = new Map(); // submission id → skip row awaiting tape
let unhedgedFills = null; // already-persisted unhedged RFQs awaiting fill
const unknownCols = new Set();
const COL_ERR = /Could not find the '([^']+)' column/i;
const SKIP_TAPE_LOOKBACK_MS = 24 * 3600 * 1000;
const SKIP_TAPE_TICK_MS = 15000;
const SKIP_TAPE_MAX_PER_TICK = 5;

async function refresh() {
  try {
    const [{ data: p }, { data: s }, { data: fills }] = await Promise.all([
      supabase.from('combo_parlays').select('*').eq('active', true),
      supabase.from('combo_settings').select('user_id,kill_switch'),
      // Ground truth contracts from Kalshi account fills (not our optimistic submission math).
      supabase.from('combo_fills')
        .select('parlay_id,count')
        .eq('is_combo', true)
        .eq('is_taker', false)
        .not('parlay_id', 'is', null),
    ]);
    parlays = p || [];
    killByUser = {};
    (s || []).forEach((r) => (killByUser[r.user_id] = r.kill_switch));

    filledByParlay = {};
    (fills || []).forEach((r) => {
      filledByParlay[r.parlay_id] = (filledByParlay[r.parlay_id] || 0) + Number(r.count || 0);
    });

    // Pre-stage prices (Step 3)
    const next = {};
    for (const row of parlays) {
      const v = fillView(row.fill_american);
      next[row.id] = {
        noBid: v.noBid,
        yesBid: YES_DECLINE,
        rest_remainder: false,
        fillAmerican: row.fill_american,
        effTaker: v.effTaker,
      };
    }
    staged = next;

    console.log(`[${MODE}] refreshed — ${parlays.length} active parlay(s), staged=${Object.keys(staged).length}`);
    // Do not seed outstanding from combo_submissions — a 2h is_live re-import
    // revived 1309 dead contracts on Cards/Pirates every 30s. WS close + 20s
    // unaccepted DELETE is the reserve clock; unmark stale is_live so a restart
    // cannot re-pin remaining.
    clearStaleLiveSubmissions().catch((e) => console.error(`[${MODE}] clear stale is_live`, e.message));
    cancelStartedQuotes().catch((e) => console.error(`[${MODE}] cancel-on-start refresh`, e.message));
    if (polyLoop && typeof polyLoop.cancelStartedQuotes === 'function') {
      polyLoop.cancelStartedQuotes().catch((e) => console.error(`[${MODE}] poly cancel-on-start refresh`, e.message));
    }
    loadPendingSkipTapes().catch((e) => console.error(`[${MODE}] skip-tape load`, e.message));
  } catch (e) {
    console.error(`[${MODE}] refresh failed`, e.message);
  }
}

// Use the larger of DB fills vs session fills so a restart can't under-count,
// and we don't double-count the same contracts from both sources.
const filledSoFarFor = (id) => Math.max(filledByParlay[id] || 0, sessionFilledByParlay[id] || 0);
const killEngagedFor = (userId) => killByUser[userId] !== false;

// DB check constraint allows: shadow | filled | unfilled | declined.
// Live quotes: status=filled + is_live + no order_id → Combo Locks shows "quoted (awaiting)".
// Executions set order_id. "limitreached" maps to declined.
function normalizeStatus(status) {
  // Posted quotes must NOT use status=filled — that made Combo Locks / any
  // fill-summing logic treat quotes as real fills and pause the parlay when
  // quoted size crossed max_contracts. Real executions still write status=filled
  // with an order_id in onQuoteExecuted.
  if (status === 'quoted') return 'unfilled';
  if (status === 'limitreached') return 'declined';
  return status;
}

function stripUnknown(body) {
  const out = { ...body };
  for (const c of unknownCols) delete out[c];
  return out;
}

// Fire-and-forget log (Step 1 — never on the critical path before POST)
function logAsync(p, rfq, d, status, extra = {}) {
  const contracts =
    extra.contracts != null ? extra.contracts
      : d && d.contracts != null ? d.contracts
        : rfq.contracts != null ? rfq.contracts : null;
  const body = stripUnknown({
    user_id: p.user_id,
    parlay_id: p.id,
    rfq_id: rfq.rfqId,
    label: p.label,
    fill_american: (d && d.fillAmerican != null) ? d.fillAmerican : p.fill_american,
    contracts,
    worst_lock: d ? d.worst : null,
    status: normalizeStatus(status),
    ...extra,
  });
  return supabase.from('combo_submissions').insert(body).select('id').then(({ data, error }) => {
    if (error) {
      const m = String(error.message || '').match(COL_ERR);
      if (m) {
        unknownCols.add(m[1]);
        console.warn(`[${MODE}] combo_submissions missing column ${m[1]} — degrading`);
        return logAsync(p, rfq, d, status, extra);
      }
      console.error(`[${MODE}] log insert failed`, error.message);
      return null;
    }
    return (data && data[0]) || null;
  }).catch((e) => {
    console.error(`[${MODE}] log insert failed`, e.message);
    return null;
  });
}

function trackSkipTape(row, extra, p, rfq) {
  if (!row || !row.id || !extra || !extra.skip_reason) return;
  if (pendingSkipTapes.has(row.id)) return;
  pendingSkipTapes.set(row.id, {
    id: row.id,
    parlay_id: p.id,
    rfq_id: rfq.rfqId,
    contracts: extra.contracts != null ? extra.contracts : rfq.contracts,
    remaining: extra.remaining,
    skip_reason: extra.skip_reason,
    market_ticker: extra.market_ticker || rfq.marketTicker || null,
    created_at: new Date().toISOString(),
    tape_match: null,
  });
}

function logSkip(p, rfq, d, status, size) {
  const skipReason = classifySkip(d);
  const extra = skipPersistExtra({
    skipReason,
    contracts: size && size.contracts != null ? size.contracts : rfq.contracts,
    remaining: d && d.remaining != null ? d.remaining : null,
    marketTicker: rfq.marketTicker,
  });
  logAsync(p, rfq, d, status, extra).then((row) => trackSkipTape(row, extra, p, rfq));
}

async function postQuote(rfqId, noBid, yesBid = YES_DECLINE, restRemainder) {
  const body = JSON.stringify(buildQuoteBody(rfqId, noBid, yesBid, restRemainder));
  const headers = {
    'Content-Type': 'application/json',
    ...authHeaders({ keyId: KEY_ID, pem: PEM, method: 'POST', signPath: QUOTE_PATH }),
  };
  const { statusCode, body: resBody } = await kalshiHttp.request({
    path: QUOTE_PATH,
    method: 'POST',
    headers,
    body,
  });
  const text = await resBody.text();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Kalshi quote failed ${statusCode}: ${text}`);
  }
  return JSON.parse(text); // { id: quote_id }
}

// Kalshi RFQ: after quote_accepted the maker must confirm within the window
// (combos/HVM ≈ 3s) or the trade never executes.
function confirmPath(rfqId, quoteId) {
  return `/trade-api/v2/communications/rfqs/${rfqId}/quotes/${quoteId}/confirm`;
}

function cancelPath(quoteId) {
  return `/trade-api/v2/communications/quotes/${quoteId}`;
}

async function cancelQuote(quoteId) {
  const path = cancelPath(quoteId);
  const headers = {
    ...authHeaders({ keyId: KEY_ID, pem: PEM, method: 'DELETE', signPath: path }),
  };
  const { statusCode, body: resBody } = await kalshiHttp.request({
    path,
    method: 'DELETE',
    headers,
  });
  const text = await resBody.text();
  // 204 = deleted. 404 = already gone (RFQ closed / already cancelled).
  if (statusCode === 204 || statusCode === 404) return { statusCode };
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Kalshi cancel failed ${statusCode}: ${text}`);
  }
  return { statusCode };
}

function parlayFromPending(pending) {
  if (!pending) return null;
  const live = parlays.find((x) => x.id === pending.parlayId);
  if (live) return live;
  return {
    id: pending.parlayId,
    label: pending.label,
    starts_at: pending.starts_at,
    legs: pending.legs,
    leg_keys: pending.leg_keys,
  };
}

function startedForParlay(p, rfq, extra) {
  return findStartedEvent(rfq || null, p, extra);
}

function pendingEntry(p, rfq, contracts, extra) {
  return {
    parlayId: p.id,
    userId: p.user_id,
    contracts,
    label: p.label,
    rfqId: rfq && rfq.rfqId,
    starts_at: p.starts_at,
    legs: p.legs,
    leg_keys: p.leg_keys || p.legKeys,
    maxContracts: p.max_contracts,
    yesBid: extra && extra.yesBid != null ? extra.yesBid : undefined,
    postedAt: extra && extra.postedAt != null ? extra.postedAt : Date.now(),
  };
}

// Cancel leftovers only — not a reserve seed. Window matches TTL so hours-old
// is_live rows cannot re-enter the cancel path as if they were still live.
async function loadOpenSubmissionQuotes() {
  const cutoff = new Date(Date.now() - RESERVE_TTL_MS).toISOString();
  try {
    const { data, error } = await supabase
      .from('combo_submissions')
      .select('quote_id,parlay_id,label,rfq_id,contracts,user_id,created_at')
      .eq('is_live', true)
      .is('order_id', null)
      .not('quote_id', 'is', null)
      .gte('created_at', cutoff);
    if (error) {
      console.error(`[${MODE}] open submissions`, error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.error(`[${MODE}] open submissions`, e.message);
    return [];
  }
}

async function clearStaleLiveSubmissions() {
  const cutoff = new Date(Date.now() - RESERVE_TTL_MS).toISOString();
  try {
    const { data, error } = await supabase
      .from('combo_submissions')
      .update({ is_live: false })
      .eq('is_live', true)
      .is('order_id', null)
      .not('quote_id', 'is', null)
      .lte('created_at', cutoff)
      .select('quote_id,contracts,label');
    if (error) {
      console.error(`[${MODE}] clear stale is_live`, error.message);
      return;
    }
    const rows = data || [];
    if (!rows.length) return;
    const contracts = rows.reduce((n, r) => n + Number(r.contracts || 0), 0);
    console.log(
      `[${MODE}] RESERVE RELEASED stale-db count=${rows.length} contracts=${contracts}`
    );
  } catch (e) {
    console.error(`[${MODE}] clear stale is_live`, e.message);
  }
}

function cancelLogLine(quoteId, pending, reason) {
  const label = (pending && pending.label) || '(unknown)';
  const rfqBit = pending && pending.rfqId ? ` rfq=${pending.rfqId}` : '';
  if (reason && reason.started) {
    return (
      `[${MODE}] CANCEL game started ${label} quote_id=${quoteId}` +
      rfqBit +
      ` source=${reason.source} at=${reason.at}`
    );
  }
  if (reason && reason.kind === 'cap_full') {
    return (
      `[${MODE}] CANCEL leftover ${label} quote_id=${quoteId}` +
      rfqBit +
      ` filled=${reason.filled}/${reason.max}`
    );
  }
  if (reason && reason.kind === 'cap_exceeded') {
    return (
      `[${MODE}] CANCEL cap exceeded ${label} quote_id=${quoteId}` +
      rfqBit +
      ` filled=${reason.filled} reserved=${reason.reserved} want=${reason.want} max=${reason.max}`
    );
  }
  if (reason && reason.kind === 'yes_accept') {
    return (
      `[${MODE}] CANCEL yes accept ${label} quote_id=${quoteId}` +
      rfqBit +
      ` side=${reason.side || 'yes'}`
    );
  }
  if (reason && reason.kind === 'ttl') {
    return (
      `[${MODE}] CANCEL unaccepted ${label} quote_id=${quoteId}` +
      rfqBit +
      (reason.age != null ? ` age=${reason.age}ms` : '')
    );
  }
  return `[${MODE}] CANCEL ${label} quote_id=${quoteId}` + rfqBit;
}

function markSubmissionNotLive(quoteId) {
  if (!quoteId || isReserveKey(quoteId)) return;
  supabase.from('combo_submissions').update({ is_live: false }).eq('quote_id', quoteId)
    .then(({ error }) => {
      if (error) console.error(`[${MODE}] clear is_live`, error.message);
    })
    .catch((e) => console.error(`[${MODE}] clear is_live`, e.message));
}

function noteReleased(quoteId, pending, reason) {
  if (quoteId && !isReserveKey(quoteId)) {
    cancelledQuotes.add(quoteId);
    markSubmissionNotLive(quoteId);
  }
  const label = (pending && pending.label) || '(unknown)';
  const rfqBit = pending && pending.rfqId ? ` rfq=${pending.rfqId}` : '';
  const n = pending && pending.contracts != null ? pending.contracts : '';
  const age = pending && pending.postedAt != null ? ` age=${Date.now() - pending.postedAt}ms` : '';
  console.log(
    `[${MODE}] RESERVE RELEASED ${reason} ${label} quote_id=${quoteId}${rfqBit} contracts=${n}${age}`
  );
}

function persistUnhedgedRow(row) {
  if (unhedgedFills) unhedgedFills.remember(row);
  return persistUnhedgedRfq(supabase, row).then((out) => {
    if (out && out.alreadyFilled && unhedgedFills) {
      unhedgedFills.remember({ venue: row.venue, rfq_id: row.rfq_id, status: 'filled' });
    }
    return out;
  });
}

function onRfqDeleted(evt, env) {
  const rfqId = evt && evt.rfqId;
  if (!rfqId) return;
  const dropped = dropPendingForRfq(pendingQuotes, rfqId, { confirming: confirmingQuotes });
  for (const { id, quote } of dropped) {
    noteReleased(id, quote, 'closed');
  }
  if (unhedgedFills && rfqId) {
    unhedgedFills.onClosed({
      venue: 'kalshi',
      rfqId,
      extra: env,
      rfq: evt,
    }).catch((e) => console.error('[UNHEDGED] fill close', e && e.message));
  }
}

async function cancelUnacceptedQuotes(now = Date.now()) {
  const stale = listStaleUnaccepted(pendingQuotes, now, RESERVE_TTL_MS, {
    confirming: confirmingQuotes,
  });
  for (const { id } of stale) {
    const live = pendingQuotes.get(id);
    if (!live || live.accepted || confirmingQuotes.has(id)) continue;
    const posted = live.postedAt;
    const age = posted != null ? now - posted : null;
    await cancelQuoteAndDrop(id, live, { kind: 'ttl', age });
  }
}

async function cancelQuoteAndDrop(quoteId, pending, reason) {
  if (!quoteId) return;
  if (isReserveKey(quoteId)) {
    pendingQuotes.delete(quoteId);
    return;
  }
  if (cancelingQuotes.has(quoteId) || cancelledQuotes.has(quoteId)) return;
  cancelingQuotes.add(quoteId);
  const label = (pending && pending.label) || '(unknown)';
  const failKind = (reason && reason.started) ? 'game started' : (reason && reason.kind) || '';
  try {
    await cancelQuote(quoteId);
    pendingQuotes.delete(quoteId);
    cancelledQuotes.add(quoteId);
    markSubmissionNotLive(quoteId);
    console.log(cancelLogLine(quoteId, pending, reason));
  } catch (e) {
    console.error(
      `[${MODE}] CANCEL FAILED ${failKind} ${label} quote_id=${quoteId}`,
      e.message
    );
  } finally {
    cancelingQuotes.delete(quoteId);
  }
}

async function cancelOpenQuotesForParlay(parlayId, started, extras) {
  const seen = new Set();
  for (const [quoteId, pending] of pendingQuotes) {
    if (pending.parlayId !== parlayId) continue;
    seen.add(quoteId);
    await cancelQuoteAndDrop(quoteId, pending, started);
  }
  for (const row of extras || []) {
    if (!row || !row.quote_id || seen.has(row.quote_id) || cancelledQuotes.has(row.quote_id)) continue;
    await cancelQuoteAndDrop(row.quote_id, {
      label: row.label,
      rfqId: row.rfq_id,
      parlayId,
    }, started);
  }
}

async function cancelCapLeftovers(parlayId, info) {
  const extras = (await loadOpenSubmissionQuotes()).filter((r) => r.parlay_id === parlayId);
  await cancelOpenQuotesForParlay(parlayId, { kind: 'cap_full', ...info }, extras);
}

async function cancelPendingIfStarted() {
  for (const [quoteId, pending] of pendingQuotes) {
    const p = parlayFromPending(pending);
    const started = startedForParlay(p);
    if (started.started) await cancelQuoteAndDrop(quoteId, pending, started);
  }
}

async function cancelStartedQuotes() {
  await cancelPendingIfStarted();

  const startedParlays = parlays
    .map((p) => ({ p, started: startedForParlay(p) }))
    .filter((x) => x.started.started);
  if (!startedParlays.length) return;

  const extras = await loadOpenSubmissionQuotes();

  for (const { p, started } of startedParlays) {
    const rows = extras.filter((r) => r.parlay_id === p.id);
    await cancelOpenQuotesForParlay(p.id, started, rows);
  }
}

async function confirmQuote(rfqId, quoteId) {
  const path = confirmPath(rfqId, quoteId);
  // Kalshi rejects PUTs without an explicit JSON content-type (400 invalid_content_type),
  // even when the body is empty — send {} + application/json.
  const body = '{}';
  const headers = {
    'Content-Type': 'application/json',
    ...authHeaders({ keyId: KEY_ID, pem: PEM, method: 'PUT', signPath: path }),
  };
  const { statusCode, body: resBody } = await kalshiHttp.request({
    path,
    method: 'PUT',
    headers,
    body,
  });
  const text = await resBody.text();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Kalshi confirm failed ${statusCode}: ${text}`);
  }
  return { statusCode };
}

async function warmConnection() {
  try {
    const headers = {
      ...authHeaders({ keyId: KEY_ID, pem: PEM, method: 'GET', signPath: WARM_PATH }),
    };
    const { statusCode, body } = await kalshiHttp.request({
      path: WARM_PATH,
      method: 'GET',
      headers,
    });
    await body.text();
    console.log(`[${MODE}] connection warm ok status=${statusCode}`);
  } catch (e) {
    console.error(`[${MODE}] connection warm failed`, e.message);
  }
}

async function kalshiGet(path, query) {
  const headers = {
    ...authHeaders({ keyId: KEY_ID, pem: PEM, method: 'GET', signPath: path }),
  };
  const fullPath = query ? `${path}?${query}` : path;
  const { statusCode, body } = await kalshiHttp.request({
    path: fullPath,
    method: 'GET',
    headers,
  });
  const text = await body.text();
  if (statusCode === 404) return { statusCode, json: null };
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Kalshi GET ${path} ${statusCode}: ${text}`);
  }
  return { statusCode, json: text ? JSON.parse(text) : null };
}

async function fetchSkipRfq(rfqId) {
  const { statusCode, json } = await kalshiGet(`/trade-api/v2/communications/rfqs/${rfqId}`);
  if (statusCode === 404 || !json) return null;
  return json.rfq || json;
}

async function fetchSkipTrades(ticker, minTs, maxTs) {
  const qs = new URLSearchParams({
    ticker: String(ticker),
    min_ts: String(minTs),
    max_ts: String(maxTs),
    limit: '100',
  });
  const { json } = await kalshiGet('/trade-api/v2/markets/trades', qs.toString());
  return (json && json.trades) || [];
}

async function persistSkipTape(id, patch) {
  const body = stripUnknown(patch);
  if (!Object.keys(body).length) return;
  const { error } = await supabase.from('combo_submissions').update(body).eq('id', id);
  if (!error) return;
  const m = String(error.message || '').match(COL_ERR);
  if (m) {
    unknownCols.add(m[1]);
    console.warn(`[${MODE}] combo_submissions missing column ${m[1]} — degrading`);
    return persistSkipTape(id, patch);
  }
  console.error(`[${MODE}] skip-tape persist`, error.message);
}

async function loadPendingSkipTapes() {
  const live = parlays.filter((p) => !startedForParlay(p).started);
  if (!live.length) return;
  const cutoff = new Date(Date.now() - SKIP_TAPE_LOOKBACK_MS).toISOString();
  let q = supabase
    .from('combo_submissions')
    .select('id,parlay_id,rfq_id,contracts,remaining,skip_reason,market_ticker,created_at,tape_match')
    .in('parlay_id', live.map((p) => p.id))
    .in('skip_reason', ['oversized', 'limit_reached'])
    .is('tape_match', null)
    .gte('created_at', cutoff)
    .limit(50);
  const { data, error } = await q;
  if (error) {
    const m = String(error.message || '').match(COL_ERR);
    if (m) {
      unknownCols.add(m[1]);
      console.warn(`[${MODE}] combo_submissions missing column ${m[1]} — skip-tape idle`);
      return;
    }
    console.error(`[${MODE}] skip-tape load`, error.message);
    return;
  }
  for (const row of data || []) {
    if (!row || !row.id || pendingSkipTapes.has(row.id)) continue;
    pendingSkipTapes.set(row.id, row);
  }
}

async function reconcileSkipTapes() {
  if (!pendingSkipTapes.size) return; // idle — no skipped RFQs waiting
  const now = Date.now();
  const byId = new Map(parlays.map((p) => [p.id, p]));
  const live = parlays.filter((p) => !startedForParlay(p).started);
  if (!live.length) {
    pendingSkipTapes.clear(); // stop looking; do not guess tape_match=none
    return;
  }

  let looked = 0;
  for (const [id, row] of pendingSkipTapes) {
    const p = byId.get(row.parlay_id);
    const started = p ? startedForParlay(p) : { started: true };
    const eligible = isSkipTapeEligible({
      skipReason: row.skip_reason,
      tapeMatch: row.tape_match,
      parlayActive: !!p,
      started: started.started,
      now,
      startsAt: p && p.starts_at,
    });

    if (!eligible) {
      pendingSkipTapes.delete(id);
      continue;
    }

    if (looked >= SKIP_TAPE_MAX_PER_TICK) continue;
    looked++;
    try {
      const out = await resolveSkipTape(row, {
        fetchRfq: fetchSkipRfq, fetchTrades: fetchSkipTrades, now,
      });
      if (out.retry) {
        if (out.error) console.error(`[${MODE}] skip-tape`, row.rfq_id, out.error.message);
        continue;
      }
      await persistSkipTape(id, out.patch);
      if (out.patch.tape_match === 'matched') counts.tapeMatched++;
      else counts.tapeNone++;
      console.log(
        `[${MODE}] skip-tape ${out.patch.tape_match} rfq=${row.rfq_id} ` +
        `ticker=${out.patch.market_ticker || row.market_ticker || '(none)'} ` +
        `reason=${row.skip_reason}` +
        (out.patch.tape_match === 'matched'
          ? ` yes=${out.patch.tape_yes_price} no=${out.patch.tape_no_price}`
          : '')
      );
      pendingSkipTapes.delete(id);
    } catch (e) {
      console.error(`[${MODE}] skip-tape`, row.rfq_id, e.message);
    }
  }
}

function resolveRfqContracts(rfq, fillAmerican, stagedNoBid) {
  if (rfq.contracts != null && rfq.contracts > 0) {
    return { contracts: rfq.contracts, source: 'contracts' };
  }
  if (rfq.targetCostDollars != null && rfq.targetCostDollars > 0) {
    const noBid = stagedNoBid != null
      ? parseFloat(stagedNoBid)
      : parseFloat(fillView(fillAmerican).noBid);
    const implied = impliedYesBid(noBid);
    const yesPrice = implied ? parseFloat(implied) : Math.max(0.01, 1 - noBid);
    const estimated = Math.floor(rfq.targetCostDollars / yesPrice);
    return {
      contracts: Math.max(1, estimated),
      source: 'dollar',
      targetCost: rfq.targetCostDollars,
      estimated,
    };
  }
  return { contracts: null, source: 'none' };
}

async function onQuoteAccepted(evt) {
  const t0 = performance.now();
  let quoteId = evt && evt.quoteId;
  let rfqId = evt && evt.rfqId;
  const pending = quoteId ? pendingQuotes.get(quoteId) : null;
  if (pending) pending.accepted = true; // do not TTL-cancel during the 3s confirm window
  if (!rfqId && pending) rfqId = pending.rfqId;
  if (!quoteId || !rfqId) {
    console.error(
      `[${MODE}] quote_accepted missing ids quote_id=${quoteId || '(none)'} rfq_id=${rfqId || '(none)'}`
    );
    return;
  }
  if (confirmingQuotes.has(quoteId)) {
    console.log(`[${MODE}] confirm already in-flight quote_id=${quoteId}`);
    return;
  }
  confirmingQuotes.add(quoteId);
  try {
    // Two-sided dollar quotes: only confirm NO. YES accept would buy the parlay.
    // Contract-count quotes send yes_bid "0.00" — YES cannot be accepted; confirm as today.
    if (pending && !shouldConfirmAccept(pending.yesBid, evt.acceptedSide)) {
      console.log(
        `[${MODE}] CONFIRM SKIPPED yes accept quote_id=${quoteId} rfq_id=${rfqId} ` +
        `side=${evt.acceptedSide || '?'} yes_bid=${pending.yesBid} ` +
        `label=${pending.label}`
      );
      await cancelQuoteAndDrop(quoteId, pending, {
        kind: 'yes_accept',
        side: evt.acceptedSide || 'yes',
      });
      return;
    }
    const parlay = parlayFromPending(pending);
    const started = parlay ? startedForParlay(parlay) : { started: false };
    if (started.started) {
      console.log(
        `[${MODE}] CONFIRM SKIPPED game started quote_id=${quoteId} rfq_id=${rfqId} ` +
        `label=${pending ? pending.label : '(unknown)'} source=${started.source} at=${started.at}`
      );
      cancelQuoteAndDrop(quoteId, pending, started).catch(() => {});
      return;
    }
    const maxContracts = (parlay && parlay.max_contracts) || (pending && pending.maxContracts);
    const filledSoFar = pending ? filledSoFarFor(pending.parlayId) : 0;
    const outstandingOthers = pending
      ? outstandingFor(pending.parlayId, quoteId)
      : 0;
    const want = pending && pending.contracts;
    if (pending && wouldExceedCap(maxContracts, filledSoFar, outstandingOthers, want)) {
      console.log(
        `[${MODE}] CONFIRM SKIPPED cap exceeded quote_id=${quoteId} rfq_id=${rfqId} ` +
        `label=${pending.label} filled=${filledSoFar} reserved=${outstandingOthers} ` +
        `want=${want} max=${maxContracts}`
      );
      await cancelQuoteAndDrop(quoteId, pending, {
        kind: 'cap_exceeded',
        filled: filledSoFar,
        reserved: outstandingOthers,
        want,
        max: maxContracts,
      });
      return;
    }
    // Confirm FIRST — HVM confirmation window is ~3s. Log/Telegram after.
    await confirmQuote(rfqId, quoteId);
    const ms = (performance.now() - t0).toFixed(1);
    console.log(
      `[${MODE}] CONFIRMED quote_id=${quoteId} rfq_id=${rfqId} in ${ms}ms ` +
      `side=${evt.acceptedSide || '?'} label=${pending ? pending.label : '(unknown)'}`
    );
  } catch (e) {
    console.error(`[${MODE}] CONFIRM FAILED quote_id=${quoteId} rfq_id=${rfqId}`, e.message);
    sendAlert(
      `❌ CONFIRM FAILED — ${pending ? pending.label : shortId(quoteId)}\n` +
      `quote ${shortId(quoteId)} · rfq ${shortId(rfqId)}\n` +
      `${e.message}`
    ).catch(() => {});
  } finally {
    confirmingQuotes.delete(quoteId);
  }
}

async function onQuoteExecuted(evt) {
  const { quoteId, orderId } = evt;
  if (!quoteId) return;

  const pending = pendingQuotes.get(quoteId);
  if (!pending) {
    console.log(`[${MODE}] quote_executed unknown quote_id=${quoteId} order_id=${orderId}`);
    return;
  }

  const contracts = pending.contracts;
  try {
    // Prefer update; if the post-time insert never landed, insert a filled row.
    const { data: updated, error } = await supabase
      .from('combo_submissions')
      .update({ status: 'filled', order_id: orderId || null, is_live: true })
      .eq('quote_id', quoteId)
      .select('id');
    if (error) console.error(`[${MODE}] update filled failed`, error.message);
    if (!updated || !updated.length) {
      const { error: insErr } = await supabase.from('combo_submissions').insert({
        user_id: pending.userId,
        parlay_id: pending.parlayId,
        rfq_id: pending.rfqId,
        label: pending.label,
        contracts,
        status: 'filled',
        quote_id: quoteId,
        order_id: orderId || null,
        is_live: true,
      });
      if (insErr) console.error(`[${MODE}] insert filled failed`, insErr.message);
    }

    // Combo Locks "Filled — awaiting settlement" keys off combo_fills.
    const fillId = orderId || quoteId;
    const { error: fillErr } = await supabase.from('combo_fills').upsert({
      fill_id: fillId,
      order_id: orderId || null,
      parlay_id: pending.parlayId,
      count: contracts,
      is_combo: true,
      is_taker: false,
      outcome_side: 'no',
      action: 'sell',
      kalshi_created_time: new Date().toISOString(),
      raw: { source: 'live-runner', quote_id: quoteId, rfq_id: pending.rfqId, label: pending.label },
    }, { onConflict: 'fill_id' });
    if (fillErr) console.error(`[${MODE}] combo_fills upsert failed`, fillErr.message);
  } catch (e) {
    console.error(`[${MODE}] onQuoteExecuted DB error`, e.message);
  }

  sessionFilledByParlay[pending.parlayId] =
    (sessionFilledByParlay[pending.parlayId] || 0) + contracts;
  pendingQuotes.delete(quoteId);
  counts.filled++;

  const sessionTotal = sessionFilledByParlay[pending.parlayId];
  const parlay = parlays.find((x) => x.id === pending.parlayId);
  const ceiling = (parlay && parlay.max_contracts > 0)
    ? Number(parlay.max_contracts)
    : (pending.maxContracts > 0 ? Number(pending.maxContracts) : null);
  const filledNow = filledSoFarFor(pending.parlayId);
  const fullyFilled = isCapExhausted(ceiling, filledNow);

  // Full hedge → stop matching this parlay. Combo Locks still lists it; combo_fills moves it to Filled.
  if (fullyFilled) {
    try {
      const { error: deactErr } = await supabase
        .from('combo_parlays')
        .update({ active: false })
        .eq('id', pending.parlayId);
      if (deactErr) console.error(`[${MODE}] deactivate failed`, deactErr.message);
      else {
        parlays = parlays.filter((x) => x.id !== pending.parlayId);
        delete staged[pending.parlayId];
        console.log(`[${MODE}] FULL FILL — deactivated ${pending.label} (${sessionTotal}/${ceiling})`);
      }
    } catch (e) {
      console.error(`[${MODE}] deactivate error`, e.message);
    }
    cancelCapLeftovers(pending.parlayId, { filled: filledNow, max: ceiling }).catch((e) => {
      console.error(`[${MODE}] cancel leftover`, e.message);
    });
  }

  console.log(
    `[${MODE}] FILL CONFIRMED ${pending.label} quote_id=${quoteId} order_id=${orderId} ` +
    `contracts=${contracts} sessionTotal=${sessionTotal}` +
    (fullyFilled ? ' FULL' : '')
  );
  sendAlert(
    `✅ FILL CONFIRMED — ${pending.label}\n` +
    `order ${orderId ? shortId(orderId) : '(none)'} · quote ${shortId(quoteId)}\n` +
    `+${contracts} contracts` +
    (fullyFilled
      ? ` · FULL ${sessionTotal}/${ceiling} — stopped quoting`
      : ` · session ${sessionTotal}${ceiling != null ? '/' + ceiling : ''}`)
  ).catch(() => {});
}

async function onRfq(rfq, env) {
  const t0 = performance.now(); // Step 0
  counts.rfqs++;

  // Step 4 — cheapest rejects first
  if (!rfq.isCombo) return;
  if (rfq.contracts == null && (rfq.targetCostDollars == null || !(rfq.targetCostDollars > 0))) {
    return;
  }
  counts.combos++;

  const p = matchParlay(rfq, parlays);
  if (!p) {
    // Combo Locks miss — shadow in-scope unhedged RFQs only. Never quotes.
    shadowUnhedgedMiss(rfq, {
      venue: 'kalshi',
      extra: env && env.msg ? { msg: env.msg } : null,
      persist: persistUnhedgedRow,
      supabase,
      env: process.env,
      priceCache: unhedgedPrices,
      onPersisted: (row) => { if (unhedgedFills) unhedgedFills.remember(row); },
    });
    return;
  }
  counts.matched++;

  const started = startedForParlay(p, rfq, env && env.msg ? { msg: env.msg } : null);
  if (started.started) {
    counts.declined++;
    console.log(
      `[${MODE}] SKIP game started ${p.label} rfq=${rfq.rfqId} ` +
      `source=${started.source} at=${started.at}`
    );
    logAsync(p, rfq, null, 'declined');
    cancelOpenQuotesForParlay(p.id, started).catch((e) => {
      console.error(`[${MODE}] cancel-on-start`, e.message);
    });
    return;
  }

  const engaged = killEngagedFor(p.user_id);
  const filledSoFar = filledSoFarFor(p.id);
  const outstanding = outstandingFor(p.id);
  const st = staged[p.id];

  const size = resolveRfqContracts(rfq, p.fill_american, st && st.noBid);
  if (size.source === 'dollar') counts.dollarRfqs++;
  if (!shouldPostQuote(size)) {
    counts.declined++;
    if (size.source === 'dollar' || (size.source === 'none' && rfq.targetCostDollars > 0)) {
      console.log(
        `[${MODE}] SKIP dollar RFQ ${p.label} rfq=${rfq.rfqId} ` +
        `target=$${size.targetCost != null ? size.targetCost : rfq.targetCostDollars} — unresolvable size`
      );
    }
    logAsync(p, rfq, null, 'declined');
    return;
  }

  const d = decideAtFill({
    parlayStake: p.parlay_stake,
    parlayAmerican: p.parlay_american,
    fillAmerican: p.fill_american,
    fairAmerican: p.fair_american,
    rfqContracts: size.contracts,
    hedgeMode: p.hedge_mode || '1x',
    maxContracts: p.max_contracts,
    filledSoFar,
    outstanding,
  });

  if (!d.ok) {
    if (d.reason === 'limit_reached') {
      counts.limitReached++;
      console.log(
        `[${MODE}] LIMIT REACHED ${p.label} rfq=${rfq.rfqId} — ` +
        `filled=${filledSoFar} reserved=${outstanding} ${filledSoFar + outstanding}/${d.totalLimit}`
      );
      logSkip(p, rfq, d, 'limitreached', size);
      // No Telegram — every post-ceiling RFQ would spam. Console above is enough.
      if (isCapExhausted(p.max_contracts, filledSoFar)) {
        cancelCapLeftovers(p.id, { filled: filledSoFar, max: d.totalLimit }).catch((e) => {
          console.error(`[${MODE}] cancel leftover`, e.message);
        });
      }
      return;
    }
    counts.declined++;
    if (d.reason === 'rfq_too_large') {
      console.log(
        `[${MODE}] SKIP oversized RFQ ${p.label} rfq=${rfq.rfqId} ` +
        `want=${size.contracts} remaining=${d.remaining}/${d.totalLimit} ` +
        `filled=${filledSoFar} reserved=${outstanding}`
      );
      logSkip(p, rfq, d, 'declined', size);
      return;
    }
    logAsync(p, rfq, null, 'declined');
    return;
  }

  // Section 18 — locks informational only
  if (!d.locks) {
    counts.noLock++;
    console.log(`[${MODE}] NO-LOCK (posting) ${p.label} rfq=${rfq.rfqId} worst=$${d.worst}`);
  }

  counts.wouldQuote++;
  const t1 = performance.now(); // after match + price

  // Prefer pre-staged NO price. Dollar yes_bid is implied YES of that NO —
  // never the staged / decideAtFill "0.00" (Kalshi would size off 1¢ YES).
  const noBid = (st && st.noBid) || d.quote.no_bid;
  const yesBid = quoteYesBid(size.source, noBid);
  const restRemainder = (st && st.rest_remainder != null) ? st.rest_remainder : d.quote.rest_remainder;

  // ─── LIVE POST first (Step 1) ─────────────────────────────────────────
  if (!engaged) {
    // Reserve BEFORE the await so a parallel RFQ sees this size in outstanding.
    const reserveKey = `reserve:${++reserveSeq}`;
    pendingQuotes.set(reserveKey, pendingEntry(p, rfq, d.contracts, { yesBid }));
    const t2 = performance.now();
    try {
      const result = await postQuote(rfq.rfqId, noBid, yesBid, restRemainder);
      const t3 = performance.now();
      const reservedContracts = size.source === 'dollar'
        ? contractsFromQuoteResponse(result, d.contracts)
        : d.contracts;

      // Step 0 — latency log
      console.log(
        `[LAT] match=${(t1 - t0).toFixed(1)} pre=${(t2 - t1).toFixed(1)} ` +
        `post=${(t3 - t2).toFixed(1)} total=${(t3 - t0).toFixed(1)}ms ` +
        `rfq=${rfq.rfqId} quote=${result.id}`
      );

      counts.posted++;
      pendingQuotes.delete(reserveKey);
      pendingQuotes.set(result.id, pendingEntry(p, rfq, reservedContracts, { yesBid }));

      console.log(
        `[${MODE}] QUOTED ${p.label} rfq=${rfq.rfqId} quote_id=${result.id} ` +
        `contracts=${reservedContracts} yes_bid=${yesBid} no_bid=${noBid} ` +
        `reserved=${outstanding + reservedContracts}/${d.totalLimit} locks=${d.locks}`
      );

      // Fire-and-forget after POST (Step 1)
      logAsync(p, rfq, d, 'quoted', {
        quote_id: result.id, is_live: true, contracts: reservedContracts,
      });
      sendAlert(
        `✅ QUOTED — ${p.label}\n` +
        `rfq ${shortId(rfq.rfqId)} · quote ${shortId(result.id)}\n` +
        `${reservedContracts} contracts · NO @ $${noBid}` +
        (size.source === 'dollar' ? ` · YES @ $${yesBid}` : '') +
        (p.fill_american != null ? ` · ${sgn(p.fill_american)}` : '')
      ).catch(() => {});
    } catch (e) {
      pendingQuotes.delete(reserveKey);
      const t3 = performance.now();
      console.log(
        `[LAT] match=${(t1 - t0).toFixed(1)} pre=${(t2 - t1).toFixed(1)} ` +
        `post=${(t3 - t2).toFixed(1)} total=${(t3 - t0).toFixed(1)}ms FAIL rfq=${rfq.rfqId}`
      );
      counts.postFailed++;
      console.error(`[${MODE}] POST FAILED ${p.label} rfq=${rfq.rfqId}`, e.message);
      logAsync(p, rfq, d, 'unfilled');
      if (!isSilentQuoteFailure(e.message)) {
        sendAlert(`❌ QUOTE FAILED — ${p.label}\nrfq ${shortId(rfq.rfqId)}\n${e.message}`).catch(() => {});
      }
    }
    return;
  }

  // Kill-switch engaged → shadow only (not latency-critical)
  logAsync(p, rfq, d, 'shadow');
  console.log(
    `[${MODE}] SHADOW ${p.label} rfq=${rfq.rfqId} wouldSell=${d.contracts} noBid=${noBid}`
  );
}

async function main() {
  if (!KEY_ID || !PEM || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error(
      `[${MODE}] missing env: need KALSHI_KEY_ID, Kalshi_combo_key, SUPABASE_URL, SUPABASE_SERVICE_KEY`
    );
    process.exit(1);
  }
  console.log(
    `[${MODE}] starting — latency-optimized. POST first, undici keep-alive, pre-staged prices. ` +
    `Auto-confirms quote_accepted (HVM ~3s window). ` +
    `Remaining = max - filled - outstanding quotes (Kalshi + Polymarket). ` +
    `Unaccepted quotes are DELETE'd after ${RESERVE_TTL_MS / 1000}s. ` +
    `rfq_deleted releases immediately. ` +
    `Skipped oversized/cap RFQs get a targeted tape lookup after close. ` +
    `Unhedged RFQ shadow (UNHEDGED_RFQ_SHADOW=${isUnhedgedRfqShadow(process.env) ? 'on' : 'off'}, ` +
    `UNHEDGED_RFQ_LIVE=${isUnhedgedRfqLive(process.env) ? 'on' : 'off'}) ` +
    `persists in-scope unmatched MLB/NFL ML combos — never posts.`
  );

  unhedgedPrices = createUnhedgedPriceCache({
    env: process.env,
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
  unhedgedPrices.start();

  await refresh();
  setInterval(refresh, 30000);
  setInterval(() => {
    cancelUnacceptedQuotes().catch((e) => console.error(`[${MODE}] cancel-unaccepted tick`, e.message));
    cancelPendingIfStarted().catch((e) => console.error(`[${MODE}] cancel-on-start tick`, e.message));
  }, 2000);
  setInterval(() => {
    reconcileSkipTapes().catch((e) => console.error(`[${MODE}] skip-tape tick`, e.message));
  }, SKIP_TAPE_TICK_MS);

  unhedgedFills = createUnhedgedFillTracker({
    supabase,
    env: process.env,
    fetchRfq: fetchSkipRfq,
    fetchTrades: fetchSkipTrades,
  });
  unhedgedFills.hydrate().catch((e) => console.error('[UNHEDGED] fill hydrate', e && e.message));
  setInterval(() => {
    unhedgedFills.tick().catch((e) => console.error('[UNHEDGED] fill tick', e && e.message));
  }, SKIP_TAPE_TICK_MS);

  // Step 2 — pre-warm + keep warm
  await warmConnection();
  setInterval(warmConnection, 45000);

  startHeartbeat(supabase, MODE, counts, () => parlays.length);

  const poly = startPolymarketRfqLoop({
    pendingQuotes: polyPendingQuotes,
    kalshiPendingQuotes: pendingQuotes,
    getOutstanding: outstandingFor,
    getParlays: () => parlays,
    filledSoFarFor,
    killEngagedFor,
    startedFor: startedForParlay,
    logAsync,
    sendAlert,
    counts,
    sessionFilledByParlay,
    supabase,
    env: process.env,
    unhedgedPrices,
  });
  polyLoop = poly;

  const client = createKalshiWs({
    keyId: KEY_ID,
    pem: PEM,
    onStatus: (s, i) => console.log(`[${MODE}] ws:${s}`, i || ''),
    onRfqCreated: (rfq, env) => onRfq(rfq, env).catch((e) => console.error('onRfq', e)),
    onRfqDeleted: (evt, env) => { try { onRfqDeleted(evt, env); } catch (e) { console.error('onRfqDeleted', e); } },
    onQuoteAccepted: (evt) => onQuoteAccepted(evt).catch((e) => console.error('onQuoteAccepted', e)),
    onQuoteExecuted: (evt) => onQuoteExecuted(evt).catch((e) => console.error('onQuoteExecuted', e)),
  });

  setInterval(() => console.log(`[${MODE}] tallies`, counts), 60000);
  process.on('SIGINT', () => {
    client.stop();
    try { poly && poly.stop && poly.stop(); } catch (_) {}
    try { unhedgedPrices && unhedgedPrices.stop && unhedgedPrices.stop(); } catch (_) {}
    try { kalshiHttp.close(); } catch (_) {}
    console.log(`[${MODE}] final`, counts);
    process.exit(0);
  });
  client.start();
}
main();
