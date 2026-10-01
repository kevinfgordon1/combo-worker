'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  decideAtFill, hedgeCap, fillView, buildQuoteBody, yesBidForQuote, shouldPostQuote, isSilentQuoteFailure,
  isInsufficientFundsFailure, quoteFailureSkipReason,
  isRfqClosedFailure, quotePostFailReason, formatQuoteLatency,
  YES_DECLINE, impliedYesBid, quoteYesBid, isRealYesBid, shouldConfirmAccept, contractsFromQuoteResponse,
} = require('./engine');
const { normalizeRfq } = require('./rfq');

assert.strictEqual(YES_DECLINE, '0.00');
assert.strictEqual(yesBidForQuote(undefined), '0.00');
assert.strictEqual(yesBidForQuote(null), '0.00');
assert.strictEqual(yesBidForQuote(''), '0.00');
assert.strictEqual(yesBidForQuote('0'), '0.00');
assert.strictEqual(yesBidForQuote(0), '0.00');
assert.strictEqual(yesBidForQuote('0.00'), '0.00');
assert.notStrictEqual(yesBidForQuote('0'), '0');
assert.strictEqual(impliedYesBid('0.77'), '0.23');
assert.strictEqual(impliedYesBid(0.77), '0.23');
assert.ok(parseFloat(impliedYesBid('0.77')) + 0.77 <= 1);
assert.strictEqual(quoteYesBid('contracts', '0.77'), YES_DECLINE);
assert.strictEqual(quoteYesBid('dollar', '0.77'), '0.23');
assert.ok(isRealYesBid('0.23'));
assert.ok(!isRealYesBid(YES_DECLINE));
assert.ok(!isRealYesBid('0'));

const d = decideAtFill({
  parlayStake: 100,
  parlayAmerican: 400,
  fillAmerican: 1100,
  rfqContracts: 10,
  hedgeMode: '1x',
  maxContracts: 50,
});
assert.ok(d.ok);
assert.strictEqual(d.outstanding, 0);
assert.strictEqual(d.quote.yes_bid, '0.00');
assert.notStrictEqual(d.quote.yes_bid, '0');
assert.ok(parseFloat(d.quote.no_bid) > 0);
assert.strictEqual(d.quote.no_bid, fillView(1100).noBid);
assert.match(d.quote.no_bid, /^\d+\.\d{2}$/);

const posted = buildQuoteBody('rfq-sox-pirates', d.quote.no_bid, d.quote.yes_bid, d.quote.rest_remainder);
assert.strictEqual(posted.yes_bid, '0.00');
assert.notStrictEqual(posted.yes_bid, '0');
assert.strictEqual(posted.no_bid, d.quote.no_bid);
assert.ok(parseFloat(posted.no_bid) > 0);
assert.strictEqual(posted.rfq_id, 'rfq-sox-pirates');
assert.strictEqual(posted.rest_remainder, false);

const defaulted = buildQuoteBody('rfq-2', '0.08');
assert.strictEqual(defaulted.yes_bid, '0.00');
assert.strictEqual(defaulted.no_bid, '0.08');

const leaked = buildQuoteBody('rfq-3', '0.09', '0', false);
assert.strictEqual(leaked.yes_bid, '0.00');
assert.strictEqual(leaked.no_bid, '0.09');

const wire = JSON.parse(JSON.stringify(posted));
assert.strictEqual(wire.yes_bid, '0.00');
assert.ok(Number(wire.no_bid) > 0);

const dollarRfq = normalizeRfq({
  type: 'rfq_created',
  msg: { id: 'rfq-dollar', target_cost_dollars: '25.00', mve_collection_ticker: 'KXMVE-X' },
});
assert.strictEqual(dollarRfq.contracts, null);
assert.strictEqual(dollarRfq.targetCostDollars, 25);
assert.strictEqual(shouldPostQuote({ source: 'dollar', contracts: 43, targetCost: 25 }), true);

const contractRfq = normalizeRfq({
  type: 'rfq_created',
  msg: { id: 'rfq-count', contracts_fp: '10.00', mve_collection_ticker: 'KXMVE-X' },
});
assert.strictEqual(contractRfq.contracts, 10);
assert.strictEqual(shouldPostQuote({ source: 'contracts', contracts: contractRfq.contracts }), true);
assert.strictEqual(shouldPostQuote({ source: 'none', contracts: null }), false);

