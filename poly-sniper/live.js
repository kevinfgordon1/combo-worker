// Polymarket combo sniper — LIVE layer (Kevin Oct 29, preview). Runs inside poly-worker, the only app
// with the Polymarket keys; the keys never leave it. Built on top of the Phase 1 dry run (engine.js
// prices every RFQ; this module posts, confirms, cancels and books).
//
// Safety model
//   * POLY_SNIPER_DRY_RUN=1 (hard fallback): this module is never created and never sees a client.
//   * POLY_SNIPER_DRY_RUN=0: live-CAPABLE. Nothing is posted until the runtime switch
//     public.poly_sniper_control.live is true (default false). Polled every few seconds, so on/off
//     needs no restart. Read errors fail closed (switch treated as off after controlFailOffMs).
//   * Switch off (or daily-loss halt, decline pause, feed stall, SIGTERM): every open sniper quote is
//     deleted, and any accept still in last look is declined.
//   * Caps = the Kalshi sniper's caps (sniperCapsFromEnv). Only REAL exposure counts: resting quotes
//     count $0; an accept being confirmed / a confirmed quote awaiting its fill counts at the accepted
//     size; after the fill is booked, the real filled risk. All caps are re-checked at confirm, inside
//     Polymarket's last-look window, together with a fresh fair price (engine.decidePoly).
//   * Cash floor: never post or confirm if Polymarket buying power minus the new risk would fall below
//     POLY_SNIPER_CASH_FLOOR_USD, so Combo Locks stays funded. Unknown / stale balance = no trading.
//   * Rate limits: sniper posts <= POLY_SNIPER_POST_RPS (20/s) and cancels <= POLY_SNIPER_CANCEL_RPS
//     (50/s, POLY_SNIPER_CANCEL_CONCURRENCY in flight), on their own buckets (Polymarket US: quote create
//     and quote delete each have their own 100 req/s venue bucket). A sniper confirm waits (briefly) for
//     any Combo Locks confirm in flight: Combo Locks always goes first.
//   * Max quote life (Kevin Oct 30: "no quote alive more than 20 seconds"): POLY_SNIPER_MAX_QUOTE_LIFE_MS
//     (20s). Polymarket US CreateQuote has no expiry field, so we enforce it ourselves: every quote is
//     deleted at POLY_SNIPER_QUOTE_TTL_MS (15s, never more than max life - 5s) by a 1s sweeper. Deletes
//     have strict priority: no new quote is posted while the delete lane is backed up (> 20 pending or
//     oldest pending > 2s) or while any open quote is near the max life. Before Oct 30 the delete lane
//     sent one DELETE at a time, so it fell 100-285s behind ~20 posts/s.
//   * Declines: if sniper declines exceed 10% of sniper accepts over the last hour — or the whole
//     account's (sniper + Combo Locks) do — the sniper pauses (Polymarket pauses makers over 15%,
//     which would also stop Combo Locks). Resumes when the hour window is back under 10%.
//   * Fills: booked from the quote's own order (quoteExecuted / orderExecution on the private WS), with
//     the #308 REST backstop (GetQuotes EXECUTED SELF + GET /v1/order via resolveQuoteFill). Combo
//     Locks' reconcile skips every quote / order / fill the sniper owns (isSniperFill).
'use strict';
const { decidePoly } = require('./engine');
const { resolveQuoteFill, listSelfExecutedQuotes, quoteIdOf, orderIdOfQuote, fetchQuoteByIds, isExecutedQuoteStatus } = require('../polymarket-fill-reconcile');

const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const flag = (v, d) => (v == null || v === '' ? d : !/^(0|false|no|off)$/i.test(String(v).trim()));

// Kalshi sniper caps, as live on kaygo-sniper Oct 29 (summary row caps + fly/sniper.toml):
// per quote $400 risk / $100,000 payout, per game $1,500, per leg $750, (Kevin Oct 30: Poly + Kalshi now $500/quote, $1,000/leg)
// total open $10,000,
// long-dated open $5,000 (settles > 48h after quote), daily new risk $10,000, daily loss stop $10,000,
// soon-cap (settles <= 24h: total cap = cash, never below normal), legs <= 7 days out.
// Every value can be overridden with the POLY_SNIPER_* env of the same name.
function liveConfig(env = process.env) {
  const maxLife = Math.max(6000, num(env.POLY_SNIPER_MAX_QUOTE_LIFE_MS, 20000));
  return {
    maxRisk: num(env.POLY_SNIPER_MAX_RISK, 500),
    maxPayout: num(env.POLY_SNIPER_MAX_PAYOUT, 100000),
    perGameCap: num(env.POLY_SNIPER_PER_GAME_CAP, 1500),
    perLegCap: num(env.POLY_SNIPER_PER_LEG_CAP, 1000),
    totalExposureCap: num(env.POLY_SNIPER_TOTAL_EXPOSURE_CAP, 10000),
    longExposureCap: num(env.POLY_SNIPER_LONG_EXPOSURE_CAP, 5000),
    shortSettleHours: num(env.POLY_SNIPER_SHORT_SETTLE_HOURS, 48),
    dailyRiskCap: num(env.POLY_SNIPER_DAILY_RISK_CAP, 10000),
    dailyLossCap: num(env.POLY_SNIPER_DAILY_LOSS_CAP, 10000),
    soonCap: flag(env.POLY_SNIPER_SOON_CAP, true),
    soonHours: num(env.POLY_SNIPER_SOON_HOURS, 24),
    maxLegDays: num(env.POLY_SNIPER_MAX_LEG_DAYS, 7),
    gameHours: num(env.POLY_SNIPER_GAME_HOURS, 4),          // settle = last kickoff + this (Kalshi sniper rule)
    maxQuotesPerHour: num(env.POLY_SNIPER_MAX_QUOTES_PER_HOUR, 0), // 0 = off (post bucket is the limiter)
    cashFloorUsd: num(env.POLY_SNIPER_CASH_FLOOR_USD, 5000),
    balancePollMs: num(env.POLY_SNIPER_BALANCE_POLL_MS, 30000),
    balanceMaxAgeMs: num(env.POLY_SNIPER_BALANCE_MAX_AGE_MS, 120000),
    postRps: num(env.POLY_SNIPER_POST_RPS, 20),
    cancelRps: num(env.POLY_SNIPER_CANCEL_RPS, 50),
    cancelConcurrency: Math.max(1, Math.floor(num(env.POLY_SNIPER_CANCEL_CONCURRENCY, 10))),
    maxRfqAgeMs: num(env.POLY_SNIPER_MAX_RFQ_AGE_MS, 3000),
    // Kevin Oct 30: no quote may stay alive on Polymarket more than 20s. TTL (when the sweeper deletes it)
    // is clamped to max life - 5s, leaving room for sweep granularity, the delete lane and the DELETE itself.
    maxQuoteLifeMs: maxLife,
    quoteTtlMs: Math.max(1000, Math.min(num(env.POLY_SNIPER_QUOTE_TTL_MS, 15000), maxLife - 5000)),
    // Post gate: no new quote while the delete lane has more than this many pending (queued + in flight),
    // or its oldest pending delete has waited longer than cancelBacklogMs, or any open quote is within
    // ageGuardMs of the max life.
    cancelBacklogMax: num(env.POLY_SNIPER_CANCEL_BACKLOG_MAX, 20),
    cancelBacklogMs: num(env.POLY_SNIPER_CANCEL_BACKLOG_MS, 2000),
    ageGuardMs: num(env.POLY_SNIPER_AGE_GUARD_MS, 2000),
    // DELETE 4xx (Polymarket "400 unable to process"): verify with one GetQuotes read (shares the 1 req/s
    // RFQ budget, so at most one per verifyGapMs); a quote still live is re-deleted up to rejectRetries.
    verifyGapMs: num(env.POLY_SNIPER_DELETE_VERIFY_GAP_MS, 3000),
    rejectRetries: num(env.POLY_SNIPER_DELETE_REJECT_RETRIES, 3),
    // Post a little above the minimum edge (min + this); last look / sweeps still use the plain minimum.
    postEdgeCushion: num(env.POLY_SNIPER_POST_EDGE_CUSHION, 0.005),
    closedGraceMs: num(env.POLY_SNIPER_CLOSED_GRACE_MS, 30000),
    sweepMs: num(env.POLY_SNIPER_SWEEP_MS, 1000),
    declinePauseRatio: num(env.POLY_SNIPER_DECLINE_PAUSE_RATIO, 0.10),
    declineWindowMs: num(env.POLY_SNIPER_DECLINE_WINDOW_MS, 3600000),
    confirmSafetyMs: num(env.POLY_SNIPER_CONFIRM_SAFETY_MS, 300),
    confirmDefaultBudgetMs: num(env.POLY_SNIPER_CONFIRM_BUDGET_MS, 2500),
    comboConfirmWaitMs: num(env.POLY_SNIPER_COMBO_CONFIRM_WAIT_MS, 150),
    controlPollMs: num(env.POLY_SNIPER_CONTROL_POLL_MS, 5000),
    controlFailOffMs: num(env.POLY_SNIPER_CONTROL_FAIL_OFF_MS, 30000),
    fillCheckMs: num(env.POLY_SNIPER_FILL_CHECK_MS, 60000),
    unfilledReleaseMs: num(env.POLY_SNIPER_UNFILLED_RELEASE_MS, 15 * 60000),
    settleMs: num(env.POLY_SNIPER_SETTLE_MS, 5 * 60000),
    dayRefreshMs: num(env.POLY_SNIPER_DAY_REFRESH_MS, 5 * 60000),
    // 'quoted' ledger rows older than this are past every TTL (60s) + cancel retry, so not live here:
    // expired at startup and by the stale sweep (Oct 30: 2,608 rows left 'quoted' by two deploys).
    staleQuotedMs: num(env.POLY_SNIPER_STALE_QUOTED_MS, 15 * 60000),
    staleSweepMs: num(env.POLY_SNIPER_STALE_SWEEP_MS, 5 * 60000),
    staleDeleteMaxAgeMs: num(env.POLY_SNIPER_STALE_DELETE_MAX_AGE_MS, 24 * 3600e3), // venue DELETE only for rows younger than this
  };
}

