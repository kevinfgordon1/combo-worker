// combo-poly Railway service: Polymarket Combo Locks quoting only.
// Never opens a Kalshi WebSocket. Pair with COMBO_POLY_ENABLED=0 on combo-worker.
'use strict';
const { spawn } = require('child_process');

const env = { ...process.env, COMBO_ROLE: 'poly' };
// Dry run: no Polymarket POSTs, no Miss-tape rows, no cross-venue hold rows.
if (/^(1|true|yes|on)$/i.test(String(env.POLY_DRY_RUN || '').trim())) {
  env.POLYMARKET_RFQ_LIVE = '0';
  env.COMBO_VENUE_COORD = '0';
  console.log('[start-poly] POLY_DRY_RUN=1: listen/evaluate/log only, no orders, no DB writes');
}
const child = spawn(process.execPath, ['live-runner.js'], { stdio: 'inherit', env, cwd: __dirname });
child.on('exit', (code, signal) => {
  console.error(`[start-poly] live-runner.js exited code=${code} signal=${signal || ''}`);
  process.exit(code == null ? 1 : code);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill('SIGINT'));
