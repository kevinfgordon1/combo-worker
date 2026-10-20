'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { createPolyLimiter, sharedPolyLimiter, resetSharedPolyLimiter, classify } = require('./poly-limiter');
const { createPolymarketHttp } = require('./polymarket-client');
const { hydrateRfq, createComboCache } = require('./polymarket-rfq');
const { createPolymarketMarketsWs, parseMarketsMessage } = require('./poly-markets-ws');
const { createSingleLegRunner } = require('./single-leg-runner');

(async () => {
  // classify
  assert.strictEqual(classify('GET', '/v1/rfqs'), 'rfq');
  assert.strictEqual(classify('GET', '/v1/rfqs/quotes'), 'rfq');
  assert.strictEqual(classify('GET', '/v1/rfqs/user-id'), 'rfq');
  assert.strictEqual(classify('GET', '/v1/combos'), 'general');
  assert.strictEqual(classify('GET', '/v1/market/slug/x'), 'general');
  assert.strictEqual(classify('POST', '/v1/rfqs/quotes'), 'write');
  assert.strictEqual(classify('DELETE', '/v1/rfqs/a/quotes/b'), 'write');

  // GCRA: rfq 0.8/s => 1250ms spacing; drop past max wait; writes never wait
  {
    let t = 0; const slept = [];
    const lim = createPolyLimiter({ now: () => t, sleep: async (ms) => { slept.push(ms); }, rfqMaxWaitMs: 3000 });
    assert.strictEqual((await lim.acquire('GET', '/v1/rfqs')).waitMs, 0);
    assert.strictEqual((await lim.acquire('GET', '/v1/rfqs')).waitMs, 1250);
    assert.strictEqual((await lim.acquire('GET', '/v1/rfqs')).waitMs, 2500);
    assert.strictEqual((await lim.acquire('GET', '/v1/rfqs')).ok, false, 'past 3s max wait is dropped');
    assert.strictEqual((await lim.acquire('POST', '/v1/rfqs/quotes')).waitMs, 0, 'writes skip the queue');
    // general: 20/s, burst 5
    for (let i = 0; i < 5; i += 1) assert.strictEqual((await lim.acquire('GET', '/v1/combos')).waitMs, 0);
    assert.strictEqual((await lim.acquire('GET', '/v1/combos')).waitMs, 50);
    t = 10000;
    assert.strictEqual((await lim.acquire('GET', '/v1/rfqs')).waitMs, 0, 'refills over time');
    const st = lim.rollStats();
    assert.strictEqual(st.rfq.dropped, 1);
    assert.strictEqual(st.write.ok, 1);
    assert.strictEqual(lim.rollStats().rfq.ok, 0, 'rollStats resets');
  }

  // Sustained rate stays under 0.8/s over a simulated minute
  {
    let t = 0;
    const lim = createPolyLimiter({ now: () => t, sleep: async (ms) => { t += ms; } });
    let sent = 0;
    while (t < 60000) { const r = await lim.acquire('GET', '/v1/rfqs'); if (r.ok) sent += 1; }
    assert.ok(sent <= 49, `rfq sent ${sent} in 60s`);
  }

  // shared limiter only on poly role
  resetSharedPolyLimiter();
  assert.strictEqual(sharedPolyLimiter({}), null, 'combo-worker: no limiter');
  assert.ok(sharedPolyLimiter({ COMBO_ROLE: 'poly' }), 'poly-worker: limiter on');
  assert.strictEqual(sharedPolyLimiter({ COMBO_ROLE: 'poly' }), sharedPolyLimiter({ COMBO_ROLE: 'poly' }), 'one per process');
  resetSharedPolyLimiter();
  assert.strictEqual(sharedPolyLimiter({ COMBO_ROLE: 'poly', POLY_LIMITER: '0' }), null);

  // client: limiter drop returns a local 429 without a network call
  {
    let calls = 0;
    const lim = createPolyLimiter({ rfqMaxWaitMs: 0, sleep: async () => {} });
    const http = createPolymarketHttp({
      keyId: 'k', secretKey: Buffer.alloc(32, 1).toString('base64'), limiter: lim,
      requestFn: async () => { calls += 1; return { statusCode: 200, text: '{"rfqs":[]}', json: { rfqs: [] } }; },
    });
    await http.listRfqs({ limit: 1 });
    await assert.rejects(() => http.listRfqs({ limit: 1 }), (e) => e.statusCode === 429);
    assert.strictEqual(calls, 1, 'dropped request never left the process');
    assert.strictEqual(http.limiter, lim);
    const http2 = createPolymarketHttp({ keyId: 'k', secretKey: Buffer.alloc(32, 1).toString('base64'), requestFn: async () => ({ statusCode: 200, json: {} }) });
    assert.strictEqual(http2.limiter, null, 'no limiter outside poly role');
  }

  // combo cache: one GET per symbol, concurrent callers share it
  {
    let gets = 0; let rfqGets = 0;
    const legs = [{ marketSlug: 'aec-nfl-chi-ne-2026-10-22', side: 'yes' }];
    const http = {
      getCombo: async () => { gets += 1; await new Promise((r) => setTimeout(r, 5)); return { combo: { legs } }; },
      listRfqs: async () => { rfqGets += 1; return { rfqs: [] }; },
      isBackedOff: () => false,
    };
    const cache = createComboCache();
    const [a, b] = await Promise.all([cache.get(http, 'S1'), cache.get(http, 'S1')]);
    assert.deepStrictEqual(a, legs); assert.deepStrictEqual(b, legs);
    await cache.get(http, 'S1');
    assert.strictEqual(gets, 1);
    // hydrate with combo cache never calls the single-RFQ GET
    await hydrateRfq(http, { id: 'r1', symbol: 'S2', status: 'RFQ_STATUS_OPEN' }, { comboCache: cache });
    await hydrateRfq(http, { id: 'r2', symbol: 'S2', status: 'RFQ_STATUS_OPEN' }, { comboCache: cache });
    assert.strictEqual(rfqGets, 0, 'no GET /v1/rfqs?rfqId on poly-worker');
    assert.strictEqual(gets, 2, 'S2 fetched once for two RFQs');
    // old path (combo-worker) still does the single-RFQ lookup
    await hydrateRfq(http, { id: 'r3', symbol: 'S3', status: 'RFQ_STATUS_OPEN' });
    assert.strictEqual(rfqGets, 1);
    // 429 is not cached
    const c2 = createComboCache();
    let n = 0;
    const flaky = { getCombo: async () => { n += 1; if (n === 1) { const e = new Error('429'); e.statusCode = 429; throw e; } return { combo: { legs } }; } };
    await assert.rejects(() => c2.get(flaky, 'X'));
    assert.deepStrictEqual(await c2.get(flaky, 'X'), legs);
  }

  // markets WS: subscribe in chunks, cache books, books from dead socket are not live
  class FakeWs extends EventEmitter {
    constructor(url, opts) { super(); this.url = url; this.opts = opts; this.sent = []; FakeWs.last = this; }
    send(s) { this.sent.push(JSON.parse(s)); }
    ping() {}
    close() { this.emit('close', 1000); }
  }
  {
    assert.strictEqual(parseMarketsMessage('{"marketData":{"marketSlug":"m1","offers":[]}}').slug, 'm1');
    const mws = createPolymarketMarketsWs({ keyId: 'k', secretKey: Buffer.alloc(32, 1).toString('base64'), WebSocketImpl: FakeWs });
    mws.ensure('m1');
    const sock = FakeWs.last;
    assert.ok(sock.opts.headers, 'signed handshake');
    sock.emit('open');
    assert.strictEqual(sock.sent[0].subscribe.subscriptionType, 'SUBSCRIPTION_TYPE_MARKET_DATA');
    assert.deepStrictEqual(sock.sent[0].subscribe.marketSlugs, ['m1']);
    mws.ensure('m2');
    assert.deepStrictEqual(sock.sent[1].subscribe.marketSlugs, ['m2'], 'incremental subscribe');
    mws.ensure('m1');
    assert.strictEqual(sock.sent.length, 2, 'no duplicate subscribe');
    assert.strictEqual(mws.liveBook('m1'), null);
    sock.emit('message', Buffer.from(JSON.stringify({ marketData: { marketSlug: 'm1', offers: [{ px: { value: '0.40' }, qty: '100' }], bids: [] } })));
    assert.ok(mws.liveBook('m1'));
    mws.stop();
    assert.strictEqual(mws.liveBook('m1'), null, 'closed socket: not live');
    // 250 slugs -> 3 subscriptions of <=100
    const big = createPolymarketMarketsWs({ keyId: 'k', secretKey: Buffer.alloc(32, 1).toString('base64'), WebSocketImpl: FakeWs });
    big.ensure('s0'); const s2 = FakeWs.last;
    for (let i = 1; i < 250; i += 1) big.ensure(`s${i}`);
    s2.emit('open');
    assert.strictEqual(s2.sent.length, 3);
    assert.ok(s2.sent.every((m) => m.subscribe.marketSlugs.length <= 100));
    big.stop();
  }

  // single-leg runner reads books from the WS cache, REST only before the first push
  {
    let restBooks = 0;
    const books = new Map();
    const polyBooks = { ensure() {}, liveBook: (s) => books.get(s) || null };
    const runner = createSingleLegRunner({
      env: { SINGLE_LEG_LIVE: 'dry' }, supabase: null, kalshiSigned: async () => ({ statusCode: 500 }),
      polyBooks, getParlays: () => [], venues: ['polymarket'], forceDry: true, log: () => {},
      fetchImpl: async () => { restBooks += 1; return { ok: true, json: async () => ({ marketData: { offers: [{ px: { value: '0.50' }, qty: '10' }], bids: [] } }) }; },
    });
    const a1 = await runner._asksFor('polymarket', 'm1', 'ORDER_INTENT_BUY_LONG');
    assert.strictEqual(restBooks, 1); assert.strictEqual(a1[0].cost, 0.5);
    books.set('m1', { marketData: { offers: [{ px: { value: '0.45' }, qty: '20' }], bids: [] } });
    const a2 = await runner._asksFor('polymarket', 'm1', 'ORDER_INTENT_BUY_LONG');
    assert.strictEqual(restBooks, 1, 'no REST once the WS book is live');
    assert.strictEqual(a2[0].cost, 0.45);
    assert.deepStrictEqual(runner.bookStats(), { ws: 1, rest: 1 });
  }

  // loop: poly-worker skips the deep scan while the WS is healthy, crawls when it is not
  {
    const { startPolymarketRfqLoop } = require('./polymarket-rfq');
    let listCalls = 0;
    const fakeHttp = {
      listRfqs: async () => { listCalls += 1; return { rfqs: [] }; },
      getUserId: async () => ({ rfqUserId: 'u' }),
      isBackedOff: () => false,
      listQuotes: async () => ({ quotes: [] }),
    };
    let silent = 0;
    const fakeWs = { start() {}, stop() {}, stats: () => ({ lastMessageAt: Date.now() - silent, silentMs: silent, stalls: 0, reconnects: 0 }) };
    const env = { POLYMARKET_KEY_ID: 'k', POLYMARKET_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'), POLYMARKET_RFQ_LIVE: 'false' };
    const loop = startPolymarketRfqLoop({ env, http: fakeHttp, ws: fakeWs, polyRole: true, getParlays: () => [], reconcileMs: 3600000, crawlMs: 3600000, prewarmMarkets: false, crawlPageDelayMs: 0 });
    const r1 = await loop.crawlAllOpenRfqs();
    assert.strictEqual(r1, null, 'healthy WS: no deep scan');
    assert.strictEqual(listCalls, 0);
    silent = 60000;
    await loop.crawlAllOpenRfqs();
    assert.ok(listCalls >= 1, 'unhealthy WS: full coverage crawl');
    loop.stop();
  }

  console.log('poly-ratelimit tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
