'use strict';
// ─────────────────────────────────────────────────────────────────────────
// latency-stats.js — observability for the Kalshi quote path (no order logic).
//
//  • createLatencyStats()  per-heartbeat-interval counters + histograms:
//      quote_ms   histogram of match→POST-complete (the [LAT] total)
//      intake_ms  histogram of RFQ age when our handler first sees a lock-matched
//                 RFQ (now − rfq.created_ts). This is the WS/loop/backlog delay
//                 BEFORE we can even start a POST — the thing [LAT] never saw.
//      posted_age_ms  histogram of RFQ age when the POST returned
//      late_posts     quotes that landed > LATE_POST_MS after the RFQ was created
//      rfq_closed     409 rfq_closed POST failures
//      post_failed / posted
//      reconnects / reconnect_by_reason / max_gap_ms   (from kalshi-ws shards)
//      loop_lag_ms  p50 / p99 / max event-loop delay (perf_hooks histogram)
//  • rollInterval() returns the finished snapshot (jsonb for combo_worker_stats.latency)
//    and starts a new window, like poly-intake.
// ─────────────────────────────────────────────────────────────────────────

const LATE_POST_MS = 1000;
const BUCKETS = [25, 50, 100, 250, 500, 1000, 2500, 10000]; // upper bounds, ms; last bin is +Inf

function emptyHist() {
  return { n: 0, sum: 0, max: 0, bins: new Array(BUCKETS.length + 1).fill(0) };
}

function histAdd(h, ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  h.n += 1;
  h.sum += ms;
  if (ms > h.max) h.max = ms;
  let i = 0;
  while (i < BUCKETS.length && ms > BUCKETS[i]) i += 1;
  h.bins[i] += 1;
}

function histQuantile(h, q) {
  if (!h.n) return null;
  const target = Math.ceil(h.n * q);
  let seen = 0;
  for (let i = 0; i < h.bins.length; i++) {
    seen += h.bins[i];
    if (seen >= target) return i < BUCKETS.length ? BUCKETS[i] : Math.round(h.max);
  }
  return Math.round(h.max);
}

function histJson(h) {
  const bins = {};
  for (let i = 0; i < h.bins.length; i++) {
    if (!h.bins[i]) continue;
    bins[i < BUCKETS.length ? `le_${BUCKETS[i]}` : 'gt_' + BUCKETS[BUCKETS.length - 1]] = h.bins[i];
  }
  return {
    n: h.n,
    avg: h.n ? Math.round((h.sum / h.n) * 10) / 10 : null,
    p50: histQuantile(h, 0.5),
    p90: histQuantile(h, 0.9),
    p99: histQuantile(h, 0.99),
    max: Math.round(h.max * 10) / 10,
    bins,
  };
}

function ageMs(createdTs, nowMs) {
  if (createdTs == null || createdTs === '') return null;
  const t = typeof createdTs === 'number' ? (createdTs < 1e12 ? createdTs * 1000 : createdTs) : Date.parse(createdTs);
  if (!Number.isFinite(t)) return null;
  const a = nowMs - t;
  return a >= -2000 ? Math.max(0, a) : null; // ignore absurd clock skew
}

