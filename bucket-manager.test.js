'use strict';
const assert = require('assert');
const {
  CENTICENTS_PER_DOLLAR,
  dollarsToCenticents,
  centsToCenticents,
  loadBucketConfig,
  isGameday,
  planBucketAction,
  parseShardBalance,
  usdCashFromBalances,
  isOpenPosition,
  createKalshiBucketClient,
  parseTransfers,
  transferStatusClass,
  TRANSFERS_PATH,
  readPolyCashFromHttp,
  polyReaderFromEnv,
  createBucketManager,
} = require('./bucket-manager');

function cents(dollars) {
  return Math.round(dollars * 100);
}

function at(iso) {
  return new Date(iso);
}

const WED = at('2026-01-14T15:00:00.000Z'); // Wednesday 10:00 EST

// Pre-Oct-2 values, pinned so the older scenario tests keep their arithmetic.
// The current defaults are asserted separately.
const LEGACY_LIMITS = {
  KALSHI_BUCKET_TARGET_DEFAULT: '5000',
  KALSHI_BUCKET_TARGET_GAMEDAY: '10000',
  KALSHI_BUCKET_CEILING: '15000',
};

function baseConfig(over = {}) {
  const cfg = loadBucketConfig(LEGACY_LIMITS);
  return Object.assign(cfg, over);
}

// --- money and balance parsing ------------------------------------------------

assert.strictEqual(CENTICENTS_PER_DOLLAR, 10_000);
assert.strictEqual(dollarsToCenticents(3000), 30_000_000);
assert.strictEqual(dollarsToCenticents(100.019), 1_000_100, 'floor to the cent: $100.01');
assert.strictEqual(dollarsToCenticents(100.009), 1_000_000, 'floor to the cent: $100.00');
assert.strictEqual(dollarsToCenticents(0), 0);
assert.strictEqual(dollarsToCenticents(-5), 0);
assert.strictEqual(centsToCenticents(cents(3000)), 30_000_000);
assert.strictEqual(centsToCenticents(cents(3000)) % 100, 0);

{
  const parsed = parseShardBalance({
    balance: 213,
    balance_dollars: '2.1399',
    portfolio_value: 500,
  });
  assert.strictEqual(parsed.availableCents, 213);
  assert.strictEqual(parsed.portfolioCents, 500);
  const dollarsOnly = parseShardBalance({ balance_dollars: '2000.0099', portfolio_value: 0 });
  assert.strictEqual(dollarsOnly.availableCents, 200_000);
}

assert.strictEqual(usdCashFromBalances({
  balances: [{ currency: 'USD', currentBalance: 1200.5 }, { currency: 'EUR', currentBalance: 9 }],
}), 1200.5);
assert.strictEqual(usdCashFromBalances({ currentBalance: 40, currency: 'USD' }), 40);
assert.strictEqual(isOpenPosition({ position_fp: '0.00', position: 0 }), false);
assert.strictEqual(isOpenPosition({ position_fp: '1.00' }), true);
assert.strictEqual(isOpenPosition({ position: -3 }), true);

// --- game-day schedule in America/New_York, including DST -------------------

assert.strictEqual(isGameday(at('2026-01-10T05:00:00.000Z')), true, 'Sat 00:00 EST');
assert.strictEqual(isGameday(at('2026-01-10T04:59:00.000Z')), true, 'Fri 23:59 EST (Friday playoff + college window)');
assert.strictEqual(isGameday(at('2026-01-09T16:59:00.000Z')), false, 'Fri 11:59 EST');
assert.strictEqual(isGameday(at('2026-01-09T17:00:00.000Z')), true, 'Fri 12:00 EST');
assert.strictEqual(isGameday(at('2026-01-09T08:01:00.000Z')), false, 'Fri 03:01 EST (between the windows)');
assert.strictEqual(isGameday(at('2026-01-13T04:59:00.000Z')), true, 'Mon 23:59 EST');
assert.strictEqual(isGameday(at('2026-01-13T05:00:00.000Z')), false, 'Tue 00:00 EST');
assert.strictEqual(isGameday(at('2026-01-08T16:59:00.000Z')), false, 'Thu 11:59 EST');
assert.strictEqual(isGameday(at('2026-01-08T17:00:00.000Z')), true, 'Thu 12:00 EST');
assert.strictEqual(isGameday(at('2026-01-09T08:00:00.000Z')), true, 'Fri 03:00 EST');
assert.strictEqual(isGameday(at('2026-01-09T08:01:00.000Z')), false, 'Fri 03:01 EST');
assert.strictEqual(isGameday(at('2026-01-11T18:00:00.000Z')), true, 'Sunday afternoon EST');

// Fixed EST (UTC-5) would call Saturday 00:30 EDT Friday night.
assert.strictEqual(isGameday(at('2026-07-11T04:00:00.000Z')), true, 'Sat 00:00 EDT');
assert.strictEqual(isGameday(at('2026-07-11T03:59:00.000Z')), true, 'Fri 23:59 EDT');
assert.strictEqual(isGameday(at('2026-07-10T15:59:00.000Z')), false, 'Fri 11:59 EDT');
assert.strictEqual(isGameday(at('2026-07-10T16:00:00.000Z')), true, 'Fri 12:00 EDT');
assert.strictEqual(isGameday(at('2026-10-02T21:20:00.000Z')), true, 'Fri 5:20 PM EDT Oct 2 2026 is gameday now');
assert.strictEqual(isGameday(at('2026-07-11T04:30:00.000Z')), true, 'Sat 00:30 EDT');
// Fixed EDT (UTC-4) would call Monday 23:59 EST Tuesday.
assert.strictEqual(isGameday(at('2026-09-24T16:00:00.000Z')), true, 'Thu 12:00 EDT');
assert.strictEqual(isGameday(at('2026-09-25T07:00:00.000Z')), true, 'Fri 03:00 EDT');
assert.strictEqual(isGameday(at('2026-09-25T07:01:00.000Z')), false, 'Fri 03:01 EDT');
// Fall-back Sunday, both 01:30 instants are still the weekend window.
assert.strictEqual(isGameday(at('2026-11-01T05:30:00.000Z')), true);
assert.strictEqual(isGameday(at('2026-11-01T06:30:00.000Z')), true);

{
  const custom = loadBucketConfig({
    KALSHI_BUCKET_SCHEDULE: JSON.stringify([
      { id: 'wednesday', start: { dow: 3, time: '00:00' }, end: { dow: 3, time: '23:59' } },
    ]),
  });
  assert.strictEqual(custom.scheduleError, null);
  assert.strictEqual(isGameday(WED, custom.windows), true, 'custom list can make Wednesday a game day');
  assert.strictEqual(isGameday(at('2026-01-10T05:00:00.000Z'), custom.windows), false);
  const bad = loadBucketConfig({ KALSHI_BUCKET_SCHEDULE: '{nope' });
  assert.ok(bad.scheduleError);
  assert.strictEqual(isGameday(at('2026-01-10T05:00:00.000Z'), bad.windows), true, 'bad JSON keeps the default list');
}

{
  const cfg = loadBucketConfig({});
  assert.strictEqual(cfg.auto, false);
  assert.strictEqual(cfg.sweep, false);
  assert.strictEqual(cfg.ceilingCents, cents(22_000));
  assert.strictEqual(cfg.floorCents, cents(2_000));
  assert.strictEqual(cfg.maxTransferCents, cents(10_000));
  assert.strictEqual(cfg.dailyCapCents, cents(15_000));
  assert.strictEqual(cfg.minTransferCents, cents(100));
  assert.strictEqual(cfg.targetGamedayCents, cents(12_000));
  assert.strictEqual(cfg.targetDefaultCents, cents(8_000));
  assert.strictEqual(cfg.insufficientBufferCents, cents(500));
  assert.strictEqual(cfg.lowAlertCents, cents(1_500));
  assert.strictEqual(cfg.polyLowAlertCents, cents(1_500));
  assert.strictEqual(cfg.intervalMin, 5);
  assert.strictEqual(loadBucketConfig({ KALSHI_BUCKET_AUTO: '1' }).auto, true);
  assert.strictEqual(loadBucketConfig({ KALSHI_BUCKET_SWEEP: '0' }).sweep, false);
}

