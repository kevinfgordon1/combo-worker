'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { sniperKalshiTradeBudget: b } = require('./kalshi-budget');
const { createLimiter } = require('./limiter');
(async () => {
  // defaults: 15 account - 9 Combo Locks = 6/s sniper, 4/s after 429
  let x = b({});
  assert.strictEqual(x.rps, 6); assert.strictEqual(x.on429, 4); assert.strictEqual(x.reserved, 9);
  assert.ok(x.rps + x.reserved <= x.account);
  // old 15/s setting is clamped so Combo Locks keeps 9/s
  x = b({ SNIPER_KALSHI_TRADE_RPS: '15' }); assert.strictEqual(x.rps, 6); assert.strictEqual(x.clamped, true);
  // lower requested is honored; on429 never exceeds rps
  x = b({ SNIPER_KALSHI_TRADE_RPS: '3' }); assert.strictEqual(x.rps, 3); assert.strictEqual(x.on429, 3);
  // garbage / extreme reserve still leaves >= 1/s
  x = b({ SNIPER_KALSHI_TRADE_RPS: 'abc', COMBO_LOCKS_RESERVED_RPS: '20' }); assert.strictEqual(x.rps, 1);
  // shipped sniper.toml stays inside the split
  const toml = fs.readFileSync(path.join(__dirname, '..', 'fly', 'sniper.toml'), 'utf8');
  const env = {}; for (const m of toml.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)) env[m[1]] = m[2];
  x = b(env); assert.strictEqual(x.rps, 45); assert.strictEqual(x.on429, 20); assert.strictEqual(x.clamped, false); assert.ok(x.rps + x.reserved <= x.account);
  // limiter steps down after a 429 and keeps urgent-cancel priority
  let t = 0; const lim = createLimiter({ name: 'k', ratePerSec: 6, ratePerSecOn429: 4, burst: 1, now: () => t, sleep: async (ms) => { t += ms; } });
  await assert.rejects(lim.run(async () => ({ status: 429 })), /429/);
  assert.strictEqual(lim.stats().ratePerSec, 4); assert.strictEqual(lim.stats().degraded, true);
  t += 60000; // clear backoff
  const order = []; let release; const gate = new Promise((r) => { release = r; });
  const hold = lim.run(async () => { await gate; return { ok: true, status: 200 }; });
  const normal = lim.run(async () => { order.push('normal'); return { ok: true, status: 200 }; }, { priority: 1 });
  const urgent = lim.run(async () => { order.push('urgent'); return { ok: true, status: 200 }; }, { priority: 2 });
  release(); await Promise.all([hold, normal, urgent]);
  assert.deepStrictEqual(order, ['urgent', 'normal']);
  console.log('kalshi-budget ok');
})().catch((e) => { console.error(e); process.exit(1); });
