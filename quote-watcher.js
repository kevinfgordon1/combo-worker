// ─────────────────────────────────────────────────────────────────────────
// quote-watcher.js — READ-ONLY observability. Answers two questions:
//   1. How many RFQs matched each parlay?          → combo_matches
//   2. What happened to each quote we posted?       → quote_outcomes
//      (accepted / executed / lost, response latency, and real-fill reconcile)
//
// After a loss, it also reads Kalshi's PUBLIC trade tape for that combo ticker
// (GET /markets/trades — including non-block RFQ prints) and, on a unique
// size≈contracts / time-near-close match, saves the clearing price and Telegrams once.
//
// Memory-safe: it INSERTs only on a MATCH (rare — your exact combos) or on one of
// YOUR OWN quote events (also rare — quote_* events are private to you). It never
// stores the firehose. This is nothing like the debug capture that OOM'd.
//
// Env: KALSHI_KEY_ID, Kalshi_combo_key (or KALSHI_PRIVATE_KEY),
//      SUPABASE_URL, SUPABASE_SERVICE_KEY,
//      TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID (optional; lost-quote DMs).
//      Run as its own process:  node quote-watcher.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { createKalshiWs } = require('./kalshi-ws');
const { normalizePem, authHeaders } = require('./kalshi-auth');
const { matchParlay, normalizeRfq } = require('./rfq');
const { toNum: tapeNum, normalizeTrade, matchTapeTrades, formatLostAlert } = require('./tape');

const KEY_ID = process.env.KALSHI_KEY_ID;
const PEM = normalizePem(process.env.Kalshi_combo_key || process.env.KALSHI_PRIVATE_KEY || '');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const REST = process.env.KALSHI_REST_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
const LOST_AFTER_MS = 30000;         // no acceptance within this window → mark 'lost' (classify later)
const TAPE_PAD_MS = 45000;           // RFQ close → public print delay
const TAPE_LOOKBACK_MS = 24 * 3600 * 1000;
const ALERT_LOOKBACK_MS = 2 * 3600 * 1000;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_ALERT_CHAT_ID;

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

const counts = { rfqs: 0, matched: 0, quoteEvents: 0, accepted: 0, executed: 0, lost: 0, reconciled: 0, tapeMatched: 0, tapeAmbiguous: 0, tapeAlerts: 0 };
const unknownCols = new Set();
const tapeAttempted = new Set();
const tapeAlerted = new Set();

async function sendAlert(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log(`[WATCH] ALERT (telegram not configured): ${text.replace(/\n/g, ' | ')}`);
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text }),
    });
    if (!r.ok) console.error('[WATCH] telegram send failed', r.status, await r.text());
  } catch (e) {
    console.error('[WATCH] telegram error', e.message);
  }
}

const COL_ERR = /Could not find the '([^']+)' column/i;
async function updateQuoteOutcome(quoteId, patch) {
  const body = { ...patch };
  for (const c of unknownCols) delete body[c];
  if (!Object.keys(body).length) return { error: null };
  const { error } = await supabase.from('quote_outcomes').update(body).eq('quote_id', quoteId);
  if (!error) return { error: null };
  const m = String(error.message || '').match(COL_ERR);
  if (m) {
    unknownCols.add(m[1]);
    console.warn(`[WATCH] quote_outcomes missing column ${m[1]} — degrading`);
    return updateQuoteOutcome(quoteId, patch);
  }
  return { error };
}

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

// Age un-accepted quotes to 'lost' (later classified no_purchase / outbid / too_slow / no_taker).
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
// Then classify a LOSS: cancelled → no_taker; closed & NOT in-time → too_slow;
// closed & in-time → no_purchase for now. reconcileTape upgrades to outbid only when
// the public tape shows someone else filled (clearing price).
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
      // Outbid is proven later by tape match — don't assume a silent close means we lost on price.
      if (o.outcome === 'lost') reason = cancelled ? 'no_taker' : (inTime === false ? 'too_slow' : 'no_purchase');
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
      const ticker = rfq.market_ticker || rfq.ticker || null;
      if (ticker) {
        const { error } = await updateQuoteOutcome(o.quote_id, { market_ticker: ticker });
        if (error) console.warn('[WATCH] market_ticker persist', error.message);
      }
    }
  } catch (e) { console.error('[WATCH] reconcileRfq', e.message); }
}

async function fetchTrades(ticker, minTs, maxTs) {
  const signPath = '/trade-api/v2/markets/trades';
  const get = async (extra) => {
    const qs = new URLSearchParams({
      ticker: String(ticker),
      min_ts: String(minTs),
      max_ts: String(maxTs),
      limit: '100',
      ...extra,
    });
    const headers = authHeaders({ keyId: KEY_ID, pem: PEM, method: 'GET', signPath });
    const res = await fetch(`${REST}/markets/trades?${qs}`, { headers });
    if (!res.ok) throw new Error(`trades ${res.status}: ${await res.text()}`);
    const j = await res.json();
    return j.trades || [];
  };
  // Combo RFQ fills often print with is_block_trade=false (seen on $1/$2 Chicago).
  // Fetch the full public tape; matchTapeTrades prefers block prints when present,
  // otherwise falls back to ordinary size/time matches.
  return await get({});
}