// $10 dollar RFQ at +350 fill → no_bid 0.77 → yes ~0.23 → ~43 contracts. Fits a 116 cap.
const dollarNoBid = parseFloat(fillView(350).noBid);
const dollarYes = Math.max(0.01, 1 - dollarNoBid);
const dollarEst = Math.floor(10 / dollarYes);
assert.strictEqual(dollarEst, 43);
assert.strictEqual(shouldPostQuote({ source: 'dollar', contracts: dollarEst, targetCost: 10 }), true);

const dollarFit = decideAtFill({
  parlayStake: 100,
  parlayAmerican: 400,
  fillAmerican: 350,
  rfqContracts: dollarEst,
  hedgeMode: '1x',
  maxContracts: 116,
});
assert.ok(dollarFit.ok);
assert.strictEqual(dollarFit.quote.no_bid, fillView(350).noBid);
assert.strictEqual(dollarFit.contracts, 43);
assert.strictEqual(shouldPostQuote({ source: 'dollar', contracts: dollarFit.contracts, targetCost: 10 }), true);

// Dollar wire body: implied YES of the NO bid we send — never "0" / "0.00".
// Staged / decideAtFill still decline YES; POST must not copy that onto a dollar RFQ.
const dollarNoStr = dollarFit.quote.no_bid;
const dollarImpliedYes = impliedYesBid(dollarNoStr);
assert.strictEqual(dollarImpliedYes, '0.23');
assert.notStrictEqual(dollarImpliedYes, '0.00');
assert.notStrictEqual(dollarImpliedYes, '0');
assert.ok(isRealYesBid(dollarImpliedYes));
assert.ok(parseFloat(dollarImpliedYes) + parseFloat(dollarNoStr) <= 1);
assert.strictEqual(quoteYesBid('dollar', dollarNoStr), dollarImpliedYes);
assert.strictEqual(quoteYesBid('dollar', dollarNoStr), '0.23');

const dollarPosted = buildQuoteBody(
  'rfq-dollar-fit', dollarNoStr, quoteYesBid('dollar', dollarNoStr), dollarFit.quote.rest_remainder
);
assert.strictEqual(dollarPosted.yes_bid, '0.23');
assert.notStrictEqual(dollarPosted.yes_bid, '0.00');
assert.notStrictEqual(dollarPosted.yes_bid, '0');
assert.strictEqual(dollarPosted.no_bid, dollarNoStr);
assert.ok(parseFloat(dollarPosted.yes_bid) + parseFloat(dollarPosted.no_bid) <= 1);

// Blindly using staged YES_DECLINE would still blow up dollar sizing.
const stagedLeak = buildQuoteBody('rfq-dollar-staged', dollarNoStr, YES_DECLINE, false);
assert.strictEqual(stagedLeak.yes_bid, '0.00');
assert.notStrictEqual(quoteYesBid('dollar', dollarNoStr), stagedLeak.yes_bid);

// Contract-count path still declines YES with "0.00".
assert.strictEqual(quoteYesBid('contracts', d.quote.no_bid), YES_DECLINE);
const contractPosted = buildQuoteBody('rfq-count-wire', d.quote.no_bid, quoteYesBid('contracts', d.quote.no_bid), false);
assert.strictEqual(contractPosted.yes_bid, '0.00');
assert.notStrictEqual(contractPosted.yes_bid, '0');
assert.ok(parseFloat(contractPosted.no_bid) > 0);

const dollarHuge = decideAtFill({
  parlayStake: 100,
  parlayAmerican: 400,
  fillAmerican: 350,
  rfqContracts: 8000,
  hedgeMode: '1x',
  maxContracts: 116,
});
assert.strictEqual(dollarHuge.ok, false);
assert.strictEqual(dollarHuge.reason, 'rfq_too_large');

