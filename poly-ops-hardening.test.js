'use strict';
// Poly ops hardening: GET 429 circuit breaker, WS stall watchdog,
// quote-delete retry/stray tracking.
const assert = require('assert');
const EventEmitter = require('events');

process.env.POLY_429_BASE_MS = '60';
process.env.POLY_429_MAX_MS = '200';
const { createPolymarketHttp, createPolymarketRfqWs } = require('./polymarket-client');
const { startPolymarketRfqLoop } = require('./polymarket-rfq');

const SEED_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function test429Breaker() {
  let mode = '429';
  const calls = [];
  const http = createPolymarketHttp({
    keyId: 'k', secretKey: SEED_B64,
    requestFn: async (req) => {
      calls.push(`${req.method} ${req.path}`);
      if (req.method === 'GET' && req.path === '/v1/rfqs' && mode === '429') {
        return { statusCode: 429, text: 'error code: 1015', json: null, headers: {} };
      }
      return { statusCode: 200, json: { rfqs: [], quoteId: 'q' } };
    },
  });
  await assert.rejects(() => http.listRfqs({ status: 'RFQ_STATUS_OPEN' }), (e) => e.statusCode === 429 && !e.localBackoff);
  assert.strictEqual(calls.length, 1);
  assert.ok(http.isBackedOff('/v1/rfqs'));
  // inside the window: no network call, synthetic local 429
  await assert.rejects(() => http.listRfqs({ status: 'RFQ_STATUS_OPEN' }), (e) => e.statusCode === 429 && e.localBackoff === true);
  assert.strictEqual(calls.length, 1, 'no upstream call while backed off');
  // other GET paths and all writes are unaffected
  await http.listActivities({});
  await http.createQuote({ x: 1 });
  await http.confirmQuote('r', 'q');
  await http.deleteQuote('r', 'q');
  assert.strictEqual(calls.length, 5);
  // window expires -> real call again; success clears the breaker
  await sleep(300);
  mode = 'ok';
  await http.listRfqs({ status: 'RFQ_STATUS_OPEN' });
  assert.strictEqual(calls.length, 6);
  assert.ok(!http.isBackedOff('/v1/rfqs'));
  assert.strictEqual(http.backoffSnapshot()['/v1/rfqs'].step, 0);
  // Retry-After honored (capped by max) and backoff grows
  const http2 = createPolymarketHttp({
    keyId: 'k', secretKey: SEED_B64,
    requestFn: async () => ({ statusCode: 429, text: 'x', json: null, headers: { 'retry-after': '0.1' } }),
  });
  await assert.rejects(() => http2.listRfqs({}));
  const snap = http2.backoffSnapshot()['/v1/rfqs'];
  assert.ok(snap.blockedMs > 0 && snap.blockedMs <= 200, `blockedMs=${snap.blockedMs}`);
}

class FakeSock extends EventEmitter {
  constructor() { super(); this.terminated = false; this.sent = []; }
  send(m) { this.sent.push(m); }
  ping() {}
  close() { this.emit('close', 1000); }
  terminate() { this.terminated = true; setImmediate(() => this.emit('close', 1006)); }
}

