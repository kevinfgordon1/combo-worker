'use strict';
const assert = require('assert');
const { decideAtFill } = require('./engine');
const { normalizeTrade } = require('./tape');
const {
  classifySkip,
  skipPersistExtra,
  withVenue,
  isSkipTapeEligible,
  tapeFieldsFromMatch,
  isTapeReady,
  rfqCountForTape,
  resolveSkipTape,
  TAPE_PAD_MS,
} = require('./skip-tape');

const args = {
  parlayStake: 100,
  parlayAmerican: 400,
  fillAmerican: 350,
  hedgeMode: '1x',
  maxContracts: 116,
};

// ── skip classification (engine reasons → persist values) ──────────────
{
  const oversized = decideAtFill({ ...args, rfqContracts: 8000 });
  assert.strictEqual(oversized.ok, false);
  assert.strictEqual(oversized.reason, 'rfq_too_large');
  assert.strictEqual(classifySkip(oversized), 'oversized');
  assert.strictEqual(oversized.remaining, 116);

  const leftover = decideAtFill({ ...args, rfqContracts: 43, filledSoFar: 0, outstanding: 86 });
  assert.strictEqual(leftover.ok, false);
  assert.strictEqual(leftover.reason, 'rfq_too_large');
  assert.strictEqual(classifySkip(leftover), 'oversized');
  assert.strictEqual(leftover.remaining, 30);

  const cap = decideAtFill({ ...args, rfqContracts: 10, filledSoFar: 116 });
  assert.strictEqual(cap.ok, false);
  assert.strictEqual(cap.reason, 'limit_reached');
  assert.strictEqual(classifySkip(cap), 'limit_reached');
  assert.strictEqual(cap.remaining, 0);

  const reservedFull = decideAtFill({ ...args, rfqContracts: 10, filledSoFar: 50, outstanding: 66 });
  assert.strictEqual(reservedFull.reason, 'limit_reached');
  assert.strictEqual(classifySkip(reservedFull), 'limit_reached');

  const ok = decideAtFill({ ...args, rfqContracts: 43 });
  assert.ok(ok.ok);
  assert.strictEqual(classifySkip(ok), null);

  const bad = decideAtFill({ parlayStake: 0, parlayAmerican: 400, fillAmerican: 350, rfqContracts: 10 });
  assert.strictEqual(bad.reason, 'bad_inputs');
  assert.strictEqual(classifySkip(bad), null);
  assert.strictEqual(classifySkip(null), null);
  assert.strictEqual(classifySkip({ ok: false, reason: 'zero_cap' }), null);
}

{
  const extra = skipPersistExtra({
    skipReason: 'oversized',
    contracts: 8000,
    remaining: 116,
    marketTicker: 'KXMVE-ABC',
  });
  assert.deepStrictEqual(extra, {
    skip_reason: 'oversized',
    contracts: 8000,
    remaining: 116,
    market_ticker: 'KXMVE-ABC',
  });
  const cap = skipPersistExtra({ skipReason: 'limit_reached', contracts: 10, remaining: 0 });
  assert.strictEqual(cap.skip_reason, 'limit_reached');
  assert.strictEqual(cap.remaining, 0);
  assert.strictEqual(cap.contracts, 10);
  assert.ok(!('market_ticker' in cap));
}

// Miss tape insert extras: default kalshi; Poly fallback; caller venue wins.
{
  const kalshiBody = { status: 'quoted', ...withVenue() };
  assert.strictEqual(kalshiBody.venue, 'kalshi');
  assert.strictEqual(kalshiBody.status, 'quoted');

  const skipBody = { status: 'declined', ...withVenue({ skip_reason: 'oversized', contracts: 8000 }) };
  assert.strictEqual(skipBody.venue, 'kalshi');
  assert.strictEqual(skipBody.skip_reason, 'oversized');
  assert.strictEqual(skipBody.contracts, 8000);

  const polyWrap = (extra) => ({ status: 'quoted', ...withVenue(extra, 'polymarket') });
  const polyBody = polyWrap({ quote_id: 'q-pm', is_live: true });
  assert.strictEqual(polyBody.venue, 'polymarket');
  assert.strictEqual(polyBody.quote_id, 'q-pm');
  assert.strictEqual(polyBody.is_live, true);

  const alreadyPoly = polyWrap({ venue: 'polymarket', skip_reason: 'oversized' });
  assert.strictEqual(alreadyPoly.venue, 'polymarket');
  assert.strictEqual(alreadyPoly.skip_reason, 'oversized');

  assert.strictEqual(withVenue({ venue: 'polymarket' }).venue, 'polymarket');
  assert.strictEqual(withVenue(undefined, 'polymarket').venue, 'polymarket');
}

