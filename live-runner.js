// ─────────────────────────────────────────────────────────────────────────
// live-runner.js — LIVE worker (latency-optimized)
//
// ACCOUNTING: POST → 'quoted'. Kalshi quote_executed means orders were
//   placed, not that a trade filled — do not book the quoted size.
//   combo_fills / max_contracts advance only from GET /portfolio/fills
//   (count_fp, one row per fill_id, partials add). Polymarket orderExecution
//   FILL / PARTIAL_FILL still persists on the same path.
//   Persist combo_fills (parlay_id) FIRST, then stamp combo_submissions
//   status=filled + order_id. UI Filled tab is combo_fills; History needs
//   both fields. Restart recovery reads combo_submissions by quote_id
//   or order_id (quoteExecuted stamps creatorOrderId before the fill).
//   Poly quoteExecuted is orders-submitted, not a fill — do not persist there.
//   Retail WS fills arrive as snake_case order_subscription_update with
//   protobuf type 1/2; string EXECUTION_TYPE_* still works. A missed WS
//   event is recovered by GetQuotes(EXECUTED)+GET /v1/order (and, if
//   still dark, portfolio activities/positions matched to a unique lock).
//   Poly activity / reconcile / position share one economic size per
//   lock+caoc — distinct fill_ids must not stack on the Combo Lock card.
// RESERVE: default outstanding live quotes (pendingQuotes + in-flight POST)
//   count against remaining so parallel RFQs cannot all clear the same ceiling.
//   remaining = max - filled - outstanding.
//   COMBO_CAP_AT_CONFIRM=1 stops open quotes from reserving. Quote time still
//   skips an RFQ bigger than max - confirmed fills - confirms in flight.
//   Confirm (Kalshi and Polymarket) then checks that sum plus this accept,
//   one lock at a time. Default off keeps the outstanding-quote reserve.
//   Polymarket Retail RFQ (polymarket-rfq.js) shares this ceiling via
//   polyPendingQuotes + outstandingFor — Kalshi yes_bid / dollar RFQ math is unchanged.
//   Kalshi still declines the full RFQ when rfqContracts > remaining (no allowPartial).
//   Released on fill, cancel, POST fail, rfq_deleted, or 20s unaccepted DELETE.
// PARTIAL-FILL: d.locks is informational; post while ceiling remains.
// LATENCY: Steps 0–4 — instrument, POST first, undici keep-alive, pre-stage.
//   Quote POST/confirm/cancel use a dedicated undici Client so background
//   GETs (unhedged /markets, skip-tape, fill tracker, warm) cannot HOL-block
//   the auction send. While a POST/confirm is in flight, unmatched
//   rfq_created frames are setImmediate'd (lock-needle raw filter) so the
//   HTTP callback is not stuck behind firehose JSON.parse / RFQ-DEBUG
//   console. Quote pool is re-warmed every QUOTE_WARM_MS (not 45s) so an
//   idle LB cannot leave a dead socket for the next auction. [LAT]
//   match/pre/post/total ms on every attempt; 409 rfq_closed is logged as
//   QUOTE LATE with that latency (null quote_id). Successful QUOTED
//   Telegram includes the same match→POST total ms as LATE. Quote-lifecycle
//   Telegram (QUOTED / LATE / FAILED / CONFIRM / FILL / RFQ REPEAT) labels
//   (Kalshi) or (Polymarket) so Kaygosports can tell the venues apart.
// START GATE: never quote (and cancel open quotes) once any leg's start <= now.
//   Started still wins; the cap is a second gate.
//   Polymarket confirm + resting-quote cancel uses the same startedFor /
//   findStartedEvent (polymarket-rfq.js) — date-only PM slugs are not starts.
// LOCK-MISS: combo RFQ that matchParlay missed. Distinct from noLock
//   (matched, hedge does not lock). Tallies lockMiss + emptyLegs.
//   Sample logs are ≤1/10s and ONLY rfq= / legs=N / activeCount=N —
//   never keys= dumps or overlap label joins (that CPU work starved
//   Kalshi WS under NFL Sunday RFQ flood after #87). Rate-limit check
//   runs before any string building. NFL date-only Combo Locks vs
//   timed Kalshi tickers match via identity / HHMM strip.
// WS STALL: handshake 401 (header_timestamp_expired) is ignored — ws
//   does not emit close — or a zombie OPEN socket that neither messages
//   nor pongs. Keepalive pong is liveness; a quiet Saturday book must
//   not reconnect. Communications `unsubscribed` / channel-dead error
//   frames force close + resubscribe (pongs must not hide a dropped
//   sub). Telegram on handshake/auth, or a stall/reconnect burst — not
//   every quiet-book watchdog tick. Code 25 (subscription buffer
//   overflow) reconnects that shard only; Telegram fires when a socket
//   is still down after ~10s, not on every overflow.
// FIREHOSE: one socket per communications shard_key (KALSHI_WS_SHARD_FACTOR,
//   default 8; 1 = single unsharded socket). rfq_created frames that miss
//   lock needles are dropped before JSON.parse. quote_accepted /
//   quote_executed and rfq close frames are never dropped. counts.rfqs is
//   needle hits; ws-throughput.recv is the raw firehose. A shard reconnect
//   does not pause the other sockets.
// REST CLOCK: quote POST/confirm/cancel/GET share signedRequest so the
//   timestamp is minted at send, Date-header offset ignores 1s Date
//   truncation (PR #61 expired otherwise-good quotes), and a 401
//   header_timestamp_expired retries once after resync. Matching is
//   unchanged. Quote-watcher is not wired here.
// SKIP TAPE: oversized / limit_reached skips persist a distinct reason on
//   combo_submissions, then one RFQ+ticker tape lookup after close (or pad).
//   Poly Combo Locks reconcile SKIP/QUOTE also insert here (venue=polymarket)
//   via persistLockTape — not Railway-only. no_lock_overlap* is not taped.
//   Underfunded quote create/confirm (insufficient_balance) also persist a
//   declined combo_submissions row for the lock card. The generic QUOTE
//   FAILED Telegram stays silent. bucket-manager.js sends a loud alert
//   (1 per 10 min per venue) and checks the combo bucket immediately.
//   No public-tape lookup. Precision rejects stay console + unfilled.
//   Quote-watcher stays parked (same KALSHI_KEY_ID unsubscribes this WS).
//   We do not write combo_matches or watcher_debug.
// RFQ REPEAT: lock-matched RFQs about to quote are fingerprinted
//   (sorted legs + contracts + target_cost + creator_id when non-empty).
//   Cooldown / skip rfq_repeat ONLY when creator_id is known. Anonymous
//   WS RFQs (empty creator — common) always POST, even if Ari+Jax 6-contract
//   is identical. Known-creator loops allow RFQ_REPEAT_MAX_QUOTES successful
//   quotes (default 8) then go dark for RFQ_REPEAT_COOLDOWN_MS (default 300s;
//   0 disables). During dark, persist skip_reason=rfq_repeat on Miss tape
//   and Telegram once per window. After dark ends the quote counter resets.
//   Failed POST (incl. 409 rfq_closed) does not claim — the next live
//   auction can still quote. History fingerprint is still written for
//   grouping. Exact-lock matching unchanged. Poly is not wired.
//   Quote-watcher stays parked.
// UNHEDGED: default WORKER_MODE=combo does NOT schedule unhedged /markets
//   refresh, fill ticks, or shadow-miss persist. That work is
//   unhedged-runner.js (npm run start:unhedged) — its own Railway job,
//   own Kalshi WS / REST, own cache. UNHEDGED_RFQ_LIVE stays off.
//   WORKER_MODE=all is the local/rollback escape hatch (old one-process
//   wiring). Quote-hot still pauses leftover background ticks (skip-tape,
//   cancel, parlays refresh) while a Combo Lock POST/confirm is in flight.
//
// Env: KALSHI_KEY_ID, Kalshi_combo_key, SUPABASE_URL, SUPABASE_SERVICE_KEY
//      TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID (optional)
//      RFQ_REPEAT_MAX_QUOTES (optional; default 8)
//      RFQ_REPEAT_COOLDOWN_MS (optional; default 300000; 0 disables)
//      WORKER_MODE=combo|unhedged|all (default combo)
//      COMBO_CAP_AT_CONFIRM=1 (optional; default off) — enforce cap at confirm,
//        not by reserving every open quote. Polymarket close/overfill guards
//        stay on either way.
//      Combo bucket (shard 1) preallocation: bucket-manager.js.
//        KALSHI_BUCKET_AUTO=0 (default) logs the dry run and does not transfer.
//        In-app alerts for Kevin (public.app_alerts, sql/app_alerts.sql):
//        transfers, blocked top-ups, low shard 1 cash, insufficient funds.
//        COMBO_LOW_CASH_ALERT_USD (default 1000) = shard 1 low-cash level.
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { createKalshiFirehose, readShardFactor, DEFAULT_LIVE_SHARD_FACTOR, summarizeThroughput } = require('./kalshi-ws');
const { normalizePem, clockOffset, signedRequest } = require('./kalshi-auth');
const { matchParlay } = require('./rfq');
const { decideAtFill, isFreeBetRow, fillView, subcentEnabled, isPriceGridFailure, pennyNoBid, buildQuoteBody, shouldPostQuote, isSilentQuoteFailure, quoteFailureSkipReason, isRfqClosedFailure, quotePostFailReason, formatQuoteLatency, YES_DECLINE, impliedYesBid, quoteYesBid, shouldConfirmAccept, contractsFromQuoteResponse, isSubcentPrice } = require('./engine');
const { findStartedEvent } = require('./started');
const {
  RESERVE_TTL_MS,
  sumOutstanding,
  isCapExhausted,
  isReserveKey,
  dropPendingForRfq,
  listStaleUnaccepted,
} = require('./reserve');
const {
  capAtConfirmEnabled,
  createCapBook,
  createHoldResolver,
  confirmAgainstCap,
  releaseConfirmedFill,
  overfillOf,
  formatOverfillLog,
  formatOverfillAlert,
  formatCapSkip,
  formatMissingContext,
} = require('./cap-confirm');
const { startHeartbeat } = require('./heartbeat');
const { createLatencyStats, createLoopLagSampler } = require('./latency-stats');
const { startPolymarketRfqLoop } = require('./polymarket-rfq');
const { shortId } = require('./short-id');
const {
  classifySkip,
  skipPersistExtra,
  withVenue,
  isSkipTapeEligible,
  resolveSkipTape,
} = require('./skip-tape');
const {
  isUnhedgedRfqShadow,
  isUnhedgedRfqLive,
  persistUnhedgedRfq,
  shadowUnhedgedMiss,
} = require('./unhedged-rfq');
const {
  querySoftFailed,
  applyRefreshParlays,
  applyRefreshKillByUser,
  applyRefreshFilledByParlay,
} = require('./refresh-state');
const { liveRunnerFillRow, resolveFillLookup, findPendingFill, submissionAlreadyFilled, claimFillKey, isKalshiTradeFill, countsTowardCap } = require('./fills-attr');
const { bookFromQuoteExecution, fillsQuery, fillReferencesOrder } = require('./kalshi-fill-confirm');
const { findPolyEconomicTwin } = require('./polymarket-fill-reconcile');
const {
  fingerprintRfq,
  cooldownFingerprint,
  creatorIdFromQuoteResponse,
  createRepeatGuard,
  readCooldownMs,
  readMaxQuotes,
  formatRepeatSkipAlert,
  REPEAT_SKIP_REASON,
} = require('./rfq-repeat');
const { createKalshiRestPair, QUOTE_WARM_MS, QUOTE_CONNECTIONS } = require('./kalshi-http');
const { createQuoteHot, lockNeedlePlan, fastDropDisabled, dropDeletedDisabled, createDeletedFilter } = require('./quote-hot');
const { resolveWorkerMode, shouldRunUnhedged } = require('./worker-mode');
const { startUnhedgedSide } = require('./unhedged-boot');
const { createWsStatusAlerter, formatWsAlert } = require('./ws-status-alert');
const { formatAlertStatus } = require('./venue-alert');
const { createBucketManager } = require('./bucket-manager');
const { splitPaused, diffPaused, createPausePoller } = require('./lock-pause');
const { createLiveUserGate } = require('./live-users');
const { createAppAlerts } = require('./app-alerts');
const { createPolyStallAlerts } = require('./poly-stall-alert');
const { createPartialQuoteDryRun, isPartialQuoteFlagOn } = require('./partial-quote');

