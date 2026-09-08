#!/usr/bin/env node
// One-shot / boot-safe reattribute of combo_fills.parlay_id=null using the
// same quote-window + order_id rules as fills-reader. Stamps matching
// combo_submissions to status=filled + order_id.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY
// Optional: REPAIR_LOOKBACK_HOURS (default 48)
// Does not call Kalshi. Does not deploy.
'use strict';
const { createClient } = require('@supabase/supabase-js');
const {
  attributeComboFill,
  existingFillNeedsParlay,
  submissionFilledPatch,
  canStampSubmission,
} = require('../fills-attr');

const HOURS = parseInt(process.env.REPAIR_LOOKBACK_HOURS || '48', 10);
const LOOKBACK_MS = (Number.isFinite(HOURS) && HOURS > 0 ? HOURS : 48) * 3600 * 1000;

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('need SUPABASE_URL and SUPABASE_SERVICE_KEY');
    process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString();

  const [parlaysQ, fillsQ, subsQ] = await Promise.all([
    supabase.from('combo_parlays').select('id,label,mve_collection,active,max_contracts,fill_american').is('archived_at', null),
    supabase.from('combo_fills').select('*')
      .eq('is_combo', true).eq('is_taker', false).is('parlay_id', null)
      .gte('recorded_at', cutoff),
    supabase.from('combo_submissions').select('id,parlay_id,quote_id,order_id,contracts,status,created_at,label')
      .or('quote_id.not.is.null,order_id.not.is.null')
      .gte('created_at', cutoff)
      .limit(1000),
  ]);
  if (parlaysQ.error) throw new Error(parlaysQ.error.message);
  if (fillsQ.error) throw new Error(fillsQ.error.message);
  if (subsQ.error) throw new Error(subsQ.error.message);

  const parlays = parlaysQ.data || [];
  const submissions = subsQ.data || [];
  const fills = fillsQ.data || [];
  console.log(`repair: ${fills.length} unattributed combo fill(s), ${submissions.length} quote row(s), ${parlays.length} lock(s)`);

  let attributed = 0;
  let stamped = 0;
  for (const row of fills) {
    const attr = attributeComboFill(row.ticker, row, parlays, { submissions });
    const parlay = attr && attr.parlay;
    if (!parlay || !existingFillNeedsParlay(row, parlay.id)) continue;
    const { error } = await supabase
      .from('combo_fills')
      .update({ parlay_id: parlay.id })
      .eq('fill_id', row.fill_id)
      .is('parlay_id', null);
    if (error) {
      console.error('reattribute failed', row.fill_id, error.message);
      continue;
    }
    attributed += 1;
    console.log(`attributed ${row.fill_id} count=${row.count} → ${parlay.label || parlay.id}`);
    if (attr.submission && canStampSubmission(attr.submission, row)) {
      const { error: stampErr } = await supabase
        .from('combo_submissions')
        .update(submissionFilledPatch(row))
        .eq('id', attr.submission.id);
      if (stampErr) console.error('stamp failed', attr.submission.id, stampErr.message);
      else stamped += 1;
    }
  }
  console.log(`repair done: attributed=${attributed} stamped=${stamped}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