const dollarHugePartial = decideAtFill({
  parlayStake: 100,
  parlayAmerican: 400,
  fillAmerican: 350,
  rfqContracts: 8000,
  hedgeMode: '1x',
  maxContracts: 116,
  allowPartial: true,
});
assert.ok(dollarHugePartial.ok);
assert.strictEqual(dollarHugePartial.contracts, 116);
assert.strictEqual(dollarHugePartial.partial, true);
assert.strictEqual(dollarHugePartial.trimmedByLimit, true);
assert.strictEqual(dollarHugePartial.remaining, 0);

// Parallel $10 RFQs: first two 43s fit 116; a third does not (the overfill bug).
const soxArgs = {
  parlayStake: 100,
  parlayAmerican: 400,
  fillAmerican: 350,
  rfqContracts: dollarEst,
  hedgeMode: '1x',
  maxContracts: 116,
};
const q1 = decideAtFill({ ...soxArgs, filledSoFar: 0, outstanding: 0 });
assert.ok(q1.ok);
assert.strictEqual(q1.contracts, 43);
assert.strictEqual(q1.outstanding, 0);
assert.strictEqual(q1.remaining, 73);
const q2 = decideAtFill({ ...soxArgs, filledSoFar: 0, outstanding: 43 });
assert.ok(q2.ok);
assert.strictEqual(q2.outstanding, 43);
assert.strictEqual(q2.remaining, 30);
const q3 = decideAtFill({ ...soxArgs, filledSoFar: 0, outstanding: 86 });
assert.strictEqual(q3.ok, false);
assert.strictEqual(q3.reason, 'rfq_too_large');
assert.strictEqual(q3.remaining, 30);
assert.strictEqual(q3.outstanding, 86);
assert.ok(!shouldPostQuote({ source: 'dollar', contracts: 0, targetCost: 10 }));

const q3Partial = decideAtFill({ ...soxArgs, filledSoFar: 0, outstanding: 86, allowPartial: true });
assert.ok(q3Partial.ok);
assert.strictEqual(q3Partial.contracts, 30);
assert.strictEqual(q3Partial.partial, true);
assert.strictEqual(q3Partial.remaining, 0);
assert.strictEqual(q3Partial.outstanding, 86);

const leftoverEmpty = decideAtFill({ ...soxArgs, filledSoFar: 0, outstanding: 116, allowPartial: true });
assert.strictEqual(leftoverEmpty.ok, false);
assert.strictEqual(leftoverEmpty.reason, 'limit_reached');
assert.strictEqual(leftoverEmpty.remaining, 0);

assert.ok(isSilentQuoteFailure('Kalshi quote failed 400: {"error":{"code":"insufficient_balance"}}'));
assert.ok(isSilentQuoteFailure('Kalshi quote failed 400: invalid_yes_bid: invalid dollar precision: 0'));
assert.ok(isSilentQuoteFailure('Kalshi quote failed 400: invalid_dollar_precision'));
assert.ok(!isSilentQuoteFailure('Kalshi quote failed 400: RFQ_CLOSED'));
assert.ok(!isSilentQuoteFailure('fetch failed'));
assert.ok(!isSilentQuoteFailure('Kalshi quote failed 400: unexpected'));

assert.ok(isInsufficientFundsFailure('Kalshi quote failed 400: {"error":{"code":"insufficient_balance"}}'));
assert.ok(isInsufficientFundsFailure('Kalshi confirm failed 400: INSUFFICIENT_BALANCE'));
assert.ok(isInsufficientFundsFailure('Polymarket POST /v1/rfqs/quotes 400 not enough balance / allowance'));
assert.ok(isInsufficientFundsFailure('Polymarket PUT confirm 400 insufficient_funds'));
assert.ok(isInsufficientFundsFailure('{"error":"insufficient collateral"}'));
assert.ok(isInsufficientFundsFailure('not enough funds to back this quote'));
assert.ok(isInsufficientFundsFailure('not enough collateral'));
assert.ok(isInsufficientFundsFailure('underfunded'));
assert.ok(!isInsufficientFundsFailure('Kalshi quote failed 400: invalid_yes_bid: invalid dollar precision: 0'));
assert.ok(!isInsufficientFundsFailure('Kalshi quote failed 400: invalid_dollar_precision'));
assert.ok(!isInsufficientFundsFailure('Kalshi quote failed 400: RFQ_CLOSED'));
assert.ok(!isInsufficientFundsFailure('fetch failed'));

