// ─────────────────────────────────────────────────────────────────────────
// fills-reader.js — READ-ONLY real-fill reader.
//
// Polls Kalshi's GET /portfolio/fills (a signed READ of your account — it places,
// cancels, and modifies NOTHING) and records the ACTUAL executed fills into the
// combo_fills table. This is ground truth from Kalshi, as opposed to the quote-on-post
// rows the worker writes to combo_submissions.
//
// It also DMs you on a new real combo fill — this is the true "you actually got filled"
// alert, distinct from the worker's "quote posted" alert.
//
// Attribution note: Kalshi's fills carry no quote/RFQ id. CROSSCATEGORY shard
// tickers also miss mve_collection (KXMVESPORTSMULTIGAMEEXTENDED-R). We match:
//   1) combo_submissions.order_id  2) live-runner combo_fills twin
//   3) unique collection / no_bid  4) unique recent quote window (partial OK)
// Never guess when two parlays still fit. ignoreDuplicates used to freeze
// parlay_id=null; we UPDATE when a later poll can attribute. Attributed fills
// also stamp combo_submissions status=filled + order_id (History / lock card).
//
// Env (set on the host — SAME values as the worker; read-only use):
//   KALSHI_KEY_ID          public Key ID
//   Kalshi_combo_key       private key PEM (also accepts KALSHI_PRIVATE_KEY)
//   SUPABASE_URL           your project URL
//   SUPABASE_SERVICE_KEY   service-role key
//   TELEGRAM_BOT_TOKEN     (optional) real-fill DM
//   TELEGRAM_ALERT_CHAT_ID (optional) real-fill DM
//   FILLS_POLL_MS          (optional, default 20000)
//   FILLS_LOOKBACK_SEC     (optional, default 86400) how far back to read on boot
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { normalizePem, authHeaders } = require('./kalshi-auth');
const {
  attributeComboFill,
  sumAttributedFillCounts,
  formatRealFillAlert,
  existingFillNeedsParlay,
  submissionFilledPatch,
  canStampSubmission,
  QUOTE_WINDOW_BEFORE_MS,
} = require('./fills-attr');

const MODE = 'FILLS';
const KEY_ID = process.env.KALSHI_KEY_ID;
const PEM = normalizePem(process.env.Kalshi_combo_key || process.env.KALSHI_PRIVATE_KEY || '');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_ALERT_CHAT_ID;
const POLL_MS = parseInt(process.env.FILLS_POLL_MS || '20000', 10);
const LOOKBACK = parseInt(process.env.FILLS_LOOKBACK_SEC || '86400', 10);
const REST = 'https://external-api.kalshi.com';

async function sendAlert(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log(`[${MODE}] (telegram not configured) ${text.replace(/\n/g, ' | ')}`); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text }),
    });
    if (!r.ok) console.error(`[${MODE}] telegram failed`, r.status, await r.text());
  } catch (e) { console.error(`[${MODE}] telegram error`, e.message); }
}

const isComboTicker = (t) => !!t && /MVE/i.test(t);
let activeParlays = [];

async function loadParlays() {
  const { data } = await supabase
    .from('combo_parlays')
    .select('id,label,mve_collection,active,max_contracts,fill_american')
    .is('archived_at', null);
  activeParlays = data || [];
}

// Ground-truth filled contracts for a parlay (includes the row just upserted).
// Dedupes live-runner order_id twins against the Kalshi fill_id row.
async function filledSumForParlay(parlayId) {
  const { data, error } = await supabase
    .from('combo_fills')
    .select('count,fill_id,order_id,raw')
    .eq('parlay_id', parlayId);
  if (error) {
    console.error(`[${MODE}] fill sum failed`, error.message);
    return null;
  }
  return sumAttributedFillCounts(data || []);
}

async function loadRecentSubmissions() {
  const cutoff = new Date(Date.now() - QUOTE_WINDOW_BEFORE_MS - 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('combo_submissions')
    .select('id,parlay_id,quote_id,order_id,contracts,status,created_at,label')
    .or('quote_id.not.is.null,order_id.not.is.null')
    .gte('created_at', cutoff)
    .limit(500);
  if (error) {
    console.error(`[${MODE}] submissions load failed`, error.message);
    return [];
  }
  return data || [];
}

async function loadFillsByOrderId(orderId) {
  if (!orderId) return [];
  const { data, error } = await supabase
    .from('combo_fills')
    .select('fill_id,order_id,parlay_id,count,raw')
    .eq('order_id', orderId);
  if (error) {
    console.error(`[${MODE}] fills-by-order failed`, error.message);
    return [];
  }
  return data || [];
}

async function findExistingFill(fillId) {
  const { data, error } = await supabase
    .from('combo_fills')
    .select('id,parlay_id')
    .eq('fill_id', fillId)
    .maybeSingle();
  if (error) {
    console.error(`[${MODE}] fill lookup failed`, error.message);
    return null;
  }
  return data || null;
}

async function stampSubmissionFilled(attr, fill) {
  if (!attr || !fill) return;
  const sub = attr.submission;
  if (!canStampSubmission(sub, fill)) return;
  const { error } = await supabase
    .from('combo_submissions')
    .update(submissionFilledPatch(fill))
    .eq('id', sub.id);
  if (error) console.error(`[${MODE}] stamp submission failed`, error.message);
}

// Signed READ of the fills endpoint. No query string is signed (Kalshi signs ts+METHOD+path only).
async function fetchFills(minTs) {
  const signPath = '/trade-api/v2/portfolio/fills';
  const url = `${REST}${signPath}?limit=200&min_ts=${minTs}`;
  const headers = authHeaders({ keyId: KEY_ID, pem: PEM, method: 'GET', signPath });
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`fills read ${res.status}: ${text}`);
  const body = JSON.parse(text);
  return body.fills || [];
}

