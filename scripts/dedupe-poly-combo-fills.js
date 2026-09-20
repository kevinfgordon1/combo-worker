#!/usr/bin/env node
// One-shot cleanup of duplicate Polymarket combo_fills on the same
// (parlay_id, caoc ticker). claimFillKey cannot collapse these — sources
// mint distinct fill_ids (poly-act: / poly-recon: / poly-pos:).
//
// Keep rule (highest first):
//   1. poly-activity / poly-activity-sold  (trade ids)
//   2. poly-reconcile                      (quote/order cum)
//   3. other polymarket rows               (live WS)
//   4. poly-position                       (snapshot fallback)
// Same-size rows keep the highest rank (all winners if several activities
// share a size). Position snapshots are also dropped when any trade row
// remains on that lock+caoc, even if the snapshot is the sum of lots
// (Eagles 49.32 + 24.63 activity vs poly-pos 73.95).
// Kalshi rows are not touched.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY
// Optional: DEDUPE_LOOKBACK_DAYS (default 21)
// Optional: DEDUPE_DRY_RUN=1
// Does not deploy.
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { selectDuplicatePolyFillsToDrop } = require('../polymarket-fill-reconcile');

const DAYS = parseInt(process.env.DEDUPE_LOOKBACK_DAYS || '21', 10);
const LOOKBACK_MS = (Number.isFinite(DAYS) && DAYS > 0 ? DAYS : 21) * 24 * 3600 * 1000;
const DRY = /^(1|true|yes|on)$/i.test(String(process.env.DEDUPE_DRY_RUN || ''));

const OPEN_CAOCS = [
  'caoc-1f0613a434f23f94',
  'caoc-23f1fca1ea3441ed',
  'caoc-e0bed519fe46b9a2',
  'caoc-ea194abfb78d8326',
  'caoc-ee31bd7977a36124',
];

function qtyOf(row) {
  const n = Number(row && row.count);
  return Number.isFinite(n) ? n : 0;
}

function sumByTicker(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const ticker = String((row && row.ticker) || '').toLowerCase();
    if (!ticker) continue;
    map.set(ticker, (map.get(ticker) || 0) + qtyOf(row));
  }
  return map;
}

function formatQty(n) {
  return (Math.round(Number(n) * 1e8) / 1e8).toFixed(2);
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
    .select('fill_id,parlay_id,ticker,count,recorded_at,raw')
    .eq('is_combo', true)
    .gte('recorded_at', cutoff)
    .limit(5000);
  if (error) throw new Error(error.message);

  const rows = data || [];
  const drop = selectDuplicatePolyFillsToDrop(rows);
  const dropIds = new Set(drop.map((row) => row.fill_id).filter(Boolean));
  const kept = rows.filter((row) => !dropIds.has(row.fill_id));
  const before = sumByTicker(rows);
  const after = sumByTicker(kept);

  console.log(
    `[DEDUPE] lookback_d=${LOOKBACK_MS / 86400000} dry=${DRY} ` +
    `rows=${rows.length} drop=${drop.length}`
  );
  console.log('[DEDUPE] keep rule: poly-activity > poly-reconcile > other poly > poly-position');
  console.log('[DEDUPE] position snapshots drop when any trade remains on that lock+caoc');

  console.log('[DEDUPE] open caoc before → after (DB sum):');
  for (const slug of OPEN_CAOCS) {
    const b = before.get(slug) || 0;
    const a = after.get(slug) || 0;
    console.log(`  ${slug}  ${formatQty(b)} → ${formatQty(a)}`);
  }

  for (const row of drop) {
    const src = row.raw && row.raw.source;
    console.log(
      `[DEDUPE] ${DRY ? 'would drop' : 'dropping'} fill_id=${row.fill_id} ` +
      `ticker=${row.ticker} count=${row.count} src=${src || '—'} parlay=${row.parlay_id}`
    );
  }

  if (DRY || !drop.length) {
    console.log(`[DEDUPE] ${DRY ? 'dry-run done' : 'nothing to drop'}`);
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
      console.error('[DEDUPE] delete failed', row.fill_id, delErr.message);
      continue;
    }
    deleted += 1;
  }
  console.log(`[DEDUPE] deleted=${deleted}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
