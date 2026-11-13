// Novig RFQ maker. Shadow by default: listen and log, never quote or confirm.
// NOVIG_DRY_RUN=1 is a hard stop even if NOVIG_RFQ_LIVE is set.
'use strict';
const { spawn } = require('child_process');

const env = { ...process.env, COMBO_ROLE: 'novig' };
if (env.NOVIG_DRY_RUN === undefined) env.NOVIG_DRY_RUN = '1';
if (env.NOVIG_RFQ_LIVE === undefined) env.NOVIG_RFQ_LIVE = '0';
if (env.NOVIG_SHADOW === undefined) env.NOVIG_SHADOW = '1';
// Quote-time reserve. Cap-at-confirm must not apply on this process.
env.COMBO_CAP_AT_CONFIRM = '0';
if (env.COMBO_VENUE_COORD === undefined) env.COMBO_VENUE_COORD = '1';

const quoter = spawn(process.execPath, ['live-runner.js'], { stdio: 'inherit', env, cwd: __dirname });
quoter.on('exit', (code, signal) => {
  console.error(`[start-novig] live-runner.js exited code=${code} signal=${signal || ''}`);
  process.exit(code == null ? 1 : code);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => quoter.kill('SIGINT'));
}