const MODE = 'LIVE';
let bucketManager = null;

// Cash a NO quote ties up on shard 1: contracts x NO price (dollars). null when unknown.
function quoteCostDollars(contracts, noBid) {
  const c = Number(contracts);
  const n = Number(noBid);
  if (!(c > 0) || !(n > 0) || n >= 1.0001) return null;
  return c * n;
}

// One-shot hint (set and consumed synchronously) so the rejected quote's cash
// need reaches the bucket manager without becoming a combo_submissions column.
let costHint = null;
function setCostHint(costDollars) {
  costHint = costDollars != null && Number(costDollars) > 0 ? { costDollars: Number(costDollars) } : null;
}
function takeCostHint() {
  const h = costHint;
  costHint = null;
  return h;
}

function noteInsufficientBalance(venue, info = null) {
  if (!bucketManager) return;
  Promise.resolve(bucketManager.onInsufficientBalance(venue, info)).catch((e) => {
    console.error(`[${MODE}] bucket notify`, e && e.message);
  });
}
const KEY_ID = process.env.KALSHI_KEY_ID;
const PEM = normalizePem(process.env.Kalshi_combo_key || process.env.KALSHI_PRIVATE_KEY || '');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Step 2 — two persistent HTTP clients. Quote mutations must not queue
// behind unhedged /markets pagination or skip-tape GETs (undici Client
// defaults to one connection).
const { rest: kalshiHttp, quote: kalshiQuoteHttp } = createKalshiRestPair();
const quoteHot = createQuoteHot();
// Quote-path latency / late-post / reconnect metrics → [LATENCY] log + combo_worker_stats.latency.
const latency = createLatencyStats();
let loopLag = null;
let latencyClient = null; // the kalshi firehose, set in main()
const QUOTE_PATH = '/trade-api/v2/communications/quotes';
const WARM_PATH = '/trade-api/v2/exchange/status';

// Sign immediately before send; retry once on header_timestamp_expired
// after applying Kalshi's Date header. Quote POST / confirm / cancel / GET
// share this so Combo Locks REST cannot keep the #61 WS-only clock offset.
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

const cancelingQuotes = new Set();
const cancelledQuotes = new Set();
const confirmingQuotes = new Set(); // de-dupe accept + skip 20s TTL during confirm
const capBook = createCapBook({
  enabled: capAtConfirmEnabled(process.env),
  // Hard-TTL exit only: a hold the venue could not be asked about for 30 min.
  onForced: (info) => {
    const msg = `[${MODE}] HOLD FORCE-RELEASED after ${Math.round(info.ageMs / 1000)}s unresolved ` +
      `quote_id=${info.quoteId} lock=${info.parlayId} size=${info.size} ` +
      `label=${(info.meta && info.meta.label) || '(unknown)'}`;
    console.error(msg);
    sendAlert(`⚠️ ${msg}`).catch(() => {});
  },
});
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
const seenFillIds = new Set();
let polyLoop = null;
// Poly fill GET/tape uses this client, created before the shared tracker.
// Do not wait for startPolymarketRfqLoop — tracker + warmConnection run first.
let polyUnhedgedHttp = null;
let unhedgedPrices = null;

function openOutstanding(parlayId, excludeQuoteId) {
  return sumOutstanding(pendingQuotes, parlayId, excludeQuoteId)
    + sumOutstanding(polyPendingQuotes, parlayId, excludeQuoteId);
}

function outstandingFor(parlayId, excludeQuoteId) {
  return capBook.exposure(openOutstanding(parlayId, excludeQuoteId), parlayId, excludeQuoteId);
}

function exposureBit(n) {
  return capBook.enabled ? `inFlight=${n}` : `reserved=${n}`;
}

// Step 3 — pre-staged quote pieces per parlay (rebuilt on successful parlays refresh)
// staged[id] = { noBid, yesBid, rest_remainder, fillAmerican, effTaker }
// yesBid stays YES_DECLINE (contract-count decline). Dollar RFQs pick
// implied YES at POST time from the no_bid actually sent — do not use this
// staged 0.00 on that path (Kalshi would derive ~1000 contracts).
let staged = {};
// KALSHI_SUBCENT=1 quotes at the exact lock target on the 0.001 grid (Kalshi MVE
// price_level_structure center_deci_edge_centi_cent) instead of flooring to the cent.
// Read once at boot; flip the Railway variable and redeploy to change it.
let SUBCENT = subcentEnabled(process.env);
// Safety latch: if the venue ever rejects a sub-cent price as off-grid AND the penny twin
// then succeeds, count it. 3 in a row → fall back to penny quoting until the next deploy.
let subcentGridFails = 0;
// RFQs that reach the handler older than this are skipped, not quoted (KALSHI_STALE_RFQ_MS, 0 = off).
const STALE_RFQ_MS = (() => {
  const n = Number(process.env.KALSHI_STALE_RFQ_MS);
  if (process.env.KALSHI_STALE_RFQ_MS == null || process.env.KALSHI_STALE_RFQ_MS === '') return 15000;
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();
const SUBCENT_LATCH_AFTER = 3;

const counts = {
  rfqs: 0, combos: 0, matched: 0, wouldQuote: 0,
  declined: 0, noLock: 0, lockMiss: 0, emptyLegs: 0,
  limitReached: 0,
  posted: 0, postFailed: 0, dollarRfqs: 0, filled: 0,
  tapeMatched: 0, tapeNone: 0,
  rfqRepeat: 0,
};
// Oversized-RFQ partial-quote DRY-RUN counter (COMBO_PARTIAL_QUOTE_OVERSIZED,
// default OFF). Observability only — Kalshi quotes cannot be smaller than the RFQ.
const partialQuote = createPartialQuoteDryRun();

const repeatGuard = createRepeatGuard({
  cooldownMs: readCooldownMs(process.env),
  maxQuotes: readMaxQuotes(process.env),
});
let lastLockFingerprint = '';
const LOCK_MISS_LOG_MS = 10000;
let lastLockMissLogAt = 0;

const pendingSkipTapes = new Map(); // submission id → skip row awaiting tape
let unhedgedFills = null; // WORKER_MODE=all only — default combo leaves this null
let unhedgedSide = null;
const workerMode = resolveWorkerMode(process.env);
const runUnhedged = shouldRunUnhedged(process.env);
const unknownCols = new Set();
const COL_ERR = /Could not find the '([^']+)' column/i;
const SKIP_TAPE_LOOKBACK_MS = 24 * 3600 * 1000;
const SKIP_TAPE_TICK_MS = 15000;
const SKIP_TAPE_MAX_PER_TICK = 5;

// --- per-lock pause -----------------------------------------------------------
let pausedParlayIds = new Set();
const liveUsers = createLiveUserGate({ env: process.env, log: (m) => console.log(`[${MODE}] ${m}`) });
console.log(`[${MODE}] ${liveUsers.summary()}`);

const pausePoller = createPausePoller({ supabase, log: (m) => console.log(`[${MODE}] ${m.replace(/^\[PAUSE\] /, 'PAUSE ')}`) });

async function cancelPausedLock(parlayId) {
  try {
    const rows = (await loadOpenSubmissionQuotes()).filter((r) => r.parlay_id === parlayId);
    await cancelOpenQuotesForParlay(parlayId, { kind: 'paused' }, rows);
  } catch (e) {
    console.error(`[${MODE}] pause cancel (kalshi)`, e.message);
  }
  if (polyLoop && typeof polyLoop.cancelOpenQuotesForParlay === 'function') {
    try {
      await polyLoop.cancelOpenQuotesForParlay(parlayId, { kind: 'paused' });
    } catch (e) {
      console.error(`[${MODE}] pause cancel (poly)`, e.message);
    }
  }
}

// Record the paused set; cancel open quotes for locks that just became paused.
function notePausedIds(next) {
  const { pausedNow, resumed } = diffPaused(pausedParlayIds, next);
  pausedParlayIds = next;
  for (const id of pausedNow) {
    console.log(`[${MODE}] PAUSED lock ${id} — no longer quoting (Kalshi + Polymarket); cancelling open quotes`);
    cancelPausedLock(id);
  }
  for (const id of resumed) console.log(`[${MODE}] RESUMED lock ${id} — quoting again`);
  return { pausedNow, resumed };
}

// Every 2s: a quote that raced the pause (POST in flight) is cancelled.
function cancelStragglersForPaused() {
  if (!pausedParlayIds.size) return;
  for (const [, pending] of pendingQuotes) {
    if (pending && pausedParlayIds.has(pending.parlayId)) { cancelPausedLock(pending.parlayId); break; }
  }
}

// Fast path (5s): react to a toggle without waiting for the 30s refresh.
async function pollPaused() {
  const ids = await pausePoller.poll();
  if (!ids) return;
  const { pausedNow, resumed } = diffPaused(pausedParlayIds, ids);
  if (!pausedNow.length && !resumed.length) return;
  if (pausedNow.length) {
    parlays = parlays.filter((x) => !ids.has(x.id));
    for (const id of pausedNow) delete staged[id];
    try {
      const plan = lockNeedlePlan(parlays);
      if (fastDropDisabled(process.env)) plan.enabled = false;
      quoteHot.setPlan(plan);
    } catch (e) {
      console.error(`[${MODE}] pause needle plan`, e.message);
    }
  }
  notePausedIds(ids);
  if (resumed.length) refresh();
}