async function testWsWatchdog() {
  let t = 1_000_000;
  const socks = [];
  const stalls = [];
  const recovered = [];
  const statuses = [];
  const events = [];
  const ws = createPolymarketRfqWs({
    keyId: 'k', secretKey: SEED_B64,
    stallMs: 60000, stallCheckMs: 3_600_000,
    now: () => t,
    WebSocketImpl: function Fake() { const s = new FakeSock(); socks.push(s); return s; },
    onStatus: (s) => statuses.push(s),
    onStall: (i) => stalls.push(i),
    onRecovered: (i) => recovered.push(i),
    onEvent: (e) => events.push(e),
  });
  ws.start();
  assert.strictEqual(socks.length, 1);
  socks[0].emit('open');
  ws.checkStall();
  assert.strictEqual(stalls.length, 0, 'fresh connection is not a stall');
  t += 30000;
  socks[0].emit('message', Buffer.from('{}'));
  t += 59000;
  ws.checkStall();
  assert.strictEqual(stalls.length, 0, 'message 59s ago is healthy');
  t += 2000; // 61s silent
  ws.checkStall();
  assert.strictEqual(stalls.length, 1);
  assert.ok(stalls[0].silentMs >= 60000);
  assert.ok(socks[0].terminated, 'stalled socket terminated');
  ws.checkStall();
  assert.strictEqual(stalls.length, 1, 'does not re-fire immediately');
  await sleep(1300); // close -> reconnect (1s backoff)
  assert.strictEqual(socks.length, 2, 'reconnected after stall');
  assert.ok(statuses.includes('stalled') && statuses.includes('reconnecting'));
  socks[1].emit('open');
  assert.strictEqual(recovered.length, 0);
  socks[1].emit('message', Buffer.from('{}'));
  assert.strictEqual(recovered.length, 1, 'recovery reported on first message');
  // a dead socket that never sends anything after reconnect is re-flagged
  t += 61000;
  ws.checkStall();
  assert.strictEqual(stalls.length, 2);
  ws.stop();
  assert.strictEqual(ws.stats().stalls, 2);

  // stallMs=0 disables
  const off = createPolymarketRfqWs({
    keyId: 'k', secretKey: SEED_B64, stallMs: 0, now: () => t,
    WebSocketImpl: function Fake() { const s = new FakeSock(); socks.push(s); return s; },
    onStall: () => { throw new Error('should not fire'); },
  });
  off.start();
  socks[socks.length - 1].emit('open');
  t += 10 * 60000;
  off.checkStall();
  off.stop();
}

async function testDeleteRetry() {
  process.env.POLY_STRAY_DELETE_BASE_MS = '10';
  process.env.POLY_DELETE_INLINE_TRIES = '2';
  const log = [];
  let fail = 4; // inline x2 + first sweep fail, then succeed
  let statusCode = 503;
  const http = {
    async getUserId() { return { rfqUserId: 'u' }; },
    async listRfqs() { return { rfqs: [] }; },
    async listQuotes() { return { quotes: [] }; },
    async deleteQuote(rfqId, quoteId) {
      log.push(`${rfqId}/${quoteId}`);
      if (fail > 0) {
        fail -= 1;
        const e = new Error(`Polymarket DELETE x ${statusCode}`);
        e.statusCode = statusCode;
        throw e;
      }
      return { statusCode: 200 };
    },
    close() {},
  };
  const loop = startPolymarketRfqLoop({
    env: { POLYMARKET_KEY_ID: 'k', POLYMARKET_SECRET_KEY: SEED_B64, POLYMARKET_RFQ_LIVE: 'true' },
    http, startWs: false, crawl: false,
    getParlays: () => [], filledSoFarFor: () => 0, getOutstanding: () => 0,
    pendingQuotes: new Map(), reconcileMs: 3_600_000, fillReconcileMs: 3_600_000,
  });
  assert.ok(loop.live, 'live loop');
  const r = await loop.deleteQuoteReliably('rfq1', 'q1');
  assert.strictEqual(r.ok, false);
  assert.ok(r.queued);
  assert.strictEqual(log.length, 2);
  assert.ok(loop.strayDeletes.has('q1'), 'failed delete is tracked, not forgotten');
  await loop.sweepStrayDeletes(); // not due yet (nextAt in future)
  await sleep(30);
  await loop.sweepStrayDeletes(); // due -> fails (3rd)
  assert.ok(loop.strayDeletes.has('q1'));
  await sleep(200);
  await loop.sweepStrayDeletes(); // fails (4th)
  await sleep(300);
  await loop.sweepStrayDeletes(); // succeeds
  assert.ok(!loop.strayDeletes.has('q1'), 'cleared once the venue accepts the delete');
  assert.strictEqual(loop.deleteStats.strayCleared, 1);

  // terminal 400 is not retried forever
  fail = 99; statusCode = 400; log.length = 0;
  const r2 = await loop.deleteQuoteReliably('rfq2', 'q2');
  assert.ok(r2.terminal);
  assert.strictEqual(log.length, 1, '400 is not retried');
  assert.ok(!loop.strayDeletes.has('q2'));
  loop.stop();
}

