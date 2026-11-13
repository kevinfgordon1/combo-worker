'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  snapUpMilli,
  onGrid,
  quotePriceFromAmerican,
  americanFromMilli,
  formatAmerican,
  maxWagerFor,
  collateralForWager,
  payoutContracts,
  milliFromDecimal,
} = require('./novig-price');
const { indexNovigCatalog, indexLocks, matchOutcomes } = require('./novig-legs');
const { createNovigQuoter, sendsBlocked, CONFIRM_MS } = require('./novig-rfq');
const { stringToSign } = require('./novig-sign');
const { countsTowardCap, isQuoteExecutionStub, isKalshiTradeFill } = require('./fills-attr');
const { summarizeShadowRows } = require('./scripts/novig-shadow-summary');

const T0 = Date.parse('2026-09-13T17:00:00Z');

// RFQ price. Snap UP to the next 0.001, never down. Every thousandth from
// 0.001 to 0.999 is legal. +400 is 0.200 and stays. +350 is 0.22222… and
// quotes 0.223 (about +348). +1000 quotes 0.091. 0.052 is allowed.
assert.strictEqual(quotePriceFromAmerican(400), '0.200');
assert.strictEqual(formatAmerican(americanFromMilli(200)), '+400');
assert.strictEqual(quotePriceFromAmerican(350), '0.223');
assert.strictEqual(formatAmerican(americanFromMilli(223)), '+348');
assert.strictEqual(quotePriceFromAmerican(1000), '0.091');
assert.strictEqual(quotePriceFromAmerican(-150), '0.600');
assert.strictEqual(formatAmerican(americanFromMilli(600)), '-150');
assert.strictEqual(snapUpMilli(222.22), 223);
assert.strictEqual(snapUpMilli(200), 200);
assert.strictEqual(snapUpMilli(52), 52);
assert.strictEqual(snapUpMilli(51), 51);
assert.strictEqual(snapUpMilli(54), 54);
assert.strictEqual(snapUpMilli(50), 50);
assert.strictEqual(snapUpMilli(665), 665);
assert.strictEqual(snapUpMilli(667), 667);
assert.strictEqual(snapUpMilli(945), 945);
assert.strictEqual(snapUpMilli(946), 946);
assert.strictEqual(snapUpMilli(999), 999);
assert.strictEqual(snapUpMilli(999.1), null);
assert.strictEqual(snapUpMilli(1000), null);
assert.strictEqual(snapUpMilli(0.2), 1);
assert.ok(onGrid(1) && onGrid(52) && onGrid(223) && onGrid(667) && onGrid(999));
assert.ok(!onGrid(0) && !onGrid(1000) && !onGrid(52.4));
assert.strictEqual(quotePriceFromAmerican(0), null);

// maxWager is the user stake. Collateral is stake × (1 − price) / price.
{
  const sized = maxWagerFor({
    priceMilli: 200,
    remainingContracts: 100,
    freeBalance: 10,
    perQuoteCollateral: 100,
    perLockCollateral: 250,
    totalCollateral: 500,
    hardWagerCap: 25,
  });
  assert.strictEqual(sized.wager, 2.5);
  assert.ok(Math.abs(collateralForWager(2.5, 200) - 10) < 1e-9);
  const capped = maxWagerFor({
    priceMilli: 200,
    remainingContracts: 1000,
    freeBalance: 5000,
    perQuoteCollateral: 100,
    perLockCollateral: 250,
    totalCollateral: 500,
    hardWagerCap: 25,
  });
  assert.strictEqual(capped.wager, 25);
  assert.strictEqual(payoutContracts(25, 200), 125);
  assert.ok(Math.abs(collateralForWager(15, 225) - (15 * 0.775 / 0.225)) < 1e-9);
}