assert.strictEqual(
  quoteFailureSkipReason('Kalshi quote failed 400: {"error":{"code":"insufficient_balance"}}'),
  'insufficient_balance'
);
assert.strictEqual(
  quoteFailureSkipReason('Polymarket POST /v1/rfqs/quotes 400 not enough balance / allowance'),
  'insufficient_balance'
);
assert.strictEqual(quoteFailureSkipReason('Kalshi quote failed 400: invalid_yes_bid'), null);
assert.strictEqual(quoteFailureSkipReason('Kalshi quote failed 400: RFQ_CLOSED'), null);
assert.ok(isRfqClosedFailure('Kalshi quote failed 409: {"error":{"code":"rfq_closed"}}'));
assert.ok(isRfqClosedFailure('Kalshi quote failed 409: RFQ_CLOSED'));
assert.ok(isRfqClosedFailure('409 already closed'));
assert.ok(!isRfqClosedFailure('Kalshi quote failed 400: insufficient_balance'));
assert.ok(!isRfqClosedFailure('fetch failed'));
assert.strictEqual(
  quotePostFailReason('Kalshi quote failed 409: {"error":{"code":"rfq_closed"}}'),
  'rfq_closed'
);
assert.strictEqual(
  quotePostFailReason('Kalshi quote failed 400: {"error":{"code":"insufficient_balance"}}'),
  'insufficient_balance'
);
assert.strictEqual(quotePostFailReason('fetch failed'), null);
assert.ok(!isSilentQuoteFailure('Kalshi quote failed 409: {"error":{"code":"rfq_closed"}}'));
{
  const ok = formatQuoteLatency({
    matchMs: '1.2', preMs: '0.3', postMs: '42.0', totalMs: '43.5',
    rfqId: 'rfq-1', quoteId: 'q-1',
  });
  assert.strictEqual(ok, '[LAT] match=1.2 pre=0.3 post=42.0 total=43.5ms rfq=rfq-1 quote=q-1');
  const late = formatQuoteLatency({
    matchMs: '2.0', preMs: '0.1', postMs: '180.4', totalMs: '182.5',
    rfqId: 'rfq-late', failReason: 'rfq_closed',
  });
  assert.strictEqual(
    late,
    '[LAT] match=2.0 pre=0.1 post=180.4 total=182.5ms FAIL reason=rfq_closed rfq=rfq-late'
  );
}

// Two-sided dollar quote: confirm only the NO side.
assert.strictEqual(shouldConfirmAccept(YES_DECLINE, 'yes'), true);
assert.strictEqual(shouldConfirmAccept(YES_DECLINE, 'no'), true);
assert.strictEqual(shouldConfirmAccept('0.00', 'yes'), true);
assert.strictEqual(shouldConfirmAccept('0.23', 'no'), true);
assert.strictEqual(shouldConfirmAccept('0.23', 'NO'), true);
assert.strictEqual(shouldConfirmAccept('0.23', 'yes'), false);
assert.strictEqual(shouldConfirmAccept('0.23', 'YES'), false);
assert.strictEqual(shouldConfirmAccept('0.23', null), false);
assert.strictEqual(shouldConfirmAccept(undefined, 'yes'), true);

// CreateQuoteResponse is { id } only — keep the estimate. Prefer NO count if present.
assert.strictEqual(contractsFromQuoteResponse({ id: 'q1' }, 43), 43);
assert.strictEqual(contractsFromQuoteResponse({ id: 'q1', no_contracts_fp: '43.00' }, 40), 43);
assert.strictEqual(contractsFromQuoteResponse({ id: 'q1', yes_contracts_fp: '50.00', no_contracts_fp: '43.00' }, 40), 43);
assert.strictEqual(contractsFromQuoteResponse({ id: 'q1', contracts_fp: '41.00' }, 40), 41);
assert.strictEqual(contractsFromQuoteResponse({ quote: { no_contracts_fp: '42.00' } }, 40), 42);
assert.strictEqual(contractsFromQuoteResponse(null, 43), 43);

