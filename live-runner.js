// ─────────────────────────────────────────────────────────────────────────
// live-runner.js — LIVE worker. Connects to the live Kalshi RFQ firehose,
// matches incoming combo RFQs against the user's active parlays (from Supabase),
// and (when kill-switch is disarmed) posts a real quote via POST /communications/quotes.
//
// Cumulative share-limit: respects max_contracts across all fills for a parlay.
// Once the ceiling is reached, further RFQs are declined with reason 'limit_reached'.
//
// Env (set on the host):
//   KALSHI_KEY_ID          public Key ID
//   Kalshi_combo_key       private key PEM (armor optional; also accepts KALSHI_PRIVATE_KEY)
//   SUPABASE_URL           your project URL
//   SUPABASE_SERVICE_KEY   service-role key (bypasses RLS to read parlays / write logs)
//   TELEGRAM_BOT_TOKEN     (optional) your bot token — enables match alerts
//   TELEGRAM_ALERT_CHAT_ID (optional) your personal chat id to DM on a match
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { createKalshiWs } = require('./kalshi-ws');
const { normalizePem, authHeaders } = require('./kalshi-auth');
const { matchParlay } = require('./rfq');
const { decideAtFill } = require('./engine');

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
// Cumulative share-limit tracking (per parlay id)
//   filledByParlay     — real contracts already filled (reconciled from DB every refresh)
//   sessionFilledByParlay — contracts filled this LIVE session (bumped only after successful POST)
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
  posted: 0,
  postFailed: 0,
};

async function refresh() {
  try {
    const [{ data: p }, { data: s }, { data: fills }] = await Promise.all([
      supabase.from('combo_parlays').select('*').eq('active', true),
      supabase.from('combo_settings').select('user_id,kill_switch'),
      // Real fills already booked — source of truth for the cumulative ceiling
      supabase.from('combo_submissions')
        .select('parlay_id,contracts,status,is_live')
        .or('status.eq.filled,is_live.eq.true'),
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

// Contracts already counted against a parlay's ceiling
const filledSoFarFor = (id) => (filledByParlay[id] || 0) + (sessionFilledByParlay[id] || 0);
const killEngagedFor = (userId) => killByUser[userId] !== false; // default engaged (safe)

async function log(p, rfq, d, status, extra = {}) {
  try {
    await supabase.from('combo_submissions').insert({
      user_id: p.user_id,
      parlay_id: p.id,
      rfq_id: rfq.rfqId,
      label: p.label,
      fill_american: d ? d.fillAmerican : p.fill_american,
      contracts: d ? d.contracts : rfq.contracts,
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

async function onRfq(rfq) {
  counts.rfqs++;
  if (!rfq.isCombo || rfq.contracts == null) return;
  counts.combos++;

  const p = matchParlay(rfq, parlays);
  if (!p) return;
  counts.matched++;

  const engaged = killEngagedFor(p.user_id);
  const filledSoFar = filledSoFarFor(p.id);

  const d = decideAtFill({
    parlayStake: p.parlay_stake,
    parlayAmerican: p.parlay_american,
    fillAmerican: p.fill_american,
    fairAmerican: p.fair_american,
    rfqContracts: rfq.contracts,
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
        `already at ${filledSoFar}/${d.totalLimit} contracts — new RFQs are being DECLINED\n` +
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

  // Alert on every match
  const cost = (d.contracts * parseFloat(d.quote.no_bid)).toFixed(0);
  const sizeNote = d.trimmedByLimit
    ? `⚠️ TRIMMED to ceiling: only ${d.contracts} left before your ${d.totalLimit} limit (${d.filledSoFar} already filled)`
    : d.partial
      ? `fills to your ${d.cap} hedge (taker wanted ${rfq.contracts} — you take ${d.contracts})`
      : `full even hedge (${d.contracts})`;

  await sendAlert(
    `🎯 Combo RFQ MATCH — ${p.label}\n` +
    `taker requested ${rfq.contracts} contracts (rfq ${rfq.rfqId})\n` +
    `➡️ PLACE: sell ${d.contracts} NO @ $${d.quote.no_bid}  ≈ $${cost} to put up\n` +
    `   ${sizeNote}\n` +
    `   cumulative: ${d.filledSoFar}+${d.contracts} of ${d.totalLimit} limit · ${d.remaining} left after\n` +
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
    `cumulative=${filledSoFar + d.contracts}/${d.totalLimit} ` +
    `lock worst=$${d.worst} hit=$${d.hit} miss=$${d.miss}`
  );

  // ─── LIVE POST (only when kill-switch is disarmed) ─────────────────────
  if (!engaged) {
    try {
      const result = await postQuote(rfq, d);
      counts.posted++;

      // Bump the in-memory counter only after a successful POST
      sessionFilledByParlay[p.id] = (sessionFilledByParlay[p.id] || 0) + d.contracts;

      console.log(
        `[${MODE}] QUOTED ${p.label} rfq=${rfq.rfqId} quote_id=${result.id} ` +
        `contracts=${d.contracts} cumulative=${filledSoFar + d.contracts}/${d.totalLimit}`
      );

      await log(p, rfq, d, 'filled', {
        quote_id: result.id,
        is_live: true,
      });

      await sendAlert(
        `✅ LIVE QUOTE POSTED — ${p.label}\n` +
        `quote ${result.id} · rfq ${rfq.rfqId}\n` +
        `sell ${d.contracts} NO @ $${d.quote.no_bid}\n` +
        `cumulative: ${filledSoFar + d.contracts}/${d.totalLimit}`
      );

      if (d.limitReached) {
        console.log(`[${MODE}] CEILING HIT ${p.label} — reached ${d.totalLimit}; further RFQs will be declined`);
      }
    } catch (e) {
      counts.postFailed++;
      console.error(`[${MODE}] POST FAILED ${p.label} rfq=${rfq.rfqId}`, e.message);
      await log(p, rfq, d, 'unfilled');
      await sendAlert(`❌ LIVE QUOTE FAILED — ${p.label}\nrfq ${rfq.rfqId}\n${e.message}`);
    }
  } else {
    // Kill-switch still engaged → pure shadow
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
    `[${MODE}] starting — will post real quotes when kill-switch is disarmed. ` +
    `Respects cumulative max_contracts ceiling.`
  );
  await refresh();
  setInterval(refresh, 30000);

  const client = createKalshiWs({
    keyId: KEY_ID,
    pem: PEM,
    onStatus: (s, i) => console.log(`[${MODE}] ws:${s}`, i || ''),
    onRfqCreated: (rfq) => onRfq(rfq).catch((e) => console.error('onRfq', e)),
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
