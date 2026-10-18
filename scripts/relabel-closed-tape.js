#!/usr/bin/env node
// Re-label closed Combo Lock requests with the batched one-trade-per-request matching.
//
// DRY RUN by default: prints how many labels would change. Writes only with --apply.
// Public Kalshi trades only (no Kalshi key needed). Places nothing.
//
//   node scripts/relabel-closed-tape.js --days 7                 # dry run from Supabase
//   node scripts/relabel-closed-tape.js --input rows.json        # dry run from an export
//   node scripts/relabel-closed-tape.js --days 7 --apply         # write the changes
//
// Rows: Kalshi combo_submissions we quoted on (quote_id set) whose request closed while
// our quote was live: skip_reason in (outbid, no_print, rfq_closed_live). Rows without a
// stored close time use the legacy window (close within 21s of our quote). Rows with no
// ticker borrow their lock's ticker when the lock only ever used one.
'use strict';
const fs = require('fs');
const path = require('path');
const tb = require('../tape-batch');

const PUBLIC_API = process.env.KALSHI_PUBLIC_API || 'https://api.elections.kalshi.com/trade-api/v2';
const LABELS = ['outbid', 'no_print', 'rfq_closed_live'];

function args(argv) {
  const out = { days: 7, apply: false, input: null, cache: null, limitTickers: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--input') out.input = argv[++i];
    else if (a === '--cache') out.cache = argv[++i];
    else if (a === '--limit-tickers') out.limitTickers = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

function inferTickers(rows) {
  const byParlay = new Map();
  for (const r of rows) {
    if (!r.market_ticker || !r.parlay_id) continue;
    if (!byParlay.has(r.parlay_id)) byParlay.set(r.parlay_id, new Set());
    byParlay.get(r.parlay_id).add(r.market_ticker);
  }
  let inferred = 0;
  let unknown = 0;
  for (const r of rows) {
    if (r.market_ticker) continue;
    const s = byParlay.get(r.parlay_id);
    if (s && s.size === 1) { r.market_ticker = [...s][0]; inferred++; } else unknown++;
  }
  return { inferred, unknown };
}

async function fetchPublicTrades(ticker, minTs, maxTs, { cacheDir, fetchImpl = fetch } = {}) {
  const key = cacheDir ? path.join(cacheDir, `${ticker}_${minTs}_${maxTs}.json`) : null;
  if (key && fs.existsSync(key)) return JSON.parse(fs.readFileSync(key, 'utf8'));
  const all = [];
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ ticker, min_ts: String(minTs), max_ts: String(maxTs), limit: '1000' });
    if (cursor) qs.set('cursor', cursor);
    let res;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        res = await fetchImpl(`${PUBLIC_API}/markets/trades?${qs}`);
        if (res.status !== 429 && res.status < 500) break;
      } catch (e) {
        res = null; // network blip: retry
        if (attempt === 5) throw e;
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    if (!res || !res.ok) throw new Error(`trades ${ticker} HTTP ${res && res.status}`);
    const j = await res.json();
    for (const t of j.trades || []) all.push(t);
    cursor = j.cursor || '';
    if (!cursor) break;
  }
  if (key) fs.writeFileSync(key, JSON.stringify(all));
  return all;
}

