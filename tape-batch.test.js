'use strict';
const assert = require('assert');
const tb = require('./tape-batch');

const T0 = Date.parse('2026-10-17T21:31:00Z');
const iso = (ms) => new Date(ms).toISOString();
const trade = (id, ms, count, yes) => ({
  trade_id: id, created_time: iso(ms), count_fp: String(count),
  yes_price_dollars: String(yes), no_price_dollars: String(Math.round((1 - yes) * 10000) / 10000),
  is_block_trade: false,
});

// One print, five repeat requests near it: only the request that closed nearest wins it.
{
  const rows = [0, 3, 6, 9, 12].map((s, i) => ({
    id: `r${i}`, created_at: iso(T0 + s * 1000 - 2000), rfq_closed_at: iso(T0 + s * 1000),
  }));
  const out = tb.assignTrades(rows, [trade('t1', T0 + 6200, 58.27, 0.162)]);
  assert.strictEqual(out.size, 1);
  assert.ok(out.has('r2'));
  assert.strictEqual(out.get('r2').yes, 0.162);
  const patches = rows.map((r) => tb.patchFor(r, out.get(r.id), 'KX'));
  assert.strictEqual(patches.filter((p) => p.skip_reason === 'outbid').length, 1);
  assert.strictEqual(patches.filter((p) => p.skip_reason === 'no_print').length, 4);
  assert.strictEqual(patches[2].tape_trade_id, 't1');
  assert.strictEqual(patches[2].tape_match, 'matched');
  assert.strictEqual(patches[0].tape_match, 'none');
}

// Size beats time: an exact-size print goes to the request of that size.
{
  const rows = [
    { id: 'a', created_at: iso(T0 - 1000), rfq_closed_at: iso(T0), rfq_contracts: 100 },
    { id: 'b', created_at: iso(T0 - 1000), rfq_closed_at: iso(T0 + 500), rfq_contracts: 40 },
  ];
  const out = tb.assignTrades(rows, [trade('x', T0 + 400, 100, 0.2), trade('y', T0 + 450, 40, 0.21)]);
  assert.strictEqual(out.get('a').raw.trade_id, 'x');
  assert.strictEqual(out.get('b').raw.trade_id, 'y');
  // Wrong size → no match at all (not a guess).
  const none = tb.assignTrades([rows[1]], [trade('z', T0 + 450, 300, 0.2)]);
  assert.strictEqual(none.size, 0);
}

// Claimed trades (credited before) are never reused.
{
  const rows = [{ id: 'a', created_at: iso(T0 - 1000), rfq_closed_at: iso(T0) }];
  const out = tb.assignTrades(rows, [trade('t1', T0 + 100, 10, 0.3)], { claimed: new Set(['t1']) });
  assert.strictEqual(out.size, 0);
}

// No size known: print must be within NEAR_CLOSE_MS of the close; outside the window → none.
{
  const row = { id: 'a', created_at: iso(T0 - 1000), rfq_closed_at: iso(T0) };
  assert.strictEqual(tb.assignTrades([row], [trade('n', T0 + tb.NEAR_CLOSE_MS + 1, 5, 0.1)]).size, 0);
  assert.strictEqual(tb.assignTrades([row], [trade('n', T0 + 2000, 5, 0.1)]).size, 1);
  assert.strictEqual(tb.assignTrades([row], [trade('n', T0 - 5000, 5, 0.1)]).size, 0); // before create
}

// Legacy rows (no close time): close in [created, created + 21s].
{
  const w = tb.rowWindow({ created_at: iso(T0) });
  assert.strictEqual(w.closeLo, T0);
  assert.strictEqual(w.closeHi, T0 + tb.LEGACY_CLOSE_SPAN_MS);
  assert.strictEqual(w.exactClose, false);
  const out = tb.assignTrades([{ id: 'L', created_at: iso(T0) }], [trade('m', T0 + 15000, 7, 0.4)]);
  assert.strictEqual(out.size, 1);
}

// Due / spans / grouping.
{
  const row = { id: 'a', created_at: iso(T0 - 1000), rfq_closed_at: iso(T0), market_ticker: 'K1' };
  assert.strictEqual(tb.isBatchDue(row, T0 + 1000), false);
  assert.strictEqual(tb.isBatchDue(row, T0 + tb.TAPE_PAD_MS), true);
  assert.strictEqual(tb.isBatchDue({ created_at: iso(T0) }, T0 + 1e9), false); // no close time
  const span = tb.fetchSpan([row, { ...row, id: 'b', rfq_closed_at: iso(T0 + 60000) }]);
  assert.ok(span.minTs <= Math.floor((T0 - 2000) / 1000));
  assert.ok(span.maxTs >= Math.ceil((T0 + 60000 + tb.TAPE_PAD_MS) / 1000));
  const g = tb.groupByTicker([row, { ...row, id: 'c', market_ticker: 'K2' }, { id: 'd' }]);
  assert.deepStrictEqual([...g.keys()], ['K1', 'K2']);
}

console.log('tape-batch.test.js ok');

// Backfill script pure parts.
{
  const { inferTickers, clusters, relabelTicker, summarize } = require('./scripts/relabel-closed-tape');
  const rows = [
    { id: 'a', parlay_id: 'p', market_ticker: 'K', created_at: iso(T0), skip_reason: 'outbid', tape_yes_price: 0.162 },
    { id: 'b', parlay_id: 'p', market_ticker: null, created_at: iso(T0 + 3000), skip_reason: 'outbid', tape_yes_price: 0.162 },
    { id: 'c', parlay_id: 'p', market_ticker: null, created_at: iso(T0 + 3 * 3600e3), skip_reason: 'rfq_closed_live' },
    { id: 'd', parlay_id: 'q', market_ticker: null, created_at: iso(T0), skip_reason: 'no_print' },
  ];
  const inf = inferTickers(rows);
  assert.deepStrictEqual(inf, { inferred: 2, unknown: 1 });
  assert.strictEqual(rows[1].market_ticker, 'K');
  assert.strictEqual(clusters(rows.slice(0, 3)).length, 2);
  // a and b both claimed the same print before; now only one keeps it.
  const dec = relabelTicker(rows.slice(0, 2), [trade('t1', T0 + 1500, 58, 0.162)], 'K');
  const s = summarize(dec);
  assert.strictEqual(s.outbidWithPriceBefore, 2);
  assert.strictEqual(s.outbidWithPriceAfter, 1);
  assert.strictEqual(s.changed, 1);
  assert.strictEqual(s.transitions['outbid(price) → no_print'], 1);
}
console.log('tape-batch.test.js backfill ok');
