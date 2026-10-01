'use strict';
const assert = require('assert');
const q = require('./quote');
const { makeBook } = require('./test-util');

const G1 = { game: '26OCT04ARINYG', a: 'ARI', b: 'NYG', askA: 0.52, bidA: 0.50, askB: 0.50, bidB: 0.48 };
const G2 = { game: '26OCT04DENSF', a: 'DEN', b: 'SF', askA: 0.40, bidA: 0.38, askB: 0.62, bidB: 0.60 };
const book = makeBook([G1, G2]);
const legs = [{ gameId: book.games()[0][0], team: 'ari' }, { gameId: book.games()[1][0], team: 'den' }];

// defaults
assert.strictEqual(q.DEFAULTS.margin, 0.10);
assert.strictEqual(q.configFromEnv({}).margin, 0.10);
assert.strictEqual(q.configFromEnv({ NOBOOST_MARGIN: '0.2' }).margin, 0.2);
assert.strictEqual(q.isNoBoostShadow({}), false, 'flag defaults OFF');
assert.strictEqual(q.isNoBoostShadow({ NOBOOST_SHADOW: '1' }), true);
assert.strictEqual(q.isNoBoostLive({}), false);

// targetPrice formulas
assert.ok(Math.abs(q.targetPrice(0.2, 0.10, 'price') - 0.22) < 1e-12, 'P*(1+m)');
assert.ok(Math.abs(q.targetPrice(0.2, 0.10, 'capital') - (0.3 / 1.1)) < 1e-12, '(P+m)/(1+m)');
assert.strictEqual(q.targetPrice(0, 0.1), null);
assert.strictEqual(q.targetPrice(0.2, -0.1), null);

// tick rounding is UP (never quote below target)
assert.strictEqual(q.ceilTo(0.2201, 0.001), 0.221);
assert.strictEqual(q.ceilTo(0.22, 0.001), 0.22);

// fmtAm
assert.strictEqual(q.fmtAm(150.4), '+150');
assert.strictEqual(q.fmtAm(-110), '-110');
assert.strictEqual(q.fmtAm(null), null);

// pricing with guardrail OFF: quote = ceil(P*(1.1))
const off = q.priceCombo(legs, book.source, { cfg: { guardrail: 'off', margin: 0.10 } });
assert.ok(off.ok);
assert.ok(off.quoteYes >= off.fair * 1.1 - 1e-9 && off.quoteYes < off.fair * 1.1 + 0.0011, 'quote = P(1+m) rounded up');
assert.strictEqual(off.binding, false);
assert.ok(Math.abs(off.edgeVsFair - (off.quoteYes / off.fair - 1)) < 1e-12);

// inverse method: leg true = sign-flip of best fee-included OPPONENT ask => fair is below the ask-cost product
const lockOn = q.priceCombo(legs, book.source, { cfg: { guardrail: 'lock', margin: 0.10 } });
assert.ok(lockOn.ok);
assert.ok(lockOn.yLock > off.fair, 'cost to rebuild the legs exceeds inverse fair');
assert.ok(lockOn.quoteYes >= lockOn.yLock - 1e-9, 'never below the lockable price');
assert.ok(lockOn.quoteYes >= off.quoteYes, 'guardrail only raises price');

// lock binds -> flagged
const hi = q.priceCombo(legs, book.source, { cfg: { guardrail: 'lock', margin: 0.0 } });
assert.strictEqual(hi.binding, true);
assert.ok(Math.abs(hi.quoteYes - q.ceilTo(hi.yLock, 0.001)) < 1e-9);

// monotone in margin; skew widens
const m5 = q.priceCombo(legs, book.source, { cfg: { guardrail: 'off', margin: 0.05 } });
const m20 = q.priceCombo(legs, book.source, { cfg: { guardrail: 'off', margin: 0.20 } });
assert.ok(m20.quoteYes > off.quoteYes && off.quoteYes > m5.quoteYes);
const sk = q.priceCombo(legs, book.source, { cfg: { guardrail: 'off', margin: 0.10, skew: 1 }, util: 1 });
assert.ok(sk.quoteYes > off.quoteYes, 'inventory skew widens margin');
assert.ok(Math.abs(sk.mEff - 0.20) < 1e-12);
const noSkew = q.priceCombo(legs, book.source, { cfg: { guardrail: 'off', margin: 0.10, skew: 0 }, util: 1 });
assert.strictEqual(noSkew.quoteYes, off.quoteYes);

// capital mode
const cap = q.priceCombo(legs, book.source, { cfg: { guardrail: 'off', margin: 0.10, marginMode: 'capital' } });
assert.ok(cap.quoteYes > off.fair);

// output has American odds only
assert.ok(Number.isFinite(off.fair_american) && Number.isFinite(off.quote_american));

// too many / too few legs, unpriceable
assert.strictEqual(q.priceCombo(legs.slice(0, 1), book.source, {}).reason, 'too_few_legs');
assert.strictEqual(q.priceCombo(legs, book.source, { cfg: { maxLegs: 1 } }).reason, 'too_many_legs');
assert.strictEqual(q.priceCombo([{ gameId: 'X', team: 'zzz' }, legs[0]], book.source, {}).reason, 'unpriceable_leg');

// winsPrint
assert.strictEqual(q.winsPrint(0.2, 0.25), 'win');
assert.strictEqual(q.winsPrint(0.25, 0.25), 'tie');
assert.strictEqual(q.winsPrint(0.3, 0.25), 'no');

// contractsFor
assert.strictEqual(q.contractsFor({ contracts: 10, targetCostDollars: 0 }, 0.2), 10);
assert.strictEqual(q.contractsFor({ contracts: 0, targetCostDollars: 10 }, 0.25), 40);

console.log('noboost-quote.test.js ok');
