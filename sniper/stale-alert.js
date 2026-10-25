// Alerts when more than `ratio` of RFQs over a rolling `windowMs` were skipped as prices_stale.
// One alert per episode; re-arms after a recovery (ratio back under threshold over a full window).
'use strict';

function createStaleAlert({ windowMs = 10 * 60 * 1000, ratio = 0.5, minRfqs = 20, now = () => Date.now(), alert = () => {} } = {}) {
  // Per-second buckets with running totals: O(1) per record. (The old per-event array was
  // reduced on every RFQ — O(n) with ~400k events in the 10-min window at NFL Sunday volume, 80%
  // of main-thread CPU and the Oct 25 2026 stall.)
  const buckets = []; let head = 0; // [secMs, n, stale]
  let n = 0; let s = 0;
  let firing = false; let startedAt = 0;
  function trim(t) {
    while (head < buckets.length && buckets[head][0] < t - windowMs) { n -= buckets[head][1]; s -= buckets[head][2]; head += 1; }
    if (head > 1024 && head * 2 > buckets.length) { buckets.splice(0, head); head = 0; }
  }
  function state(t = now()) {
    trim(t);
    return { n, stale: s, ratio: n ? s / n : 0 };
  }
  function add(t, stale) {
    const sec = t - (t % 1000);
    const last = buckets.length > head ? buckets[buckets.length - 1] : null;
    if (last && last[0] === sec) { last[1] += 1; if (stale) last[2] += 1; } else buckets.push([sec, 1, stale ? 1 : 0]);
    n += 1; if (stale) s += 1;
  }
  function record(stale) {
    const t = now(); add(t, !!stale);
    if (!startedAt) startedAt = t;
    check(t);
  }
  function check(t = now()) {
    const st = state(t);
    const full = t - startedAt >= windowMs;
    if (!firing && full && st.n >= minRfqs && st.ratio > ratio) {
      firing = true;
      alert(`[SNIPER] ⚠️ prices_stale: ${(st.ratio * 100).toFixed(0)}% of ${st.n} RFQs in the last ${Math.round(windowMs / 60000)} min skipped — Kalshi book refresh is stuck; not quoting`);
    } else if (firing && st.ratio <= ratio) {
      firing = false;
      alert(`[SNIPER] ✅ prices_stale recovered: ${(st.ratio * 100).toFixed(0)}% of ${st.n} RFQs in the last ${Math.round(windowMs / 60000)} min`);
    }
    return st;
  }
  return { record, check, state, firing: () => firing };
}

module.exports = { createStaleAlert };
