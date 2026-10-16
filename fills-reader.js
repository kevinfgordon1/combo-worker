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
  sumConfirmedFillCounts,
  formatRealFillAlert,
  existingFillNeedsParlay,
  submissionFilledPatch,
  canStampSubmission,
  isKalshiTradeFill,
  selectLiveRunnerStubsToDrop,
  QUOTE_WINDOW_BEFORE_MS,
} = require('./fills-attr');
const { normalizeKalshiFill } = require('./kalshi-fill-confirm');

const MODE = 'FILLS';
const { createLiveUserGate } = require('./live-users');
// Fills on Kevin's exchange account only attribute to allowlisted users' locks.
const { resolveWorkerScope } = require('./worker-scope');
// Whose Kalshi account this reader polls (Kevin's main worker, or one tester).
const SCOPE = resolveWorkerScope(process.env);
const liveUsers = createLiveUserGate({ env: process.env, scope: SCOPE, log: (m) => console.log(`[${MODE}] ${m}`) });
const KEY_ID = process.env.KALSHI_KEY_ID;
const PEM = normalizePem(process.env.Kalshi_combo_key || process.env.KALSHI_PRIVATE_KEY || '');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { createTelegramGate } = require('./tg-gate');
const POLL_MS = parseInt(process.env.FILLS_POLL_MS || '20000', 10);
const LOOKBACK = parseInt(process.env.FILLS_LOOKBACK_SEC || '86400', 10);
const REST = 'https://external-api.kalshi.com';

const tgGate = createTelegramGate({ env: process.env, tag: MODE });
async function sendAlert(text) {
  try { await tgGate.send(text); } catch (e) { console.error(`[${MODE}] telegram error`, e && e.message); }
}

let activeParlays = [];

async function loadParlays() {
  const { data } = await supabase
    .from('combo_parlays')
    .select('id,user_id,label,mve_collection,active,max_contracts,fill_american')
    .is('archived_at', null);
  activeParlays = liveUsers.filterByScope(data || []);
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
  return sumConfirmedFillCounts(data || []);
}

async function loadRecentSubmissions() {
  const cutoff = new Date(Date.now() - QUOTE_WINDOW_BEFORE_MS - 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('combo_submissions')
    .select('id,parlay_id,quote_id,order_id,contracts,status,created_at,label')
    .in('user_id', SCOPE.userIds)
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

// Real trade arrived: delete the live-runner order stub (fill_id === order_id)
// so Combo Locks History / SQL / exports do not keep both.
async function deleteLiveRunnerTwins(orderId) {
  if (!orderId) return 0;
  const twins = await loadFillsByOrderId(orderId);
  const drop = selectLiveRunnerStubsToDrop(twins);
  let n = 0;
  for (const row of drop) {
    if (!row.fill_id) continue;
    const { error } = await supabase
      .from('combo_fills')
      .delete()
      .eq('fill_id', row.fill_id);
    if (error) {
      console.error(`[${MODE}] stub delete failed`, row.fill_id, error.message);
      continue;
    }
    n += 1;
    console.log(`[${MODE}] dropped live-runner stub fill_id=${row.fill_id} order_id=${orderId}`);
  }
  return n;
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
  return normalizeKalshiFill(f);
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
        // A tester's account fills belong to that tester even when unattributed.
        const { error } = await supabase.from('combo_fills').insert(SCOPE.writeUserId ? { ...row, user_id: SCOPE.writeUserId } : row);
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

      if (row.is_combo && !row.is_taker && isKalshiTradeFill(row) && row.order_id) {
        await deleteLiveRunnerTwins(row.order_id);
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
  if (SCOPE.invalid) {
    console.error(`[${MODE}] COMBO_WORKER_USER_ID is not a uuid — refusing to start`);
    process.exit(1);
  }
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
