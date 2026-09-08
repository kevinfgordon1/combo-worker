// Start Combo Locks live quoter + read-only fills reader.
// Unhedged RFQs are a separate job (npm run start:unhedged).
'use strict';
const { spawn } = require('child_process');
const { resolveWorkerMode } = require('./worker-mode');

function run(script) {
  const child = spawn(process.execPath, [script], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    console.error(`[start-live] ${script} exited code=${code} signal=${signal || ''}`);
    process.exit(code == null ? 1 : code);
  });
  return child;
}

const mode = resolveWorkerMode(process.env);
if (mode === 'unhedged') {
  console.error('[start-live] WORKER_MODE=unhedged — use npm run start:unhedged');
  process.exit(1);
}

run('live-runner.js');
run('fills-reader.js');
