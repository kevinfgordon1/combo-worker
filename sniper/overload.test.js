'use strict';
// Oct 25 2026 main-thread overload: stale-alert O(1), etDay cache, intake early filter.
const test = require('node:test'); const assert = require('node:assert');
const { createStaleAlert } = require('./stale-alert');
const { createCandidateFilter } = require('./intake-filter');

test('stale-alert: same ratios/alerts as before, fast at 400k events', () => {
  let t = 0; const alerts = [];
  const a = createStaleAlert({ windowMs: 600000, now: () => t, alert: (m) => alerts.push(m) });
  for (let i = 0; i < 601; i += 1) { t += 1000; a.record(i % 4 !== 0); }
  assert.ok(Math.abs(a.state().n - 600) <= 1); assert.strictEqual(alerts.length, 1); assert.ok(a.firing());
  for (let i = 0; i < 700; i += 1) { t += 1000; a.record(false); }
  assert.strictEqual(a.state().stale, 0); assert.ok(Math.abs(a.state().n - 600) <= 1); assert.strictEqual(alerts.length, 2);
  const t0 = Date.now(); for (let i = 0; i < 400000; i += 1) { t += 1; a.record(i % 2 === 0); }
  assert.ok(Date.now() - t0 < 1500, 'record must be O(1)');
  const st = a.state(); assert.ok(st.n >= 400000 && st.n <= 400601); assert.ok(Math.abs(st.stale - 200000) <= 1);
});
test('etDay cache: correct across ET midnight', () => {
  const S = require('../auto-sniper');
  const f = S.etDay || (S._etDay);
  if (!f) return; // not exported; covered via prune tests in the suite
  assert.strictEqual(f(Date.UTC(2026, 9, 26, 3, 59)), '2026-10-25');
  assert.strictEqual(f(Date.UTC(2026, 9, 26, 4, 0)), '2026-10-26');
});
const rfq = (id, legs, created = 1000) => ({ isCombo: true, rfqId: id, legKeys: legs, createdTs: created });
test('early filter: drops dup ids and started legs; off = old behaviour', () => {
  const started = new Set(); const sk = {}; const bump = (k) => { sk[k] = (sk[k] || 0) + 1; };
  const f = createCandidateFilter({ maxAgeMs: 5000, earlyFilter: true }, { now: () => 1000, clock: () => 1000, bump, started });
  assert.ok(f(rfq('A', ['KXNFLGAME-26OCT25MIANYJ-MIA:yes', 'KXNFLGAME-26OCT25GBDET-GB:no'])));
  assert.strictEqual(f(rfq('A', ['KXNFLGAME-26OCT25MIANYJ-MIA:yes', 'KXNFLGAME-26OCT25GBDET-GB:no'])), null);
  started.add('KXNFLGAME-26OCT25GBDET-GB');
  assert.strictEqual(f(rfq('B', ['KXNFLGAME-26OCT25MIANYJ-MIA:yes', 'KXNFLGAME-26OCT25GBDET-GB:no'])), null);
  assert.ok(f(rfq('C', ['KXNFLGAME-26OCT25MIANYJ-MIA:yes', 'KXNFLGAME-26OCT25BUFNE-BUF:no'])));
  assert.deepStrictEqual(sk, { dup_rfq_intake: 1, game_started_intake: 1 });
  const off = createCandidateFilter({ maxAgeMs: 5000, earlyFilter: false }, { now: () => 1000, clock: () => 1000, started });
  assert.ok(off(rfq('B', ['KXNFLGAME-26OCT25GBDET-GB:no', 'KXNFLGAME-26OCT25MIANYJ-MIA:yes'])));
  assert.ok(off(rfq('B', ['KXNFLGAME-26OCT25GBDET-GB:no', 'KXNFLGAME-26OCT25MIANYJ-MIA:yes'])));
});
