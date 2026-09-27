#!/usr/bin/env node
// Reconcile combo_fills against Kalshi portfolio fill history.
//
// quote_executed records a live-runner stub at the quoted size. Kalshi can
// mark that quote executed (orders placed) and still have no portfolio fill.
// Those rows inflate max_contracts. This script drops them, replaces a stub
// with the real partial fills when Kalshi does have them, and corrects a
// stored count that disagrees with count_fp.
//
// Idempotent. Default is a dry run that prints the plan and writes nothing.
//
//   node scripts/reconcile-kalshi-phantom-fills.js
//   node scripts/reconcile-kalshi-phantom-fills.js --apply
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, KALSHI_KEY_ID, Kalshi_combo_key
//      (KALSHI_PRIVATE_KEY also accepted)
// Optional: RECONCILE_LOOKBACK_DAYS (default 21)
//           RECONCILE_APPLY=1   same as --apply
//
// Does not deploy. Does not start the worker. Refuses to change rows when
// the Kalshi fill read fails or comes back truncated.
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { normalizePem, authHeaders } = require('../kalshi-auth');
const { isQuoteExecutionStub } = require('../fills-attr');
const {
  fillsQuery,
  planKalshiFillReconcile,
  reconcileMode,
  reconcileFetchUsable,
  collectFillPages,
  applyKalshiFillPlan,
  buildKalshiFillIndex,
} = require('../kalshi-fill-confirm');

const REST = 'https://external-api.kalshi.com';
const PORTFOLIO_PATH = '/trade-api/v2/portfolio/fills';
const HISTORICAL_PATH = '/trade-api/v2/historical/fills';
const DAYS = parseInt(process.env.RECONCILE_LOOKBACK_DAYS || '21', 10);
const LOOKBACK_MS = (Number.isFinite(DAYS) && DAYS > 0 ? DAYS : 21) * 24 * 3600 * 1000;

function log(line) {
  console.log(`[RECONCILE] ${line}`);
}

async function kalshiGet(signPath, query, keyId, pem) {
  const headers = authHeaders({ keyId, pem, method: 'GET', signPath });
  const res = await fetch(`${REST}${signPath}?${query}`, { method: 'GET', headers });
  const text = await res.text();
  return { statusCode: res.status, text };
}

async function fetchFillEndpoint(signPath, { minTs, orderId, allowNotFound, keyId, pem }) {
  return collectFillPages(async (cursor) => {
    const qs = fillsQuery({ minTs, orderId, cursor, limit: 200 });
    let res;
    try {
      res = await kalshiGet(signPath, qs, keyId, pem);
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
    if (res.statusCode === 404 && allowNotFound) return { ok: true, fills: [], cursor: '' };
    if (res.statusCode !== 200) {
      return { ok: false, error: `${signPath} ${res.statusCode}: ${String(res.text || '').slice(0, 240)}` };
    }
    let body;
    try { body = JSON.parse(res.text || '{}'); }
    catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, fills: body.fills || [], cursor: body.cursor || '' };
  });
}

async function loadComboFills(supabase, cutoff) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; from < 20000; from += pageSize) {
    const { data, error } = await supabase
      .from('combo_fills')
      .select('fill_id,parlay_id,ticker,count,order_id,recorded_at,raw,is_combo,is_taker')
      .eq('is_combo', true)
      .gte('recorded_at', cutoff)
      .order('recorded_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return rows;
}

async function main() {
  const mode = reconcileMode(process.argv.slice(2), process.env);
  const dryRun = mode !== 'apply';
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('need SUPABASE_URL and SUPABASE_SERVICE_KEY');
    process.exit(1);
  }
  const keyId = process.env.KALSHI_KEY_ID;
  const pem = normalizePem(process.env.Kalshi_combo_key || process.env.KALSHI_PRIVATE_KEY || '');
  if (!keyId || !pem) {
    console.error('need KALSHI_KEY_ID and Kalshi_combo_key');
    process.exit(1);
  }

  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const minTs = Math.floor((Date.now() - LOOKBACK_MS) / 1000);
  log(`mode=${mode} lookback_d=${LOOKBACK_MS / 86400000} since=${cutoff}`);
  log('reads Kalshi fills and combo_fills; writes only with --apply');

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const dbRows = await loadComboFills(supabase, cutoff);
  const portfolio = await fetchFillEndpoint(PORTFOLIO_PATH, { minTs, keyId, pem });
  if (!reconcileFetchUsable(portfolio)) {
    console.error(`[RECONCILE] portfolio fills unavailable (${portfolio && (portfolio.error || (portfolio.truncated ? 'truncated' : 'failed'))}) — not changing combo_fills`);
    process.exit(1);
  }
  const historical = await fetchFillEndpoint(HISTORICAL_PATH, {
    minTs, allowNotFound: true, keyId, pem,
  });
  if (!reconcileFetchUsable(historical)) {
    console.error(`[RECONCILE] historical fills unavailable (${historical && (historical.error || 'truncated')}) — not changing combo_fills`);
    process.exit(1);
  }

  const kalshiFills = portfolio.fills.concat(historical.fills);
  let index = buildKalshiFillIndex(kalshiFills);
  const unverifiedOrderIds = new Set();
  const stubs = dbRows.filter(isQuoteExecutionStub);
  for (const stub of stubs) {
    const orderId = stub.order_id || stub.fill_id;
    if (!orderId || index.matches(orderId).length || index.byFillId.has(orderId)) continue;
    const looked = await fetchFillEndpoint(PORTFOLIO_PATH, { orderId, keyId, pem });
    if (!reconcileFetchUsable(looked)) {
      unverifiedOrderIds.add(orderId);
      log(`skip order_id=${orderId} — portfolio lookup failed (${looked && looked.error})`);
      continue;
    }
    kalshiFills.push(...looked.fills);
    index = buildKalshiFillIndex(kalshiFills);
  }

  const plan = planKalshiFillReconcile(dbRows, kalshiFills, { unverifiedOrderIds });
  log(`db_rows=${dbRows.length} kalshi_fills=${kalshiFills.length} stubs=${stubs.length}`);

  const confirmedIds = new Set(
    kalshiFills.map((fill) => fill && (fill.fill_id || fill.trade_id)).filter(Boolean)
  );
  const result = await applyKalshiFillPlan({
    deleteFill: async (fillId) => {
      if (confirmedIds.has(fillId)) {
        throw new Error(`refusing to delete Kalshi-confirmed fill_id=${fillId}`);
      }
      const { error } = await supabase.from('combo_fills').delete().eq('fill_id', fillId);
      if (error) throw new Error(error.message);
    },
    insertFill: async (row) => {
      const { error } = await supabase.from('combo_fills').upsert(row, { onConflict: 'fill_id' });
      if (error) throw new Error(error.message);
    },
    updateCount: async (fillId, count) => {
      const { error } = await supabase.from('combo_fills').update({ count }).eq('fill_id', fillId);
      if (error) throw new Error(error.message);
    },
  }, plan, { dryRun, log });

  if (dryRun) log('dry-run done — no rows changed. Re-run with --apply to write.');
  else log(`applied dropped=${result.dropped} inserted=${result.inserted} updated=${result.updated}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main };
