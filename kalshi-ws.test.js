'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { generateKeyPairSync } = require('crypto');
const { createKalshiWs, DEFAULT_STALL_MS, PING_MS, INITIAL_BACKOFF_MS, readStallMs, deadChannelReason, shouldOpenQuoteWatcherWs } = require('./kalshi-ws');
const { applyServerDate, resetClockOffset, signedNow, authHeaders } = require('./kalshi-auth');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });

class FakeWs extends EventEmitter {
  static instances = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts || {};
    this.readyState = FakeWs.CONNECTING;
    this.sent = [];
    this.terminated = false;
    FakeWs.instances.push(this);
    queueMicrotask(() => {
      if (this.terminated || this.readyState === FakeWs.CLOSED) return;
      if (FakeWs.rejectHandshake) {
        const body = FakeWs.rejectBody || '{"error":"header_timestamp_expired"}';
        const req = { destroy() { req.destroyed = true; } };
        const res = new EventEmitter();
        res.statusCode = FakeWs.rejectStatus || 401;
        res.headers = { date: FakeWs.rejectDate || new Date().toUTCString() };
        queueMicrotask(() => {
          this.emit('unexpected-response', req, res);
          queueMicrotask(() => {
            res.emit('data', Buffer.from(body));
            res.emit('end');
          });
        });
        return;
      }
      this.readyState = FakeWs.OPEN;
      this.emit('open');
    });
  }

  send(payload) { this.sent.push(payload); }
  ping() {
    this.pinged = true;
    this.pingCount = (this.pingCount || 0) + 1;
  }
  close() {
    this.readyState = FakeWs.CLOSED;
    this.emit('close', 1000);
  }
  terminate() {
    this.terminated = true;
    this.readyState = FakeWs.CLOSED;
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startClient(extra = {}) {
  const statuses = [];
  const client = createKalshiWs({
    keyId: 'test-key',
    pem: PEM,
    WebSocket: FakeWs,
    stallMs: extra.stallMs != null ? extra.stallMs : 60_000,
    onStatus: (s, i) => statuses.push({ s, i }),
    onRfqCreated: extra.onRfqCreated,
    onQuoteExecuted: extra.onQuoteExecuted,
  });
  client.start();
  return { client, statuses };
}

{
  assert.strictEqual(DEFAULT_STALL_MS, 20_000);
  assert.strictEqual(PING_MS, 10_000);
  assert.strictEqual(INITIAL_BACKOFF_MS, 1000);
  assert.strictEqual(readStallMs(undefined, {}), 20_000);
  assert.strictEqual(readStallMs(15_000, {}), 15_000);
  assert.strictEqual(readStallMs(undefined, { KALSHI_WS_STALL_MS: '8000' }), 8000);
  assert.strictEqual(deadChannelReason({ type: 'unsubscribed' }), 'unsubscribed');
  assert.strictEqual(deadChannelReason({ type: 'unsubscribed', msg: { channel: 'communications' } }), 'unsubscribed');
  assert.strictEqual(deadChannelReason({ type: 'error', msg: { code: 10, msg: 'Channel error' } }), 'channel_error');
  assert.strictEqual(deadChannelReason({ type: 'error', msg: { code: 25, msg: 'Subscription buffer overflow' } }), 'channel_error');
  assert.strictEqual(deadChannelReason({ type: 'error', msg: { code: 9, msg: 'Authentication required' } }), 'channel_error');
  assert.strictEqual(deadChannelReason({ type: 'error', msg: { message: 'unsubscribed' } }), 'channel_error');
  assert.strictEqual(deadChannelReason({ type: 'error', msg: { code: 1, msg: 'Unable to process message' } }), null);
  assert.strictEqual(deadChannelReason({ type: 'error', msg: { code: 6, msg: 'Already subscribed' } }), null);
  assert.strictEqual(deadChannelReason({ type: 'subscribed', msg: { channel: 'communications' } }), null);
  assert.strictEqual(deadChannelReason({ type: 'rfq_created' }), null);
  assert.strictEqual(shouldOpenQuoteWatcherWs({}), true);
  assert.strictEqual(shouldOpenQuoteWatcherWs({ QUOTE_WATCHER_WS: '0' }), false);
  assert.strictEqual(shouldOpenQuoteWatcherWs({ QUOTE_WATCHER_WS: 'false' }), false);
  assert.strictEqual(shouldOpenQuoteWatcherWs({ QUOTE_WATCHER_WS: 'off' }), false);
  assert.strictEqual(shouldOpenQuoteWatcherWs({ KALSHI_WS_OWNER: 'combo' }), false);
  assert.strictEqual(shouldOpenQuoteWatcherWs({ KALSHI_WS_OWNER: 'combo-worker' }), false);
  assert.strictEqual(shouldOpenQuoteWatcherWs({ KALSHI_WS_OWNER: 'quote-watcher' }), true);
  assert.strictEqual(shouldOpenQuoteWatcherWs({ KALSHI_WS_OWNER: 'watcher' }), true);
  assert.strictEqual(shouldOpenQuoteWatcherWs({ KALSHI_WS_OWNER: 'quote-watcher', QUOTE_WATCHER_WS: '0' }), false);
}

{
  resetClockOffset();
  const past = new Date(Date.now() - 12_000).toUTCString();
  const offset = applyServerDate(past);
  assert.ok(offset < -8000, `expected negative offset, got ${offset}`);
  const ts = Number(authHeaders({
    keyId: 'k', pem: PEM, method: 'GET', signPath: '/trade-api/ws/v2',
  })['KALSHI-ACCESS-TIMESTAMP']);
  assert.ok(Math.abs(ts - signedNow()) < 50);
  resetClockOffset();
}

async function runAsync() {
  FakeWs.instances = [];
  FakeWs.rejectHandshake = false;

  {
    const { client, statuses } = startClient();
    await wait(20);
    assert.ok(FakeWs.instances.length >= 1);
    const first = FakeWs.instances[0];
    assert.ok(first.sent.some((s) => String(s).includes('communications')));
    assert.ok(statuses.some((x) => x.s === 'subscribed'));
    first.emit('message', JSON.stringify({
      type: 'rfq_created',
      msg: { id: 'rfq-1', contracts_fp: '10.00', mve_collection_ticker: 'KXMVE-X' },
    }));
    const h = client.health();
    assert.ok(h.lastCommAt > 0);
    client.stop();
  }

  {
    FakeWs.instances = [];
    FakeWs.rejectHandshake = true;
    FakeWs.rejectStatus = 401;
    FakeWs.rejectBody = '{"error":{"code":"header_timestamp_expired"}}';
    const { client, statuses } = startClient();
    await wait(40);
    assert.ok(statuses.some((x) => x.s === 'error' && /handshake 401/.test(String(x.i && x.i.message))));
    assert.ok(statuses.some((x) => x.s === 'reconnecting' && x.i && x.i.reason === 'auth_timestamp'));
    FakeWs.rejectHandshake = false;
    await wait(300);
    assert.ok(FakeWs.instances.length >= 2, `expected reconnect instance, got ${FakeWs.instances.length}`);
    assert.ok(statuses.some((x) => x.s === 'subscribed'), 'reconnect after 401 must subscribe');
    client.stop();
  }

  {
    FakeWs.instances = [];
    FakeWs.rejectHandshake = false;
    const { client, statuses } = startClient({ stallMs: 40 });
    await wait(20);
    const n0 = FakeWs.instances.length;
    const first = FakeWs.instances[0];
    assert.ok(first.pinged, 'open must send an immediate keepalive ping');
    await wait(80);
    assert.ok(statuses.some((x) => x.s === 'stalled'), 'silence with no pong must trip stall watchdog');
    assert.ok(statuses.some((x) => x.s === 'reconnecting' && x.i && x.i.reason === 'stall'));
    await wait(1100);
    assert.ok(FakeWs.instances.length > n0, 'stall must open a new socket');
    client.stop();
  }

  {
    FakeWs.instances = [];
    const { client, statuses } = startClient({ stallMs: 40 });
    await wait(15);
    const sock = FakeWs.instances[0];
    for (let i = 0; i < 4; i++) {
      sock.emit('message', JSON.stringify({
        type: 'rfq_created',
        msg: { id: `rfq-${i}`, contracts_fp: '5.00', mve_collection_ticker: 'KXMVE-X' },
      }));
      await wait(20);
    }
    assert.ok(!statuses.some((x) => x.s === 'stalled'), 'live communications must not stall');
    client.stop();
  }

  {
    FakeWs.instances = [];
    const { client, statuses } = startClient({ stallMs: 50 });
    await wait(15);
    const sock = FakeWs.instances[0];
    for (let i = 0; i < 8; i++) {
      sock.emit('pong');
      await wait(20);
    }
    assert.ok(!statuses.some((x) => x.s === 'stalled'), 'quiet book with pongs must not stall');
    assert.ok(!statuses.some((x) => x.s === 'reconnecting' && x.i && x.i.reason === 'stall'));
    assert.ok(!statuses.some((x) => x.s === 'reconnecting'), 'pong-only quiet book must not reconnect');
    assert.strictEqual(client.health().backoff, 1000, 'pong liveness must reset backoff');
    client.stop();
  }

  {
    FakeWs.instances = [];
    const { client, statuses } = startClient();
    await wait(15);
    const n0 = FakeWs.instances.length;
    const sock = FakeWs.instances[0];
    sock.emit('message', JSON.stringify({
      type: 'unsubscribed',
      msg: { channel: 'communications' },
    }));
    assert.ok(statuses.some((x) => x.s === 'unsubscribed'), 'unsubscribed must be a first-class status');
    assert.ok(
      statuses.some((x) => x.s === 'reconnecting' && x.i && x.i.reason === 'unsubscribed'),
      'unsubscribed must schedule a reconnect'
    );
    assert.ok(sock.terminated, 'unsubscribed must drop the pong-alive socket');
    await wait(1100);
    assert.ok(FakeWs.instances.length > n0, 'unsubscribed must open a new socket');
    assert.ok(statuses.some((x) => x.s === 'subscribed'), 'reconnect after unsubscribed must resubscribe');
    client.stop();
  }

  {
    FakeWs.instances = [];
    const { client, statuses } = startClient();
    await wait(15);
    const n0 = FakeWs.instances.length;
    FakeWs.instances[0].emit('message', JSON.stringify({
      type: 'error',
      msg: { code: 10, msg: 'Channel error' },
    }));
    assert.ok(statuses.some((x) => x.s === 'error' && x.i && x.i.code === 10));
    assert.ok(
      statuses.some((x) => x.s === 'reconnecting' && x.i && x.i.reason === 'channel_error'),
      'channel-dead error must schedule a reconnect'
    );
    await wait(1100);
    assert.ok(FakeWs.instances.length > n0, 'channel error must open a new socket');
    client.stop();
  }

  {
    FakeWs.instances = [];
    const { client, statuses } = startClient();
    await wait(15);
    const n0 = FakeWs.instances.length;
    FakeWs.instances[0].emit('message', JSON.stringify({
      type: 'error',
      msg: { code: 1, msg: 'Unable to process message' },
    }));
    assert.ok(statuses.some((x) => x.s === 'error'));
    assert.ok(!statuses.some((x) => x.s === 'reconnecting'), 'benign command error must not reconnect');
    await wait(40);
    assert.strictEqual(FakeWs.instances.length, n0, 'benign error must keep the same socket');
    client.stop();
  }

  {
    FakeWs.instances = [];
    const { client, statuses } = startClient({ stallMs: 50 });
    await wait(15);
    const sock = FakeWs.instances[0];
    sock.emit('message', JSON.stringify({
      type: 'subscribed',
      id: 1,
      msg: { channel: 'communications' },
    }));
    for (let i = 0; i < 6; i++) {
      sock.emit('ping');
      await wait(20);
    }
    assert.ok(!statuses.some((x) => x.s === 'stalled'), 'subscribe ack + inbound ping are liveness');
    client.stop();
  }

  {
    FakeWs.instances = [];
    const { client, statuses } = startClient({ stallMs: 40 });
    await wait(100);
    const r1 = statuses.filter((x) => x.s === 'reconnecting' && x.i && x.i.reason === 'stall');
    assert.ok(r1.length >= 1, 'first stall must schedule a reconnect');
    assert.strictEqual(r1[0].i.wait, 1000, 'first stall reconnect waits initial backoff');
    await wait(1100);
    await wait(80);
    const r2 = statuses.filter((x) => x.s === 'reconnecting' && x.i && x.i.reason === 'stall');
    assert.ok(r2.length >= 2, 'second stall after silent open must reconnect again');
    assert.ok(r2[1].i.wait >= 2000, `stall backoff must grow across reconnects, got wait=${r2[1].i.wait}`);
    assert.ok(
      !r2.slice(1).every((x) => x.i.wait === 1000),
      'open must not reset backoff to 1s during a stall storm'
    );
    client.stop();
  }

  {
    FakeWs.instances = [];
    const { client, statuses } = startClient();
    await wait(15);
    const sock = FakeWs.instances[0];
    sock.emit('close', 1006);
    sock.emit('close', 1006);
    const reconnects = statuses.filter((x) => x.s === 'reconnecting');
    assert.strictEqual(reconnects.length, 1, 'close storms must be single-flight');
    client.stop();
  }

  {
    FakeWs.instances = [];
    const created = [];
    const captured = [];
    const client = createKalshiWs({
      keyId: 'test-key',
      pem: PEM,
      WebSocket: FakeWs,
      stallMs: 60_000,
      shouldDeferCreated: (raw) => raw.includes('DEFER-ME'),
      captureRfq: (env) => captured.push(env && env.msg && env.msg.id),
      onRfqCreated: (rfq) => created.push(rfq.rfqId),
    });
    client.start();
    await wait(15);
    const sock = FakeWs.instances[FakeWs.instances.length - 1];
    sock.emit('message', JSON.stringify({
      type: 'rfq_created',
      msg: { id: 'rfq-defer', contracts_fp: '5.00', mve_collection_ticker: 'KXMVE-X', note: 'DEFER-ME' },
    }));
    assert.strictEqual(created.length, 0, 'deferred rfq_created must not run on the WS tick');
    assert.strictEqual(captured.length, 0, 'RFQ-DEBUG must not run on the WS tick');
    await wait(15);
    assert.ok(created.includes('rfq-defer'), 'deferred rfq_created still delivers');
    assert.ok(captured.includes('rfq-defer'), 'RFQ-DEBUG still runs after setImmediate');

    sock.emit('message', JSON.stringify({
      type: 'rfq_created',
      msg: { id: 'rfq-hot', contracts_fp: '5.00', mve_collection_ticker: 'KXMVE-X' },
    }));
    assert.strictEqual(created[created.length - 1], 'rfq-hot', 'non-deferred rfq_created stays sync');
    assert.strictEqual(created.filter((id) => id === 'rfq-hot').length, 1);
    client.stop();
  }

  {
    FakeWs.instances = [];
    const executed = [];
    const { client } = startClient({ onQuoteExecuted: (evt) => executed.push(evt) });
    await wait(15);
    FakeWs.instances[0].emit('message', JSON.stringify({
      type: 'quote_executed',
      msg: {
        quote_id: '23e32a31-748d-4cc5-9bbb-6769ad52a8e1',
        order_id: '01a081a8-4a08-7823-a57f-2273007cd403',
        market_ticker: 'KXMVECROSSCATEGORY0-SHARD1-S20260E99CE0B6F9-BD36A940BEC',
        contracts_fp: '98.00',
      },
    }));
    assert.strictEqual(executed.length, 1);
    assert.strictEqual(executed[0].quoteId, '23e32a31-748d-4cc5-9bbb-6769ad52a8e1');
    assert.strictEqual(executed[0].orderId, '01a081a8-4a08-7823-a57f-2273007cd403');
    assert.strictEqual(executed[0].contracts, 98);
    assert.match(executed[0].marketTicker, /CROSSCATEGORY/);
    client.stop();
  }

  console.log('kalshi-ws.test.js ok');
}

runAsync().catch((e) => {
  console.error(e);
  process.exit(1);
});
