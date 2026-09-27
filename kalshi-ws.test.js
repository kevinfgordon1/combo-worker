'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { generateKeyPairSync } = require('crypto');
const { createKalshiWs, createKalshiFirehose, DEFAULT_STALL_MS, DEFAULT_LIVE_SHARD_FACTOR, PING_MS, INITIAL_BACKOFF_MS, readStallMs, readShardFactor, shardsLookUnsplit, summarizeThroughput, deadChannelReason, shouldOpenQuoteWatcherWs } = require('./kalshi-ws');
const { normalizeRfq, matchParlay } = require('./rfq');
const { createQuoteHot, lockNeedlePlan } = require('./quote-hot');
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
  assert.strictEqual(DEFAULT_LIVE_SHARD_FACTOR, 8);
  assert.strictEqual(readShardFactor(undefined, {}, 8), 8);
  assert.strictEqual(readShardFactor(undefined, { KALSHI_WS_SHARD_FACTOR: '1' }, 8), 1);
  assert.strictEqual(readShardFactor('4', { KALSHI_WS_SHARD_FACTOR: '1' }, 8), 4);
  assert.strictEqual(readShardFactor('0', {}, 8), 1);
  assert.strictEqual(readShardFactor('500', {}, 1), 100);
  assert.strictEqual(shardsLookUnsplit([2100, 2200, 2300], 3), true);
  assert.strictEqual(shardsLookUnsplit([300, 300, 300], 3), false);
  assert.strictEqual(shardsLookUnsplit([5000], 1), false);
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

  {
    FakeWs.instances = [];
    const hot = createQuoteHot();
    hot.setPlan(lockNeedlePlan([{
      id: 'sea',
      leg_keys: ['KXNFLGAME-26SEP13NESEA-SEA:yes', 'KXNFLGAME-26SEP13WASPHI-PHI:yes'],
    }]));
    const created = [];
    const deleted = [];
    const accepted = [];
    const executed = [];
    const client = createKalshiFirehose({
      keyId: 'test-key',
      pem: PEM,
      WebSocket: FakeWs,
      stallMs: 60_000,
      shardFactor: 4,
      shouldDropCreated: (raw) => hot.shouldDropCreated(raw),
      onRfqCreated: (rfq) => created.push(rfq.rfqId),
      onRfqDeleted: (evt) => deleted.push(evt.rfqId),
      onQuoteAccepted: (evt) => accepted.push(evt.quoteId),
      onQuoteExecuted: (evt) => executed.push(evt.orderId),
    });
    client.start();
    await wait(30);
    assert.strictEqual(FakeWs.instances.length, 4, 'one socket per shard');
    const keys = FakeWs.instances.map((sock) => {
      const body = JSON.parse(sock.sent[0]);
      assert.deepStrictEqual(body.params.channels, ['communications']);
      return body.params.shard_key;
    });
    assert.deepStrictEqual(keys.sort((a, b) => a - b), [0, 1, 2, 3]);
    assert.ok(FakeWs.instances.every((sock) => JSON.parse(sock.sent[0]).params.shard_factor === 4));

    const noise = Buffer.from(JSON.stringify({
      type: 'rfq_created',
      msg: {
        id: 'rfq-noise',
        contracts_fp: '10.00',
        mve_collection_ticker: 'KXMVECROSSCATEGORY-R',
        mve_selected_legs: [
          { market_ticker: 'KXNFLGAME-26SEP271330BUFKC-BUF', side: 'yes' },
          { market_ticker: 'KXNFLGAME-26SEP271330DALNYG-DAL', side: 'yes' },
        ],
      },
    }));
    FakeWs.instances[0].emit('message', noise);
    assert.strictEqual(created.length, 0, 'non-lock rfq_created must not be parsed into onRfq');
    assert.ok(client.health().drop >= 1);

    FakeWs.instances[1].emit('message', JSON.stringify({
      type: 'rfq_created',
      msg: {
        id: 'rfq-hit',
        contracts_fp: '10.00',
        mve_collection_ticker: 'KXMVECROSSCATEGORY-R',
        mve_selected_legs: [
          { market_ticker: 'KXNFLGAME-26SEP271330NESEA-SEA', side: 'yes' },
          { market_ticker: 'KXNFLGAME-26SEP271330WASPHI-PHI', side: 'yes' },
        ],
      },
    }));
    assert.ok(created.includes('rfq-hit'), 'needle hit stays on the receive path');
    FakeWs.instances[2].emit('message', JSON.stringify({
      type: 'rfq_created',
      msg: {
        id: 'rfq-hit',
        contracts_fp: '10.00',
        mve_selected_legs: [
          { market_ticker: 'KXNFLGAME-26SEP271330NESEA-SEA', side: 'yes' },
        ],
      },
    }));
    assert.strictEqual(created.filter((id) => id === 'rfq-hit').length, 1, 'duplicate shard delivery must not double-quote');

    FakeWs.instances[0].emit('message', JSON.stringify({
      type: 'rfq_deleted',
      msg: { id: 'rfq-hit', deleted_ts: '2026-09-27T18:00:00Z' },
    }));
    assert.deepStrictEqual(deleted, ['rfq-hit'], 'rfq_deleted is not needle-filtered');

    const quote = {
      type: 'quote_accepted',
      msg: { quote_id: 'q-1', rfq_id: 'rfq-hit', accepted_side: 'no' },
    };
    FakeWs.instances[2].emit('message', JSON.stringify(quote));
    FakeWs.instances[3].emit('message', JSON.stringify(quote));
    assert.deepStrictEqual(accepted, ['q-1'], 'quote_accepted from two shards confirms once');

    const executedMsg = {
      type: 'quote_executed',
      msg: {
        quote_id: 'q-1',
        rfq_id: 'rfq-hit',
        order_id: 'ord-1',
        market_ticker: 'KXMVECROSSCATEGORY-R',
        contracts_fp: '10.00',
      },
    };
    FakeWs.instances[0].emit('message', JSON.stringify(executedMsg));
    FakeWs.instances[1].emit('message', JSON.stringify(executedMsg));
    assert.deepStrictEqual(executed, ['ord-1']);
    await wait(300);
    FakeWs.instances[1].emit('message', JSON.stringify(executedMsg));
    assert.strictEqual(executed.length, 2, 'a later quote_executed still reaches the fill path');

    const before = FakeWs.instances.length;
    const victim = FakeWs.instances[1];
    victim.emit('message', JSON.stringify({
      type: 'error',
      msg: { code: 25, msg: 'Subscription buffer overflow' },
    }));
    assert.ok(victim.terminated, 'code 25 drops that shard socket');
    assert.ok(FakeWs.instances[0].readyState === FakeWs.OPEN && !FakeWs.instances[0].terminated, 'other shards stay up');
    assert.strictEqual(client.health().shardFactor, 4, 'code 25 must not collapse sharding');
    await wait(1100);
    assert.ok(FakeWs.instances.length > before, 'the overflowed shard reconnects on its own');
    client.stop();
  }

  {
    FakeWs.instances = [];
    const statuses = [];
    const client = createKalshiFirehose({
      keyId: 'test-key',
      pem: PEM,
      WebSocket: FakeWs,
      stallMs: 60_000,
      shardFactor: 3,
      onStatus: (s, info) => statuses.push({ s, info }),
    });
    client.start();
    await wait(20);
    FakeWs.instances[0].emit('message', JSON.stringify({ type: 'unsubscribed', msg: { channel: 'communications' } }));
    FakeWs.instances[1].emit('message', JSON.stringify({ type: 'unsubscribed', msg: { channel: 'communications' } }));
    await wait(30);
    assert.ok(statuses.some((x) => x.s === 'fallback'), 'two unsubscribed shards collapse to one socket');
    assert.strictEqual(client.health().shardFactor, 1);
    const live = FakeWs.instances.filter((sock) => !sock.terminated);
    assert.ok(live.length >= 1);
    const solo = live[live.length - 1];
    const params = JSON.parse(solo.sent[0]).params;
    assert.ok(!('shard_factor' in params), 'fallback socket is the full unsharded subscription');
    client.stop();
  }

  {
    const hot = createQuoteHot();
    hot.setPlan(lockNeedlePlan([{
      id: 'sea',
      leg_keys: ['KXNFLGAME-26SEP13NESEA-SEA:yes'],
    }]));
    const legs = [];
    for (let i = 0; i < 8; i++) {
      legs.push({
        market_ticker: `KXNFLGAME-26SEP271330BUFKC-BUF${i}`,
        side: 'yes',
        event_ticker: 'KXNFLGAME-26SEP27',
        yes_settlement_value_dollars: '1.0000',
      });
    }
    const noise = Buffer.from(JSON.stringify({
      type: 'rfq_created',
      sid: 1,
      msg: {
        id: 'rfq-bench',
        creator_id: '',
        market_ticker: 'KXMVECROSSCATEGORY-R',
        contracts_fp: '100.00',
        target_cost_dollars: '25.00',
        mve_collection_ticker: 'KXMVECROSSCATEGORY-R',
        mve_selected_legs: legs,
      },
    }));
    assert.ok(noise.length > 800, `bench frame should look like a combo RFQ, got ${noise.length}b`);
    const N = 20000;
    const t0 = process.hrtime.bigint();
    let dropped = 0;
    for (let i = 0; i < N; i++) if (hot.shouldDropCreated(noise)) dropped++;
    const sec = Number(process.hrtime.bigint() - t0) / 1e9;
    const rate = N / sec;
    assert.strictEqual(dropped, N);
    const parlays = [{ id: 'sea', leg_keys: ['KXNFLGAME-26SEP13NESEA-SEA:yes'] }];
    const M = 2000;
    const t1 = process.hrtime.bigint();
    for (let i = 0; i < M; i++) {
      matchParlay(normalizeRfq(JSON.parse(noise.toString())), parlays);
    }
    const parseSec = Number(process.hrtime.bigint() - t1) / 1e9;
    const parseRate = M / parseSec;
    FakeWs.instances = [];
    const benchClient = createKalshiWs({
      keyId: 'test-key',
      pem: PEM,
      WebSocket: FakeWs,
      stallMs: 60_000,
      shouldDropCreated: (raw) => hot.shouldDropCreated(raw),
      onRfqCreated: () => { throw new Error('fast-drop leaked a non-lock rfq_created'); },
    });
    benchClient.start();
    await wait(20);
    const benchSock = FakeWs.instances[FakeWs.instances.length - 1];
    const H = 10000;
    const t2 = process.hrtime.bigint();
    for (let i = 0; i < H; i++) benchSock.emit('message', noise);
    const handlerRate = H / (Number(process.hrtime.bigint() - t2) / 1e9);
    benchClient.stop();
    console.log(
      `[bench] fast-drop ${Math.round(rate)} frames/s; receive handler ${Math.round(handlerRate)} frames/s ` +
      `(${noise.length}b); full normalize+match ${Math.round(parseRate)} frames/s`
    );
    assert.ok(handlerRate >= 6000, `receive handler ${Math.round(handlerRate)} frames/s cannot cover a 2.7k peak`);
    assert.ok(rate >= 6000, `fast-drop ${Math.round(rate)} frames/s is under the 2.7k peak with headroom`);
    const snap = summarizeThroughput({
      windowMs: 30_000,
      recv: 81000,
      drop: 80000,
      parse: 1000,
      quotes: 2,
      backlog: 0,
      maxHandlerMs: 0.4,
      loopLagMs: 12,
      shardsUp: 8,
      shardFactor: 8,
      perShard: [{ shardKey: 0, recv: 10000, recvPerSec: 333, up: true }],
    });
    assert.strictEqual(snap.recvPerSec, 2700);
    assert.strictEqual(snap.backlog, 0);
    assert.strictEqual(snap.shardsUp, 8);
  }

  console.log('kalshi-ws.test.js ok');
}

runAsync().catch((e) => {
  console.error(e);
  process.exit(1);
});