function createLatencyStats({ now = () => Date.now(), lateMs = LATE_POST_MS } = {}) {
  let startedAt = now();
  let cur = fresh();
  const total = { posted: 0, post_failed: 0, rfq_closed: 0, late_posts: 0, reconnects: 0, stale_skipped: 0 };

  function fresh() {
    return {
      quote: emptyHist(), intake: emptyHist(), postedAge: emptyHist(),
      posted: 0, post_failed: 0, rfq_closed: 0, late_posts: 0, late_failed: 0,
      subcent_fallback: 0, stale_skipped: 0,
    };
  }

  // A lock-matched RFQ just reached our handler.
  function noteIntake(createdTs) {
    const a = ageMs(createdTs, now());
    if (a != null) histAdd(cur.intake, a);
    return a;
  }

  // POST finished (ok or failed). totalMs = [LAT] total (match → POST done).
  function notePost({ totalMs, createdTs, ok, rfqClosed = false } = {}) {
    if (Number.isFinite(Number(totalMs))) histAdd(cur.quote, Number(totalMs));
    const a = ageMs(createdTs, now());
    if (a != null) histAdd(cur.postedAge, a);
    const late = a != null && a > lateMs;
    if (ok) {
      cur.posted += 1; total.posted += 1;
      if (late) { cur.late_posts += 1; total.late_posts += 1; }
    } else {
      cur.post_failed += 1; total.post_failed += 1;
      if (late) cur.late_failed += 1;
      if (rfqClosed) { cur.rfq_closed += 1; total.rfq_closed += 1; }
    }
    return { ageMs: a, late };
  }

  function noteStaleSkip() { cur.stale_skipped += 1; total.stale_skipped += 1; }
  function staleSkipsTotal() { return total.stale_skipped; }

  function noteSubcentFallback() { cur.subcent_fallback += 1; }
  function noteReconnects(n) { if (n > 0) total.reconnects += n; }

  // ws = { count, byReason, maxGapMs }, loop = { p50, p99, max, mean } in ms, extra = { backlog, ... }
  function rollInterval({ ws = null, loop = null, extra = null } = {}) {
    const t = now();
    const snap = {
      interval_s: Math.round((t - startedAt) / 1000),
      quote_ms: histJson(cur.quote),
      intake_ms: histJson(cur.intake),
      posted_age_ms: histJson(cur.postedAge),
      posted: cur.posted,
      post_failed: cur.post_failed,
      rfq_closed: cur.rfq_closed,
      late_posts: cur.late_posts,
      late_failed: cur.late_failed,
      late_post_ms: lateMs,
      subcent_fallback: cur.subcent_fallback,
      stale_skipped: cur.stale_skipped,
      reconnects: ws ? ws.count : 0,
      reconnect_by_reason: ws ? ws.byReason : {},
      resubscribe_gap_max_ms: ws && ws.maxGapMs != null ? ws.maxGapMs : null,
      loop_lag_ms: loop,
      ...(extra || {}),
    };
    if (ws) noteReconnects(ws.count);
    cur = fresh();
    startedAt = t;
    return snap;
  }

  function formatLine(snap) {
    const s = snap;
    const q = s.quote_ms; const i = s.intake_ms;
    const loop = s.loop_lag_ms || {};
    return (
      `[LATENCY] interval=${s.interval_s}s posted=${s.posted} failed=${s.post_failed} ` +
      `rfq_closed=${s.rfq_closed} late_posts=${s.late_posts}(>${s.late_post_ms}ms) ` +
      `quote_ms p50=${q.p50} p99=${q.p99} max=${q.max} ` +
      `intake_age_ms p50=${i.p50} p99=${i.p99} max=${i.max} n=${i.n} ` +
      `reconnects=${s.reconnects} gap_max_ms=${s.resubscribe_gap_max_ms} ` +
      `loop_lag_ms p99=${loop.p99} max=${loop.max}` +
      (s.stale_skipped ? ` stale_skipped=${s.stale_skipped}` : '') +
      (s.subcent_fallback ? ` subcent_fallback=${s.subcent_fallback}` : '')
    );
  }

  return {
    noteIntake, notePost, noteSubcentFallback, noteStaleSkip, staleSkipsTotal, noteReconnects, rollInterval, formatLine,
    totals: () => ({ ...total }),
    peek: () => ({ posted: cur.posted, post_failed: cur.post_failed, late_posts: cur.late_posts, rfq_closed: cur.rfq_closed }),
  };
}

// perf_hooks event-loop delay sampler (resolution 10ms). take() → ms stats then reset.
function createLoopLagSampler() {
  let h = null;
  try {
    const { monitorEventLoopDelay } = require('perf_hooks');
    h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
  } catch (_) { h = null; }
  const ms = (ns) => Math.round((ns / 1e6) * 10) / 10;
  return {
    take() {
      if (!h) return null;
      const out = { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max), mean: ms(h.mean) };
      h.reset();
      return out;
    },
    stop() { try { h && h.disable(); } catch (_) {} },
  };
}

module.exports = {
  LATE_POST_MS, BUCKETS, createLatencyStats, createLoopLagSampler, ageMs, histAdd, histQuantile, emptyHist, histJson,
};
