// ─────────────────────────────────────────────────────────────────────────
// live-runner.js — LIVE worker. Connects to the live Kalshi RFQ firehose,
// matches incoming combo RFQs against the user's active parlays (from Supabase),
// and (when kill-switch is disarmed) posts a real quote via POST /communications/quotes.
//
// IMPORTANT ACCOUNTING RULE (Section 17.2):
//   A successful POST only means "quote submitted". It does NOT mean the taker
//   accepted it. We log status 'quoted' on POST success and do NOT bump the
//   cumulative fill counter. Only a confirmed execution (quote_accepted /
//   quote_executed or portfolio fill) should ever write status 'filled' and
//   increment the counter. Until that wiring exists, max_contracts is protected
//   only by the DB trigger + manual review.
//
// Supports both contract-sized and dollar-sized RFQs.
//
// Env:
//   KALSHI_KEY_ID, Kalshi_combo_key (or KALSHI_PRIVATE_KEY)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID (optional)
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { createKalshiWs } = require('./kalshi-ws');
const { normalizePem, authHeaders } = require('./kalshi-auth');
const { matchParlay } = require('./rfq');
const { decideAtFill, fillView } = require('./engine');

const MODE = 'LIVE';
const KEY_ID = process.env.KALSHI_KEY_ID;
const PEM = normalizePem(process.env.Kalshi_combo_key || process.env.KALSHI_PRIVATE_KEY || '');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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

// Cumulative share-limit tracking
// filledByParlay        = true executions only (status='filled'), reconciled from DB
// sessionFilledByParlay = true executions this session (bumped ONLY on confirmed fill)
// Until execution events are wired, sessionFilledByParlay stays at 0 after POSTs.
let filledByParlay = {};
let sessionFilledByParlay = {};

const counts = {
  rfqs: 0,
  combos: 0,
  matched: 0,
  wouldQuote: 0,
  declined: 0,
  noLock: 0,
  limitReached: 0,
  posted: 0,       // successful POSTs (quotes submitted)
  postFailed: 0,
  dollarRfqs: 0,
};

