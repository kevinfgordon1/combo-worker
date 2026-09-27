'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  fillContractCount,
  normalizeKalshiFill,
  bookFromQuoteExecution,
  planKalshiFillReconcile,
  planNetContracts,
  describeReconcilePlan,
  reconcileMode,
  reconcileFetchUsable,
  collectFillPages,
  applyKalshiFillPlan,
} = require('./kalshi-fill-confirm');
const {
  countsTowardCap,
  sumConfirmedFillCounts,
  isQuoteExecutionStub,
} = require('./fills-attr');

function close(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-9, msg || `${actual} ~= ${expected}`);
}

function quoteStub(orderId, count) {
  return {
    fill_id: orderId,
    order_id: orderId,
    count,
    parlay_id: 'p-jets-ari',
    ticker: 'KXMVECROSSCATEGORY-JETS-ARI',
    is_combo: true,
    is_taker: false,
    raw: { source: 'live-runner', venue: 'kalshi', quote_id: `q-${orderId}` },
  };
}

// Jets + Cardinals, Sun Sep 27 2026: three executed quotes (250, 750, 133)
// were stored as fills. Kalshi's fills API has no fills for those orders.
// The real position is 2820.86 on other fills.
const PHANTOMS = [
  quoteStub('ord-0213', 250),
  quoteStub('ord-0232', 750),
  quoteStub('ord-0557', 133),
];
const REAL = {
  fill_id: 'trade-jets',
  order_id: 'ord-real',
  count: 2820.86,
  parlay_id: 'p-jets-ari',
  ticker: 'KXMVECROSSCATEGORY-JETS-ARI',
  is_combo: true,
  is_taker: false,
  raw: { trade_id: 'trade-jets', count_fp: '2820.86', order_id: 'ord-real' },
};
const KALSHI_REAL = {
  fill_id: 'trade-jets',
  trade_id: 'trade-jets',
  order_id: 'ord-real',
  count: 2820,
  count_fp: '2820.86',
  ticker: 'KXMVECROSSCATEGORY-JETS-ARI',
  is_taker: false,
};

assert.ok(PHANTOMS.every(isQuoteExecutionStub));
assert.ok(!isQuoteExecutionStub(REAL));
assert.ok(PHANTOMS.every((row) => !countsTowardCap(row)));
assert.ok(countsTowardCap(REAL));
close(sumConfirmedFillCounts(PHANTOMS.concat([REAL])), 2820.86);
close(
  PHANTOMS.reduce((sum, row) => sum + row.count, 0) + REAL.count,
  3953.86,
  'raw rows still contain the phantom 1133 until reconciliation'
);

{
  const plan = planKalshiFillReconcile(PHANTOMS.concat([REAL]), [KALSHI_REAL]);
  assert.deepStrictEqual(plan.drop.map((row) => row.count).sort((a, b) => a - b), [133, 250, 750]);
  assert.ok(plan.drop.every((row) => row.reason === 'no-kalshi-fill'));
  assert.strictEqual(plan.insert.length, 0);
  assert.strictEqual(plan.countFixes.length, 0);
  assert.ok(!plan.drop.some((row) => row.fill_id === REAL.fill_id));
  close(planNetContracts(plan), -1133);

  const kept = [REAL];
  const again = planKalshiFillReconcile(kept, [KALSHI_REAL]);
  assert.strictEqual(again.drop.length, 0);
  assert.strictEqual(again.insert.length, 0);
  assert.strictEqual(again.countFixes.length, 0);
  close(planNetContracts(again), 0);

  const lines = describeReconcilePlan(plan, { dryRun: true });
  assert.ok(lines.some((line) => line.startsWith('would drop') && line.includes('count=250')));
  assert.ok(lines.some((line) => line.includes('net_contracts=-1133') && line.includes('dry=yes')));
  assert.ok(!lines.some((line) => line.startsWith('dropping ')));
}

// Executed quote of 100 with two partial portfolio fills. Book count_fp, not 100.
{
  const quoted = 100;
  const fills = [
    { fill_id: 'fill-a', order_id: 'ord-partial', count: 40, count_fp: '40.50', trade_id: 'fill-a' },
    { fill_id: 'fill-b', order_id: 'ord-partial', count: 12, count_fp: '12.25', trade_id: 'fill-b' },
    { fill_id: 'other', order_id: 'someone-else', count_fp: '9.00', trade_id: 'other' },
  ];
  assert.strictEqual(fillContractCount(fills[0]), 40.5);
  assert.strictEqual(fillContractCount({ count: 7 }), 7);
  const booked = bookFromQuoteExecution({ orderId: 'ord-partial', fills });
  assert.strictEqual(booked.reason, 'confirmed');
  assert.strictEqual(booked.book.length, 2);
  close(booked.contracts, 52.75);
  assert.notStrictEqual(booked.contracts, quoted);
  const none = bookFromQuoteExecution({ orderId: 'ord-0213', fills: [] });
  assert.strictEqual(none.reason, 'no-portfolio-fill');
  assert.strictEqual(none.contracts, 0);
  assert.deepStrictEqual(none.book, []);
  const missingOrder = bookFromQuoteExecution({ fills });
  assert.strictEqual(missingOrder.reason, 'no-order-id');
}

