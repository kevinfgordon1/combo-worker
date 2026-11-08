'use strict';
const assert = require('assert');
const {
  TIERS, classify, retryAfterMs, isBalancePath, isTransferPost,
  createKalshiAccountLimiter, createKalshiBalanceCache, readTier, readHeadroom,
} = require('./kalshi-account-limiter');

assert.strictEqual(readTier({}), 'advanced');
assert.strictEqual(readTier({ KALSHI_TIER: 'premier' }), 'premier');
assert.strictEqual(readTier({ KALSHI_TIER: 'nope' }), 'advanced');
assert.strictEqual(readHeadroom({}), 0.9);
assert.strictEqual(readHeadroom({ KALSHI_LIMIT_HEADROOM: '2' }), 1);
assert.strictEqual(readHeadroom({ KALSHI_LIMIT_HEADROOM: '0.1' }), 0.5);

assert.strictEqual(TIERS.advanced.readTok, 300);
assert.strictEqual(TIERS.advanced.writeTok, 300);
assert.strictEqual(TIERS.advanced.balanceRps, 1);
assert.strictEqual(TIERS.advanced.readBurstSec, 3);
assert.strictEqual(TIERS.basic.balanceRps, 1);
assert.strictEqual(TIERS.expert.balanceRps, 5);
assert.strictEqual(TIERS.basic.writeBurstSec, 1, 'Basic write holds one second, no 3s burst');

{
  const post = classify('POST', '/trade-api/v2/communications/quotes');
  assert.strictEqual(post.bucket, 'write');
  assert.strictEqual(post.cost, 2);
  assert.strictEqual(post.priority, 2);
  const confirm = classify('PUT', '/trade-api/v2/communications/rfqs/r/quotes/q/confirm');
  assert.strictEqual(confirm.cost, 1);
  assert.strictEqual(confirm.priority, 2);
  const del = classify('DELETE', '/trade-api/v2/communications/quotes/q');
  assert.strictEqual(del.bucket, 'write');
  assert.strictEqual(del.cost, 2);
  assert.strictEqual(del.priority, 1);
  const bal = classify('GET', '/trade-api/v2/portfolio/balance');
  assert.strictEqual(bal.bucket, 'balance');
  const warm = classify('GET', '/trade-api/v2/exchange/status');
  assert.strictEqual(warm.bucket, 'read');
  assert.strictEqual(warm.cost, 10);
  assert.strictEqual(warm.priority, 0);
  const fills = classify('GET', '/trade-api/v2/portfolio/fills');
  assert.strictEqual(fills.priority, 1, 'fill reads beat connection warm');
  assert.ok(isBalancePath('/trade-api/v2/portfolio/balance'));
  assert.ok(!isBalancePath('/trade-api/v2/portfolio/fills'));
  assert.ok(isTransferPost('POST', '/trade-api/v2/portfolio/intra_exchange_instance_transfer'));
  assert.ok(!isTransferPost('GET', '/trade-api/v2/portfolio/intra_exchange_instance_transfers'));
}

{
  assert.strictEqual(retryAfterMs({ 'retry-after': '2' }, 0), 2000);
  assert.strictEqual(retryAfterMs({ 'Retry-After': '0' }, 0), 0);
  const hdrs = { get(n) { return n === 'retry-after' ? '1.5' : null; } };
  assert.strictEqual(retryAfterMs(hdrs, 0), 1500);
  const when = Date.parse('2026-11-08T06:31:52.000Z');
  assert.strictEqual(retryAfterMs({ 'retry-after': 'Sun, 08 Nov 2026 06:31:52 GMT' }, when - 500), 500);
  assert.strictEqual(retryAfterMs({}, 0), null);
  assert.strictEqual(retryAfterMs({ 'retry-after': 'soon' }, 0), null);
}

