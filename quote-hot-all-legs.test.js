'use strict';
const assert = require('assert');
const { lockNeedlePlan, createQuoteHot, compileGroupMatcher, needleAllDisabled } = require('./quote-hot');

const lock = { leg_keys: ['KXNFLGAME-26SEP13NESEA-SEA:yes', 'KXNFLGAME-26SEP13SFLAR-LAR:yes'] };
const frame = (legs) => JSON.stringify({ type: 'rfq_created', msg: { mve_selected_legs: legs.map((t) => ({ market_ticker: t, side: 'yes' })) } });
const exact = frame(['KXNFLGAME-26SEP13NESEA-SEA', 'KXNFLGAME-26SEP13SFLAR-LAR']);
const oneShared = frame(['KXNFLGAME-26SEP13NESEA-SEA', 'KXNFLGAME-26SEP13DALNYG-DAL']);

const plan = lockNeedlePlan([lock]);
assert.ok(Array.isArray(plan.groups) && plan.groups.length === 1, 'one group per lock');
assert.strictEqual(plan.groups[0].length, 2, 'one alt-list per leg');

// AND (default): keeps the exact combo, drops a combo that shares only one game.
const hot = createQuoteHot({ env: {} });
hot.setPlan(plan);
assert.strictEqual(hot.shouldDropCreated(exact), false);
assert.strictEqual(hot.shouldDropCreated(Buffer.from(exact)), false, 'buffer path');
assert.strictEqual(hot.shouldDropCreated(oneShared), true);
assert.strictEqual(hot.shouldDropCreated(Buffer.from(oneShared)), true);

// Rollback switch: OR filter keeps the one-shared-game frame again.
const orHot = createQuoteHot({ env: { KALSHI_WS_NEEDLE_ALL: '0' } });
orHot.setPlan(plan);
assert.strictEqual(orHot.shouldDropCreated(oneShared), false);
assert.strictEqual(needleAllDisabled({ KALSHI_WS_NEEDLE_ALL: 'off' }), true);
assert.strictEqual(needleAllDisabled({}), false);

// Any lock satisfied is enough.
const lock2 = { leg_keys: ['KXNFLGAME-26SEP13DALNYG-DAL:yes', 'KXNFLGAME-26SEP13NESEA-SEA:yes'] };
const hot2 = createQuoteHot({ env: {} });
hot2.setPlan(lockNeedlePlan([lock, lock2]));
assert.strictEqual(hot2.shouldDropCreated(oneShared), false);

// No groups (setNeedles / old plans) -> OR matcher unchanged.
const legacy = createQuoteHot({ env: {} });
legacy.setPlan({ needles: plan.needles, uncovered: 0, enabled: true });
assert.strictEqual(legacy.shouldDropCreated(oneShared), false);

assert.strictEqual(compileGroupMatcher(null), null);
assert.strictEqual(compileGroupMatcher([[['AB'], ['CD']]])('xxABxxCD'), true);
assert.strictEqual(compileGroupMatcher([[['AB'], ['CD']]])('xxABxx'), false);
console.log('quote-hot-all-legs.test.js ok');
