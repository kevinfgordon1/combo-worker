// ─────────────────────────────────────────────────────────────────────────
// live-runner.js — LIVE worker. Connects to the live Kalshi RFQ firehose,
// matches incoming combo RFQs against the user's active parlays (from Supabase),
// and (when kill-switch is disarmed AND RFQ size ≤ hedge cap) posts a real
// quote via POST /communications/quotes.
//
// Conservative rule: only quotes when rfq.contracts ≤ hedge cap.
// Larger RFQs are logged as shadow and skipped so we never risk more size
// than planned.
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
const counts = {
  rfqs: 0, combos: 0, matched: 0, wouldQuote: 0,
  declined: 0, noLock: 0, tooBig: 0, posted: 0, postFailed: 0,
};

async function refresh() {
  try {
    const [{ data: p }, { data: s }] = await Promise.all([
      supabase.from('combo_parlays').select('*').eq('active', true),
      supabase.from('combo_settings').select('user_id,kill_switch'),
    ]);
    parlays = p || [];
    killByUser = {};
    (s || []).forEach((r) => (killByUser[r.user_id] = r.kill_switch));
    console.log(`[${MODE}] refreshed — ${parlays.length} active parlay(s)`);
  } catch (e) {
    console.error(`[${MODE}] refresh failed`, e.message);
  }
}
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
  const d = decideAtFill({
    parlayStake: p.parlay_stake,
    parlayAmerican: p.parlay_american,
    fillAmerican: p.fill_american,
    fairAmerican: p.fair_american,
    rfqContracts: rfq.contracts,
    hedgeMode: p.hedge_mode || '1x',
  });

  if (!d.ok) {
    counts.declined++;
    console.log(`[${MODE}] DECLINE ${p.label} rfq=${rfq.rfqId} (${d.reason})`);
    await log(p, rfq, null, 'declined');
    await sendAlert(`⚠️ RFQ matched but DECLINED — ${p.label}\nrfq ${rfq.rfqId} · reason ${d.reason}`);
    return;
  }

  const cost = (d.contracts * parseFloat(d.quote.no_bid)).toFixed(0);
  const sizeNote = d.partial
    ? `fills your full ${d.cap} hedge (taker wanted ${rfq.contracts} — you take ${d.contracts})`
    : d.contracts < d.cap
      ? `PARTIAL hedge: only ${d.contracts} available vs your ${d.cap} even-hedge`
      : `full even hedge (${d.contracts})`;

  await sendAlert(
    `🎯 Combo RFQ MATCH — ${p.label}\n` +
    `taker requested ${rfq.contracts} contracts (rfq ${rfq.rfqId})\n` +
    `➡️ PLACE: sell ${d.contracts} NO @ $${d.quote.no_bid}  ≈ $${cost} to put up\n` +
    `   ${sizeNote}\n` +
    `   your ${sgn(p.fill_american)} net · taker gets ${sgn(d.effTakerOdds)}\n` +
    `${d.locks ? '🔒 LOCKS' : '⚠️ NO-LOCK'}  worst $${d.worst}  (win $${d.hit} / lose $${d.miss})`
  );

  if (!d.locks) {
    counts.noLock++;
    console.log(`[${MODE}] NO-LOCK ${p.label} rfq=${rfq.rfqId} worst=$${d.worst}`);
    await log(p, rfq, d, 'shadow');
    return;
  }

  // Conservative size rule
  if (rfq.contracts > d.cap) {
    counts.tooBig++;
    console.log(`[${MODE}] SKIP (RFQ too large) ${p.label} rfq=${rfq.rfqId} wanted=${rfq.contracts} cap=${d.cap}`);
    await log(p, rfq, d, 'shadow');
    await sendAlert(
      `⚠️ RFQ matched but SKIPPED (too large) — ${p.label}\n` +
      `rfq ${rfq.rfqId} · taker wanted ${rfq.contracts}, your cap ${d.cap}`
    );
    return;
  }

  counts.wouldQuote++;
  console.log(
    `[${MODE}] WOULD QUOTE ${engaged ? '(kill-switch engaged) ' : ''}${p.label} ` +
    `rfq=${rfq.rfqId} post=${JSON.stringify(d.quote)} lock worst=$${d.worst} hit=$${d.hit} miss=$${d.miss}`
  );

  if (!engaged) {
    try {
      const result = await postQuote(rfq, d);
      counts.posted++;
      console.log(`[${MODE}] QUOTED ${p.label} rfq=${rfq.rfqId} quote_id=${result.id}`);
      await log(p, rfq, d, 'filled', { quote_id: result.id });
      await sendAlert(
        `✅ LIVE QUOTE POSTED — ${p.label}\n` +
        `quote ${result.id} · rfq ${rfq.rfqId}\n` +
        `sell ${d.contracts} NO @ $${d.quote.no_bid}`
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
    console.error(`[${MODE}] missing env: need KALSHI_KEY_ID, Kalshi_combo_key, SUPABASE_URL, SUPABASE_SERVICE_KEY`);
    process.exit(1);
  }
  console.log(`[${MODE}] starting — will post real quotes when kill-switch is disarmed and RFQ size ≤ hedge cap.`);
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