async function main() {
// Advanced balance is 1/s with no burst. Two shard reads must not leave together.
{
  let t = 0;
  const lim = createKalshiAccountLimiter({
    tier: 'advanced', headroom: 1, now: () => t, random: () => 0,
    sleep: async (ms) => { t += ms; },
  });
  await lim.acquire('GET', '/trade-api/v2/portfolio/balance');
  const afterFirst = t;
  await lim.acquire('GET', '/trade-api/v2/portfolio/balance?x=1');
  assert.ok(t - afterFirst >= 1000, `second balance read waited ${t - afterFirst}ms`);
  assert.strictEqual(lim.rollStats().balance.taken, 2);
}

// Headroom 0.9 spaces balance a little past one second.
{
  let t = 0;
  const lim = createKalshiAccountLimiter({
    tier: 'advanced', headroom: 0.9, now: () => t, random: () => 0,
    sleep: async (ms) => { t += ms; },
  });
  await lim.acquire('GET', '/trade-api/v2/portfolio/balance');
  const a = t;
  await lim.acquire('GET', '/trade-api/v2/portfolio/balance');
  assert.ok(t - a >= 1100, `headroom gap ${t - a}ms`);
}

// A background write waits; a quote post is taken first when tokens return.
{
  let t = 0;
  const waiters = [];
  const lim = createKalshiAccountLimiter({
    tier: 'advanced',
    headroom: 1,
    budgets: { readTok: 10, writeTok: 2, readBurstSec: 1, writeBurstSec: 1, balanceRps: 1 },
    now: () => t,
    random: () => 0,
    sleep: (ms) => new Promise((resolve) => { waiters.push({ at: t + ms, resolve }); }),
  });
  // Spend the whole 10-token write bucket (one order write).
  await lim.acquire('POST', '/trade-api/v2/portfolio/events/orders');
  let lowDone = false;
  let highDone = false;
  const low = lim.acquire('DELETE', '/trade-api/v2/communications/quotes/bg').then(() => { lowDone = true; });
  const high = lim.acquire('POST', '/trade-api/v2/communications/quotes').then(() => { highDone = true; });
  await Promise.resolve();
  // Both are waiting. Advance one sleep at a time. The quote must finish first.
  for (let i = 0; i < 500 && !highDone; i += 1) {
    assert.ok(waiters.length, 'someone is waiting for tokens');
    waiters.sort((a, b) => a.at - b.at);
    const step = waiters.shift();
    t = step.at;
    step.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.strictEqual(highDone, true, 'quote post runs before the queued cancel');
  assert.strictEqual(lowDone, false, 'cancel is still waiting');
  for (let i = 0; i < 500 && !lowDone; i += 1) {
    if (!waiters.length) break;
    waiters.sort((a, b) => a.at - b.at);
    const step = waiters.shift();
    t = step.at;
    step.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.strictEqual(lowDone, true, 'cancel still runs once the quote has its tokens');
}

// 429 without Retry-After backs off about the base, then doubles. Balance base is 1s.
{
  let t = 1000;
  const lim = createKalshiAccountLimiter({
    tier: 'advanced', headroom: 1, now: () => t, random: () => 0,
    sleep: async (ms) => { t += ms; },
  });
  const w1 = lim.note429('GET', '/trade-api/v2/portfolio/balance', {});
  assert.strictEqual(w1, 750, 'jitter at random=0 is 0.75 * 1000');
  const w2 = lim.note429('GET', '/trade-api/v2/portfolio/balance', {});
  assert.strictEqual(w2, 1500);
  const wPost = lim.note429('POST', '/trade-api/v2/communications/quotes', { 'retry-after': '3' });
  assert.strictEqual(wPost, 3000, 'Retry-After seconds, no early retry');
  await lim.acquire('POST', '/trade-api/v2/communications/quotes');
  assert.ok(t >= 1000 + 3000, 'acquire waits out the write backoff');
}

// Cache: a fresh shard is served, a stale one is not, in-flight reads collapse.
{
  let t = 0;
  const cache = createKalshiBalanceCache({ ttlMs: 1000, now: () => t });
  assert.strictEqual(cache.lookup('/trade-api/v2/portfolio/balance?exchange_index=1'), null);
  cache.store('/trade-api/v2/portfolio/balance?exchange_index=1', '{"balance":100}');
  assert.strictEqual(cache.lookup('/trade-api/v2/portfolio/balance?exchange_index=1').text, '{"balance":100}');
  assert.strictEqual(cache.lookup('/trade-api/v2/portfolio/balance?exchange_index=0'), null);
  cache.markStale();
  assert.strictEqual(cache.lookup('/trade-api/v2/portfolio/balance?exchange_index=1'), null);
  cache.store('/trade-api/v2/portfolio/balance?exchange_index=1', '{"balance":90}');
  t = 1000;
  assert.strictEqual(cache.lookup('/trade-api/v2/portfolio/balance?exchange_index=1'), null, 'ttl');
  let fetches = 0;
  const a = cache.coalesce('?exchange_index=1', async () => { fetches += 1; return 'a'; });
  const b = cache.coalesce('?exchange_index=1', async () => { fetches += 1; return 'b'; });
  assert.strictEqual(await a, 'a');
  assert.strictEqual(await b, 'a');
  assert.strictEqual(fetches, 1);
}

{
  let t = 0;
  let reads = 0;
  const { createKalshiBalanceCache, readIfBalanceStale } = require('./kalshi-account-limiter');
  const cache = createKalshiBalanceCache({ ttlMs: 20000, now: () => t });
  const path = '/trade-api/v2/portfolio/balance?exchange_index=1';
  const first = await readIfBalanceStale({ cache, path, read: async () => { reads += 1; cache.store(path, '{"balance":100}'); } });
  assert.strictEqual(first.fetched, true);
  assert.strictEqual(reads, 1);
  const second = await readIfBalanceStale({ cache, path, read: async () => { reads += 1; } });
  assert.strictEqual(second.fetched, false);
  assert.strictEqual(reads, 1, 'fresh cache does not read');
  cache.markStale();
  const third = await readIfBalanceStale({ cache, path, read: async () => { reads += 1; cache.store(path, '{"balance":80}'); } });
  assert.strictEqual(third.fetched, true);
  assert.strictEqual(reads, 2, 'fill or funds failure invalidation forces the next read');
  t = 20000;
  const fourth = await readIfBalanceStale({ cache, path, read: async () => { reads += 1; } });
  assert.strictEqual(fourth.fetched, true, '20s cache expiry reads again');
}

console.log('kalshi-account-limiter.test.js ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
