'use strict';
// Polymarket exact-target pricing (POLY_EXACT_TARGET, default on): ceil to the 0.001 tick, minus the maker
// rebate on big fills; never nets below the lock target. Also: engine Polymarket branch, quote Pool routing,
// stale-RFQ skip and quote latency stats.
const assert = require('assert');
const { impliedProb, decideAtFill, americanFromProb } = require('./engine');
const Q = require('./polymarket-quote');
const { createPolymarketHttp } = require('./polymarket-client');
const { evaluatePolymarketRfq, startPolymarketRfqLoop, quoteBodyFromEval } = require('./polymarket-rfq');

const SEED_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const tick3 = (x) => Math.ceil(x * 1000 - 1e-9) / 1000;
const bankers = (x) => { // round-half-even to cent
  const c = x * 100; const f = Math.floor(c); const d = c - f;
  const r = Math.abs(d - 0.5) < 1e-9 ? (f % 2 === 0 ? f : f + 1) : Math.round(c);
  return r / 100;
};

// ── flag ──────────────────────────────────────────────────────────────────────
assert.strictEqual(Q.polyExactTargetEnabled({}), true);
assert.strictEqual(Q.polyExactTargetEnabled({ POLY_EXACT_TARGET: '' }), true);
assert.strictEqual(Q.polyExactTargetEnabled({ POLY_EXACT_TARGET: '1' }), true);
for (const off of ['0', 'false', 'OFF', 'no']) assert.strictEqual(Q.polyExactTargetEnabled({ POLY_EXACT_TARGET: off }), false);

// ── price examples (before -> after) ──────────────────────────────────────────
const px = (f, contracts) => Q.fillAmericanToExactQuote(f, { contracts, env: {} }).buyPrice;
assert.strictEqual(Q.fillAmericanToBuyPrice(910), '0.099');           // legacy floor
assert.strictEqual(px(910, 91.61), '0.098');                           // +910, real fill size: 0.1c better
assert.strictEqual(px(910, 300), '0.098');
assert.strictEqual(px(910, 10), '0.100');                              // too small to credit the rebate: ceil(target)
assert.strictEqual(px(910, 39.99), '0.100');
assert.strictEqual(px(910, 40) <= '0.099', true);
assert.strictEqual(px(609, 100), '0.140');                             // legacy 0.141
assert.strictEqual(px(1850, 100), '0.051');                            // legacy 0.051
assert.strictEqual(px(1800, 100), '0.053');                            // legacy 0.052 (was 0.06c under target)
assert.strictEqual(px(2250, 100), '0.043');                            // legacy 0.042
assert.strictEqual(px(3972, 100), '0.025');                            // legacy 0.024
assert.strictEqual(px(350, 100), '0.221');                             // legacy 0.222

// ── properties over many locks and sizes ─────────────────────────────────────
let checked = 0;
for (let f = -400; f <= 6000; f += (f < 600 ? 7 : 53)) {
  if (f === 0 || (f > -100 && f < 100)) continue;
  const t = impliedProb(f);
  if (!(t > 0.002 && t < 0.99)) continue;
  for (const qty of [1, 5, 39, 40, 41, 60, 91.61, 175, 400, 2083]) {
    const r = Q.fillAmericanToExactQuote(f, { contracts: qty, env: {} });
    assert.ok(r, `quote for ${f}@${qty}`);
    const price = parseFloat(r.buyPrice);
    // never nets below the target after the credited rebate
    assert.ok(price + r.credit + 1e-12 >= t, `${f}@${qty}: ${price}+${r.credit} < ${t}`);
    // minimal tick: one tick lower would net below the target
    if (price > 0.001 + 1e-9) {
      const lower = price - 0.001;
      const lc = Q.rebateCreditPerContract(lower, qty);
      assert.ok(lower + lc < t - 1e-13, `${f}@${qty}: ${lower} would also qualify (price ${price})`);
    }
    // never above ceil(target)
    assert.ok(price <= tick3(t) + 1e-9, `${f}@${qty}: ${price} > ceil ${tick3(t)}`);
    // under the rebate threshold: no credit and exactly ceil(target)
    if (qty < 40) { assert.strictEqual(r.credit, 0); assert.ok(Math.abs(price - tick3(t)) < 1e-9); }
    // the real venue rebate (rounded to the cent per fill) always covers the credit we took
    const venueRebate = bankers(0.0125 * price * (1 - price) * qty);
    assert.ok(venueRebate + 1e-9 >= r.credit * qty, `${f}@${qty}: venue rebate ${venueRebate} < credit ${r.credit * qty}`);
    // and the price + realised rebate nets >= target on the whole fill
    assert.ok(price * qty + venueRebate + 1e-9 >= t * qty, `${f}@${qty}: fill nets below target`);
    checked++;
  }
}
assert.ok(checked > 1000, `checked ${checked}`);

