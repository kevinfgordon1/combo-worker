// ─────────────────────────────────────────────────────────────────────────
// quote-watcher.js — READ-ONLY observability. Answers two questions:
//   1. How many RFQs matched each parlay?          → combo_matches
//   2. What happened to each quote we posted?       → quote_outcomes
//      (accepted / executed / lost, response latency, and real-fill reconcile)
//
// It PLACES NOTHING. It only listens to the same Kalshi 'communications' feed
// the worker uses (its own separate WS connection), runs the SAME leg-set match
// (rfq.js) to count matches, watches YOUR OWN quote lifecycle events, and polls
// GET /portfolio/fills to confirm real executions. No order path, ever.
//
// Memory-safe: it INSERTs only on a MATCH (rare — your exact combos) or on one of
// YOUR OWN quote events (also rare — quote_* events are private to you). It never
// stores the firehose. This is nothing like the debug capture that OOM'd.
//
// Env: KALSHI_KEY_ID, Kalshi_combo_key (or KALSHI_PRIVATE_KEY),
//      SUPABASE_URL, SUPABASE_SERVICE_KEY.  Run as its own process:  node quote-watcher.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { createKalshiWs } = require('./kalshi-ws');
const { normalizePem, authHeaders } = require('./kalshi-auth');
const { matchParlay, normalizeRfq } = require('./rfq');

const KEY_ID = process.env.KALSHI_KEY_ID;
const PEM = normalizePem(process.env.Kalshi_combo_key || process.env.KALSHI_PRIVATE_KEY || '');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const REST = process.env.KALSHI_REST_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
const LOST_AFTER_MS = 30000;         // no acceptance within this window → mark 'lost' (outbid / not taken)

// self-contained lock math (mirrors engine.js / ComboLocks — read-only, informational only)
const impliedProb = (a) => (a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100));
const aToDec = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
const r2 = (x) => Math.round(x * 100) / 100;

let parlays = [];
let postedByQuote = {};   // quote_id -> {quote_id, rfq_id, parlay_id, label, posted_at}
let postedByRfq = {};     // rfq_id   -> same record
const matchedRfqTs = new Map(); // rfq_id -> ms we saw the matching rfq_created (bounded; matched only)

const counts = { rfqs: 0, matched: 0, quoteEvents: 0, accepted: 0, executed: 0, lost: 0, reconciled: 0 };

async function loadState() {
  try {
    const [{ data: p }, { data: subs }] = await Promise.all([
      supabase.from('combo_parlays').select('*').eq('active', true),
      supabase.from('combo_submissions')
        .select('parlay_id,label,rfq_id,quote_id,created_at')
        .not('quote_id', 'is', null)
        .order('created_at', { ascending: false }).limit(200),
    ]);
    parlays = p || [];
    const bq = {}, br = {}, seed = [];
    (subs || []).forEach((s) => {
      if (!s.quote_id) return;
      const rec = { quote_id: s.quote_id, rfq_id: s.rfq_id, parlay_id: s.parlay_id, label: s.label, posted_at: s.created_at };
      bq[s.quote_id] = rec; if (s.rfq_id) br[s.rfq_id] = rec;
      seed.push({ quote_id: s.quote_id, rfq_id: s.rfq_id, parlay_id: s.parlay_id, label: s.label, posted_at: s.created_at });
    });
    postedByQuote = bq; postedByRfq = br;
    // Seed a 'posted' outcome row for every quote we know about (ignore if already tracked),
    // so even quotes whose live events we missed still appear and get aged to 'lost'.
    if (seed.length) await supabase.from('quote_outcomes').upsert(seed, { onConflict: 'quote_id', ignoreDuplicates: true });
    console.log(`[WATCH] state — ${parlays.length} active parlay(s), ${seed.length} posted quote(s) tracked`);
  } catch (e) { console.error('[WATCH] loadState', e.message); }
}

function lockAt(p, N) {
  if (!(N > 0) || !p.parlay_stake || !p.parlay_american || !p.fill_american) return { locks: null, worst: null };
  const s = impliedProb(p.fill_american);
  const winReturn = p.parlay_stake * aToDec(p.parlay_american);
  const hit = (winReturn - p.parlay_stake) + N * s - N;
  const miss = (-p.parlay_stake) + N * s;
  const worst = Math.min(hit, miss);
  return { locks: worst >= 0, worst: r2(worst) };
}

