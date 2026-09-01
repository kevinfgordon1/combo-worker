'use strict';
const assert = require('assert');
const { formatVenueAlert } = require('./venue-alert');

const quotedKalshi = formatVenueAlert('Kalshi', '✅ QUOTED — Sox/Pirates');
const quotedPoly = formatVenueAlert('Polymarket', '✅ QUOTED — Sox/Pirates');
assert.strictEqual(quotedKalshi, 'Kalshi · ✅ QUOTED — Sox/Pirates');
assert.strictEqual(quotedPoly, 'Polymarket · ✅ QUOTED — Sox/Pirates');
assert.ok(quotedKalshi.startsWith('Kalshi ·'));
assert.ok(quotedPoly.startsWith('Polymarket ·'));
assert.notStrictEqual(quotedKalshi, quotedPoly);

const fillKalshi = formatVenueAlert('Kalshi', '✅ FILL CONFIRMED — Sox/Pirates\n+10 contracts');
const fillPoly = formatVenueAlert('Polymarket', '✅ FILL CONFIRMED — Sox/Pirates\n+10 contracts');
assert.ok(fillKalshi.startsWith('Kalshi · ✅ FILL CONFIRMED'));
assert.ok(fillPoly.startsWith('Polymarket · ✅ FILL CONFIRMED'));
assert.ok(fillKalshi.includes('+10 contracts'));
assert.ok(fillPoly.includes('+10 contracts'));

console.log('venue-alert.test.js ok');
