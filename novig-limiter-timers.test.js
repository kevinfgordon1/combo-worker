'use strict';

// Regression (Kevin Nov 2): the Novig limiter's pump() set `timer = null` on EVERY call, not only
// when its own timer fired. Each run() / job completion while requests were queued armed a fresh
// 50 ms setTimeout without clearing the pending one, and every one of those re-armed itself forever
// while the queue stayed non-empty. Live relay after 62h: ~627k pump timers (= 2 x 313k Novig calls),
// each firing every 50 ms -> CPU pegged, ~57% of it in GC, /health 6-19s, fetch timeouts everywhere.
// The limiter must keep AT MOST ONE pending pump timer, however many jobs are queued or finish.
const assert = require('assert');

const realSet = global.setTimeout;
const realClear = global.clearTimeout;
const live = new Set();
let peak = 0;
let armed = 0;
global.setTimeout = function patchedSetTimeout(fn, ms, ...rest) {
  if (fn && fn.name === 'pump') {
    let h;
    const wrapped = function pump() { live.delete(h); return fn(); };
    h = realSet(wrapped, ms, ...rest);
    live.add(h);
    armed += 1;
    if (live.size > peak) peak = live.size;
    return h;
  }
  return realSet(fn, ms, ...rest);
};
global.clearTimeout = function patchedClearTimeout(h) { live.delete(h); return realClear(h); };

const { createLimiter } = require('./odds-relay').novigFeed;

// The pump timer is unref'd; keep the test process alive until the checks finish.
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  // 1. Backlogged limiter (more work than the rate allows): many enqueues + completions.
  const lim = createLimiter({ rps: 20, concurrency: 2 });
  const jobs = [];
  for (let i = 0; i < 60; i += 1) jobs.push(lim.run(() => new Promise((r) => realSet(r, 2)), i % 3 ? 'high' : 'low'));
  await Promise.all(jobs);
  assert.ok(peak <= 1, `at most one pending pump timer while backlogged, peak was ${peak}`);
  assert.strictEqual(live.size, 0, 'no pump timer left once the queue drains');
  // Token wait is computed, not polled every 50 ms: 60 jobs at 20 rps should need well under 200 wakeups.
  assert.ok(armed < 200, `pump timer armed ${armed} times for 60 jobs`);

  // 2. Backoff (429 Retry-After) still holds requests until pausedUntil, then they run.
  peak = 0;
  const lim2 = createLimiter({ rps: 1000, concurrency: 1 });
  lim2.backoff(120);
  const t0 = Date.now();
  const done = [];
  await Promise.all([1, 2, 3].map((n) => lim2.run(() => done.push(n), 'high')));
  assert.ok(Date.now() - t0 >= 100, 'paused requests waited for the backoff');
  assert.deepStrictEqual(done, [1, 2, 3]);
  assert.ok(peak <= 1, `one pump timer during backoff, peak ${peak}`);

  // 3. Rate is still respected: 10 jobs at 5 rps (5-token burst, then 1 per 200 ms) take >= ~1s.
  const lim3 = createLimiter({ rps: 5, concurrency: 4 });
  const t1 = Date.now();
  await Promise.all(Array.from({ length: 10 }, () => lim3.run(() => null, 'mid')));
  assert.ok(Date.now() - t1 >= 900, `rate limit kept (${Date.now() - t1}ms)`);
  assert.ok(lim3.stats().timerArmed === false, 'stats reports no armed timer when idle');

  console.log('novig-limiter-timers ok');
  clearInterval(keepAlive);
})().catch((err) => { console.error(err); process.exit(1); });