const events = {
  items: [
    { eventId: 'ev1', description: 'Arizona Cardinals @ New York Giants', league: 'NFL', status: 'OPEN_PREGAME', startsTs: T0 },
    { eventId: 'ev2', description: 'Cleveland Browns @ Jacksonville Jaguars', league: 'NFL', status: 'OPEN_PREGAME', startsTs: T0 },
    { eventId: 'ev3', description: 'Pittsburgh Steelers @ Cleveland Browns', league: 'NFL', status: 'OPEN_PREGAME', startsTs: Date.parse('2026-10-01T20:00:00Z') },
  ],
};
const markets = {
  items: [
    { marketId: 'm1', eventId: 'ev1', marketType: 'MONEY', strike: '0', status: 'OPEN', outcomes: [{ outcomeId: 'nyg-out', name: 'NYG' }, { outcomeId: 'ari-out', name: 'ARI' }] },
    { marketId: 'm2', eventId: 'ev2', marketType: 'MONEY', strike: '0', status: 'OPEN', outcomes: [{ outcomeId: 'jac-out', name: 'JAC' }, { outcomeId: 'cle-out', name: 'CLE' }] },
    { marketId: 'm3', eventId: 'ev3', marketType: 'MONEY', strike: '0', status: 'OPEN', outcomes: [{ outcomeId: 'cle2', name: 'CLE' }, { outcomeId: 'pit-out', name: 'PIT' }] },
    {
      marketId: 'td', eventId: 'ev3', marketType: 'TOUCHDOWNS', strike: '0.5', status: 'OPEN',
      description: 'Deshaun Watson 0.5 TOUCHDOWNS',
      outcomes: [{ outcomeId: 'td-over', name: 'Over' }, { outcomeId: 'td-under', name: 'Under' }],
    },
  ],
};
const catalog = indexNovigCatalog('NFL', events, markets, T0 - 3600e3);
const lock = {
  id: 'L1', user_id: 'u1', label: 'Giants + Jaguars', fill_american: 400, max_contracts: 500,
  leg_keys: ['KXNFLGAME-26SEP13ARINYG-NYG:yes', 'KXNFLGAME-26SEP13CLEJAC-JAC:yes'],
};
const locks = indexLocks([lock]);
const hit = matchOutcomes(['nyg-out', 'jac-out'], catalog.byOutcome, locks);
assert.strictEqual(hit.ok, true, 'exact leg set matches one lock');
assert.strictEqual(hit.lock.id, 'L1');
assert.strictEqual(matchOutcomes(['nyg-out', 'nope'], catalog.byOutcome, locks).ok, false);
assert.strictEqual(matchOutcomes(['nyg-out', 'ari-out'], catalog.byOutcome, locks).reason, 'unknown');
const two = indexLocks([lock, { ...lock, id: 'L2', label: 'same legs' }]);
assert.strictEqual(matchOutcomes(['jac-out', 'nyg-out'], catalog.byOutcome, two).reason, 'ambiguous');

const prop = catalog.byOutcome.get('td-over');
assert.ok(prop && prop.key && prop.key.includes('p.deswat'), prop && prop.key);
assert.strictEqual(catalog.byOutcome.has('td-under'), false);

function harness(env, mutate) {
  const calls = [];
  const releases = [];
  const state = { clock: T0 - 3600e3, catalogAt: T0 - 3600e3, socketAt: T0 - 3600e3, balance: 5000 };
  const ctx = {
    env,
    now: () => state.clock,
    log: () => {},
    alert: (t) => calls.push(['alert', t]),
    catalogAt: () => state.catalogAt,
    socketAt: () => state.socketAt,
    outcomeIndex: () => catalog.byOutcome,
    lockIndex: () => locks,
    balance: () => ({ balance: state.balance, openCollateral: 0, at: state.clock }),
    filledFor: () => 0,
    otherHeld: () => 0,
    claim: async (row) => { calls.push(['claim', row.size, row.parlayId]); return { ok: true, other: 0 }; },
    release: async (row) => { releases.push(row.quoteId); },
    send: (frame) => calls.push(['send', frame]),
    shadowWrite: async (row) => { calls.push(['shadow', row]); },
    getParlays: () => [lock],
  };
  if (mutate) mutate(ctx, state);
  const q = createNovigQuoter(ctx);
  return { q, calls, releases, state };
}