async function onEvent(env) {
  const type = env && env.type;
  if (!type) return;

  // ── 1. Count matches per parlay ─────────────────────────────────────────
  if (type === 'rfq_created') {
    counts.rfqs++;
    let rfq; try { rfq = normalizeRfq(env); } catch (_) { return; }
    if (!rfq || !rfq.isCombo || !rfq.legKeys || !rfq.legKeys.length) return;
    const p = matchParlay(rfq, parlays);
    if (!p) return;
    counts.matched++;
    matchedRfqTs.set(rfq.rfqId, Date.now());
    if (matchedRfqTs.size > 500) matchedRfqTs.delete(matchedRfqTs.keys().next().value); // bounded
    const { locks, worst } = lockAt(p, rfq.contracts);
    try {
      await supabase.from('combo_matches').upsert({
        rfq_id: rfq.rfqId, parlay_id: p.id, label: p.label,
        sizing: rfq.contracts != null ? 'contract' : 'dollar',
        contracts: rfq.contracts, target_dollars: rfq.targetCostDollars,
        locks, worst,
      }, { onConflict: 'rfq_id,parlay_id', ignoreDuplicates: true });
    } catch (e) { console.error('[WATCH] match upsert', e.message); }
    return;
  }

  // ── 2. Track outcomes of OUR OWN quotes ─────────────────────────────────
  if (type.indexOf('quote_') === 0) {
    const m = env.msg || {};
    const qid = m.id || m.quote_id || null;
    const rid = m.rfq_id || null;
    const rec = (qid && postedByQuote[qid]) || (rid && postedByRfq[rid]) || null;
    if (!rec) return;                 // not one of our quotes — ignore
    counts.quoteEvents++;
    const nowIso = new Date().toISOString();
    const patch = { updated_at: nowIso, raw: env };
    if (type === 'quote_accepted') { patch.outcome = 'accepted'; patch.accepted_at = nowIso; counts.accepted++; }
    else if (type === 'quote_executed') {
      patch.outcome = 'executed'; patch.executed_at = nowIso; counts.executed++;
      patch.order_id = m.order_id || m.creator_order_id || m.maker_order_id || null;
    }
    // else quote_created: leave outcome as-is (row already seeded 'posted')
    const rts = rec.rfq_id && matchedRfqTs.get(rec.rfq_id);
    if (rts && (type === 'quote_accepted' || type === 'quote_executed')) patch.responded_ms = Date.now() - rts;
    try { await supabase.from('quote_outcomes').update(patch).eq('quote_id', rec.quote_id); }
    catch (e) { console.error('[WATCH] outcome update', e.message); }
  }
}

// Age un-accepted quotes to 'lost' (outbid, or the taker accepted no one / let it expire).
async function ageLost() {
  try {
    const cutoff = new Date(Date.now() - LOST_AFTER_MS).toISOString();
    const { data } = await supabase.from('quote_outcomes')
      .update({ outcome: 'lost', updated_at: new Date().toISOString() })
      .eq('outcome', 'posted').lt('posted_at', cutoff).select('quote_id');
    if (data && data.length) counts.lost += data.length;
  } catch (e) { console.error('[WATCH] ageLost', e.message); }
}

async function fetchFills() {
  const signPath = '/trade-api/v2/portfolio/fills';
  const headers = authHeaders({ keyId: KEY_ID, pem: PEM, method: 'GET', signPath });
  const res = await fetch(`${REST}/portfolio/fills?limit=200`, { headers });
  if (!res.ok) throw new Error(`fills ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.fills || [];
}

// Confirm executed quotes against the real account fills (best-effort by order_id).
async function reconcileFills() {
  try {
    const { data: pend } = await supabase.from('quote_outcomes')
      .select('quote_id,order_id').eq('outcome', 'executed').eq('fill_confirmed', false).not('order_id', 'is', null);
    if (!pend || !pend.length) return;
    const fills = await fetchFills();
    for (const o of pend) {
      const f = fills.find((x) => x.order_id === o.order_id || x.creator_order_id === o.order_id);
      if (f) {
        await supabase.from('quote_outcomes')
          .update({ fill_confirmed: true, fill_count: Number(f.count_fp || f.count || 0), updated_at: new Date().toISOString() })
          .eq('quote_id', o.quote_id);
        counts.reconciled++;
      }
    }
  } catch (e) { console.error('[WATCH] reconcileFills', e.message); }
}

async function main() {
  if (!KEY_ID || !PEM || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('[WATCH] missing env: KALSHI_KEY_ID, Kalshi_combo_key, SUPABASE_URL, SUPABASE_SERVICE_KEY');
    process.exit(1);
  }
  console.log('[WATCH] read-only quote/match watcher starting — counts matches, tracks quote outcomes, places NOTHING.');
  await loadState();
  setInterval(loadState, 30000);
  setInterval(ageLost, 20000);
  setInterval(reconcileFills, 30000);
  setInterval(() => console.log('[WATCH] tallies', counts), 60000);

  const client = createKalshiWs({
    keyId: KEY_ID, pem: PEM,
    onStatus: (s, i) => console.log(`[WATCH] ws:${s}`, i || ''),
    onEvent: (env) => { onEvent(env).catch((e) => console.error('[WATCH] onEvent', e.message)); },
  });
  process.on('SIGINT', () => { client.stop(); console.log('[WATCH] final', counts); process.exit(0); });
  client.start();
}
main();
