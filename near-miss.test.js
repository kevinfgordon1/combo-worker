'use strict';
const assert = require('assert');
const { createNearMissLogger, nearThreshold } = require('./near-miss');

const lock = { id: '42b5ee16-aaaa', label: 'DET+MIA+SF', leg_keys: ['KXNFLGAME-26OCT25GBDET-DET:yes', 'KXNFLGAME-26OCT25MIANYJ-MIA:yes', 'KXNFLGAME-26OCT25SFATL-SF:yes'] };
const parlays = [lock];
const lines = [];
let t = 0;
const mk = (env) => createNearMissLogger({ env, log: (l) => lines.push(l), now: () => t, defer: (f) => f() });

// Off by default: no work, no lines.
assert.strictEqual(mk({}).observe({ rfqId: 'a', legKeys: lock.leg_keys.slice(0, 2) }, parlays), null);
assert.strictEqual(lines.length, 0);

assert.strictEqual(nearThreshold(3), 2); assert.strictEqual(nearThreshold(1), 1);
const nm = mk({ COMBO_NEAR_MISS_LOG: '1', COMBO_NEAR_MISS_LOG_MS: '10000' });
// 2 of 3 legs + one other leg -> near miss with missing/extra keys.
let r = nm.observe({ rfqId: 'r1', legKeys: ['KXNFLGAME-26OCT25GBDET-DET:yes', 'KXNFLGAME-26OCT25SFATL-SF:yes', 'KXNFLGAME-26OCT25CINBAL-CIN:yes'] }, parlays);
assert.strictEqual(r.shared, 2);
assert.deepStrictEqual(r.missing, ['KXNFLGAME-26OCT25MIANYJ-MIA:yes']);
assert.deepStrictEqual(r.extra, ['KXNFLGAME-26OCT25CINBAL-CIN:yes']);
assert.strictEqual(lines.length, 1);
assert.ok(/NEAR-MISS rfq=r1 lock=42b5ee16 lockLegs=3 rfqLegs=3 shared=2 missing=KXNFLGAME-26OCT25MIANYJ-MIA:yes extra=KXNFLGAME-26OCT25CINBAL-CIN:yes/.test(lines[0]), lines[0]);

// Rate limit per lock.
t = 5000;
r = nm.observe({ rfqId: 'r2', legKeys: lock.leg_keys.slice(0, 2) }, parlays);
assert.ok(r.suppressed); assert.strictEqual(lines.length, 1);
t = 11000;
nm.observe({ rfqId: 'r3', legKeys: lock.leg_keys.slice(0, 2) }, parlays);
assert.strictEqual(lines.length, 2);

// Not near: 1 of 3 legs, or a 29-leg parlay that merely contains the legs.
t = 100000;
assert.strictEqual(nm.observe({ rfqId: 'x', legKeys: [lock.leg_keys[0], 'KXNFLGAME-26OCT25CINBAL-CIN:yes'] }, parlays), null);
const big = lock.leg_keys.concat(Array.from({ length: 26 }, (_, i) => `KXNFLX-${i}:yes`));
assert.strictEqual(nm.observe({ rfqId: 'y', legKeys: big }, parlays), null);
assert.strictEqual(lines.length, 2);

// Global per-minute cap.
const many = Array.from({ length: 5 }, (_, i) => ({ id: `lock${i}xxxx`, leg_keys: [`KXA-${i}:yes`, `KXB-${i}:yes`] }));
const capped = mk({ COMBO_NEAR_MISS_LOG: '1', COMBO_NEAR_MISS_MAX_PER_MIN: '3' });
const before = lines.length;
t = 200000;
for (let i = 0; i < 5; i++) capped.observe({ rfqId: `c${i}`, legKeys: [`KXA-${i}:yes`] }, many);
assert.strictEqual(lines.length - before, 3);
console.log('near-miss ok');