// invalid inputs
for (const bad of [null, undefined, '', 0, 'x', NaN]) assert.strictEqual(Q.fillAmericanToExactQuote(bad, { contracts: 100, env: {} }), null);
assert.strictEqual(Q.fillAmericanToExactQuote(-100000, { contracts: 100, env: {} }), null, 'target above 0.999: no valid tick');

// theta override via env
{
  const r0 = Q.fillAmericanToExactQuote(910, { contracts: 300, env: { POLY_MAKER_REBATE_THETA: '0' } });
  assert.strictEqual(r0.buyPrice, '0.100');
  assert.strictEqual(r0.credit, 0);
  const rm = Q.fillAmericanToExactQuote(910, { contracts: 60, env: { POLY_REBATE_MIN_CONTRACTS: '100' } });
  assert.strictEqual(rm.credit, 0);
}

// ── buildPolymarketQuote ──────────────────────────────────────────────────────
{
  const qtyQ = Q.buildPolymarketQuote({ fillAmerican: 910, qtyDecimal: '91.61', env: {} });
  assert.strictEqual(qtyQ.buyPrice, '0.098');
  assert.strictEqual(qtyQ.estimatedContracts, 91.61);
  assert.strictEqual(qtyQ.exact, true);
  assert.ok(qtyQ.rebateCredit > 0.001 && qtyQ.rebateCredit < 0.0012);
  const legacy = Q.buildPolymarketQuote({ fillAmerican: 910, qtyDecimal: '91.61', exact: false });
  assert.strictEqual(legacy.buyPrice, '0.099');
  assert.strictEqual(legacy.rebateCredit, 0);
  assert.strictEqual(legacy.exact, false);
  // env flag off -> legacy
  const prev = process.env.POLY_EXACT_TARGET;
  process.env.POLY_EXACT_TARGET = '0';
  assert.strictEqual(Q.buildPolymarketQuote({ fillAmerican: 910, qtyDecimal: '91.61' }).buyPrice, '0.099');
  process.env.POLY_EXACT_TARGET = '1';
  assert.strictEqual(Q.buildPolymarketQuote({ fillAmerican: 910, qtyDecimal: '91.61' }).buyPrice, '0.098');
  if (prev == null) delete process.env.POLY_EXACT_TARGET; else process.env.POLY_EXACT_TARGET = prev;
  // cash RFQ: contracts sized from the quoted price; rebate sized from a haircut estimate
  const cash = Q.buildPolymarketQuote({ fillAmerican: 910, cashOrderQty: '10', env: {} });
  assert.strictEqual(cash.buyPrice, '0.098');
  assert.strictEqual(cash.estimatedContracts, Math.floor(10 / 0.098));
  // tiny cash RFQ ($1 ~ 10 contracts): no rebate credit, ceil(target)
  const tiny = Q.buildPolymarketQuote({ fillAmerican: 910, cashOrderQty: '1', env: {} });
  assert.strictEqual(tiny.buyPrice, '0.100');
  assert.strictEqual(tiny.rebateCredit, 0);
  // cash RFQ whose haircut size drops under the threshold does not credit (cash 4 ~ 40 contracts -> 34 est)
  const edge = Q.buildPolymarketQuote({ fillAmerican: 910, cashOrderQty: '4', env: {} });
  assert.strictEqual(edge.rebateCredit, 0);
  assert.strictEqual(Q.buildPolymarketQuote({ fillAmerican: 0, cashOrderQty: 10, env: {} }), null);
}

