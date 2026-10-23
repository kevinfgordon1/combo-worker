'use strict';
const assert = require('assert');
const { rogueGuard, rogueConfig, deviates } = require('./rogue');
const { bestCost, legFairDepth, ALL_VENUES } = require('./fair');
const V = ALL_VENUES;
const cfg = rogueConfig({});
const ok = (venue, p, extra = {}) => ({ venue, used: true, reason: 'ok', cost: 1 - p, availUsd: 5000, ...extra });
const top = (venue, p) => ({ venue, used: false, reason: 'depth', topAmerican: (() => { const c = 1 - p; return c >= 0.5 ? -Math.round(100 * c / (1 - c)) : Math.round(100 * (1 - c) / c); })() });

// defaults
assert.equal(cfg.mode, 'enforce'); assert.equal(cfg.maxDev, 0.04); assert.equal(cfg.maxLogit, 0.30); assert.equal(cfg.dropHigh, false);
// threshold shape: 4pp at the middle; logit test catches longshots; tick noise ignored
assert.equal(deviates(0.50, 0.54, cfg), true);
assert.equal(deviates(0.50, 0.53, cfg), false);
assert.equal(deviates(0.03, 0.05, cfg), true);   // +3233 vs +1900: 2pp but 0.53 logit
assert.equal(deviates(0.03, 0.04, cfg), false);  // 1pp < 1.5pp floor
assert.equal(deviates(0.95, 0.93, cfg), false);  // direction matters (b must be above a)

// 1) all venues agree → unchanged best
let g = rogueGuard([ok('kalshi', 0.60), ok('novig', 0.61), ok('polymarket', 0.605)], V, cfg, bestCost);
assert.equal(g.skip, null); assert.equal(g.best.venue, 'novig'); assert.equal(g.events.length, 0);

// 2) rogue HIGH venue (deep + fresh, 10pp above the others) → logged, NOT dropped (it only makes us quote higher)
g = rogueGuard([ok('kalshi', 0.60), ok('novig', 0.70), ok('polymarket', 0.605)], V, cfg, bestCost);
assert.equal(g.skip, null); assert.equal(g.best.venue, 'novig');
assert.equal(g.events.find((e) => e.kind === 'rogue_high').venue, 'novig');
// …optional drop
g = rogueGuard([ok('kalshi', 0.60), ok('novig', 0.70), ok('polymarket', 0.605)], V, { ...cfg, dropHigh: true }, bestCost);
assert.equal(g.best.venue, 'polymarket'); assert.ok(g.events[0].dropped);

// 3) single deep venue LOW vs other venues' top-of-book → skip
g = rogueGuard([ok('kalshi', 0.50), top('novig', 0.58), top('polymarket', 0.57)], V, cfg, bestCost);
assert.equal(g.skip, 'rogue_fair_low'); assert.equal(g.best, null);
assert.equal(g.events.find((e) => e.kind === 'rogue_low').venue, 'kalshi');
// shadow mode: logs but keeps the fair
g = rogueGuard([ok('kalshi', 0.50), top('novig', 0.58)], V, { ...cfg, mode: 'shadow' }, bestCost);
assert.equal(g.skip, null); assert.equal(g.best.venue, 'kalshi'); assert.ok(g.events.some((e) => e.kind === 'rogue_low'));
// off
g = rogueGuard([ok('kalshi', 0.50), top('novig', 0.58)], V, { ...cfg, mode: 'off' }, bestCost);
assert.equal(g.events.length, 0);

// 4) only one venue at all → current behaviour
g = rogueGuard([ok('novig', 0.55)], V, cfg, bestCost);
assert.equal(g.skip, null); assert.equal(g.best.venue, 'novig'); assert.equal(g.events[0].kind, 'no_ref');

// 5) stale sources never count as a reference; same-venue Kalshi pair (yes_opp/no_own) is one venue
g = rogueGuard([ok('kalshi', 0.50, { via: 'yes_opp' }), ok('kalshi', 0.49, { via: 'no_own' }), { venue: 'novig', used: false, reason: 'stale', topAmerican: -400 }], V, cfg, bestCost);
assert.equal(g.skip, null);

// 6) longshot TD No leg: chosen 0.90 (−900) while others say 0.95 → skip (5pp)
g = rogueGuard([ok('kalshi', 0.90), ok('novig', 0.95), ok('polymarket', 0.951)], V, cfg, bestCost);
assert.equal(g.best.venue, 'polymarket'); assert.equal(g.skip, null); // best is the high one → fine

// 7) wired into legFairDepth (ML via pmLive stub)
const pmLive = { legFair: () => ({ sources: [ok('kalshi', 0.50), top('novig', 0.60), top('prophetx', 0.59)] }) };
let f = legFairDepth({ gameId: 'g', team: 'A' }, { pmLive, venues: V, rogue: cfg });
assert.equal(f.p, null); assert.equal(f.reason, 'rogue_fair_low'); assert.equal(f.rogue[0].kind, 'rogue_low');
f = legFairDepth({ gameId: 'g', team: 'A' }, { pmLive: { legFair: () => ({ sources: [ok('kalshi', 0.50, { via: 'yes_opp' }), ok('novig', 0.51)] }) }, venues: V, rogue: cfg });
assert.ok(Math.abs(f.p - 0.51) < 1e-9); assert.equal(f.best, 'novig'); assert.equal(f.rogue, undefined);
const td = { legMulti: () => ({ sources: [ok('kalshi', 0.80, { via: 'td_opposite' })] }) };
f = legFairDepth({ kind: 'td', id: 'X', side: 'no' }, { tdBook: td, venues: V, rogue: cfg });
assert.equal(f.best, 'kalshi');
console.log('sniper/rogue.test.js OK');
