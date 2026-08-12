// ─────────────────────────────────────────────────────────────────────────
// live-runner.js — LIVE worker (latency-optimized)
//
// ACCOUNTING: POST → 'quoted'. Ceiling advances only on quote_executed.
// PARTIAL-FILL: d.locks is informational; post while ceiling remains.
// LATENCY: Steps 0–4 — instrument, POST first, undici keep-alive, pre-stage.
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
const { decideAtFill, fillView } = require('./engine');
const { startHeartbeat } = require('./heartbeat');

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
      supabase.from('combo_submissions')
        .select('parlay_id,contracts,status')
        .eq('status', 'filled'),
    ]);
    parlays = p || [];
    killByUser = {};
    (s || []).forEach((r) => (killByUser[r.user_id] = r.kill_switch));

    filledByParlay = {};
    (fills || []).forEach((r) => {
      filledByParlay[r.parlay_id] = (filledByParlay[r.parlay_id] || 0) + Number(r.contracts || 0);
    });

    // Pre-stage prices (Step 3)
    const next = {};
    for (const row of parlays) {
      const v = fillView(row.fill_american);
      next[row.id] = {
        noBid: v.noBid,
        yesBid: '0.00',
        rest_remainder: false,
        fillAmerican: row.fill_american,
        effTaker: v.effTaker,
      };
    }
    staged = next;

    console.log(`[${MODE}] refreshed — ${parlays.length} active parlay(s), staged=${Object.keys(staged).length}`);
  } catch (e) {
    console.error(`[${MODE}] refresh failed`, e.message);
  }
}

const filledSoFarFor = (id) => (filledByParlay[id] || 0) + (sessionFilledByParlay[id] || 0);
const killEngagedFor = (userId) => killByUser[userId] !== false;

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
    status,
    ...extra,
  }).then(({ error }) => {
    if (error) console.error(`[${MODE}] log insert failed`, error.message);
  }).catch((e) => console.error(`[${MODE}] log insert failed`, e.message));
}

