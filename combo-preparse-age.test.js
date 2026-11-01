'use strict';
// Nov 1 2026: Combo Locks pre-parse age gate. Kevin's 8-shard intake fell 4-15s behind at NFL
// kickoff volume (~9.3k frames/s, ~4k JSON.parse/s); Kalshi then closed sockets with 1008
// "WebSocket server delivery exceeded 15 seconds" / code 25 "Subscription buffer overflow".
// An rfq_created older than the post deadline is now dropped on a substring peek, before parse.
const assert = require('assert');
const { EventEmitter } = require('events');
const { generateKeyPairSync } = require('crypto');
const { createKalshiWs, createKalshiFirehose, peekCreatedMs, summarizeThroughput } = require('./kalshi-ws');
const { readPreparseMaxAgeMs, DEFAULT_PREPARSE_MAX_AGE_MS, createComboIntakeHost } = require('./combo-intake-host');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });

class FakeWs extends EventEmitter {
  static instances = [];
  static OPEN = 1;
  constructor() {
    super();
    this.readyState = 0; this.sent = [];
    FakeWs.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
  }
  send(m) { this.sent.push(m); }
  ping() {}
  terminate() { this.readyState = 3; }
  removeAllListeners() { return super.removeAllListeners(); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function frame(id, createdTs, asBuffer = true) {
  const s = JSON.stringify({
    type: 'rfq_created',
    sid: 1,
    msg: {
      id,
      contracts_fp: '10.00',
      mve_collection_ticker: 'KXMVECROSSCATEGORY-R',
      mve_selected_legs: [
        { market_ticker: 'KXNFLGAME-26NOV01BUFKC-BUF', side: 'yes' },
        { market_ticker: 'KXNFLGAME-26NOV01DETMIN-DET', side: 'yes' },
      ],
      created_ts: createdTs,
    },
  });
  return asBuffer ? Buffer.from(s) : s;
}

(async () => {
  const NOW = Date.parse('2026-11-01T18:00:10.000Z');

  // peekCreatedMs: ISO string, unix seconds, unix ms, missing, garbage
  assert.strictEqual(peekCreatedMs(frame('a', '2026-11-01T18:00:00.000Z')), Date.parse('2026-11-01T18:00:00.000Z'));
  assert.strictEqual(peekCreatedMs(frame('a', '2026-11-01T18:00:00.000Z', false)), Date.parse('2026-11-01T18:00:00.000Z'));
  assert.strictEqual(peekCreatedMs(frame('a', 1793556000)), 1793556000 * 1000);
  assert.strictEqual(peekCreatedMs(frame('a', 1793556000123)), 1793556000123);
  assert.strictEqual(peekCreatedMs(frame('a', '1793556000')), 1793556000 * 1000);
  assert.strictEqual(peekCreatedMs(Buffer.from('{"type":"rfq_created","msg":{"id":"x"}}')), null);
  assert.strictEqual(peekCreatedMs(Buffer.from('{"type":"rfq_created","msg":{"created_ts":"soon"}}')), null);
  assert.strictEqual(peekCreatedMs(Buffer.from('{"type":"rfq_created","msg":{"created_ts":null}}')), null);

  // env reader: default on, 0 = off, clamped
  assert.strictEqual(readPreparseMaxAgeMs({}), DEFAULT_PREPARSE_MAX_AGE_MS);
  assert.strictEqual(DEFAULT_PREPARSE_MAX_AGE_MS, 3500);
  assert.strictEqual(readPreparseMaxAgeMs({ COMBO_PREPARSE_MAX_AGE_MS: '0' }), 0);
  assert.strictEqual(readPreparseMaxAgeMs({ COMBO_PREPARSE_MAX_AGE_MS: 'off' }), 0);
  assert.strictEqual(readPreparseMaxAgeMs({ COMBO_PREPARSE_MAX_AGE_MS: '200' }), 1000);
  assert.strictEqual(readPreparseMaxAgeMs({ COMBO_PREPARSE_MAX_AGE_MS: '99999' }), 15000);
  assert.strictEqual(readPreparseMaxAgeMs({ COMBO_PREPARSE_MAX_AGE_MS: '5000' }), 5000);

  // Single socket with the gate on: stale frame never reaches onRfqCreated; fresh one does;
  // quote_accepted is never age-gated; unknown created_ts is never dropped.
  {
    FakeWs.instances = [];
    const created = []; const accepted = [];
    const ws = createKalshiWs({
      keyId: 'k', pem: PEM, WebSocket: FakeWs, stallMs: 60_000,
      maxCreatedAgeMs: 3500, now: () => NOW,
      onRfqCreated: (r) => created.push(r.rfqId),
      onQuoteAccepted: (e) => accepted.push(e.quoteId),
    });
    ws.start();
    await wait(10);
    const sock = FakeWs.instances[0];
    sock.emit('message', frame('stale', '2026-11-01T18:00:05.000Z'));   // 5s old -> drop
    sock.emit('message', frame('fresh', '2026-11-01T18:00:08.000Z'));   // 2s old -> keep
    sock.emit('message', frame('edge', '2026-11-01T18:00:06.500Z'));    // exactly 3.5s -> keep
    sock.emit('message', Buffer.from(JSON.stringify({ type: 'rfq_created', msg: { id: 'no-ts', mve_collection_ticker: 'KXMVE' } })));
    sock.emit('message', JSON.stringify({ type: 'quote_accepted', msg: { quote_id: 'q1', rfq_id: 'stale', created_ts: '2026-11-01T17:00:00Z' } }));
    assert.deepStrictEqual(created, ['fresh', 'edge', 'no-ts']);
    assert.deepStrictEqual(accepted, ['q1']);
    assert.strictEqual(ws.health().dropStale, 1);
    const snap = ws.takeThroughput();
    assert.strictEqual(snap.dropStale, 1);
    assert.strictEqual(ws.takeThroughput().dropStale, 0, 'window counter resets');
    ws.stop();
  }

  // Gate off by default (sniper and every other caller unchanged).
  {
    FakeWs.instances = [];
    const created = [];
    const ws = createKalshiWs({ keyId: 'k', pem: PEM, WebSocket: FakeWs, stallMs: 60_000, onRfqCreated: (r) => created.push(r.rfqId) });
    ws.start();
    await wait(10);
    FakeWs.instances[0].emit('message', frame('old', '2020-01-01T00:00:00.000Z'));
    assert.deepStrictEqual(created, ['old']);
    ws.stop();
  }

  // Firehose passes the option to every shard and sums dropStale.
  {
    FakeWs.instances = [];
    const created = [];
    const fh = createKalshiFirehose({
      keyId: 'k', pem: PEM, WebSocket: FakeWs, stallMs: 60_000, shardFactor: 2,
      maxCreatedAgeMs: 3500, now: () => NOW,
      onRfqCreated: (r) => created.push(r.rfqId),
    });
    fh.start();
    await wait(20);
    assert.strictEqual(FakeWs.instances.length, 2);
    FakeWs.instances[0].emit('message', frame('s0-old', '2026-11-01T18:00:00.000Z'));
    FakeWs.instances[1].emit('message', frame('s1-old', '2026-11-01T18:00:01.000Z'));
    FakeWs.instances[1].emit('message', frame('s1-new', '2026-11-01T18:00:09.000Z'));
    assert.deepStrictEqual(created, ['s1-new']);
    const snap = fh.takeThroughput();
    assert.strictEqual(snap.dropStale, 2);
    const sum = summarizeThroughput(snap);
    assert.strictEqual(sum.dropStale, 2);
    fh.stop();
  }

  // Host hands the limit to the intake worker thread.
  {
    let wd = null;
    class FakeWorker extends EventEmitter { constructor(file, opts) { super(); wd = opts.workerData; } postMessage() {} terminate() { return Promise.resolve(); } }
    const host = createComboIntakeHost({ shardFactor: 8, preparseMaxAgeMs: 3500, WorkerImpl: FakeWorker, onRfqCreated() {}, onRfqDeleted() {}, onQuoteAccepted() {}, onQuoteExecuted() {} });
    host.start();
    assert.strictEqual(wd.preparseMaxAgeMs, 3500);
    assert.strictEqual(wd.shardFactor, 8);
    await host.stop();
  }

  // Cost check (informational): peek vs parse per frame.
  {
    const f = frame('perf', '2026-11-01T18:00:00.000Z');
    let t0 = process.hrtime.bigint();
    for (let i = 0; i < 100_000; i++) peekCreatedMs(f);
    const peekNs = Number(process.hrtime.bigint() - t0);
    t0 = process.hrtime.bigint();
    for (let i = 0; i < 100_000; i++) JSON.parse(f.toString());
    const parseNs = Number(process.hrtime.bigint() - t0);
    // informational only (timing asserts flake on shared CI)
    console.log(`peek ${(peekNs / 1e5).toFixed(0)}ns/frame vs toString+JSON.parse ${(parseNs / 1e5).toFixed(0)}ns/frame`);
  }

  console.log('combo-preparse-age tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