async function refresh() {
  try {
    const [parlaysQ, settingsQ, fillsQ] = await Promise.all([
      supabase.from('combo_parlays').select('*').eq('active', true),
      supabase.from('combo_settings').select('user_id,kill_switch'),
      // Confirmed contracts only. Quote-execution stubs (source=live-runner)
      // are not Kalshi fills and must not consume max_contracts.
      supabase.from('combo_fills')
        .select('parlay_id,count,fill_id,order_id,raw')
        .eq('is_combo', true)
        .eq('is_taker', false)
        .not('parlay_id', 'is', null),
    ]);
    const refreshLog = { error: (msg) => console.error(`[${MODE}] ${msg}`) };
    // supabase-js soft-fails as { data: null, error } — do not treat null as [].
    const parlaysFailed = querySoftFailed(parlaysQ);
    // Only allowlisted users' locks are ever loaded (Kalshi AND Polymarket read
    // this same list). Everyone else's rows are dropped here, logged once.
    parlays = liveUsers.filterParlays(applyRefreshParlays(parlays, parlaysQ, refreshLog));
    if (!parlaysFailed) {
      // Paused locks (combo_parlays.paused) stay in the table but are not quoted.
      // Missing column => no row has paused === true => everything stays enabled.
      const split = splitPaused(parlays);
      parlays = split.live;
      notePausedIds(split.pausedIds);
    }
    killByUser = liveUsers.filterKillByUser(applyRefreshKillByUser(killByUser, settingsQ, refreshLog));
    const fillsForCap = querySoftFailed(fillsQ)
      ? fillsQ
      : { data: (fillsQ.data || []).filter(countsTowardCap), error: null };
    filledByParlay = applyRefreshFilledByParlay(filledByParlay, fillsForCap, 'count', refreshLog);

    // Pre-stage prices (Step 3). Soft-fail keeps previous staged with the locks.
    if (!parlaysFailed) {
      const next = {};
      for (const row of parlays) {
        const v = fillView(row.fill_american, { subcent: SUBCENT });
        next[row.id] = {
          noBid: v.noBid,
          yesBid: YES_DECLINE,
          rest_remainder: false,
          fillAmerican: row.fill_american,
          effTaker: v.effTaker,
        };
      }
      staged = next;
    }
    const needlePlan = lockNeedlePlan(parlays);
    if (fastDropDisabled(process.env)) needlePlan.enabled = false;
    quoteHot.setPlan(needlePlan);
    const fastDropBit = `fastDrop=${needlePlan.enabled ? 'on' : 'off'} needles=${needlePlan.needles.length} uncovered=${needlePlan.uncovered}`;

    if (parlaysFailed) {
      const kept = parlays.map((row) => row.label || row.id).join(', ') || 'none';
      console.log(
        `[${MODE}] refreshed — ${parlays.length} active parlay(s) RETAINED after soft-fail, ` +
        `staged=${Object.keys(staged).length} ${fastDropBit} — ${kept}`
      );
    } else {
      console.log(
        `[${MODE}] refreshed — ${parlays.length} active parlay(s), staged=${Object.keys(staged).length} ${fastDropBit}`
      );
    }
    const lockBits = parlays.map((row) => {
      const keys = row.leg_keys || row.legKeys || [];
      return `${row.label || row.id}[${Array.isArray(keys) ? keys.join('|') : ''}]`;
    });
    const fingerprint = lockBits.join(' || ');
    if (fingerprint !== lastLockFingerprint) {
      lastLockFingerprint = fingerprint;
      if (lockBits.length) {
        for (const bit of lockBits) console.log(`[${MODE}] lock ${bit}`);
      }
    }
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

// DB-fresh filled for one lock, same rule as refresh(): every non-stub maker
// combo fill. Null on error so a failed read never lowers the count.
async function freshFilledFor(parlayId) {
  if (!parlayId) return null;
  try {
    const { data, error } = await supabase
      .from('combo_fills')
      .select('parlay_id,count,fill_id,order_id,raw')
      .eq('is_combo', true)
      .eq('is_taker', false)
      .eq('parlay_id', parlayId);
    if (error) {
      console.error(`[${MODE}] last-look fills read`, error.message);
      return null;
    }
    return (data || []).filter(countsTowardCap).reduce((n, r) => n + (Number(r.count) || 0), 0);
  } catch (e) {
    console.error(`[${MODE}] last-look fills read`, e && e.message);
    return null;
  }
}

// Last look before any confirm: the in-memory count can lag the books.
async function lastLookFilledFor(parlayId) {
  try { await resolveHolds(parlayId); } catch (_) { /* best effort */ }
  const fresh = await freshFilledFor(parlayId);
  return fresh == null ? 0 : fresh;
}

// Use the larger of DB fills vs session fills so a restart can't under-count,
// and we don't double-count the same contracts from both sources.
const filledSoFarFor = (id) => Math.max(filledByParlay[id] || 0, sessionFilledByParlay[id] || 0);
// Not allowlisted => always engaged, whatever combo_settings says.
const killEngagedFor = (userId) => !liveUsers.isAllowed(userId) || killByUser[userId] !== false;

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
  const venueExtra = withVenue(extra);
  if (venueExtra.skip_reason === 'insufficient_balance') {
    noteInsufficientBalance(venueExtra.venue || 'kalshi', takeCostHint());
  }
  const body = stripUnknown({
    user_id: p.user_id,
    parlay_id: p.id,
    rfq_id: rfq.rfqId,
    label: p.label,
    fill_american: (d && d.fillAmerican != null) ? d.fillAmerican : p.fill_american,
    contracts,
    worst_lock: d ? d.worst : null,
    status: normalizeStatus(status),
    ...withVenue(extra),
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

function fundingSkipExtra(d, rfq, extra = {}) {
  return skipPersistExtra({
    skipReason: 'insufficient_balance',
    contracts: extra.contracts != null ? extra.contracts
      : d && d.contracts != null ? d.contracts
        : rfq && rfq.contracts != null ? rfq.contracts : null,
    remaining: extra.remaining != null ? extra.remaining
      : d && d.remaining != null ? d.remaining : null,
    marketTicker: extra.marketTicker || (rfq && rfq.marketTicker) || null,
  });
}

function logFundingSkip(p, rfq, d, extra = {}) {
  const persistExtra = fundingSkipExtra(d, rfq, extra);
  // Not a column: handed to logAsync's notify through a one-shot hint.
  setCostHint(extra.costDollars);
  logAsync(p, rfq, d, 'declined', persistExtra);
}

// Confirm already inserted a quoted row — stamp skip_reason on that attempt.
// If the insert never landed, insert a declined funding row.
function persistQuoteSkip(quoteId, skipReason, fallback, venue, info = null) {
  if (skipReason === 'insufficient_balance') noteInsufficientBalance(venue || 'kalshi', info);
  if (!skipReason) return Promise.resolve(null);
  const body = stripUnknown({
    skip_reason: skipReason,
    status: 'declined',
    is_live: false,
  });
  const insertFallback = () => {
    if (!fallback || typeof fallback !== 'function') return Promise.resolve(null);
    return Promise.resolve(fallback());
  };
  if (!quoteId || isReserveKey(quoteId)) return insertFallback();
  return supabase.from('combo_submissions').update(body).eq('quote_id', quoteId).select('id')
    .then(({ data, error }) => {
      if (error) {
        const m = String(error.message || '').match(COL_ERR);
        if (m) {
          unknownCols.add(m[1]);
          console.warn(`[${MODE}] combo_submissions missing column ${m[1]} — degrading`);
          const retry = { ...body };
          delete retry[m[1]];
          return supabase.from('combo_submissions').update(retry).eq('quote_id', quoteId).select('id')
            .then(({ data: d2, error: e2 }) => {
              if (e2) {
                console.error(`[${MODE}] quote skip persist`, e2.message);
                return insertFallback();
              }
              if (d2 && d2.length) return d2[0];
              return insertFallback();
            });
        }
        console.error(`[${MODE}] quote skip persist`, error.message);
        return insertFallback();
      }
      if (data && data.length) return data[0];
      return insertFallback();
    })
    .catch((e) => {
      console.error(`[${MODE}] quote skip persist`, e.message);
      return insertFallback();
    });
}

async function withQuoteHot(fn) {
  quoteHot.begin();
  try {
    return await fn();
  } finally {
    quoteHot.end();
  }
}

// Background timers (skip-tape, 20s cancel, parlays refresh — and
// unhedged ticks only when WORKER_MODE=all) must not run on the same
// tick as a Combo Lock POST/confirm.
function unlessQuoteHot(fn) {
  return () => {
    if (quoteHot.inFlight) return;
    return fn();
  };
}

async function postQuote(rfqId, noBid, yesBid = YES_DECLINE, restRemainder) {
  return withQuoteHot(async () => {
    const body = JSON.stringify(buildQuoteBody(rfqId, noBid, yesBid, restRemainder));
    const { statusCode, text } = await kalshiSigned('POST', QUOTE_PATH, {
      headers: { 'Content-Type': 'application/json' },
      body,
      http: kalshiQuoteHttp,
    });
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Kalshi quote failed ${statusCode}: ${text}`);
    }
    return JSON.parse(text); // { id: quote_id }
  });
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
  const { statusCode, text } = await kalshiSigned('DELETE', path, { http: kalshiQuoteHttp });
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
  if (reason && reason.kind === 'paused') {
    return `[${MODE}] CANCEL lock paused ${label} quote_id=${quoteId}` + rfqBit;
  }
  if (reason && reason.kind === 'cap_full') {
    return (
      `[${MODE}] CANCEL leftover ${label} quote_id=${quoteId}` +
      rfqBit +
      ` filled=${reason.filled}/${reason.max}`
    );
  }
  if (reason && reason.kind === 'cap_exceeded') {
    const heldWord = reason.inFlight ? 'inFlight' : 'reserved';
    return (
      `[${MODE}] CANCEL cap exceeded ${label} quote_id=${quoteId}` +
      rfqBit +
      ` filled=${reason.filled} ${heldWord}=${reason.reserved} want=${reason.want} max=${reason.max}`
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
  if (!runUnhedged) return Promise.resolve(null);
  if (unhedgedSide && typeof unhedgedSide.persist === 'function') {
    return unhedgedSide.persist(row);
  }
  if (unhedgedFills) unhedgedFills.remember(row);
  return persistUnhedgedRfq(supabase, row);
}

function onRfqDeleted(evt, env) {
  const rfqId = evt && evt.rfqId;
  if (!rfqId) return;
  const dropped = dropPendingForRfq(pendingQuotes, rfqId, { confirming: confirmingQuotes });
  for (const { id, quote } of dropped) {
    noteReleased(id, quote, 'closed');
  }
  if (unhedgedFills && rfqId) {
    const closedEvt = evt;
    const closedEnv = env;
    setImmediate(() => {
      unhedgedFills.onClosed({
        venue: 'kalshi',
        rfqId,
        extra: closedEnv,
        rfq: closedEvt,
      }).catch((e) => console.error('[UNHEDGED] fill close', e && e.message));
    });
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
  if (polyLoop && typeof polyLoop.cancelOpenQuotesForParlay === 'function') {
    try {
      await polyLoop.cancelOpenQuotesForParlay(parlayId, { kind: 'cap_full', ...info });
    } catch (e) {
      console.error(`[${MODE}] poly cancel leftover`, e.message);
    }
  }
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
  return withQuoteHot(async () => {
    const path = confirmPath(rfqId, quoteId);
    // Kalshi rejects PUTs without an explicit JSON content-type (400 invalid_content_type),
    // even when the body is empty — send {} + application/json.
    const { statusCode, text } = await kalshiSigned('PUT', path, {
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      http: kalshiQuoteHttp,
    });
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Kalshi confirm failed ${statusCode}: ${text}`);
    }
    return { statusCode };
  });
}

async function warmOne(http, label, fanout = 1) {
  try {
    // A Pool spreads concurrent requests over its sockets, so firing `fanout` at once
    // keeps EVERY socket warm (sequential GETs would reuse only the first idle one and let
    // the others hit the LB idle-kill, costing a TLS handshake on the next burst POST).
    const results = await Promise.all(
      Array.from({ length: Math.max(1, fanout) }, () => kalshiSigned('GET', WARM_PATH, { http }))
    );
    const statusCode = results[0].statusCode;
    const offset = clockOffset();
    if (Math.abs(offset) > 2000) {
      console.warn(`[${MODE}] kalshi clock offset ${offset}ms (from Date header)`);
    }
    console.log(`[${MODE}] connection warm ${label} ok status=${statusCode} sockets=${results.length} clockOffset=${offset}ms`);
  } catch (e) {
    console.error(`[${MODE}] connection warm ${label} failed`, e.message);
  }
}

async function warmConnection() {
  // Warm quote + rest in parallel — different pools, same origin.
  // Skip the quote-pool GET while a POST/confirm owns those sockets.
  const tasks = [warmOne(kalshiHttp, 'rest', 1)];
  if (!quoteHot.inFlight) tasks.push(warmOne(kalshiQuoteHttp, 'quote', QUOTE_CONNECTIONS));
  await Promise.all(tasks);
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
      : parseFloat(fillView(fillAmerican, { subcent: SUBCENT }).noBid);
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
    // Flag on: no quote context means we cannot check the cap. Do not confirm.
    // Flag off keeps today's confirm-without-pending path.
    if (!pending && capBook.enabled) {
      console.warn(formatMissingContext(MODE, quoteId, rfqId));
      return;
    }
    if (!pending) {
      await confirmQuote(rfqId, quoteId);
      const ms = (performance.now() - t0).toFixed(1);
      console.log(
        `[${MODE}] CONFIRMED quote_id=${quoteId} rfq_id=${rfqId} in ${ms}ms ` +
        `side=${evt.acceptedSide || '?'} label=(unknown)`
      );
      return;
    }
    const maxContracts = (parlay && parlay.max_contracts) || pending.maxContracts;
    const decision = await confirmAgainstCap(capBook, {
      parlayId: pending.parlayId,
      quoteId,
      maxContracts,
      size: pending.contracts,
      getFilled: () => filledSoFarFor(pending.parlayId),
      lastLook: () => withBudget(lastLookFilledFor(pending.parlayId), 900),
      onLastLookRaise: (info) => console.warn(
        `[${MODE}] LAST LOOK raised filled ${info.memory} -> ${info.fresh} lock=${pending.parlayId} quote_id=${quoteId}`
      ),
      meta: {
        venue: 'kalshi', rfqId, label: pending.label, contracts: pending.contracts,
        maxContracts, userId: pending.userId,
      },
      getOpenHeld: () => openOutstanding(pending.parlayId, quoteId),
      confirm: () => confirmQuote(rfqId, quoteId),
      onExceed: async (info) => {
        console.log(formatCapSkip({
          mode: MODE,
          quoteId,
          rfqId,
          label: pending.label,
          quoted: pending.contracts,
          enabled: capBook.enabled,
          filled: info.filled,
          held: info.held,
          size: info.size,
          maxContracts: info.maxContracts,
        }));
        await cancelQuoteAndDrop(quoteId, pending, {
          kind: 'cap_exceeded',
          filled: info.filled,
          reserved: info.held,
          want: info.size,
          max: info.maxContracts,
          inFlight: capBook.enabled,
        });
      },
    });
    if (!decision.ok) return;
    // Confirm already returned — HVM window is ~3s. Log/Telegram after.
    const ms = (performance.now() - t0).toFixed(1);
    console.log(
      `[${MODE}] CONFIRMED quote_id=${quoteId} rfq_id=${rfqId} in ${ms}ms ` +
      `side=${evt.acceptedSide || '?'} label=${pending.label}`
    );
  } catch (e) {
    console.error(`[${MODE}] CONFIRM FAILED quote_id=${quoteId} rfq_id=${rfqId}`, e.message);
    const skipReason = quoteFailureSkipReason(e.message);
    if (skipReason) {
      const yb = pending && Number(pending.yesBid);
      const confirmCost = yb > 0 && yb < 1 ? quoteCostDollars(pending.contracts, 1 - yb) : null;
      persistQuoteSkip(quoteId, skipReason, () => {
        const p = parlayFromPending(pending);
        if (!p) return null;
        return logFundingSkip(p, { rfqId, contracts: pending && pending.contracts }, null, {
          contracts: pending && pending.contracts,
          costDollars: confirmCost,
        });
      }, 'kalshi', confirmCost != null ? { costDollars: confirmCost } : null);
    }
    if (!isSilentQuoteFailure(e.message)) {
      sendAlert(
        `${formatAlertStatus('❌ CONFIRM FAILED', 'kalshi')} — ${pending ? pending.label : shortId(quoteId)}\n` +
        `quote ${shortId(quoteId)} · rfq ${shortId(rfqId)}\n` +
        `${e.message}`
      ).catch(() => {});
    }
  } finally {
    confirmingQuotes.delete(quoteId);
  }
}

function fillVenueOf(evt) {
  return evt && evt.venue === 'polymarket' ? 'polymarket' : 'kalshi';
}

function fillKeyOf(evt) {
  if (!evt) return null;
  return evt.fillId || evt.orderId || evt.quoteId || null;
}

async function persistExecutedFill(pending, evt) {
  const quoteId = evt.quoteId;
  const orderId = evt.orderId || evt.fillId || quoteId || null;
  const contracts = evt.contracts != null ? evt.contracts : pending.contracts;
  const ticker = evt.marketTicker || null;
  const venue = fillVenueOf(evt);
  // Combo Locks "Filled — awaiting settlement" keys off combo_fills.parlay_id.
  // Write fills first so a submissions error cannot hide the position.
  try {
    let skipFill = false;
    if (venue === 'polymarket' && pending.parlayId) {
      const { data: booked, error: bookedErr } = await supabase
        .from('combo_fills')
        .select('fill_id,parlay_id,ticker,count,raw,recorded_at,kalshi_created_time')
        .eq('parlay_id', pending.parlayId)
        .eq('is_combo', true)
        .limit(500);
      if (bookedErr) console.error(`[${MODE}] poly twin lookup`, bookedErr.message);
      const twin = findPolyEconomicTwin(
        {
          qty: contracts,
          contracts,
          marketSlug: ticker,
          parlay_id: pending.parlayId,
          fill_id: evt.fillId,
          fillId: evt.fillId,
          tradeTime: evt.tradeTime || null,
        },
        { id: pending.parlayId },
        booked || [],
        { live: !!evt.live },
      );
      if (twin && (twin.fill_id || twin.fillId) !== evt.fillId) {
        skipFill = true;
        console.log(
          `[${MODE}] skip poly fill — economic twin fill_id=${twin.fill_id || twin.fillId} ` +
          `already booked on ${pending.parlayId} ${ticker || ''} size=${contracts}`
        );
      }
    } else if (orderId) {
      const { data: sameOrder, error: orderErr } = await supabase
        .from('combo_fills')
        .select('fill_id,order_id,raw,ticker')
        .eq('order_id', orderId)
        .limit(20);
      if (orderErr) console.error(`[${MODE}] kalshi stub lookup`, orderErr.message);
      if ((sameOrder || []).some(isKalshiTradeFill)) {
        skipFill = true;
        console.log(`[${MODE}] skip live-runner stub — real Kalshi fill already on order_id=${orderId}`);
      }
    }
    if (!skipFill) {
      const { error: fillErr } = await supabase.from('combo_fills').upsert(
        liveRunnerFillRow({
          quoteId,
          orderId,
          fillId: evt.fillId,
          parlayId: pending.parlayId,
          count: contracts,
          ticker,
          rfqId: pending.rfqId || evt.rfqId,
          label: pending.label,
          venue,
          source: evt.source || 'live-runner',
        }),
        { onConflict: 'fill_id' },
      );
      if (fillErr) console.error(`[${MODE}] combo_fills upsert failed`, fillErr.message);
    }
  } catch (e) {
    console.error(`[${MODE}] combo_fills persist`, e.message);
  }

  try {
    const patch = { status: 'filled', order_id: orderId, is_live: true };
    if (ticker) patch.market_ticker = ticker;
    const { data: updated, error } = await supabase
      .from('combo_submissions')
      .update(patch)
      .eq('quote_id', quoteId)
      .select('id');
    if (error) console.error(`[${MODE}] update filled failed`, error.message);
    if (!updated || !updated.length) {
      const { error: insErr } = await supabase.from('combo_submissions').insert({
        user_id: pending.userId,
        parlay_id: pending.parlayId,
        rfq_id: pending.rfqId || evt.rfqId,
        label: pending.label,
        contracts,
        status: 'filled',
          quote_id: quoteId,
          order_id: orderId,
          is_live: true,
          venue,
          market_ticker: ticker,
        });
      if (insErr) console.error(`[${MODE}] insert filled failed`, insErr.message);
    }
  } catch (e) {
    console.error(`[${MODE}] onQuoteExecuted submission`, e.message);
  }
}

async function pendingFromSubmission({ quoteId, orderId } = {}) {
  if (!quoteId && !orderId) return null;
  try {
    let query = supabase
      .from('combo_submissions')
      .select('quote_id,parlay_id,label,rfq_id,contracts,user_id,order_id,status')
      .order('created_at', { ascending: false })
      .limit(1);
    if (quoteId) query = query.eq('quote_id', quoteId);
    else query = query.eq('order_id', orderId);
    const { data, error } = await query.maybeSingle();
    if (error || !data) return null;
    return {
      parlayId: data.parlay_id,
      userId: data.user_id,
      contracts: data.contracts,
      label: data.label,
      rfqId: data.rfq_id,
      quoteId: data.quote_id,
      maxContracts: null,
      alreadyFilled: submissionAlreadyFilled(data),
    };
  } catch (_) {
    return null;
  }
}

const POLY_FILL_LOOKBACK_MS = 21 * 24 * 3600 * 1000;
const POLY_SLUG_CACHE_MS = 15000;
let polySlugCacheAt = 0;
let polySlugCacheRows = null;
let polySlugInflight = null;

async function loadUnfilledPolyQuotes() {
  const cutoff = new Date(Date.now() - POLY_FILL_LOOKBACK_MS).toISOString();
  try {
    const { data, error } = await supabase
      .from('combo_submissions')
      .select('id,quote_id,order_id,rfq_id,parlay_id,label,contracts,user_id,status,created_at,market_ticker')
      .eq('venue', 'polymarket')
      .not('quote_id', 'is', null)
      .neq('status', 'filled')
      .neq('status', 'shadow')
      .gte('created_at', cutoff)
      .limit(300);
    if (error) {
      console.error(`[${MODE}] load unfilled poly quotes`, error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.error(`[${MODE}] load unfilled poly quotes`, e && e.message);
    return [];
  }
}

async function getFilledForQuote(quoteId) {
  if (!quoteId) return 0;
  try {
    const cutoff = new Date(Date.now() - POLY_FILL_LOOKBACK_MS).toISOString();
    const { data, error } = await supabase
      .from('combo_fills')
      .select('count,raw,fill_id')
      .eq('is_combo', true)
      .gte('recorded_at', cutoff)
      .limit(500);
    if (error) {
      console.error(`[${MODE}] filled-for-quote`, error.message);
      return 0;
    }
    let sum = 0;
    for (const row of data || []) {
      const raw = row && row.raw;
      if (!raw || raw.quote_id !== quoteId) continue;
      const n = Number(row.count);
      if (Number.isFinite(n)) sum += n;
    }
    return sum;
  } catch (e) {
    console.error(`[${MODE}] filled-for-quote`, e && e.message);
    return 0;
  }
}

async function loadRecentLocks() {
  const cutoff = new Date(Date.now() - POLY_FILL_LOOKBACK_MS).toISOString();
  try {
    const [locksQ, quotedQ] = await Promise.all([
      supabase
        .from('combo_parlays')
        .select('id,label,user_id,max_contracts,active,created_at,archived_at')
        .gte('created_at', cutoff)
        .limit(200),
      supabase
        .from('combo_submissions')
        .select('parlay_id')
        .eq('venue', 'polymarket')
        .not('quote_id', 'is', null)
        .gte('created_at', cutoff)
        .limit(2000),
    ]);
    if (locksQ.error) {
      console.error(`[${MODE}] load recent locks`, locksQ.error.message);
      return parlays.slice();
    }
    const recent = liveUsers.filterParlays(locksQ.data || []);
    const have = new Set(recent.map((p) => p && p.id).filter(Boolean));
    const missing = [];
    for (const row of quotedQ.data || []) {
      if (row && row.parlay_id && !have.has(row.parlay_id)) {
        have.add(row.parlay_id);
        missing.push(row.parlay_id);
      }
    }
    if (!missing.length) return recent.length ? recent : parlays.slice();
    const extraQ = await supabase
      .from('combo_parlays')
      .select('id,label,user_id,max_contracts,active,created_at,archived_at')
      .in('id', missing);
    if (extraQ.error) {
      console.error(`[${MODE}] load quoted locks`, extraQ.error.message);
      return recent.length ? recent : parlays.slice();
    }
    return recent.concat(liveUsers.filterParlays(extraQ.data || []));
  } catch (e) {
    console.error(`[${MODE}] load recent locks`, e && e.message);
    return parlays.slice();
  }
}

async function loadPolySlugRecordsUncached() {
  const cutoff = new Date(Date.now() - POLY_FILL_LOOKBACK_MS).toISOString();
  try {
    const [fillsQ, subsQ] = await Promise.all([
      supabase
        .from('combo_fills')
        .select('ticker,parlay_id,raw,count,fill_id,recorded_at,kalshi_created_time')
        .eq('is_combo', true)
        .gte('recorded_at', cutoff)
        .limit(1000),
      supabase
        .from('combo_submissions')
        .select('quote_id,parlay_id,market_ticker,contracts')
        .eq('venue', 'polymarket')
        .not('quote_id', 'is', null)
        .gte('created_at', cutoff)
        .limit(2000),
    ]);
    if (fillsQ.error) console.error(`[${MODE}] load poly fill slugs`, fillsQ.error.message);
    if (subsQ.error) console.error(`[${MODE}] load poly quote slugs`, subsQ.error.message);
    const rows = [];
    for (const row of fillsQ.data || []) {
      if (!row || !row.parlay_id) continue;
      const venue = row.raw && row.raw.venue;
      if (venue === 'polymarket' || (row.ticker && /^caoc-/i.test(row.ticker))) {
        rows.push({
          ticker: row.ticker,
          market_ticker: row.ticker,
          parlay_id: row.parlay_id,
          contracts: row.count,
          fill_id: row.fill_id,
          source: row.raw && row.raw.source,
          recorded_at: row.recorded_at,
          kalshi_created_time: row.kalshi_created_time,
        });
      }
    }
    for (const row of subsQ.data || []) {
      if (row && row.parlay_id) rows.push(row);
    }
    return rows;
  } catch (e) {
    console.error(`[${MODE}] load poly slug records`, e && e.message);
    return [];
  }
}

async function loadPolySlugRecords() {
  const now = Date.now();
  if (polySlugCacheRows && (now - polySlugCacheAt) < POLY_SLUG_CACHE_MS) {
    return polySlugCacheRows;
  }
  if (polySlugInflight) return polySlugInflight;
  polySlugInflight = loadPolySlugRecordsUncached().then((rows) => {
    polySlugCacheRows = rows;
    polySlugCacheAt = Date.now();
    return rows;
  }).finally(() => {
    polySlugInflight = null;
  });
  return polySlugInflight;
}

function persistQuoteOrder(quoteId, orderId) {
  if (!quoteId || !orderId || isReserveKey(quoteId)) return;
  supabase.from('combo_submissions').update({ order_id: orderId, is_live: true })
    .eq('quote_id', quoteId)
    .then(({ error }) => {
      if (error) console.error(`[${MODE}] stamp order_id failed`, error.message);
    })
    .catch((e) => console.error(`[${MODE}] stamp order_id failed`, e && e.message));
}

async function findComboFill(fillId) {
  if (!fillId) return null;
  try {
    const { data, error } = await supabase
      .from('combo_fills')
      .select('fill_id,count')
      .eq('fill_id', fillId)
      .maybeSingle();
    if (error) {
      console.error(`[${MODE}] confirmed fill lookup`, error.message);
      return { fill_id: fillId, uncertain: true };
    }
    return data || null;
  } catch (e) {
    console.error(`[${MODE}] confirmed fill lookup`, e.message);
    return { fill_id: fillId, uncertain: true };
  }
}

// quote_executed places orders. Count only fills Kalshi already lists for
// that order_id, at count_fp. An empty fills response books nothing.
async function fetchKalshiFillsForOrder(orderId) {
  if (!orderId) return [];
  const signPath = '/trade-api/v2/portfolio/fills';
  const out = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const qs = fillsQuery({ orderId, limit: 200, cursor });
    const res = await kalshiSigned('GET', signPath, { path: `${signPath}?${qs}` });
    if (!res || res.statusCode !== 200) {
      throw new Error(`fills read ${res && res.statusCode}: ${res && res.text}`);
    }
    const body = JSON.parse(res.text || '{}');
    const fills = (body.fills || []).filter((fill) => fillReferencesOrder(fill, orderId));
    out.push(...fills);
    if (!body.cursor || !(body.fills || []).length) break;
    cursor = body.cursor;
  }
  return out;
}

async function bookConfirmedKalshiFills(pending, evt) {
  const quoteId = evt.quoteId || null;
  const orderId = evt.orderId || null;
  if (quoteId && orderId) persistQuoteOrder(quoteId, orderId);
  let apiFills = [];
  try {
    apiFills = await fetchKalshiFillsForOrder(orderId);
  } catch (e) {
    console.error(`[${MODE}] quote_executed fill confirm failed`, e.message);
    return { contracts: 0, newContracts: 0, reason: 'confirm-failed', partial: false };
  }
  const booked = bookFromQuoteExecution({ orderId, fills: apiFills });
  if (booked.reason !== 'confirmed') {
    return { contracts: 0, newContracts: 0, reason: booked.reason, partial: false };
  }
  let added = 0;
  for (const row of booked.book) {
    seenFillIds.add(row.fill_id);
    const existing = await findComboFill(row.fill_id);
    const stored = {
      ...row,
      parlay_id: (pending && pending.parlayId) || null,
      is_combo: true,
    };
    try {
      const { error } = await supabase.from('combo_fills').upsert(stored, { onConflict: 'fill_id' });
      if (error) {
        console.error(`[${MODE}] confirmed fill upsert failed`, error.message);
        continue;
      }
    } catch (e) {
      console.error(`[${MODE}] confirmed fill upsert failed`, e.message);
      continue;
    }
    // Already stored (or the lookup failed): refresh owns the cap. Only a
    // newly inserted portfolio fill moves max_contracts in this process.
    if (existing) continue;
    const n = Number(row.count);
    if (Number.isFinite(n)) added += n;
  }
  const quoted = evt.contracts != null ? Number(evt.contracts) : Number(pending && pending.contracts);
  const partial = Number.isFinite(quoted) && quoted > 0 && booked.contracts + 1e-9 < quoted;
  if (quoteId && booked.contracts > 0) {
    try {
      const patch = { status: 'filled', order_id: orderId, is_live: true };
      if (evt.marketTicker) patch.market_ticker = evt.marketTicker;
      const { error } = await supabase.from('combo_submissions').update(patch).eq('quote_id', quoteId);
      if (error) console.error(`[${MODE}] stamp confirmed fill failed`, error.message);
    } catch (e) {
      console.error(`[${MODE}] stamp confirmed fill failed`, e.message);
    }
  }
  return { contracts: booked.contracts, newContracts: added, reason: 'confirmed', partial };
}

function withBudget(promise, ms) {
  let t;
  const timeout = new Promise((resolve) => { t = setTimeout(() => resolve(0), ms); if (t.unref) t.unref(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

const KALSHI_WATCH_MS = [3000, 10000, 25000, 60000, 120000];
function startKalshiFillWatch(pending, quoteId, orderId) {
  if (!capBook.enabled || !pending || !pending.parlayId || !quoteId) return;
  KALSHI_WATCH_MS.forEach((ms) => {
    const t = setTimeout(async () => {
      try {
        if (!capBook.has(pending.parlayId, quoteId)) return;
        const confirmed = await bookConfirmedKalshiFills(pending, { quoteId, orderId, contracts: pending.contracts });
        if (confirmed.newContracts > 0) {
          console.log(`[${MODE}] WATCHDOG booked kalshi quote_id=${quoteId} contracts=${confirmed.newContracts} after ${ms}ms`);
          sessionFilledByParlay[pending.parlayId] = (sessionFilledByParlay[pending.parlayId] || 0) + confirmed.newContracts;
          filledByParlay[pending.parlayId] = (filledByParlay[pending.parlayId] || 0) + confirmed.newContracts;
          releaseConfirmedFill(capBook, {
            parlayId: pending.parlayId, quoteId, partial: confirmed.partial, contracts: confirmed.newContracts,
          });
        }
      } catch (e) {
        console.error(`[${MODE}] kalshi fill watchdog`, e && e.message);
      }
    }, ms);
    if (t.unref) t.unref();
  });
}

// Resolver check for a Kalshi confirm hold.
async function checkKalshiHold(row) {
  let sub = null;
  try {
    const { data } = await supabase
      .from('combo_submissions')
      .select('order_id,status')
      .eq('quote_id', row.quoteId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    sub = data || null;
  } catch (_) { sub = null; }
  let orderId = sub && sub.order_id;
  if (!orderId) {
    try {
      const { statusCode, json } = await kalshiGet(`/trade-api/v2/communications/quotes/${row.quoteId}`);
      if (statusCode === 404 || !json) return { state: 'unknown' };
      const q = json.quote || json;
      const st = String(q.status || '').toLowerCase();
      if (st === 'cancelled' || st === 'canceled' || st === 'expired' || st === 'deleted') return { state: 'cancelled' };
      orderId = q.creator_order_id || q.creatorOrderId || null;
      if (!orderId) return { state: 'open' };
    } catch (e) { return { state: 'unknown', error: e && e.message }; }
  }
  let fills;
  try { fills = await fetchKalshiFillsForOrder(orderId); } catch (e) { return { state: 'unknown', error: e && e.message }; }
  if (fills.length) {
    let unbooked = 0;
    for (const f of fills) {
      const id = f.fill_id || f.trade_id;
      const existing = await findComboFill(id);
      if (!existing) unbooked += Number(f.count_fp != null ? f.count_fp : f.count) || 0;
    }
    return unbooked > 0
      ? { state: 'filled_unbooked', contracts: unbooked, orderId }
      : { state: 'booked' };
  }
  try {
    const { statusCode, json } = await kalshiGet(`/trade-api/v2/portfolio/orders/${orderId}`);
    if (statusCode === 404 || !json) return { state: 'unknown', orderId };
    const o = json.order || json;
    const st = String(o.status || '').toLowerCase();
    if (st === 'canceled' || st === 'cancelled') return { state: 'cancelled' };
    if (st === 'executed') return { state: 'booked' };
    return { state: 'open', orderId };
  } catch (e) { return { state: 'unknown', error: e && e.message }; }
}

async function rebookKalshiHold(row, res) {
  const pending = {
    parlayId: row.parlayId, quoteId: row.quoteId, rfqId: row.meta && row.meta.rfqId,
    label: row.meta && row.meta.label, contracts: row.meta && row.meta.contracts,
    userId: row.meta && row.meta.userId,
  };
  const confirmed = await bookConfirmedKalshiFills(pending, {
    quoteId: row.quoteId, orderId: res && res.orderId, contracts: pending.contracts,
  });
  if (confirmed.newContracts > 0) {
    sessionFilledByParlay[row.parlayId] = (sessionFilledByParlay[row.parlayId] || 0) + confirmed.newContracts;
    filledByParlay[row.parlayId] = (filledByParlay[row.parlayId] || 0) + confirmed.newContracts;
    releaseConfirmedFill(capBook, {
      parlayId: row.parlayId, quoteId: row.quoteId, partial: confirmed.partial, contracts: confirmed.newContracts,
    });
  }
}

const holdResolver = createHoldResolver({
  book: capBook,
  check: (row) => (row.meta && row.meta.venue === 'polymarket'
    ? (polyLoop && polyLoop.checkHold ? polyLoop.checkHold(row) : { state: 'unknown' })
    : checkKalshiHold(row)),
  onFilledUnbooked: (row, res) => (row.meta && row.meta.venue === 'polymarket'
    ? (polyLoop && polyLoop.rebookHold ? polyLoop.rebookHold(row, res) : null)
    : rebookKalshiHold(row, res)),
  log: (m) => console.log(`[${MODE}] ${m}`),
});

function resolveHolds(parlayId) {
  return holdResolver.resolveParlay(parlayId);
}

async function onQuoteExecuted(evt) {
  if (!evt) return;
  const looked = resolveFillLookup(evt);
  let quoteId = looked.quoteId;
  const orderId = looked.orderId;
  if (!quoteId && !orderId) return;
  const fillKey = fillKeyOf(evt);
  if (!claimFillKey(seenFillIds, fillKey)) {
    console.log(`[${MODE}] quote_executed duplicate fill_id=${fillKey}`);
    return;
  }

  let pending = evt.pending || null;
  let fromMemory = !!pending;
  if (!pending) {
    const hit = findPendingFill([pendingQuotes, polyPendingQuotes], quoteId, orderId);
    if (hit) {
      pending = hit.pending;
      quoteId = quoteId || hit.pendingId;
      fromMemory = true;
    }
  }
  if (!pending) {
    pending = await pendingFromSubmission({ quoteId, orderId });
    if (!pending) {
      console.log(`[${MODE}] quote_executed unknown quote_id=${quoteId || '?'} order_id=${orderId || '?'}`);
      return;
    }
    quoteId = quoteId || pending.quoteId;
    console.log(`[${MODE}] quote_executed recovered quote_id=${quoteId} from combo_submissions`);
  }
  if (!quoteId && pending && pending.parlayId) {
    quoteId = evt.fillId || orderId || `poly-orphan:${pending.parlayId}`;
  }
  if (!quoteId) {
    console.log(`[${MODE}] quote_executed missing quote_id order_id=${orderId || '?'}`);
    return;
  }

  const venue = fillVenueOf(evt);
  let contracts = evt.contracts != null ? evt.contracts : pending.contracts;
  let partial = !!evt.isPartial;
  if (venue !== 'polymarket') {
    // Orders are on the book. The quote is no longer outstanding, whether
    // or not any of it has traded.
    pendingQuotes.delete(quoteId);
    const confirmed = await bookConfirmedKalshiFills(pending, { ...evt, quoteId, orderId });
    if (!(confirmed.newContracts > 0)) {
      console.log(
        `[${MODE}] quote_executed no portfolio fill quote_id=${quoteId} order_id=${orderId || '?'} ` +
        `quoted=${evt.contracts != null ? evt.contracts : pending.contracts} reason=${confirmed.reason}`
      );
      // The confirm hold stays (the order may still fill). Re-check on a short
      // ladder; a hold is only released once the fill is booked or the order is dead.
      startKalshiFillWatch(pending, quoteId, orderId);
      return;
    }
    contracts = confirmed.newContracts;
    partial = confirmed.partial;
  } else {
    await persistExecutedFill(pending, { ...evt, quoteId, orderId, venue });
    // Restart replay of the same full fill: persist is idempotent; do not
    // re-count or re-Telegram. Partials keep a distinct fill_id so they add.
    if (!fromMemory && pending.alreadyFilled && !evt.isPartial) {
      pendingQuotes.delete(quoteId);
      polyPendingQuotes.delete(quoteId);
      return;
    }
  }

  sessionFilledByParlay[pending.parlayId] =
    (sessionFilledByParlay[pending.parlayId] || 0) + contracts;
  if (venue !== 'polymarket' && pending.parlayId) {
    filledByParlay[pending.parlayId] = (filledByParlay[pending.parlayId] || 0) + contracts;
  }
  // Actual size is already in the cap. Drop the confirm hold in the same turn
  // so the next accept cannot see neither number.
  releaseConfirmedFill(capBook, {
    parlayId: pending.parlayId,
    quoteId,
    partial,
    contracts,
  });
  if (!evt.overfillFlagged) {
    const over = overfillOf(pending.contracts, contracts);
    if (over) {
      console.warn(formatOverfillLog(MODE, { ...over, label: pending.label, quoteId }));
      sendAlert(formatOverfillAlert({
        ...over,
        venue,
        label: pending.label,
        quoteShort: shortId(quoteId),
      })).catch(() => {});
    }
  }
  if (!partial) {
    pendingQuotes.delete(quoteId);
    polyPendingQuotes.delete(quoteId);
  }
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

  const venueTag = venue === 'polymarket' ? ' POLY' : '';
  console.log(
    `[${MODE}] FILL CONFIRMED${venueTag} ${pending.label} quote_id=${quoteId} order_id=${orderId} ` +
    `contracts=${contracts} sessionTotal=${sessionTotal}` +
    (fullyFilled ? ' FULL' : '') +
    (partial ? ' PARTIAL' : '')
  );
  sendAlert(
    `${formatAlertStatus('✅ FILL CONFIRMED', venue)} — ${pending.label}\n` +
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
  // Count dollar sizing on the book BEFORE match. Production dollarRfqs=0
  // with matched=0 was an accounting hole (increment lived after matchParlay),
  // not proof the firehose had no dollar RFQs.
  if (rfq.targetCostDollars > 0) counts.dollarRfqs++;
  if (counts.combos <= 12) {
    const keys = rfq.legKeys || [];
    const sampleN = counts.combos;
    const sampleRfq = rfq;
    setImmediate(() => {
      console.log(
        `[${MODE}] RFQ-SAMPLE n=${sampleN} rfq=${sampleRfq.rfqId} ` +
        `contracts=${sampleRfq.contracts != null ? sampleRfq.contracts : '(none)'} ` +
        `dollar=${sampleRfq.targetCostDollars != null ? `$${sampleRfq.targetCostDollars}` : '(none)'} ` +
        `legs=${keys.length} keys=${keys.join('|') || '(none)'}`
      );
    });
  }

  const p = matchParlay(rfq, parlays);
  const intakeAgeMs = p ? latency.noteIntake(rfq.createdTs) : null;
  if (p && intakeAgeMs != null && intakeAgeMs > STALE_RFQ_MS) {
    // Delivered late (reconnect gap / backlog). Kalshi has almost surely closed it (the 234
    // rfq_closed 409s had a median RFQ age of 15s) and no quote older than 1s ever filled.
    // Skip the POST instead of burning a request + a 409.
    latency.noteStaleSkip();
    if (latency.staleSkipsTotal() <= 5 || latency.staleSkipsTotal() % 50 === 0) {
      console.log(`[${MODE}] STALE RFQ skipped rfq=${rfq.rfqId} age=${Math.round(intakeAgeMs)}ms (> ${STALE_RFQ_MS}ms) n=${latency.staleSkipsTotal()}`);
    }
    return;
  }
  if (!p) {
    // lockMiss ≠ noLock. noLock is "matched a parlay but hedge does not lock".
    // lockMiss is "combo RFQ did not hit any staged parlay" — the quiet-Kalshi
    // failure mode (exact ticker miss / empty legs).
    const keys = rfq.legKeys || [];
    if (!keys.length) {
      counts.emptyLegs++;
      if (counts.emptyLegs <= 8) {
        const missRfq = rfq;
        const raw = env && env.msg && typeof env.msg === 'object' ? env.msg : {};
        setImmediate(() => {
          const nested = raw.rfq && typeof raw.rfq === 'object' ? raw.rfq : {};
          console.log(
            `[${MODE}] EMPTY-LEGS rfq=${missRfq.rfqId} ` +
            `msgKeys=${Object.keys(raw).join(',') || '(none)'} ` +
            `nestedKeys=${Object.keys(nested).join(',') || '(none)'} ` +
            `collection=${missRfq.mveCollection || '(none)'} ` +
            `contracts=${missRfq.contracts != null ? missRfq.contracts : '(none)'} ` +
            `dollar=${missRfq.targetCostDollars != null ? `$${missRfq.targetCostDollars}` : '(none)'}`
          );
        });
      }
    }
    counts.lockMiss++;
    const nowMiss = Date.now();
    if (nowMiss - lastLockMissLogAt >= LOCK_MISS_LOG_MS) {
      lastLockMissLogAt = nowMiss;
      const missId = rfq.rfqId;
      const missLegs = keys.length;
      const activeCount = parlays.length;
      setImmediate(() => {
        console.log(
          `[${MODE}] LOCK-MISS rfq=${missId} legs=${missLegs} activeCount=${activeCount}`
        );
      });
    }
    // Combo Locks miss — unhedged paper tape is the other Railway job.
    // WORKER_MODE=all keeps the old in-process shadow (yielded).
    if (runUnhedged) {
      const missRfq = rfq;
      const missExtra = env && env.msg ? { msg: env.msg } : null;
      setImmediate(() => {
        shadowUnhedgedMiss(missRfq, {
          venue: 'kalshi',
          extra: missExtra,
          persist: persistUnhedgedRow,
          supabase,
          env: process.env,
          priceCache: unhedgedPrices,
          onPersisted: (row) => {
            if (unhedgedFills) {
              unhedgedFills.remember({
                ...row,
                market_ticker: missRfq.marketTicker || missRfq.market_ticker || null,
              });
            }
          },
        });
      });
    }
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
    isFreeBet: isFreeBetRow(p),
    subcent: SUBCENT,
  });

  if (!d.ok) {
    if (d.reason === 'quote_below_target') {
      counts.declined++;
      console.error(
        `[${MODE}] SKIP quote_below_target ${p.label} rfq=${rfq.rfqId} no_bid=${d.quotedNoBid} fill=${p.fill_american}`
      );
      logAsync(p, rfq, null, 'declined');
      return;
    }
    if (d.reason === 'no_cap') {
      counts.declined++;
      console.log(
        `[${MODE}] SKIP no cap ${p.label} rfq=${rfq.rfqId} — free bet riskfree with max_contracts=${p.max_contracts}; not quoting`
      );
      logAsync(p, rfq, null, 'declined');
      return;
    }
    if (d.reason === 'limit_reached') {
      counts.limitReached++;
      console.log(
        `[${MODE}] LIMIT REACHED ${p.label} rfq=${rfq.rfqId} — ` +
        `filled=${filledSoFar} ${exposureBit(outstanding)} ${filledSoFar + outstanding}/${d.totalLimit}`
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
      const wouldClip = partialQuote.note({
        venue: 'kalshi', parlayId: p.id, rfqContracts: size.contracts, remaining: d.remaining,
      });
      if (wouldClip > 0) counts.partialWouldQuote = (counts.partialWouldQuote || 0) + 1;
      console.log(
        `[${MODE}] SKIP oversized RFQ ${p.label} rfq=${rfq.rfqId} ` +
        `want=${size.contracts} remaining=${d.remaining}/${d.totalLimit} ` +
        `filled=${filledSoFar} ${exposureBit(outstanding)}` +
        (wouldClip > 0 ? ` partial_would_quote=${wouldClip}` : '')
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

  const fingerprint = fingerprintRfq(rfq);
  const cooldownFp = cooldownFingerprint(rfq);
  const peeked = cooldownFp ? repeatGuard.peek(cooldownFp) : { skip: false, gated: false };
  const claimed = peeked.skip ? repeatGuard.noteSkip(cooldownFp) : peeked;
  if (claimed.skip) {
    counts.rfqRepeat++;
    const extra = {
      ...skipPersistExtra({
        skipReason: REPEAT_SKIP_REASON,
        contracts: size.contracts != null ? size.contracts : rfq.contracts,
        remaining: d && d.remaining != null ? d.remaining : null,
        marketTicker: rfq.marketTicker,
      }),
      rfq_fingerprint: fingerprint,
    };
    logAsync(p, rfq, d, 'declined', extra);
    console.log(
      `[${MODE}] SKIP ${REPEAT_SKIP_REASON} ${p.label} rfq=${rfq.rfqId} ` +
      `fp=${fingerprint} remaining=${claimed.remainingMs}ms skips=${claimed.skipCount}`
    );
    if (claimed.alert) {
      sendAlert(formatRepeatSkipAlert({
        label: p.label,
        contracts: size.contracts != null ? size.contracts : rfq.contracts,
        cooldownMs: claimed.cooldownMs,
        skipCount: claimed.skipCount,
        venue: 'kalshi',
      })).catch(() => {});
    }
    return;
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
      let result;
      let sentNoBid = noBid;
      let sentYesBid = yesBid;
      try {
        result = await postQuote(rfq.rfqId, sentNoBid, sentYesBid, restRemainder);
        if (SUBCENT) subcentGridFails = 0;
      } catch (firstErr) {
        // Sub-cent price rejected as off-grid: retry ONCE at the penny floor (never above the
        // sub-cent price, so still never worse than the lock target) instead of losing the RFQ.
        if (!(SUBCENT && isSubcentPrice(noBid) && isPriceGridFailure(firstErr.message))) throw firstErr;
        sentNoBid = pennyNoBid(noBid);
        sentYesBid = quoteYesBid(size.source, sentNoBid);
        console.error(
          `[${MODE}] SUBCENT price rejected no_bid=${noBid} yes_bid=${yesBid} — retry penny no_bid=${sentNoBid}: ${firstErr.message}`
        );
        result = await postQuote(rfq.rfqId, sentNoBid, sentYesBid, restRemainder);
        counts.subcentFallback = (counts.subcentFallback || 0) + 1;
        latency.noteSubcentFallback();
        subcentGridFails += 1;
        if (subcentGridFails >= SUBCENT_LATCH_AFTER) {
          SUBCENT = false;
          staged = {};
          console.error(`[${MODE}] SUBCENT latched OFF after ${subcentGridFails} consecutive off-grid rejections — penny quoting until redeploy`);
          sendAlert(`⚠️ KALSHI_SUBCENT latched OFF (venue rejected sub-cent prices ${subcentGridFails}x). Quoting at the cent until redeploy.`).catch(() => {});
        }
      }
      const t3 = performance.now();
      const reservedContracts = size.source === 'dollar'
        ? contractsFromQuoteResponse(result, d.contracts)
        : d.contracts;
      const totalMs = (t3 - t0).toFixed(1);

      // Step 0 — latency log
      console.log(formatQuoteLatency({
        matchMs: (t1 - t0).toFixed(1),
        preMs: (t2 - t1).toFixed(1),
        postMs: (t3 - t2).toFixed(1),
        totalMs,
        rfqId: rfq.rfqId,
        quoteId: result.id,
      }));

      counts.posted++;
      const postNote = latency.notePost({ totalMs: t3 - t0, createdTs: rfq.createdTs, ok: true });
      if (postNote.late) {
        console.log(`[${MODE}] LATE POST ok rfq=${rfq.rfqId} rfq_age=${Math.round(postNote.ageMs)}ms post=${(t3 - t2).toFixed(1)}ms`);
      }
      pendingQuotes.delete(reserveKey);
      pendingQuotes.set(result.id, pendingEntry(p, rfq, reservedContracts, { yesBid: sentYesBid }));

      console.log(
        `[${MODE}] QUOTED ${p.label} rfq=${rfq.rfqId} quote_id=${result.id} ` +
        `contracts=${reservedContracts} yes_bid=${sentYesBid} no_bid=${sentNoBid}` +
        `${d.subcent ? ` subcent eff=${d.quotedEffAmerican} worstAtQuote=$${d.worstAtQuote}` : ''} ` +
        `${exposureBit(capBook.enabled ? outstanding : outstanding + reservedContracts)}/${d.totalLimit} locks=${d.locks}`
      );

      // REST may return rfq_creator_id after we already posted. Persist it
      // for History; start the creator-gated window only after POST landed.
      if (cooldownFp) repeatGuard.claim(cooldownFp);
      const restCreator = creatorIdFromQuoteResponse(result);
      const quotedFingerprint = restCreator && !rfq.creatorId
        ? fingerprintRfq({ ...rfq, creatorId: restCreator })
        : fingerprint;
      if (restCreator && !cooldownFp) {
        const learned = cooldownFingerprint({ ...rfq, creatorId: restCreator });
        if (learned) repeatGuard.claim(learned);
      }

      // Fire-and-forget after POST (Step 1)
      logAsync(p, rfq, d, 'quoted', {
        quote_id: result.id, is_live: true, contracts: reservedContracts,
        rfq_fingerprint: quotedFingerprint,
      });
      sendAlert(
        `${formatAlertStatus('✅ QUOTED', 'kalshi')} — ${p.label}\n` +
        `rfq ${shortId(rfq.rfqId)} · quote ${shortId(result.id)}\n` +
        `match→POST ${totalMs}ms\n` +
        `${reservedContracts} contracts · NO @ $${sentNoBid}` +
        (size.source === 'dollar' ? ` · YES @ $${sentYesBid}` : '') +
        (p.fill_american != null ? ` · ${sgn(p.fill_american)}` : '')
      ).catch(() => {});
    } catch (e) {
      pendingQuotes.delete(reserveKey);
      const t3 = performance.now();
      const failReason = quotePostFailReason(e.message) || 'error';
      const totalMs = (t3 - t0).toFixed(1);
      console.log(formatQuoteLatency({
        matchMs: (t1 - t0).toFixed(1),
        preMs: (t2 - t1).toFixed(1),
        postMs: (t3 - t2).toFixed(1),
        totalMs,
        rfqId: rfq.rfqId,
        failReason,
      }));
      counts.postFailed++;
      const closed = isRfqClosedFailure(e.message);
      const failNote = latency.notePost({ totalMs: t3 - t0, createdTs: rfq.createdTs, ok: false, rfqClosed: closed });
      console.error(
        `[${MODE}] POST FAILED${closed ? ' rfq_closed' : ''} ${p.label} ` +
        `rfq=${rfq.rfqId} in ${totalMs}ms` +
        (failNote.ageMs != null ? ` rfq_age=${Math.round(failNote.ageMs)}ms` : ''),
        e.message
      );
      if (quoteFailureSkipReason(e.message)) {
        logFundingSkip(p, rfq, d, { costDollars: quoteCostDollars(d && d.contracts, noBid) });
      } else if (closed) {
        logAsync(p, rfq, d, 'unfilled', {
          skip_reason: 'rfq_closed',
          rfq_fingerprint: fingerprint,
        });
      } else {
        logAsync(p, rfq, d, 'unfilled');
      }
      if (!isSilentQuoteFailure(e.message)) {
        sendAlert(
          closed
            ? `${formatAlertStatus('❌ QUOTE LATE', 'kalshi')} — ${p.label}\n` +
              `rfq ${shortId(rfq.rfqId)} already closed\n` +
              `match→POST ${totalMs}ms\n` +
              `${e.message}`
            : `${formatAlertStatus('❌ QUOTE FAILED', 'kalshi')} — ${p.label}\nrfq ${shortId(rfq.rfqId)}\n${e.message}`
        ).catch(() => {});
      }
    }
    return;
  }

  // Kill-switch engaged → shadow only (not latency-critical)
  logAsync(p, rfq, d, 'shadow', { rfq_fingerprint: fingerprint });
  console.log(
    `[${MODE}] SHADOW ${p.label} rfq=${rfq.rfqId} wouldSell=${d.contracts} noBid=${noBid}`
  );
}

async function main() {
  if (workerMode === 'unhedged') {
    console.error(
      `[${MODE}] WORKER_MODE=unhedged — use start-unhedged.js / npm run start:unhedged`
    );
    process.exit(1);
  }
  if (!KEY_ID || !PEM || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error(
      `[${MODE}] missing env: need KALSHI_KEY_ID, Kalshi_combo_key, SUPABASE_URL, SUPABASE_SERVICE_KEY`
    );
    process.exit(1);
  }
  bucketManager = createBucketManager({
    env: process.env,
    alert: (text) => sendAlert(text),
    appAlerts: createAppAlerts({ client: supabase }),
    signed: (method, signPath, opts) => kalshiSigned(method, signPath, opts),
  });
  bucketManager.start();

  console.log(
    `[${MODE}] starting — latency-optimized. POST first, dedicated quote HTTP, ` +
    `firehose yield while quote-hot, quote warm ${QUOTE_WARM_MS}ms, pre-staged prices. ` +
    `Auto-confirms quote_accepted (HVM ~3s window). ` +
    `Kalshi communications shard_factor=${readShardFactor(undefined, process.env, DEFAULT_LIVE_SHARD_FACTOR)} ` +
    `(KALSHI_WS_SHARD_FACTOR, 1 = one unsharded socket). ` +
    `Non-lock rfq_created frames drop before JSON.parse when every lock has a needle. ` +
    `Remaining = max - filled - ${capBook.enabled ? 'in-flight confirms' : 'outstanding quotes'} (Kalshi + Polymarket). ` +
    `COMBO_CAP_AT_CONFIRM=${capBook.enabled ? 'on' : 'off'}. ` +
    `Unaccepted quotes are DELETE'd after ${RESERVE_TTL_MS / 1000}s. ` +
    `rfq_deleted releases immediately. ` +
    `Skipped oversized/cap RFQs get a targeted tape lookup after close. ` +
    `RFQ repeat ${repeatGuard.maxQuotes} quotes then ${repeatGuard.cooldownMs}ms dark creator-gated ` +
    `(RFQ_REPEAT_MAX_QUOTES / RFQ_REPEAT_COOLDOWN_MS; 0 cooldown disables; empty creator_id always quotes). ` +
    `WORKER_MODE=${workerMode}. ` +
    (runUnhedged
      ? `Unhedged RFQ shadow in-process (UNHEDGED_RFQ_SHADOW=${isUnhedgedRfqShadow(process.env) ? 'on' : 'off'}, ` +
        `UNHEDGED_RFQ_LIVE=${isUnhedgedRfqLive(process.env) ? 'on' : 'off'}) — never posts.`
      : 'Unhedged /markets, fill ticks, and shadow miss are off — run npm run start:unhedged.')
  );

  if (runUnhedged) {
    unhedgedSide = startUnhedgedSide({
      supabase,
      env: process.env,
      kalshiGet,
      shouldPause: () => quoteHot.inFlight,
    });
    unhedgedPrices = unhedgedSide.prices;
    unhedgedFills = unhedgedSide.fills;
    polyUnhedgedHttp = unhedgedSide.polyHttp;
  }

  await refresh();
  setInterval(unlessQuoteHot(() => { refresh(); }), 30000);
  setInterval(unlessQuoteHot(() => {
    cancelUnacceptedQuotes().catch((e) => console.error(`[${MODE}] cancel-unaccepted tick`, e.message));
    cancelPendingIfStarted().catch((e) => console.error(`[${MODE}] cancel-on-start tick`, e.message));
    cancelStragglersForPaused();
  }), 2000);
  // Confirm holds are never dropped on a timer: verify the stale ones against the venue.
  setInterval(() => {
    holdResolver.tick().catch((e) => console.error(`[${MODE}] hold resolver`, e && e.message));
  }, 15000);
  setInterval(unlessQuoteHot(() => {
    pollPaused().catch((e) => console.error(`[${MODE}] pause poll`, e.message));
  }), 5000);
  setInterval(unlessQuoteHot(() => {
    reconcileSkipTapes().catch((e) => console.error(`[${MODE}] skip-tape tick`, e.message));
  }), SKIP_TAPE_TICK_MS);

  // Step 2 — pre-warm + keep warm (15s so LB idle-kill cannot cold-start POST)
  await warmConnection();
  setInterval(warmConnection, QUOTE_WARM_MS);

  if (isPartialQuoteFlagOn()) {
    console.log(
      `[${MODE}] COMBO_PARTIAL_QUOTE_OVERSIZED is ON but no venue can quote fewer contracts than the RFQ ` +
      `(Kalshi/Polymarket US quotes carry no size) — still dry-run only, no order-flow change`
    );
  }
  loopLag = createLoopLagSampler();
  const partialTimer = setInterval(() => { partialQuote.tick(); }, 60 * 1000);
  if (partialTimer.unref) partialTimer.unref();
  let polyHeartbeatSnap = null;
  startHeartbeat(
    supabase, MODE, counts, () => parlays.length, 60000,
    () => {
      const snap = polyHeartbeatSnap;
      polyHeartbeatSnap = null; // each interval is persisted once
      let lat = null;
      try {
        lat = latency.rollInterval({
          ws: latencyClient && latencyClient.takeReconnects ? latencyClient.takeReconnects() : null,
          loop: loopLag ? loopLag.take() : null,
          extra: (() => {
            const h = latencyClient && latencyClient.health ? latencyClient.health() : null;
            return h ? { ws_backlog: h.backlog, shards_up: h.shardsUp, shard_factor: h.shardFactor } : null;
          })(),
        });
        console.log(latency.formatLine(lat));
      } catch (e) { lat = null; }
      return {
        ...(snap ? { poly: snap } : {}),
        partial_quote: partialQuote.statsJson(),
        ...(lat ? { latency: lat } : {}),
        ...(bucketManager && bucketManager.snapshot && bucketManager.snapshot()
          ? { bucket: bucketManager.snapshot() } : {}),
      };
    }
  );

  const polyAppAlerts = createAppAlerts({ client: supabase });
  const polyStallAlerts = createPolyStallAlerts({ appAlerts: polyAppAlerts, log: console.log });
  { const t = setInterval(() => { polyStallAlerts.tick().catch(() => {}); }, 30000); if (t.unref) t.unref(); }
  const poly = startPolymarketRfqLoop({
    pendingQuotes: polyPendingQuotes,
    kalshiPendingQuotes: pendingQuotes,
    capBook,
    getOutstanding: outstandingFor,
    getParlays: () => parlays,
    filledSoFarFor,
    freshFilledFor,
    resolveHolds,
    killEngagedFor,
    startedFor: startedForParlay,
    logAsync: (p, rfq, d, status, extra = {}) =>
      logAsync(p, rfq, d, status, withVenue(extra, 'polymarket')),
    persistQuoteSkip: (quoteId, skipReason, fallback) =>
      persistQuoteSkip(quoteId, skipReason, fallback, 'polymarket'),
    persistQuoteOrder,
    loadUnfilledPolyQuotes,
    getFilledForQuote,
    loadRecentLocks,
    loadPolySlugRecords,
    seenFillIds,
    initialFillReconcile: true,
    sendAlert,
    onPolyHeartbeat: (snap) => { polyHeartbeatSnap = snap; },
    // Silent Poly WS stall (socket open, no messages): the client terminates +
    // reconnects. A self-healed stall is an INFO row resolved on recovery (hidden
    // from the banner); 3+ stalls/hour or an unrecovered one escalates to WARN.
    onWsStall: (info) => polyStallAlerts.onStall(info),
    onWsRecovered: () => polyStallAlerts.onRecovered(),
    // Poly REST crawl pages wait while a Kalshi quote POST/confirm is in flight.
    shouldPause: () => quoteHot.inFlight,
    counts,
    sessionFilledByParlay,
    supabase,
    env: process.env,
    enableLocks: true,
    enableUnhedged: runUnhedged,
    unhedgedPrices: runUnhedged ? unhedgedPrices : null,
    unhedgedFills: runUnhedged ? unhedgedFills : null,
    http: (runUnhedged && polyUnhedgedHttp) || undefined,
    onQuoteExecuted: (evt) => onQuoteExecuted({
      ...evt,
      venue: (evt && evt.venue) || 'polymarket',
    }).catch((e) => console.error('onQuoteExecuted', e)),
  });
  polyLoop = poly;

  const wsAlerter = createWsStatusAlerter();
  const shardFactor = readShardFactor(undefined, process.env, DEFAULT_LIVE_SHARD_FACTOR);

  const client = createKalshiFirehose({
    keyId: KEY_ID,
    pem: PEM,
    shardFactor,
    onStatus: noteWsStatus,
    shouldDeferCreated: (raw) => quoteHot.shouldDeferCreated(raw),
    shouldDropCreated: (raw) => quoteHot.shouldDropCreated(raw),
    // rfq_deleted for an RFQ we hold no reserve/quote on is dropped before JSON.parse.
    // Off when unhedged shares this process (it needs every close) or KALSHI_WS_DROP_DELETED=0.
    shouldDropDeleted: (runUnhedged || dropDeletedDisabled(process.env))
      ? undefined
      : createDeletedFilter((cb) => { pendingQuotes.forEach((q) => cb(q && q.rfqId)); }),
    onRfqCreated: (rfq, env) => onRfq(rfq, env).catch((e) => console.error('onRfq', e)),
    onRfqDeleted: (evt, env) => { try { onRfqDeleted(evt, env); } catch (e) { console.error('onRfqDeleted', e); } },
    onQuoteAccepted: (evt) => onQuoteAccepted(evt).catch((e) => console.error('onQuoteAccepted', e)),
    onQuoteExecuted: (evt) => onQuoteExecuted(evt).catch((e) => console.error('onQuoteExecuted', e)),
  });

  function noteWsStatus(s, info) {
    const h = client.health ? client.health() : null;
    const enriched = Object.assign({}, info || {}, {
      shardFactor: h && h.shardFactor,
      shardsUp: h && h.shardsUp,
      shardsDown: h && h.shardsDown,
    });
    console.log(`[${MODE}] ws:${s}`, enriched);
    if (!wsAlerter.shouldAlert(s, enriched)) return;
    sendAlert(formatWsAlert(s, enriched)).catch(() => {});
  }

  setInterval(() => {
    const snap = client.takeThroughput ? client.takeThroughput() : null;
    if (!snap) return;
    console.log(`[${MODE}] ws-throughput`, Object.assign(summarizeThroughput(snap), {
      fastDrop: quoteHot.fastDropEnabled(),
      needles: quoteHot.getNeedles().length,
    }));
  }, 30_000);
  setInterval(() => {
    const h = client.health ? client.health() : null;
    const hit = wsAlerter.poll(h ? {
      shardFactor: h.shardFactor,
      shardsUp: h.shardsUp,
      shardsDown: h.shardsDown,
    } : null);
    if (!hit) return;
    sendAlert(formatWsAlert(hit.s, hit.info)).catch(() => {});
  }, 1000);
  setInterval(() => {
    const h = client.health ? client.health() : null;
    const age = h && h.stalestAgeMs != null
      ? h.stalestAgeMs
      : (h && h.lastCommAt ? Date.now() - h.lastCommAt : null);
    console.log(`[${MODE}] tallies`, {
      ...counts,
      kalshiWsAgeMs: age,
      kalshiWsStallMs: h && h.stallMs,
      shardsUp: h && h.shardsUp,
      shardFactor: h && h.shardFactor,
      wsBacklog: h && h.backlog,
      wsLoopLagMs: h && h.loopLagMs,
      wsRecv: h && h.recv,
      wsDrop: h && h.drop,
    });
  }, 60000);
  process.on('SIGINT', () => {
    client.stop();
    try { poly && poly.stop && poly.stop(); } catch (_) {}
    try { unhedgedSide && unhedgedSide.stop && unhedgedSide.stop(); } catch (_) {}
    try { unhedgedPrices && unhedgedPrices.stop && unhedgedPrices.stop(); } catch (_) {}
    try { polyUnhedgedHttp && polyUnhedgedHttp.close && polyUnhedgedHttp.close(); } catch (_) {}
    try { kalshiHttp.close(); } catch (_) {}
    try { kalshiQuoteHttp.close(); } catch (_) {}
    console.log(`[${MODE}] final`, counts);
    process.exit(0);
  });
  latencyClient = client;
  client.start();
}
main();
