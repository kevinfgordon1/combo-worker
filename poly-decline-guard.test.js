'use strict';
const assert = require('assert');
const { createDeclineGuard, readDeclineGuardConfig } = require('./poly-decline-guard');

// config
{
  const c = readDeclineGuardConfig({});
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.ratio, 0.04);
  assert.strictEqual(c.minDeclines, 3);
  assert.strictEqual(c.lockMaxDeclines, 2);
  assert.strictEqual(c.windowMs, 3_600_000);
  assert.strictEqual(readDeclineGuardConfig({ POLY_COMBO_DECLINE_GUARD: '0' }).enabled, false);
  assert.strictEqual(readDeclineGuardConfig({ POLY_COMBO_DECLINE_RATIO: '0.08' }).ratio, 0.08);
  assert.strictEqual(readDeclineGuardConfig({ POLY_COMBO_DECLINE_RATIO: 'x' }).ratio, 0.04);
}

// Nov 1 replay: 68 of 70 declined. Old code kept posting through all 68; the guard stops all
// Combo Locks Polymarket posting at the 3rd decline and each lock at its 2nd.
{
  let t = 1_000_000;
  const logs = [];
  const g = createDeclineGuard({}, { now: () => t, log: (m) => logs.push(m) });
  assert.strictEqual(g.check('A'), null);
  g.record({ parlayId: 'A', confirmed: true });
  g.record({ parlayId: 'B', confirmed: true });
  let r = g.record({ parlayId: 'A', confirmed: false, reason: 'cap_exceeded' });
  assert.deepStrictEqual(r, { lockTripped: false, accountTripped: false });
  assert.strictEqual(g.check('A'), null, 'one decline is not enough');
  r = g.record({ parlayId: 'A', confirmed: false, reason: 'cap_exceeded' });
  assert.strictEqual(r.lockTripped, true);
  assert.strictEqual(g.check('A').reason, 'lock_declines');
  assert.strictEqual(g.check('B'), null, 'other locks keep quoting');
  r = g.record({ parlayId: 'C', confirmed: false, reason: 'confirm_failed' });
  assert.strictEqual(r.accountTripped, true, '3 declines / 5 accepts = 60% > 4%');
  assert.strictEqual(g.check('B').reason, 'combo_decline_rate');
  const s = g.stats();
  assert.strictEqual(s.accountPaused, true);
  assert.deepStrictEqual(s.byReason, { cap_exceeded: 2, confirm_failed: 1 });
  assert.ok(logs.some((m) => /stops posting on Polymarket/.test(m)));
  // lock cooldown 30m, account window 1h
  t += 31 * 60_000;
  assert.strictEqual(g._lockUntil.has('A'), true);
  assert.strictEqual(g.check('A').reason, 'combo_decline_rate');
  t += 30 * 60_000; // window passed: everything aged out
  assert.strictEqual(g.check('A'), null);
  assert.strictEqual(g.stats().accountPaused, false);
  assert.ok(logs.some((m) => /account cleared/.test(m)));
}

// A healthy desk: 2 declines in 100 accepts never trips the account guard (2 < min 3; and 3/100 = 3% < 4%).
{
  const g = createDeclineGuard({}, { now: () => 5 });
  for (let i = 0; i < 97; i += 1) g.record({ parlayId: `L${i}`, confirmed: true });
  g.record({ parlayId: 'x1', confirmed: false, reason: 'game_started' });
  g.record({ parlayId: 'x2', confirmed: false, reason: 'game_started' });
  g.record({ parlayId: 'x3', confirmed: false, reason: 'game_started' });
  assert.strictEqual(g.check('L1'), null);
  assert.strictEqual(g.stats().accountPaused, false);
}

// Off switch
{
  const g = createDeclineGuard({ enabled: false }, { now: () => 5 });
  for (let i = 0; i < 10; i += 1) g.record({ parlayId: 'A', confirmed: false, reason: 'x' });
  assert.strictEqual(g.check('A'), null);
}

console.log('poly-decline-guard tests ok');