function tapeDone(row) {
  if (!row) return true;
  if (tapeAttempted.has(row.quote_id)) return true;
  if (row.tape_match) return true;
  if (row.tape_alerted_at) return true;
  const t = row.raw && row.raw.tape;
  return !!(t && (t.match || t.alerted_at));
}

function isRecentLoss(o, closedMs) {
  const t = parseTs(o.posted_at) || parseTs(o.rfq_closed_ts) || closedMs;
  return t != null && (Date.now() - t) <= ALERT_LOOKBACK_MS;
}

async function persistTape(row, tape, extra = {}) {
  const patch = {
    updated_at: new Date().toISOString(),
    tape_match: tape.match,
    tape_yes_price: tape.yesPrice != null ? tape.yesPrice : null,
    tape_no_price: tape.noPrice != null ? tape.noPrice : null,
    tape_count: tape.count != null ? tape.count : null,
    tape_trade_ts: tape.tradeTs != null ? new Date(tape.tradeTs).toISOString() : null,
    ...extra,
  };
  const { error } = await updateQuoteOutcome(row.quote_id, patch);
  if (error) console.error('[WATCH] persistTape', error.message);

  const tapeCols = ['tape_match', 'tape_yes_price', 'tape_no_price', 'tape_count', 'tape_trade_ts', 'tape_alerted_at'];
  if (!tapeCols.some((c) => unknownCols.has(c))) return;
  const raw = (row.raw && typeof row.raw === 'object' && !Array.isArray(row.raw)) ? { ...row.raw } : { prev: row.raw };
  raw.tape = {
    match: tape.match,
    yes_price: tape.yesPrice != null ? tape.yesPrice : null,
    no_price: tape.noPrice != null ? tape.noPrice : null,
    count: tape.count != null ? tape.count : null,
    trade_ts: tape.tradeTs != null ? new Date(tape.tradeTs).toISOString() : null,
    alerted_at: extra.tape_alerted_at || null,
  };
  const { error: rawErr } = await supabase.from('quote_outcomes')
    .update({ raw, updated_at: new Date().toISOString() })
    .eq('quote_id', row.quote_id);
  if (rawErr) console.error('[WATCH] persistTape raw', rawErr.message);
}

async function selectLostForTape() {
  const base = 'quote_id,rfq_id,label,posted_at,loss_reason,rfq_created_ts,rfq_closed_ts,submitted_no_bid,no_bid,raw';
  const attempts = [
    { sel: `${base},market_ticker,tape_match,tape_alerted_at`, filterTape: true },
    { sel: `${base},tape_match,tape_alerted_at`, filterTape: true },
    { sel: base, filterTape: false },
  ];
  const cutoff = new Date(Date.now() - TAPE_LOOKBACK_MS).toISOString();
  for (const a of attempts) {
    let q = supabase.from('quote_outcomes').select(a.sel)
      .eq('outcome', 'lost')
      .not('loss_reason', 'is', null)
      .gte('posted_at', cutoff)
      .limit(30);
    if (a.filterTape) q = q.is('tape_match', null);
    const { data, error } = await q;
    if (error) {
      console.warn('[WATCH] selectLostForTape', error.message);
      continue;
    }
    return (data || []).filter((r) => !tapeDone(r)).slice(0, 20);
  }
  return [];
}

