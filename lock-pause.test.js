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
    assert.deepStrictEqual(sb.calls[0], { table: 'combo_parlays', cols: 'id,paused', col: 'active', val: true });
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
