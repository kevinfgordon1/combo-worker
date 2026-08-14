// ─────────────────────────────────────────────────────────────────────────
// shadow-runner.js — SHADOW worker. Connects to the live Kalshi RFQ firehose,
// matches incoming combo RFQs against the user's active parlays (from Supabase),
// and LOGS the quote it WOULD post to combo_submissions (status 'shadow').
//
// It NEVER places an order — there is NO create-quote / POST code in this file.
// Going live is a SEPARATE runner added later, gated by the kill-switch + caps.
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
const { normalizePem } = require('./kalshi-auth');
const { matchParlay } = require('./rfq');
const { decideAtFill } = require('./engine');
const { shortId } = require('./short-id');

const MODE = 'SHADOW';
// Demo read-check: if DEMO_KALSHI_* are present, use them (point KALSHI_WS_URL at the demo WS).
// Non-destructive — production KALSHI_KEY_ID / Kalshi_combo_key are left untouched.
const DEMO = !!process.env.DEMO_KALSHI_KEY_ID;
const KEY_ID = process.env.DEMO_KALSHI_KEY_ID || process.env.KALSHI_KEY_ID;
const PEM = normalizePem(process.env.DEMO_KALSHI_COMBO_KEY || process.env.Kalshi_combo_key || process.env.KALSHI_PRIVATE_KEY || '');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Optional personal alert channel (notification only — never places an order).
// Set both on the host to get a Telegram DM the instant an RFQ matches a parlay.
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_ALERT_CHAT_ID;
async function sendAlert(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log(`[${MODE}] ALERT (telegram not configured): ${text.replace(/\n/g, ' | ')}`); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text }),
    });
    if (!r.ok) console.error(`[${MODE}] telegram send failed`, r.status, await r.text());
  } catch (e) { console.error(`[${MODE}] telegram error`, e.message); }
}
const sgn = (n) => (n > 0 ? '+' + n : '' + n);

let parlays = [];
let killByUser = {};
let wsConnected = false; // tracked from ws status — recorded to combo_worker_stats so a disconnect (e.g. the demo-WS 401) is visible in the DB, not just the console.
// Cumulative share-limit tracking (per parlay id):
//   filledByParlay    — contracts already filled, reconciled from the DB every refresh (survives restarts)
//   simFilledByParlay — contracts this SHADOW run *would* have filled this session (so back-to-back RFQs
//                       respect the running total and we can prove the ceiling stops new fills).
// In LIVE (live-runner), the equivalent of simFilledByParlay is a REAL in-memory counter you bump on each
// successful POST — see the handoff notes. The engine just takes filledSoFar and respects it.
let filledByParlay = {};
let simFilledByParlay = {};
const counts = { rfqs: 0, combos: 0, matched: 0, wouldQuote: 0, declined: 0, noLock: 0, limitReached: 0 };

// Durable firehose record + heartbeat. Every row is a point-in-time snapshot of what
// the worker has seen. Absence of recent rows = worker down; ws_connected=false = feed down.
async function writeStats() {
  try {
    await supabase.from('combo_worker_stats').insert({
      mode: MODE, ws_connected: wsConnected,
      rfqs: counts.rfqs, combos: counts.combos, matched: counts.matched,
      would_quote: counts.wouldQuote, declined: counts.declined, no_lock: counts.noLock,
      active_parlays: parlays.length,
    });
  } catch (e) { console.error(`[${MODE}] stats insert failed`, e.message); }
}

async function refresh() {
  try {
    const [{ data: p }, { data: s }, { data: fills }] = await Promise.all([
      supabase.from('combo_parlays').select('*').eq('active', true),
      supabase.from('combo_settings').select('user_id,kill_switch'),
      // Real fills already booked, per parlay — the source of truth for the cumulative ceiling.
      supabase.from('combo_submissions').select('parlay_id,contracts,status,is_live').or('status.eq.filled,is_live.eq.true'),
    ]);
    parlays = p || [];
    killByUser = {};
    (s || []).forEach((r) => (killByUser[r.user_id] = r.kill_switch));
    filledByParlay = {};
    (fills || []).forEach((r) => { filledByParlay[r.parlay_id] = (filledByParlay[r.parlay_id] || 0) + Number(r.contracts || 0); });
    console.log(`[${MODE}] refreshed — ${parlays.length} active parlay(s)`);
  } catch (e) { console.error(`[${MODE}] refresh failed`, e.message); }
}
// Contracts counted against a parlay's ceiling: real booked fills (DB) + would-be fills this session.
const filledSoFarFor = (id) => (filledByParlay[id] || 0) + (simFilledByParlay[id] || 0);
const killEngagedFor = (userId) => killByUser[userId] !== false; // default engaged (safe)

