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
// Attribution note: Kalshi's fills carry no quote/RFQ id, so a fill can't be tied to a
// specific quote by id. We flag combo (MVE) maker fills and, when exactly one parlay is
// active, attribute to it; otherwise parlay_id is left null (still recorded). This is
// best-effort and clearly surfaced in the tab.
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
const { shortId } = require('./short-id');

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
  const { data } = await supabase.from('combo_parlays').select('id,label,mve_collection,active').is('archived_at', null);
  activeParlays = data || [];
}

// Best-effort: match a combo ticker to a parlay by its collection prefix; else, if exactly
// one parlay is active, attribute to it; else leave unattributed.
function attributeParlay(ticker) {
  const byCollection = activeParlays.find((p) => p.mve_collection && ticker && ticker.includes(p.mve_collection));
  if (byCollection) return byCollection;
  if (activeParlays.length === 1) return activeParlays[0];
  return null;
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
    for (const raw of fills) {
      const row = normalizeFill(raw);
      if (!row.fill_id) continue;
      if (raw.ts && raw.ts > maxTs) maxTs = raw.ts;

      const parlay = row.is_combo && !row.is_taker ? attributeParlay(row.ticker) : null;
      row.parlay_id = parlay ? parlay.id : null;

      // Upsert — ignore if we've already recorded this fill_id (dedupe across overlapping polls).
      const { data: inserted, error } = await supabase
        .from('combo_fills')
        .upsert(row, { onConflict: 'fill_id', ignoreDuplicates: true })
        .select('id');
      if (error) { console.error(`[${MODE}] upsert failed`, error.message); continue; }

      // inserted is non-empty only when this was a genuinely NEW fill row.
      if (inserted && inserted.length && row.is_combo && !row.is_taker) {
        console.log(`[${MODE}] NEW REAL FILL ${row.ticker} count=${row.count} ${parlay ? '→ ' + parlay.label : '(unattributed)'}`);
        await sendAlert(
          `💰 REAL FILL (from Kalshi account) — ${parlay ? parlay.label : row.ticker}\n` +
          `${row.action || ''} ${row.count} contracts · ${row.outcome_side || ''} @ $${row.no_price ?? row.yes_price ?? '?'}\n` +
          `${parlay ? 'parlay ' + parlay.label : 'unattributed combo fill'} · fill ${shortId(row.fill_id)}`
        );
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
