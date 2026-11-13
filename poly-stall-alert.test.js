'use strict';
const assert = require('assert');
const EventEmitter = require('events');
const { createPolyStallAlerts, fmtCause, restNote } = require('./poly-stall-alert');
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
  constructor() { super(); this.pings = 0; this.sent = []; }
  send(m) { this.sent.push(m); } ping() { this.pings += 1; }
  close(code, reason) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = Buffer.isBuffer(reason) ? reason.toString('utf8') : (reason || '');
    this.emit('close', code == null ? 1000 : code, reason);
  }
  terminate() { this.terminated = true; setImmediate(() => this.emit('close', 1006)); }
}

function testClientDiagnostics() {
  assert.strictEqual(DEFAULT_WS_STALL_MS, 5000, 'default stall window is 5s');
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

async function testRestNote() {
  assert.ok(/REST polling covers part of intake/.test(restNote({})));
  assert.ok(/REST also failing/.test(restNote({ restFailing: true })));
  const a = fakeAlerts(); let t = 1e7;
  const s = createPolyStallAlerts({ appAlerts: a, now: () => t });
  for (let k = 0; k < 3; k++) await s.onStall({ silentMs: 35000, restFailing: true });
  assert.ok(a.raised.every((r) => /REST also failing/.test(r.body) && !/covering/.test(r.body)));
}

function testOutageNoFalseRecovery() {
  let t = 2_000_000;
  const socks = []; const rec = []; const statuses = [];
  const realST = global.setTimeout; const fns = [];
  global.setTimeout = (fn) => { fns.push(fn); return 0; };
  const ws = createPolymarketRfqWs({
    keyId: 'k', secretKey: SEED_B64, stallMs: 30000, stallCheckMs: 3_600_000, now: () => t,
    WebSocketImpl: function F() { const s = new FakeSock(); s.terminate = () => s.emit('close', 1006); socks.push(s); return s; },
    onRecovered: (i) => rec.push(i), onStatus: (s, i) => statuses.push([s, i]),
  });
  ws.start();
  const errMsg = Buffer.from(JSON.stringify({ error: { message: 'unavailable' } }));
  // Polymarket closing the socket (not our watchdog) still backs off 1s → 30s.
  for (let k = 0; k < 4; k++) {
    const s = socks[socks.length - 1];
    s.emit('open'); s.emit('message', errMsg);
    s.emit('close', 1001, Buffer.from('going away'));
    fns.shift()();
  }
  global.setTimeout = realST;
  assert.strictEqual(rec.length, 0, 'error replies must not count as recovered');
  const w = statuses.filter(([s]) => s === 'reconnecting').map(([, i]) => i.wait);
  assert.deepStrictEqual(w, [1000, 2000, 4000, 8000], 'backoff grows when Polymarket closes the socket');
  const closed = statuses.filter(([s]) => s === 'closed');
  assert.strictEqual(closed[0][1].code, 1001);
  assert.strictEqual(closed[0][1].reason, 'going away');
  ws.stop();
}

function testRealDataRecoversAndResetsBackoff() {
  let t = 3_000_000;
  const socks = []; const rec = []; const statuses = [];
  const realST = global.setTimeout; const fns = [];
  global.setTimeout = (fn) => { fns.push(fn); return 0; };
  const ws = createPolymarketRfqWs({
    keyId: 'k', secretKey: SEED_B64, stallMs: 30000, stallCheckMs: 3_600_000, now: () => t,
    WebSocketImpl: function F() { const s = new FakeSock(); socks.push(s); return s; },
    onRecovered: (i) => rec.push(i), onStatus: (s, i) => statuses.push([s, i]),
  });
  ws.start();
  socks[0].emit('open');
  t += 31000; ws.checkStall(); // immediate replacement, wait 0
  socks[1].emit('open');
  t += 31000; ws.checkStall();
  socks[2].emit('open');
  socks[2].emit('message', Buffer.from(JSON.stringify({ rfqEvent: { rfqCreated: { rfq: { id: 'y' } } } })));
  assert.strictEqual(rec.length, 1, 'real RFQ recovers');
  // After real data the remote-close backoff is back to 1s, not the grown value.
  socks[2].emit('close', 1006, Buffer.from('bye'));
  global.setTimeout = realST;
  const w = statuses.filter(([s]) => s === 'reconnecting').map(([, i]) => i.wait);
  assert.deepStrictEqual(w, [0, 0, 1000], 'watchdog reconnects immediately; backoff resets only after real data');
  assert.strictEqual(fns.length, 1, 'only the remote close scheduled a delayed reconnect');
  ws.stop();
}

function testWatchdogMakeBeforeBreak() {
  let t = 4_000_000;
  const socks = []; const events = []; const statuses = [];
  const ws = createPolymarketRfqWs({
    keyId: 'k', secretKey: SEED_B64, stallMs: 5000, stallCheckMs: 3_600_000, now: () => t,
    WebSocketImpl: function F() {
      const s = new FakeSock();
      // Hold the close event so an in-flight message on the old socket can still arrive.
      s.close = (code, reason) => {
        s.closed = true;
        s.closeCode = code;
        s.closeReason = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || '');
      };
      socks.push(s);
      return s;
    },
    onEvent: (e) => events.push(e),
    onStatus: (s, i) => statuses.push([s, i]),
  });
  ws.start();
  socks[0].emit('open');
  const rfq = (id) => Buffer.from(JSON.stringify({ rfqEvent: { rfqCreated: { rfq: { id } } } }));
  socks[0].emit('message', rfq('a'));
  t += 5000;
  ws.checkStall();
  assert.strictEqual(socks.length, 2, 'replacement socket is opened immediately');
  assert.ok(!socks[0].closed, 'stalled socket stays open until the new one subscribes');
  const waits = statuses.filter(([s]) => s === 'reconnecting').map(([, i]) => i.wait);
  assert.deepStrictEqual(waits, [0], 'watchdog reconnect does not wait the 1s backoff');
  socks[1].emit('open');
  assert.ok(socks[0].closed, 'old socket is closed only after the new one is open');
  assert.strictEqual(socks[0].closeCode, 4000);
  assert.strictEqual(socks[0].closeReason, 'stall-replaced');
  assert.ok(socks[1].sent.some((m) => String(m).includes('SUBSCRIPTION_TYPE_RFQ')), 'subscribed before close');
  socks[0].emit('message', rfq('b'));
  socks[1].emit('message', rfq('b'));
  const ids = events.filter((e) => e.type === 'rfqCreated').map((e) => e.rfq.id);
  assert.deepStrictEqual(ids, ['a', 'b', 'b'], 'both sockets deliver during the overlap; dedupe is by RFQ id upstream');
  socks[0].emit('close', 4000, Buffer.from('stall-replaced'));
  assert.strictEqual(socks.length, 2, 'closing the replaced socket does not open another');
  ws.stop();
}

(async () => {
  await testRestNote();
  testRealDataRecoversAndResetsBackoff();
  testOutageNoFalseRecovery();
  testWatchdogMakeBeforeBreak();
  await testPolicy();
  await testUnrecovered();
  testClientDiagnostics();
  console.log('poly-stall-alert tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
