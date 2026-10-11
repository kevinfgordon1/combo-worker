'use strict';
const assert = require('assert');
const { isPaused, splitPaused, diffPaused, createPausePoller } = require('./lock-pause');

// No column / undefined / false => enabled. Only an explicit true pauses.
assert.strictEqual(isPaused({ id: 'a' }), false);
assert.strictEqual(isPaused({ id: 'a', paused: false }), false);
assert.strictEqual(isPaused({ id: 'a', paused: null }), false);
assert.strictEqual(isPaused({ id: 'a', paused: 'true' }), false);
assert.strictEqual(isPaused({ id: 'a', paused: true }), true);
assert.strictEqual(isPaused(null), false);

{
  const rows = [{ id: 'a' }, { id: 'b', paused: true }, { id: 'c', paused: false }];
  const { live, pausedIds } = splitPaused(rows);
  assert.deepStrictEqual(live.map((r) => r.id), ['a', 'c']);
  assert.deepStrictEqual([...pausedIds], ['b']);
  // Rows from a database without the column: nothing paused.
  const none = splitPaused([{ id: 'a' }, { id: 'b' }]);
  assert.strictEqual(none.live.length, 2);
  assert.strictEqual(none.pausedIds.size, 0);
  assert.deepStrictEqual(splitPaused(null), { live: [], pausedIds: new Set(), probeUntil: new Map() });
}

{
  const d = diffPaused(new Set(['a', 'b']), new Set(['b', 'c']));
  assert.deepStrictEqual(d, { pausedNow: ['c'], resumed: ['a'] });
  assert.deepStrictEqual(diffPaused(new Set(), new Set()), { pausedNow: [], resumed: [] });
}

function fakeSupabase(result) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        select(cols) {
          return {
            async eq(col, val) {
              calls.push({ table, cols, col, val });
              return typeof result === 'function' ? result() : result;
            },
          };
        },
      };
    },
  };
}