// Documented CreateQuote price: decimal string on the RFQ tick (engine rounds to tick; 0.001 or finer).
function formatPrice(x) { return String(Math.round(Number(x) * 1e4) / 1e4); }

function etDayStartIso(ms) {
  const d = new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  // ET midnight (handles EDT/EST): try -04:00 then -05:00, pick the one that is the same ET date.
  for (const off of ['-04:00', '-05:00']) {
    const t = Date.parse(`${d}T00:00:00${off}`);
    if (new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === d && new Date(t - 1).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) !== d) return new Date(t).toISOString();
  }
  return new Date(Date.parse(`${d}T00:00:00-05:00`)).toISOString();
}

// Simple non-waiting token bucket: take() true/false.
function createBucket(rate, burst = rate, now = () => Date.now()) {
  let tokens = burst; let at = now();
  return {
    take() {
      const t = now(); tokens = Math.min(burst, tokens + ((t - at) / 1000) * rate); at = t;
      if (tokens >= 1) { tokens -= 1; return true; }
      return false;
    },
    waitMs() { const t = now(); const have = Math.min(burst, tokens + ((t - at) / 1000) * rate); return have >= 1 ? 0 : Math.ceil(((1 - have) / rate) * 1000); },
  };
}

// Pure cap check. pos = { risk, contracts, games, legs, combo, settleAt, legKickoffs[] }.
// book = { positions: Iterable<{risk,games,legs,combo,long}> , dayRisk, dayLoss, hourCount }.
// Returns null when OK, else the reason (same names as the Kalshi sniper where they exist).
function capReason(pos, book, config, { nowMs, cashUsd = null, cashAt = null } = {}) {
  if (!(pos.risk > 0)) return 'no_risk';
  if (pos.risk > config.maxRisk + 1e-9) return 'risk_over_cap';
  if (pos.contracts > config.maxPayout + 1e-9) return 'payout_over_cap';
  if (-(book.dayLoss || 0) >= config.dailyLossCap) return 'daily_loss_halt';
  for (const k of pos.legKickoffs || []) {
    if (config.maxLegDays > 0 && Number.isFinite(k) && k - nowMs > config.maxLegDays * 864e5) return 'leg_too_far';
  }
  if (cashUsd == null || !(cashAt > 0) || nowMs - cashAt > config.balanceMaxAgeMs) return 'cash_unknown';
  if (cashUsd - pos.risk < config.cashFloorUsd - 1e-9) return 'cash_floor';
  let total = 0; let longTotal = 0; const g = new Map(); const l = new Map();
  for (const p of book.positions) {
    if (!(p.risk > 0)) continue;
    if (pos.combo && p.combo === pos.combo) return 'already_hold_combo';
    total += p.risk; if (p.long) longTotal += p.risk;
    for (const x of p.games || []) g.set(x, (g.get(x) || 0) + p.risk);
    for (const x of p.legs || []) l.set(x, (l.get(x) || 0) + p.risk);
  }
  const settleIn = Number.isFinite(pos.settleAt) ? pos.settleAt - nowMs : Infinity;
  const soon = config.soonCap && settleIn <= config.soonHours * 3600e3;
  // Soon-cap (Kalshi rule): parlays settling within soonHours may use the cash we have, never below the
  // normal cap. On Polymarket the cash is shared with Combo Locks, so "cash" here is above the floor.
  const totalCap = soon ? Math.max(config.totalExposureCap, (cashUsd || 0) - config.cashFloorUsd) : config.totalExposureCap;
  if (total + pos.risk > totalCap + 1e-9) return 'total_cap';
  const isLong = settleIn > config.shortSettleHours * 3600e3;
  if (isLong && longTotal + pos.risk > config.longExposureCap + 1e-9) return 'cap_total_long';
  for (const x of pos.games || []) if ((g.get(x) || 0) + pos.risk > config.perGameCap + 1e-9) return 'game_cap';
  for (const x of pos.legs || []) if ((l.get(x) || 0) + pos.risk > config.perLegCap + 1e-9) return 'leg_cap';
  if ((book.dayRisk || 0) + pos.risk > config.dailyRiskCap + 1e-9) return 'daily_risk_cap';
  if (config.maxQuotesPerHour > 0 && (book.hourCount || 0) + 1 > config.maxQuotesPerHour) return 'hourly_rate_cap';
  return null;
}

// Combo outcome from RFQ leg settlements (settlementPrice is the raw YES settlement, not inverted for
// SIDE_SELL legs). Returns 1 (combo YES won: we lose), 0 (we win), or null (not settled / not 0|1).
function comboSettlement(comboLegs) {
  if (!Array.isArray(comboLegs) || !comboLegs.length) return null;
  let all = 1;
  for (const leg of comboLegs) {
    if (leg.settlementPrice == null && leg.settlement_price == null) return null;
    const sp = Number(leg.settlementPrice != null ? leg.settlementPrice : leg.settlement_price);
    if (sp !== 0 && sp !== 1) return null;
    const v = /SELL/i.test(String(leg.side || '')) ? 1 - sp : sp;
    all *= v;
  }
  return all;
}

