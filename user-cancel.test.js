'use strict';
const assert = require('node:assert/strict');
const { createUserCancelPoller } = require('./user-cancel');

function fakeSb({ parlays = [], subs = [], err = null } = {}) {
  return {
    from(table) {
      const api = {
        select() { return api; },
        eq() { return api; },
        not() { return api; },
        then(ok, bad) {
          if (err) return Promise.resolve({ data: null, error: err }).then(ok, bad);
          const data = table === 'combo_parlays' ? parlays : subs;
          return Promise.resolve({ data, error: null }).then(ok, bad);
        },
      };
      // supabase client uses await on builder — make it thenable via returning itself with then
      api.select = () => api;
      return api;
    },
  };
}

(async () => {
  const logs = [];
  const poller = createUserCancelPoller({
    supabase: fakeSb({
      parlays: [{ id: 'p1', cancel_open_at: '2026-10-10T05:00:00Z' }],
      subs: [{ id: 's1', parlay_id: 'p1', quote_id: 'q1', is_live: true, cancel_requested_at: '2026-10-10T05:01:00Z' }],
    }),
    log: (m) => logs.push(m),
  });
  let r = await poller.poll();
  assert.deepEqual(r.parlayIds, ['p1']);
  assert.equal(r.submissions.length, 1);

  // Second poll: same timestamps — no re-fire
  r = await poller.poll();
  assert.deepEqual(r.parlayIds, []);
  assert.equal(r.submissions.length, 0);

  // Bump cancel_open_at — fires again
  const poller2 = createUserCancelPoller({
    supabase: fakeSb({
      parlays: [{ id: 'p1', cancel_open_at: '2026-10-10T06:00:00Z' }],
      subs: [],
    }),
  });
  // seed handled with older
  await poller2.poll(); // first sees 06:00
  r = await poller2.poll();
  assert.deepEqual(r.parlayIds, []);

  const missing = createUserCancelPoller({
    supabase: fakeSb({ err: { message: "Could not find the 'cancel_open_at' column of 'combo_parlays'" } }),
    log: (m) => logs.push(m),
  });
  assert.equal(await missing.poll(), null);
  assert.equal(missing.disabled, true);

  console.log('user-cancel.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