async function log(p, rfq, d, status) {
  try {
    await supabase.from('combo_submissions').insert({
      user_id: p.user_id, parlay_id: p.id, rfq_id: rfq.rfqId, label: p.label,
      fill_american: d ? d.fillAmerican : p.fill_american,
      contracts: d ? d.contracts : rfq.contracts, worst_lock: d ? d.worst : null, status,
    });
  } catch (e) { console.error(`[${MODE}] log insert failed`, e.message); }
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
    parlayStake: p.parlay_stake, parlayAmerican: p.parlay_american, fillAmerican: p.fill_american,
    fairAmerican: p.fair_american, rfqContracts: rfq.contracts, hedgeMode: p.hedge_mode || '1x',
    maxContracts: p.max_contracts, filledSoFar, // cumulative ceiling — stop once total is reached
  });
  if (!d.ok) {
    // Ceiling hit: this parlay has already filled its full max_contracts — decline everything further.
    if (d.reason === 'limit_reached') {
      counts.limitReached++;
      console.log(`[${MODE}] LIMIT REACHED ${p.label} rfq=${rfq.rfqId} — filled ${filledSoFar}/${d.totalLimit}, declining`);
      await log(p, rfq, null, 'limitreached');
      await sendAlert(`🛑 LIMIT REACHED — ${p.label}\nalready at ${filledSoFar}/${d.totalLimit} contracts — new RFQs are being DECLINED\nrfq ${shortId(rfq.rfqId)} skipped`);
      return;
    }
    counts.declined++;
    console.log(`[${MODE}] DECLINE ${p.label} rfq=${rfq.rfqId} (${d.reason})`);
    await log(p, rfq, null, 'declined');
    await sendAlert(`⚠️ RFQ matched but DECLINED — ${p.label}\nrfq ${shortId(rfq.rfqId)} · reason ${d.reason}`);
    return;
  }
  // ALERT on every match (notification only). The order is yours to place.
  const cost = (d.contracts * parseFloat(d.quote.no_bid)).toFixed(0);
  const sizeNote = d.trimmedByLimit
    ? `⚠️ TRIMMED to ceiling: only ${d.contracts} left before your ${d.totalLimit} limit (${d.filledSoFar} already filled)`
    : d.partial
      ? `fills to your ${d.cap} hedge (taker wanted ${rfq.contracts} — you take ${d.contracts})`
      : `full even hedge (${d.contracts})`;
  await sendAlert(
    `🎯 Combo RFQ MATCH — ${p.label}\n` +
    `taker requested ${rfq.contracts} contracts (rfq ${shortId(rfq.rfqId)})\n` +
    `➡️ PLACE: sell ${d.contracts} NO @ $${d.quote.no_bid}  ≈ $${cost} to put up\n` +
    `   ${sizeNote}\n` +
    `   cumulative: ${d.filledSoFar}+${d.contracts} of ${d.totalLimit} limit · ${d.remaining} left after\n` +
    `   your ${sgn(p.fill_american)} net · taker gets ${sgn(d.effTakerOdds)}\n` +
    `${d.locks ? '🔒 LOCKS' : '⚠️ NO-LOCK'}  worst $${d.worst}  (win $${d.hit} / lose $${d.miss})`
  );
  if (!d.locks) {
    counts.noLock++;
    console.log(`[${MODE}] NO-LOCK ${p.label} rfq=${rfq.rfqId} worst=$${d.worst}`);
    await log(p, rfq, d, 'nolock'); // record no-lock matches too — every match now leaves a durable row
    return;
  }
  counts.wouldQuote++;
  // Consume the ceiling: count this would-be fill so the NEXT RFQ this session sees a smaller remaining
  // and eventually gets declined at 'limit_reached'. (In live-runner, increment your REAL counter here,
  // only AFTER a successful POST.)
  simFilledByParlay[p.id] = (simFilledByParlay[p.id] || 0) + d.contracts;
  console.log(`[${MODE}] WOULD QUOTE ${engaged ? '(kill-switch engaged) ' : ''}${p.label} rfq=${rfq.rfqId} post=${JSON.stringify(d.quote)} cumulative=${filledSoFar + d.contracts}/${d.totalLimit} lock worst=$${d.worst} hit=$${d.hit} miss=$${d.miss}`);
  if (d.limitReached) console.log(`[${MODE}] CEILING HIT ${p.label} — reached ${d.totalLimit}; further RFQs will be declined`);
  await log(p, rfq, d, 'shadow'); // ALWAYS shadow here — this runner never posts.
}

async function main() {
  if (!KEY_ID || !PEM || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error(`[${MODE}] missing env: need KALSHI_KEY_ID, Kalshi_combo_key, SUPABASE_URL, SUPABASE_SERVICE_KEY`);
    process.exit(1);
  }
  console.log(`[${MODE}] starting — logs would-be quotes, NEVER places an order.`);
  if (DEMO) console.log(`[${MODE}] DEMO env — using DEMO_KALSHI key; WS=${process.env.KALSHI_WS_URL || '(default PROD — set KALSHI_WS_URL to the demo WS!)'}`);
  await refresh();
  setInterval(refresh, 30000);
  const client = createKalshiWs({
    keyId: KEY_ID, pem: PEM,
    onStatus: (s, i) => {
      wsConnected = (s === 'subscribed'); // only 'subscribed' means the feed is truly flowing
      console.log(`[${MODE}] ws:${s}`, i || '');
    },
    onRfqCreated: (rfq) => onRfq(rfq).catch((e) => console.error('onRfq', e)),
  });
  setInterval(() => { console.log(`[${MODE}] tallies`, counts); writeStats(); }, 60000);
  writeStats(); // one row at startup so the table shows the worker came up
  process.on('SIGINT', () => { client.stop(); console.log(`[${MODE}] final`, counts); process.exit(0); });
  client.start();
}
main();