function createPolySniperLive({ env = process.env, engineConfig, feed, store = null, log = console.log, alert = null, now = () => Date.now(), timers = true } = {}) {
  const config = liveConfig(env);
  const quotes = new Map();   // quoteId -> rec
  const byRfq = new Map();    // rfqId -> quoteId
  const byOrder = new Map();  // orderId -> quoteId
  const posting = new Map();  // rfqId -> [buffered events]
  const symbolFills = new Map(); // symbol -> [{qty, at}]  (to keep Combo Locks' activity/position reconcile off our fills)
  const declines = [];        // ms of sniper declines (last hour)
  const accepts = [];         // ms of sniper accepts
  const comboOutcomes = [];   // { at, declined }
  const postBucket = createBucket(config.postRps, config.postRps, now);
  const cancelBucket = createBucket(config.cancelRps, config.cancelRps, now);
  const cancelQueue = [];     // { quoteId, rfqId, reason, tries, queuedAt }
  const inflightCancels = new Map(); // quoteId -> job
  const stats = { posted: 0, postFailed: 0, postRate: 0, accepted: 0, confirmed: 0, declined: 0, cancelled: 0, cancelFailed: 0, cancelGone: 0, cancelRejected: 0, cancelVerified: 0, cancelStillLive: 0, cancelClosed: 0, maxCancelLagMs: 0, maxQuoteAgeMs: 0, filled: 0, fillContracts: 0, settled: 0, skips: {} };
  const day = { key: null, risk: 0, loss: 0, startIso: null };
  const hourPosts = [];
  let http = null; let comboConfirming = () => 0;
  let switchOn = false; let lastControlOkAt = 0; let controlLoaded = false;
  let paused = null;          // { reason, at }
  let halted = null;          // daily loss halt: { day }
  let wsStalled = false;
  let cash = null; let cashAt = 0;
  let confirmChain = Promise.resolve();
  let started = false; let stopped = false; const handles = [];
  let backoffUntil = 0;
  let lastVerifyAt = 0;
  let ageAlertAt = 0;

  const say = (m) => log(`[POLY-SNIPER] LIVE ${m}`);
  const notify = (m) => { if (typeof alert === 'function') { try { Promise.resolve(alert(`🎯 POLY SNIPER (not Combo Locks) ${m}`)).catch(() => {}); } catch (_) { /* best effort */ } } };
  const skipNote = (r) => { stats.skips[r] = (stats.skips[r] || 0) + 1; return r; };
  const persist = (quoteId, patch) => { if (store) store.patch(quoteId, patch); };

  function rollDay(t) {
    const k = new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (day.key !== k) {
      day.key = k; day.risk = 0; day.loss = 0; day.startIso = etDayStartIso(t);
      if (halted) { halted = null; say('daily loss halt cleared (new ET day)'); }
    }
  }
  function prune(t) {
    while (declines.length && declines[0] < t - config.declineWindowMs) declines.shift();
    while (accepts.length && accepts[0] < t - config.declineWindowMs) accepts.shift();
    while (comboOutcomes.length && comboOutcomes[0].at < t - config.declineWindowMs) comboOutcomes.shift();
    while (hourPosts.length && hourPosts[0] < t - 3600e3) hourPosts.shift();
    for (const [s, arr] of symbolFills) { const keep = arr.filter((x) => x.at > t - 7 * 864e5); if (keep.length) symbolFills.set(s, keep); else symbolFills.delete(s); }
  }
  // Positions that count toward caps: accepted/confirming/confirmed at accepted size, filled at fill.
  function countedPositions(excludeId = null) {
    const out = [];
    for (const [id, r] of quotes) {
      if (id === excludeId) continue;
      if (r.phase === 'filled' || r.phase === 'confirmed' || r.phase === 'confirming') out.push(r);
    }
    return out;
  }
  function book(excludeId = null) {
    return { positions: countedPositions(excludeId), dayRisk: day.risk, dayLoss: day.loss, hourCount: hourPosts.length };
  }
  function isActive() { return !!(http && switchOn && !paused && !halted && !wsStalled && !stopped); }
  function state() { return !http ? 'no_client' : !switchOn ? 'switch_off' : halted ? 'daily_loss_halt' : paused ? `paused:${paused.reason}` : wsStalled ? 'feed_stall' : stopped ? 'stopped' : 'live'; }

  function settleAtOf(legKeys, t) {
    let last = null; const kicks = [];
    for (const k of legKeys || []) {
      const ticker = String(k).split(':')[0];
      const ko = feed && feed.kickoffs ? feed.kickoffs.kickoffFor(ticker) : null;
      if (Number.isFinite(ko)) { kicks.push(ko); if (last == null || ko > last) last = ko; }
    }
    return { settleAt: last != null ? last + config.gameHours * 3600e3 : t + 7 * 864e5, kicks };
  }

  // Fresh price for a stored quote at size `contracts` (null = RFQ size). -> { ok, reason, d }
  function reprice(rec, t, { contracts = null } = {}) {
    if (!rec.rfq) return { ok: false, reason: 'no_context' };
    const rfq = contracts != null ? { ...rec.rfq, qtyDecimal: String(contracts), cashOrderQty: null } : rec.rfq;
    let d;
    try { d = decidePoly(rfq, { feed, config: engineConfig, ledger: null, nowMs: t, skipLedger: true }); } catch (e) { return { ok: false, reason: `reprice_error:${String(e.message).slice(0, 40)}` }; }
    if (!d || d.action !== 'quote') return { ok: false, reason: (d && d.reason) || 'reprice_skip', d };
    // Our resting price still clears the min edge if it is at or above today's minimum price.
    if (rec.buyPrice + 1e-9 < d.buyPrice) return { ok: false, reason: 'fair_moved', d };
    const n = contracts != null ? contracts : d.contracts;
    const ev = n * (rec.buyPrice - d.fair); const risk = n * (1 - rec.buyPrice);
    if (risk > 0 && ev / risk > engineConfig.maxRoi) return { ok: false, reason: 'roi_suspicious', d };
    return { ok: true, d };
  }

  // ── posting ─────────────────────────────────────────────────────────────
  async function onDecision(rfq, d, { ageMs = null } = {}) {
    const t = now(); rollDay(t); prune(t);
    if (!isActive()) return { posted: false, reason: skipNote(state()) };
    if (!d || d.action !== 'quote') return { posted: false, reason: 'not_quote' };
    if (t < backoffUntil) return { posted: false, reason: skipNote('post_backoff') };
    const gate = postGate(t);
    if (gate) return { posted: false, reason: skipNote(gate) };
    if (byRfq.has(rfq.rfqId) || posting.has(rfq.rfqId)) return { posted: false, reason: skipNote('already_quoted') };
    if (ageMs != null && ageMs > config.maxRfqAgeMs) return { posted: false, reason: skipNote('stale_rfq') };
    const { settleAt, kicks } = settleAtOf(d.legKeys, t);
    const pos = { risk: d.risk, contracts: d.contracts, games: d.games, legs: d.legKeys, combo: d.combo, settleAt, legKickoffs: kicks };
    const cr = capReason(pos, book(), config, { nowMs: t, cashUsd: cash, cashAt });
    if (cr) return { posted: false, reason: skipNote(cr) };
    if (!postBucket.take()) { stats.postRate += 1; return { posted: false, reason: skipNote('post_rate') }; }
    posting.set(rfq.rfqId, []);
    let res;
    try {
      res = await http.createQuote({ rfqId: rfq.rfqId, buyPrice: formatPrice(d.buyPrice), sellPrice: '0', restRemainder: false });
    } catch (e) {
      const buffered = posting.get(rfq.rfqId) || []; posting.delete(rfq.rfqId);
      stats.postFailed += 1;
      if (e && e.statusCode === 429) { backoffUntil = now() + 5000; say(`post 429: posting paused 5s`); }
      if (stats.postFailed <= 20 || stats.postFailed % 100 === 0) say(`POST FAILED rfq=${rfq.rfqId} ${e && e.message}`);
      for (const ev of buffered) ev.release(false);
      return { posted: false, reason: 'post_failed', error: e && e.message };
    }
    const quoteId = res && (res.quoteId || res.id);
    const buffered = posting.get(rfq.rfqId) || []; posting.delete(rfq.rfqId);
    if (!quoteId) { say(`POST returned no quote id rfq=${rfq.rfqId}`); for (const ev of buffered) ev.release(false); return { posted: false, reason: 'no_quote_id' }; }
    const rec = {
      quoteId, rfqId: rfq.rfqId, rfq, symbol: rfq.symbol || null, phase: 'quoted', postedAt: now(),
      buyPrice: Number(d.buyPrice), fair: d.fair, roi: d.roi, minRoi: d.minRoi, contracts: d.contracts,
      quotedRisk: d.risk, risk: 0, games: d.games, legs: d.legKeys, combo: d.combo, legDetail: d.legs,
      settleAt, long: settleAt - t > config.shortSettleHours * 3600e3, filled: 0, filledCost: 0, fillIds: new Set(), orderId: null,
    };
    quotes.set(quoteId, rec); byRfq.set(rfq.rfqId, quoteId);
    hourPosts.push(t); stats.posted += 1;
    if (store) store.insertQuote({ quote_id: quoteId, rfq_id: rfq.rfqId, symbol: rec.symbol, combo_key: rec.combo, games: rec.games, legs: rec.legs, leg_detail: rec.legDetail, phase: 'quoted', buy_price: rec.buyPrice, fair: rec.fair, edge: rec.roi, min_edge: rec.minRoi, contracts: rec.contracts, quoted_risk: Math.round(rec.quotedRisk * 1e6) / 1e6, settle_at: new Date(settleAt).toISOString() });
    if (stats.posted <= 20 || stats.posted % 50 === 0) say(`QUOTED rfq=${rfq.rfqId} quote_id=${quoteId} buy=${rec.buyPrice} fair=${rec.fair.toFixed(4)} edge=${(rec.roi * 100).toFixed(1)}% risk=$${rec.quotedRisk.toFixed(2)} n=${stats.posted}`);
    for (const ev of buffered) ev.release(true);
    return { posted: true, quoteId };
  }

  // ── cancels (never dropped; strict priority over posts; parallel; rate limited) ──
  // Up to cancelConcurrency DELETEs in flight at cancelRps. Outcomes:
  //   2xx / 404            -> gone (404 = already gone on the venue)
  //   network/5xx/429/408  -> retried fast (<= 2s backoff, up to 8 tries; 429 also pauses posts 2s)
  //   other 4xx (400 "unable to process") -> RFQ closed = gone; else verified with GetQuotes (rate
  //                           limited, off the delete lane): already gone / executed -> recorded as such;
  //                           still live -> re-deleted (rejectRetries) then alert; unverifiable ->
  //                           recorded as delete_rejected_<code>. Never retried forever.
  function queueCancel(rec, reason) {
    if (!rec || rec.cancelQueued) return;
    rec.cancelQueued = true; rec.cancelReason = reason;
    cancelQueue.push({ quoteId: rec.quoteId, rfqId: rec.rfqId, reason, tries: 0, rejects: 0, queuedAt: now() });
    drainCancels();
  }
  function cancelBacklog(t = now()) {
    let oldest = null;
    for (const j of cancelQueue) if (oldest == null || j.queuedAt < oldest) oldest = j.queuedAt;
    for (const j of inflightCancels.values()) if (oldest == null || j.queuedAt < oldest) oldest = j.queuedAt;
    return { pending: cancelQueue.length + inflightCancels.size, oldestMs: oldest == null ? 0 : t - oldest };
  }
  // Oldest quote that may still be resting on the venue (phase quoted; not one whose DELETE the venue
  // already refused and is being verified, and not one on a closed RFQ, which can no longer be accepted).
  function oldestOpenAgeMs(t = now()) {
    let max = 0;
    for (const r of quotes.values()) {
      if (r.phase !== 'quoted' || r.closedAt || r.cancelVerifying) continue;
      const a = t - (r.postedAt || t); if (a > max) max = a;
    }
    return max;
  }
  // Reason to hold new posts, or null. Deletes always go first.
  function postGate(t = now()) {
    const b = cancelBacklog(t);
    if (b.pending > config.cancelBacklogMax) return 'cancel_backlog';
    if (b.pending > 0 && b.oldestMs > config.cancelBacklogMs) return 'cancel_lag';
    if (oldestOpenAgeMs(t) >= config.maxQuoteLifeMs - config.ageGuardMs) return 'quote_age_guard';
    return null;
  }
  let draining = false;
  function drainCancels() {
    if (!http) return;
    while (cancelQueue.length && inflightCancels.size < config.cancelConcurrency) {
      if (!cancelBucket.take()) {
        if (!draining) { draining = true; setTimeout(() => { draining = false; drainCancels(); }, Math.max(5, cancelBucket.waitMs())); }
        return;
      }
      const job = cancelQueue.shift();
      inflightCancels.set(job.quoteId, job);
      runCancel(job).catch((e) => say(`cancel worker error ${e && e.message}`)).finally(() => { inflightCancels.delete(job.quoteId); drainCancels(); });
    }
  }
  async function runCancel(job) {
    const rec = quotes.get(job.quoteId);
    if (!rec || rec.phase !== 'quoted') return; // accepted / declined / dropped meanwhile: nothing to delete
    if (rec.closedAt) { stats.cancelClosed += 1; finishCancel(rec, job, ':rfq_closed'); return; }
    const lag = now() - job.queuedAt; if (lag > stats.maxCancelLagMs) stats.maxCancelLagMs = lag;
    try {
      const res = await http.deleteQuote(job.rfqId, job.quoteId);
      if (res && res.statusCode === 404) { stats.cancelGone += 1; finishCancel(rec, job, ':already_gone'); return; }
      stats.cancelled += 1;
      finishCancel(rec, job);
    } catch (e) {
      const sc = e && e.statusCode;
      const transient = sc == null || sc >= 500 || sc === 429 || sc === 408;
      if (sc === 429) backoffUntil = Math.max(backoffUntil, now() + 2000); // deletes first: hold posts
      if (transient) {
        if (job.tries < 8) { job.tries += 1; const h = setTimeout(() => { cancelQueue.unshift(job); drainCancels(); }, Math.min(2000, 100 * (2 ** job.tries))); if (h.unref) h.unref(); return; }
        stats.cancelFailed += 1; say(`cancel GAVE UP after ${job.tries} tries quote_id=${job.quoteId} rfq=${job.rfqId}: ${e && e.message}`);
        notify(`⚠️ could not delete quote ${job.quoteId} (rfq ${job.rfqId}) after ${job.tries} tries: ${e && e.message}`);
        finishCancel(rec, job, ':delete_failed');
        return;
      }
      onDeleteRejected(rec, job, sc, e);
    }
  }
  function onDeleteRejected(rec, job, sc, e) {
    stats.cancelRejected += 1;
    if (stats.cancelRejected <= 20 || stats.cancelRejected % 100 === 0) say(`cancel rejected ${sc} quote_id=${job.quoteId} rfq=${job.rfqId} (${stats.cancelRejected} so far): ${String((e && e.message) || '').slice(0, 120)}`);
    if (rec && rec.closedAt) { stats.cancelClosed += 1; finishCancel(rec, job, ':rfq_closed'); return; }
    const t = now();
    if (!rec || typeof http.listQuotes !== 'function' || t - lastVerifyAt < config.verifyGapMs) { finishCancel(rec, job, `:delete_rejected_${sc}`); return; }
    lastVerifyAt = t; rec.cancelVerifying = true;
    const timeout = new Promise((r) => { const h = setTimeout(() => r(undefined), 6000); if (h.unref) h.unref(); });
    Promise.race([fetchQuoteByIds(http, { rfqId: job.rfqId, quoteId: job.quoteId }), timeout]).then((cur) => {
      rec.cancelVerifying = false;
      if (rec.phase !== 'quoted') return; // accepted / gone meanwhile
      const st = String((cur && (cur.status || cur.state)) || '').toUpperCase();
      if (cur === undefined || !cur || !st) { finishCancel(rec, job, `:delete_rejected_${sc}`); return; }
      stats.cancelVerified += 1;
      if (/DELET|EXPIR|CANCEL|EXECUT|REJECT|CLOSED|FILLED|DONE/.test(st)) { stats.cancelGone += 1; finishCancel(rec, job, `:already_gone_${st.replace(/^QUOTE_STATUS_/, '').toLowerCase()}`); return; }
      stats.cancelStillLive += 1;
      if (job.rejects < config.rejectRetries) { job.rejects += 1; cancelQueue.unshift(job); drainCancels(); return; }
      say(`QUOTE STILL LIVE after ${job.rejects + 1} rejected deletes quote_id=${job.quoteId} rfq=${job.rfqId} status=${st}`);
      notify(`⚠️ quote ${job.quoteId} (rfq ${job.rfqId}) still ${st} on Polymarket after ${job.rejects + 1} rejected deletes. Check it.`);
      finishCancel(rec, job, ':delete_rejected_still_live');
    }).catch(() => { rec.cancelVerifying = false; finishCancel(rec, job, `:delete_rejected_${sc}`); });
  }
  function finishCancel(rec, job, suffix = '') {
    if (!rec) return;
    if (rec.phase === 'quoted') { dropRec(rec, 'cancelled', { cancel_reason: job.reason + (suffix || '') }); }
  }
  function dropRec(rec, phase, patch = {}) {
    rec.phase = phase;
    quotes.delete(rec.quoteId);
    if (byRfq.get(rec.rfqId) === rec.quoteId) byRfq.delete(rec.rfqId);
    persist(rec.quoteId, { phase, ...patch });
  }
  function cancelAllResting(reason) {
    let n = 0;
    for (const rec of quotes.values()) if (rec.phase === 'quoted') { queueCancel(rec, reason); n += 1; }
    if (n) say(`cancelling ${n} open quote(s): ${reason}`);
    return n;
  }

  // ── accept / confirm (last look) ────────────────────────────────────────
  function decline(rec, reason, t) {
    stats.declined += 1; declines.push(t);
    rec.phase = 'declined'; rec.risk = 0;
    if (http) http.deleteQuote(rec.rfqId, rec.quoteId).catch(() => { /* deadline passing declines it anyway */ });
    dropRec(rec, 'declined', { decline_reason: reason });
    say(`DECLINED quote_id=${rec.quoteId} rfq=${rec.rfqId} reason=${reason}`);
    checkDeclinePause(t);
    return { confirmed: false, reason };
  }
  function onAccepted(evt) {
    const q = (evt && evt.quote) || {};
    const quoteId = q.id || q.quoteId || q.quote_id;
    const rec = quotes.get(quoteId);
    if (!rec) return;
    const t = now();
    if (rec.phase !== 'quoted') return; // duplicate event
    rec.phase = 'accepted'; rec.acceptedAt = t; stats.accepted += 1; accepts.push(t);
    const deadline = Date.parse(q.confirmationDeadline || q.confirmation_deadline || '');
    rec.deadline = Number.isFinite(deadline) ? deadline : t + config.confirmDefaultBudgetMs;
    const side = q.acceptedSide || q.accepted_side || '';
    const venueQty = Number(q.buyQtyDecimal != null ? q.buyQtyDecimal : q.buy_qty_decimal);
    rec.acceptedContracts = venueQty > 0 ? venueQty : rec.contracts;
    if (q.creatorOrderId || q.creator_order_id) setOrder(rec, q.creatorOrderId || q.creator_order_id);
    persist(rec.quoteId, { phase: 'accepted', accepted_at: new Date(t).toISOString(), accepted_contracts: rec.acceptedContracts });
    // One confirm decision at a time: caps see every earlier accept.
    confirmChain = confirmChain.then(() => confirmOrDecline(rec, side)).catch((e) => say(`confirm error ${e && e.message}`));
    return confirmChain;
  }
  async function confirmOrDecline(rec, side) {
    const t = now(); rollDay(t); prune(t);
    if (!/BUY/i.test(String(side || 'SIDE_BUY'))) return decline(rec, 'side_not_buy', t);
    if (t > rec.deadline - config.confirmSafetyMs) return decline(rec, 'deadline', t);
    if (!isActive()) return decline(rec, state(), t);
    const n = rec.acceptedContracts;
    const rp = reprice(rec, t, { contracts: n });
    if (!rp.ok) return decline(rec, `reprice:${rp.reason}`, t);
    const { settleAt, kicks } = settleAtOf(rec.legs, t);
    const risk = n * (1 - rec.buyPrice);
    const cr = capReason({ risk, contracts: n, games: rec.games, legs: rec.legs, combo: rec.combo, settleAt, legKickoffs: kicks }, book(rec.quoteId), config, { nowMs: t, cashUsd: cash, cashAt });
    if (cr) return decline(rec, `cap:${cr}`, t);
    // Combo Locks first: wait briefly for any of its confirms in flight.
    const waitUntil = Math.min(now() + config.comboConfirmWaitMs, rec.deadline - config.confirmSafetyMs - 50);
    while (comboConfirming() > 0 && now() < waitUntil) await new Promise((r) => setTimeout(r, 10));
    if (now() > rec.deadline - config.confirmSafetyMs) return decline(rec, 'deadline', now());
    rec.phase = 'confirming'; rec.risk = risk; rec.settleAt = settleAt; rec.long = settleAt - (rec.postedAt || t) > config.shortSettleHours * 3600e3;
    try {
      await http.confirmQuote(rec.rfqId, rec.quoteId);
    } catch (e) {
      rec.risk = 0;
      return decline(rec, `confirm_failed:${String((e && e.message) || '').slice(0, 60)}`, now());
    }
    rec.phase = 'confirmed'; rec.confirmedAt = now(); stats.confirmed += 1;
    persist(rec.quoteId, { phase: 'confirmed', confirmed_at: new Date(rec.confirmedAt).toISOString(), risk });
    say(`CONFIRMED quote_id=${rec.quoteId} rfq=${rec.rfqId} n=${n} buy=${rec.buyPrice} fair_now=${rp.d.fair.toFixed(4)} risk=$${risk.toFixed(2)} ms=${rec.confirmedAt - rec.acceptedAt}`);
    return { confirmed: true };
  }

  // ── fills ───────────────────────────────────────────────────────────────
  function setOrder(rec, orderId) { if (!orderId) return; rec.orderId = orderId; byOrder.set(orderId, rec.quoteId); }
  async function resolveFill(rec, quote = null) {
    if (!http || !rec) return null;
    let evt = null;
    try {
      evt = await resolveQuoteFill(http, { quote: quote || { id: rec.quoteId, rfqId: rec.rfqId, creatorOrderId: rec.orderId }, pending: { rfqId: rec.rfqId, contracts: rec.acceptedContracts || rec.contracts, creatorOrderId: rec.orderId }, pendingId: rec.quoteId, alreadyFilled: rec.filled });
    } catch (e) { say(`fill resolve ${rec.quoteId}: ${e && e.message}`); return null; }
    if (!evt || !(evt.contracts > 0)) return null;
    return bookFill(rec, evt);
  }
  function bookFill(rec, evt) {
    const fid = evt.fillId || `${rec.quoteId}:${rec.filled + evt.contracts}`;
    if (rec.fillIds.has(fid)) return null;
    rec.fillIds.add(fid);
    if (evt.orderId) setOrder(rec, evt.orderId);
    const t = now(); rollDay(t);
    rec.filled = Math.round((rec.filled + evt.contracts) * 1e6) / 1e6;
    rec.filledCost = Math.round(rec.filled * rec.buyPrice * 1e6) / 1e6;
    const filledRisk = rec.filled * (1 - rec.buyPrice);
    const full = !evt.isPartial || rec.filled + 1e-6 >= (rec.acceptedContracts || rec.contracts);
    day.risk += evt.contracts * (1 - rec.buyPrice);
    rec.risk = full ? filledRisk : Math.max(filledRisk, rec.risk);
    if (full) rec.phase = 'filled';
    rec.filledAt = rec.filledAt || t;
    if (rec.symbol) { const a = symbolFills.get(rec.symbol) || []; a.push({ qty: evt.contracts, at: t }); symbolFills.set(rec.symbol, a); }
    stats.filled += 1; stats.fillContracts += evt.contracts;
    persist(rec.quoteId, { phase: rec.phase, filled_contracts: rec.filled, filled_cost: rec.filledCost, risk: rec.risk, order_id: rec.orderId, fill_ids: [...rec.fillIds], filled_at: new Date(rec.filledAt).toISOString() });
    say(`FILL quote_id=${rec.quoteId} rfq=${rec.rfqId} +${evt.contracts} (total ${rec.filled}) @ ${rec.buyPrice} risk=$${rec.risk.toFixed(2)}${full ? '' : ' PARTIAL'} src=${evt.source || 'ws'}`);
    notify(`✅ FILL ${evt.contracts} contracts @ ${rec.buyPrice} (risk $${(evt.contracts * (1 - rec.buyPrice)).toFixed(2)}, edge ${(rec.roi * 100).toFixed(1)}%) rfq ${rec.rfqId}`);
    return evt;
  }
  async function fillBackstop() {
    if (!http) return;
    const t = now();
    const waiting = [...quotes.values()].filter((r) => (r.phase === 'confirmed' || (r.phase === 'filled' && r.filled + 1e-6 < (r.acceptedContracts || 0))));
    if (!waiting.length) return;
    let executed = [];
    try { executed = (await listSelfExecutedQuotes(http, { limit: 100 })).quotes || []; } catch (_) { executed = []; }
    const ex = new Map(executed.map((q) => [quoteIdOf(q), q]));
    let n = 0;
    for (const rec of waiting) {
      if (n >= 5) break;
      const q = ex.get(rec.quoteId) || null;
      if (q && orderIdOfQuote(q)) setOrder(rec, orderIdOfQuote(q));
      if (q || rec.orderId) { n += 1; await resolveFill(rec, q); continue; }
      if (rec.phase === 'confirmed' && t - (rec.confirmedAt || t) > config.unfilledReleaseMs) {
        n += 1;
        const cur = await fetchQuoteByIds(http, { rfqId: rec.rfqId, quoteId: rec.quoteId });
        if (cur && isExecutedQuoteStatus(cur.status)) { if (orderIdOfQuote(cur)) setOrder(rec, orderIdOfQuote(cur)); await resolveFill(rec, cur); continue; }
        if (cur && /DELETED|EXPIRED|CANCEL/i.test(String(cur.status || ''))) { rec.risk = 0; dropRec(rec, 'expired', { cancel_reason: `confirmed_not_executed:${cur.status}` }); say(`released confirmed-but-never-executed quote ${rec.quoteId} (${cur.status})`); }
      }
    }
  }

  // ── settlement + daily loss stop ────────────────────────────────────────
  let settleIdx = 0;
  async function settleTick() {
    if (!http || typeof http.listRfqs !== 'function') return;
    const t = now(); rollDay(t);
    const due = [...quotes.values()].filter((r) => r.phase === 'filled' && r.settleAt + 3600e3 < t);
    if (!due.length) return;
    const rec = due[settleIdx++ % due.length]; // one RFQ read per tick (shares the 1 req/s RFQ budget)
    let row = null;
    try { const j = await http.listRfqs({ rfqId: rec.rfqId }); row = ((j && j.rfqs) || [])[0] || null; } catch (_) { return; }
    const won = row ? comboSettlement(row.comboLegs || row.combo_legs) : null;
    if (won == null) return;
    const pnl = Math.round((rec.filledCost - rec.filled * won) * 100) / 100;
    rec.risk = 0; stats.settled += 1; day.loss += pnl; // day.loss = today's realized P&L (wins offset losses, like the Kalshi stop)
    dropRec(rec, 'settled', { market_result: won ? 'combo_won' : 'combo_lost', realized_pnl: pnl, settled_at: new Date(t).toISOString() });
    say(`SETTLED quote_id=${rec.quoteId} ${won ? 'combo won (we lose)' : 'combo lost (we win)'} pnl=$${pnl}`);
    checkLossHalt();
  }
  function checkLossHalt() {
    if (!halted && -day.loss >= config.dailyLossCap) {
      halted = { day: day.key };
      cancelAllResting('daily_loss_halt');
      say(`AUTO-DISABLED: realized loss today $${(-day.loss).toFixed(2)} >= $${config.dailyLossCap}`);
      notify(`🛑 AUTO-DISABLED: realized loss today $${(-day.loss).toFixed(2)} ≥ $${config.dailyLossCap}. Resumes after midnight ET.`);
    }
  }
  async function refreshDay() {
    if (!store || typeof store.dayTotals !== 'function') return;
    const t = now(); rollDay(t);
    try {
      const d = await store.dayTotals(day.startIso);
      day.loss = d.realized; day.risk = Math.max(day.risk, d.filledRisk);
      checkLossHalt();
    } catch (e) { say(`day totals read failed: ${e.message}`); }
  }

  // ── decline-rate pause ──────────────────────────────────────────────────
  function declineRatios() {
    const cA = comboOutcomes.length; const cD = comboOutcomes.filter((x) => x.declined).length;
    return { sniper: accepts.length ? declines.length / accepts.length : 0, account: (accepts.length + cA) ? (declines.length + cD) / (accepts.length + cA) : 0, accepts: accepts.length, declines: declines.length, comboAccepts: cA, comboDeclines: cD };
  }
  function checkDeclinePause(t = now()) {
    prune(t);
    const r = declineRatios();
    const over = (r.declines > 0 && r.sniper > config.declinePauseRatio) || ((r.declines + r.comboDeclines) > 0 && r.account > config.declinePauseRatio && r.declines > 0);
    if (over && !paused) {
      paused = { reason: 'decline_rate', at: t };
      cancelAllResting('decline_rate_pause');
      say(`PAUSED decline rate sniper=${(r.sniper * 100).toFixed(0)}% (${r.declines}/${r.accepts}) account=${(r.account * 100).toFixed(0)}% last hour > ${(config.declinePauseRatio * 100).toFixed(0)}%`);
      notify(`⏸ PAUSED: declined ${r.declines} of ${r.accepts} accepts in the last hour (account ${(r.account * 100).toFixed(0)}%). Polymarket pauses makers over 15%. Auto-resumes under ${(config.declinePauseRatio * 100).toFixed(0)}%.`);
    } else if (!over && paused && paused.reason === 'decline_rate') {
      paused = null; say('decline-rate pause cleared');
    }
  }

  // Decline pause survives restarts (Oct 30): rebuild the last hour's sniper accepts / declines from
  // poly_sniper_ledger.accepted_at before trading. If it cannot be read, stay paused
  // (decline_history_unknown) and retry on every control poll.
  async function loadDeclineHistory() {
    if (!store || typeof store.recentOutcomes !== 'function') return null;
    const t = now();
    try {
      const rows = await store.recentOutcomes(new Date(t - config.declineWindowMs).toISOString());
      const a = []; const d = [];
      for (const r of rows || []) {
        if (quotes.has(r.quote_id) && quotes.get(r.quote_id).acceptedAt) continue; // already counted live
        const at = Date.parse(r.accepted_at || '');
        if (!Number.isFinite(at) || at < t - config.declineWindowMs) continue;
        a.push(at); if (r.phase === 'declined') d.push(at);
      }
      const merge = (arr, add) => { arr.push(...add); arr.sort((x, y) => x - y); };
      merge(accepts, a); merge(declines, d);
      if (paused && paused.reason === 'decline_history_unknown') { paused = null; say('decline history loaded: pause cleared'); }
      say(`decline history: ${a.length} accept(s), ${d.length} decline(s) in the last ${Math.round(config.declineWindowMs / 60000)}m loaded from the ledger`);
      checkDeclinePause(t);
      return { accepts: a.length, declines: d.length };
    } catch (e) {
      if (!paused) { paused = { reason: 'decline_history_unknown', at: t }; cancelAllResting('decline_history_unknown'); }
      say(`decline history read failed: ${e.message} — sniper paused until it loads`);
      return null;
    }
  }

  // ── stale sweep (stale prices, feed stall, fair moved past edge, near game start, TTL, closed) ──
  function sweep() {
    const t = now(); rollDay(t); prune(t);
    checkDeclinePause(t);
    if (!isActive()) { cancelAllResting(state()); return; }
    const healthy = feed && typeof feed.pricesHealthy === 'function' ? feed.pricesHealthy(t) : true;
    let oldest = 0;
    for (const rec of quotes.values()) {
      if (rec.phase !== 'quoted') continue;
      // A closed RFQ can no longer be accepted: its quotes are dead on the venue (a DELETE would only get
      // "400 unable to process"). Kept in memory for the grace period so late WS events still route here.
      if (rec.closedAt) { if (t - rec.closedAt > config.closedGraceMs) dropRec(rec, 'expired', { cancel_reason: 'rfq_closed' }); continue; }
      const age = t - rec.postedAt;
      if (!rec.cancelVerifying && age > oldest) oldest = age;
      if (rec.cancelQueued) continue;
      if (!healthy) { queueCancel(rec, 'prices_stale'); continue; }
      if (age >= config.quoteTtlMs) { queueCancel(rec, 'ttl'); continue; }
      const rp = reprice(rec, t);
      if (!rp.ok) queueCancel(rec, rp.reason === 'game_started' ? 'near_game_start' : rp.reason);
    }
    if (oldest > stats.maxQuoteAgeMs) stats.maxQuoteAgeMs = oldest;
    if (oldest > config.maxQuoteLifeMs && t - ageAlertAt > 60000) {
      ageAlertAt = t;
      const b = cancelBacklog(t);
      say(`MAX QUOTE LIFE EXCEEDED: oldest open quote ${(oldest / 1000).toFixed(1)}s > ${config.maxQuoteLifeMs / 1000}s (delete lane pending=${b.pending} oldest=${b.oldestMs}ms). Posting held until it clears.`);
      notify(`⚠️ a quote has been open ${(oldest / 1000).toFixed(1)}s (> ${config.maxQuoteLifeMs / 1000}s max). New quotes held until deletes catch up.`);
    }
  }

  // ── stale 'quoted' ledger rows (left by a previous process) ──────────────
  // DB: phase -> 'expired' (cancel_reason stale_quoted_sweep). Venue: best-effort DELETE, one at a time
  // and only while the real cancel lane is idle, so live cancels never wait behind cleanup.
  const staleDeletes = [];
  async function staleQuotedSweep() {
    if (!store || typeof store.expireStaleQuoted !== 'function') return 0;
    const t = now();
    const rows = await store.expireStaleQuoted({ staleQuotedMs: config.staleQuotedMs, nowMs: t, keepIds: new Set(quotes.keys()) });
    for (const r of rows) {
      const age = t - (Date.parse(r.created_at) || t);
      if (age <= config.staleDeleteMaxAgeMs && staleDeletes.length < 10000) staleDeletes.push({ rfqId: r.rfq_id, quoteId: r.quote_id });
    }
    stats.staleExpired = (stats.staleExpired || 0) + rows.length;
    if (rows.length) say(`stale sweep: expired ${rows.length} leftover 'quoted' row(s) older than ${Math.round(config.staleQuotedMs / 60000)}m (${staleDeletes.length} venue delete(s) queued)`);
    return rows.length;
  }
  async function drainStaleDeletes(max = 1) {
    let n = 0;
    while (http && n < max && staleDeletes.length && !cancelQueue.length && !inflightCancels.size && cancelBucket.take()) {
      const job = staleDeletes.shift(); n += 1;
      try { await http.deleteQuote(job.rfqId, job.quoteId); stats.staleDeleted = (stats.staleDeleted || 0) + 1; } catch (_) { stats.staleDeleteGone = (stats.staleDeleteGone || 0) + 1; }
    }
    return n;
  }

  // ── control switch ──────────────────────────────────────────────────────
  async function pollControl() {
    if (!store) return;
    const t = now();
    try {
      const c = await store.readControl();
      lastControlOkAt = t;
      if (c.live !== switchOn || !controlLoaded) {
        const was = switchOn; switchOn = c.live; controlLoaded = true;
        say(`switch ${switchOn ? 'ON' : 'OFF'}${c.updatedBy ? ` by ${c.updatedBy}` : ''}${c.updatedAt ? ` at ${c.updatedAt}` : ''}`);
        if (was && !switchOn) { cancelAllResting('switch_off'); notify('⏹ switched OFF: all open sniper quotes deleted.'); }
        if (!was && switchOn) notify(`▶️ switched ON. Caps: $${config.maxRisk}/quote, $${config.perGameCap}/game, $${config.perLegCap}/leg, $${config.totalExposureCap} open ($${config.longExposureCap} >${config.shortSettleHours}h), $${config.dailyRiskCap}/day new, $${config.dailyLossCap} daily loss stop, cash floor $${config.cashFloorUsd}.`);
      }
    } catch (e) {
      if (switchOn && t - lastControlOkAt > config.controlFailOffMs) {
        switchOn = false; cancelAllResting('control_unreadable');
        say(`switch read failing for ${Math.round((t - lastControlOkAt) / 1000)}s: treating as OFF (${e.message})`);
        notify('⚠️ cannot read poly_sniper_control: treated as OFF, open quotes deleted.');
      }
    }
  }
  async function pollBalance() {
    if (!http || typeof http.request !== 'function') return;
    try {
      const res = await http.request('GET', '/v1/account/balances');
      if (!res || res.statusCode < 200 || res.statusCode >= 300) return;
      const j = res.json || {};
      const list = Array.isArray(j.balances) ? j.balances : (j.currentBalance != null ? [j] : []);
      const usd = list.find((b) => !b.currency || String(b.currency).toUpperCase() === 'USD') || list[0];
      if (!usd) return;
      const v = Number(usd.buyingPower != null ? usd.buyingPower : usd.currentBalance);
      if (Number.isFinite(v)) { cash = v; cashAt = now(); }
    } catch (_) { /* stale balance = no trading (capReason cash_unknown) */ }
  }

  // ── startup cleanup (leftover own quotes) + hydrate real exposure ─────
  async function hydrate() {
    if (!store) return { cleaned: 0, loaded: 0 };
    let rows = [];
    try { rows = await store.hydrateOpen({ staleQuotedMs: config.staleQuotedMs, nowMs: now() }); } catch (e) { say(`hydrate failed: ${e.message} — sniper stays off until it loads`); throw e; }
    let cleaned = 0; let loaded = 0;
    for (const r of rows) {
      const rec = {
        quoteId: r.quote_id, rfqId: r.rfq_id, rfq: null, symbol: r.symbol, phase: r.phase, postedAt: Date.parse(r.created_at) || now(),
        buyPrice: Number(r.buy_price), fair: Number(r.fair), roi: 0, contracts: Number(r.contracts) || 0, acceptedContracts: Number(r.accepted_contracts) || Number(r.contracts) || 0,
        risk: Number(r.risk) || 0, games: r.games || [], legs: r.legs || [], combo: r.combo_key, settleAt: r.settle_at ? Date.parse(r.settle_at) : now() + 7 * 864e5,
        filled: Number(r.filled_contracts) || 0, filledCost: Number(r.filled_cost) || 0, fillIds: new Set(r.fill_ids || []), orderId: r.order_id || null, filledAt: r.filled_at ? Date.parse(r.filled_at) : null,
      };
      rec.long = rec.settleAt - rec.postedAt > config.shortSettleHours * 3600e3;
      if (r.phase === 'quoted' || r.phase === 'accepted') {
        // Leftover from a previous process: delete on the venue (404 = already gone), never confirm.
        quotes.set(rec.quoteId, rec); rec.phase = 'quoted';
        queueCancel(rec, 'startup_cleanup'); cleaned += 1; continue;
      }
      if (r.phase === 'confirmed' && !(rec.risk > 0)) rec.risk = rec.acceptedContracts * (1 - rec.buyPrice);
      quotes.set(rec.quoteId, rec); if (rec.orderId) byOrder.set(rec.orderId, rec.quoteId); loaded += 1;
      if (rec.symbol && rec.filled > 0) { const a = symbolFills.get(rec.symbol) || []; a.push({ qty: rec.filled, at: rec.filledAt || now() }); symbolFills.set(rec.symbol, a); }
    }
    say(`startup: ${cleaned} leftover quote(s) queued for delete, ${loaded} open position(s) loaded`);
    return { cleaned, loaded };
  }

  // ── WS routing (called by polymarket-rfq.js before Combo Locks handles the event) ──
  function ownsQuote(quoteId) { return !!(quoteId && quotes.has(quoteId)); }
  function execIds(ex) {
    const o = (ex && (ex.order || ex)) || {};
    return { orderId: o.id || o.orderId || o.order_id || ex.orderId || null, quoteId: o.quoteId || o.quote_id || ex.quoteId || null };
  }
  function ownsExecution(ex) {
    const { orderId, quoteId } = execIds(ex);
    return !!((orderId && byOrder.has(orderId)) || ownsQuote(quoteId));
  }
  function onOrderExecution(ex) {
    const { orderId, quoteId } = execIds(ex);
    const rec = quotes.get(quoteId) || quotes.get(byOrder.get(orderId));
    if (!rec) return;
    const typ = String(ex.type || '').toUpperCase();
    if (/FILL|TRADE/.test(typ)) resolveFill(rec).catch(() => {});
  }
  // true = event belongs to the sniper (Combo Locks must not handle it).
  function onWsEvent(evt) {
    if (!evt) return false;
    const q = evt.quote || {};
    const quoteId = q.id || q.quoteId || q.quote_id || null;
    const rfqId = q.rfqId || q.rfq_id || (evt.rfq && (evt.rfq.id || evt.rfq.rfqId)) || null;
    if (evt.type === 'rfqClosed') {
      const id = (evt.rfq && (evt.rfq.id || evt.rfq.rfqId)) || evt.rfqId;
      const rec = id && quotes.get(byRfq.get(id));
      if (rec && rec.phase === 'quoted') rec.closedAt = now();
      return false; // Combo Locks still needs it
    }
    if (!['quoteAccepted', 'quoteConfirmed', 'quoteExecuted', 'quoteDeleted'].includes(evt.type)) return false;
    if (!ownsQuote(quoteId)) {
      // Accept racing our own POST response: hold it until the POST returns (then route by id).
      if (evt.type === 'quoteAccepted' && rfqId && posting.has(rfqId)) {
        posting.get(rfqId).push({ release: (ok) => { if (ok && ownsQuote(quoteId)) onWsEvent(evt); else if (typeof fallback === 'function') fallback(evt); } });
        return true;
      }
      return false;
    }
    const rec = quotes.get(quoteId);
    if (evt.type === 'quoteAccepted') onAccepted(evt);
    else if (evt.type === 'quoteExecuted') {
      if (q.creatorOrderId || q.creator_order_id) setOrder(rec, q.creatorOrderId || q.creator_order_id);
      resolveFill(rec, q).catch(() => {});
    } else if (evt.type === 'quoteDeleted') {
      if (rec.phase === 'quoted') dropRec(rec, rec.cancelQueued ? 'cancelled' : 'replaced', { cancel_reason: rec.cancelReason || 'venue_deleted_or_replaced' });
    }
    return true;
  }
  let fallback = null; // Combo Locks handler for buffered accepts that turned out not to be ours
  // Keeps Combo Locks' REST reconcile (activities / positions / executed quotes) off sniper fills.
  function isSniperFill(evt) {
    if (!evt) return false;
    if (evt.quoteId && quotes.has(evt.quoteId)) return true;
    if (evt.orderId && byOrder.has(evt.orderId)) return true;
    const slug = evt.marketTicker || evt.symbol || null;
    if (!evt.quoteId && slug && symbolFills.has(slug)) {
      if (String(evt.source || '').startsWith('poly-position')) return true; // aggregate position on a sniper combo
      const arr = symbolFills.get(slug);
      if (arr.some((x) => Math.abs(x.qty - Number(evt.contracts)) < 0.011)) return true;
    }
    return false;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────
  function every(ms, fn) { if (!timers) return; const h = setInterval(() => { Promise.resolve().then(fn).catch((e) => say(`${fn.name} ${e && e.message}`)); }, ms); if (h.unref) h.unref(); handles.push(h); }
  async function attach({ http: client, comboConfirming: cc, onComboFallback } = {}) {
    if (!client || typeof client.createQuote !== 'function') throw new Error('poly-sniper live: attach needs the poly-worker Polymarket client');
    http = client; if (typeof cc === 'function') comboConfirming = cc; if (typeof onComboFallback === 'function') fallback = onComboFallback;
    if (started) return;
    started = true;
    await hydrate();
    await loadDeclineHistory();
    await Promise.all([pollControl(), pollBalance(), refreshDay()]);
    try { await staleQuotedSweep(); } catch (e) { say(`stale sweep failed: ${e.message}`); }
    every(config.controlPollMs, pollControl);
    every(config.controlPollMs, async function declineHistoryRetry() { if (paused && paused.reason === 'decline_history_unknown') await loadDeclineHistory(); });
    every(config.balancePollMs, pollBalance);
    every(config.sweepMs, sweep);
    every(config.fillCheckMs, fillBackstop);
    every(config.settleMs, settleTick);
    every(config.dayRefreshMs, refreshDay);
    every(config.staleSweepMs, staleQuotedSweep);
    every(config.sweepMs, drainStaleDeletes);
    say(`attached. switch=${switchOn ? 'ON' : 'OFF'} cash=${cash != null ? `$${cash.toFixed(2)}` : 'unknown'} floor=$${config.cashFloorUsd} posts<=${config.postRps}/s cancels<=${config.cancelRps}/s x${config.cancelConcurrency} quote_ttl=${config.quoteTtlMs / 1000}s max_life=${config.maxQuoteLifeMs / 1000}s post_cushion=+${(config.postEdgeCushion * 100).toFixed(1)}%`);
  }
  async function shutdown(reason = 'shutdown', budgetMs = 10000) {
    stopped = true;
    for (const h of handles) clearInterval(h);
    for (const rec of quotes.values()) if (rec.phase === 'accepted') decline(rec, reason, now());
    cancelAllResting(reason);
    const until = now() + budgetMs;
    while ((cancelQueue.length || inflightCancels.size) && now() < until) await new Promise((r) => setTimeout(r, 50));
    if (store) { try { await Promise.race([store.flush(), new Promise((r) => setTimeout(r, Math.max(0, until - now())))]); } catch (_) {} }
  }
  return {
    config, attach, shutdown, onDecision, onWsEvent, ownsExecution, onOrderExecution, isSniperFill, ownsQuote,
    onWsStall() { if (!wsStalled) { wsStalled = true; cancelAllResting('feed_stall'); } },
    onWsRecovered() { wsStalled = false; },
    onComboAcceptOutcome(confirmed) { comboOutcomes.push({ at: now(), declined: !confirmed }); checkDeclinePause(); },
    isActive, state,
    stats: () => ({ state: state(), open: [...quotes.values()].filter((r) => r.phase === 'quoted').length, cancelPending: cancelBacklog().pending, cancelOldestMs: cancelBacklog().oldestMs, oldestQuoteMs: oldestOpenAgeMs(), positions: countedPositions().length, openRisk: countedPositions().reduce((a, r) => a + r.risk, 0), dayRisk: day.risk, dayPnl: day.loss, cash, ...declineRatios(), ...stats, skips: { ...stats.skips } }),
    confirmIdle: () => confirmChain,
    _internal: { quotes, byRfq, byOrder, posting, cancelQueue, inflightCancels, postGate, cancelBacklog, oldestOpenAgeMs, loadDeclineHistory, sweep, pollControl, pollBalance, fillBackstop, settleTick, hydrate, bookFill, staleQuotedSweep, drainStaleDeletes, staleDeletes, setCash: (v, at) => { cash = v; cashAt = at; }, day },
  };
}

module.exports = { createPolySniperLive, liveConfig, capReason, comboSettlement, etDayStartIso, createBucket, formatPrice };
