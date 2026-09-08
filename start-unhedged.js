// Start the Unhedged RFQ shadow worker as its own process.
// Combo Locks (start-live.js) must not spawn this.
'use strict';
const { spawn } = require('child_process');
const { workerRole } = require('./unhedged-mode');

if (workerRole(process.env) === 'locks') {
  console.error('[start-unhedged] WORKER_ROLE=locks — use start-live.js for Combo Locks.');
  process.exit(1);
}

const child = spawn(process.execPath, ['unhedged-runner.js'], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  console.error(`[start-unhedged] unhedged-runner.js exited code=${code} signal=${signal || ''}`);
  process.exit(code == null ? 1 : code);
});
