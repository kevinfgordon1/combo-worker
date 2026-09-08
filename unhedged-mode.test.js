'use strict';
const assert = require('assert');
const { workerRole, isUnhedgedInProcess, isLocksOnly } = require('./unhedged-mode');

assert.strictEqual(workerRole({}), 'all');
assert.strictEqual(workerRole({ WORKER_ROLE: '' }), 'all');
assert.strictEqual(workerRole({ WORKER_ROLE: 'locks' }), 'locks');
assert.strictEqual(workerRole({ WORKER_ROLE: 'combo-locks' }), 'locks');
assert.strictEqual(workerRole({ WORKER_ROLE: 'unhedged' }), 'unhedged');
assert.strictEqual(workerRole({ WORKER_ROLE: 'ALL' }), 'all');
assert.strictEqual(workerRole({ COMBO_WORKER_ROLE: 'locks' }), 'locks');

// Default: keep unhedged in-process so shipping this PR does not drop the tape
// before the second Railway service exists.
assert.strictEqual(isUnhedgedInProcess({}), true);
assert.strictEqual(isUnhedgedInProcess({ UNHEDGED_IN_PROCESS: '' }), true);
assert.strictEqual(isUnhedgedInProcess({ UNHEDGED_IN_PROCESS: '1' }), true);
assert.strictEqual(isUnhedgedInProcess({ UNHEDGED_IN_PROCESS: 'true' }), true);
assert.strictEqual(isUnhedgedInProcess({ UNHEDGED_IN_PROCESS: '0' }), false);
assert.strictEqual(isUnhedgedInProcess({ UNHEDGED_IN_PROCESS: 'false' }), false);
assert.strictEqual(isUnhedgedInProcess({ UNHEDGED_IN_PROCESS: 'off' }), false);
assert.strictEqual(isLocksOnly({ UNHEDGED_IN_PROCESS: '0' }), true);
assert.strictEqual(isLocksOnly({}), false);

assert.strictEqual(isUnhedgedInProcess({ WORKER_ROLE: 'locks' }), false);
assert.strictEqual(isUnhedgedInProcess({ WORKER_ROLE: 'locks', UNHEDGED_IN_PROCESS: '1' }), false);
assert.strictEqual(isUnhedgedInProcess({ WORKER_ROLE: 'unhedged' }), true);
assert.strictEqual(isUnhedgedInProcess({ WORKER_ROLE: 'unhedged', UNHEDGED_IN_PROCESS: '0' }), true);

console.log('unhedged-mode.test.js ok');
