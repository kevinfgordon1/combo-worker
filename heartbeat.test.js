'use strict';
const assert = require('assert');
const { startHeartbeat } = require('./heartbeat');

function client(missing) {
  const inserts = [];
  return {
    inserts,
    from(table) {
      assert.strictEqual(table, 'combo_worker_stats');
      return {
        async insert(row) {
          const bad = Object.keys(row).find((k) => missing.includes(k));
          if (bad) return { error: { message: `Could not find the '${bad}' column of 'combo_worker_stats' in the schema cache` } };
          inserts.push(row);
          return { error: null };
        },
      };
    },
  };
}

(async () => {
  // All extras present.
  {
    const c = client([]);
    const stop = startHeartbeat(c, 'LIVE', { rfqs: 1 }, () => 3, 3_600_000, () => ({ poly: { a: 1 }, latency: { b: 2 }, bucket: { main_cents: 5 } }));
    await new Promise((r) => setTimeout(r, 20));
    stop();
    assert.strictEqual(c.inserts.length, 1);
    assert.deepStrictEqual(Object.keys(c.inserts[0]).filter((k) => ['poly', 'latency', 'bucket'].includes(k)).sort(), ['bucket', 'latency', 'poly']);
  }
  // `bucket` not migrated: only it is dropped, poly/latency still land.
  {
    const c = client(['bucket']);
    const stop = startHeartbeat(c, 'LIVE', { rfqs: 1 }, () => 3, 3_600_000, () => ({ poly: { a: 1 }, latency: { b: 2 }, bucket: { main_cents: 5 } }));
    await new Promise((r) => setTimeout(r, 20));
    stop();
    assert.strictEqual(c.inserts.length, 1);
    assert.ok('poly' in c.inserts[0] && 'latency' in c.inserts[0]);
    assert.ok(!('bucket' in c.inserts[0]));
    assert.strictEqual(c.inserts[0].active_parlays, 3);
  }
  // Several missing: each is dropped in turn.
  {
    const c = client(['bucket', 'latency']);
    const stop = startHeartbeat(c, 'LIVE', { rfqs: 1 }, () => 3, 3_600_000, () => ({ poly: { a: 1 }, latency: { b: 2 }, bucket: {} }));
    await new Promise((r) => setTimeout(r, 20));
    stop();
    assert.strictEqual(c.inserts.length, 1);
    assert.ok('poly' in c.inserts[0] && !('latency' in c.inserts[0]) && !('bucket' in c.inserts[0]));
  }
  console.log('heartbeat.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
