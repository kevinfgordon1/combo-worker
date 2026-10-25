'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { createLockCoord } = require('./coord');
test('SNIPER_LOCK_COORD=0: no polls, never blocks, never waits', async () => {
  let calls = 0; const supabase = { from() { calls += 1; throw new Error('should not query'); } };
  const c = createLockCoord({ supabase, enabled: false, log: () => {} });
  c.start(); assert.equal(c.blockReason({ legs: [] }), null);
  assert.equal(await c.comboWorkerQuoting('x'), null); assert.equal(calls, 0); c.stop();
});