// riskfree_open: $100 at +2000, fill +1200. y = 1/13, W = 2000.
// 1× = 2100. Open cap = floor(2000 / (12/13)) = 2166. Win side stays ≥ $0.
{
  const stake = 100;
  const boost = 2000;
  const fill = 1200;
  const y = 1 / 13;
  const W = 2000;
  assert.strictEqual(hedgeCap({ stake, boostAmerican: boost, fillAmerican: fill, mode: '1x' }), 2100);
  assert.strictEqual(hedgeCap({ stake, boostAmerican: boost, fillAmerican: fill, mode: 'riskfree' }), 1300);
  assert.strictEqual(hedgeCap({ stake, boostAmerican: boost, fillAmerican: fill, mode: '2x' }), 4200);
  assert.strictEqual(hedgeCap({ stake, boostAmerican: boost, fillAmerican: fill, mode: '3x' }), 6300);
  assert.strictEqual(hedgeCap({ stake, boostAmerican: boost, fillAmerican: fill, mode: 'nope' }), 2100);
  const openCap = hedgeCap({ stake, boostAmerican: boost, fillAmerican: fill, mode: 'riskfree_open' });
  assert.strictEqual(openCap, 2166);
  assert.strictEqual(openCap, Math.floor(W / (1 - y)));
  const open = decideAtFill({
    parlayStake: stake,
    parlayAmerican: boost,
    fillAmerican: fill,
    rfqContracts: openCap,
    hedgeMode: 'riskfree_open',
    maxContracts: openCap,
  });
  assert.strictEqual(open.ok, true);
  assert.strictEqual(open.cap, 2166);
  assert.strictEqual(open.contracts, 2166);
  assert.strictEqual(open.hit, 0.62);
  assert.strictEqual(open.miss, 66.62);
  assert.ok(open.hit >= 0);
  const tooBig = decideAtFill({
    parlayStake: stake,
    parlayAmerican: boost,
    fillAmerican: fill,
    rfqContracts: 2167,
    hedgeMode: 'riskfree_open',
    maxContracts: openCap,
  });
  assert.strictEqual(tooBig.ok, false);
  assert.strictEqual(tooBig.reason, 'rfq_too_large');
  const between = decideAtFill({
    parlayStake: stake,
    parlayAmerican: boost,
    fillAmerican: fill,
    rfqContracts: 2166,
    hedgeMode: '1x',
    maxContracts: openCap,
  });
  assert.strictEqual(between.ok, false, '1× still declines an RFQ between 2100 and the open cap');
  assert.strictEqual(between.reason, 'rfq_too_large');
  assert.strictEqual(between.cap, 2100);
}

// Free bet: cash at risk is $0, profit is still face × (decimal − 1).
// A $100 free bet at +2000 has W = 2000, so the open cap is 2166, not 0.
{
  const face = 100;
  const profit = face * (2000 / 100);
  assert.strictEqual(profit, 2000);
  const free = hedgeCap({
    stake: face, boostAmerican: 2000, fillAmerican: 1200, mode: 'riskfree_open',
  });
  assert.strictEqual(free, 2166);
  assert.strictEqual(free, Math.floor(profit / (12 / 13)));
  const exact = hedgeCap({
    stake: 50, boostAmerican: 500, fillAmerican: 200, mode: 'riskfree_open',
  });
  assert.strictEqual(exact, 375, 'free-bet profit that divides evenly stays on the integer');
  const filled = decideAtFill({
    parlayStake: 50,
    parlayAmerican: 500,
    fillAmerican: 200,
    rfqContracts: exact,
    hedgeMode: 'riskfree_open',
    maxContracts: exact,
  });
  assert.strictEqual(filled.ok, true);
  assert.ok(filled.hit >= 0);
  assert.strictEqual(filled.hit, 0);
}