async function refresh() {
  try {
    const [{ data: p }, { data: s }, { data: fills }] = await Promise.all([
      supabase.from('combo_parlays').select('*').eq('active', true),
      supabase.from('combo_settings').select('user_id,kill_switch'),
      // ONLY true executions. Do NOT include 'quoted' / is_live rows.
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

    console.log(`[${MODE}] refreshed — ${parlays.length} active parlay(s)`);
  } catch (e) {
    console.error(`[${MODE}] refresh failed`, e.message);
  }
}

const filledSoFarFor = (id) => (filledByParlay[id] || 0) + (sessionFilledByParlay[id] || 0);
const killEngagedFor = (userId) => killByUser[userId] !== false; // default engaged (safe)

async function log(p, rfq, d, status, extra = {}) {
  try {
    const contracts =
      d && d.contracts != null
        ? d.contracts
        : rfq.contracts != null
          ? rfq.contracts
          : null;
    await supabase.from('combo_submissions').insert({
      user_id: p.user_id,
      parlay_id: p.id,
      rfq_id: rfq.rfqId,
      label: p.label,
      fill_american: d ? d.fillAmerican : p.fill_american,
      contracts,
      worst_lock: d ? d.worst : null,
      status,
      ...extra,
    });
  } catch (e) {
    console.error(`[${MODE}] log insert failed`, e.message);
  }
}

async function postQuote(rfq, d) {
  const signPath = '/trade-api/v2/communications/quotes';
  const body = {
    rfq_id: rfq.rfqId,
    yes_bid: d.quote.yes_bid,
    no_bid: d.quote.no_bid,
    rest_remainder: d.quote.rest_remainder,
  };
  const headers = {
    'Content-Type': 'application/json',
    ...authHeaders({ keyId: KEY_ID, pem: PEM, method: 'POST', signPath }),
  };
  const res = await fetch(`https://external-api.kalshi.com${signPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Kalshi quote failed ${res.status}: ${text}`);
  }
  return JSON.parse(text); // { id: quote_id }
}

/**
 * Derive a usable contract count for decideAtFill.
 * - Contract-sized RFQ → use rfq.contracts
 * - Dollar-sized RFQ   → estimate from target_cost_dollars ÷ (1 − no_bid)
 */
function resolveRfqContracts(rfq, fillAmerican) {
  if (rfq.contracts != null && rfq.contracts > 0) {
    return { contracts: rfq.contracts, source: 'contracts' };
  }
  if (rfq.targetCostDollars != null && rfq.targetCostDollars > 0) {
    const v = fillView(fillAmerican);
    const noBid = parseFloat(v.noBid);
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

async function onRfq(rfq) {
  counts.rfqs++;

  // Accept combos with either a contract count OR a dollar target
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

  const size = resolveRfqContracts(rfq, p.fill_american);
  if (size.contracts == null || !(size.contracts > 0)) {
    counts.declined++;
    console.log(`[${MODE}] DECLINE ${p.label} rfq=${rfq.rfqId} (no usable size)`);
    await log(p, rfq, null, 'declined');
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
      console.log(
        `[${MODE}] LIMIT REACHED ${p.label} rfq=${rfq.rfqId} — filled ${filledSoFar}/${d.totalLimit}, declining`
      );
      await log(p, rfq, null, 'limitreached');
      await sendAlert(
        `🛑 LIMIT REACHED — ${p.label}\n` +
        `already at ${filledSoFar}/${d.totalLimit} contracts — new RFQs DECLINED\n` +
        `rfq ${rfq.rfqId} skipped`
      );
      return;
    }
    counts.declined++;
    console.log(`[${MODE}] DECLINE ${p.label} rfq=${rfq.rfqId} (${d.reason})`);
    await log(p, rfq, null, 'declined');
    await sendAlert(`⚠️ RFQ matched but DECLINED — ${p.label}\nrfq ${rfq.rfqId} · reason ${d.reason}`);
    return;
  }

  const cost = (d.contracts * parseFloat(d.quote.no_bid)).toFixed(0);
  const sizeNote = d.trimmedByLimit
    ? `⚠️ TRIMMED to ceiling: only ${d.contracts} left before your ${d.totalLimit} limit (${d.filledSoFar} already filled)`
    : d.partial
      ? `fills to your ${d.cap} hedge (taker wanted ~${size.contracts} — you take ${d.contracts})`
      : `full even hedge (${d.contracts})`;

  const sourceNote = size.source === 'dollar'
    ? ` (dollar RFQ $${size.targetCost} → ~${size.estimated} contracts)`
    : '';

  await sendAlert(
    `🎯 Combo RFQ MATCH — ${p.label}\n` +
    `taker requested ~${size.contracts} contracts${sourceNote} (rfq ${rfq.rfqId})\n` +
    `➡️ PLACE: sell ${d.contracts} NO @ $${d.quote.no_bid}  ≈ $${cost} to put up\n` +
    `   ${sizeNote}\n` +
    `   cumulative (true fills): ${d.filledSoFar}+${d.contracts} of ${d.totalLimit} · ${d.remaining} left after\n` +
    `   your ${sgn(p.fill_american)} net · taker gets ${sgn(d.effTakerOdds)}\n` +
    `${d.locks ? '🔒 LOCKS' : '⚠️ NO-LOCK'}  worst $${d.worst}  (win $${d.hit} / lose $${d.miss})`
  );

  if (!d.locks) {
    counts.noLock++;
    console.log(`[${MODE}] NO-LOCK ${p.label} rfq=${rfq.rfqId} worst=$${d.worst}`);
    await log(p, rfq, d, 'nolock');
    return;
  }

  counts.wouldQuote++;
  console.log(
    `[${MODE}] WOULD QUOTE ${engaged ? '(kill-switch engaged) ' : ''}${p.label} ` +
    `rfq=${rfq.rfqId} post=${JSON.stringify(d.quote)} ` +
    `trueFills=${filledSoFar}/${d.totalLimit} source=${size.source}`
  );

  // ─── LIVE POST ─────────────────────────────────────────────────────────
  if (!engaged) {
    try {
      const result = await postQuote(rfq, d);
      counts.posted++;

      // CRITICAL: do NOT bump sessionFilledByParlay here.
      // A successful POST only means the quote was submitted, not that it was taken.
      // Bump the counter only when a confirmed execution arrives (future work).

      console.log(
        `[${MODE}] QUOTED ${p.label} rfq=${rfq.rfqId} quote_id=${result.id} ` +
        `contracts=${d.contracts} (not yet a fill — waiting for acceptance)`
      );

      await log(p, rfq, d, 'quoted', {
        quote_id: result.id,
        is_live: true,
      });

      await sendAlert(
        `📤 QUOTE POSTED (not yet filled) — ${p.label}\n` +
        `quote ${result.id} · rfq ${rfq.rfqId}\n` +
        `offered ${d.contracts} NO @ $${d.quote.no_bid}\n` +
        `Waiting for taker acceptance. This does NOT count against the fill ceiling.`
      );
    } catch (e) {
      counts.postFailed++;
      console.error(`[${MODE}] POST FAILED ${p.label} rfq=${rfq.rfqId}`, e.message);
      await log(p, rfq, d, 'unfilled');
      await sendAlert(`❌ LIVE QUOTE FAILED — ${p.label}\nrfq ${rfq.rfqId}\n${e.message}`);
    }
  } else {
    await log(p, rfq, d, 'shadow');
  }
}

async function main() {
  if (!KEY_ID || !PEM || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error(
      `[${MODE}] missing env: need KALSHI_KEY_ID, Kalshi_combo_key, SUPABASE_URL, SUPABASE_SERVICE_KEY`
    );
    process.exit(1);
  }
  console.log(
    `[${MODE}] starting — posts real quotes when kill-switch is disarmed. ` +
    `POST success = 'quoted' (not a fill). Cumulative ceiling only counts true executions.`
  );
  await refresh();
  setInterval(refresh, 30000);

  const client = createKalshiWs({
    keyId: KEY_ID,
    pem: PEM,
    onStatus: (s, i) => console.log(`[${MODE}] ws:${s}`, i || ''),
    onRfqCreated: (rfq) => onRfq(rfq).catch((e) => console.error('onRfq', e)),
    // Future: add onQuoteAccepted / onQuoteExecuted handlers here to:
    //   1. log status 'filled' with order_id
    //   2. sessionFilledByParlay[parlayId] += contracts
  });

  setInterval(() => console.log(`[${MODE}] tallies`, counts), 60000);
  process.on('SIGINT', () => {
    client.stop();
    console.log(`[${MODE}] final`, counts);
    process.exit(0);
  });
  client.start();
}
main();
