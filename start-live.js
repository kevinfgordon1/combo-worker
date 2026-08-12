// Start live quoter + read-only fills reader (Combo Locks Filled tab needs combo_fills).
'use strict';
const { spawn } = require('child_process');

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
