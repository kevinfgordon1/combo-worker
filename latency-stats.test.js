'use strict';
const assert = require('assert');
const { createLatencyStats, createLoopLagSampler, ageMs, emptyHist, histAdd, histQuantile, BUCKETS, LATE_POST_MS } = require('./latency-stats');

let t = Date.parse('2026-10-04T18:00:00.000Z');
const clock = () => t;
const iso = (ms) => new Date(ms).toISOString();

// ageMs
assert.strictEqual(ageMs(iso(t - 250), t), 250);
assert.strictEqual(ageMs(null, t), null);
assert.strictEqual(ageMs('garbage', t), null);
assert.strictEqual(ageMs(iso(t + 60_000), t), null, 'future timestamps (clock skew) are ignored');
assert.strictEqual(ageMs(iso(t + 500), t), 0, 'tiny skew clamps to 0');

// histogram
{
  const h = emptyHist();
  [10, 20, 30, 40, 900, 5000].forEach((x) => histAdd(h, x));
  assert.strictEqual(h.n, 6);
  assert.strictEqual(histQuantile(h, 0.5), 50);
  assert.strictEqual(histQuantile(h, 0.99), 10000);
  assert.strictEqual(h.bins.length, BUCKETS.length + 1);
  histAdd(h, 60_000);
  assert.strictEqual(histQuantile(h, 1), 60000, 'overflow bin reports the real max');
}

// late-post counter, rfq_closed counter, quote-latency histogram, intake age
{
  const s = createLatencyStats({ now: clock });
  s.noteIntake(iso(t - 40));
  s.noteIntake(iso(t - 6000));
  const ok = s.notePost({ totalMs: 28, createdTs: iso(t - 60), ok: true });
  assert.strictEqual(ok.late, false);
  const late = s.notePost({ totalMs: 31, createdTs: iso(t - (LATE_POST_MS + 500)), ok: true });
  assert.strictEqual(late.late, true);
  const closed = s.notePost({ totalMs: 22, createdTs: iso(t - 4000), ok: false, rfqClosed: true });
  assert.strictEqual(closed.late, true);
  s.notePost({ totalMs: 40, createdTs: iso(t - 10), ok: false, rfqClosed: false });
  s.noteSubcentFallback();
  t += 60_000;
  const snap = s.rollInterval({
    ws: { count: 3, byReason: { channel_error: 3 }, maxGapMs: 412 },
    loop: { p50: 0.1, p99: 3, max: 9, mean: 0.4 },
    extra: { ws_backlog: 0 },
  });
  assert.strictEqual(snap.interval_s, 60);
  assert.strictEqual(snap.posted, 2);
  assert.strictEqual(snap.post_failed, 2);
  assert.strictEqual(snap.rfq_closed, 1);
  assert.strictEqual(snap.late_posts, 1);
  assert.strictEqual(snap.late_failed, 1);
  assert.strictEqual(snap.reconnects, 3);
  assert.deepStrictEqual(snap.reconnect_by_reason, { channel_error: 3 });
  assert.strictEqual(snap.resubscribe_gap_max_ms, 412);
  assert.strictEqual(snap.quote_ms.n, 4);
  assert.strictEqual(snap.quote_ms.max, 40);
  assert.strictEqual(snap.quote_ms.p50, 50);
  assert.strictEqual(snap.intake_ms.n, 2);
  assert.strictEqual(snap.intake_ms.max, 6000);
  assert.strictEqual(snap.subcent_fallback, 1);
  assert.strictEqual(snap.loop_lag_ms.p99, 3);
  assert.strictEqual(snap.ws_backlog, 0);
  assert.doesNotThrow(() => JSON.stringify(snap));
  const line = s.formatLine(snap);
  assert.ok(/^\[LATENCY\] interval=60s posted=2 failed=2 rfq_closed=1 late_posts=1\(>1000ms\)/.test(line), line);
  assert.ok(/reconnects=3 gap_max_ms=412/.test(line));
  // interval reset, totals persist
  t += 1000;
  const next = s.rollInterval();
  assert.strictEqual(next.posted, 0);
  assert.strictEqual(next.late_posts, 0);
  assert.strictEqual(next.quote_ms.n, 0);
  assert.strictEqual(next.quote_ms.p50, null);
  assert.deepStrictEqual(s.totals(), { posted: 2, post_failed: 2, rfq_closed: 1, late_posts: 1, reconnects: 3, stale_skipped: 0 });
}

// loop-lag sampler returns numbers and resets
{
  const l = createLoopLagSampler();
  const x = l.take();
  assert.ok(x === null || (typeof x.p99 === 'number' && typeof x.max === 'number'));
  l.stop();
}
{
  const L = createLatencyStats({ now: () => 100000 });
  L.noteStaleSkip(); L.noteStaleSkip();
  assert.strictEqual(L.staleSkipsTotal(), 2);
  const snap = L.rollInterval({});
  assert.strictEqual(snap.stale_skipped, 2);
  assert.ok(L.formatLine(snap).includes('stale_skipped=2'));
  assert.strictEqual(L.rollInterval({}).stale_skipped, 0);
  assert.strictEqual(L.staleSkipsTotal(), 2, 'lifetime total survives interval rolls');
}

console.log('latency-stats.test.js ok');
