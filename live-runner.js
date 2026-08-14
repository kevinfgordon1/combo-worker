// ─────────────────────────────────────────────────────────────────────────
// live-runner.js — LIVE worker (latency-optimized)
//
// ACCOUNTING: POST → 'quoted'. Ceiling advances only on quote_executed.
// PARTIAL-FILL: d.locks is informational; post while ceiling remains.
// LATENCY: Steps 0–4 — instrument, POST first, undici keep-alive, pre-stage.
// START GATE: never quote (and cancel open quotes) once any leg's start <= now.
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
const { decideAtFill, fillView, buildQuoteBody, shouldPostQuote, isSilentQuoteFailure, YES_DECLINE } = require('./engine');
const { findStartedEvent } = require('./started');
const { startHeartbeat } = require('./heartbeat');
const { shortId } = require('./short-id');

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

// Step 3 — pre-staged quote pieces per parlay (rebuilt every refresh)
// staged[id] = { noBid, yesBid, rest_remainder, fillAmerican, effTaker }
let staged = {};

const counts = {
  rfqs: 0, combos: 0, matched: 0, wouldQuote: 0,
  declined: 0, noLock: 0, limitReached: 0,
  posted: 0, postFailed: 0, dollarRfqs: 0, filled: 0,
};

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
    cancelStartedQuotes().catch((e) => console.error(`[${MODE}] cancel-on-start refresh`, e.message));
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

