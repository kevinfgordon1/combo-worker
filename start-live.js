// Start Combo Locks live quoter + read-only fills reader (Filled tab needs combo_fills).
// Does NOT start unhedged-runner — that is a second Railway service (start-unhedged.js).
'use strict';
const { spawn } = require('child_process');
const { workerRole } = require('./unhedged-mode');

if (workerRole(process.env) === 'unhedged') {
  console.error('[start-live] WORKER_ROLE=unhedged — use start-unhedged.js');
  process.exit(1);
}

function run(script) {
  const child = spawn(process.execPath, [script], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    console.error(`[start-live] ${script} exited code=${code} signal=${signal || ''}`);
    process.exit(code == null ? 1 : code);
  });
  return child;
}

run('live-runner.js');
run('fills-reader.js');