// --- pure plan ----------------------------------------------------------------

{
  const cfg = baseConfig();
  const top = planBucketAction({
    mainAvailableCents: cents(20_000),
    bucketAvailableCents: cents(2_000),
    bucketPortfolioCents: 0,
    gameday: false,
    sweepEnabled: false,
    flat: null,
    dailyTopupCents: 0,
    config: cfg,
  });
  assert.strictEqual(top.action, 'topup');
  assert.strictEqual(top.amountCents, cents(3_000));
  assert.strictEqual(top.fromShard, 0);
  assert.strictEqual(top.toShard, 1);
  assert.strictEqual(top.reason, 'top-up');

  // Ceiling is on available cash only: open-position value does not count.
  const cfgLow = baseConfig({ ceilingCents: cents(9_000) });
  const ceiling = planBucketAction({
    mainAvailableCents: cents(50_000),
    bucketAvailableCents: cents(2_000),
    bucketPortfolioCents: cents(12_000),
    gameday: true,
    sweepEnabled: false,
    flat: null,
    dailyTopupCents: 0,
    config: cfgLow,
  });
  assert.strictEqual(ceiling.action, 'topup');
  assert.strictEqual(ceiling.amountCents, cents(7_000), 'ceiling on available cash: $9,000 - $2,000');
  assert.strictEqual(ceiling.clamp, 'ceiling');

  const withPositions = planBucketAction({
    mainAvailableCents: cents(50_000),
    bucketAvailableCents: cents(1_000),
    bucketPortfolioCents: cents(14_500),
    gameday: false,
    sweepEnabled: false,
    flat: null,
    dailyTopupCents: 0,
    config: cfg,
  });
  assert.strictEqual(withPositions.action, 'topup', 'open positions no longer block a top-up');
  assert.strictEqual(withPositions.amountCents, cents(4_000));
  assert.strictEqual(withPositions.clamp, null);

  const ceilingBlock = planBucketAction({
    mainAvailableCents: cents(50_000),
    bucketAvailableCents: cents(4_900),
    bucketPortfolioCents: 0,
    gameday: false,
    sweepEnabled: false,
    flat: null,
    dailyTopupCents: 0,
    config: baseConfig({ ceilingCents: cents(4_950) }),
  });
  assert.strictEqual(ceilingBlock.action, 'blocked');
  assert.strictEqual(ceilingBlock.block, 'ceiling');
  assert.strictEqual(ceilingBlock.amountCents, 0);

  const floor = planBucketAction({
    mainAvailableCents: cents(2_500),
    bucketAvailableCents: 0,
    bucketPortfolioCents: 0,
    gameday: false,
    sweepEnabled: false,
    flat: null,
    dailyTopupCents: 0,
    config: cfg,
  });
  assert.strictEqual(floor.action, 'topup');
  assert.strictEqual(floor.amountCents, cents(500));
  assert.strictEqual(floor.clamp, 'floor');

  const floorBlock = planBucketAction({
    mainAvailableCents: cents(2_000),
    bucketAvailableCents: 0,
    bucketPortfolioCents: 0,
    gameday: false,
    sweepEnabled: false,
    flat: null,
    dailyTopupCents: 0,
    config: cfg,
  });
  assert.strictEqual(floorBlock.action, 'blocked');
  assert.strictEqual(floorBlock.block, 'floor');

  const daily = planBucketAction({
    mainAvailableCents: cents(50_000),
    bucketAvailableCents: cents(1_000),
    bucketPortfolioCents: 0,
    gameday: false,
    sweepEnabled: false,
    flat: null,
    dailyTopupCents: cents(15_000),
    config: cfg,
  });
  assert.strictEqual(daily.action, 'blocked');
  assert.strictEqual(daily.block, 'daily_cap');

  const dust = planBucketAction({
    mainAvailableCents: cents(20_000),
    bucketAvailableCents: cents(4_950),
    bucketPortfolioCents: 0,
    gameday: false,
    sweepEnabled: false,
    flat: null,
    dailyTopupCents: 0,
    config: cfg,
  });
  assert.strictEqual(dust.action, 'hold');
  assert.strictEqual(dust.reason, 'min_transfer');
}

function fakeBook(initial) {
  const state = {
    main: { availableCents: initial.main, portfolioCents: initial.mainPortfolio || 0 },
    bucket: { availableCents: initial.bucket, portfolioCents: initial.bucketPortfolio || 0 },
    flat: initial.flat || { openPositions: false, restingOrders: false, uncertain: false },
    flatError: initial.flatError || null,
    transferError: initial.transferError || null,
    applyTransfer: initial.applyTransfer !== false,
    // Kalshi transfer record status for each POST: 'complete' (default when the
    // balance moves), 'processing', 'failed', or null for no record at all.
    recordStatus: initial.recordStatus !== undefined
      ? initial.recordStatus
      : (initial.applyTransfer !== false ? 'complete' : null),
    recordsError: initial.recordsError || null,
    // Combo spend landing on shard 1 while the transfer settles.
    spendOnTransferCents: initial.spendOnTransferCents || 0,
    records: [],
  };
  const transfers = [];
  const calls = { getShard: 0, transfer: 0, shardActivity: 0 };
  let activeTransfers = 0;
  let maxActiveTransfers = 0;
  let releaseTransfer = null;
  let transferWait = null;
  const client = {
    async getShard(index) {
      calls.getShard += 1;
      const src = index === 0 ? state.main : state.bucket;
      return { availableCents: src.availableCents, portfolioCents: src.portfolioCents };
    },
    async transfer(body) {
      calls.transfer += 1;
      activeTransfers += 1;
      maxActiveTransfers = Math.max(maxActiveTransfers, activeTransfers);
      transfers.push(body);
      if (transferWait) {
        const started = transferWait.started;
        transferWait = null;
        started();
        await new Promise((resolve) => { releaseTransfer = resolve; });
      }
      activeTransfers -= 1;
      if (state.transferError) throw new Error(state.transferError);
      if (state.applyTransfer) {
        const centsMoved = body.amountCenticents / 100;
        if (body.fromShard === 0) {
          state.main.availableCents -= centsMoved;
          state.bucket.availableCents += centsMoved;
        } else {
          state.bucket.availableCents -= centsMoved;
          state.main.availableCents += centsMoved;
        }
      }
      const transferId = `tr_${transfers.length}`;
      if (state.spendOnTransferCents) state.bucket.availableCents -= state.spendOnTransferCents;
      if (state.recordStatus) {
        state.records.unshift({
          transferId,
          status: state.recordStatus,
          amountCents: body.amountCenticents / 100,
          fromShard: body.fromShard,
          toShard: body.toShard,
        });
      }
      return { transferId };
    },
    async getTransfers() {
      calls.getTransfers = (calls.getTransfers || 0) + 1;
      if (state.recordsError) throw new Error(state.recordsError);
      return state.records.map((r) => ({ ...r }));
    },
    async shardActivity() {
      calls.shardActivity += 1;
      if (state.flatError) throw new Error(state.flatError);
      return { ...state.flat };
    },
    holdNextTransfer() {
      transferWait = {};
      const started = new Promise((resolve) => { transferWait.started = resolve; });
      return {
        started,
        release() { if (releaseTransfer) releaseTransfer(); },
      };
    },
  };
  return { state, transfers, calls, client, maxActive: () => maxActiveTransfers };
}

function harness(env, book, when) {
  let current = when || WED;
  const alerts = [];
  const logs = [];
  const mgr = createBucketManager({
    env: { ...LEGACY_LIMITS, ...env },
    now: () => current,
    alert(text) { alerts.push(text); },
    log(line) { logs.push(String(line)); },
    sleep: async () => {},
    client: book.client,
    readPolyCash: env.readPolyCash === undefined ? null : env.readPolyCash,
  });
  return {
    mgr,
    alerts,
    logs,
    setNow(d) { current = d; },
    now() { return current; },
  };
}

const LIVE = {
  ...LEGACY_LIMITS,
  KALSHI_BUCKET_AUTO: '1',
  KALSHI_BUCKET_SWEEP: '0',
};

