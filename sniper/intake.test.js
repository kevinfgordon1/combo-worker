'use strict';
const assert = require('assert');
const { createNflFrameFilter, createDeletedFilter, tooOld, createLatencyStats } = require('./intake');
const drop = createNflFrameFilter();
const nfl = '{"type":"rfq_created","msg":{"id":"a","mve_selected_legs":[{"market_ticker":"KXNFLGAME-26OCT22NECHI-NE","side":"yes"}]}}';
const nba = '{"type":"rfq_created","msg":{"id":"b","mve_selected_legs":[{"market_ticker":"KXNBAGAME-26OCT22BOSNYK-BOS","side":"yes"}]}}';
assert.strictEqual(drop(Buffer.from(nfl)), false);
assert.strictEqual(drop(Buffer.from(nba)), true);
assert.strictEqual(drop(nfl), false);
assert.strictEqual(drop([Buffer.from(nfl.slice(0, 40)), Buffer.from(nfl.slice(40))]), false);
assert.strictEqual(drop(Buffer.from(nfl.replace('KXNFLGAME-26OCT22NECHI-NE', 'KXNFLTD-26OCT22NECHI-NEDMAYE10-1'))), false);
const held = new Set(['keep-me']);
const dd = createDeletedFilter((cb) => held.forEach(cb));
assert.strictEqual(dd('{"type":"rfq_deleted","msg":{"id":"keep-me"}}'), false);
assert.strictEqual(dd('{"type":"rfq_deleted","msg":{"id":"other"}}'), true);
const now = Date.parse('2026-10-22T17:00:10Z');
assert.strictEqual(tooOld({ createdTs: '2026-10-22T17:00:09.000Z' }, now, 2000), null);
assert.strictEqual(tooOld({ createdTs: '2026-10-22T17:00:05.000Z' }, now, 2000), 5000);
assert.strictEqual(tooOld({ createdTs: null }, now, 2000), null);
assert.strictEqual(tooOld({ createdTs: '2026-10-22T17:00:05.000Z' }, now, 0), null);
const L = createLatencyStats(); [100, 200, 300, 4000].forEach(L.arrive); L.staleIntake();
const snap = L.snapshot();
assert.deepStrictEqual(snap.arriveAgeMs, { n: 4, p50: 300, p90: 4000, max: 4000 });
assert.strictEqual(snap.staleIntake, 1); assert.strictEqual(L.snapshot().arriveAgeMs.n, 0);
console.log('sniper intake ok');

// stage timing + stale buckets + loop lag summary
{
  const { createLatencyStats: mk, staleBucket } = require('./intake');
  const l = mk();
  l.staleIntake(2500); l.staleIntake(45000); l.staleIntake(7000);
  l.stage('decidedToReserved', 100); l.stage('decidedToReserved', 300); l.stage('bogus', 5);
  l.loopLag(10); l.loopLag(1500);
  const snap = l.snapshot();
  assert.deepStrictEqual(snap.staleBuckets, { '2-5s': 1, '5-10s': 1, '10-30s': 0, '>30s': 1 });
  assert.strictEqual(snap.stages.decidedToReserved.n, 2);
  assert.strictEqual(snap.stages.decidedToReserved.p90, 300);
  assert.strictEqual(snap.loopLagMs.max, 1500);
  assert.strictEqual(l.snapshot().staleIntake, 0);
  assert.strictEqual(staleBucket(12000), '10-30s');
}

// O(1) rfq_deleted filter
{
  const { createDeletedIdFilter } = require('./intake');
  const open = new Set(['rfq-hit']);
  const f = createDeletedIdFilter((id) => open.has(id));
  assert.strictEqual(f('{"type":"rfq_deleted","sid":3,"msg":{"id":"rfq-hit","market_ticker":"X"}}'), false);
  assert.strictEqual(f('{"type":"rfq_deleted","sid":3,"msg":{"id":"other"}}'), true);
  assert.strictEqual(f('{"type":"rfq_deleted","msg":{"rfq_id":"rfq-hit"}}'), false);
  assert.strictEqual(f(Buffer.from('{"type":"rfq_deleted","msg":{"id":"other"}}')), true);
  assert.strictEqual(f('{"type":"rfq_deleted","msg":{}}'), false); // no id => keep
}
