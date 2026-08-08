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
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { createKalshiWs } = require('./kalshi-ws');
const { normalizePem } = require('./kalshi-auth');
const { matchParlay } = require('./rfq');
const { decideAtFill } = require('./engine');

const MODE = 'SHADOW';
const KEY_ID = process.env.KALSHI_KEY_ID;
const PEM = normalizePem(process.env.Kalshi_combo_key || process.env.KALSHI_PRIVATE_KEY || '');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

let parlays = [];
let killByUser = {};
const counts = { rfqs: 0, combos: 0, matched: 0, wouldQuote: 0, declined: 0, noLock: 0 };
let sampled = 0; // TEMP diagnostic — remove after confirming leg format

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
  } catch (e) { console.error(`[${MODE}] refresh failed`, e.message); }
}
const killEngagedFor = (userId) => killByUser[userId] !== false; // default engaged (safe)

async function log(p, rfq, d, status) {
  try {
    await supabase.from('combo_submissions').insert({
      user_id: p.user_id, parlay_id: p.id, rfq_id: rfq.rfqId, label: p.label,
      fill_american: d ? d.fillAmerican : p.fill_american,
      contracts: rfq.contracts, worst_lock: d ? d.worst : null, status,
    });
  } catch (e) { console.error(`[${MODE}] log insert failed`, e.message); }
}

async function onRfq(rfq) {
  counts.rfqs++;
  if (!rfq.isCombo || rfq.contracts == null) return;
  counts.combos++;
  if (sampled < 10 && rfq.mveCollection === 'KXMVESPORTSMULTIGAMEEXTENDED-R') { // TEMP diagnostic
    sampled++;
    console.log(`[SHADOW][SAMPLE] coll=${rfq.mveCollection} contracts=${rfq.contracts} legs=${JSON.stringify(rfq.legKeys)}`);
  }
  const p = matchParlay(rfq, parlays);
  if (!p) return;
  counts.matched++;
  const engaged = killEngagedFor(p.user_id);
  const d = decideAtFill({
    parlayStake: p.parlay_stake, parlayAmerican: p.parlay_american, fillAmerican: p.fill_american,
    fairAmerican: p.fair_american, rfqContracts: rfq.contracts, maxContracts: p.max_contracts, scaleFactor: p.scale_factor,
  });
  if (!d.ok) { counts.declined++; console.log(`[${MODE}] DECLINE ${p.label} rfq=${rfq.rfqId} (${d.reason})`); await log(p, rfq, null, 'declined'); return; }
  if (!d.locks) { counts.noLock++; console.log(`[${MODE}] NO-LOCK ${p.label} rfq=${rfq.rfqId} worst=$${d.worst}`); return; }
  counts.wouldQuote++;
  console.log(`[${MODE}] WOULD QUOTE ${engaged ? '(kill-switch engaged) ' : ''}${p.label} rfq=${rfq.rfqId} post=${JSON.stringify(d.quote)} lock worst=$${d.worst} hit=$${d.hit} miss=$${d.miss}`);
  await log(p, rfq, d, 'shadow'); // ALWAYS shadow here — this runner never posts.
}

async function main() {
  if (!KEY_ID || !PEM || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error(`[${MODE}] missing env: need KALSHI_KEY_ID, Kalshi_combo_key, SUPABASE_URL, SUPABASE_SERVICE_KEY`);
    process.exit(1);
  }
  console.log(`[${MODE}] starting — logs would-be quotes, NEVER places an order.`);
  await refresh();
  setInterval(refresh, 30000);
  const client = createKalshiWs({
    keyId: KEY_ID, pem: PEM,
    onStatus: (s, i) => console.log(`[${MODE}] ws:${s}`, i || ''),
    onRfqCreated: (rfq) => onRfq(rfq).catch((e) => console.error('onRfq', e)),
  });
  setInterval(() => console.log(`[${MODE}] tallies`, counts), 60000);
  process.on('SIGINT', () => { client.stop(); console.log(`[${MODE}] final`, counts); process.exit(0); });
  client.start();
}
main();
