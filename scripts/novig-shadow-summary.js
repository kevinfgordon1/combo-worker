// Summarize combo_novig_shadow. Reads Supabase. Sends nothing to Novig.
// Usage: node scripts/novig-shadow-summary.js
'use strict';

const { formatAmerican } = require('../novig-price');

function summarizeShadowRows(rows) {
  const list = rows || [];
  let matched = 0;
  let wouldQuote = 0;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let pending = 0;
  const byReason = {};
  for (const row of list) {
    matched += 1;
    if (!row.skip_reason) wouldQuote += 1;
    else byReason[row.skip_reason] = (byReason[row.skip_reason] || 0) + 1;
    if (row.executed_price == null) pending += 1;
    else if (row.would_win === true) wins += 1;
    else if (row.would_win === false) losses += 1;
    else ties += 1;
  }
  return {
    rows: list.length,
    matched,
    wouldQuote,
    decided: wins + losses + ties,
    wouldWin: wins,
    wouldLose: losses,
    tie: ties,
    awaitingExecution: pending,
    skipReasons: byReason,
  };
}

function formatSummary(summary, rows) {
  const lines = [
    `Novig shadow: ${summary.rows} matched RFQ(s)`,
    `would quote: ${summary.wouldQuote}`,
    `executions: win ${summary.wouldWin}, lose ${summary.wouldLose}, tie ${summary.tie}, waiting ${summary.awaitingExecution}`,
  ];
  const reasons = Object.entries(summary.skipReasons);
  if (reasons.length) {
    lines.push('skips: ' + reasons.map(([k, n]) => `${k}=${n}`).join(', '));
  }
  const sample = (rows || []).filter((r) => r.would_price).slice(0, 8);
  for (const row of sample) {
    const am = row.would_american != null ? formatAmerican(row.would_american) : '';
    lines.push(
      `${row.label || row.parlay_id || row.rfq_id} ${am || row.would_price} ` +
      `stake ${row.would_max_wager == null ? '-' : row.would_max_wager} ` +
      `${row.would_win == null ? (row.skip_reason || 'open') : (row.would_win ? 'would-win' : 'would-lose')}`
    );
  }
  return lines.join('\n');
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.log('Set SUPABASE_URL and SUPABASE_SERVICE_KEY to read combo_novig_shadow.');
    return;
  }
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from('combo_novig_shadow')
    .select('rfq_id,parlay_id,label,would_price,would_american,would_max_wager,skip_reason,executed_price,would_win,seen_at')
    .order('seen_at', { ascending: false })
    .limit(1000);
  if (error) {
    console.error(`shadow read failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(formatSummary(summarizeShadowRows(data), data));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = { summarizeShadowRows, formatSummary };
