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
assert.ok(/if \(!SPLIT\.runKalshi\) \{[\s\S]{0,2500}?process\.on\('SIGINT'/.test(src));
// Poly role: Kalshi skip-tape never scheduled; single-leg runner is Polymarket-only.
assert.ok(/if \(SPLIT\.runKalshi\) \{\s*setInterval\(unlessQuoteHot\(\(\) => \{\s*reconcileSkipTapes/.test(src));
assert.ok(/venues: \['polymarket'\],\s*forceDry: polyDry/.test(src));
const startPoly = fs.readFileSync(path.join(__dirname, 'start-poly.js'), 'utf8');
assert.ok(startPoly.includes("COMBO_ROLE: 'poly'") && !startPoly.includes('fills-reader') && !startPoly.includes('desk-protect'));

console.log('poly-split tests ok');

// Dry run forces orders and coordination off in the child env.
{
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, 'start-poly.js'), 'utf8');
  require('assert').ok(/POLY_DRY_RUN/.test(src) && /POLYMARKET_RFQ_LIVE = '0'/.test(src) && /COMBO_VENUE_COORD = '0'/.test(src));
  const prq = fs.readFileSync(require('path').join(__dirname, 'polymarket-rfq.js'), 'utf8');
  require('assert').ok(/!dryRun && isPolymarketRfqLive/.test(prq) && /reason: 'dry_run'/.test(prq));
  console.log('poly-split dry-run ok');
}
