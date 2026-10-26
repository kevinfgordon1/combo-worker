// Kevin's Kalshi account write budget, split statically between two Fly apps that share it:
//   - kaygo-sniper (this process)          -> at most account - reserved (default 15 - 9 = 6/s)
//   - kaygo-combo-worker (Kevin's Combo Locks) -> the reserved 9/s, guaranteed because the
//     sniper can never take more than its share.
// Static per-app budgets (no cross-app shared counter): the two apps are separate Fly machines,
// and a shared Redis/Supabase token bucket would add a network hop to every order write plus a
// new failure mode. A hard ceiling on the sniper is enough to guarantee Combo Locks its share.
// Borrowing: with SNIPER_KALSHI_BORROW=1 the sniper may add up to (reserved - safety) slots/s
// while Combo Locks is verifiably idle (sniper/kalshi-lane.js). KALSHI_ACCOUNT_WRITE_RPS stays the
// configurable account total.
// Other users (testers app) use their own Kalshi keys and are not affected.
'use strict';

const num = (v, d) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : d; };

function sniperKalshiTradeBudget(env = process.env) {
  const account = Math.max(1, num(env.KALSHI_ACCOUNT_WRITE_RPS, 15));
  const reserved = Math.max(0, num(env.COMBO_LOCKS_RESERVED_RPS, 9));
  const ceiling = Math.max(1, account - reserved);
  const requested = num(env.SNIPER_KALSHI_TRADE_RPS, ceiling);
  const rps = Math.max(1, Math.min(ceiling, requested));
  // After any 429 the sniper permanently steps down to this (until restart). Never above rps.
  const on429 = Math.max(1, Math.min(rps, num(env.SNIPER_KALSHI_TRADE_RPS_ON_429, 4)));
  return { account, reserved, ceiling, requested, rps, on429, clamped: requested > ceiling };
}

module.exports = { sniperKalshiTradeBudget };
