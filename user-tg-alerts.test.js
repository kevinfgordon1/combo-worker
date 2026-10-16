'use strict';
const assert = require('assert');
const { createUserTgAlerts, formatQuote, fmtAmerican } = require('./user-tg-alerts');
const { buildTesterEnv } = require('./tester-env');

const KEVIN = '79ae1610-097e-4b46-a622-1e952f18e936';
const KENNY = '42b5ee16-68d5-4b3b-a931-40aa17cd1a47';
const OTHER = '11111111-2222-4333-8444-555555555555';
const PID = '799f71e3-e7d7-49e9-a88c-9a7926eb714c';

function fakeDb(tables) {
  return {
    from(name) {
      const f = []; let lim = Infinity;
      const q = {
        select() { return q; },
        eq(c, v) { f.push((r) => r[c] === v); return q; },
        in(c, v) { f.push((r) => v.includes(r[c])); return q; },
        gt(c, v) { f.push((r) => r[c] > v); return q; },
        not(c, op, v) { f.push((r) => r[c] != null); return q; },
        order() { return q; },
        limit(n) { lim = n; return q; },
        then(res, rej) { return Promise.resolve({ data: (tables[name] || []).filter((r) => f.every((g) => g(r))).slice(0, lim), error: null }).then(res, rej); },
      };
      return q;
    },
  };
}

(async () => {
  assert.strictEqual(fmtAmerican(1170), '+1170');
  assert.strictEqual(fmtAmerican(-150), '-150');
  const parlay = { id: PID, user_id: KENNY, label: 'x', fill_american: 1170, legs: [{ label: 'Las Vegas' }, { label: 'Green Bay' }, { label: 'New Orleans' }] };
  assert.strictEqual(formatQuote({ fill_american: 1170, contracts: 25 }, parlay), 'Quote sent: Las Vegas + Green Bay + New Orleans @ +1170, 25 contracts');

  // Off by default / without allowlist.
  assert.strictEqual(createUserTgAlerts({ supabase: fakeDb({}), env: {} }).active, false);
  assert.strictEqual(createUserTgAlerts({ supabase: fakeDb({}), env: { COMBO_USER_TG_ALERTS: '1', COMBO_USER_TG_BOT_TOKEN: 't' } }).active, false);

  // Child env never gets the per-user bot token.
  const ce = buildTesterEnv({ COMBO_USER_TG_BOT_TOKEN: 'secret', COMBO_USER_TG_ALERTS: '1', TESTER_ENV_COMBO_USER_TG_BOT_TOKEN: 's2' }, { userId: KENNY, kalshi: { keyId: 'k', secret: 's' } });
  assert.ok(!('COMBO_USER_TG_BOT_TOKEN' in ce) && !('COMBO_USER_TG_ALERTS' in ce));

  let t = Date.parse('2026-10-10T20:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const tables = {
    combo_tg_links: [
      { user_id: KENNY, chat_id: 555, enabled: true },
      { user_id: KEVIN, chat_id: 8745205056, enabled: true }, // Kevin never via this path
      { user_id: OTHER, chat_id: 777, enabled: true }, // not allowlisted
    ],
    combo_parlays: [parlay, { id: 'kp', user_id: KEVIN, label: 'kevin lock', legs: [], fill_american: 500 }],
    combo_submissions: [],
    combo_fills: [],
  };
  const sent = [];
  const fetchImpl = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; };
  const a = createUserTgAlerts({ supabase: fakeDb(tables), env: { COMBO_USER_TG_ALERTS: '1', COMBO_USER_TG_BOT_TOKEN: 't', COMBO_USER_TG_USER_IDS: `${KENNY},${KEVIN}` }, fetchImpl, now: () => t, log: () => {} });
  assert.strictEqual(await a.tick(), 1); // only Kenny
  assert.deepStrictEqual([...a._users.keys()], [KENNY]);

  // Old rows (before link) are not sent; new quotes + other users' rows.
  tables.combo_submissions.push(
    { id: 's0', user_id: KENNY, parlay_id: PID, fill_american: 1170, contracts: 5, status: 'unfilled', created_at: iso(t - 1000) },
    { id: 's1', user_id: KENNY, parlay_id: PID, fill_american: 1170, contracts: 10, status: 'unfilled', created_at: iso(t + 1000) },
    { id: 's2', user_id: KENNY, parlay_id: PID, fill_american: 1170, contracts: 3, status: 'declined', created_at: iso(t + 1500) },
    { id: 'k1', user_id: KEVIN, parlay_id: 'kp', fill_american: 500, contracts: 99, status: 'unfilled', created_at: iso(t + 1000) },
  );
  t += 2000;
  await a.tick();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].chat_id, '555');
  assert.strictEqual(sent[0].text, 'Quote sent: Las Vegas + Green Bay + New Orleans @ +1170, 10 contracts');

  // Throttle: more quotes + a fill within 30s are held, then batched.
  tables.combo_submissions.push({ id: 's3', user_id: KENNY, parlay_id: PID, fill_american: 1170, contracts: 7, status: 'unfilled', created_at: iso(t + 100) });
  tables.combo_fills.push(
    { fill_id: 'f1', user_id: KENNY, parlay_id: PID, count: 7, no_price: 0.92, outcome_side: 'no', recorded_at: iso(t + 200) },
    { fill_id: 'fk', user_id: KEVIN, parlay_id: 'kp', count: 50, yes_price: 0.1, recorded_at: iso(t + 200) },
  );
  t += 5000;
  await a.tick();
  assert.strictEqual(sent.length, 1);
  t += 30_000;
  await a.tick();
  assert.strictEqual(sent.length, 2);
  const lines = sent[1].text.split('\n');
  assert.ok(lines[0].startsWith('FILLED: Las Vegas + Green Bay + New Orleans @ +1170, 7 contracts'));
  assert.ok(lines[1].includes('7 contracts') && lines[1].startsWith('Quote sent'));
  assert.ok(!sent.some((m) => /kevin|99 contracts|50 contracts/.test(m.text)));
  assert.ok(sent.every((m) => m.chat_id === '555'));

  // Disable => stops.
  tables.combo_tg_links[0].enabled = false;
  assert.strictEqual(await a.tick(), 0);
  assert.strictEqual(a._users.size, 0);
  console.log('user-tg-alerts tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
