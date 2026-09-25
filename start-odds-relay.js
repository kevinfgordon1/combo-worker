// Odds-board relay. Own process. Does not set WORKER_MODE and does not
// start Combo Locks, Unhedged, or the Kalshi communications socket.
'use strict';

const { startOddsRelay } = require('./odds-relay');

const port = Number(process.env.PORT) || 8787;
const relay = startOddsRelay();

relay.listen(port).then((addr) => {
  console.log(`[odds-relay] listening on ${addr && addr.port}`);
}).catch((err) => {
  console.error('[odds-relay] listen failed', err && err.message);
  process.exit(1);
});

function shutdown() {
  relay.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
