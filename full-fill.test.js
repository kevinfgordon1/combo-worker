'use strict';
const assert = require('assert');
const { sumConfirmedForCap, confirmedFullFill, isComboLocksCapRow } = require('./full-fill');
const fakeSb = (rows, error = null) => ({ from: () => { const q = { select: () => q, eq: () => q, then: (r) => r({ data: rows, error }) }; return q; } });
(async () => {
  // Jazz+Hornets: 100 Kalshi + 10.43 Poly confirmed; offered 193.43; cap 142.
  const jazz = [
    { fill_id: '07242b80-a809', order_id: '01a15d80', count: 100, is_combo: true, is_taker: false, raw: { trade_id: 't1' } },
    { fill_id: 'poly-act:D7VA', order_id: 'D7VA', count: 10.43, is_combo: true, is_taker: false, raw: { source: 'poly-activity' } },
  ];
  assert.strictEqual(sumConfirmedForCap(jazz), 110.43);
  let g = await confirmedFullFill({ supabase: fakeSb(jazz), parlayId: 'a179', ceiling: 142 });
  assert.strictEqual(g.full, false, 'offered 193.43 must not deactivate at 110.43 confirmed');
  // Stubs (quote-execution, not a fill), taker buys, sniper subaccount rows excluded.
  const noise = [
    { fill_id: 'o1', order_id: 'o1', count: 67, is_combo: true, is_taker: false, raw: { source: 'live-runner' } },
    { fill_id: 'x', order_id: 'y', count: 50, is_combo: true, is_taker: true, raw: {} },
    { fill_id: 's', order_id: 'z', count: 50, is_combo: true, is_taker: false, raw: { subaccount_number: 3, trade_id: 't' } },
  ];
  assert.strictEqual(sumConfirmedForCap([...jazz, ...noise]), 110.43);
  noise.forEach((r) => assert.strictEqual(isComboLocksCapRow(r), false));
  // Real full fill deactivates.
  g = await confirmedFullFill({ supabase: fakeSb([...jazz, { fill_id: 'f3', order_id: 'o3', count: 31.57, is_combo: true, is_taker: false, raw: { trade_id: 't3' } }]), parlayId: 'a179', ceiling: 142 });
  assert.strictEqual(g.full, true);
  // Read failure never deactivates.
  g = await confirmedFullFill({ supabase: fakeSb(null, { message: 'down' }), parlayId: 'a179', ceiling: 142 });
  assert.strictEqual(g.full, false);
  console.log('full-fill tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
