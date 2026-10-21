// Isolated Auto-Sniper Railway service (DRY RUN). Own process; crash here cannot affect
// any other service. WORKER_MODE must be "sniper" (or unset).
'use strict';
if (!process.env.WORKER_MODE || !String(process.env.WORKER_MODE).trim()) process.env.WORKER_MODE = 'sniper';
if (String(process.env.WORKER_MODE).trim().toLowerCase() !== 'sniper') {
  console.error(`[start-sniper] WORKER_MODE=${process.env.WORKER_MODE} — this entrypoint only runs the sniper.`);
  process.exit(1);
}
process.on('uncaughtException', (e) => { console.error('[SNIPER] uncaught', e && e.stack); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('[SNIPER] unhandledRejection', e && (e.stack || e.message)); });
require('./sniper/runner').main().catch((e) => { console.error('[SNIPER] fatal', e && e.message); process.exit(1); });
