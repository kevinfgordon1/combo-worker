'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_LIVE_USER_IDS, parseLiveUserIds, resolveLiveUserIds, createLiveUserGate,
} = require('./live-users');

const KEVIN = '79ae1610-097e-4b46-a622-1e952f18e936';
const KEVIN2 = '968efed8-54db-48a6-808b-194a7a03a4cb';
const OTHER = '42b5ee16-68d5-4b3b-a931-40aa17cd1a47';
const RANDOM = '11111111-2222-4333-8444-555555555555';

// Default (unset / blank / garbage) => Kevin only.
for (const env of [{}, { COMBO_LIVE_USER_IDS: '' }, { COMBO_LIVE_USER_IDS: '   ' }]) {
  const r = resolveLiveUserIds(env);
  assert.strictEqual(r.source, 'default');
  assert.strictEqual(r.invalid, false);
  assert.deepStrictEqual([...r.ids].sort(), [...DEFAULT_LIVE_USER_IDS].sort());
}
assert.ok(DEFAULT_LIVE_USER_IDS.includes(KEVIN));
assert.ok(!DEFAULT_LIVE_USER_IDS.includes(OTHER));
{
  const r = resolveLiveUserIds({ COMBO_LIVE_USER_IDS: 'kev120909@gmail.com, nope' });
  assert.strictEqual(r.source, 'default');
  assert.strictEqual(r.invalid, true);
  assert.ok(r.ids.has(KEVIN));
  assert.ok(!r.ids.has('kev120909@gmail.com'));
}

// Env list replaces the default (comma / space / semicolon, case-insensitive).
assert.deepStrictEqual(parseLiveUserIds(` ${KEVIN.toUpperCase()},${OTHER} ;bad`), [KEVIN, OTHER]);
{
  const r = resolveLiveUserIds({ COMBO_LIVE_USER_IDS: OTHER });
  assert.strictEqual(r.source, 'env');
  assert.deepStrictEqual([...r.ids], [OTHER]);
}

// Gate: filters locks, logs each skipped lock once, keeps soft-fail input as-is.
{
  const logs = [];
  const gate = createLiveUserGate({ env: {}, log: (m) => logs.push(m) });
  assert.strictEqual(gate.isAllowed(KEVIN), true);
  assert.strictEqual(gate.isAllowed(KEVIN.toUpperCase()), true);
  assert.strictEqual(gate.isAllowed(KEVIN2), true);
  assert.strictEqual(gate.isAllowed(OTHER), false);
  assert.strictEqual(gate.isAllowed(null), false);
  assert.strictEqual(gate.isAllowed(''), false);

  const rows = [
    { id: 'k1', user_id: KEVIN, label: 'Kevin lock' },
    { id: 'x1', user_id: RANDOM, label: 'Stranger lock' },
    { id: 'k2', user_id: KEVIN2, label: 'Kevin alt' },
    { id: 'n1', user_id: null, label: 'No owner' },
  ];
  assert.deepStrictEqual(gate.filterParlays(rows).map((r) => r.id), ['k1', 'k2']);
  assert.strictEqual(logs.length, 2);
  assert.ok(/skipping lock x1 .*not in COMBO_LIVE_USER_IDS/.test(logs[0]));
  assert.ok(/skipping lock n1/.test(logs[1]));
  // Every 30s refresh: same rows, no new log lines.
  gate.filterParlays(rows);
  gate.filterParlays(rows);
  assert.strictEqual(logs.length, 2);
  assert.strictEqual(gate.filterParlays(null), null);
  assert.deepStrictEqual(gate.filterParlays([]), []);

  // Kill switch: a stranger's kill_switch=false never reaches the worker.
  const kill = gate.filterKillByUser({ [KEVIN]: false, [RANDOM]: false, [OTHER]: true });
  assert.deepStrictEqual(kill, { [KEVIN]: false });
  assert.strictEqual(gate.filterKillByUser(null), null);
  assert.ok(/2 live user\(s\) from default/.test(gate.summary()));
}

// Env allowlist that excludes Kevin really excludes him.
{
  const gate = createLiveUserGate({ env: { COMBO_LIVE_USER_IDS: RANDOM }, log: () => {} });
  assert.deepStrictEqual(gate.filterParlays([{ id: 'k1', user_id: KEVIN }, { id: 'r', user_id: RANDOM }]).map((r) => r.id), ['r']);
}

// Wiring: every loader that can lead to a quote or a fill attribution is gated.
const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
{
  const live = src('live-runner.js');
  assert.ok(/parlays = liveUsers\.filterParlays\(applyRefreshParlays\(parlays, parlaysQ, refreshLog\)\)/.test(live), 'live refresh gates parlays');
  assert.ok(/killByUser = liveUsers\.filterKillByUser\(applyRefreshKillByUser\(/.test(live), 'live refresh gates kill switch');
  assert.ok(/const killEngagedFor = \(userId\) => !liveUsers\.isAllowed\(userId\) \|\| killByUser\[userId\] !== false;/.test(live), 'kill engaged for non-allowlisted');
  assert.ok(/getParlays: \(\) => parlays/.test(live), 'Polymarket RFQ loop reads the gated Kalshi list');
  assert.ok(/const recent = liveUsers\.filterParlays\(locksQ\.data/.test(live), 'poly fill lock lookup gated');
  const shadow = src('shadow-runner.js');
  assert.ok(/parlays = liveUsers\.filterParlays\(applyRefreshParlays\(/.test(shadow));
  assert.ok(/killByUser = liveUsers\.filterKillByUser\(applyRefreshKillByUser\(/.test(shadow));
  assert.ok(/parlays = liveUsers\.filterParlays\(applyRefreshParlays\(/.test(src('unhedged-runner.js')));
  assert.ok(/activeParlays = liveUsers\.filterParlays\(/.test(src('fills-reader.js')));
  // No other runner reads combo_parlays/combo_settings into a quoting list without the gate.
  for (const f of ['live-runner.js', 'shadow-runner.js', 'unhedged-runner.js', 'fills-reader.js']) {
    assert.ok(/require\('\.\/live-users'\)/.test(src(f)), `${f} requires live-users`);
  }
}

console.log('live-users tests passed');
