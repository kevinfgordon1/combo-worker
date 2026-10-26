'use strict';
const assert = require('assert');
const { createAllLegsFrameFilter, createSniperFrameFilter, sniperNeedles, needleAllDisabled, NFL_NEEDLES } = require('./intake');
const { createCandidateFilter } = require('./intake-filter');

const frame = (legs, parent = 'KXMVENFLMULTIGAME-26OCT25-ABC') => JSON.stringify({ type: 'rfq_created', msg: { id: 'R', market_ticker: parent,
  mve_selected_legs: legs.map((t) => ({ market_ticker: t, event_ticker: t.split('-').slice(0, 2).join('-'), side: 'yes' })) } });
const NFL1 = 'KXNFLGAME-26NOV01PHIWAS-WAS'; const NFL2 = 'KXNFLGAME-26OCT26DALPHI-DAL';
const CFB = 'KXNCAAFGAME-26OCT30NEVUCLA-UCLA'; const NBA = 'KXNBAGAME-26OCT26CHIBOS-BOS'; const SOC = 'KXEPLGAME-26OCT26ARSCHE-ARS';

// every leg must match; the KXMVE parent is ignored
const all = createAllLegsFrameFilter(NFL_NEEDLES);
assert.strictEqual(all(frame([NFL1, NFL2])), false, 'all-NFL kept');
assert.strictEqual(all(frame([NFL1, SOC])), true, 'one unsupported leg dropped');
assert.strictEqual(all(frame([SOC, NBA])), true, 'no supported leg dropped');
assert.strictEqual(all(Buffer.from(frame([NFL1, NFL2]))), false, 'buffer input');
assert.strictEqual(all([Buffer.from(frame([NFL1, SOC]).slice(0, 40)), Buffer.from(frame([NFL1, SOC]).slice(40))]), true, 'fragmented frame');
assert.strictEqual(all('{"type":"rfq_created","msg":{"legs":["KXNFLGAME-X:yes"]}}'), false, 'no ticker fields => fail open');

// sport toggles
assert.ok(!sniperNeedles({ ncaaf: false }).some((n) => n.toString().startsWith('KXNCAAF')));
assert.ok(sniperNeedles({ nba: true }).some((n) => n.toString() === 'KXNBAGAME'));
assert.strictEqual(createSniperFrameFilter({ ncaaf: false })(frame([NFL1, CFB])), true, 'NCAAF off => CFB leg dropped');
assert.strictEqual(createSniperFrameFilter({ ncaaf: true })(frame([NFL1, CFB])), false, 'NCAAF on => kept');
assert.strictEqual(createSniperFrameFilter({ nba: false })(frame([NFL1, NBA])), true, 'NBA off => dropped');
assert.strictEqual(createSniperFrameFilter({ nba: true })(frame([NFL1, NBA])), false, 'NBA on => kept');
assert.strictEqual(createSniperFrameFilter({ all: false })(frame([NFL1, SOC])), false, 'rollback = any-leg filter');
assert.strictEqual(needleAllDisabled({ SNIPER_WS_NEEDLE_ALL: '0' }), true);
assert.strictEqual(needleAllDisabled({}), false);

// scope / same-game / too-many-legs skips are counted in the worker and never returned to main
const bumps = {}; const bump = (k) => { bumps[k] = (bumps[k] || 0) + 1; };
const f = createCandidateFilter({ maxAgeMs: 0, earlyFilter: true, maxLegs: 3, scope: { td: false, ncaaf: true, lines: false, nba: false } }, { bump });
const rfq = (id, legKeys) => ({ rfqId: id, isCombo: true, legKeys });
assert.strictEqual(f(rfq('a', [`${NFL1}:yes`, `${SOC}:yes`])), null, 'unsupported leg not sent to main');
assert.strictEqual(f(rfq('b', [`${NBA}:yes`, `${NFL1}:yes`])), null, 'NBA off not sent to main');
assert.strictEqual(f(rfq('c', [`${NFL1}:yes`, 'KXNFLGAME-26NOV01PHIWAS-PHI:yes'])), null, 'same-game not sent to main');
assert.strictEqual(f(rfq('d', [`${NFL1}:yes`, `${NFL2}:yes`, `${CFB}:yes`, 'KXNFLGAME-26NOV01KCDEN-KC:yes'])), null, 'too many legs not sent to main');
assert.strictEqual(bumps.too_many_legs_intake, 1);
assert.ok(Object.keys(bumps).filter((k) => k.startsWith('scope_')).length >= 2, JSON.stringify(bumps));
assert.ok(f(rfq('e', [`${NFL1}:yes`, `${NFL2}:yes`])), 'quotable NFL combo still reaches main');
console.log('intake-all-legs ok', bumps);