async function main() {
  // Normal top-up to the weekday target, then a re-read before any further move.
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(2_000) });
    const h = harness(LIVE, book);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.action, 'topup');
    assert.strictEqual(out.confirmed, true);
    assert.strictEqual(book.transfers.length, 1);
    assert.strictEqual(book.transfers[0].amountCenticents, centsToCenticents(cents(3_000)));
    assert.strictEqual(book.transfers[0].fromShard, 0);
    assert.strictEqual(book.transfers[0].toShard, 1);
    assert.strictEqual(book.state.bucket.availableCents, cents(5_000));
    assert.strictEqual(book.state.main.availableCents, cents(17_000));
    assert.ok(book.calls.getShard >= 4, 're-read both shards after the transfer');
    assert.ok(h.alerts.some((t) => t.includes('$3,000.00') && t.includes('shard 0 (main)') && t.includes('shard 1 (combo)')));
    const again = await h.mgr.check('interval');
    assert.strictEqual(again.decision.action, 'hold');
    assert.strictEqual(book.transfers.length, 1);
  }

  // Ceiling clamps a partial top-up and blocks when there is no legal room.
  {
    const book = fakeBook({
      main: cents(50_000),
      bucket: cents(2_000),
      bucketPortfolio: cents(12_000),
    });
    const h = harness({ ...LIVE, KALSHI_BUCKET_TARGET_DEFAULT: '10000', KALSHI_BUCKET_CEILING: '9000' }, book);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.amountCents, cents(7_000), 'ceiling on available cash: $9,000 - $2,000');
    assert.strictEqual(out.decision.clamp, 'ceiling');
    assert.strictEqual(book.transfers.length, 1);
    assert.ok(!h.alerts.some((t) => /blocked/.test(t)));
  }
  {
    const book = fakeBook({ main: cents(50_000), bucket: cents(4_900) });
    const h = harness({ ...LIVE, KALSHI_BUCKET_CEILING: '4950' }, book);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.block, 'ceiling');
    assert.strictEqual(book.transfers.length, 0);
    assert.ok(h.alerts.some((t) => /blocked \(ceiling\)/.test(t) && /ceiling on available cash/.test(t)));
  }
  // Large open-position value does not block a top-up.
  {
    const book = fakeBook({
      main: cents(50_000),
      bucket: cents(1_000),
      bucketPortfolio: cents(14_500),
    });
    const h = harness(LIVE, book);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.action, 'topup');
    assert.strictEqual(out.decision.clamp, null);
    assert.strictEqual(book.transfers.length, 1);
    assert.strictEqual(book.state.bucket.availableCents, cents(5_000));
  }

  // Main floor clamps, then blocks.
  {
    const book = fakeBook({ main: cents(2_500), bucket: 0 });
    const h = harness(LIVE, book);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.amountCents, cents(500));
    assert.strictEqual(out.decision.clamp, 'floor');
    assert.strictEqual(book.state.main.availableCents, cents(2_000));
    assert.strictEqual(book.transfers.length, 1);
  }
  {
    const book = fakeBook({ main: cents(2_000), bucket: 0 });
    const h = harness(LIVE, book);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.block, 'floor');
    assert.strictEqual(book.transfers.length, 0);
    assert.ok(h.alerts.some((t) => /blocked \(floor\)/.test(t)));
  }

  // Daily cap: $10k max per transfer, $15k per ET day, then a block.
  {
    const book = fakeBook({ main: cents(100_000), bucket: 0 });
    const h = harness({
      ...LIVE,
      KALSHI_BUCKET_TARGET_DEFAULT: '40000',
      KALSHI_BUCKET_CEILING: '50000',
      KALSHI_BUCKET_MAX_TRANSFER: '10000',
      KALSHI_BUCKET_DAILY_CAP: '15000',
    }, book);
    const first = await h.mgr.check('interval');
    assert.strictEqual(first.decision.amountCents, cents(10_000));
    const second = await h.mgr.check('interval');
    assert.strictEqual(second.decision.amountCents, cents(5_000));
    assert.strictEqual(second.decision.clamp, 'daily_cap');
    const third = await h.mgr.check('interval');
    assert.strictEqual(third.decision.block, 'daily_cap');
    assert.strictEqual(book.transfers.length, 2);
    assert.ok(h.alerts.some((t) => /blocked \(daily_cap\)/.test(t)));
    h.setNow(at('2026-01-15T15:00:00.000Z'));
    const nextDay = await h.mgr.check('interval');
    assert.strictEqual(nextDay.decision.action, 'topup');
    assert.strictEqual(book.transfers.length, 3, 'ET date rollover resets the daily cap');
  }

  // Dry run reads balances and does not call transfer.
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(2_000) });
    book.client.transfer = async () => { throw new Error('dry run must not transfer'); };
    const h = harness({ KALSHI_BUCKET_AUTO: '0' }, book);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.decision.action, 'topup');
    assert.strictEqual(out.decision.amountCents, cents(3_000));
    assert.ok(book.calls.getShard >= 2);
    assert.ok(h.logs.some((line) => line.includes('DRY RUN would transfer')));
    assert.ok(!h.alerts.some((t) => /bucket transfer/.test(t)));
  }

  // Sweep: off by default, then on only when flat, off-window, and above target.
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(12_000) });
    const h = harness({ KALSHI_BUCKET_AUTO: '1', KALSHI_BUCKET_SWEEP: '0' }, book);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.action, 'hold');
    assert.strictEqual(book.calls.shardActivity, 0);
    assert.strictEqual(book.transfers.length, 0);
  }
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(12_000) });
    const h = harness({ KALSHI_BUCKET_AUTO: '1', KALSHI_BUCKET_SWEEP: '1' }, book);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.action, 'sweep');
    assert.strictEqual(out.decision.amountCents, cents(7_000));
    assert.strictEqual(book.transfers[0].fromShard, 1);
    assert.strictEqual(book.transfers[0].toShard, 0);
    assert.strictEqual(book.state.bucket.availableCents, cents(5_000));
    assert.strictEqual(book.calls.shardActivity, 1);
  }
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(12_000) });
    const h = harness({ KALSHI_BUCKET_AUTO: '1', KALSHI_BUCKET_SWEEP: '1' }, book, at('2026-01-10T18:00:00.000Z'));
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.reason, 'sweep_gameday');
    assert.strictEqual(book.transfers.length, 0);
    assert.strictEqual(book.calls.shardActivity, 0);
  }
  {
    const book = fakeBook({
      main: cents(20_000),
      bucket: cents(12_000),
      flat: { openPositions: true, restingOrders: false, uncertain: false },
    });
    const h = harness({ KALSHI_BUCKET_AUTO: '1', KALSHI_BUCKET_SWEEP: '1' }, book);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.reason, 'sweep_open_positions');
    assert.strictEqual(book.transfers.length, 0);
  }
  {
    const book = fakeBook({
      main: cents(20_000),
      bucket: cents(12_000),
      flat: { openPositions: false, restingOrders: true, uncertain: false },
    });
    const h = harness({ KALSHI_BUCKET_AUTO: '1', KALSHI_BUCKET_SWEEP: '1' }, book);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.reason, 'sweep_resting_orders');
    assert.strictEqual(book.transfers.length, 0);
  }
  {
    const book = fakeBook({
      main: cents(20_000),
      bucket: cents(12_000),
      flatError: 'positions down',
    });
    const h = harness({ KALSHI_BUCKET_AUTO: '1', KALSHI_BUCKET_SWEEP: '1' }, book);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.reason, 'sweep_flat_unknown');
    assert.strictEqual(book.transfers.length, 0);
  }

  // Unconfirmed re-read blocks another transfer. An API error does not retry in a loop.
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(2_000), applyTransfer: false });
    const h = harness(LIVE, book);
    const first = await h.mgr.check('interval');
    assert.strictEqual(first.confirmed, false);
    assert.strictEqual(book.transfers.length, 1);
    const second = await h.mgr.check('interval');
    assert.strictEqual(second.held, true);
    assert.strictEqual(book.transfers.length, 1);
    h.setNow(new Date(h.now().getTime() + 61_000));
    const stillHolding = await h.mgr.check('interval');
    assert.strictEqual(stillHolding.held, true, 'async transfer stays on hold inside the settle window');
    assert.strictEqual(book.transfers.length, 1);
    h.setNow(new Date(h.now().getTime() + 180_000));
    const third = await h.mgr.check('interval');
    assert.strictEqual(third.unconfirmed, true);
    assert.strictEqual(book.transfers.length, 1);
    assert.ok(h.alerts.some((t) => /not confirmed/.test(t)));
  }
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(2_000), transferError: 'Kalshi POST 500 boom' });
    const h = harness(LIVE, book);
    const first = await h.mgr.check('interval');
    assert.ok(first.error);
    assert.strictEqual(book.transfers.length, 1);
    const second = await h.mgr.check('interval');
    assert.strictEqual(second.cooledDown, true);
    assert.strictEqual(book.transfers.length, 1);
    assert.ok(h.alerts.some((t) => /transfer failed/.test(t) && t.includes('500')));
    h.setNow(new Date(h.now().getTime() + 61_000));
    book.state.transferError = null;
    const third = await h.mgr.check('interval');
    assert.strictEqual(third.confirmed, true);
    assert.strictEqual(book.transfers.length, 2);
  }

  // Mutex: a second check during an in-flight transfer does not start another.
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(2_000) });
    const hold = book.client.holdNextTransfer();
    const h = harness(LIVE, book);
    const first = h.mgr.check('interval');
    await hold.started;
    const second = h.mgr.check('interval');
    assert.strictEqual(second, first);
    hold.release();
    await first;
    assert.strictEqual(book.calls.transfer, 1);
    assert.strictEqual(book.maxActive(), 1);
  }

  // insufficient_balance alerts: 1 per 10 min per venue, and the check still runs.
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(2_000) });
    const h = harness(LIVE, book);
    await h.mgr.onInsufficientBalance('kalshi');
    assert.strictEqual(book.transfers.length, 1);
    const afterFirst = h.alerts.filter((t) => /INSUFFICIENT BALANCE/.test(t)).length;
    await h.mgr.onInsufficientBalance('kalshi');
    assert.strictEqual(h.alerts.filter((t) => /INSUFFICIENT BALANCE/.test(t)).length, afterFirst);
    await h.mgr.onInsufficientBalance('polymarket');
    assert.ok(h.alerts.some((t) => /INSUFFICIENT BALANCE \(Polymarket\)/.test(t)));
    assert.ok(h.alerts.some((t) => /INSUFFICIENT BALANCE \(Kalshi\)/.test(t)));
    h.setNow(new Date(h.now().getTime() + 10 * 60 * 1000));
    await h.mgr.onInsufficientBalance('kalshi');
    assert.strictEqual(h.alerts.filter((t) => /INSUFFICIENT BALANCE \(Kalshi\)/.test(t)).length, 2);
  }

  // Top-up blocked: at most once per 60 minutes per reason. A new reason alerts now.
  {
    const book = fakeBook({ main: cents(2_000), bucket: 0 });
    const h = harness({ ...LIVE, KALSHI_BUCKET_CEILING: '1050' }, book);
    const started = h.now().getTime();
    const floorAlerts = () => h.alerts.filter((t) => /blocked \(floor\)/.test(t)).length;
    const ceilingAlerts = () => h.alerts.filter((t) => /blocked \(ceiling\)/.test(t)).length;
    const first = await h.mgr.check('interval');
    assert.strictEqual(first.decision.block, 'floor');
    assert.strictEqual(floorAlerts(), 1);
    h.setNow(new Date(started + 5 * 60 * 1000));
    const again = await h.mgr.check('interval');
    assert.strictEqual(again.decision.block, 'floor');
    assert.strictEqual(floorAlerts(), 1, 'the 5-minute check does not resend the same block');
    assert.ok(h.logs.some((line) => /blocked/.test(line)));
    book.state.main.availableCents = cents(50_000);
    book.state.bucket.availableCents = cents(1_000);
    h.setNow(new Date(started + 10 * 60 * 1000));
    const ceiling = await h.mgr.check('interval');
    assert.strictEqual(ceiling.decision.block, 'ceiling');
    assert.strictEqual(ceilingAlerts(), 1, 'a changed block reason alerts immediately');
    assert.strictEqual(floorAlerts(), 1);
    book.state.main.availableCents = cents(2_000);
    book.state.bucket.availableCents = 0;
    book.state.bucket.portfolioCents = 0;
    h.setNow(new Date(started + 15 * 60 * 1000));
    const back = await h.mgr.check('interval');
    assert.strictEqual(back.decision.block, 'floor');
    assert.strictEqual(floorAlerts(), 1, 'returning to a reason inside the hour stays quiet');
    h.setNow(new Date(started + 60 * 60 * 1000));
    const later = await h.mgr.check('interval');
    assert.strictEqual(later.decision.block, 'floor');
    assert.strictEqual(floorAlerts(), 2, 'the same reason alerts again after 60 minutes');
  }

  // Low-balance alerts repeat hourly, and Polymarket cash is alert-only.
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(1_000) });
    const poly = { cash: 1_000 };
    const h = harness({
      ...LIVE,
      KALSHI_MAIN_FLOOR: '0',
      readPolyCash: async () => poly.cash,
    }, book);
    await h.mgr.check('interval');
    assert.ok(h.alerts.some((t) => /combo bucket low/.test(t)));
    assert.ok(h.alerts.some((t) => /Polymarket cash low/.test(t)));
    const lows = h.alerts.length;
    await h.mgr.check('interval');
    assert.strictEqual(h.alerts.filter((t) => /cash low|combo bucket low/.test(t)).length, 2);
    h.setNow(new Date(h.now().getTime() + 60 * 60 * 1000));
    poly.cash = 1_200;
    book.state.bucket.availableCents = cents(5_000);
    await h.mgr.check('interval');
    assert.ok(h.alerts.filter((t) => /Polymarket cash low/.test(t)).length >= 2);
    assert.ok(!h.alerts.slice(lows).some((t) => /combo bucket low/.test(t)), 'recovered shard does not re-alert');
    book.state.bucket.availableCents = cents(100);
    await h.mgr.check('interval');
    assert.ok(h.alerts.some((t) => /combo bucket low/.test(t) && t.includes('$100.00')));
  }

  // Game-day target is $10k, including Saturday 00:30 EDT. Weekday stays $5k.
  {
    const book = fakeBook({ main: cents(30_000), bucket: cents(6_000) });
    const h = harness(LIVE, book, at('2026-07-11T04:30:00.000Z'));
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.gameday, true);
    assert.strictEqual(out.decision.amountCents, cents(4_000));
    assert.strictEqual(out.decision.targetCents, cents(10_000));
  }
  {
    const book = fakeBook({ main: cents(30_000), bucket: cents(6_000) });
    const h = harness(LIVE, book, WED);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.action, 'hold');
    assert.strictEqual(out.decision.targetCents, cents(5_000));
    assert.strictEqual(book.transfers.length, 0);
  }
  {
    const book = fakeBook({ main: cents(30_000), bucket: cents(6_000) });
    const h = harness(LIVE, book, at('2026-09-24T16:00:00.000Z'));
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.gameday, true);
    assert.strictEqual(out.decision.targetCents, cents(10_000));
    assert.strictEqual(out.decision.amountCents, cents(4_000));
  }
  {
    const book = fakeBook({ main: cents(30_000), bucket: cents(6_000) });
    const h = harness(LIVE, book, at('2026-09-25T14:00:00.000Z'));
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.gameday, false, 'Fri 10:00 EDT is still the default target');
    assert.strictEqual(out.decision.action, 'hold');
  }
  {
    const book = fakeBook({ main: cents(30_000), bucket: cents(6_000) });
    const h = harness(LIVE, book, at('2026-09-25T18:00:00.000Z'));
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.decision.gameday, true, 'Fri 2:00 PM EDT: Friday playoff/college locks count as gameday');
    assert.strictEqual(out.decision.targetCents, cents(10_000));
  }

  // Wire format: centicents, event_contract, shard query on the signed path.
  {
    const seen = [];
    let bucketDollars = 2000;
    const signed = async (method, signPath, opts) => {
      seen.push({ method, signPath, path: opts.path, body: opts.body });
      if (method === 'GET' && signPath.endsWith('/balance')) {
        const shard = /exchange_index=1/.test(opts.path) ? 1 : 0;
        return {
          statusCode: 200,
          text: JSON.stringify({
            balance: shard === 1 ? bucketDollars * 100 : 2_000_000,
            balance_dollars: shard === 1 ? bucketDollars.toFixed(4) : '20000.0000',
            portfolio_value: 0,
          }),
        };
      }
      if (method === 'POST') {
        const body = JSON.parse(opts.body);
        bucketDollars += body.amount / CENTICENTS_PER_DOLLAR;
        return { statusCode: 200, text: JSON.stringify({ transfer_id: 'tr_wire' }) };
      }
      if (method === 'GET' && signPath.endsWith('/positions')) {
        return { statusCode: 200, text: JSON.stringify({ market_positions: [], event_positions: [] }) };
      }
      if (method === 'GET' && signPath.endsWith('/orders')) {
        return { statusCode: 200, text: JSON.stringify({ orders: [] }) };
      }
      throw new Error(`unexpected ${method} ${signPath}`);
    };
    const client = createKalshiBucketClient(signed);
    const alerts = [];
    const mgr = createBucketManager({
      env: LIVE,
      now: () => WED,
      alert(text) { alerts.push(text); },
      log() {},
      sleep: async () => {},
      client,
      readPolyCash: null,
    });
    const out = await mgr.check('interval');
    assert.strictEqual(out.confirmed, true);
    const post = seen.find((c) => c.method === 'POST');
    const body = JSON.parse(post.body);
    assert.strictEqual(post.signPath, '/trade-api/v2/portfolio/intra_exchange_instance_transfer');
    assert.strictEqual(post.path, post.signPath);
    assert.strictEqual(body.source, 'event_contract');
    assert.strictEqual(body.destination, 'event_contract');
    assert.strictEqual(body.source_exchange_shard, 0);
    assert.strictEqual(body.destination_exchange_shard, 1);
    assert.strictEqual(body.amount, 30_000_000);
    assert.ok(seen.some((c) => c.method === 'GET' && c.signPath.endsWith('/balance') && c.signPath.indexOf('?') === -1));
    assert.ok(seen.some((c) => /exchange_index=0/.test(c.path)));
    assert.ok(seen.some((c) => /exchange_index=1/.test(c.path)));
    assert.ok(alerts.some((t) => t.includes('tr_wire') && t.includes('$5,000.00')));
  }

  {
    const calls = [];
    const reader = polyReaderFromEnv(
      { POLYMARKET_KEY_ID: 'k', POLYMARKET_SECRET_KEY: 's' },
      () => ({
        request(method, path) {
          calls.push({ method, path });
          return { statusCode: 200, json: { balances: [{ currency: 'USD', currentBalance: 42 }] } };
        },
      }),
    );
    assert.strictEqual(await reader(), 42);
    assert.deepStrictEqual(calls, [{ method: 'GET', path: '/v1/account/balances' }]);
    assert.strictEqual(polyReaderFromEnv({}), null);
    const cash = await readPolyCashFromHttp({
      request() {
        return { statusCode: 200, json: { balances: [{ currency: 'USD', currentBalance: 8 }] } };
      },
    });
    assert.strictEqual(cash, 8);
  }

  // --- in-app alerts (app_alerts) -------------------------------------------
  function fakeAppAlerts() {
    const rows = [];
    return {
      enabled: true,
      rows,
      async raise(spec) {
        if (spec.dedupeKey && rows.some((r) => r.dedupeKey === spec.dedupeKey && !r.resolved)) return true;
        rows.push({ ...spec, resolved: false });
        return true;
      },
      async resolve(keys) {
        for (const r of rows) if (keys.includes(r.dedupeKey)) r.resolved = true;
        return true;
      },
    };
  }
  function harnessApp(env, book, when, appAlerts) {
    let current = when || WED;
    const alerts = [];
    const mgr = createBucketManager({
      env: { ...LEGACY_LIMITS, ...env }, now: () => current, alert(t) { alerts.push(t); }, log() {}, sleep: async () => {},
      client: book.client, readPolyCash: null, appAlerts,
    });
    return { mgr, alerts, setNow(d) { current = d; }, now() { return current; } };
  }

  // A transfer writes one in-app row with dollars, and stays off Telegram.
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(2_000) });
    const app = fakeAppAlerts();
    const h = harnessApp(LIVE, book, WED, app);
    await h.mgr.check('interval');
    const rows = app.rows.filter((r) => r.kind === 'bucket_transfer');
    assert.strictEqual(rows.length, 1);
    assert.ok(rows[0].title.includes('$3,000.00'));
    assert.ok(rows[0].body.includes('shard 0 (main)') && rows[0].body.includes('shard 1 (combo)'));
    assert.ok(!h.alerts.some((t) => /bucket transfer/.test(t)), 'no Telegram for a completed transfer');
    await h.mgr.check('interval');
    assert.strictEqual(app.rows.filter((r) => r.kind === 'bucket_transfer').length, 1, 'hold writes nothing');
    assert.ok(!app.rows.some((r) => r.kind === 'combo_low_cash'), 'top-up to $5,000 is not low cash');
  }

  // Dry run writes no transfer rows.
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(2_000) });
    const app = fakeAppAlerts();
    const h = harnessApp({ KALSHI_BUCKET_AUTO: '0' }, book, WED, app);
    await h.mgr.check('interval');
    assert.strictEqual(app.rows.filter((r) => r.kind === 'bucket_transfer').length, 0);
  }

  // Failed transfer writes an error row and still alerts Telegram.
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(2_000) });
    book.state.transferError = 'Kalshi POST 500 boom';
    const app = fakeAppAlerts();
    const h = harnessApp(LIVE, book, WED, app);
    await h.mgr.check('interval');
    const rows = app.rows.filter((r) => r.kind === 'bucket_transfer_failed');
    assert.strictEqual(rows.length, 1);
    {
      assert.strictEqual(rows[0].severity, 'error');
      assert.ok(h.alerts.some((t) => /transfer failed/.test(t)));
    }
  }

  // Blocked (floor): one deduped row, resolved when it clears, re-raised after.
  {
    const book = fakeBook({ main: cents(2_050), bucket: cents(1_000) });
    const app = fakeAppAlerts();
    const h = harnessApp({ ...LIVE }, book, WED, app);
    await h.mgr.check('interval');
    const blocked = () => app.rows.filter((r) => r.kind === 'bucket_blocked');
    assert.strictEqual(blocked().length, 1);
    assert.strictEqual(blocked()[0].dedupeKey, 'bucket_blocked:floor');
    assert.ok(blocked()[0].body.includes('$2,000.00'));
    h.setNow(new Date(h.now().getTime() + 5 * 60 * 1000));
    await h.mgr.check('interval');
    assert.strictEqual(blocked().length, 1, 'still blocked: no second row');
    book.state.main.availableCents = cents(20_000);
    h.setNow(new Date(h.now().getTime() + 5 * 60 * 1000));
    await h.mgr.check('interval');
    assert.ok(blocked()[0].resolved, 'top-up clears the blocked row');
    book.state.main.availableCents = cents(2_050);
    book.state.bucket.availableCents = cents(1_000);
    h.setNow(new Date(h.now().getTime() + 5 * 60 * 1000));
    await h.mgr.check('interval');
    assert.strictEqual(blocked().length, 2, 'blocked again after recovery raises a new row');
  }

  // Combo low cash: default $1,000, configurable, dollars in message, de-duped.
  {
    assert.strictEqual(loadBucketConfig({}).comboLowCashCents, cents(1_000));
    assert.strictEqual(loadBucketConfig({ COMBO_LOW_CASH_ALERT_USD: '2500' }).comboLowCashCents, cents(2_500));
    const book = fakeBook({ main: cents(500), bucket: cents(800) });
    const app = fakeAppAlerts();
    const h = harnessApp({ KALSHI_BUCKET_AUTO: '0' }, book, WED, app);
    await h.mgr.check('interval');
    const low = () => app.rows.filter((r) => r.kind === 'combo_low_cash');
    assert.strictEqual(low().length, 1);
    assert.ok(low()[0].body.includes('$800.00') && low()[0].body.includes('$1,000.00'));
    await h.mgr.check('interval');
    await h.mgr.check('interval');
    assert.strictEqual(low().length, 1, 'one open alert while cash stays low');
    book.state.bucket.availableCents = cents(4_000);
    await h.mgr.check('interval');
    assert.ok(low()[0].resolved, 'recovery resolves the alert');
    book.state.bucket.availableCents = cents(900.5);
    await h.mgr.check('interval');
    assert.strictEqual(low().length, 2, 're-alerts after recovering and dropping again');
    assert.ok(low()[1].body.includes('$900.50'));
  }

  // Cash at/above the threshold never alerts; a live top-up that fixes low cash does not alert.
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(1_000) });
    const app = fakeAppAlerts();
    const h = harnessApp(LIVE, book, WED, app);
    await h.mgr.check('interval');
    assert.strictEqual(app.rows.filter((r) => r.kind === 'combo_low_cash').length, 0);
    const book2 = fakeBook({ main: cents(20_000), bucket: cents(1_000) });
    const app2 = fakeAppAlerts();
    const h2 = harnessApp({ KALSHI_BUCKET_AUTO: '0', COMBO_LOW_CASH_ALERT_USD: '1000' }, book2, WED, app2);
    await h2.mgr.check('interval');
    assert.strictEqual(app2.rows.filter((r) => r.kind === 'combo_low_cash').length, 0, 'exactly $1,000 is not low');
  }

  // Insufficient-funds skip writes an in-app row with the last shard 1 balance.
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(2_000) });
    const app = fakeAppAlerts();
    const h = harnessApp(LIVE, book, WED, app);
    await h.mgr.check('startup');
    await h.mgr.onInsufficientBalance('kalshi');
    await h.mgr.onInsufficientBalance('polymarket');
    const rows = app.rows.filter((r) => r.kind === 'combo_insufficient_funds');
    assert.strictEqual(rows.length, 1);
    assert.ok(/\$\d/.test(rows[0].body));
  }

  // A broken in-app writer never breaks the bucket manager.
  {
    const book = fakeBook({ main: cents(20_000), bucket: cents(2_000) });
    const bad = { enabled: true, async raise() { throw new Error('db down'); }, async resolve() { throw new Error('db down'); } };
    const h = harnessApp(LIVE, book, WED, bad);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.confirmed, true);
  }

  // --- transfer confirmation (record first, shard 0 fallback, hold while pending) ---

  assert.strictEqual(TRANSFERS_PATH, '/trade-api/v2/portfolio/intra_exchange_instance_transfers');
  assert.strictEqual(transferStatusClass('complete'), 'complete');
  assert.strictEqual(transferStatusClass('COMPLETED'), 'complete');
  assert.strictEqual(transferStatusClass('failed'), 'failed');
  assert.strictEqual(transferStatusClass('pending'), 'processing');
  assert.strictEqual(transferStatusClass(undefined), 'processing');
  assert.deepStrictEqual(parseTransfers({
    transfers: [{
      amount: '667.5700', created_ts: 1, destination: 'event_contract', destination_exchange_shard: 1,
      source: 'event_contract', source_exchange_shard: 0, status: 'complete',
      transfer_id: '7bb3493e-1fbf-4233-b37b-95c2e24085a3',
    }, { amount: 'x' }],
  }), [{
    transferId: '7bb3493e-1fbf-4233-b37b-95c2e24085a3', status: 'complete',
    amountCents: 66757, fromShard: 0, toShard: 1,
  }]);
  assert.deepStrictEqual(parseTransfers(null), []);

  // Oct 1 incident: the balance re-read lags (and combo spend lands on shard 1),
  // but Kalshi's record says complete. Confirmed, no unconfirmed alert, no Telegram error.
  {
    const book = fakeBook({
      main: cents(20_000), bucket: cents(2_000), applyTransfer: false, recordStatus: 'complete',
    });
    const app = fakeAppAlerts();
    const slept = [];
    let current = WED;
    const alerts = [];
    const mgr = createBucketManager({
      env: LIVE, now: () => current, alert(t) { alerts.push(t); }, log() {},
      sleep: async (ms) => { slept.push(ms); }, client: book.client, readPolyCash: null, appAlerts: app,
    });
    const out = await mgr.check('interval');
    assert.strictEqual(out.confirmed, true);
    assert.strictEqual(out.via, 'record');
    assert.deepStrictEqual(slept, [2_000], 'first confirm is deferred, not the immediate re-read');
    assert.ok(!alerts.some((t) => /not confirmed/.test(t)));
    assert.ok(!app.rows.some((r) => r.kind === 'bucket_transfer_unconfirmed'));
    assert.strictEqual(app.rows.filter((r) => r.kind === 'bucket_transfer')[0].meta.state, 'confirmed');
    const next = await mgr.check('interval');
    assert.notStrictEqual(next.held, true, 'nothing pending after a confirmed transfer');
    void current;
  }

  // Shard 1 spend during the settle window must not read as a failed transfer.
  {
    const book = fakeBook({
      main: cents(20_000), bucket: cents(2_000), spendOnTransferCents: cents(3_000),
    });
    const app = fakeAppAlerts();
    const h = harnessApp(LIVE, book, WED, app);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.confirmed, true, 'record complete beats spend-masked balance');
    assert.strictEqual(book.state.bucket.availableCents, cents(2_000), 'spend ate the top-up');
    assert.ok(!app.rows.some((r) => r.kind === 'bucket_transfer_unconfirmed'));
    assert.ok(!h.alerts.some((t) => /not confirmed/.test(t)));
  }

  // Record API down: shard 0 drop confirms even when shard 1 spend hides the landing.
  {
    const book = fakeBook({
      main: cents(20_000), bucket: cents(2_000), spendOnTransferCents: cents(3_000),
      recordStatus: null, recordsError: 'Kalshi GET transfers 500',
    });
    const app = fakeAppAlerts();
    const h = harnessApp(LIVE, book, WED, app);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.confirmed, true);
    assert.strictEqual(out.via, 'shard0');
    assert.strictEqual(book.state.main.availableCents, cents(17_000));
    assert.ok(!app.rows.some((r) => r.kind === 'bucket_transfer_unconfirmed'));
  }

  // Record says failed: failed alert, pending cleared, cooldown, no resend inside it.
  {
    const book = fakeBook({
      main: cents(20_000), bucket: cents(2_000), applyTransfer: false, recordStatus: 'failed',
    });
    const app = fakeAppAlerts();
    const h = harnessApp(LIVE, book, WED, app);
    const out = await h.mgr.check('interval');
    assert.strictEqual(out.failed, true);
    assert.ok(h.alerts.some((t) => /transfer failed/.test(t)));
    const rows = app.rows.filter((r) => r.kind === 'bucket_transfer_failed');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].severity, 'error');
    const again = await h.mgr.check('interval');
    assert.strictEqual(again.cooledDown, true);
    assert.strictEqual(book.transfers.length, 1);
    h.setNow(new Date(h.now().getTime() + 6 * 60 * 1000));
    const later = await h.mgr.check('interval');
    assert.strictEqual(later.decision.action, 'topup', 'a failed transfer is retried after the cooldown');
    assert.strictEqual(book.transfers.length, 2);
  }

  // Record still processing: hold, no alert inside the settle window, late confirm when it completes.
  {
    const book = fakeBook({
      main: cents(20_000), bucket: cents(2_000), applyTransfer: false, recordStatus: 'processing',
    });
    const app = fakeAppAlerts();
    const h = harnessApp(LIVE, book, WED, app);
    const first = await h.mgr.check('interval');
    assert.strictEqual(first.confirmed, false);
    assert.strictEqual(first.verify, 'processing');
    assert.strictEqual(app.rows.filter((r) => r.kind === 'bucket_transfer')[0].meta.state, 'accepted');
    assert.ok(!app.rows.some((r) => r.kind === 'bucket_transfer_unconfirmed'));
    assert.ok(!h.alerts.some((t) => /not confirmed|transfer failed/.test(t)));
    h.setNow(new Date(h.now().getTime() + 60_000));
    const held = await h.mgr.check('interval');
    assert.strictEqual(held.held, true);
    assert.strictEqual(book.transfers.length, 1);
    book.state.records[0].status = 'complete';
    h.setNow(new Date(h.now().getTime() + 60_000));
    const done = await h.mgr.check('interval');
    assert.strictEqual(done.confirmed, true);
    assert.strictEqual(done.late, true);
    assert.strictEqual(done.via, 'record');
    assert.ok(!app.rows.some((r) => r.kind === 'bucket_transfer_unconfirmed'));
    assert.strictEqual(book.transfers.length, 1, 'no second transfer while it was pending');
  }

  // No record and no balance trace: alert once after the settle window, keep holding,
  // release only after the long timeout (record API healthy => it never happened).
  {
    const book = fakeBook({
      main: cents(20_000), bucket: cents(2_000), applyTransfer: false, recordStatus: null,
    });
    const app = fakeAppAlerts();
    const h = harnessApp(LIVE, book, WED, app);
    const first = await h.mgr.check('interval');
    assert.strictEqual(first.confirmed, false);
    assert.strictEqual(first.verify, 'missing');
    assert.ok(!app.rows.some((r) => r.kind === 'bucket_transfer_unconfirmed'), 'no alert on the immediate read');
    h.setNow(new Date(h.now().getTime() + 181_000));
    const over = await h.mgr.check('interval');
    assert.strictEqual(over.held, true);
    assert.strictEqual(over.unconfirmed, true);
    assert.strictEqual(app.rows.filter((r) => r.kind === 'bucket_transfer_unconfirmed').length, 1);
    assert.ok(h.alerts.some((t) => /not confirmed/.test(t)));
    assert.strictEqual(book.transfers.length, 1);
    h.setNow(new Date(h.now().getTime() + 5 * 60_000));
    const still = await h.mgr.check('interval');
    assert.strictEqual(still.held, true);
    assert.strictEqual(app.rows.filter((r) => r.kind === 'bucket_transfer_unconfirmed').length, 1, 'alerts once');
    assert.strictEqual(book.transfers.length, 1, 'still never drops pending without verifying');
    h.setNow(new Date(h.now().getTime() + 31 * 60_000));
    const lost = await h.mgr.check('interval');
    assert.strictEqual(lost.lost, true);
    assert.ok(app.rows.some((r) => r.kind === 'bucket_transfer_failed' && /never appeared/.test(r.title)));
    h.setNow(new Date(h.now().getTime() + 6 * 60_000));
    const resumed = await h.mgr.check('interval');
    assert.strictEqual(resumed.decision.action, 'topup');
    assert.strictEqual(book.transfers.length, 2);
  }

  // Record unreadable and balances show nothing: unknown. Hold indefinitely, never release.
  {
    const book = fakeBook({
      main: cents(20_000), bucket: cents(2_000), applyTransfer: false,
      recordStatus: null, recordsError: 'Kalshi GET transfers 503',
    });
    const app = fakeAppAlerts();
    const h = harnessApp(LIVE, book, WED, app);
    const first = await h.mgr.check('interval');
    assert.strictEqual(first.verify, 'unknown');
    for (let i = 0; i < 20; i += 1) {
      h.setNow(new Date(h.now().getTime() + 6 * 60_000));
      const out = await h.mgr.check('interval');
      assert.strictEqual(out.held, true);
    }
    assert.strictEqual(book.transfers.length, 1, 'two hours later, still only the one transfer');
    assert.strictEqual(app.rows.filter((r) => r.kind === 'bucket_transfer_unconfirmed').length, 1);
    book.state.recordsError = null;
    book.state.records.unshift({ transferId: 'tr_1', status: 'complete', amountCents: cents(3_000), fromShard: 0, toShard: 1 });
    const ok = await h.mgr.check('interval');
    assert.strictEqual(ok.confirmed, true);
  }

  // The confirm path must not loosen the safeguards: floor, per-transfer cap, daily cap, ceiling, minimum.
  {
    const cfg = loadBucketConfig({});
    assert.strictEqual(cfg.floorCents, cents(2_000));
    assert.strictEqual(cfg.maxTransferCents, cents(10_000));
    assert.strictEqual(cfg.dailyCapCents, cents(15_000));
    assert.strictEqual(cfg.ceilingCents, cents(22_000));
    assert.strictEqual(cfg.minTransferCents, cents(100));
    assert.strictEqual(cfg.confirmDelayMs, 2_000);
    // Big deficit with plenty of main: one transfer clamped to $10k, held while pending.
    const book = fakeBook({
      main: cents(50_000), bucket: cents(0), applyTransfer: false, recordStatus: 'processing',
    });
    const h = harness({ ...LIVE, KALSHI_BUCKET_TARGET_DEFAULT: '15000' }, book);
    const first = await h.mgr.check('interval');
    assert.strictEqual(first.decision.amountCents, cents(10_000));
    const second = await h.mgr.check('interval');
    assert.strictEqual(second.held, true);
    assert.strictEqual(book.transfers.length, 1);
  }

  // Wire: the client reads Kalshi's transfer records (GET, signed path, no body).
  {
    const seen = [];
    const signed = async (method, signPath, opts) => {
      seen.push({ method, signPath, path: opts.path, body: opts.body });
      return {
        statusCode: 200,
        text: JSON.stringify({ transfers: [{
          amount: '382.1200', source_exchange_shard: 0, destination_exchange_shard: 1,
          status: 'complete', transfer_id: '2828cf44-1487-4bbf-872d-16a3b713a9cc',
        }] }),
      };
    };
    const rows = await createKalshiBucketClient(signed).getTransfers();
    assert.strictEqual(seen[0].method, 'GET');
    assert.strictEqual(seen[0].signPath, TRANSFERS_PATH);
    assert.strictEqual(seen[0].body, undefined);
    assert.strictEqual(rows[0].amountCents, 38212);
    assert.strictEqual(rows[0].toShard, 1);
  }

  // --- Oct 2: new targets, ceiling, and top-up toward a rejected quote's cost ---

  // New defaults on a Friday-evening gameday with the Oct 2 balances: plan a top-up to $12k.
  {
    const FRI_EVE = at('2026-10-02T21:20:00.000Z'); // Fri 5:20 PM EDT
    const book = fakeBook({
      main: cents(15_587.85), bucket: cents(4_963.42), bucketPortfolio: cents(6_343.43),
    });
    let current = FRI_EVE;
    const alerts = [];
    const mgr = createBucketManager({
      env: { KALSHI_BUCKET_AUTO: '1' }, now: () => current, alert(t) { alerts.push(t); }, log() {},
      sleep: async () => {}, client: book.client, readPolyCash: null,
    });
    const out = await mgr.check('interval');
    assert.strictEqual(out.decision.gameday, true);
    assert.strictEqual(out.decision.targetCents, cents(12_000));
    assert.strictEqual(out.decision.action, 'topup');
    assert.strictEqual(out.decision.amountCents, 703_658, '$12,000 - $4,963.42');
    assert.strictEqual(out.decision.clamp, null, 'ceiling $22k on available cash: 12.0k fits');
    assert.strictEqual(out.confirmed, true);
    assert.strictEqual(book.state.bucket.availableCents, cents(12_000));
    assert.ok(book.state.main.availableCents >= cents(2_000));
  }

  // Non-gameday target is $8k.
  {
    const cfg = loadBucketConfig({});
    const plan = planBucketAction({
      mainAvailableCents: cents(15_000), bucketAvailableCents: cents(4_963.42), bucketPortfolioCents: 0,
      gameday: false, sweepEnabled: false, flat: null, dailyTopupCents: 0, config: cfg,
    });
    assert.strictEqual(plan.targetCents, cents(8_000));
    assert.strictEqual(plan.amountCents, cents(8_000) - cents(4_963.42));
  }

  // Ceiling ($22k) is enforced on available cash only; open positions never count.
  {
    const cfg = loadBucketConfig({});
    const withPositions = planBucketAction({
      mainAvailableCents: cents(50_000), bucketAvailableCents: cents(4_000), bucketPortfolioCents: cents(14_000),
      gameday: true, sweepEnabled: false, flat: null, dailyTopupCents: 0, config: cfg,
    });
    assert.strictEqual(withPositions.clamp, null, '$14k of open positions does not clamp');
    assert.strictEqual(withPositions.amountCents, cents(8_000), '12,000 - 4,000');
    const nearCeiling = planBucketAction({
      mainAvailableCents: cents(50_000), bucketAvailableCents: cents(21_900), bucketPortfolioCents: 0,
      gameday: true, sweepEnabled: false, flat: null, dailyTopupCents: 0, config: cfg, needCents: cents(30_000),
    });
    assert.strictEqual(nearCeiling.clamp, 'ceiling');
    assert.strictEqual(nearCeiling.amountCents, cents(100), '22,000 - 21,900');
  }

  // needCents lifts the target to cost + $500 and every clamp still applies.
  {
    const cfg = loadBucketConfig({});
    const base = {
      mainAvailableCents: cents(15_000), bucketAvailableCents: cents(4_963.42), bucketPortfolioCents: cents(6_343.43),
      gameday: false, sweepEnabled: false, flat: null, dailyTopupCents: 0, config: cfg,
    };
    const small = planBucketAction({ ...base, needCents: cents(5_620) });
    assert.strictEqual(small.targetCents, cents(8_000), 'cost + buffer below the base target changes nothing');
    const big = planBucketAction({ ...base, needCents: cents(9_000), mainAvailableCents: cents(30_000) });
    assert.strictEqual(big.needTargetCents, cents(9_500));
    assert.strictEqual(big.targetCents, cents(9_500));
    assert.strictEqual(big.amountCents, cents(9_500) - cents(4_963.42));
    const capped = planBucketAction({ ...base, needCents: cents(35_000), mainAvailableCents: cents(40_000) });
    assert.strictEqual(capped.targetCents, cents(35_500));
    assert.strictEqual(capped.clamp, 'max_transfer', 'Navy-size need: ceiling headroom 17.0k, per-transfer cap $10k binds first');
    assert.strictEqual(capped.amountCents, cents(10_000));
    const ceil = planBucketAction({
      ...base, needCents: cents(35_000), mainAvailableCents: cents(40_000), bucketAvailableCents: cents(15_000),
    });
    assert.strictEqual(ceil.clamp, 'ceiling', 'available cash near the $22k ceiling binds');
    assert.strictEqual(ceil.amountCents, cents(7_000));
    const floored = planBucketAction({ ...base, needCents: cents(20_000), mainAvailableCents: cents(4_000) });
    assert.strictEqual(floored.clamp, 'floor');
    assert.strictEqual(floored.amountCents, cents(2_000), 'only cash above the $2k floor');
    const daily = planBucketAction({ ...base, needCents: cents(20_000), mainAvailableCents: cents(40_000), dailyTopupCents: cents(14_850) });
    assert.strictEqual(daily.clamp, 'daily_cap');
    assert.strictEqual(daily.amountCents, cents(150));
    const none = planBucketAction({ ...base, needCents: cents(20_000), mainAvailableCents: cents(40_000), dailyTopupCents: cents(14_950) });
    assert.strictEqual(none.action, 'blocked', 'under $100 of daily room: no transfer');
    assert.strictEqual(none.block, 'daily_cap');
    assert.strictEqual(none.amountCents, 0);
  }

  // Rejection -> immediate check tops up toward the rejected cost + $500, confirms via #113 logic.
  {
    const book = fakeBook({
      main: cents(30_000), bucket: cents(4_963.42), bucketPortfolio: cents(6_343.43),
    });
    const app = fakeAppAlerts();
    const alerts = [];
    const logs = [];
    const mgr = createBucketManager({
      env: { KALSHI_BUCKET_AUTO: '1', KALSHI_BUCKET_TARGET_DEFAULT: '3000' },
      now: () => at('2026-10-02T14:00:00.000Z'), // Fri 10:00 AM EDT, default target
      alert(t) { alerts.push(t); }, log(l) { logs.push(String(l)); },
      sleep: async () => {}, client: book.client, readPolyCash: null, appAlerts: app,
    });
    // $9,000 rejected quote: need 9,000 + 500 = 9,500 > target $3,000.
    const out = await mgr.onInsufficientBalance('kalshi', { costDollars: 9_000 });
    assert.strictEqual(out.decision.targetCents, cents(9_500));
    assert.strictEqual(out.decision.action, 'topup');
    assert.strictEqual(out.decision.amountCents, cents(9_500) - cents(4_963.42));
    assert.strictEqual(out.confirmed, true);
    assert.ok(out.transferId);
    assert.strictEqual(book.transfers.length, 1);
    assert.strictEqual(book.state.bucket.availableCents, cents(9_500));
    assert.ok(logs.some((l) => /needs \$9,000\.00/.test(l)));
    const row = app.rows.find((r) => r.kind === 'combo_insufficient_funds');
    assert.ok(/needed about \$9,000\.00/.test(row.body));
    // A later interval check keeps the need for a while, but nothing more to move.
    const later = await mgr.check('interval');
    assert.strictEqual(later.decision.action, 'hold');
    assert.strictEqual(book.transfers.length, 1);
  }

  // Without a cost (polymarket, unknown) behavior is unchanged: normal plan only.
  {
    const book = fakeBook({ main: cents(30_000), bucket: cents(4_963.42) });
    const mgr = createBucketManager({
      env: { KALSHI_BUCKET_AUTO: '1', KALSHI_BUCKET_TARGET_DEFAULT: '3000' },
      now: () => at('2026-10-02T14:00:00.000Z'), alert() {}, log() {},
      sleep: async () => {}, client: book.client, readPolyCash: null,
    });
    const out = await mgr.onInsufficientBalance('kalshi');
    assert.strictEqual(out.decision.targetCents, cents(3_000));
    assert.strictEqual(out.decision.action, 'hold');
    const poly = await mgr.onInsufficientBalance('polymarket', { costDollars: 99_999 });
    assert.ok(poly.skipped === 'coalesced' || poly.decision.targetCents === cents(3_000), 'polymarket cost never lifts the Kalshi target');
    assert.strictEqual(book.transfers.length, 0);
  }

  // A second, larger rejection inside the coalesce window is not swallowed.
  {
    const book = fakeBook({ main: cents(40_000), bucket: cents(4_000) });
    const mgr = createBucketManager({
      env: { KALSHI_BUCKET_AUTO: '1', KALSHI_BUCKET_TARGET_DEFAULT: '3000' },
      now: () => at('2026-10-02T14:00:00.000Z'), alert() {}, log() {},
      sleep: async () => {}, client: book.client, readPolyCash: null,
    });
    const first = await mgr.onInsufficientBalance('kalshi', { costDollars: 5_000 });
    assert.strictEqual(first.decision.targetCents, cents(5_500));
    assert.strictEqual(first.confirmed, true);
    const second = await mgr.onInsufficientBalance('kalshi', { costDollars: 8_000 });
    assert.notStrictEqual(second.skipped, 'coalesced');
    assert.strictEqual(second.decision.targetCents, cents(8_500));
    assert.strictEqual(book.state.bucket.availableCents, cents(8_500));
    const third = await mgr.onInsufficientBalance('kalshi', { costDollars: 4_000 });
    assert.strictEqual(third.skipped, 'coalesced', 'a smaller repeat inside 15s is still coalesced');
  }

  // While a transfer is pending, a rejection records the need but sends nothing new.
  {
    const book = fakeBook({
      main: cents(40_000), bucket: cents(4_000), applyTransfer: false, recordStatus: 'processing',
    });
    const mgr = createBucketManager({
      env: { KALSHI_BUCKET_AUTO: '1', KALSHI_BUCKET_TARGET_DEFAULT: '3000' },
      now: () => at('2026-10-02T14:00:00.000Z'), alert() {}, log() {},
      sleep: async () => {}, client: book.client, readPolyCash: null,
    });
    const first = await mgr.onInsufficientBalance('kalshi', { costDollars: 6_000 });
    assert.strictEqual(first.confirmed, false);
    assert.strictEqual(book.transfers.length, 1);
    const second = await mgr.onInsufficientBalance('kalshi', { costDollars: 9_000 });
    assert.ok(second.held || second.skipped);
    assert.strictEqual(book.transfers.length, 1, 'pending transfer holds further sends (#113)');
  }

  console.log('bucket-manager.test.js ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