// Stub of the full quote, real partials not yet in combo_fills: drop the stub
// and insert both count_fp rows. Running again changes nothing.
{
  const stub = quoteStub('ord-partial', 100);
  const fills = [
    { fill_id: 'fill-a', order_id: 'ord-partial', count: 40, count_fp: '40.50', trade_id: 'fill-a', ticker: 'KXMVE-X' },
    { fill_id: 'fill-b', order_id: 'ord-partial', count: 12, count_fp: '12.25', trade_id: 'fill-b', ticker: 'KXMVE-X' },
  ];
  const plan = planKalshiFillReconcile([stub, REAL], fills.concat([KALSHI_REAL]));
  assert.strictEqual(plan.drop.length, 1);
  assert.strictEqual(plan.drop[0].reason, 'quote-stub-superseded');
  assert.strictEqual(plan.insert.length, 2);
  close(plan.insert.reduce((sum, row) => sum + row.count, 0), 52.75);
  assert.ok(plan.insert.every((row) => row.parlay_id === 'p-jets-ari'));
  close(planNetContracts(plan), -100 + 52.75);

  const applied = [REAL].concat(plan.insert);
  const again = planKalshiFillReconcile(applied, fills.concat([KALSHI_REAL]));
  assert.strictEqual(again.drop.length, 0);
  assert.strictEqual(again.insert.length, 0);
  assert.strictEqual(again.countFixes.length, 0);
}

// Real fill already stored next to the stub: drop only the stub.
{
  const stub = quoteStub('ord-partial', 100);
  const partA = {
    fill_id: 'fill-a',
    order_id: 'ord-partial',
    count: 40.5,
    parlay_id: 'p-jets-ari',
    raw: { trade_id: 'fill-a', count_fp: '40.50', order_id: 'ord-partial' },
  };
  const partB = {
    fill_id: 'fill-b',
    order_id: 'ord-partial',
    count: 12.25,
    parlay_id: 'p-jets-ari',
    raw: { trade_id: 'fill-b', count_fp: '12.25', order_id: 'ord-partial' },
  };
  const fills = [
    { fill_id: 'fill-a', order_id: 'ord-partial', count_fp: '40.50', trade_id: 'fill-a' },
    { fill_id: 'fill-b', order_id: 'ord-partial', count_fp: '12.25', trade_id: 'fill-b' },
  ];
  const plan = planKalshiFillReconcile([stub, partA, partB], fills);
  assert.strictEqual(plan.drop.length, 1);
  assert.strictEqual(plan.drop[0].fill_id, 'ord-partial');
  assert.strictEqual(plan.insert.length, 0);
  close(sumConfirmedFillCounts([stub, partA, partB]), 52.75);
  const again = planKalshiFillReconcile([partA, partB], fills);
  assert.strictEqual(again.drop.length, 0);
}

// Integer count vs count_fp on a confirmed fill. Second pass is a no-op.
{
  const stored = {
    fill_id: 'fill-frac',
    order_id: 'ord-frac',
    count: 40,
    parlay_id: 'p-jets-ari',
    raw: { trade_id: 'fill-frac', order_id: 'ord-frac', count_fp: '40.00' },
  };
  const live = { fill_id: 'fill-frac', trade_id: 'fill-frac', order_id: 'ord-frac', count: 40, count_fp: '40.50' };
  const plan = planKalshiFillReconcile([stored], [live]);
  assert.strictEqual(plan.drop.length, 0);
  assert.strictEqual(plan.countFixes.length, 1);
  assert.strictEqual(plan.countFixes[0].from, 40);
  assert.strictEqual(plan.countFixes[0].to, 40.5);
  const fixed = [{ ...stored, count: 40.5 }];
  const again = planKalshiFillReconcile(fixed, [live]);
  assert.strictEqual(again.countFixes.length, 0);
  const normalized = normalizeKalshiFill(live);
  assert.strictEqual(normalized.count, 40.5);
  assert.strictEqual(normalized.fill_id, 'fill-frac');
}

