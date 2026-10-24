'use strict';
// Depth = potential PROFIT, not stake (Kevin: $3,000 bettable at −200 is $1,500 of depth).
const assert = require('assert');
const { walk } = require('./pm-live');
const { vwapFor } = require('./td-book');
// Novig ($0 fee) −200 opposing side: 2/3 per contract, wins 1/3.
const c = 2 / 3;
assert.strictEqual(walk([[c, 4500]], 'novig', 1500).fail, undefined, '$3,000 stake at −200 = $1,500 depth');
assert.ok(Math.abs(walk([[c, 4500]], 'novig', 1500).stakeUsd - 3000) < 1e-6);
assert.strictEqual(walk([[c, 4499]], 'novig', 1500).fail, 'depth');
assert.ok(Math.abs(walk([[c, 4500]], 'novig', 1000).availUsd - 1500) < 1e-6, 'availUsd is profit $');
// +150 underdog side (0.40): $1,000 stake wins $1,500.
assert.ok(Math.abs(walk([[0.4, 2500]], 'novig', 1500).stakeUsd - 1000) < 1e-6);
// td-book uses the same unit
const v = vwapFor([[0.4, 2500]], 1500, () => 0);
assert.ok(v && Math.abs(v.stakeUsd - 1000) < 1e-6);
assert.strictEqual(vwapFor([[0.4, 2400]], 1500, () => 0), null);
console.log('depth-profit ok');
