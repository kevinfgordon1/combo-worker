'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_LIVE_USER_IDS, parseLiveUserIds, resolveEnvAllowlist, createLiveUserGate,
} = require('./live-users');
const { resolveWorkerScope, scopeLabel } = require('./worker-scope');

const KEVIN = '79ae1610-097e-4b46-a622-1e952f18e936';
const KEVIN2 = '968efed8-54db-48a6-808b-194a7a03a4cb';
const OTHER = '42b5ee16-68d5-4b3b-a931-40aa17cd1a47';
const RANDOM = '11111111-2222-4333-8444-555555555555';

// Env allowlist: unset/blank => no extra restriction; garbage => Kevin only.
for (const env of [{}, { COMBO_LIVE_USER_IDS: '' }, { COMBO_LIVE_USER_IDS: '   ' }]) {
  assert.strictEqual(resolveEnvAllowlist(env).ids, null);
}
assert.ok(DEFAULT_LIVE_USER_IDS.includes(KEVIN));
assert.ok(!DEFAULT_LIVE_USER_IDS.includes(OTHER));
{
  const r = resolveEnvAllowlist({ COMBO_LIVE_USER_IDS: 'kev120909@gmail.com, nope' });
  assert.strictEqual(r.invalid, true);
  assert.deepStrictEqual([...r.ids].sort(), [...DEFAULT_LIVE_USER_IDS].sort());
}
assert.deepStrictEqual(parseLiveUserIds(` ${KEVIN.toUpperCase()},${OTHER} ;bad`), [KEVIN, OTHER]);
assert.deepStrictEqual([...resolveEnvAllowlist({ COMBO_LIVE_USER_IDS: OTHER }).ids], [OTHER]);

// Worker scope: unset => Kevin's main worker; uuid => one tester; garbage => nothing.
{
  const main = resolveWorkerScope({});
  assert.deepStrictEqual([...main.userIds].sort(), [...DEFAULT_LIVE_USER_IDS].sort());
  assert.strictEqual(main.writeUserId, null);
  assert.strictEqual(main.isTester, false);
  const t = resolveWorkerScope({ COMBO_WORKER_USER_ID: ` ${RANDOM.toUpperCase()} ` });
  assert.deepStrictEqual([...t.userIds], [RANDOM]);
  assert.strictEqual(t.writeUserId, RANDOM);
  assert.strictEqual(t.isTester, true);
  const bad = resolveWorkerScope({ COMBO_WORKER_USER_ID: 'kevin' });
  assert.strictEqual(bad.invalid, true);
  assert.deepStrictEqual([...bad.userIds], []);
  assert.ok(/INVALID/.test(scopeLabel(bad)));
  assert.ok(/owner worker/.test(scopeLabel(main)));
}

const DB = (rows) => ({ data: rows, error: null });
const kevRows = [
  { user_id: KEVIN, can_trade: true, paused: false, max_per_lock_usd: null, max_per_day_usd: null },
  { user_id: KEVIN2, can_trade: true, paused: false, max_per_lock_usd: null, max_per_day_usd: null },
];

// Main worker before combo_live_users is read: Kevin's scope, uncapped (his path
// never depends on the new table).
{
  const logs = [];
  const gate = createLiveUserGate({ env: {}, log: (m) => logs.push(m) });
  assert.strictEqual(gate.loaded, false);
  assert.strictEqual(gate.isAllowed(KEVIN), true);
  assert.strictEqual(gate.isAllowed(KEVIN.toUpperCase()), true);
  assert.strictEqual(gate.isAllowed(KEVIN2), true);
  assert.strictEqual(gate.isAllowed(OTHER), false);
  assert.strictEqual(gate.isAllowed(null), false);
  assert.strictEqual(gate.isAllowed(''), false);
  assert.strictEqual(gate.capsFor(KEVIN), null);

  const rows = [
    { id: 'k1', user_id: KEVIN, label: 'Kevin lock' },
    { id: 'x1', user_id: RANDOM, label: 'Stranger lock' },
    { id: 'k2', user_id: KEVIN2, label: 'Kevin alt' },
    { id: 'n1', user_id: null, label: 'No owner' },
  ];
  assert.deepStrictEqual(gate.filterParlays(rows).map((r) => r.id), ['k1', 'k2']);
  assert.strictEqual(logs.length, 2);
  assert.ok(/skipping lock x1 .*not a live user of this worker/.test(logs[0]));
  assert.ok(/skipping lock n1/.test(logs[1]));
  gate.filterParlays(rows);
  gate.filterParlays(rows);
  assert.strictEqual(logs.length, 2);
  assert.strictEqual(gate.filterParlays(null), null);
  assert.deepStrictEqual(gate.filterParlays([]), []);
  // Fill attribution: scope only, never another user's locks.
  assert.deepStrictEqual(gate.filterByScope(rows).map((r) => r.id), ['k1', 'k2']);

  const kill = gate.filterKillByUser({ [KEVIN]: false, [RANDOM]: false, [OTHER]: true });
  assert.deepStrictEqual(kill, { [KEVIN]: false });
  assert.strictEqual(gate.filterKillByUser(null), null);
  assert.ok(/scope 2 user\(s\)/.test(gate.summary()));

  // A tester appearing in combo_live_users never reaches Kevin's worker.
  assert.strictEqual(gate.apply(DB(kevRows.concat([{ user_id: RANDOM, can_trade: true, paused: false, max_per_lock_usd: 50, max_per_day_usd: 250 }]))), true);
  assert.strictEqual(gate.loaded, true);
  assert.strictEqual(gate.isAllowed(KEVIN), true);
  assert.strictEqual(gate.isAllowed(RANDOM), false);
  assert.strictEqual(gate.capsFor(KEVIN), null, 'Kevin stays uncapped');

  // Read failure keeps the last snapshot.
  assert.strictEqual(gate.apply({ data: null, error: { message: 'timeout' } }), false);
  assert.strictEqual(gate.isAllowed(KEVIN), true);
  // Owner pausing Kevin's own account is honoured too.
  gate.apply(DB([{ ...kevRows[0], paused: true }, kevRows[1]]));
  assert.strictEqual(gate.isAllowed(KEVIN), false);
  assert.strictEqual(gate.isAllowed(KEVIN2), true);
}