// Maker order id may show up as creator_order_id on the fill, not order_id.
{
  const stub = quoteStub('maker-order', 250);
  const fill = {
    fill_id: 'trade-maker',
    trade_id: 'trade-maker',
    order_id: 'exchange-order',
    creator_order_id: 'maker-order',
    count: 80,
    count_fp: '80.10',
    ticker: 'KXMVE-X',
  };
  const booked = bookFromQuoteExecution({ orderId: 'maker-order', fills: [fill] });
  assert.strictEqual(booked.reason, 'confirmed');
  close(booked.contracts, 80.1);
  const plan = planKalshiFillReconcile([stub], [fill]);
  assert.strictEqual(plan.drop.length, 1);
  assert.strictEqual(plan.drop[0].reason, 'quote-stub-superseded');
  assert.strictEqual(plan.insert.length, 1);
  close(plan.insert[0].count, 80.1);
  const again = planKalshiFillReconcile(plan.insert, [fill]);
  assert.strictEqual(again.drop.length, 0);
  assert.strictEqual(again.insert.length, 0);
}

// Failed Kalshi lookup must not delete the row. Polymarket rows stay.
{
  const stub = quoteStub('ord-unknown', 80);
  const poly = {
    fill_id: 'poly-act:abc',
    order_id: 'poly-order',
    count: 10,
    parlay_id: 'p-jets-ari',
    ticker: 'caoc-abc',
    raw: { source: 'poly-activity', venue: 'polymarket' },
  };
  const plan = planKalshiFillReconcile([stub, poly, REAL], [KALSHI_REAL], {
    unverifiedOrderIds: ['ord-unknown'],
  });
  assert.strictEqual(plan.drop.length, 0);
  assert.strictEqual(plan.skipped.length, 1);
  assert.strictEqual(plan.skipped[0].reason, 'kalshi-lookup-failed');
  assert.ok(countsTowardCap(poly));
}

{
  assert.strictEqual(reconcileMode([], {}), 'dry-run');
  assert.strictEqual(reconcileMode(['--dry-run'], { RECONCILE_APPLY: '1' }), 'dry-run');
  assert.strictEqual(reconcileMode(['--apply'], {}), 'apply');
  assert.strictEqual(reconcileMode([], { RECONCILE_APPLY: '1' }), 'apply');
  assert.strictEqual(reconcileFetchUsable({ ok: true, fills: [], truncated: false }), true);
  assert.strictEqual(reconcileFetchUsable({ ok: true, truncated: true }), false);
  assert.strictEqual(reconcileFetchUsable({ ok: false, truncated: false }), false);
  assert.strictEqual(reconcileFetchUsable(null), false);
}

async function runAsync() {
  const pages = [
    { ok: true, fills: [{ fill_id: 'a', count_fp: '1.50' }], cursor: 'c1' },
    { ok: true, fills: [{ fill_id: 'b', count_fp: '2.25' }], cursor: '' },
  ];
  const result = await collectFillPages(async () => pages.shift());
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.fills.length, 2);
  close(fillContractCount(result.fills[0]) + fillContractCount(result.fills[1]), 3.75);

  const failed = await collectFillPages(async () => ({ ok: false, error: 'down' }));
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(reconcileFetchUsable(failed), false);

  const plan = planKalshiFillReconcile(PHANTOMS.concat([REAL]), [KALSHI_REAL]);
  let writes = 0;
  const io = {
    deleteFill: async () => { writes += 1; },
    insertFill: async () => { writes += 1; },
    updateCount: async () => { writes += 1; },
  };
  const dry = await applyKalshiFillPlan(io, plan, { dryRun: true, log: () => {} });
  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(writes, 0);
  assert.strictEqual(dry.dropped, 0);
  const applied = await applyKalshiFillPlan(io, plan, { dryRun: false, log: () => {} });
  assert.strictEqual(applied.dryRun, false);
  assert.strictEqual(applied.dropped, 3);
  assert.strictEqual(writes, 3);
  assert.strictEqual(applied.inserted, 0);
}

{
  const liveSrc = fs.readFileSync(path.join(__dirname, 'live-runner.js'), 'utf8');
  const fillsSrc = fs.readFileSync(path.join(__dirname, 'fills-reader.js'), 'utf8');
  assert.ok(/normalizeKalshiFill/.test(fillsSrc), 'fills-reader must store count_fp via normalizeKalshiFill');
  assert.ok(/sumConfirmedFillCounts/.test(fillsSrc));
  assert.ok(!/f\.count != null \? f\.count : \(f\.count_fp/.test(fillsSrc));
  assert.ok(/countsTowardCap/.test(liveSrc));
  assert.ok(/bookFromQuoteExecution/.test(liveSrc));
  const script = fs.readFileSync(path.join(__dirname, 'scripts/reconcile-kalshi-phantom-fills.js'), 'utf8');
  assert.ok(/reconcileMode/.test(script) && /--apply/.test(script));
  assert.ok(/reconcileFetchUsable/.test(script));
  assert.ok(/if \(require\.main === module\)/.test(script));
  assert.ok(/not changing combo_fills/.test(script));
}

runAsync().then(() => {
  console.log('kalshi-fill-confirm.test.js ok');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
