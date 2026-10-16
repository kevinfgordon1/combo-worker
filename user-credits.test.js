'use strict';
const assert = require('node:assert/strict');
const { createUserCredits, ALERT_KEY } = require('./user-credits');
const K = '42b5ee16-68d5-4b3b-a931-40aa17cd1a47';
const H = '721c1166-be0b-4856-8a88-6de3a8b047b9';

function fakeClient(rows, { rpcError = null } = {}) {
  const alerts = [];
  const c = {
    alerts, rows,
    async rpc(name, args) {
      assert.equal(name, 'combo_fee_status_for_worker');
      if (rpcError) return { data: null, error: rpcError };
      return { data: c.rows.filter((r) => args.uids.includes(r.user_id)), error: null };
    },
    from(t) {
      assert.equal(t, 'combo_user_alerts');
      const st = { filters: {} };
      const q = {
        insert(row) { if (alerts.some((a) => a.user_id === row.user_id && a.dedupe_key === row.dedupe_key && !a.resolved_at)) return Promise.resolve({ error: { code: '23505' } }); alerts.push({ ...row }); return Promise.resolve({ error: null }); },
        update(p) { st.patch = p; return q; },
        eq(k, v) { st.filters[k] = v; return q; },
        is() { alerts.filter((a) => a.user_id === st.filters.user_id && a.dedupe_key === st.filters.dedupe_key && !a.resolved_at).forEach((a) => Object.assign(a, st.patch)); return Promise.resolve({ error: null }); },
      };
      return q;
    },
  };
  return c;
}

(async () => {
  const c = fakeClient([
    { user_id: K, fees_enabled: true, can_quote: true, allowance_left_usd: 12, credits_usd: 0 },
    { user_id: H, fees_enabled: false, can_quote: true },
  ]);
  const g = createUserCredits({ client: c, log: () => {} });
  assert.equal(g.blocked(K), false, 'unknown before first read = not blocked (fee users are opt-in)');
  assert.equal(await g.refresh([K, H]), true);
  assert.equal(g.blocked(K), false);
  assert.equal(g.blocked(H), false);

  // Kenny runs out: blocked + exactly one alert, even over many refreshes.
  c.rows[0] = { ...c.rows[0], can_quote: false, allowance_left_usd: 0, credits_usd: -0.08 };
  await g.refresh([K, H]); await g.refresh([K, H]);
  assert.equal(g.blocked(K), true);
  assert.equal(g.blocked(H), false, 'fee-free users never blocked');
  assert.equal(c.alerts.length, 1);
  assert.equal(c.alerts[0].kind, 'no_credits');
  assert.equal(c.alerts[0].dedupe_key, ALERT_KEY);
  assert.match(c.alerts[0].title, /Add credits to keep quoting/);

  // Read error keeps the last snapshot (still blocked).
  const prevRpc = c.rpc;
  c.rpc = async () => ({ data: null, error: { message: 'timeout' } });
  assert.equal(await g.refresh([K]), false);
  assert.equal(g.blocked(K), true);
  c.rpc = prevRpc;

  // Buys credits: unblocked, alert resolved.
  c.rows[0] = { ...c.rows[0], can_quote: true, credits_usd: 25 };
  await g.refresh([K, H]);
  assert.equal(g.blocked(K), false);
  assert.ok(c.alerts[0].resolved_at);

  // Missing migration: nobody is blocked.
  const m = createUserCredits({ client: fakeClient([], { rpcError: { code: 'PGRST202', message: 'Could not find the function' } }), log: () => {} });
  assert.equal(await m.refresh([K]), false);
  assert.equal(m.blocked(K), false);
  console.log('user-credits.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