// ── eligibility: active lock, before kickoff, not already taped ────────
{
  const base = { skipReason: 'oversized', tapeMatch: null, parlayActive: true, started: false, now: 1_000_000 };
  assert.strictEqual(isSkipTapeEligible(base), true);
  assert.strictEqual(isSkipTapeEligible({ ...base, skipReason: 'limit_reached' }), true);
  assert.strictEqual(isSkipTapeEligible({ ...base, skipReason: 'declined' }), false);
  assert.strictEqual(isSkipTapeEligible({ ...base, tapeMatch: 'none' }), false);
  assert.strictEqual(isSkipTapeEligible({ ...base, tapeMatch: 'matched' }), false);
  assert.strictEqual(isSkipTapeEligible({ ...base, parlayActive: false }), false);
  assert.strictEqual(isSkipTapeEligible({ ...base, started: true }), false);
  assert.strictEqual(isSkipTapeEligible({ ...base, startsAt: new Date(500_000).toISOString() }), false);
  assert.strictEqual(isSkipTapeEligible({ ...base, startsAt: new Date(2_000_000).toISOString() }), true);
}

{
  assert.strictEqual(isTapeReady({ status: 'open', closedMs: Date.now(), now: Date.now() }), false);
  const closed = Date.parse('2026-08-12T20:00:00Z');
  assert.strictEqual(isTapeReady({ status: 'closed', closedMs: closed, now: closed + 1000 }), false);
  assert.strictEqual(isTapeReady({ status: 'closed', closedMs: closed, now: closed + TAPE_PAD_MS }), true);
  assert.strictEqual(isTapeReady({ status: 'cancelled', closedMs: closed, now: closed + TAPE_PAD_MS }), true);
  assert.strictEqual(isTapeReady({ status: null, closedMs: null, now: Date.now() }), false);
}

assert.strictEqual(rfqCountForTape({ contracts_fp: '10.00' }, 9), 10);
assert.strictEqual(rfqCountForTape({ contracts: 7 }, 9), 7);
assert.strictEqual(rfqCountForTape({}, 9), 9);
assert.strictEqual(rfqCountForTape({}, null), null);

{
  const matched = tapeFieldsFromMatch({
    match: 'matched', yesPrice: 0.08, noPrice: 0.92, tradeTs: Date.parse('2026-08-12T20:00:03Z'),
  });
  assert.strictEqual(matched.tape_match, 'matched');
  assert.strictEqual(matched.tape_yes_price, 0.08);
  assert.strictEqual(matched.tape_no_price, 0.92);
  assert.strictEqual(matched.tape_trade_ts, '2026-08-12T20:00:03.000Z');

  const none = tapeFieldsFromMatch({ match: 'none' });
  assert.strictEqual(none.tape_match, 'none');
  assert.strictEqual(none.tape_yes_price, null);
  assert.strictEqual(none.tape_no_price, null);
  assert.strictEqual(none.tape_trade_ts, null);

  // Ambiguous is not a print we can trust — do not guess a price.
  const amb = tapeFieldsFromMatch({ match: 'ambiguous', yesPrice: 0.50, noPrice: 0.50 });
  assert.strictEqual(amb.tape_match, 'none');
  assert.strictEqual(amb.tape_yes_price, null);
  assert.strictEqual(amb.tape_no_price, null);
}

function parseTs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const closedIso = '2026-08-12T20:00:00Z';
const closedMs = Date.parse(closedIso);
const afterPad = closedMs + TAPE_PAD_MS + 1000;
const row = {
  rfq_id: 'rfq-skip-1',
  contracts: 10,
  market_ticker: 'KXMVE-ABC',
  skip_reason: 'oversized',
};

const closedRfq = {
  status: 'closed',
  market_ticker: 'KXMVE-ABC',
  contracts_fp: '10.00',
  created_ts: '2026-08-12T19:59:30Z',
  updated_ts: closedIso,
};