// Rows on one ticker can span days; split into clusters so each fetch stays small.
function clusters(rows, gapMs = 30 * 60 * 1000) {
  const sorted = [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const out = [];
  let cur = [];
  let last = -Infinity;
  for (const r of sorted) {
    const t = Date.parse(r.created_at);
    if (cur.length && t - last > gapMs) { out.push(cur); cur = []; }
    cur.push(r);
    last = t;
  }
  if (cur.length) out.push(cur);
  return out;
}

function labelOf(r) {
  return r.skip_reason;
}

function samePrice(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 1e-6;
}

// Pure: rows + trades for one ticker → per-row decisions with old/new labels.
function relabelTicker(rows, trades, ticker) {
  const assigned = tb.assignTrades(rows, trades);
  return rows.map((r) => {
    const patch = tb.patchFor(r, assigned.get(r.id) || null, ticker);
    const oldLabel = labelOf(r);
    const changed = oldLabel !== patch.skip_reason
      || (patch.skip_reason === 'outbid' && !samePrice(r.tape_yes_price, patch.tape_yes_price));
    return { id: r.id, oldLabel, oldYes: r.tape_yes_price != null ? Number(r.tape_yes_price) : null, patch, changed };
  });
}

function summarize(decisions) {
  const s = { rows: decisions.length, changed: 0, transitions: {}, outbidPriceChanged: 0, outbidWithPriceBefore: 0, outbidWithPriceAfter: 0 };
  for (const d of decisions) {
    if (d.oldLabel === 'outbid' && d.oldYes != null) s.outbidWithPriceBefore++;
    if (d.patch.skip_reason === 'outbid') s.outbidWithPriceAfter++;
    if (!d.changed) continue;
    s.changed++;
    const k = `${d.oldLabel}${d.oldLabel === 'outbid' ? (d.oldYes != null ? '(price)' : '(no price)') : ''} → ${d.patch.skip_reason}`;
    if (d.oldLabel === 'outbid' && d.patch.skip_reason === 'outbid') s.outbidPriceChanged++;
    s.transitions[k] = (s.transitions[k] || 0) + 1;
  }
  return s;
}

async function loadRows(opt) {
  if (opt.input) return JSON.parse(fs.readFileSync(opt.input, 'utf8'));
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const since = new Date(Date.now() - opt.days * 86400000).toISOString();
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('combo_submissions')
      .select('id,parlay_id,rfq_id,market_ticker,created_at,skip_reason,tape_match,tape_yes_price,venue,quote_id')
      .in('skip_reason', LABELS).not('quote_id', 'is', null).gte('created_at', since)
      .order('created_at', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows.filter((r) => (r.venue || 'kalshi') === 'kalshi');
}

async function applyPatches(decisions) {
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  let n = 0;
  for (const d of decisions) {
    if (!d.changed) continue;
    const body = { ...d.patch };
    let { error } = await sb.from('combo_submissions').update(body).eq('id', d.id);
    if (error && /tape_trade_id/.test(error.message)) {
      delete body.tape_trade_id;
      ({ error } = await sb.from('combo_submissions').update(body).eq('id', d.id));
    }
    if (error) console.error('update', d.id, error.message); else n++;
  }
  return n;
}

async function main() {
  const opt = args(process.argv);
  if (opt.cache) fs.mkdirSync(opt.cache, { recursive: true });
  const rows = await loadRows(opt);
  const inf = inferTickers(rows);
  const byTicker = tb.groupByTicker(rows);
  let tickers = [...byTicker.keys()];
  if (opt.limitTickers) tickers = tickers.slice(0, opt.limitTickers);
  const decisions = [];
  let calls = 0;
  for (const ticker of tickers) {
    for (const group of clusters(byTicker.get(ticker))) {
      const span = tb.fetchSpan(group);
      const trades = await fetchPublicTrades(ticker, span.minTs, span.maxTs, { cacheDir: opt.cache });
      calls++;
      decisions.push(...relabelTicker(group, trades, ticker));
    }
  }
  const s = summarize(decisions);
  s.inputRows = rows.length;
  s.tickerInferred = inf.inferred;
  s.skippedNoTicker = inf.unknown;
  s.tickers = tickers.length;
  s.tradeCalls = calls;
  console.log(JSON.stringify(s, null, 2));
  if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(decisions.filter((d) => d.changed)));
  if (opt.apply) {
    const n = await applyPatches(decisions);
    console.log(`applied ${n} updates`);
  } else {
    console.log('dry run — nothing written (use --apply)');
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { inferTickers, clusters, relabelTicker, summarize, fetchPublicTrades };