// Missing caps/pause columns => fall back to base columns.
{
  const logs = [];
  const gate = createLiveUserGate({ env: {}, log: (m) => logs.push(m) });
  const selects = [];
  const fake = { from: () => ({ select: (c) => { selects.push(c); return Promise.resolve(null); } }) };
  gate.query(fake);
  gate.apply({ data: null, error: { message: 'column combo_live_users.paused does not exist' } });
  gate.query(fake);
  assert.ok(/max_per_day_usd/.test(selects[0]));
  assert.strictEqual(selects[1], 'user_id,can_trade');
  assert.strictEqual(gate.isAllowed(KEVIN), true);
}

// Tester child: fails closed until the DB row is read; then can_trade/paused/caps.
{
  const scope = resolveWorkerScope({ COMBO_WORKER_USER_ID: RANDOM });
  const gate = createLiveUserGate({ env: {}, scope, log: () => {} });
  assert.strictEqual(gate.isAllowed(RANDOM), false, 'no DB yet => quotes nothing');
  assert.deepStrictEqual(gate.capsFor(RANDOM), { perLockUsd: 0, perDayUsd: 0 });
  gate.apply(DB(kevRows));
  assert.strictEqual(gate.isAllowed(RANDOM), false, 'not in combo_live_users');
  assert.strictEqual(gate.isAllowed(KEVIN), false, 'never Kevin from a tester process');
  gate.apply(DB(kevRows.concat([{ user_id: RANDOM, can_trade: true, paused: false, max_per_lock_usd: '50', max_per_day_usd: 250 }])));
  assert.strictEqual(gate.isAllowed(RANDOM), true);
  assert.deepStrictEqual(gate.capsFor(RANDOM), { perLockUsd: 50, perDayUsd: 250 });
  const rows = [{ id: 'k1', user_id: KEVIN }, { id: 't1', user_id: RANDOM }, { id: 'o1', user_id: OTHER }];
  assert.deepStrictEqual(gate.filterParlays(rows).map((r) => r.id), ['t1']);
  assert.deepStrictEqual(gate.filterByScope(rows).map((r) => r.id), ['t1']);
  assert.deepStrictEqual(gate.filterKillByUser({ [KEVIN]: false, [RANDOM]: false }), { [RANDOM]: false });
  gate.apply(DB([{ user_id: RANDOM, can_trade: true, paused: true }]));
  assert.strictEqual(gate.isAllowed(RANDOM), false, 'owner pause stops quoting');
  assert.deepStrictEqual(gate.filterByScope(rows).map((r) => r.id), ['t1'], 'late fills still book to own locks');
  gate.apply(DB([{ user_id: RANDOM, can_trade: false, paused: false }]));
  assert.strictEqual(gate.isAllowed(RANDOM), false);
  // Env allowlist narrows testers too.
  const g2 = createLiveUserGate({ env: { COMBO_LIVE_USER_IDS: KEVIN }, scope, log: () => {} });
  g2.apply(DB([{ user_id: RANDOM, can_trade: true, paused: false }]));
  assert.strictEqual(g2.isAllowed(RANDOM), false);
}