function normalizeFill(f) {
  const fillId = f.fill_id || f.trade_id;
  const ticker = f.ticker || f.market_ticker || null;
  const count = Number(f.count != null ? f.count : (f.count_fp != null ? f.count_fp : 0));
  const created = f.created_time || (f.ts ? new Date(f.ts * 1000).toISOString() : null);
  const yesP = f.yes_price_dollars ?? f.yes_price_fixed ?? (f.yes_price != null ? f.yes_price / 100 : null);
  const noP = f.no_price_dollars ?? f.no_price_fixed ?? (f.no_price != null ? f.no_price / 100 : null);
  return {
    fill_id: fillId,
    order_id: f.order_id || null,
    ticker,
    is_combo: isComboTicker(ticker),
    outcome_side: f.outcome_side || f.side || null,
    action: f.action || null,
    count,
    is_taker: !!f.is_taker,
    yes_price: yesP != null ? Number(yesP) : null,
    no_price: noP != null ? Number(noP) : null,
    fee: f.fee_cost != null ? Number(f.fee_cost) : (f.fee != null ? Number(f.fee) : null),
    kalshi_created_time: created,
    raw: f,
  };
}

let lastTs = 0;

async function poll() {
  try {
    await loadParlays();
    const fills = await fetchFills(lastTs || Math.floor(Date.now() / 1000) - LOOKBACK);
    if (!fills.length) return;

    let maxTs = lastTs;
    let submissions = null;
    for (const raw of fills) {
      const row = normalizeFill(raw);
      if (!row.fill_id) continue;
      if (raw.ts && raw.ts > maxTs) maxTs = raw.ts;

      let attr = null;
      if (row.is_combo && !row.is_taker) {
        if (!submissions) submissions = await loadRecentSubmissions();
        const existingFills = await loadFillsByOrderId(row.order_id);
        attr = attributeComboFill(row.ticker, row, activeParlays, {
          submissions,
          existingFills,
        });
      }
      const parlay = attr && attr.parlay ? attr.parlay : null;
      row.parlay_id = parlay ? parlay.id : null;

      const existing = await findExistingFill(row.fill_id);
      if (!existing) {
        const { error } = await supabase.from('combo_fills').insert(row);
        if (error) { console.error(`[${MODE}] insert failed`, error.message); continue; }
        if (row.is_combo && !row.is_taker) {
          console.log(`[${MODE}] NEW REAL FILL ${row.ticker} count=${row.count} ${parlay ? '→ ' + parlay.label : '(unattributed)'}`);
          const filled = parlay ? await filledSumForParlay(parlay.id) : null;
          await sendAlert(formatRealFillAlert({ parlay, row, filled }));
        }
      } else if (existingFillNeedsParlay(existing, row.parlay_id)) {
        // First write often lands unattributed (shard ticker + nearby no_bids).
        // ignoreDuplicates used to freeze parlay_id=null forever.
        const { error } = await supabase
          .from('combo_fills')
          .update({
            parlay_id: row.parlay_id,
            ticker: row.ticker,
            count: row.count,
            order_id: row.order_id,
            no_price: row.no_price,
            yes_price: row.yes_price,
          })
          .eq('fill_id', row.fill_id);
        if (error) console.error(`[${MODE}] reattribute failed`, error.message);
        else {
          console.log(`[${MODE}] REATTRIBUTED ${row.ticker} count=${row.count} → ${parlay.label || parlay.id}`);
        }
      }

      if (row.is_combo && !row.is_taker && parlay) {
        await stampSubmissionFilled(attr, row);
      }
    }
    if (maxTs > lastTs) lastTs = maxTs;
  } catch (e) {
    console.error(`[${MODE}] poll error`, e.message);
  }
}

async function main() {
  if (!KEY_ID || !PEM || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error(`[${MODE}] missing env: need KALSHI_KEY_ID, Kalshi_combo_key, SUPABASE_URL, SUPABASE_SERVICE_KEY`);
    process.exit(1);
  }
  console.log(`[${MODE}] starting — read-only poll of /portfolio/fills every ${POLL_MS}ms. Places NOTHING.`);
  await poll();
  setInterval(poll, POLL_MS);
  process.on('SIGINT', () => { console.log(`[${MODE}] stopping`); process.exit(0); });
}
main();