async function postQuote(rfqId, noBid, yesBid, restRemainder) {
  const body = JSON.stringify({
    rfq_id: rfqId,
    yes_bid: yesBid,
    no_bid: noBid,
    rest_remainder: restRemainder,
  });
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

async function confirmQuote(rfqId, quoteId) {
  const path = confirmPath(rfqId, quoteId);
  const headers = {
    ...authHeaders({ keyId: KEY_ID, pem: PEM, method: 'PUT', signPath: path }),
  };
  const { statusCode, body: resBody } = await kalshiHttp.request({
    path,
    method: 'PUT',
    headers,
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
    // Confirm FIRST — HVM confirmation window is ~3s. Log/Telegram after.
    await confirmQuote(rfqId, quoteId);
    const ms = (performance.now() - t0).toFixed(1);
    console.log(
      `[${MODE}] CONFIRMED quote_id=${quoteId} rfq_id=${rfqId} in ${ms}ms ` +
      `side=${evt.acceptedSide || '?'} label=${pending ? pending.label : '(unknown)'}`
    );
    sendAlert(
      `✅ QUOTE CONFIRMED — ${pending ? pending.label : quoteId}\n` +
      `quote ${quoteId} · rfq ${rfqId}\n` +
      `side ${evt.acceptedSide || '?'} · confirm ${ms}ms\n` +
      `Waiting for quote_executed / fill.`
    ).catch(() => {});
  } catch (e) {
    console.error(`[${MODE}] CONFIRM FAILED quote_id=${quoteId} rfq_id=${rfqId}`, e.message);
    sendAlert(
      `❌ CONFIRM FAILED — ${pending ? pending.label : quoteId}\n` +
      `quote ${quoteId} · rfq ${rfqId}\n` +
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
    const { error } = await supabase
      .from('combo_submissions')
      .update({ status: 'filled', order_id: orderId || null })
      .eq('quote_id', quoteId);
    if (error) {
      console.error(`[${MODE}] update filled failed, inserting`, error.message);
      await supabase.from('combo_submissions').insert({
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
    }
  } catch (e) {
    console.error(`[${MODE}] onQuoteExecuted DB error`, e.message);
  }

  sessionFilledByParlay[pending.parlayId] =
    (sessionFilledByParlay[pending.parlayId] || 0) + contracts;
  pendingQuotes.delete(quoteId);
  counts.filled++;

  console.log(
    `[${MODE}] FILL CONFIRMED ${pending.label} quote_id=${quoteId} order_id=${orderId} ` +
    `contracts=${contracts} sessionTotal=${sessionFilledByParlay[pending.parlayId]}`
  );
  sendAlert(
    `✅ FILL CONFIRMED — ${pending.label}\n` +
    `order ${orderId || '(none)'} · quote ${quoteId}\n` +
    `+${contracts} contracts now count against the ceiling`
  ).catch(() => {});
}

async function onRfq(rfq) {
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

  const engaged = killEngagedFor(p.user_id);
  const filledSoFar = filledSoFarFor(p.id);
  const st = staged[p.id];

  const size = resolveRfqContracts(rfq, p.fill_american, st && st.noBid);
  if (size.contracts == null || !(size.contracts > 0)) {
    counts.declined++;
    logAsync(p, rfq, null, 'declined');
    return;
  }
  if (size.source === 'dollar') counts.dollarRfqs++;

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
      sendAlert(
        `🛑 LIMIT REACHED — ${p.label}\nalready at ${filledSoFar}/${d.totalLimit}\nrfq ${rfq.rfqId}`
      ).catch(() => {});
      return;
    }
    counts.declined++;
    logAsync(p, rfq, null, 'declined');
    sendAlert(`⚠️ DECLINED — ${p.label}\nrfq ${rfq.rfqId} · ${d.reason}`).catch(() => {});
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
  const yesBid = (st && st.yesBid) || d.quote.yes_bid;
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
      });

      console.log(
        `[${MODE}] QUOTED ${p.label} rfq=${rfq.rfqId} quote_id=${result.id} ` +
        `contracts=${d.contracts} locks=${d.locks}`
      );

      // Fire-and-forget after POST (Step 1)
      logAsync(p, rfq, d, 'quoted', { quote_id: result.id, is_live: true });
      sendAlert(
        `📤 QUOTE POSTED — ${p.label}\n` +
        `quote ${result.id} · rfq ${rfq.rfqId}\n` +
        `offered ${d.contracts} NO @ $${noBid}\n` +
        `${d.locks ? '🔒 would lock if filled' : '⚠️ partial — interim exposure if filled'}\n` +
        `Does NOT count against ceiling until executed.`
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
      sendAlert(`❌ QUOTE FAILED — ${p.label}\nrfq ${rfq.rfqId}\n${e.message}`).catch(() => {});
    }
    return;
  }

  // Kill-switch engaged → shadow only (not latency-critical)
  logAsync(p, rfq, d, 'shadow');
  const cost = (d.contracts * parseFloat(noBid)).toFixed(0);
  sendAlert(
    `🎯 MATCH (shadow) — ${p.label}\n` +
    `taker ~${size.contracts} · would sell ${d.contracts} NO @ $${noBid} ≈ $${cost}\n` +
    `rfq ${rfq.rfqId} · trueFills ${filledSoFar}/${d.totalLimit}\n` +
    `${d.locks ? '🔒 LOCKS' : '⚠️ NO-LOCK'} worst $${d.worst}`
  ).catch(() => {});
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

  // Step 2 — pre-warm + keep warm
  await warmConnection();
  setInterval(warmConnection, 45000);

  startHeartbeat(supabase, MODE, counts, () => parlays.length);

  const client = createKalshiWs({
    keyId: KEY_ID,
    pem: PEM,
    onStatus: (s, i) => console.log(`[${MODE}] ws:${s}`, i || ''),
    onRfqCreated: (rfq) => onRfq(rfq).catch((e) => console.error('onRfq', e)),
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
