'use strict';
const assert = require('assert');
const { createRiskBook, riskConfigFromEnv, RISK_DEFAULTS } = require('./noboost-risk');

let t = Date.parse('2026-10-04T12:00:00-04:00');
const now = () => t;
const L = (g, team) => ({ gameId: g, team });

assert.strictEqual(riskConfigFromEnv({}).maxTotalLoss, RISK_DEFAULTS.maxTotalLoss);
assert.strictEqual(riskConfigFromEnv({ NOBOOST_MAX_GAME_LOSS: '10' }).maxGameLoss, 10);
assert.strictEqual(riskConfigFromEnv({}).dailyLossLimit, 0, 'daily loss limit optional/off');

// max loss = contracts*(1-price)
{
  const r = createRiskBook({ maxComboLoss: 100, maxGameLoss: 150, maxSelectionLoss: 120, maxTotalLoss: 300 }, { now });
  const legs = [L('g1', 'a'), L('g2', 'b')];
  assert.strictEqual(r.check(legs, 0.2, 100).ok, true);          // loss 80
  assert.strictEqual(r.check(legs, 0.2, 200).reason, 'combo_cap'); // loss 160 > 100
  assert.ok(r.addFill('f1', legs, 0.2, 100));
  assert.strictEqual(r.addFill('f1', legs, 0.2, 100), false, 'idempotent');
  assert.strictEqual(r.total(), 80);
  // second fill on the same games -> 160 > 150 game cap
  assert.strictEqual(r.check(legs, 0.2, 100).reason, 'game_cap');
  assert.strictEqual(r.check([L('g1', 'c'), L('g3', 'd')], 0.2, 100).reason, 'game_cap');
  // different games -> ok
  assert.strictEqual(r.check([L('g4', 'e'), L('g5', 'f')], 0.2, 100).ok, true);
  r.addFill('f2', [L('g4', 'e'), L('g5', 'f')], 0.2, 100);
  r.addFill('f3', [L('g6', 'e'), L('g7', 'f')], 0.2, 100);
  assert.strictEqual(r.check([L('g8', 'x'), L('g9', 'y')], 0.2, 100).reason, 'total_cap');
  // skew util: 240/300 = .8
  assert.ok(Math.abs(r.utilization([L('g8', 'x')]) - 0.8) < 1e-9);
  // settle: hit => lose contracts - premium; miss => keep premium
  assert.strictEqual(r.settle('f1', true), 20 - 100);
  assert.strictEqual(r.settle('f2', false), 20);
  assert.strictEqual(r.total(), 80);
  assert.strictEqual(r.settle('nope', true), null);
}

// per-selection cap binds before game cap when the game cap is looser
{
  const r = createRiskBook({ maxComboLoss: 100, maxGameLoss: 1000, maxSelectionLoss: 120, maxTotalLoss: 1000 }, { now });
  r.addFill('s1', [L('g1', 'a'), L('g2', 'b')], 0.2, 100);
  assert.strictEqual(r.check([L('g1', 'a'), L('g3', 'c')], 0.2, 100).reason, 'selection_cap');
  assert.strictEqual(r.check([L('g1', 'z'), L('g3', 'c')], 0.2, 100).ok, true);
}

// daily loss limit
{
  const r = createRiskBook({ dailyLossLimit: 50 }, { now });
  r.addFill('a', [L('g1', 'a'), L('g2', 'b')], 0.1, 100);
  assert.strictEqual(r.check([L('g3', 'a'), L('g4', 'b')], 0.1, 10).ok, true);
  r.settle('a', true); // -90
  assert.strictEqual(r.dailyHalted(), true);
  assert.strictEqual(r.check([L('g3', 'a'), L('g4', 'b')], 0.1, 10).reason, 'daily_loss_limit');
  t += 24 * 3600e3; // next ET day resets
  assert.strictEqual(r.dailyHalted(), false);
}

// quote pull: ttl, edge gone, below lock, unpriceable
{
  t = 1e12;
  const r = createRiskBook({ ttlMs: 5000, pullMinEdge: 0.03 }, { now });
  const q = (quoteYes, guardrail = true) => ({ venue: 'kalshi', legs: [L('g1', 'a')], quoteYes, fair: 0.2, contracts: 10, guardrail });
  r.registerQuote('ok', q(0.25));
  r.registerQuote('moved', q(0.25));
  r.registerQuote('lock', q(0.25));
  r.registerQuote('gone', q(0.25));
  const rep = (q2) => ({ ok: { fair: 0.2, yLock: 0.2 }, moved: { fair: 0.26, yLock: 0.2 }, lock: { fair: 0.2, yLock: 0.3 }, gone: null })[q2.rfqId];
  const pulled = r.sweepQuotes(rep);
  const by = Object.fromEntries(pulled.map((p) => [p.rfqId, p.reason]));
  assert.deepStrictEqual(by, { moved: 'edge_gone', lock: 'below_lock', gone: 'unpriceable' });
  t += 6000;
  assert.deepStrictEqual(r.sweepQuotes(rep).map((p) => p.reason), ['ttl']);
  // cap on open quotes
  const r2 = createRiskBook({ maxOpenQuotes: 2 }, { now });
  r2.registerQuote('1', q(0.25)); r2.registerQuote('2', q(0.25)); r2.registerQuote('3', q(0.25));
  assert.strictEqual(r2.snapshot().openQuotes, 2);
}
console.log('noboost-risk.test.js ok');
