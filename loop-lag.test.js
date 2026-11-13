'use strict';
const assert = require('assert');
const { enterTask, startLoopLagMonitor, currentTask } = require('./loop-lag');

(async () => {
  const leave = enterTask('labeled-task');
  assert.strictEqual(currentTask().label, 'labeled-task');
  assert.ok(currentTask().stack.includes('loop-lag.test.js'));
  leave();
  assert.strictEqual(currentTask(), null);

  const logs = [];
  const mon = startLoopLagMonitor({ thresholdMs: 40, intervalMs: 20, log: (m) => logs.push(m) });
  const end = enterTask('fill-activity-match');
  const until = Date.now() + 80;
  while (Date.now() < until) { /* block the loop on purpose */ }
  end();
  await new Promise((r) => setTimeout(r, 60));
  mon.stop();
  assert.ok(logs.some((m) => /block \d+ms task=fill-activity-match/.test(m)), `expected a labeled block, got ${logs.join(' | ')}`);
  console.log('loop-lag.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
