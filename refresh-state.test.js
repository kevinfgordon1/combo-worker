'use strict';
const assert = require('assert');
const {
  querySoftFailed,
  applyRefreshParlays,
  applyRefreshKillByUser,
  applyRefreshFilledByParlay,
} = require('./refresh-state');

function silentLog() {
  const errors = [];
  return {
    errors,
    error(msg) { errors.push(msg); },
  };
}

const ARI_JAC = {
  id: '98d3e355-4a1d-4f60-91ed-a7c1517c60ad',
  label: 'Arizona + Jacksonville',
  active: true,
  fill_american: 350,
  leg_keys: [
    'KXNFLGAME-26SEP13ARILAC-ARI:yes',
    'KXNFLGAME-26SEP13CLEJAC-JAC:yes',
  ],
};

{
  assert.strictEqual(querySoftFailed({ data: null, error: { message: '522' } }), true);
  assert.strictEqual(querySoftFailed({ data: null, error: null }), true);
  assert.strictEqual(querySoftFailed({ data: [], error: null }), false);
  assert.strictEqual(querySoftFailed({ data: [ARI_JAC], error: null }), false);
  assert.strictEqual(querySoftFailed({ data: [ARI_JAC], error: { message: 'partial' } }), true);
}

{
  const prev = [ARI_JAC];
  const log = silentLog();
  const next = applyRefreshParlays(prev, { data: null, error: { message: 'Timeout' } }, log);
  assert.strictEqual(next, prev, 'soft-fail null data must keep the previous parlays array');
  assert.strictEqual(next.length, 1);
  assert.strictEqual(next[0].id, ARI_JAC.id);
  assert.ok(
    /refresh soft-fail parlays: Timeout — keeping 1 lock\(s\): Arizona \+ Jacksonville/.test(log.errors[0]),
    log.errors[0]
  );
}

{
  const prev = [ARI_JAC];
  const log = silentLog();
  const next = applyRefreshParlays(prev, { data: null, error: null }, log);
  assert.strictEqual(next, prev, 'null data without a thrown error still keeps locks');
  assert.ok(/keeping 1 lock\(s\): Arizona \+ Jacksonville/.test(log.errors[0]));
}

{
  const prev = [ARI_JAC];
  const log = silentLog();
  const next = applyRefreshParlays(prev, { data: [], error: null }, log);
  assert.deepStrictEqual(next, []);
  assert.notStrictEqual(next, prev);
  assert.strictEqual(log.errors.length, 0, 'authentic empty must not log a soft-fail');
}

{
  const prev = [ARI_JAC];
  const incoming = [{ id: 'other', label: 'other', active: true }];
  const next = applyRefreshParlays(prev, { data: incoming, error: null }, silentLog());
  assert.strictEqual(next, incoming);
}

{
  const prev = { 'user-1': false };
  const log = silentLog();
  const next = applyRefreshKillByUser(prev, { data: null, error: { message: '502' } }, log);
  assert.strictEqual(next, prev);
  assert.strictEqual(next['user-1'], false, 'settings soft-fail must preserve kill_switch false');
  assert.strictEqual(next['user-1'] !== false, false);
  assert.ok(/refresh soft-fail settings: 502 — keeping kill_switch user-1=false/.test(log.errors[0]));
}

{
  const prev = { 'user-1': false };
  const next = applyRefreshKillByUser(
    prev,
    { data: [{ user_id: 'user-1', kill_switch: true }], error: null },
    silentLog()
  );
  assert.strictEqual(next['user-1'], true);
  assert.notStrictEqual(next, prev);
}

{
  const prev = { 'user-1': false };
  const next = applyRefreshKillByUser(prev, { data: [], error: null }, silentLog());
  assert.deepStrictEqual(next, {});
}

{
  const prev = { [ARI_JAC.id]: 12 };
  const log = silentLog();
  const next = applyRefreshFilledByParlay(
    prev,
    { data: null, error: { message: 'fetch failed' } },
    'count',
    log
  );
  assert.strictEqual(next, prev);
  assert.strictEqual(next[ARI_JAC.id], 12);
  assert.ok(/refresh soft-fail fills: fetch failed — keeping 1 parlay fill/.test(log.errors[0]));
}

{
  const prev = { [ARI_JAC.id]: 12 };
  const next = applyRefreshFilledByParlay(
    prev,
    { data: [{ parlay_id: ARI_JAC.id, count: 3 }, { parlay_id: ARI_JAC.id, count: 2 }], error: null },
    'count',
    silentLog()
  );
  assert.strictEqual(next[ARI_JAC.id], 5);
}

{
  const prev = { p1: 4 };
  const next = applyRefreshFilledByParlay(
    prev,
    { data: [{ parlay_id: 'p1', contracts: 7 }], error: null },
    'contracts',
    silentLog()
  );
  assert.strictEqual(next.p1, 7);
}

console.log('refresh-state.test.js ok');
