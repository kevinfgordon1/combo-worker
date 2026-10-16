// Start Combo Locks live quoter + read-only fills reader.
// Unhedged RFQs are a separate job (npm run start:unhedged).
'use strict';
const { spawn } = require('child_process');
const { resolveWorkerMode } = require('./worker-mode');
const { readDeskProtectConfig, deskProtectDisabledMessage } = require('./desk-protect');

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

if (mode === 'testers') {
  // Per-tester Combo Locks: one child per approved tester, on THAT tester's
  // keys. Kevin's quoter, fills reader and desk protect never start here.
  run('start-testers.js');
  return;
}

run('live-runner.js');
run('fills-reader.js');

// Kevin's Desk Adverse Protect. No-op unless the aibetbuilder sweep URL and
// shared secret are both set. Never started for the Unhedged job.
const protectCfg = readDeskProtectConfig(process.env);
if (protectCfg.enabled) {
  run('desk-protect.js');
} else {
  console.log(deskProtectDisabledMessage(protectCfg));
}