// ── engine Polymarket branch ──────────────────────────────────────────────────
{
  const base = { parlayStake: 100, parlayAmerican: 400, fillAmerican: 910, rfqContracts: 91.61, hedgeMode: '1x', maxContracts: 1000 };
  const q = Q.buildPolymarketQuote({ fillAmerican: 910, qtyDecimal: 91.61, env: {} });
  const d = decideAtFill({ ...base, polyQuote: { buyPrice: q.buyPrice, credit: q.rebateCredit, enforce: true } });
  assert.ok(d.ok, d.reason);
  assert.strictEqual(d.venue, 'polymarket');
  assert.strictEqual(d.quotedBuyPrice, '0.098');
  assert.strictEqual(d.contracts, 91.61);
  assert.strictEqual(d.subcent, false);
  assert.ok(d.quote.buy_price === '0.098' && !('no_bid' in d.quote), 'no Kalshi NO bid on the Polymarket branch');
  const sQ = 0.098 + q.rebateCredit;
  assert.ok(sQ >= impliedProb(910));
  // hit/miss/worst at the price actually sent (price + credited rebate), not at the target
  const N = 91.61; const bookHit = 100 * (1 + 4) - 100; const bookMiss = -100;
  assert.strictEqual(d.hitAtQuote, Math.round((bookHit + N * sQ - N) * 100) / 100);
  assert.strictEqual(d.missAtQuote, Math.round((bookMiss + N * sQ) * 100) / 100);
  assert.strictEqual(d.worstAtQuote, Math.min(d.hitAtQuote, d.missAtQuote));
  assert.strictEqual(d.quotedEffAmerican, americanFromProb(sQ));
  assert.strictEqual(d.effTakerOdds, americanFromProb(0.098));
  // refuses a price whose net is below the target
  const bad = decideAtFill({ ...base, polyQuote: { buyPrice: '0.097', credit: 0.001, enforce: true } });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, 'quote_below_target');
  assert.strictEqual(bad.quotedBuyPrice, '0.097');
  // ...but only when enforcing (legacy POLY_EXACT_TARGET=0 keeps its old floor and is not refused)
  const legacy = decideAtFill({ ...base, polyQuote: { buyPrice: '0.099', credit: 0, enforce: false } });
  assert.ok(legacy.ok);
  // out-of-range price never posts
  assert.strictEqual(decideAtFill({ ...base, polyQuote: { buyPrice: '1.000', credit: 0, enforce: false } }).reason, 'quote_below_target');
  assert.strictEqual(decideAtFill({ ...base, polyQuote: { buyPrice: '0.000', credit: 0, enforce: false } }).reason, 'quote_below_target');
  // Kalshi path untouched
  const k = decideAtFill({ ...base, subcent: true });
  assert.ok(k.ok && k.quote.no_bid && k.subcent === true);
}

// ── evaluatePolymarketRfq end to end ──────────────────────────────────────────
const lock = {
  id: 'lk', user_id: 'u1', label: 'White Sox ML + Pirates ML',
  parlay_stake: 100, parlay_american: 400, fill_american: 910, hedge_mode: '1x', max_contracts: 1000,
  leg_keys: ['AEC-MLB-BOS-PIT-2026-08-14-PIT:yes', 'AEC-MLB-CWS-DET-2026-08-14-CWS:yes'],
  legs: [
    { symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'SIDE_BUY' },
    { symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'SIDE_BUY' },
  ],
};
const mkRfq = (over) => ({ id: 'r1', status: 'RFQ_STATUS_OPEN', comboLegs: lock.legs, ...over });
const NOW = Date.parse('2026-08-14T12:00:00Z');
{
  const ev = evaluatePolymarketRfq({ rfq: mkRfq({ qtyDecimal: '91.61' }), parlays: [lock], now: NOW, exactTarget: true });
  assert.strictEqual(ev.action, 'quoteable', ev.reason);
  assert.strictEqual(ev.quote.buyPrice, '0.098');
  assert.strictEqual(quoteBodyFromEval(ev).buyPrice, '0.098');
  assert.strictEqual(ev.decision.venue, 'polymarket');
  const off = evaluatePolymarketRfq({ rfq: mkRfq({ qtyDecimal: '91.61' }), parlays: [lock], now: NOW, exactTarget: false });
  assert.strictEqual(off.quote.buyPrice, '0.099');
  const small = evaluatePolymarketRfq({ rfq: mkRfq({ qtyDecimal: '10' }), parlays: [lock], now: NOW, exactTarget: true });
  assert.strictEqual(small.quote.buyPrice, '0.100');
}

