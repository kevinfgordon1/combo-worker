'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { createKalshiBookFeed, createBookRouter, splitShards } = require('./book-ws');

let clock = 1000; const now = () => clock;
const sockets = [];
class FakeWS extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(m) { this.sent.push(JSON.parse(m)); }
  ping() {} terminate() { this.readyState = 3; } close() { this.readyState = 3; }
  open() { this.readyState = 1; this.emit('open'); }
  frame(o) { this.emit('message', Buffer.from(JSON.stringify(o))); }
}
const timers = [];
const mk = (o = {}) => createKalshiBookFeed({ WS: FakeWS, url: 'wss://x', headers: () => ({ h: 1 }), now, perShard: 2, maxShards: 8, quietMs: 10000,
  setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, setIntervalFn: () => 0, clearIntervalFn: () => {}, ...o });

// sharding: 5 tickers / 2 per shard -> 3 sockets, each subscribing orderbook_delta for its own tickers
assert.deepStrictEqual(splitShards(['A', 'B', 'C', 'D', 'E'], 2, 8).map((s) => s.length), [2, 2, 1]);
assert.strictEqual(splitShards(Array.from({ length: 100 }, (_, i) => `T${i}`), 2, 8).length, 8, 'capped at maxShards');
const feed = mk();
feed.setTickers(['KXNFLGAME-A', 'KXNFLGAME-B', 'KXNFLTD-C']);
assert.strictEqual(sockets.length, 2);
sockets.forEach((s) => s.open());
const sub = sockets.flatMap((s) => s.sent.map((m) => m.params));
assert.ok(sub.every((p) => p.channels[0] === 'orderbook_delta'));
assert.deepStrictEqual(sub.flatMap((p) => p.market_tickers).sort(), ['KXNFLGAME-A', 'KXNFLGAME-B', 'KXNFLTD-C']);
assert.strictEqual(feed.setTickers(['KXNFLTD-C', 'KXNFLGAME-B', 'KXNFLGAME-A']), false, 'same set: no reshard');

const sA = sockets.find((s) => s.sent[0].params.market_tickers.includes('KXNFLGAME-A'));
const sC = sockets.find((s) => s !== sA);
// not live until snapshot
assert.strictEqual(feed.live(['KXNFLGAME-A']), false);
sA.frame({ type: 'orderbook_snapshot', sid: 1, seq: 1, msg: { market_ticker: 'KXNFLGAME-A', yes_dollars_fp: [['0.4000', '100.00']], no_dollars_fp: [['0.5500', '50.00'], ['0.5800', '20.00']] } });
assert.strictEqual(feed.live(['KXNFLGAME-A']), true);
assert.strictEqual(feed.live(['KXNFLGAME-A', 'KXNFLGAME-B']), false, 'B has no snapshot yet');
sA.frame({ type: 'orderbook_delta', sid: 1, seq: 2, msg: { market_ticker: 'KXNFLGAME-A', side: 'no', price_dollars: '0.5800', delta_fp: '-20.00' } });
sA.frame({ type: 'orderbook_delta', sid: 1, seq: 3, msg: { market_ticker: 'KXNFLGAME-A', side: 'yes', price_dollars: '0.4100', delta_fp: '7.00' } });
sA.frame({ type: 'orderbook_delta', sid: 1, seq: 3, msg: { market_ticker: 'KXNFLGAME-A', side: 'yes', price_dollars: '0.4100', delta_fp: '7.00' } }); // dup ignored
assert.deepStrictEqual(feed.snapshot(['KXNFLGAME-A']), [{ ticker: 'KXNFLGAME-A', orderbook_fp: { yes_dollars: [['0.4000', '100'], ['0.4100', '7']], no_dollars: [['0.5500', '50']] } }]);

// quiet past quietMs (no frame, no pong) -> not live; pong revives
clock += 10001; assert.strictEqual(feed.live(['KXNFLGAME-A']), false);
sA.emit('pong'); assert.strictEqual(feed.live(['KXNFLGAME-A']), true);

// seq gap -> shard reset + reconnect (books cleared, not live); other shard untouched
sC.frame({ type: 'orderbook_snapshot', sid: 9, seq: 1, msg: { market_ticker: 'KXNFLGAME-B', yes_dollars_fp: [], no_dollars_fp: [['0.9', '10']] } });
sA.frame({ type: 'orderbook_delta', sid: 1, seq: 7, msg: { market_ticker: 'KXNFLGAME-A', side: 'yes', price_dollars: '0.41', delta_fp: '1' } });
assert.strictEqual(feed.live(['KXNFLGAME-A']), false); assert.strictEqual(feed.stats().gaps, 1);
assert.strictEqual(feed.live(['KXNFLGAME-B']), true);
// buffer overflow error code 25 -> shard reset, counted
sC.frame({ type: 'error', msg: { code: 25, msg: 'Subscription buffer overflow' } });
assert.strictEqual(feed.live(['KXNFLGAME-B']), false); assert.strictEqual(feed.stats().overflows, 1);
// reconnect timer reopens a fresh socket that resubscribes
const n0 = sockets.length; timers.splice(0).forEach((f) => f());
assert.strictEqual(sockets.length, n0 + 2);
feed.stop();

// router: ws fresh -> sink + health stamp, REST skipped; ws quiet -> REST needed (fallback)
{
  let live = true; const feedF = { live: () => live, snapshot: (t) => t.map((x) => ({ ticker: x })) };
  let t = 0; const got = []; const health = { ml: 0 };
  const r = createBookRouter({ feed: feedF, fallbackMs: 5000, now: () => t, groups: { ml: { tickers: () => ['KXNFLGAME-A'], sink: (o) => got.push(o), onFresh: (x) => { health.ml = x; } }, empty: { tickers: () => [], sink: () => { throw new Error('no'); } } } });
  assert.strictEqual(r.restNeeded('ml'), true, 'before first ws flush, REST runs');
  t = 100; r.flush(); assert.strictEqual(health.ml, 100); assert.strictEqual(got.length, 1);
  t = 3000; assert.strictEqual(r.restNeeded('ml'), false);
  live = false; t = 4000; r.flush(); assert.strictEqual(health.ml, 100, 'no stamp while ws not live');
  t = 5200; assert.strictEqual(r.restNeeded('ml'), true, 'ws quiet > fallback -> REST');
  assert.strictEqual(r.source('ml'), 'rest');
  // prices_stale semantics unchanged: runner gate is now - health.ml < 30s, stamped by ws OR REST
  const r0 = createBookRouter({ feed: null, groups: { ml: { tickers: () => ['X'], sink: () => {} } } });
  r0.flush(); assert.strictEqual(r0.restNeeded('ml'), true, 'feed off -> always REST');
}
console.log('book-ws tests passed');