// Public tape: after we lose, RFQ fills print as is_block_trade=true on the combo
// ticker. Prefer those (plus size≈RFQ contracts and time near close). Never guess.
async function reconcileTape() {
  try {
    const rows = await selectLostForTape();
    if (!rows.length) return;
    for (const o of rows) {
      if (tapeDone(o)) continue;
      let rfq;
      try { rfq = await fetchRfq(o.rfq_id); } catch (e) {
        console.error('[WATCH] tape fetchRfq', o.rfq_id, e.message);
        continue;
      }
      if (!rfq) continue;
      const ticker = o.market_ticker || (rfq && (rfq.market_ticker || rfq.ticker)) || null;
      if (ticker) {
        const { error } = await updateQuoteOutcome(o.quote_id, { market_ticker: ticker });
        if (error) console.warn('[WATCH] market_ticker persist', error.message);
      }
      const created = parseTs(rfq && rfq.created_ts) || parseTs(o.rfq_created_ts) || parseTs(o.posted_at);
      const closed = parseTs(rfq && rfq.updated_ts) || parseTs(rfq && rfq.cancelled_ts)
        || parseTs(o.rfq_closed_ts) || parseTs(o.posted_at);
      if (closed != null && Date.now() < closed + TAPE_PAD_MS) continue;

      let result = { match: 'none' };
      if (ticker) {
        const minTs = Math.max(0, Math.floor((created || closed || Date.now()) / 1000) - 1);
        const maxTs = Math.ceil(((closed || Date.now()) + TAPE_PAD_MS) / 1000);
        let trades;
        try { trades = await fetchTrades(ticker, minTs, maxTs); }
        catch (e) {
          console.error('[WATCH] fetchTrades', ticker, e.message);
          continue;
        }
        const windowStart = created || 0;
        const windowEnd = (closed || Date.now()) + TAPE_PAD_MS;
        const normalized = (trades || []).map((t) => normalizeTrade(t, parseTs))
          .filter((t) => t.ts == null || (t.ts >= windowStart - 1000 && t.ts <= windowEnd + 1000));
        let rfqCount = tapeNum(rfq && (rfq.contracts_fp != null ? rfq.contracts_fp : rfq.contracts));
        // Dollar RFQs often omit contracts — estimate from target cost + our NO bid.
        if (!(rfqCount > 0) && rfq) {
          const cost = tapeNum(rfq.target_cost_dollars != null ? rfq.target_cost_dollars : rfq.target_cost);
          const ourNo = tapeNum(o.submitted_no_bid != null ? o.submitted_no_bid : o.no_bid);
          if (cost > 0 && ourNo != null && ourNo < 1) {
            const yes = Math.max(0.01, 1 - ourNo);
            rfqCount = Math.floor(cost / yes);
          }
        }
        result = matchTapeTrades(normalized, { rfqCount, closedMs: closed });
      }

      tapeAttempted.add(o.quote_id);

      // Tape is ground truth for price competition.
      // matched → outbid; no/ambiguous print on a non-cancelled RFQ → no_purchase.
      let lossReason = o.loss_reason || null;
      if (result.match === 'matched') lossReason = 'outbid';
      else if (lossReason === 'outbid' || lossReason === 'no_purchase' || !lossReason) {
        if (result.match === 'none' || result.match === 'ambiguous') lossReason = 'no_purchase';
      }
      if (lossReason && lossReason !== o.loss_reason) {
        const { error: lrErr } = await updateQuoteOutcome(o.quote_id, { loss_reason: lossReason });
        if (lrErr) console.warn('[WATCH] loss_reason update', lrErr.message);
        else o.loss_reason = lossReason;
      }

      const alreadyAlerted = tapeAlerted.has(o.quote_id) || o.tape_alerted_at
        || (o.raw && o.raw.tape && o.raw.tape.alerted_at);
      let alertedAt = null;
      if (!alreadyAlerted) {
        // Telegram only for proven outbids (clearing price on tape).
        const shouldAlert = isRecentLoss(o, closed) && result && result.match === 'matched';
        if (shouldAlert) {
          const ourNo = tapeNum(o.submitted_no_bid != null ? o.submitted_no_bid : o.no_bid);
          await sendAlert(formatLostAlert({
            label: o.label, rfqId: o.rfq_id, lossReason: 'outbid', tape: result, ourNo,
          }));
          tapeAlerted.add(o.quote_id);
          counts.tapeAlerts++;
          alertedAt = new Date().toISOString();
        }
      }
      await persistTape(o, result, alertedAt ? { tape_alerted_at: alertedAt } : {});
      if (result.match === 'matched') counts.tapeMatched++;
      else if (result.match === 'ambiguous') counts.tapeAmbiguous++;
      console.log(`[WATCH] tape ${result.match} quote=${o.quote_id} rfq=${o.rfq_id} ticker=${ticker || '(none)'} reason=${lossReason || o.loss_reason}`);
    }
  } catch (e) { console.error('[WATCH] reconcileTape', e.message); }
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
  const dbg = { id: 'self_quotes', ts: new Date().toISOString(), status: res.status, snippet: text.slice(0, 1800) };
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

// One-shot eligibility probe: what account/balance is the worker's API key actually on?
// A maker quote can be accepted (200/open) yet never fill if the account lacks collateral,
// so we read balance + the exchange/account view to see what this key can actually back.
async function probeAccount() {
  const get = async (id, path) => {
    try {
      const headers = authHeaders({ keyId: KEY_ID, pem: PEM, method: 'GET', signPath: '/trade-api/v2' + path });
      const res = await fetch(`${REST}${path}`, { headers });
      const text = await res.text();
      await supabase.from('watcher_debug').upsert({ id, ts: new Date().toISOString(), status: res.status, snippet: text.slice(0, 800) }, { onConflict: 'id' });
    } catch (e) {
      await supabase.from('watcher_debug').upsert({ id, ts: new Date().toISOString(), error: String(e && e.message || e) }, { onConflict: 'id' }).catch(() => {});
    }
  };
  await get('balance', '/portfolio/balance');
  await get('positions', '/portfolio/positions');
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
  const rfqThenTape = () => reconcileRfq().then(() => reconcileTape()).catch((e) => console.error('[WATCH] rfq/tape', e.message));
  setInterval(rfqThenTape, 30000);
  setInterval(reconcileSelfQuotes, 30000);
  reconcileSelfQuotes();   // immediate — backfill the real prices of quotes already posted today
  rfqThenTape();           // classify losses, then tape-match recent ones
  probeAccount();          // one-shot: read the worker key's balance + positions (eligibility check)
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