// Short parlay odds, and a short fill that is larger than the legacy 3× cap.
{
  const short = hedgeCap({
    stake: 100, boostAmerican: -200, fillAmerican: 150, mode: 'riskfree_open',
  });
  assert.strictEqual(hedgeCap({
    stake: 100, boostAmerican: -200, fillAmerican: 150, mode: '1x',
  }), 150);
  assert.strictEqual(short, 83);
  const shortFill = decideAtFill({
    parlayStake: 100,
    parlayAmerican: -200,
    fillAmerican: 150,
    rfqContracts: short,
    hedgeMode: 'riskfree_open',
  });
  assert.strictEqual(shortFill.ok, true);
  assert.ok(shortFill.hit >= 0);
  assert.strictEqual(shortFill.hit, 0.2);
  const past3x = hedgeCap({
    stake: 100, boostAmerican: 2000, fillAmerican: -400, mode: 'riskfree_open',
  });
  assert.strictEqual(past3x, 10000);
  assert.ok(past3x > hedgeCap({
    stake: 100, boostAmerican: 2000, fillAmerican: -400, mode: '3x',
  }));
}

// Merged cash: $40 at +1500 and $60 at +2500 → S = 100, W = 2100, odds +2100.
{
  const merged = hedgeCap({
    stake: 100, boostAmerican: 2100, fillAmerican: 1200, mode: 'riskfree_open',
  });
  assert.strictEqual(merged, 2275);
  assert.strictEqual(hedgeCap({
    stake: 100, boostAmerican: 2100, fillAmerican: 1200, mode: '1x',
  }), 2200);
  assert.strictEqual(hedgeCap({
    stake: 100, boostAmerican: 2100, fillAmerican: 1200, mode: '3x',
  }), 6600);
}

// Bad inputs stay finite. y outside (0, 1) and a non-positive profit return 0.
{
  assert.strictEqual(hedgeCap({
    stake: 0, boostAmerican: 2000, fillAmerican: 1200, mode: 'riskfree_open',
  }), 0);
  assert.strictEqual(hedgeCap({
    stake: 100, boostAmerican: 2000, fillAmerican: null, mode: 'riskfree_open',
  }), 0);
  assert.strictEqual(hedgeCap({
    stake: 100, boostAmerican: 2000, fillAmerican: 0, mode: 'riskfree_open',
  }), 0);
  assert.strictEqual(hedgeCap({
    stake: NaN, boostAmerican: 2000, fillAmerican: 1200, mode: 'riskfree_open',
  }), 0);
  const infiniteFill = hedgeCap({
    stake: 100, boostAmerican: 2000, fillAmerican: Number.POSITIVE_INFINITY, mode: 'riskfree_open',
  });
  assert.strictEqual(infiniteFill, 0);
  assert.ok(Number.isFinite(infiniteFill));
}

for (const file of ['live-runner.js', 'shadow-runner.js', 'polymarket-rfq.js']) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  assert.match(
    src,
    /hedgeMode:\s*(?:p|parlay)\.hedge_mode\s*\|\|\s*'1x'/,
    `${file} must pass hedge_mode into decideAtFill`
  );
}

{
  // Original riskfree mode on a FREE BET with max_contracts 0/null must not quote.
  // The fallback would size it like cash (ceil(stake / y)) with no persisted
  // ceiling, which confirm-time / reserve checks treat as unlimited.
  const { isFreeBetRow, freeBetRiskfreeMissingCap } = require('./engine');
  const base = {
    parlayStake: 100, parlayAmerican: 650, fillAmerican: 610, rfqContracts: 50,
    hedgeMode: 'riskfree', isFreeBet: true,
  };
  for (const maxContracts of [0, null, undefined, '', '0', -5, NaN]) {
    const d = decideAtFill({ ...base, maxContracts });
    assert.strictEqual(d.ok, false, `max=${maxContracts}`);
    assert.strictEqual(d.reason, 'no_cap', `max=${maxContracts}`);
  }
  // Correct saved cap (ceil(face / y) = 710) quotes and is the ceiling.
  const ok = decideAtFill({ ...base, maxContracts: 710 });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.totalLimit, 710);
  const capped = decideAtFill({ ...base, maxContracts: 710, filledSoFar: 700, rfqContracts: 50, allowPartial: true });
  assert.strictEqual(capped.ok, true);
  assert.strictEqual(capped.contracts, 10);
  // Cash riskfree and other free-bet modes keep the old fallback (unchanged behavior).
  assert.strictEqual(decideAtFill({ ...base, isFreeBet: false, maxContracts: 0 }).ok, true);
  assert.strictEqual(decideAtFill({ ...base, hedgeMode: '1x', maxContracts: 0 }).ok, true);
  assert.strictEqual(decideAtFill({ ...base, hedgeMode: 'riskfree_open', maxContracts: 0 }).ok, true);
  assert.strictEqual(freeBetRiskfreeMissingCap({ hedgeMode: 'riskfree', maxContracts: 0, isFreeBet: false }), false);
  assert.strictEqual(isFreeBetRow({ is_free_bet: true }), true);
  assert.strictEqual(isFreeBetRow({ bet_type: 'free' }), true);
  assert.strictEqual(isFreeBetRow({ is_free_bet: false, bet_type: 'cash' }), false);
  assert.strictEqual(isFreeBetRow(null), false);
  // Every live quoting path must pass isFreeBet so the guard can fire.
  for (const file of ['live-runner.js', 'polymarket-rfq.js', 'shadow-runner.js']) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(/isFreeBet:\s*isFreeBetRow\(/.test(src), `${file} must pass isFreeBet into decideAtFill`);
  }
}

