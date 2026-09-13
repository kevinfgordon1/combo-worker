'use strict';
const assert = require('assert');
const { VENUE_LABELS, venueLabel, formatAlertStatus } = require('./venue-alert');

assert.strictEqual(VENUE_LABELS.kalshi, 'Kalshi');
assert.strictEqual(VENUE_LABELS.polymarket, 'Polymarket');

assert.strictEqual(venueLabel('kalshi'), 'Kalshi');
assert.strictEqual(venueLabel('KALSHI'), 'Kalshi');
assert.strictEqual(venueLabel(' polymarket '), 'Polymarket');
assert.strictEqual(venueLabel('Polymarket'), 'Polymarket');
assert.strictEqual(venueLabel(''), '');
assert.strictEqual(venueLabel(null), '');
assert.strictEqual(venueLabel(undefined), '');
assert.strictEqual(venueLabel('binance'), '', 'unknown venues stay unlabeled');

assert.strictEqual(formatAlertStatus('✅ QUOTED', 'kalshi'), '✅ QUOTED (Kalshi)');
assert.strictEqual(formatAlertStatus('✅ QUOTED', 'polymarket'), '✅ QUOTED (Polymarket)');
assert.strictEqual(formatAlertStatus('❌ QUOTE LATE', 'kalshi'), '❌ QUOTE LATE (Kalshi)');
assert.strictEqual(formatAlertStatus('❌ QUOTE FAILED', 'kalshi'), '❌ QUOTE FAILED (Kalshi)');
assert.strictEqual(formatAlertStatus('❌ CONFIRM FAILED', 'kalshi'), '❌ CONFIRM FAILED (Kalshi)');
assert.strictEqual(
  formatAlertStatus('✅ FILL CONFIRMED', 'polymarket'),
  '✅ FILL CONFIRMED (Polymarket)'
);
assert.strictEqual(
  formatAlertStatus('✅ FILL CONFIRMED', 'kalshi'),
  '✅ FILL CONFIRMED (Kalshi)'
);
assert.strictEqual(formatAlertStatus('⏭️ RFQ REPEAT', 'kalshi'), '⏭️ RFQ REPEAT (Kalshi)');
assert.strictEqual(formatAlertStatus('✅ QUOTED', null), '✅ QUOTED');
assert.strictEqual(formatAlertStatus('✅ QUOTED'), '✅ QUOTED');

{
  const quoted = `${formatAlertStatus('✅ QUOTED', 'kalshi')} — Ari + Jax\n` +
    `rfq abcde · quote 12345\n` +
    `match→POST 42.0ms\n` +
    `6 contracts · NO @ $0.12`;
  assert.ok(quoted.startsWith('✅ QUOTED (Kalshi) — Ari + Jax'));
  assert.ok(quoted.includes('match→POST 42.0ms'));
  assert.ok(!quoted.includes('✅ QUOTED —'));
}

console.log('venue-alert.test.js ok');