async function testShallowCrawlWhenWsHealthy() {
  let pages = 0;
  const http = {
    async getUserId() { return { rfqUserId: 'u' }; },
    async listRfqs() { pages += 1; return { rfqs: [{ id: `r${pages}` }], cursor: `c${pages}` }; },
    async listQuotes() { return { quotes: [] }; },
    close() {},
  };
  let healthy = true;
  const fakeWs = { start() {}, stop() {}, stats: () => ({ lastMessageAt: Date.now(), silentMs: healthy ? 100 : 40000, stalls: 0, reconnects: 0 }) };
  const loop = startPolymarketRfqLoop({
    env: { POLYMARKET_KEY_ID: 'k', POLYMARKET_SECRET_KEY: SEED_B64, POLYMARKET_RFQ_LIVE: 'false' },
    http, ws: fakeWs, crawl: true, crawlMs: 3_600_000, crawlFirstMs: 3_600_000, crawlPageDelayMs: 0, crawlMaxPages: 40,
    getParlays: () => [], filledSoFarFor: () => 0, getOutstanding: () => 0,
    pendingQuotes: new Map(), reconcileMs: 3_600_000, fillReconcileMs: 3_600_000,
  });
  await sleep(50);
  pages = 0;
  await loop.crawlAllOpenRfqs();
  assert.strictEqual(pages, 5, 'WS healthy -> shallow crawl (5 pages)');
  healthy = false;
  pages = 0;
  await loop.crawlAllOpenRfqs();
  assert.strictEqual(pages, 40, 'WS silent -> deep crawl');
  loop.stop();
}

async function testSlugScanPacing() {
  const fr = require('./polymarket-fill-reconcile');
  fr._resetSlugScanForTest();
  const seen = [];
  const http = { async listActivities(q) { seen.push(q.marketSlug); return { activities: [], eof: true }; } };
  const slugs = Array.from({ length: 30 }, (_, i) => `caoc-${String(i).padStart(16, '0')}`);
  await fr.listActivitiesForMarketSlugs(http, slugs);
  assert.strictEqual(seen.length, 30, 'first call after boot scans every slug once');
  seen.length = 0;
  await fr.listActivitiesForMarketSlugs(http, slugs);
  assert.strictEqual(seen.length, 8, 'later calls rotate through a bounded slice');
  const first = seen.slice();
  seen.length = 0;
  await fr.listActivitiesForMarketSlugs(http, slugs);
  assert.strictEqual(seen.length, 8);
  assert.ok(first.every((x) => !seen.includes(x)), 'rotation advances');
  // 429 stops the per-slug pass
  seen.length = 0;
  const h429 = { async listActivities(q) { seen.push(q.marketSlug); const e = new Error('429'); e.statusCode = 429; throw e; } };
  await fr.listActivitiesForMarketSlugs(h429, slugs);
  assert.strictEqual(seen.length, 1, 'stops on first 429');
  // partial pages are kept when a later page is rate limited
  let n = 0;
  const hp = { async listActivities() { n += 1; if (n === 2) { const e = new Error('429'); e.statusCode = 429; throw e; } return { activities: [{ id: 'a' }], nextCursor: 'c' }; } };
  const rows = await fr.listActivitiesForMarketSlugs(hp, [slugs[0]], { full: true });
  assert.ok(rows.length >= 1);
}

async function testHydrateCap() {
  const fr = require('./polymarket-fill-reconcile');
  let calls = 0;
  const http = { async listQuotes() { calls += 1; return { quotes: [] }; } };
  const cands = Array.from({ length: 15 }, (_, i) => ({ id: `q${i}`, quote: null, pending: { rfqId: `r${i}`, accepted: i === 14 } }));
  await fr.hydrateMissingQuotes(http, cands, 15);
  assert.strictEqual(calls, 5, 'hydrate capped to 5 GETs per tick');
  calls = 0;
  const h429 = { async listQuotes() { calls += 1; const e = new Error('429'); e.statusCode = 429; throw e; } };
  await fr.hydrateMissingQuotes(h429, cands, 15);
  assert.strictEqual(calls, 1, 'stops at first 429');
}

(async () => {
  await test429Breaker();
  await testHydrateCap();
  await testSlugScanPacing();
  await testShallowCrawlWhenWsHealthy();
  await testWsWatchdog();
  await testDeleteRetry();
  console.log('poly-ops-hardening.test.js ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
