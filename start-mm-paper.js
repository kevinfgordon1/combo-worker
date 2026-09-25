// Paper market-making entry. Does nothing unless MM_PAPER=1.
// Not started by npm start / start-live.js / start-unhedged.js.
'use strict';

const { paperEnabled } = require('./mm-paper-config');

if (!paperEnabled(process.env)) {
  console.log('[MM-PAPER] off (MM_PAPER is not 1). No orders. Combo Locks is unchanged.');
  process.exit(0);
}

const { main } = require('./mm-paper-runner');

main(process.env).catch((err) => {
  console.error('[MM-PAPER] fatal', err && err.stack ? err.stack : err);
  process.exit(1);
});
