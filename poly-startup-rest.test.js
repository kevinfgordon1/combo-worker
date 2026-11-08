'use strict';
const assert = require('assert');
const { createPolyStartupRest, retryAfterMs } = require('./poly-startup-rest');
const fr = require('./polymarket-fill-reconcile');

assert.strictEqual(retryAfterMs({ 'retry-after': '2' }, 0), 2000);
assert.strictEqual(retryAfterMs({ get: (n) => (n === 'retry-after' ? '1.5' : null) }, 0), 1500);
const when = Date.parse('2026-11-08T11:34:05.000Z');
assert.strictEqual(retryAfterMs({ 'Retry-After': 'Sun, 08 Nov 2026 11:34:05 GMT' }, when - 2500), 2500);
assert.strictEqual(retryAfterMs({}, 0), null);

(async () => {
  let t = 0;
  const sleeps = [];
  const q = createPolyStartupRest({
    gapMs: 1200,
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
  });
  const order = [];
  const user = q.schedule('user-id', async () => { order.push('user'); return 'u'; });
  const fills = q.schedule('fills', async () => {
    order.push('fills');
    const e = new Error('429');
    e.statusCode = 429;
    e.backoffMs = 5000;
    throw e;
  });
  const pos = q.schedule('positions', async () => { order.push('pos'); return 'p'; });
  const settled = await Promise.allSettled([user, fills, pos]);
  assert.deepStrictEqual(order, ['user', 'fills', 'pos']);
  assert.strictEqual(settled[0].status, 'fulfilled');
  assert.strictEqual(settled[1].status, 'rejected');
  assert.strictEqual(settled[2].status, 'fulfilled');
  assert.ok(sleeps.some((ms) => ms >= 5000), `queue did not honor Retry-After: ${sleeps}`);
  assert.ok(sleeps.filter((ms) => ms === 1200).length >= 1, 'tasks are spaced by the startup gap');
  // The positions read starts only after the 429 hold, not in the same instant as activities.
  assert.ok(t >= 5000);

  // Limiter: a refused slot is not a network call, and the task waits.
  t = 0;
  let n = 0;
  const q2 = createPolyStartupRest({
    gapMs: 100,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    limiter: {
      async acquire() {
        n += 1;
        return n === 1 ? { ok: false, retryInMs: 250 } : { ok: true };
      },
    },
  });
  const out = await q2.schedule('activities', async () => 'hydrated', { path: '/v1/portfolio/activities' });
  assert.strictEqual(out, 'hydrated');
  assert.strictEqual(n, 2, 'the read waits for a limiter slot');
  assert.ok(t >= 250);

  // Activity pages and the following positions read are not back to back.
  fr._resetSlugScanForTest();
  const sleeps2 = [];
  const seen = [];
  const http = {
    async listActivities(q) { seen.push(q.marketSlug || 'global'); return { activities: [{ id: 'a' }], nextCursor: seen.length < 2 ? 'c' : null, eof: seen.length >= 2 }; },
    async listPositions() { seen.push('positions'); return { positions: [] }; },
  };
  await fr.reconcileLockActivityEvents(http, {
    locks: [{ id: 'lock-1' }],
    pageGapMs: 1100,
    slugGapMs: 1100,
    fullSlugs: false,
    maxPages: 2,
    sleep: async (ms) => { sleeps2.push(ms); },
  });
  assert.ok(sleeps2.length >= 1, 'startup hydration sleeps between REST reads');
  assert.ok(sleeps2.every((ms) => ms >= 1100));
  assert.ok(seen.includes('positions') === false || seen.indexOf('positions') > 0);

  console.log('poly-startup-rest.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
