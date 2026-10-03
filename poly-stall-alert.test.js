'use strict';
const assert = require('assert');
const EventEmitter = require('events');
const { createPolyStallAlerts, fmtCause } = require('./poly-stall-alert');
const { createPolymarketRfqWs, DEFAULT_WS_STALL_MS } = require('./polymarket-client');

const SEED_B64 = Buffer.alloc(32, 7).toString('base64');

function fakeAlerts() {
  const raised = []; const resolved = [];
  return { raised, resolved,
    async raise(r) { raised.push(r); return true; },
    async resolve(k) { resolved.push(k); return true; } };
}

async function testPolicy() {
  let t = 10_000_000;
  const a = fakeAlerts();
  const s = createPolyStallAlerts({ appAlerts: a, now: () => t });
  const info = { silentMs: 31000, stalls: 1, reconnects: 0, lastMessageType: 'rfqCreated', messagesThisConn: 4000,
    ping: { state: 'pong-ok (socket alive, no data)' } };

  // 1: self-healed stall = info row, resolved on recovery, no escalation
  await s.onStall(info);
  assert.strictEqual(a.raised.length, 1);
  assert.strictEqual(a.raised[0].severity, 'info');
  assert.strictEqual(a.raised[0].dedupeKey, 'poly_ws_stall');
  assert.ok(/last message: rfqCreated/.test(a.raised[0].body) && /pong-ok/.test(a.raised[0].body));
  assert.strictEqual(a.raised[0].meta.last_message_type, 'rfqCreated');
  t += 2000;
  await s.onRecovered();
  assert.deepStrictEqual(a.resolved[0], ['poly_ws_stall']);
  assert.strictEqual(a.raised.length, 1, 'single healed stall never escalates');
  await s.tick();
  t += 10 * 60000; await s.tick();
  assert.strictEqual(a.raised.length, 1);

  // 2,3 within the hour -> 3rd escalates to warn
  await s.onStall(info); await s.onRecovered(); t += 60000;
  assert.strictEqual(a.raised.filter((r) => r.severity === 'warn').length, 0, '2 stalls/hour is still info');
  await s.onStall(info);
  const warn = a.raised.filter((r) => r.severity === 'warn');
  assert.strictEqual(warn.length, 1);
  assert.strictEqual(warn[0].kind, 'poly_ws_stall_escalated');
  assert.strictEqual(warn[0].dedupeKey, 'poly_ws_stall_escalated');
  assert.ok(/3 stalls in the last hour/.test(warn[0].body));
  // recovered but still 3 in the hour: warn stays
  await s.onRecovered();
  assert.ok(!a.resolved.some((k) => k[0] === 'poly_ws_stall_escalated'));
  // hour passes -> escalation clears
  t += 61 * 60000; await s.tick();
  assert.ok(a.resolved.some((k) => k[0] === 'poly_ws_stall_escalated'), 'escalation clears when calm');
}

async function testUnrecovered() {
  let t = 5_000_000;
  const a = fakeAlerts();
  const s = createPolyStallAlerts({ appAlerts: a, now: () => t, unrecoveredMs: 120000 });
  await s.onStall({ silentMs: 30000 });
  t += 60000; await s.tick();
  assert.strictEqual(a.raised.filter((r) => r.severity === 'warn').length, 0);
  t += 61000; await s.tick();
  const warn = a.raised.filter((r) => r.severity === 'warn');
  assert.strictEqual(warn.length, 1);
  assert.ok(/not recovered/.test(warn[0].body));
  await s.tick();
  assert.strictEqual(a.raised.filter((r) => r.severity === 'warn').length, 1, 'no duplicate escalation');
  await s.onRecovered();
  assert.ok(a.resolved.some((k) => k[0] === 'poly_ws_stall_escalated'), 'recovered + calm clears the warn');
}

class FakeSock extends EventEmitter {
  constructor() { super(); this.pings = 0; }
  send() {} ping() { this.pings += 1; }
  close() { this.emit('close', 1000); }
  terminate() { setImmediate(() => this.emit('close', 1006)); }
}

function testClientDiagnostics() {
  assert.strictEqual(DEFAULT_WS_STALL_MS, 30000, 'default stall window is 30s');
  let t = 1_000_000;
  const socks = []; const stalls = [];
  const ws = createPolymarketRfqWs({
    keyId: 'k', secretKey: SEED_B64, stallMs: 30000, stallCheckMs: 3_600_000, now: () => t,
    WebSocketImpl: function F() { const s = new FakeSock(); socks.push(s); return s; },
    onStall: (i) => stalls.push(i),
  });
  ws.start();
  socks[0].emit('open');
  t += 1000;
  socks[0].emit('message', Buffer.from(JSON.stringify({ rfqEvent: { rfqCreated: { rfq: { id: 'x' } } } })));
  socks[0].emit('message', Buffer.from(JSON.stringify({ subscribed: { requestId: 'r' } })));
  t += 29000; ws.checkStall();
  assert.strictEqual(stalls.length, 0, '29s silent is healthy');
  t += 2000; ws.checkStall();
  assert.strictEqual(stalls.length, 1, '31s silent stalls');
  const i = stalls[0];
  assert.strictEqual(i.lastMessageType, 'other:subscribed');
  assert.strictEqual(i.messagesThisConn, 2);
  assert.strictEqual(i.ping.sent, 0);
  assert.strictEqual(i.ping.state, 'no-pings-sent');
  assert.ok(i.silentMs >= 30000);
  ws.stop();

  // ping/pong state
  const socks2 = []; const st2 = [];
  const ws2 = createPolymarketRfqWs({
    keyId: 'k', secretKey: SEED_B64, stallMs: 30000, stallCheckMs: 3_600_000, now: () => t,
    WebSocketImpl: function F() { const s = new FakeSock(); socks2.push(s); return s; },
    onStall: (x) => st2.push(x),
  });
  const realSI = global.setInterval;
  const timers = [];
  global.setInterval = (fn) => { timers.push(fn); return { unref() {} }; };
  ws2.start(); socks2[0].emit('open');
  global.setInterval = realSI;
  const pingFn = timers[0];
  t += 10000; pingFn(); socks2[0].emit('pong');
  t += 10000; pingFn(); socks2[0].emit('pong');
  t += 10000; pingFn();
  ws2.checkStall();
  assert.strictEqual(st2.length, 1);
  assert.strictEqual(st2[0].lastMessageType, null);
  assert.strictEqual(st2[0].ping.sent, 3);
  assert.strictEqual(st2[0].ping.pongs, 2);
  assert.strictEqual(st2[0].ping.unansweredPings, 1);
  assert.ok(/pong-ok/.test(st2[0].ping.state));
  assert.ok(/ping\/pong: pong-ok/.test(fmtCause(st2[0])));
  ws2.stop();
}

(async () => {
  await testPolicy();
  await testUnrecovered();
  testClientDiagnostics();
  console.log('poly-stall-alert tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