// Env allowlist that excludes Kevin really excludes him.
{
  const gate = createLiveUserGate({ env: { COMBO_LIVE_USER_IDS: RANDOM }, log: () => {} });
  assert.deepStrictEqual(gate.filterParlays([{ id: 'k1', user_id: KEVIN }, { id: 'r', user_id: RANDOM }]).map((r) => r.id), []);
}

// Wiring: every loader that can lead to a quote or a fill attribution is gated
// and scoped to this process's user(s).
const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
{
  const live = src('live-runner.js');
  assert.ok(/parlays = liveUsers\.filterParlays\(applyRefreshParlays\(parlays, parlaysQ, refreshLog\)\)/.test(live), 'live refresh gates parlays');
  assert.ok(/liveUsers\.query\(supabase\),\n    \]\);\n    liveUsers\.apply\(usersQ\);/.test(live), 'refresh reads combo_live_users');
  assert.ok(/killByUser = liveUsers\.filterKillByUser\(applyRefreshKillByUser\(/.test(live), 'live refresh gates kill switch');
  assert.ok(/const killEngagedFor = \(userId, lock = null\) => !liveUsers\.isAllowed\(userId\)\n  \|\| killByUser\[userId\] !== false\n  \|\| userCaps\.dayBlocked\(/.test(live), 'kill engaged for non-allowed, kill switch, day cap');
  assert.ok(/parlays = userCaps\.applyLockCaps\(parlays\);/.test(live), 'per-lock cap applied');
  assert.ok(/getParlays: \(\) => parlays/.test(live), 'Polymarket RFQ loop reads the gated Kalshi list');
  assert.ok(/const recent = liveUsers\.filterByScope\(locksQ\.data/.test(live), 'poly fill lock lookup scoped');
  const scoped = live.match(/\.in\('user_id', SCOPE\.userIds\)/g) || [];
  assert.ok(scoped.length >= 7, `submission/fill reads scoped (${scoped.length})`);
  assert.ok(/withScopeUser\(liveRunnerFillRow\(/.test(live) && /const stored = withScopeUser\(/.test(live), 'fill writes carry user_id');
  assert.ok(/if \(!SCOPE\.isTester\) bucketManager\.start\(\);/.test(live), 'bucket manager never runs for testers');
  assert.ok(/createAppAlerts\(\{ client: SCOPE\.isTester \? null : supabase \}\)/.test(live), 'no Kevin app alerts from testers');
  const shadow = src('shadow-runner.js');
  assert.ok(/parlays = liveUsers\.filterParlays\(applyRefreshParlays\(/.test(shadow));
  assert.ok(/killByUser = liveUsers\.filterKillByUser\(applyRefreshKillByUser\(/.test(shadow));
  assert.ok(/parlays = liveUsers\.filterParlays\(applyRefreshParlays\(/.test(src('unhedged-runner.js')));
  const fr = src('fills-reader.js');
  assert.ok(/activeParlays = liveUsers\.filterByScope\(/.test(fr));
  assert.ok(/\.in\('user_id', SCOPE\.userIds\)/.test(fr));
  assert.ok(/user_id: SCOPE\.writeUserId/.test(fr));
  assert.ok(/row\.user_id = SCOPE\.writeUserId/.test(src('heartbeat.js')));
  for (const f of ['live-runner.js', 'shadow-runner.js', 'unhedged-runner.js', 'fills-reader.js']) {
    assert.ok(/require\('\.\/live-users'\)/.test(src(f)), `${f} requires live-users`);
  }
}

{
  const scope = resolveWorkerScope({ COMBO_WORKER_USER_ID: RANDOM });
  const gate = createLiveUserGate({ env: {}, scope, log: () => {} });
  const mkSb = (cap, fail) => ({ from(t) { const b = { select() { return b; }, in() { return b; },
    then(r, j) { const res = t === 'combo_live_users' ? { data: [{ user_id: RANDOM, can_trade: true, paused: false, max_per_lock_usd: null, max_per_day_usd: null, fund_unlimited: true }], error: null }
      : (fail ? { data: null, error: { message: 'x' } } : { data: cap === undefined ? [] : [{ user_id: RANDOM, autofund_cap_usd: cap }], error: null });
      return Promise.resolve(res).then(r, j); } }; return b; } });
  return (async () => {
    for (const [cap, fail, want] of [[2000, false, true], [null, false, false], [0, false, false], [undefined, false, false], [2000, true, false]]) {
      gate.apply(await gate.query(mkSb(cap, fail)));
      assert.strictEqual(gate.isAllowed(RANDOM), want, `fund_unlimited cap=${cap} fail=${fail}`);
      assert.strictEqual(gate.capsFor(RANDOM), null, 'no fixed per-lock/day caps');
    }
    console.log('live-users fund_unlimited ok');
  })();
}
console.log('live-users tests passed');
