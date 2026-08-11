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
// Our quoted price (no_bid) from the fill odds — same net-of-maker-fee math as engine/tab.
const KFEE = 0.0175;
const nominalProbFromEff = (sEff) => { const b = 1 - KFEE; return (-b + Math.sqrt(b * b + 4 * KFEE * sEff)) / (2 * KFEE); };
const noBidFor = (fillAmerican) => (fillAmerican ? r2(1 - nominalProbFromEff(impliedProb(fillAmerican))) : null);
const toNum = (v) => (v == null ? null : (typeof v === 'string' ? parseFloat(v) : Number(v)));

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
        .select('parlay_id,label,rfq_id,quote_id,created_at,fill_american')
        .not('quote_id', 'is', null)
        .order('created_at', { ascending: false }).limit(200),
    ]);
    parlays = p || [];
    const bq = {}, br = {}, seed = [];
    (subs || []).forEach((s) => {
      if (!s.quote_id) return;
      const rec = { quote_id: s.quote_id, rfq_id: s.rfq_id, parlay_id: s.parlay_id, label: s.label, posted_at: s.created_at };
      bq[s.quote_id] = rec; if (s.rfq_id) br[s.rfq_id] = rec;
      // record OUR quoted price (no_bid) + fill odds so we can learn win/loss-by-price over time
      seed.push({ quote_id: s.quote_id, rfq_id: s.rfq_id, parlay_id: s.parlay_id, label: s.label,
        posted_at: s.created_at, fill_american: s.fill_american, no_bid: noBidFor(s.fill_american) });
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
  // Every quote_* event on the communications channel is PRIVATE to the maker (us),
  // so any quote event we receive is our own quote — record it whether or not the
  // runner logged a combo_submissions row. This captures the ACTUAL submitted price
  // (yes_bid/no_bid straight off the event) and the real fate (accepted/executed/lost).
  if (type.indexOf('quote_') === 0) {
    const m = env.msg || {};
    const q = (m.quote && typeof m.quote === 'object') ? m.quote : m;   // some events nest under .quote
    const qid = m.id || m.quote_id || q.id || null;
    const rid = m.rfq_id || q.rfq_id || null;
    if (!qid && !rid) return;
    counts.quoteEvents++;
    // The moment we post, grab the quote from the REST list while it's still OPEN — that's the
    // only reliable way to read the ACTUAL no_bid_dollars we put on the wire (the WS event omits it).
    if (type === 'quote_created') reconcileSelfQuotes().catch(() => {});
    const nowIso = new Date().toISOString();
    const numify = (v) => (v == null ? null : (typeof v === 'string' ? parseFloat(v) : Number(v)));
    const subNo = numify(m.no_bid != null ? m.no_bid : q.no_bid);
    const subYes = numify(m.yes_bid != null ? m.yes_bid : q.yes_bid);

    const patch = { updated_at: nowIso, raw: env };
    if (subNo != null) patch.submitted_no_bid = subNo;
    if (subYes != null) patch.submitted_yes_bid = subYes;
    if (type === 'quote_accepted') { patch.outcome = 'accepted'; patch.accepted_at = nowIso; counts.accepted++; }
    else if (type === 'quote_executed') {
      patch.outcome = 'executed'; patch.executed_at = nowIso; counts.executed++;
      patch.order_id = m.order_id || m.creator_order_id || m.maker_order_id || q.order_id || null;
    }

    const rec = (qid && postedByQuote[qid]) || (rid && postedByRfq[rid]) || null;
    if (rec) {
      // seeded from combo_submissions — update that row (keeps intended price + parlay label)
      try { await supabase.from('quote_outcomes').update(patch).eq('quote_id', rec.quote_id); }
      catch (e) { console.error('[WATCH] outcome update', e.message); }
      return;
    }
    // UN-SEEDED — the runner posted this quote but never logged it. Record it anyway.
    if (!qid) return;
    try {
      await supabase.from('quote_outcomes').upsert({
        quote_id: qid, rfq_id: rid, label: '(live quote — no submission log)',
        outcome: 'posted', submitted_no_bid: subNo, submitted_yes_bid: subYes, raw: env,
        posted_at: parseTs(m.created_ts) ? new Date(parseTs(m.created_ts)).toISOString() : nowIso,
      }, { onConflict: 'quote_id', ignoreDuplicates: true });     // create-only; don't clobber a later state
      if (type === 'quote_accepted' || type === 'quote_executed' || subNo != null) {
        await supabase.from('quote_outcomes').update(patch).eq('quote_id', qid);
      }
    } catch (e) { console.error('[WATCH] outcome upsert', e.message); }
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

async function fetchRfq(rfqId) {
  const signPath = `/trade-api/v2/communications/rfqs/${rfqId}`;
  const headers = authHeaders({ keyId: KEY_ID, pem: PEM, method: 'GET', signPath });
  const res = await fetch(`${REST}/communications/rfqs/${rfqId}`, { headers });
  if (!res.ok) throw new Error(`rfq ${res.status}`);
  const j = await res.json();
  return j.rfq || j;
}

// Kalshi timestamps: date-time strings, or unix (sec or ms). Parse to epoch ms defensively.
function parseTs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;   // seconds vs ms
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// For each resolved quote, pull the RFQ's timeline and compute:
//   responded_ms  = our post time − RFQ created  (how fast WE answered)
//   rfq_lifetime_ms = RFQ closed − RFQ created   (how long the window was open)
//   in_time       = did we answer before it closed?
// Then classify a LOSS: cancelled → no_taker; closed & in-time → outbid (beaten on price);
// closed & NOT in-time → too_slow (we missed the window). Kalshi never reveals the winner's price.
async function reconcileRfq() {
  try {
    const { data: rows } = await supabase.from('quote_outcomes')
      .select('quote_id,rfq_id,posted_at,outcome')
      .not('rfq_id', 'is', null).is('rfq_lifetime_ms', null).limit(20);
    if (!rows || !rows.length) return;
    for (const o of rows) {
      let rfq; try { rfq = await fetchRfq(o.rfq_id); } catch (_) { continue; }
      if (!rfq || !rfq.status) continue;
      if (rfq.status === 'open') continue;               // not resolved — recheck next cycle
      const created = parseTs(rfq.created_ts);
      const closed = parseTs(rfq.updated_ts) || parseTs(rfq.cancelled_ts) || null;
      const post = parseTs(o.posted_at);
      const cancelled = !!(rfq.cancelled_ts || rfq.cancellation_reason);
      const respMs = (created != null && post != null) ? Math.max(0, post - created) : null;
      const lifeMs = (created != null && closed != null) ? Math.max(0, closed - created) : null;
      const inTime = (respMs != null && lifeMs != null) ? respMs <= lifeMs : null;
      let reason;
      if (o.outcome === 'lost') reason = cancelled ? 'no_taker' : (inTime === false ? 'too_slow' : 'outbid');
      const patch = {
        rfq_status: rfq.status,
        cancellation_reason: rfq.cancellation_reason || null,
        rfq_created_ts: created != null ? new Date(created).toISOString() : null,
        rfq_closed_ts: closed != null ? new Date(closed).toISOString() : null,
        rfq_lifetime_ms: lifeMs,
        responded_ms: respMs,
        in_time: inTime,
        updated_at: new Date().toISOString(),
      };
      if (reason) patch.loss_reason = reason;
      await supabase.from('quote_outcomes').update(patch).eq('quote_id', o.quote_id);
    }
  } catch (e) { console.error('[WATCH] reconcileRfq', e.message); }
}

// Authoritative source of OUR submitted quote prices + status, straight from Kalshi.
// GET /communications/quotes?user_filter=self returns each of our quotes with the ACTUAL
// no_bid_dollars/yes_bid_dollars we put on the wire and its status (open/accepted/executed/cancelled).
// This is how we confirm the true price we offered, independent of the runner's (broken) logging.
async function fetchSelfQuotes() {
  const signPath = '/trade-api/v2/communications/quotes';       // signature excludes the query string
  const headers = authHeaders({ keyId: KEY_ID, pem: PEM, method: 'GET', signPath });
  const res = await fetch(`${REST}/communications/quotes?user_filter=self&limit=100`, { headers });
  const text = await res.text();
  const dbg = { id: 'self_quotes', ts: new Date().toISOString(), status: res.status, snippet: text.slice(0, 400) };
  let quotes = [];
  if (res.ok) {
    try { const j = JSON.parse(text); quotes = j.quotes || j.data || []; dbg.keys = Object.keys(j).join(','); dbg.cnt = quotes.length; }
    catch (e) { dbg.error = 'parse: ' + e.message; }
  } else { dbg.error = 'http ' + res.status; }
  try { await supabase.from('watcher_debug').upsert(dbg, { onConflict: 'id' }); } catch (_) {}
  return quotes;
}

async function reconcileSelfQuotes() {
  try {
    const quotes = await fetchSelfQuotes();
    for (const qq of quotes) {
      const qid = qq.id || qq.quote_id; if (!qid) continue;
      const st = qq.status;
      let outcome = null;                                        // only set on a terminal Kalshi status
      if (st === 'executed' || st === 'confirmed') outcome = 'executed';
      else if (st === 'accepted') outcome = 'accepted';
      else if (st === 'cancelled') outcome = 'lost';
      const patch = {
        submitted_no_bid: toNum(qq.no_bid_dollars),
        submitted_yes_bid: toNum(qq.yes_bid_dollars),
        rfq_id: qq.rfq_id || null,
        updated_at: new Date().toISOString(),
      };
      if (outcome) patch.outcome = outcome;
      // update existing row (preserve its label/parlay); insert only if brand new
      const { data: upd } = await supabase.from('quote_outcomes').update(patch).eq('quote_id', qid).select('quote_id');
      if (!upd || !upd.length) {
        await supabase.from('quote_outcomes').insert({
          quote_id: qid, rfq_id: qq.rfq_id || null, label: '(self-quote — from Kalshi)',
          outcome: outcome || 'posted',
          submitted_no_bid: toNum(qq.no_bid_dollars), submitted_yes_bid: toNum(qq.yes_bid_dollars),
          posted_at: parseTs(qq.created_ts) ? new Date(parseTs(qq.created_ts)).toISOString() : new Date().toISOString(),
        });
      }
    }
  } catch (e) { console.error('[WATCH] reconcileSelfQuotes', e.message); }
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
  setInterval(reconcileRfq, 30000);
  setInterval(reconcileSelfQuotes, 30000);
  reconcileSelfQuotes();   // immediate — backfill the real prices of quotes already posted today
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
