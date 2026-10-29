'use strict';
// poly_sniper_ledger.quoted_risk: written when the column exists; before the migration the store drops
// the field (once) instead of losing the ledger row.
const assert = require('assert');
const { createPolySniperStore } = require('./store');

function fakeSupabase({ hasColumn }) {
  const upserts = [];
  return {
    upserts,
    from() {
      return {
        upsert: async (row) => {
          upserts.push(row);
          if (!hasColumn && 'quoted_risk' in row) return { error: { message: "Could not find the 'quoted_risk' column of 'poly_sniper_ledger' in the schema cache" } };
          return { error: null };
        },
      };
    },
  };
}

(async () => {
  const base = { quote_id: 'q1', rfq_id: 'r1', phase: 'quoted', buy_price: 0.08, contracts: 121, quoted_risk: 111.32 };

  const ok = fakeSupabase({ hasColumn: true });
  const s1 = createPolySniperStore({ supabase: ok, log: () => {}, retries: 0, sleep: async () => {} });
  assert.strictEqual(await s1.insertQuote(base), true);
  assert.strictEqual(ok.upserts.length, 1);
  assert.strictEqual(ok.upserts[0].quoted_risk, 111.32);

  const logs = [];
  const old = fakeSupabase({ hasColumn: false });
  const s2 = createPolySniperStore({ supabase: old, log: (m) => logs.push(m), retries: 0, sleep: async () => {} });
  assert.strictEqual(await s2.insertQuote(base), true, 'row still written without the column');
  assert.ok(!('quoted_risk' in old.upserts[1]));
  assert.strictEqual(await s2.insertQuote({ ...base, quote_id: 'q2' }), true);
  assert.strictEqual(old.upserts.length, 3, 'after the first miss the field is dropped up front (no extra failed write)');
  assert.strictEqual(logs.filter((m) => /quoted_risk column missing/.test(m)).length, 1);
  assert.strictEqual(s2.stats().quotedRiskColumn, false);
  console.log('poly-sniper store: ok');
})().catch((e) => { console.error(e); process.exit(1); });
