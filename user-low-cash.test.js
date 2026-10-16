'use strict';
const assert = require('assert');
const { createUserLowCash, availableFrom, alertText } = require('./user-low-cash');

const U = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const P2 = '33333333-3333-4333-8333-333333333333';

function fakeDb(balances) {
  const rows = [];
  let n = 0;
  function q(table) {
    const st = { table, filters: [], op: 'select', payload: null };
    const b = {
      select() { return b; }, limit() { return b; },
      eq(k, v) { st.filters.push((r) => r[k] === v); return b; },
      in(k, v) { st.filters.push((r) => v.includes(r[k])); return b; },
      is(k, v) { st.filters.push((r) => (r[k] == null) === (v == null)); return b; },
      insert(r) { st.op = 'insert'; st.payload = r; return b; },
      update(r) { st.op = 'update'; st.payload = r; return b; },
      then(res, rej) {
        let out;
        if (table === 'combo_balances') out = { data: balances.rows, error: null };
        else if (st.op === 'insert') {
          if (rows.some((r) => r.user_id === st.payload.user_id && r.dedupe_key === st.payload.dedupe_key && !r.resolved_at)) out = { data: null, error: { code: '23505' } };
          else { const r = { id: 'r' + (++n), ...st.payload }; rows.push(r); out = { data: [{ id: r.id }], error: null }; }
        } else {
          const m = rows.filter((r) => st.filters.every((f) => f(r)));
          if (st.op === 'update') m.forEach((r) => Object.assign(r, st.payload));
          out = { data: m, error: null };
        }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return b;
  }
  return { rows, client: { from: q } };
}

(async () => {
  assert.strictEqual(availableFrom([{ venue: 'kalshi', shard: 1, available_usd: 12 }], 'kalshi'), 12);
  assert.match(alertText({ venue: 'kalshi', shortfallUsd: 8 }).body, /about \$8\.00 short\. Add money on Kalshi or raise your Amount to keep for combos\./);

  const bal = { rows: [{ venue: 'kalshi', shard: 1, available_usd: 12, ok: true }] };
  const db = fakeDb(bal);
  let now = 0;
  const lc = createUserLowCash({ client: db.client, log: () => {}, clock: () => now });
  assert.ok(await lc.onRejected({ userId: U, parlayId: P, label: 'A + B', venue: 'kalshi', costDollars: 20 }));
  assert.strictEqual(db.rows.length, 1);
  assert.strictEqual(db.rows[0].shortfall_usd, 8);
  // same lock again => bump, no new row
  await lc.onRejected({ userId: U, parlayId: P, venue: 'kalshi', costDollars: 25 });
  assert.strictEqual(db.rows.length, 1);
  assert.strictEqual(db.rows[0].skipped_count, 2);
  // other lock within the hour => throttled
  assert.strictEqual(await lc.onRejected({ userId: U, parlayId: P2, venue: 'kalshi', costDollars: 5 }), false);
  assert.strictEqual(db.rows.length, 1);
  // not covered yet
  assert.strictEqual(await lc.tick([U]), 0);
  bal.rows[0].available_usd = 30;
  assert.strictEqual(await lc.tick([U]), 1);
  assert.ok(db.rows[0].resolved_at);
  // after an hour, other lock alerts again; a good quote resolves it
  now += 3600e3;
  assert.ok(await lc.onRejected({ userId: U, parlayId: P2, venue: 'kalshi', costDollars: 50 }));
  assert.strictEqual(db.rows.length, 2);
  assert.ok(await lc.onQuoted({ userId: U, parlayId: P2, venue: 'kalshi' }));
  assert.ok(db.rows[1].resolved_at);
  // bad user id ignored; no client => disabled
  assert.strictEqual(await lc.onRejected({ userId: 'x' }), false);
  assert.strictEqual(createUserLowCash({}).enabled, false);
  console.log('user-low-cash tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