// Fire-and-forget log (Step 1 — never on the critical path before POST)
function logAsync(p, rfq, d, status, extra = {}) {
  const contracts =
    d && d.contracts != null ? d.contracts
      : rfq.contracts != null ? rfq.contracts : null;
  supabase.from('combo_submissions').insert({
    user_id: p.user_id,
    parlay_id: p.id,
    rfq_id: rfq.rfqId,
    label: p.label,
    fill_american: d ? d.fillAmerican : p.fill_american,
    contracts,
    worst_lock: d ? d.worst : null,
    status: normalizeStatus(status),
    ...extra,
  }).then(({ error }) => {
    if (error) console.error(`[${MODE}] log insert failed`, error.message);
  }).catch((e) => console.error(`[${MODE}] log insert failed`, e.message));
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

async function cancelQuoteAndDrop(quoteId, pending, started) {
  if (!quoteId || cancelingQuotes.has(quoteId)) return;
  cancelingQuotes.add(quoteId);
  const label = (pending && pending.label) || '(unknown)';
  try {
    await cancelQuote(quoteId);
    pendingQuotes.delete(quoteId);
    console.log(
      `[${MODE}] CANCEL game started ${label} quote_id=${quoteId}` +
      (pending && pending.rfqId ? ` rfq=${pending.rfqId}` : '') +
      ` source=${started.source} at=${started.at}`
    );
  } catch (e) {
    console.error(
      `[${MODE}] CANCEL FAILED game started ${label} quote_id=${quoteId}`,
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
    if (!row || !row.quote_id || seen.has(row.quote_id)) continue;
    await cancelQuoteAndDrop(row.quote_id, {
      label: row.label,
      rfqId: row.rfq_id,
      parlayId,
    }, started);
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

  let extras = [];
  try {
    const cutoff = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from('combo_submissions')
      .select('quote_id,parlay_id,label,rfq_id')
      .eq('is_live', true)
      .is('order_id', null)
      .not('quote_id', 'is', null)
      .gte('created_at', cutoff);
    if (error) console.error(`[${MODE}] cancel-on-start submissions`, error.message);
    else extras = data || [];
  } catch (e) {
    console.error(`[${MODE}] cancel-on-start submissions`, e.message);
  }

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

function resolveRfqContracts(rfq, fillAmerican, stagedNoBid) {
  if (rfq.contracts != null && rfq.contracts > 0) {
    return { contracts: rfq.contracts, source: 'contracts' };
  }
  if (rfq.targetCostDollars != null && rfq.targetCostDollars > 0) {
    const noBid = stagedNoBid != null
      ? parseFloat(stagedNoBid)
      : parseFloat(fillView(fillAmerican).noBid);
    const yesPrice = Math.max(0.01, 1 - noBid);
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

const confirmingQuotes = new Set(); // de-dupe concurrent accept events

async function onQuoteAccepted(evt) {
  const t0 = performance.now();
  let quoteId = evt && evt.quoteId;
  let rfqId = evt && evt.rfqId;
  const pending = quoteId ? pendingQuotes.get(quoteId) : null;
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
  const ceiling = parlay && parlay.max_contracts > 0 ? Number(parlay.max_contracts) : null;
  const fullyFilled = ceiling != null && sessionTotal >= ceiling;

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
  if (!p) return;
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
  });

  if (!d.ok) {
    if (d.reason === 'limit_reached') {
      counts.limitReached++;
      console.log(`[${MODE}] LIMIT REACHED ${p.label} rfq=${rfq.rfqId} — ${filledSoFar}/${d.totalLimit}`);
      logAsync(p, rfq, null, 'limitreached');
      // No Telegram — every post-ceiling RFQ would spam. Console above is enough.
      return;
    }
    counts.declined++;
    if (d.reason === 'rfq_too_large') {
      console.log(
        `[${MODE}] SKIP oversized RFQ ${p.label} rfq=${rfq.rfqId} ` +
        `want=${size.contracts} remaining=${d.remaining}/${d.totalLimit}`
      );
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

  // Prefer pre-staged prices for the body (Step 3)
  const noBid = (st && st.noBid) || d.quote.no_bid;
  const yesBid = (st && st.yesBid) || d.quote.yes_bid || YES_DECLINE;
  const restRemainder = (st && st.rest_remainder != null) ? st.rest_remainder : d.quote.rest_remainder;

  // ─── LIVE POST first (Step 1) ─────────────────────────────────────────
  if (!engaged) {
    const t2 = performance.now();
    try {
      const result = await postQuote(rfq.rfqId, noBid, yesBid, restRemainder);
      const t3 = performance.now();

      // Step 0 — latency log
      console.log(
        `[LAT] match=${(t1 - t0).toFixed(1)} pre=${(t2 - t1).toFixed(1)} ` +
        `post=${(t3 - t2).toFixed(1)} total=${(t3 - t0).toFixed(1)}ms ` +
        `rfq=${rfq.rfqId} quote=${result.id}`
      );

      counts.posted++;
      pendingQuotes.set(result.id, {
        parlayId: p.id,
        userId: p.user_id,
        contracts: d.contracts,
        label: p.label,
        rfqId: rfq.rfqId,
        starts_at: p.starts_at,
        legs: p.legs,
        leg_keys: p.leg_keys || p.legKeys,
      });

      console.log(
        `[${MODE}] QUOTED ${p.label} rfq=${rfq.rfqId} quote_id=${result.id} ` +
        `contracts=${d.contracts} locks=${d.locks}`
      );

      // Fire-and-forget after POST (Step 1)
      logAsync(p, rfq, d, 'quoted', { quote_id: result.id, is_live: true });
      sendAlert(
        `✅ QUOTED — ${p.label}\n` +
        `rfq ${shortId(rfq.rfqId)} · quote ${shortId(result.id)}\n` +
        `${d.contracts} contracts · NO @ $${noBid}` +
        (p.fill_american != null ? ` · ${sgn(p.fill_american)}` : '')
      ).catch(() => {});
    } catch (e) {
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
    `Auto-confirms quote_accepted (HVM ~3s window). Ceiling advances only on quote_executed.`
  );

  await refresh();
  setInterval(refresh, 30000);
  setInterval(() => {
    cancelPendingIfStarted().catch((e) => console.error(`[${MODE}] cancel-on-start tick`, e.message));
  }, 2000);

  // Step 2 — pre-warm + keep warm
  await warmConnection();
  setInterval(warmConnection, 45000);

  startHeartbeat(supabase, MODE, counts, () => parlays.length);

  const client = createKalshiWs({
    keyId: KEY_ID,
    pem: PEM,
    onStatus: (s, i) => console.log(`[${MODE}] ws:${s}`, i || ''),
    onRfqCreated: (rfq, env) => onRfq(rfq, env).catch((e) => console.error('onRfq', e)),
    onQuoteAccepted: (evt) => onQuoteAccepted(evt).catch((e) => console.error('onQuoteAccepted', e)),
    onQuoteExecuted: (evt) => onQuoteExecuted(evt).catch((e) => console.error('onQuoteExecuted', e)),
  });

  setInterval(() => console.log(`[${MODE}] tallies`, counts), 60000);
  process.on('SIGINT', () => {
    client.stop();
    try { kalshiHttp.close(); } catch (_) {}
    console.log(`[${MODE}] final`, counts);
    process.exit(0);
  });
  client.start();
}
main();
