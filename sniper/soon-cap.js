// Kevin Oct 26: parlays whose legs ALL settle within SNIPER_SOON_HOURS (default 24h) may use the
// sniper subaccount's live cash balance as their total open-risk cap (never below the normal
// SNIPER_TOTAL_EXPOSURE_CAP). Later parlays keep the normal total cap (and the long cap).
// Unknown / stale balance (> staleMs) or unknown settle time => normal cap (fail closed).
'use strict';

// GET /portfolio/subaccounts/balances -> $ cash for subaccount `sub` (summed over exchange shards).
function parseSubBalanceUsd(json, sub) {
  const rows = (json && json.subaccount_balances) || [];
  let usd = 0; let seen = false;
  for (const r of rows) {
    if (Number(r.subaccount_number) !== Number(sub)) continue;
    const v = Number(r.balance); if (!Number.isFinite(v)) continue;
    usd += v; seen = true;
  }
  return seen ? usd : null;
}

function createSoonCap({ totalCap, hours = 24, staleMs = 5 * 60 * 1000, enabled = true, fetchBalanceUsd = null, now = () => Date.now(), log = () => {} } = {}) {
  let bal = null; let at = 0; let errs = 0;
  async function refresh() {
    if (!enabled || !fetchBalanceUsd) return null;
    try {
      const v = await fetchBalanceUsd();
      if (Number.isFinite(v) && v >= 0) { bal = v; at = now(); errs = 0; }
    } catch (e) { errs += 1; if (errs <= 3 || errs % 20 === 0) log(`[SNIPER] soon-cap balance read failed: ${e.message}`); }
    return bal;
  }
  function balance() { return bal != null && now() - at <= staleMs ? bal : null; }
  function isSoon(settleAt, nowMs = now()) {
    return Number.isFinite(settleAt) && settleAt > 0 && settleAt - nowMs <= hours * 3600e3;
  }
  // -> total open-risk cap that applies to a parlay settling at `settleAt`.
  function capFor(settleAt, nowMs = now()) {
    if (!enabled || !isSoon(settleAt, nowMs)) return totalCap;
    const b = balance();
    return b != null && b > totalCap ? Math.floor(b * 100) / 100 : totalCap;
  }
  return { refresh, balance, isSoon, capFor, stats: () => ({ enabled, hours, balance: balance(), totalCap }) };
}

module.exports = { createSoonCap, parseSubBalanceUsd };
