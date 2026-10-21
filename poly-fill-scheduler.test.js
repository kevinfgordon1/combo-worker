'use strict';
const assert = require('assert');
const { createPolyFillScheduler, isPositionPush } = require('./poly-fill-scheduler');

(async () => {
  let t = 1_000_000;
  const now = () => t;
  const s = createPolyFillScheduler({ now });
  const live = () => ({ lastMessageAt: t - 1000, silentMs: 1000 });
  const dead = () => ({ lastMessageAt: t - 120000, silentMs: 120000 });
  let calls = 0;
  const fn = async () => { calls += 1; return []; };

  // First tick always runs (lastRunAt=0).
  await s.tick(live(), fn); assert.strictEqual(calls, 1);
  // Live socket: nothing for 5 minutes, even across many 20s ticks.
  for (let i = 0; i < 14; i++) { t += 20000; await s.tick(live(), fn); }
  assert.strictEqual(calls, 1, 'no REST while WS live within 5 min');
  t += 20000; await s.tick(live(), fn); // 300s
  assert.strictEqual(calls, 2, 'safety run at 5 min');

  // Socket down: once a minute, not every 20s tick.
  t += 20000; await s.tick(dead(), fn); assert.strictEqual(calls, 2);
  t += 20000; await s.tick(dead(), fn); assert.strictEqual(calls, 2);
  t += 20000; await s.tick(dead(), fn); assert.strictEqual(calls, 3, 'ws-down run at 60s');
  t += 20000; await s.tick(null, fn); assert.strictEqual(calls, 3);

  // Reconnect / position push triggers a prompt run, debounced to 15s.
  s.trigger('ws-reconnect');
  t += 1000; await s.tick(live(), fn); assert.strictEqual(calls, 4, 'prompt run after reconnect');
  s.trigger('position-push'); s.trigger('position-push');
  t += 5000; await s.tick(live(), fn); assert.strictEqual(calls, 4, 'debounced');
  t += 10000; await s.tick(live(), fn); assert.strictEqual(calls, 5, 'one run for a burst of pushes');
  t += 20000; await s.tick(live(), fn); assert.strictEqual(calls, 5, 'trigger consumed');

  // Never two checks at once (prevents double-booking races).
  s.trigger('x'); t += 20000;
  let release; const slow = () => new Promise((r) => { release = r; });
  const p = s.tick(live(), async () => { calls += 1; await slow(); });
  s.trigger('y'); t += 20000;
  await s.tick(live(), fn);
  assert.strictEqual(calls, 6, 'in-flight check blocks a second one');
  release(); await p;

  // socketLive ignores the RFQ stall-recovery window; uses silence only.
  assert.strictEqual(s.socketLive({ lastMessageAt: t, silentMs: 0 }), true);
  assert.strictEqual(s.socketLive({ lastMessageAt: null }), false);
  assert.strictEqual(s.socketLive(null), false);

  // Position push detection.
  assert.strictEqual(isPositionPush({ type: 'other', raw: { positionUpdate: {} } }), true);
  assert.strictEqual(isPositionPush({ type: 'other', raw: { position_update: {} } }), true);
  assert.strictEqual(isPositionPush({ type: 'other', raw: { heartbeat: {} } }), false);
  assert.strictEqual(isPositionPush({ type: 'rfqCreated', raw: { position: {} } }), false);
  console.log('poly-fill-scheduler.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
