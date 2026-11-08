'use strict';
const assert = require('assert');
const { decideAtFill } = require('./engine');
const {
  querySoftFailed,
  applyRefreshParlays,
  applyRefreshKillByUser,
  applyRefreshFilledByParlay,
  CAP_FILL_PAGE_SIZE,
  noteCapFill,
  sumCapFills,
  applyCapFillPage,
  loadCapFillRows,
} = require('./refresh-state');

function silentLog() {
  const errors = [];
  return {
    errors,
    error(msg) { errors.push(msg); },
  };
}

const ARI_JAC = {
  id: '98d3e355-4a1d-4f60-91ed-a7c1517c60ad',
  label: 'Arizona + Jacksonville',
  active: true,
  fill_american: 350,
  leg_keys: [
    'KXNFLGAME-26SEP13ARILAC-ARI:yes',
    'KXNFLGAME-26SEP13CLEJAC-JAC:yes',
  ],
};

{
  assert.strictEqual(querySoftFailed({ data: null, error: { message: '522' } }), true);
  assert.strictEqual(querySoftFailed({ data: null, error: null }), true);
  assert.strictEqual(querySoftFailed({ data: [], error: null }), false);
  assert.strictEqual(querySoftFailed({ data: [ARI_JAC], error: null }), false);
  assert.strictEqual(querySoftFailed({ data: [ARI_JAC], error: { message: 'partial' } }), true);
}

{
  const prev = [ARI_JAC];
  const log = silentLog();
  const next = applyRefreshParlays(prev, { data: null, error: { message: 'Timeout' } }, log);
  assert.strictEqual(next, prev, 'soft-fail null data must keep the previous parlays array');
  assert.strictEqual(next.length, 1);
  assert.strictEqual(next[0].id, ARI_JAC.id);
  assert.ok(
    /refresh soft-fail parlays: Timeout — keeping 1 lock\(s\): Arizona \+ Jacksonville/.test(log.errors[0]),
    log.errors[0]
  );
}

{
  const prev = [ARI_JAC];
  const log = silentLog();
  const next = applyRefreshParlays(prev, { data: null, error: null }, log);
  assert.strictEqual(next, prev, 'null data without a thrown error still keeps locks');
  assert.ok(/keeping 1 lock\(s\): Arizona \+ Jacksonville/.test(log.errors[0]));
}

{
  const prev = [ARI_JAC];
  const log = silentLog();
  const next = applyRefreshParlays(prev, { data: [], error: null }, log);
  assert.deepStrictEqual(next, []);
  assert.notStrictEqual(next, prev);
  assert.strictEqual(log.errors.length, 0, 'authentic empty must not log a soft-fail');
}

{
  const prev = [ARI_JAC];
  const incoming = [{ id: 'other', label: 'other', active: true }];
  const next = applyRefreshParlays(prev, { data: incoming, error: null }, silentLog());
  assert.strictEqual(next, incoming);
}

{
  const prev = { 'user-1': false };
  const log = silentLog();
  const next = applyRefreshKillByUser(prev, { data: null, error: { message: '502' } }, log);
  assert.strictEqual(next, prev);
  assert.strictEqual(next['user-1'], false, 'settings soft-fail must preserve kill_switch false');
  assert.strictEqual(next['user-1'] !== false, false);
  assert.ok(/refresh soft-fail settings: 502 — keeping kill_switch user-1=false/.test(log.errors[0]));
}

{
  const prev = { 'user-1': false };
  const next = applyRefreshKillByUser(
    prev,
    { data: [{ user_id: 'user-1', kill_switch: true }], error: null },
    silentLog()
  );
  assert.strictEqual(next['user-1'], true);
  assert.notStrictEqual(next, prev);
}

{
  const prev = { 'user-1': false };
  const next = applyRefreshKillByUser(prev, { data: [], error: null }, silentLog());
  assert.deepStrictEqual(next, {});
}

{
  const prev = { [ARI_JAC.id]: 12 };
  const log = silentLog();
  const next = applyRefreshFilledByParlay(
    prev,
    { data: null, error: { message: 'fetch failed' } },
    'count',
    log
  );
  assert.strictEqual(next, prev);
  assert.strictEqual(next[ARI_JAC.id], 12);
  assert.ok(/refresh soft-fail fills: fetch failed — keeping 1 parlay fill/.test(log.errors[0]));
}

{
  const prev = { [ARI_JAC.id]: 12 };
  const next = applyRefreshFilledByParlay(
    prev,
    { data: [{ parlay_id: ARI_JAC.id, count: 3 }, { parlay_id: ARI_JAC.id, count: 2 }], error: null },
    'count',
    silentLog()
  );
  assert.strictEqual(next[ARI_JAC.id], 5);
}

{
  const prev = { p1: 4 };
  const next = applyRefreshFilledByParlay(
    prev,
    { data: [{ parlay_id: 'p1', contracts: 7 }], error: null },
    'contracts',
    silentLog()
  );
  assert.strictEqual(next.p1, 7);
}

