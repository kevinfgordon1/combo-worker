// Polymarket US HTTP relay. Own Railway service. Does not set WORKER_MODE
// and does not start Combo Locks, Unhedged, odds-relay, or mm-paper.
'use strict';

const { createPolyRelay, lookupEgressIp } = require('./poly-relay');

async function main() {
  let egressIp = null;
  try {
    egressIp = await lookupEgressIp();
  } catch (_) {
    egressIp = null;
  }
  const relay = createPolyRelay({ egressIp });
  const port = Number(process.env.PORT) || 8790;
  const addr = await relay.listen(port, '0.0.0.0');

  if (!process.env.POLY_RELAY_SECRET || !String(process.env.POLY_RELAY_SECRET).trim()) {
    console.log('[poly-relay] POLY_RELAY_SECRET is not set; proxy requests will be rejected');
  }
  console.log(
    `[poly-relay] listening on ${addr && addr.port} egress=${egressIp || 'unknown'} rps=${relay.rps} burst=${relay.burst}`
  );

  function shutdown() {
    relay.close().then(() => process.exit(0)).catch(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(() => {
  console.error('[poly-relay] fatal start failed');
  process.exit(1);
});
