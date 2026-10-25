'use strict';
const assert = require('node:assert/strict');
const { createDbBreaker } = require('./db-breaker');

(async () => {
  let t = 0; const logs = [];
  const b = createDbBreaker({ now: () => t, random: () => 0, minErrors: 5, log: (m) => logs.push(m) });
  let status = 503; let calls = 0;
  const f = b.wrapFetch(async () => { calls += 1; return { status }; });
  for (let i = 0; i < 4; i++) await f('x');
  assert.equal(b.isOpen(), false);
  await f('x');
  assert.equal(b.isOpen(), true, 'opens after 5 failures');
  await assert.rejects(f('x'), /breaker_open/); assert.equal(calls, 5, 'short-circuits without network');
  t += 30001; assert.equal(b.isOpen(), false);
  status = 200; await f('x'); assert.equal(b.isOpen(), false);
  await f('x'); assert.equal(calls, 7, 'closed after ok probe');
  // healthy traffic with a few errors stays closed (ratio)
  const b2 = createDbBreaker({ now: () => t, minErrors: 5, log: () => {} });
  let n = 0; const g = b2.wrapFetch(async () => ({ status: (n++ % 10 === 0) ? 500 : 200 }));
  for (let i = 0; i < 200; i++) await g('x');
  assert.equal(b2.isOpen(), false);
  // network errors count; disabled switch never opens
  const b3 = createDbBreaker({ now: () => t, minErrors: 3, log: () => {} });
  const h = b3.wrapFetch(async () => { throw new Error('fetch failed'); });
  for (let i = 0; i < 3; i++) await assert.rejects(h('x'));
  assert.equal(b3.isOpen(), true);
  const off = createDbBreaker({ enabled: false, minErrors: 1, log: () => {} });
  const o = off.wrapFetch(async () => ({ status: 500 })); for (let i = 0; i < 5; i++) await o('x');
  assert.equal(off.isOpen(), false);
  console.log('db-breaker ok');
})().catch((e) => { console.error(e); process.exit(1); });
