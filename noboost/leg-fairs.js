'use strict';
// leg_fairs: Kalshi per-leg values + the live inverse-bet per-leg fair (what Combo Sniper uses).
function legFairsWithInverse(pr, pm) {
  const base = pr && pr.legFairs ? pr.legFairs : null;
  const inv = (pm && pm.pm_inverse_legs) || [];
  if (!base && !inv.length) return null;
  const n = Math.max(base ? base.length : 0, inv.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = inv[i] && inv[i].fairAmerican != null ? inv[i].fairAmerican : null;
    const pInv = inv[i] && inv[i].p != null ? inv[i].p : (f == null ? null : (f < 0 ? -f / (100 - f) : 100 / (100 + f)));
    out.push({ ...((base && base[i]) || {}), inverseLive: pInv == null ? null : Math.round(pInv * 1e6) / 1e6, inverseLiveAmerican: f, inverseSource: inv[i] ? inv[i].best || null : null });
  }
  return out;
}

module.exports = { legFairsWithInverse };
