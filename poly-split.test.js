'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveSplit, splitConfigError } = require('./poly-split');

// Default: one process, both venues, no DB coordination (today's behavior).
let s = resolveSplit({});
assert.deepStrictEqual([s.role, s.runKalshi, s.runPoly, s.coord, s.mode], ['all', true, true, false, 'LIVE']);
// combo-worker with Polymarket moved out.
s = resolveSplit({ COMBO_POLY_ENABLED: '0' });
assert.deepStrictEqual([s.runKalshi, s.runPoly, s.coord, s.venue], [true, false, true, 'kalshi']);
s = resolveSplit({ COMBO_POLY_ENABLED: 'false' });
assert.strictEqual(s.runPoly, false);
s = resolveSplit({ COMBO_POLY_ENABLED: '1' });
assert.deepStrictEqual([s.runPoly, s.coord], [true, false]);
// combo-poly service: never Kalshi.
s = resolveSplit({ COMBO_ROLE: 'poly', COMBO_POLY_ENABLED: '0' });
assert.deepStrictEqual([s.role, s.runKalshi, s.runPoly, s.coord, s.venue, s.mode], ['poly', false, true, true, 'polymarket', 'POLY']);
// Coordination can be forced on for a canary, or off as an explicit escape.
assert.strictEqual(resolveSplit({ COMBO_VENUE_COORD: '1' }).coord, true);
assert.strictEqual(resolveSplit({ COMBO_ROLE: 'poly', COMBO_VENUE_COORD: '0' }).coord, false);
// A split without confirm-time caps would not be coordinated: refuse.
assert.ok(splitConfigError(resolveSplit({ COMBO_ROLE: 'poly' }), {}));
assert.strictEqual(splitConfigError(resolveSplit({ COMBO_ROLE: 'poly' }), { COMBO_CAP_AT_CONFIRM: '1' }), null);
assert.strictEqual(splitConfigError(resolveSplit({}), {}), null);

// The Polymarket role must never construct the Kalshi firehose: it returns
// before createKalshiFirehose is reached in main().
const src = fs.readFileSync(path.join(__dirname, 'live-runner.js'), 'utf8');
const ret = src.indexOf('return; // Polymarket service: no Kalshi WebSocket');
const fire = src.indexOf('createKalshiFirehose({');
assert.ok(ret > 0 && fire > ret, 'poly role returns before the Kalshi WS is created');
assert.ok(/if \(!SPLIT\.runKalshi\) \{\s*process\.on\('SIGINT'/.test(src));
const startPoly = fs.readFileSync(path.join(__dirname, 'start-poly.js'), 'utf8');
assert.ok(startPoly.includes("COMBO_ROLE: 'poly'") && !startPoly.includes('fills-reader') && !startPoly.includes('desk-protect'));

console.log('poly-split tests ok');
