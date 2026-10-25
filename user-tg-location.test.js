'use strict';
const assert = require('assert');
const { createUserTgAlerts, LOCATION_TEXT } = require('./user-tg-alerts');
const U = '11111111-2222-4333-8444-555555555555';
function fakeDb(t) { return { from(n) { const f = []; const q = { select: () => q, eq(c, v) { f.push((r) => r[c] === v); return q; }, in(c, v) { f.push((r) => v.includes(r[c])); return q; }, gt(c, v) { f.push((r) => r[c] > v); return q; }, not(c) { f.push((r) => r[c] != null); return q; }, is(c, v) { f.push((r) => (r[c] ?? null) === v); return q; }, order: () => q, limit: () => q, then(a, b) { return Promise.resolve({ data: (t[n] || []).filter((r) => f.every((g) => g(r))), error: null }).then(a, b); } }; return q; } }; }
(async () => {
  let t = 1000; const sent = [];
  const tables = { combo_tg_links: [{ user_id: U, chat_id: 5, enabled: true }], combo_user_alerts: [] };
  const env = { COMBO_USER_TG_ALERTS: '1', COMBO_USER_TG_BOT_TOKEN: 'x', COMBO_USER_TG_USER_IDS: U, COMBO_USER_TG_GAP_MS: '1' };
  const fetchImpl = async (u, o) => { sent.push(JSON.parse(o.body).text); return { ok: true, status: 200 }; };
  const a = createUserTgAlerts({ supabase: fakeDb(tables), env, fetchImpl, now: () => t, log: () => {}, excludeIds: [] });
  await a.tick();
  tables.combo_user_alerts.push({ id: 'a1', user_id: U, kind: 'location_expired', created_at: new Date(t + 5).toISOString(), resolved_at: null });
  t += 100; await a.tick(); t += 100; await a.tick();
  assert.deepStrictEqual(sent, [LOCATION_TEXT]);
  const off = createUserTgAlerts({ supabase: fakeDb(tables), env: { ...env, COMBO_USER_TG_LOCATION_ALERTS: '0' }, fetchImpl, now: () => 0, log: () => {}, excludeIds: [] });
  await off.tick(); assert.strictEqual(sent.length, 1);
  console.log('user-tg-location ok');
})().catch((e) => { console.error(e); process.exit(1); });
