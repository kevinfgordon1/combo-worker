'use strict';
// dayTotals (Nov 1): the filled-risk read must bound accepted_at (indexed) as well as filled_at (no index),
// so Postgres can use poly_sniper_ledger_accepted_idx instead of scanning the whole ledger.
const assert = require('assert');
const { createPolySniperStore } = require('./store');

function fakeSupabase(rows) {
  const calls = [];
  return {
    calls,
    from(table) {
      const filters = [];
      const call = { table, select: null, filters };
      calls.push(call);
      const q = {
        select(cols) { call.select = cols; return q; },
        gte(col, v) { filters.push(['gte', col, v]); return q; },
        limit() {
          const out = rows.filter((r) => filters.every(([, col, v]) => r[col] != null && Date.parse(r[col]) >= Date.parse(v)));
          return Promise.resolve({ data: out, error: null });
        },
      };
      return q;
    },
  };
}

(async () => {
  const day = '2026-11-01T04:00:00.000Z';
  const rows = [
    { accepted_at: '2026-11-01T15:00:00Z', filled_at: '2026-11-01T15:00:20Z', filled_contracts: 100, buy_price: 0.2 }, // today: 80
    { accepted_at: '2026-11-01T03:59:30Z', filled_at: '2026-11-01T04:00:10Z', filled_contracts: 10, buy_price: 0.5 }, // accepted before midnight, filled after: 5
    { accepted_at: '2026-10-31T20:00:00Z', filled_at: '2026-10-31T20:00:30Z', filled_contracts: 50, buy_price: 0.1 }, // yesterday: excluded
    { accepted_at: '2026-11-01T16:00:00Z', filled_at: null, filled_contracts: 0, buy_price: 0.3 }, // accepted, never filled
    { settled_at: '2026-11-01T18:00:00Z', realized_pnl: -12.5 },
    { settled_at: '2026-10-31T18:00:00Z', realized_pnl: 99 },
  ];
  const sb = fakeSupabase(rows);
  const store = createPolySniperStore({ supabase: sb, log: () => {} });
  const d = await store.dayTotals(day);
  assert.strictEqual(d.realized, -12.5);
  assert.ok(Math.abs(d.filledRisk - 85) < 1e-9, `filledRisk ${d.filledRisk}`);

  const fill = sb.calls.find((c) => /filled_contracts/.test(c.select || ''));
  const acc = fill.filters.find(([, col]) => col === 'accepted_at');
  assert.ok(acc, 'filled-risk read bounds accepted_at (indexed)');
  assert.strictEqual(acc[2], '2026-10-30T04:00:00.000Z', '48h lookback before the ET day start');
  assert.ok(fill.filters.some(([, col, v]) => col === 'filled_at' && v === day), 'filled_at filter kept (same rows)');

  await assert.rejects(() => store.dayTotals('not-a-date'), /bad day start/);
  console.log('poly-sniper store dayTotals: ok');
})().catch((e) => { console.error(e); process.exit(1); });