// ── quote Pool routing + warm ─────────────────────────────────────────────────
(async () => {
  const pools = [];
  const poolFactory = (origin, opts) => {
    const pool = { origin, opts, reqs: [], closed: false };
    pool.request = async (r) => {
      pool.reqs.push(`${r.method} ${r.path}`);
      return { statusCode: 200, headers: {}, body: { text: async () => '{"ok":true}' } };
    };
    pool.close = () => { pool.closed = true; };
    pools.push(pool);
    return pool;
  };
  const http = createPolymarketHttp({ keyId: 'k', secretKey: SEED_B64, poolFactory });
  assert.strictEqual(pools.length, 1, 'only the read pool exists until a mutation');
  assert.strictEqual(pools[0].opts.connections, 4);
  assert.strictEqual(pools[0].opts.pipelining, 1);
  await http.listRfqs({ limit: 1 });
  assert.strictEqual(pools.length, 1);
  assert.ok(pools[0].reqs[0].startsWith('GET /v1/rfqs'));
  await http.createQuote({ rfqId: 'r', buyPrice: '0.098', sellPrice: '0', restRemainder: false });
  assert.strictEqual(pools.length, 2, 'quote POST gets its own pool');
  const qp = pools[1];
  assert.strictEqual(qp.opts.connections, 3);
  assert.ok(qp.opts.connectTimeout > 0 && qp.opts.headersTimeout > 0 && qp.opts.bodyTimeout > 0);
  assert.ok(qp.opts.headersTimeout <= 8000);
  assert.deepStrictEqual(qp.reqs, ['POST /v1/rfqs/quotes']);
  await http.confirmQuote('r', 'q');
  await http.deleteQuote('r', 'q');
  assert.strictEqual(qp.reqs.length, 3);
  assert.ok(qp.reqs[1].startsWith('PUT ') && qp.reqs[2].startsWith('DELETE '));
  assert.strictEqual(pools[0].reqs.length, 1, 'mutations never touch the read pool');
  const warm = await http.warmQuotePool();
  assert.strictEqual(warm.ok, true);
  assert.strictEqual(warm.sockets, 3);
  assert.strictEqual(qp.reqs.filter((x) => x === 'GET /v1/rfqs/user-id').length, 3, 'warm fans out on the quote pool');
  assert.strictEqual(pools[0].reqs.length, 1);
  http.close();
  assert.ok(pools.every((p) => p.closed));
  // read-only client never opens a quote pool
  const pools2 = [];
  const ro = createPolymarketHttp({ keyId: 'k', secretKey: SEED_B64, poolFactory: (o, p) => { const x = poolFactory(o, p); pools2.push(x); return x; } });
  await ro.listPositions({});
  assert.strictEqual(pools2.length, 1);
  // requestFn mode (tests) has no pools; warm is a no-op
  const rf = createPolymarketHttp({ keyId: 'k', secretKey: SEED_B64, requestFn: async () => ({ statusCode: 200, json: {} }) });
  assert.strictEqual((await rf.warmQuotePool()).ok, false);

  // ── loop: stale-RFQ skip + latency stats ─────────────────────────────────
  const posts = [];
  const fakeHttp = {
    async getUserId() { return { rfqUserId: 'u' }; },
    async listRfqs() { return { rfqs: [] }; },
    async listQuotes() { return { quotes: [] }; },
    async getCombo() { return { combos: [] }; },
    async createQuote(body) { posts.push(body); return { quoteId: `q${posts.length}` }; },
    async confirmQuote() { return {}; },
    async deleteQuote() { return { statusCode: 200 }; },
    close() {},
  };
  const pending = new Map();
  const loop = startPolymarketRfqLoop({
    env: { POLYMARKET_KEY_ID: 'k', POLYMARKET_SECRET_KEY: SEED_B64, POLYMARKET_RFQ_LIVE: 'true' },
    http: fakeHttp, startWs: false,
    getParlays: () => [lock], filledSoFarFor: () => 0, getOutstanding: () => 0,
    startedFor: () => ({ started: false }),
    pendingQuotes: pending, reconcileMs: 60 * 60 * 1000, staleRfqMs: 30000,
    fetchMarket: async () => null,
  });
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const stale = await loop.handleRfq(mkRfq({ id: 'stale1', qtyDecimal: '91.61', createdTime: iso(45000) }), 'ws');
  assert.strictEqual(stale.reason, 'stale_rfq');
  assert.strictEqual(posts.length, 0, 'stale ws RFQ is not quoted');
  // same age via REST crawl is still quoted (an open RFQ found by a crawl is quotable)
  const rest = await loop.handleRfq(mkRfq({ id: 'rest1', qtyDecimal: '91.61', createdTime: iso(45000) }), 'rest');
  assert.strictEqual(rest.post, true);
  // fresh ws RFQ is quoted at the exact-target price
  const fresh = await loop.handleRfq(mkRfq({ id: 'fresh1', qtyDecimal: '91.61', createdTime: iso(120) }), 'ws');
  assert.strictEqual(fresh.post, true);
  assert.strictEqual(posts.length, 2);
  assert.strictEqual(posts[1].buyPrice, '0.098');
  const snap = loop.emitPolyHeartbeat();
  assert.ok(snap.latency, 'poly heartbeat carries latency stats');
  assert.strictEqual(snap.latency.posted, 2);
  assert.strictEqual(snap.latency.stale_skipped, 1);
  assert.strictEqual(snap.latency.post_failed, 0);
  assert.strictEqual(snap.latency.intake_ms.n, 3);
  assert.ok(snap.latency.quote_ms.n === 2 && snap.latency.posted_age_ms.n === 2);
  assert.ok(snap.reasons.stale_rfq === 1);
  // a failed POST is counted (and an rfq-closed one flagged)
  fakeHttp.createQuote = async () => { throw new Error('Polymarket POST /v1/rfqs/quotes 409 rfq closed'); };
  const failed = await loop.handleRfq(mkRfq({ id: 'fail1', qtyDecimal: '91.61', createdTime: iso(100) }), 'ws');
  assert.strictEqual(failed.post, false);
  const snap2 = loop.emitPolyHeartbeat();
  assert.strictEqual(snap2.latency.post_failed, 1);
  assert.strictEqual(snap2.latency.rfq_closed, 1);
  // stale off
  loop.stop();
  // market-cache prewarm: every active lock leg symbol is fetched once, off the hot path; cached ones are skipped
  {
    const fetched = [];
    const lp = startPolymarketRfqLoop({
      env: { POLYMARKET_KEY_ID: 'k', POLYMARKET_SECRET_KEY: SEED_B64, POLYMARKET_RFQ_LIVE: 'true' },
      http: fakeHttp, startWs: false, getParlays: () => [lock], filledSoFarFor: () => 0, getOutstanding: () => 0,
      pendingQuotes: new Map(), reconcileMs: 60 * 60 * 1000,
      fetchMarket: async (slug) => { fetched.push(slug); return { slug, gameStartTime: '2026-08-14T23:00:00Z' }; },
    });
    assert.strictEqual(await lp.prewarmMarkets(), 2);
    assert.deepStrictEqual(fetched.sort(), ['aec-mlb-bos-pit-2026-08-14-pit', 'aec-mlb-cws-det-2026-08-14-cws']);
    assert.strictEqual(await lp.prewarmMarkets(), 0, 'already cached: no refetch');
    lp.stop();
  }
  const loop0 = startPolymarketRfqLoop({
    env: { POLYMARKET_KEY_ID: 'k', POLYMARKET_SECRET_KEY: SEED_B64, POLYMARKET_RFQ_LIVE: 'true' },
    http: { ...fakeHttp, createQuote: async (b) => { posts.push(b); return { quoteId: 'qz' }; } }, startWs: false,
    getParlays: () => [lock], filledSoFarFor: () => 0, getOutstanding: () => 0,
    startedFor: () => ({ started: false }), pendingQuotes: new Map(), reconcileMs: 60 * 60 * 1000, staleRfqMs: 0,
    fetchMarket: async () => null,
  });
  const noStale = await loop0.handleRfq(mkRfq({ id: 'old2', qtyDecimal: '91.61', createdTime: iso(600000) }), 'ws');
  assert.strictEqual(noStale.post, true, 'stale skip disabled with 0');
  loop0.stop();
  console.log('poly-exact-target.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