async function testTapeOnSkip() {
  // print vs no print (targeted ticker only)
  {
    let tradeCalls = 0;
    const print = normalizeTrade({
      count_fp: '10.00',
      no_price_dollars: '0.92',
      yes_price_dollars: '0.08',
      created_time: '2026-08-12T20:00:03Z',
      is_block_trade: true,
    }, parseTs);
    const out = await resolveSkipTape(row, {
      now: afterPad,
      fetchRfq: async (id) => { assert.strictEqual(id, 'rfq-skip-1'); return closedRfq; },
      fetchTrades: async (ticker, minTs, maxTs) => {
        tradeCalls++;
        assert.strictEqual(ticker, 'KXMVE-ABC');
        assert.ok(minTs > 0 && maxTs > minTs);
        return [{
          count_fp: '10.00',
          no_price_dollars: '0.92',
          yes_price_dollars: '0.08',
          created_time: '2026-08-12T20:00:03Z',
          is_block_trade: true,
        }];
      },
    });
    assert.strictEqual(tradeCalls, 1);
    assert.strictEqual(out.retry, false);
    assert.strictEqual(out.patch.tape_match, 'matched');
    assert.strictEqual(out.patch.tape_yes_price, 0.08);
    assert.strictEqual(out.patch.tape_no_price, 0.92);
    assert.strictEqual(out.patch.tape_trade_ts, '2026-08-12T20:00:03.000Z');
    assert.strictEqual(out.patch.market_ticker, 'KXMVE-ABC');
    assert.strictEqual(print.yes, 0.08);
  }

  {
    let tradeCalls = 0;
    const out = await resolveSkipTape({ ...row, skip_reason: 'limit_reached' }, {
      now: afterPad,
      fetchRfq: async () => closedRfq,
      fetchTrades: async (ticker) => {
        tradeCalls++;
        assert.strictEqual(ticker, 'KXMVE-ABC');
        return [];
      },
    });
    assert.strictEqual(tradeCalls, 1);
    assert.strictEqual(out.retry, false);
    assert.strictEqual(out.patch.tape_match, 'none');
    assert.strictEqual(out.patch.tape_yes_price, null);
    assert.strictEqual(out.patch.tape_no_price, null);
    assert.strictEqual(out.patch.tape_trade_ts, null);
  }

  // still open / inside pad → wait, no trades GET
  {
    let tradeCalls = 0;
    const open = await resolveSkipTape(row, {
      now: afterPad,
      fetchRfq: async () => ({ ...closedRfq, status: 'open' }),
      fetchTrades: async () => { tradeCalls++; return []; },
    });
    assert.strictEqual(open.retry, true);
    assert.strictEqual(tradeCalls, 0);

    const early = await resolveSkipTape(row, {
      now: closedMs + 1000,
      fetchRfq: async () => closedRfq,
      fetchTrades: async () => { tradeCalls++; return []; },
    });
    assert.strictEqual(early.retry, true);
    assert.strictEqual(tradeCalls, 0);
  }

  // RFQ gone / no ticker → none, no guess
  {
    const gone = await resolveSkipTape(row, {
      now: afterPad,
      fetchRfq: async () => null,
      fetchTrades: async () => { throw new Error('should not fetch trades'); },
    });
    assert.strictEqual(gone.retry, false);
    assert.strictEqual(gone.patch.tape_match, 'none');

    const noTicker = await resolveSkipTape({ ...row, market_ticker: null }, {
      now: afterPad,
      fetchRfq: async () => ({ ...closedRfq, market_ticker: null, ticker: null }),
      fetchTrades: async () => { throw new Error('should not fetch trades'); },
    });
    assert.strictEqual(noTicker.patch.tape_match, 'none');
  }

  // fetch failure → retry (do not write none)
  {
    const rfqFail = await resolveSkipTape(row, {
      now: afterPad,
      fetchRfq: async () => { throw new Error('rfq 503'); },
      fetchTrades: async () => [],
    });
    assert.strictEqual(rfqFail.retry, true);

    const tradeFail = await resolveSkipTape(row, {
      now: afterPad,
      fetchRfq: async () => closedRfq,
      fetchTrades: async () => { throw new Error('trades 503'); },
    });
    assert.strictEqual(tradeFail.retry, true);
  }

  // lookups are per-rfq / per-ticker only — never a universe poll
  {
    const ids = [];
    const tickers = [];
    await resolveSkipTape(row, {
      now: afterPad,
      fetchRfq: async (id) => { ids.push(id); return closedRfq; },
      fetchTrades: async (ticker) => { tickers.push(ticker); return []; },
    });
    assert.deepStrictEqual(ids, ['rfq-skip-1']);
    assert.deepStrictEqual(tickers, ['KXMVE-ABC']);
  }
}

testTapeOnSkip().then(() => {
  console.log('skip-tape.test.js ok');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
