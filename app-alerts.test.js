'use strict';
const assert = require('assert');
const { createAppAlerts, OWNER_EMAIL } = require('./app-alerts');

async function main() {
  assert.strictEqual(OWNER_EMAIL, 'kev120909@gmail.com');
  const off = createAppAlerts({ client: null });
  assert.strictEqual(off.enabled, false);
  assert.strictEqual(await off.raise({ kind: 'x', title: 't' }), false);

  const inserted = [];
  const updates = [];
  let insertError = null;
  const client = {
    from(table) {
      assert.strictEqual(table, 'app_alerts');
      return {
        insert(row) { inserted.push(row); return Promise.resolve({ error: insertError }); },
        update(patch) {
          const q = { filters: [] };
          const chain = {
            eq(c, v) { q.filters.push(['eq', c, v]); return chain; },
            in(c, v) { q.filters.push(['in', c, v]); return chain; },
            is(c, v) { q.filters.push(['is', c, v]); return chain; },
            lt(c, v) { q.filters.push(['lt', c, v]); return chain; },
            then(res, rej) { updates.push({ patch, filters: q.filters }); return Promise.resolve({ error: null }).then(res, rej); },
          };
          return chain;
        },
      };
    },
  };
  const logs = [];
  const a = createAppAlerts({ client, log: (l) => logs.push(l) });
  assert.strictEqual(await a.raise({ kind: 'combo_low_cash', severity: 'warn', title: 'T', body: 'B', dedupeKey: 'k' }), true);
  assert.strictEqual(inserted[0].owner_email, 'kev120909@gmail.com');
  assert.strictEqual(inserted[0].dedupe_key, 'k');
  insertError = { code: '23505', message: 'duplicate key value violates unique constraint' };
  assert.strictEqual(await a.raise({ kind: 'combo_low_cash', title: 'T', dedupeKey: 'k' }), true, 'existing unresolved row = present');
  insertError = { code: '42P01', message: 'relation does not exist' };
  assert.strictEqual(await a.raise({ kind: 'x', title: 'T' }), false, 'other errors are swallowed');
  assert.ok(logs.some((l) => /insert failed/.test(l)));
  assert.strictEqual(await a.resolve(['k']), true);
  assert.deepStrictEqual(updates[0].filters.find((f) => f[0] === 'is'), ['is', 'resolved_at', null]);
  assert.ok(updates[0].patch.resolved_at);
  await a.resolve(['k'], { olderThanMs: 1000 });
  assert.ok(updates[1].filters.some((f) => f[0] === 'lt' && f[1] === 'created_at'));
  assert.strictEqual(await a.resolve([]), false);
  console.log('app-alerts.test.js ok');
}
main().catch((e) => { console.error(e); process.exit(1); });
