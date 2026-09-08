// Unhedged RFQ Railway job — paper/shadow only. Own process, own WS,
// own /markets cache and fill tracker. Does not start Combo Locks or fills-reader.
'use strict';
const { resolveWorkerMode, WORKER_MODE_UNHEDGED } = require('./worker-mode');

if (!process.env.WORKER_MODE || !String(process.env.WORKER_MODE).trim()) {
  process.env.WORKER_MODE = WORKER_MODE_UNHEDGED;
}

const mode = resolveWorkerMode(process.env);
if (mode !== WORKER_MODE_UNHEDGED && mode !== 'all') {
  console.error(
    `[start-unhedged] WORKER_MODE=${mode} — this entrypoint is the Unhedged job. ` +
    `Use npm start / start-live.js for Combo Locks.`
  );
  process.exit(1);
}

require('./unhedged-runner');
