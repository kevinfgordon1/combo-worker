// Alerts when more than `ratio` of RFQs over a rolling `windowMs` were skipped as prices_stale.
// One alert per episode; re-arms after a recovery (ratio back under threshold over a full window).
'use strict';

function createStaleAlert({ windowMs = 10 * 60 * 1000, ratio = 0.5, minRfqs = 20, now = () => Date.now(), alert = () => {} } = {}) {
  const ev = []; // [tsMs, stale(bool)]
  let firing = false; let startedAt = 0;
  function trim(t) { while (ev.length && ev[0][0] < t - windowMs) ev.shift(); }
  function state(t = now()) {
    trim(t);
    const n = ev.length; const s = ev.reduce((a, e) => a + (e[1] ? 1 : 0), 0);
    return { n, stale: s, ratio: n ? s / n : 0 };
  }
  function record(stale) {
    const t = now(); ev.push([t, !!stale]);
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
