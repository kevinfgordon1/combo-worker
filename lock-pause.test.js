'use strict';
const assert = require('assert');
const { isPaused, splitPaused, diffPaused, createPausePoller, createProbeHolds, PROBE_HOLD_MAX_MS } = require('./lock-pause');

// Check market price probe hold: paused while probe_hold_until is in the future,
// never for more than 30s after first seen (safety net).
{
  assert.strictEqual(PROBE_HOLD_MAX_MS, 30000);
  const holds = createProbeHolds();
  const t0 = Date.parse('2026-10-10T23:00:00Z');
  const row = { id: 'p', probe_hold_until: new Date(t0 + 20000).toISOString() };
  assert.strictEqual(isPaused(row, t0, holds), true);
  assert.strictEqual(isPaused(row, t0 + 19000, holds), true);
  assert.strictEqual(isPaused(row, t0 + 20000, holds), false, 'expired hold resumes');
  // Cleared column resumes immediately.
  assert.strictEqual(isPaused({ id: 'p', probe_hold_until: null }, t0 + 1000, holds), false);
  // A hold far in the future (crashed probe / bad clock) is capped at 30s.
  const h2 = createProbeHolds();
  const far = { id: 'q', probe_hold_until: new Date(t0 + 3600e3).toISOString() };
  assert.strictEqual(isPaused(far, t0, h2), true);
  assert.strictEqual(isPaused(far, t0 + 29999, h2), true);
  assert.strictEqual(isPaused(far, t0 + 30000, h2), false, 'safety net: never paused > 30s');
  assert.strictEqual(isPaused(far, t0 + 600e3, h2), false);
  // A new probe (new until) is honored again.
  const again = { id: 'q', probe_hold_until: new Date(t0 + 600e3 + 15000).toISOString() };
  assert.strictEqual(isPaused(again, t0 + 600e3, h2), true);
  // Garbage timestamp => not paused. paused=true still wins.
  assert.strictEqual(isPaused({ id: 'r', probe_hold_until: 'nope' }, t0, h2), false);
  assert.strictEqual(isPaused({ id: 'r', paused: true, probe_hold_until: null }, t0, h2), true);
  const sp = splitPaused([{ id: 'a' }, { id: 'b', probe_hold_until: new Date(t0 + 5000).toISOString() }], t0, createProbeHolds());
  assert.deepStrictEqual([...sp.pausedIds], ['b']);
}

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
  assert.deepStrictEqual(splitPaused(null), { live: [], pausedIds: new Set() });
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
    assert.deepStrictEqual(sb.calls[0], { table: 'combo_parlays', cols: 'id,paused,probe_hold_until', col: 'active', val: true });
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
  // Held lock shows up in the poller's paused set; missing hold column falls back to id,paused.
  {
    const now = Date.now();
    const sb = fakeSupabase({ data: [{ id: 'h', paused: false, probe_hold_until: new Date(now + 10000).toISOString() }], error: null });
    const p = createPausePoller({ supabase: sb, holds: createProbeHolds() });
    assert.deepStrictEqual([...(await p.poll())], ['h']);
  }
  {
    const logs = [];
    let n = 0;
    const sb = fakeSupabase(() => (++n === 1
      ? { data: null, error: { message: "Could not find the 'probe_hold_until' column of 'combo_parlays' in the schema cache" } }
      : { data: [{ id: 'y', paused: true }], error: null }));
    const p = createPausePoller({ supabase: sb, log: (m) => logs.push(m) });
    assert.deepStrictEqual([...(await p.poll())], ['y']);
    assert.strictEqual(p.disabled, false, 'pause still works without the hold column');
    assert.strictEqual(sb.calls[1].cols, 'id,paused');
    await p.poll();
    assert.strictEqual(sb.calls[2].cols, 'id,paused');
    assert.strictEqual(logs.length, 1);
  }
  // A throwing client never breaks the worker.
  {
    const p = createPausePoller({ supabase: { from() { throw new Error('boom'); } } });
    assert.strictEqual(await p.poll(), null);
  }
  console.log('lock-pause.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