console.log('engine.test.js ok');


// ─── KALSHI_SUBCENT: exact-target quoting on the 0.001 grid ──────────────────
{
  const { floor3, subcentEnabled, isSubcentPrice, isPriceGridFailure, pennyNoBid, americanFromProb: amFromProb } = require('./engine');
  const { impliedProb: impProb } = require('./engine');
  const aToDecT = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));

  assert.strictEqual(subcentEnabled({}), false, 'default OFF in code');
  assert.strictEqual(subcentEnabled({ KALSHI_SUBCENT: '' }), false);
  assert.strictEqual(subcentEnabled({ KALSHI_SUBCENT: '0' }), false);
  assert.strictEqual(subcentEnabled({ KALSHI_SUBCENT: 'off' }), false);
  assert.strictEqual(subcentEnabled({ KALSHI_SUBCENT: '1' }), true);
  assert.strictEqual(subcentEnabled({ KALSHI_SUBCENT: 'true' }), true);
  assert.strictEqual(floor3(0.7749999999), 0.774);
  assert.strictEqual(floor3(0.775), 0.775);
  assert.strictEqual(isSubcentPrice('0.774'), true);
  assert.strictEqual(isSubcentPrice('0.77'), false);
  assert.strictEqual(isSubcentPrice('0.770'), false);

  // Flag OFF keeps the penny floor byte-for-byte.
  assert.strictEqual(fillView(350).noBid, '0.77');
  assert.strictEqual(fillView(350, { subcent: false }).noBid, '0.77');
  assert.strictEqual(fillView(1100).noBid, '0.91');

  // +350 → exact target no_bid 0.7747… → 0.774 on the 0.001 grid (penny floor was 0.77).
  assert.strictEqual(fillView(350, { subcent: true }).noBid, '0.774');
  assert.strictEqual(fillView(1100, { subcent: true }).noBid, '0.915');
  assert.strictEqual(impliedYesBid('0.774'), '0.226');
  assert.strictEqual(impliedYesBid('0.77'), '0.23', 'penny NO still gets the penny YES');
  assert.strictEqual(quoteYesBid('dollar', '0.774'), '0.226');
  assert.strictEqual(quoteYesBid('contracts', '0.774'), YES_DECLINE);
  assert.strictEqual(parseFloat(impliedYesBid('0.774')) + 0.774, 1);
  assert.strictEqual(pennyNoBid('0.774'), '0.77');
  assert.strictEqual(pennyNoBid('0.915'), '0.91');
  assert.ok(isPriceGridFailure('Kalshi quote failed 400: {"error":{"code":"invalid_yes_bid"}}'));
  assert.ok(!isPriceGridFailure('Kalshi quote failed 409: {"error":{"code":"rfq_closed"}}'));
  assert.ok(!isPriceGridFailure('Kalshi quote failed 400: insufficient_balance'));

  // Sweep every American fill from −2000..+5000: the quote is NEVER worse than the lock's
  // target odds (net of the maker fee), always on the 0.001 grid, always at least as good as
  // the penny floor, never more than 0.9¢ above it, and profit at the exact price ≥ target profit.
  let swept = 0;
  for (let a = -2000; a <= 5000; a++) {
    if (a > -100 && a < 100) continue;
    const pen = fillView(a);
    const sub = fillView(a, { subcent: true });
    const noP = parseFloat(pen.noBid), noS = parseFloat(sub.noBid);
    assert.match(sub.noBid, /^\d\.\d{3}$/, `3dp string for ${a}`);
    assert.ok(Math.abs(noS * 1000 - Math.round(noS * 1000)) < 1e-9, `on 0.001 grid ${a}`);
    assert.ok(noS >= noP - 1e-12, `sub-cent never below penny ${a}`);
    assert.ok(noS - noP < 0.0100001, `within one cent of penny ${a}`);
    assert.ok(noS <= 0.99 + 1e-12, `cap 0.99 ${a}`);
    // Effective sell odds at the quoted price are >= lock target (probability ≥ target prob).
    const target = impProb(a);
    assert.ok(sub.sEffQuoted + 1e-9 >= target || noS >= 0.99 - 1e-12, `quote not worse than target ${a}: ${sub.sEffQuoted} < ${target}`);
    swept++;
  }
  assert.ok(swept > 6000);

  // decideAtFill: recheck profit at the exact price for every hedge mode, keep guards.
  for (const mode of ['1x', 'riskfree', 'riskfree_open']) {
    for (const fill of [350, 163, 1100, 800, 450, 275]) {
      const base = { parlayStake: 100, parlayAmerican: 900, fillAmerican: fill, rfqContracts: 10, hedgeMode: mode, maxContracts: 10000 };
      const off = decideAtFill(base);
      const on = decideAtFill({ ...base, subcent: true });
      assert.ok(off.ok === on.ok, `same decision ${mode}/${fill}`);
      if (!on.ok) continue;
      assert.strictEqual(on.contracts, off.contracts);
      assert.strictEqual(on.subcent, true);
      assert.ok(on.worstAtQuote >= on.worst - 0.01, `profit at quote ≥ target profit (${mode}/${fill}) ${on.worstAtQuote} vs ${on.worst}`);
      assert.strictEqual(on.quote.yes_bid, '0.00');
      assert.match(on.quote.no_bid, /^\d\.\d{3}$/);
      assert.strictEqual(off.quote.no_bid, fillView(fill).noBid);
    }
  }
  // Guards unchanged with the flag on: cap, limit, free-bet no_cap.
  const capOn = decideAtFill({ parlayStake: 100, parlayAmerican: 400, fillAmerican: 350, rfqContracts: 8000, hedgeMode: '1x', maxContracts: 116, subcent: true });
  assert.strictEqual(capOn.ok, false);
  assert.strictEqual(capOn.reason, 'rfq_too_large');
  const limOn = decideAtFill({ parlayStake: 100, parlayAmerican: 400, fillAmerican: 350, rfqContracts: 10, hedgeMode: '1x', maxContracts: 116, filledSoFar: 116, subcent: true });
  assert.strictEqual(limOn.reason, 'limit_reached');
  const noCapOn = decideAtFill({ parlayStake: 100, parlayAmerican: 400, fillAmerican: 350, rfqContracts: 10, hedgeMode: 'riskfree', maxContracts: 0, isFreeBet: true, subcent: true });
  assert.strictEqual(noCapOn.reason, 'no_cap');

  // Dollar RFQ at +350 with sub-cent: 0.774 NO / 0.226 YES → 10/0.226 = 44 contracts (43 at penny).
  const sc = fillView(350, { subcent: true });
  assert.strictEqual(Math.floor(10 / parseFloat(impliedYesBid(sc.noBid))), 44);
  const scBody = buildQuoteBody('rfq-sub', sc.noBid, quoteYesBid('dollar', sc.noBid), false);
  assert.deepStrictEqual(scBody, { rfq_id: 'rfq-sub', yes_bid: '0.226', no_bid: '0.774', rest_remainder: false });
  const scCount = buildQuoteBody('rfq-sub2', sc.noBid, quoteYesBid('contracts', sc.noBid), false);
  assert.deepStrictEqual(scCount, { rfq_id: 'rfq-sub2', yes_bid: '0.00', no_bid: '0.774', rest_remainder: false });
}
console.log('engine subcent ok');