const live = {
  NOVIG_DRY_RUN: '0', NOVIG_RFQ_LIVE: '1', NOVIG_SHADOW: '1', COMBO_CAP_AT_CONFIRM: '1',
};
const rfq = {
  type: 'rfq_created', rfqId: 'rfq-1', outcomeIds: ['nyg-out', 'jac-out'],
  expiresTs: T0, minWager: '10',
};

(async () => {
  // Hold, then quote. Confirm inside 1s does not claim again. Cap-at-confirm is on in env and ignored.
  {
    const h = harness(live);
    const planned = await h.q.onRfqCreated(rfq);
    assert.strictEqual(planned.action, 'quoted');
    assert.strictEqual(planned.price, '0.200');
    assert.strictEqual(formatAmerican(planned.american), '+400');
    assert.strictEqual(planned.maxWager, 25);
    assert.deepStrictEqual(h.calls.map((c) => c[0]), ['claim', 'send', 'alert', 'shadow']);
    assert.strictEqual(h.calls[0][1], 125);
    const sent = h.calls[1][1];
    assert.strictEqual(sent.quote.price, '0.200');
    assert.strictEqual(sent.quote.maxWager, '25');
    assert.ok(sent.quote.clientId);
    const acceptedAt = h.state.clock + 200;
    const conf = h.q.onQuoteAccepted({
      type: 'quote_accepted', rfqId: 'rfq-1', quoteId: 'qid-1', ts: h.state.clock, wager: '10', price: '0.200',
    }, acceptedAt);
    assert.strictEqual(conf.action, 'confirm');
    assert.ok(acceptedAt < h.state.clock + CONFIRM_MS);
    const confirms = h.calls.filter((c) => c[0] === 'send' && c[1].confirm);
    assert.strictEqual(confirms.length, 1);
    assert.strictEqual(confirms[0][1].confirm.confirmed, true);
    assert.strictEqual(confirms[0][1].confirm.quoteId, 'qid-1');
    assert.strictEqual(h.calls.filter((c) => c[0] === 'claim').length, 1);
  }

  // 1s deadline. A late confirm is not sent, and quoting pauses.
  {
    const h = harness(live);
    await h.q.onRfqCreated({ ...rfq, rfqId: 'rfq-late' });
    const t = h.state.clock;
    const miss = h.q.onQuoteAccepted({
      type: 'quote_accepted', rfqId: 'rfq-late', quoteId: 'qid-late', ts: t, wager: '10',
    }, t + CONFIRM_MS);
    assert.strictEqual(miss.action, 'miss');
    assert.ok(!h.calls.some((c) => c[0] === 'send' && c[1].confirm));
    assert.strictEqual(h.q.paused(), true);
    const next = await h.q.onRfqCreated({ ...rfq, rfqId: 'rfq-after' });
    assert.notStrictEqual(next.action, 'quoted');
    assert.ok(next.skip === 'confirm_deadline' || next.skip === 'confirm_rate');
    await new Promise((r) => setImmediate(r));
    assert.ok(h.releases.length >= 1);
  }

  // Hard fault at confirm: stale catalog rejects and pauses.
  {
    const h = harness(live);
    await h.q.onRfqCreated({ ...rfq, rfqId: 'rfq-stale' });
    h.state.catalogAt = h.state.clock - 20000;
    const rej = h.q.onQuoteAccepted({
      type: 'quote_accepted', rfqId: 'rfq-stale', quoteId: 'qid-stale', ts: h.state.clock, wager: '10',
    }, h.state.clock + 50);
    assert.strictEqual(rej.action, 'reject');
    assert.strictEqual(rej.reason, 'catalog_stale');
    const frame = h.calls.filter((c) => c[0] === 'send' && c[1].confirm).pop();
    assert.strictEqual(frame[1].confirm.confirmed, false);
    assert.strictEqual(h.q.paused(), true);
  }

  // Dry run blocks quote and confirm sends even when the live flag is on.
  {
    assert.strictEqual(sendsBlocked({}).blocked, true);
    assert.strictEqual(sendsBlocked({ NOVIG_DRY_RUN: '1', NOVIG_RFQ_LIVE: '1' }).blocked, true);
    assert.strictEqual(sendsBlocked({ NOVIG_DRY_RUN: '0', NOVIG_RFQ_LIVE: '0' }).blocked, true);
    assert.strictEqual(sendsBlocked({ NOVIG_DRY_RUN: '0', NOVIG_RFQ_LIVE: '1' }).blocked, false);
    const h = harness({ NOVIG_DRY_RUN: '1', NOVIG_RFQ_LIVE: '1', NOVIG_SHADOW: '1' });
    const out = await h.q.onRfqCreated({ ...rfq, rfqId: 'rfq-dry' });
    assert.strictEqual(out.skip, 'dry_run');
    assert.ok(!h.calls.some((c) => c[0] === 'send' || c[0] === 'claim'));
    const row = h.calls.find((c) => c[0] === 'shadow')[1];
    assert.strictEqual(row.would_price, '0.200');
    assert.strictEqual(row.would_american, 400);
    assert.strictEqual(row.would_max_wager, 25);
    h.q.noteTape({ type: 'executed', rfqId: 'rfq-dry', price: '0.250', wager: '20', offset: 1 });
    const won = h.q.shadowRows().find((r) => r.rfq_id === 'rfq-dry');
    assert.strictEqual(won.would_win, true);
    h.q.noteTape({ type: 'executed', rfqId: 'rfq-dry', price: '0.150', wager: '20', offset: 2 });
    assert.strictEqual(h.q.shadowRows().find((r) => r.rfq_id === 'rfq-dry').would_win, false);
  }

  // Unknown RFQ is silent. No shadow row.
  {
    const h = harness(live);
    const out = await h.q.onRfqCreated({ ...rfq, rfqId: 'rfq-unk', outcomeIds: ['nyg-out', 'missing'] });
    assert.strictEqual(out.action, 'silent');
    assert.ok(!h.calls.some((c) => c[0] === 'shadow' || c[0] === 'send'));
  }

  // Below min stake is not quoted.
  {
    const h = harness(live, (ctx, state) => { state.balance = 1; });
    const out = await h.q.onRfqCreated({ ...rfq, rfqId: 'rfq-small', minWager: '10' });
    assert.strictEqual(out.action, 'shadow');
    assert.ok(out.skip === 'below_min_wager' || out.skip === 'no_size');
    assert.ok(!h.calls.some((c) => c[0] === 'send'));
  }

  // quote_executed books one fill and frees the hold. A second execution does not.
  {
    const tables = { combo_fills: [], combo_submissions: [] };
    const h = harness(live, (ctx) => {
      ctx.supabase = {
        from(name) {
          if (!tables[name]) tables[name] = [];
          return {
            upsert(row) { tables[name].push(row); return { error: null }; },
            insert(row) { tables[name].push(row); return { error: null }; },
          };
        },
      };
    });
    await h.q.onRfqCreated({ ...rfq, rfqId: 'rfq-fill' });
    h.q.onQuoteAccepted({
      type: 'quote_accepted', rfqId: 'rfq-fill', quoteId: 'qid-fill', ts: h.state.clock, wager: '10', price: '0.200',
    }, h.state.clock + 100);
    const first = await h.q.onQuoteExecuted({
      type: 'quote_executed', rfqId: 'rfq-fill', quoteId: 'qid-fill', wager: '10', price: '0.200',
    });
    assert.strictEqual(first.status, 'new');
    assert.strictEqual(tables.combo_fills.length, 1);
    assert.strictEqual(tables.combo_fills[0].raw.venue, 'novig');
    assert.strictEqual(tables.combo_fills[0].fee, 0);
    assert.strictEqual(tables.combo_submissions[0].venue, 'novig');
    assert.strictEqual(tables.combo_submissions[0].status, 'filled');
    assert.ok(countsTowardCap(tables.combo_fills[0]));
    assert.strictEqual(isQuoteExecutionStub(tables.combo_fills[0]), false);
    assert.strictEqual(isKalshiTradeFill(tables.combo_fills[0]), false);
    const again = await h.q.reconcileExecutions([
      { rfqId: 'rfq-fill', price: '0.200', userCost: '10', cost: '40' },
    ]);
    assert.strictEqual(again.length, 0);
    assert.strictEqual(tables.combo_fills.length, 1);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(h.releases.length, 1);
  }

  // Reconnect backfill books a confirmed quote the socket missed.
  {
    const tables = { combo_fills: [], combo_submissions: [] };
    const h = harness(live, (ctx) => {
      ctx.supabase = {
        from(name) {
          if (!tables[name]) tables[name] = [];
          return {
            upsert(row) { tables[name].push(row); return { error: null }; },
            insert(row) { tables[name].push(row); return { error: null }; },
          };
        },
      };
    });
    await h.q.onRfqCreated({ ...rfq, rfqId: 'rfq-gap' });
    h.q.onQuoteAccepted({
      type: 'quote_accepted', rfqId: 'rfq-gap', quoteId: 'qid-gap', ts: h.state.clock, wager: '20',
    }, h.state.clock + 10);
    const booked = await h.q.reconcileExecutions([
      { rfqId: 'rfq-gap', price: '0.200', userCost: '20', cost: '80' },
    ]);
    assert.strictEqual(booked[0].status, 'new');
    assert.strictEqual(booked[0].payout, 100);
    const second = await h.q.reconcileExecutions([
      { rfqId: 'rfq-gap', price: '0.200', userCost: '20', cost: '80' },
    ]);
    assert.deepStrictEqual(second, []);
  }

  const summary = summarizeShadowRows([
    { skip_reason: null, would_price: '0.200', would_american: 400, executed_price: '0.250', would_win: true },
    { skip_reason: 'dry_run', would_price: '0.200', executed_price: '0.150', would_win: false },
    { skip_reason: 'dry_run', would_price: '0.200' },
  ]);
  assert.strictEqual(summary.wouldQuote, 1);
  assert.strictEqual(summary.wouldWin, 1);
  assert.strictEqual(summary.wouldLose, 1);
  assert.strictEqual(summary.awaitingExecution, 1);

  assert.strictEqual(stringToSign, require('./odds-relay').novigFeed.stringToSign);
  assert.strictEqual(milliFromDecimal('0.450'), 450);

  const liveSrc = fs.readFileSync(path.join(__dirname, 'live-runner.js'), 'utf8');
  const novigRet = liveSrc.indexOf('return; // Novig service: no Kalshi WebSocket');
  const fire = liveSrc.indexOf('createKalshiFirehose({');
  assert.ok(novigRet > 0 && novigRet < fire);
  assert.ok(liveSrc.includes('startNovigRfqLoop'));
  const start = fs.readFileSync(path.join(__dirname, 'start-novig.js'), 'utf8');
  assert.ok(start.includes("COMBO_ROLE: 'novig'"));
  assert.ok(start.includes("COMBO_CAP_AT_CONFIRM = '0'"));
  assert.ok(start.includes("NOVIG_DRY_RUN = '1'") || start.includes("env.NOVIG_DRY_RUN = '1'") || start.includes("NOVIG_DRY_RUN = '1'"));
  const toml = fs.readFileSync(path.join(__dirname, 'fly/novig-worker.toml'), 'utf8');
  assert.ok(toml.includes('kaygo-novig-worker'));
  assert.ok(toml.includes('NOVIG_DRY_RUN = "1"') && toml.includes('NOVIG_RFQ_LIVE = "0"'));
  assert.ok(!/PRIVATE KEY|BEGIN /.test(toml));

  console.log('novig-rfq tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
