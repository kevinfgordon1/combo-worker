// prophetx-worker Railway service: ProphetX SANDBOX parlay RFQ quoter only.
// Separate process and service from combo-worker. Loads no Kalshi or
// Polymarket trading keys; px/guard.js refuses to start if any are present or
// if any ProphetX host is not sandbox.prophetx.dev. See docs/PROPHETX-WORKER.md.
'use strict';
const { createRunner } = require('./px/runner');

let runner;
try {
  runner = createRunner();
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
runner.start().catch((e) => { console.error(`[PX] start failed: ${e.stack || e.message}`); process.exit(1); });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await Promise.race([runner.stop(), new Promise((r) => setTimeout(r, 3000))]); process.exit(0); });
}
