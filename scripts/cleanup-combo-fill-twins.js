#!/usr/bin/env node
// One-shot cleanup of Combo Lock fill twins in combo_fills.
//
// 1) Kalshi: delete live-runner order stubs (fill_id === order_id /
//    raw.source=live-runner) when a real portfolio trade exists for
//    that order_id (trade_id / count_fp / fill_id ≠ order_id).
// 2) Polymarket: same-size activity + reconcile on one lock+caoc —
//    keep poly-activity (trade id), drop poly-reconcile / poly-position.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY
// Optional: CLEANUP_LOOKBACK_DAYS (default 21)
// Optional: CLEANUP_DRY_RUN=1
// Does not deploy.
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { selectLiveRunnerStubsToDrop } = require('../fills-attr');
const { selectDuplicatePolyFillsToDrop } = require('../polymarket-fill-reconcile');

const DAYS = parseInt(process.env.CLEANUP_LOOKBACK_DAYS || '21', 10);
const LOOKBACK_MS = (Number.isFinite(DAYS) && DAYS > 0 ? DAYS : 21) * 24 * 3600 * 1000;
const DRY = /^(1|true|yes|on)$/i.test(String(process.env.CLEANUP_DRY_RUN || ''));

const POLY_TWINS = [
  'poly-recon:DP9qb_kO-3EK-RNRaoBRybVoRsPoOOBWGANmHeGzBrw:629.82',
  'poly-recon:GNESocXBvU9SGBMM3IS-n4O5rkSxza-dBdA5-bSsE2Y:83.57',
];

function uniqueByFillId(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const id = row && row.fill_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('need SUPABASE_URL and SUPABASE_SERVICE_KEY');
    process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const { data, error } = await supabase
    .from('combo_fills')
    .select('fill_id,parlay_id,ticker,count,order_id,recorded_at,raw')
    .eq('is_combo', true)
    .gte('recorded_at', cutoff)
    .limit(8000);
  if (error) throw new Error(error.message);

  const rows = data || [];
  const drop = uniqueByFillId([
    ...selectLiveRunnerStubsToDrop(rows),
    ...selectDuplicatePolyFillsToDrop(rows),
  ]);

  console.log(
    `[CLEANUP] lookback_d=${LOOKBACK_MS / 86400000} dry=${DRY} ` +
    `rows=${rows.length} drop=${drop.length}`
  );
  console.log('[CLEANUP] Kalshi: drop live-runner stubs when a real trade exists for order_id');
  console.log('[CLEANUP] Poly: keep poly-activity, drop same-size reconcile/position');

  for (const row of drop) {
    const src = row.raw && row.raw.source;
    console.log(
      `[CLEANUP] ${DRY ? 'would drop' : 'dropping'} fill_id=${row.fill_id} ` +
      `ticker=${row.ticker || '—'} count=${row.count} src=${src || '—'} ` +
      `order=${row.order_id || '—'} parlay=${row.parlay_id || '—'}`
    );
  }

  const dropIds = new Set(drop.map((row) => row.fill_id));
  for (const id of POLY_TWINS) {
    console.log(`[CLEANUP] expected live twin ${id}: ${dropIds.has(id) ? 'queued' : 'already gone'}`);
  }

  if (DRY || !drop.length) {
    console.log(`[CLEANUP] ${DRY ? 'dry-run done' : 'nothing to drop'}`);
    return;
  }

  let deleted = 0;
  for (const row of drop) {
    if (!row.fill_id) continue;
    const { error: delErr } = await supabase
      .from('combo_fills')
      .delete()
      .eq('fill_id', row.fill_id);
    if (delErr) {
      console.error('[CLEANUP] delete failed', row.fill_id, delErr.message);
      continue;
    }
    deleted += 1;
  }
  console.log(`[CLEANUP] deleted=${deleted}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