// $300 at +230, cap 990. Kalshi 702.83 + Polymarket 286.55 = 989.38.
// The cap must see both, and a later snapshot of the same rows must not add them again.
{
  const LOCK = '69ec5e47-8b31-4207-b83f-936cf8e9352f';
  const memory = {};
  const session = {};
  noteCapFill(memory, session, LOCK, 702.83);
  noteCapFill(memory, session, LOCK, 286.55);
  assert.strictEqual(memory[LOCK], 989.38);
  assert.strictEqual(session[LOCK], 989.38);
  assert.strictEqual(Math.max(memory[LOCK], session[LOCK]), 989.38, 'session and memory are not summed');

  const rows = [
    { parlay_id: LOCK, fill_id: 'kalshi-1', count: 702.83 },
    { parlay_id: LOCK, fill_id: 'poly-1', count: 286.55 },
  ];
  const merged = applyCapFillPage(memory, { ok: true, rows });
  assert.strictEqual(merged[LOCK], 989.38, 'refresh must not add the in-memory Polymarket fill on top of the same row');
  assert.notStrictEqual(merged, memory);

  const dup = applyCapFillPage(memory, { ok: true, rows: rows.concat([{ ...rows[1] }]) });
  assert.strictEqual(dup[LOCK], 989.38, 'a repeated fill_id counts once');

  const quote = {
    parlayStake: 300, parlayAmerican: 230, fillAmerican: 195,
    rfqContracts: 164, hedgeMode: '1x', maxContracts: 990, outstanding: 0,
  };
  const blocked = decideAtFill({ ...quote, filledSoFar: merged[LOCK] });
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.reason, 'limit_reached');
  const kalshiOnly = decideAtFill({ ...quote, filledSoFar: 702.83 });
  assert.strictEqual(kalshiOnly.ok, true);
  assert.strictEqual(kalshiOnly.contracts, 164, 'ignoring Polymarket would still quote 164 into a 0.62 remainder');

  const ahead = { [LOCK]: 989.38 };
  const staleDb = applyCapFillPage(ahead, { ok: true, rows: [{ parlay_id: LOCK, fill_id: 'kalshi-1', count: 702.83 }] });
  assert.strictEqual(staleDb[LOCK], 989.38, 'a snapshot that missed the Polymarket row must not wipe the in-memory count');

  const failed = applyCapFillPage(ahead, { ok: false, rows: [{ parlay_id: LOCK, fill_id: 'x', count: 1 }], error: { message: 'timeout' } });
  assert.strictEqual(failed, ahead, 'a failed page returns the same map');
  assert.strictEqual(failed[LOCK], 989.38);
}

{
  const seen = [];
  function fakeSupabase(all) {
    return {
      from() {
        const state = { parlayId: null };
        const q = {
          select() { return q; },
          eq(col, val) { if (col === 'parlay_id') state.parlayId = val; return q; },
          not() { return q; },
          order() { return q; },
          range(from, to) {
            seen.push([from, to]);
            let batch = all.slice(from, to + 1);
            if (state.parlayId) batch = all.filter((r) => r.parlay_id === state.parlayId).slice(from, to + 1);
            return Promise.resolve({ data: batch, error: null });
          },
        };
        return q;
      },
    };
  }
  const all = [];
  for (let i = 0; i < 1500; i++) {
    all.push({ parlay_id: 'L', fill_id: `f${i}`, count: 1, order_id: `o${i}`, raw: {} });
  }
  all.push({ parlay_id: 'L', fill_id: 'f0', count: 50, order_id: 'dup', raw: {} });
  loadCapFillRows(fakeSupabase(all)).then((page) => {
    assert.strictEqual(page.ok, true);
    assert.strictEqual(page.rows.length, 1501);
    assert.deepStrictEqual(seen, [[0, 999], [1000, 1999]]);
    const summed = sumCapFills(page.rows);
    assert.strictEqual(summed.L, 1500, '1500 rows plus a repeated fill_id is 1500, not the first page of 1000');
    assert.strictEqual(CAP_FILL_PAGE_SIZE, 1000);

    const memory = { L: 40 };
    const merged = applyCapFillPage(memory, page);
    assert.strictEqual(merged.L, 1500);

    seen.length = 0;
    return loadCapFillRows(fakeSupabase(all), { parlayId: 'L' });
  }).then((one) => {
    assert.strictEqual(one.ok, true);
    assert.strictEqual(sumCapFills(one.rows).L, 1500);
    let n = 0;
    const boom = {
      from() {
        const q = {
          select() { return q; },
          eq() { return q; },
          not() { return q; },
          order() { return q; },
          range() {
            n += 1;
            if (n === 1) return Promise.resolve({ data: all.slice(0, 1000), error: null });
            return Promise.resolve({ data: null, error: { message: 'page 2 failed' } });
          },
        };
        return q;
      },
    };
    return loadCapFillRows(boom);
  }).then((bad) => {
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.rows.length, 1000, 'the first page is not a complete cap sum');
    const memory = { L: 989.38 };
    assert.strictEqual(applyCapFillPage(memory, bad), memory);
    console.log('refresh-state.test.js ok');
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