(async () => {
  // Poller reads id,paused of active locks.
  {
    const sb = fakeSupabase({ data: [{ id: 'a', paused: true }, { id: 'b', paused: false }, { id: 'c' }], error: null });
    const p = createPausePoller({ supabase: sb });
    const ids = await p.poll();
    assert.deepStrictEqual([...ids], ['a']);
    assert.deepStrictEqual(sb.calls[0], { table: 'combo_parlays', cols: 'id,user_id,paused,probe_paused_at,probe_pause_until', col: 'active', val: true });
  }
  // Column missing: returns null, logs once, stops querying (all locks enabled).
  {
    const logs = [];
    const sb = fakeSupabase({ data: null, error: { message: "Could not find the 'paused' column of 'combo_parlays' in the schema cache" } });
    const p = createPausePoller({ supabase: sb, log: (m) => logs.push(m) });
    assert.strictEqual(await p.poll(), null);
    assert.strictEqual(p.disabled, true);
    assert.strictEqual(await p.poll(), null);
    assert.strictEqual(sb.calls.length, 1, 'no more queries once the column is known missing');
    assert.strictEqual(logs.length, 1);
  }
  {
    const sb = fakeSupabase({ data: null, error: { message: 'column combo_parlays.paused does not exist' } });
    const p = createPausePoller({ supabase: sb });
    assert.strictEqual(await p.poll(), null);
    assert.strictEqual(p.disabled, true);
  }
  // Transient error keeps polling and keeps the previous state (null = no change).
  {
    let n = 0;
    const sb = fakeSupabase(() => (++n === 1
      ? { data: null, error: { message: 'timeout' } }
      : { data: [{ id: 'z', paused: true }], error: null }));
    const p = createPausePoller({ supabase: sb });
    assert.strictEqual(await p.poll(), null);
    assert.strictEqual(p.disabled, false);
    assert.deepStrictEqual([...(await p.poll())], ['z']);
  }
  // A throwing client never breaks the worker.
  {
    const p = createPausePoller({ supabase: { from() { throw new Error('boom'); } } });
    assert.strictEqual(await p.poll(), null);
  }
  console.log('lock-pause.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });

// ── "Check market price" probe pause (probe_paused_at / probe_pause_until) ──
{
  const { probePauseEnd, expiredProbePauses, PROBE_PAUSE_MAX_MS } = require('./lock-pause');
  assert.strictEqual(PROBE_PAUSE_MAX_MS, 30000);
  const T = Date.parse('2026-10-10T23:00:00Z');
  const row = { id: 'p', paused: false, probe_paused_at: '2026-10-10T23:00:00Z', probe_pause_until: '2026-10-10T23:00:25Z' };
  assert.strictEqual(isPaused(row, T + 1000), true, 'paused during the check');
  assert.strictEqual(isPaused(row, T + 25000), false, 'ends at probe_pause_until');
  // Safety net: a bogus far-future until is capped 30s after the check started.
  const stuck = { ...row, probe_pause_until: '2026-10-11T23:00:00Z' };
  assert.strictEqual(isPaused(stuck, T + 29000), true);
  assert.strictEqual(isPaused(stuck, T + 30000), false, 'never more than 30s');
  assert.strictEqual(probePauseEnd(stuck, T + 1000), T + 30000);
  // No start stamp: capped from now.
  assert.strictEqual(probePauseEnd({ probe_pause_until: '2026-10-11T23:00:00Z' }, T), T + 30000);
  assert.strictEqual(isPaused({ id: 'x', probe_pause_until: 'garbage' }, T), false);
  assert.strictEqual(isPaused({ id: 'x', probe_pause_until: null, probe_paused_at: null }, T), false);
  // Manual pause wins and is not tracked as a probe pause (expiry never resumes it).
  const both = splitPaused([{ ...row, paused: true }, row, { id: 'live' }], T + 1000);
  assert.deepStrictEqual([...both.pausedIds].sort(), ['p']);
  const s2 = splitPaused([{ ...row, id: 'm', paused: true }, row, { id: 'live' }], T + 1000);
  assert.deepStrictEqual([...s2.pausedIds].sort(), ['m', 'p']);
  assert.deepStrictEqual([...s2.probeUntil.keys()], ['p']);
  assert.deepStrictEqual(s2.live.map((r) => r.id), ['live']);
  assert.deepStrictEqual(expiredProbePauses(s2.pausedIds, s2.probeUntil, T + 10000), []);
  assert.deepStrictEqual(expiredProbePauses(s2.pausedIds, s2.probeUntil, T + 25000), ['p']);
}

(async () => {
  const T = Date.parse('2026-10-10T23:00:00Z');
  // Poller reads probe columns and returns probeUntil.
  {
    const sb = fakeSupabase({ data: [{ id: 'p', paused: false, probe_paused_at: '2026-10-10T23:00:00Z', probe_pause_until: '2026-10-10T23:00:25Z' }, { id: 'q', paused: false }], error: null });
    const p = createPausePoller({ supabase: sb, now: () => T + 2000 });
    const ids = await p.poll();
    assert.deepStrictEqual([...ids], ['p']);
    assert.strictEqual(ids.probeUntil.get('p'), T + 25000);
    assert.match(sb.calls[0].cols, /probe_pause_until/);
  }
  // Probe columns not migrated yet → falls back to id,paused (manual pause keeps working).
  {
    let n = 0; const logs = [];
    const sb = fakeSupabase(() => (n++ === 0
      ? { data: null, error: { message: "column combo_parlays.probe_paused_at does not exist" } }
      : { data: [{ id: 'm', paused: true }], error: null }));
    const p = createPausePoller({ supabase: sb, log: (m) => logs.push(m) });
    const ids = await p.poll();
    assert.deepStrictEqual([...ids], ['m']);
    assert.strictEqual(p.disabled, false);
    assert.strictEqual(sb.calls[1].cols, 'id,user_id,paused');
    assert.ok(logs.some((m) => /probe_pause/.test(m)));
  }
  // live-runner wiring: 2s safety net + poll/refresh feed probePauseUntil.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'live-runner.js'), 'utf8');
    assert.match(src, /expireProbePauses\(\);\n  \}\), 2000\);/);
    assert.match(src, /probePauseUntil = ids\.probeUntil/);
    assert.match(src, /probePauseUntil = split\.probeUntil/);
  }
  // Scoped: a tester child only tracks its own locks' pauses (no flapping on Kevin's).
  {
    const sb = fakeSupabase({ data: [{ id: 'kev', user_id: 'K', paused: true }, { id: 'mine', user_id: 'T', paused: true }], error: null });
    const p = createPausePoller({ supabase: sb, filterRows: (rows) => rows.filter((r) => r.user_id === 'T') });
    assert.deepStrictEqual([...(await p.poll())], ['mine']);
  }
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'live-runner.js'), 'utf8');
    assert.match(src, /createPausePoller\(\{ supabase, filterRows: \(rows\) => liveUsers\.filterParlays\(rows\)/);
  }
  console.log('lock-pause probe tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
