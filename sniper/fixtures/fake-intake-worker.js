'use strict';
// Test double for sniper/intake-worker.js: same message protocol, no Kalshi socket.
const { parentPort } = require('worker_threads');
let open = [];
parentPort.on('message', (m) => {
  if (m.t === 'open') open = m.ids;
  if (m.t === 'open+') open = open.concat(m.ids);
  if (m.t === 'throughput') parentPort.postMessage({ t: 'throughput', id: m.id, value: { recv: 7, open } });
});
parentPort.postMessage({ t: 'ready' });
parentPort.postMessage({ t: 'rfq', rfq: { rfqId: 'R1', legKeys: ['A:yes', 'B:yes'], isCombo: true, workerAt: Date.now() } });
parentPort.postMessage({ t: 'deleted', evt: { rfqId: 'R1' } });
parentPort.postMessage({ t: 'accepted', evt: { quoteId: 'Q1' } });
parentPort.postMessage({ t: 'executed', evt: { quoteId: 'Q1' } });
parentPort.postMessage({ t: 'skips', skips: { stale_at_intake: 3 } });
