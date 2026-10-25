'use strict';
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createIntakeWorker } = require('./intake-host');
const { createCandidateFilter } = require('./intake-filter');
const { maybeStartCpuProfile } = require('./cpu-prof');

(async () => {
  // 1. candidate filter: age + scope run off the main thread; counts skips
  const sk = {}; const bump = (k) => { sk[k] = (sk[k] || 0) + 1; };
  const now = Date.parse('2026-10-25T17:00:10.000Z');
  const f = createCandidateFilter({ maxAgeMs: 2000, scope: { td: true, ncaaf: true, lines: true, nba: true } }, { now: () => now, clock: () => now, bump });
  const nfl = { rfqId: 'a', isCombo: true, createdTs: '2026-10-25T17:00:09.500Z', legKeys: ['KXNFLGAME-26OCT25INDTEN-IND:yes', 'KXNFLGAME-26OCT25NYGPHI-PHI:yes'] };
  const c = f(nfl); assert.ok(c && c.recvAge === 500 && c.recvAt === now);
  assert.strictEqual(f({ ...nfl, createdTs: '2026-10-25T17:00:05.000Z' }), null);
  assert.strictEqual(f({ ...nfl, isCombo: false }), null);
  assert.strictEqual(f({ ...nfl, legKeys: ['KXNFLGAME-26OCT25INDTEN-IND:yes', 'KXMLBHR-26OCT25-X:yes'] }), null);
  assert.strictEqual(sk.stale_at_intake, 1); assert.ok(Object.keys(sk).some((k) => k.startsWith('scope_')));

  // 2. host <-> real worker thread routing (fake worker file, no network)
  const got = { rfq: [], del: [], acc: [], exe: [], skips: [], status: [] };
  const h = createIntakeWorker({
    workerData: {}, file: path.join(__dirname, 'fixtures', 'fake-intake-worker.js'),
    onRfqCreated: (r) => got.rfq.push(r), onRfqDeleted: (e) => got.del.push(e), onQuoteAccepted: (e) => got.acc.push(e), onQuoteExecuted: (e) => got.exe.push(e),
    onSkips: (s) => got.skips.push(s), onStatus: (s) => got.status.push(s), openIds: () => ['X1'], syncMs: 20, log: () => {},
  });
  h.start();
  await new Promise((r) => setTimeout(r, 300));
  h.addOpen('X2');
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(got.rfq[0].rfqId, 'R1'); assert.strictEqual(got.del[0].rfqId, 'R1');
  assert.strictEqual(got.acc.length, 1); assert.strictEqual(got.exe.length, 1);
  assert.deepStrictEqual(got.skips[0], { stale_at_intake: 3 });
  assert.ok(got.status.includes('intake-worker ready'));
  const tp = await h.takeThroughputAsync();
  assert.strictEqual(tp.recv, 7); assert.ok(tp.open.includes('X1'));
  const st = h.stats(); assert.strictEqual(st.rfqs, 1); assert.ok(st.hopP50 != null);
  await h.stop();

  // 3. cpu profile switch writes a .cpuprofile
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  const logs = [];
  assert.strictEqual(maybeStartCpuProfile('test', {}, () => {}), false);
  assert.strictEqual(maybeStartCpuProfile('test', { SNIPER_CPU_PROF_SEC: '0.2', SNIPER_CPU_PROF_DELAY_SEC: '0', SNIPER_CPU_PROF_DIR: dir }, (m) => logs.push(m)), true);
  const keep = setInterval(() => {}, 50);
  await new Promise((r) => setTimeout(r, 900)); clearInterval(keep);
  const files = fs.readdirSync(dir).filter((x) => x.endsWith('.cpuprofile'));
  assert.strictEqual(files.length, 1, logs.join(' | '));
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, files[0]))).nodes.length > 0);
  console.log('intake worker ok');
})().catch((e) => { console.error(e); process.exit(1); });
