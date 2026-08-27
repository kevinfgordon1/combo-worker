'use strict';
const assert = require('assert');
const {
  decideAtFill, fillView, impliedProb, americanFromProb,
  buildQuoteBody, yesBidForQuote, shouldPostQuote, isSilentQuoteFailure,
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

// Combo RFQ maker 0.035: fillView posts the after-fee conservative no_bid.
// At 0.0175, floor2 ate the haircut so +500/+1600 matched fee-ignored 0.83/0.94.
const COMBO_MAKER_KFEE = 0.035;
const afterFeeEff = (noBid) => {
  const sNom = 1 - parseFloat(noBid);
  return sNom - COMBO_MAKER_KFEE * sNom * (1 - sNom);
};
const fillNoBids = { 500: '0.82', 1000: '0.90', 1100: '0.91', 1600: '0.93', 2000: '0.95' };
for (const [fillStr, noBid] of Object.entries(fillNoBids)) {
  const fill = Number(fillStr);
  const v = fillView(fill);
  assert.strictEqual(v.noBid, noBid);
  const sEffQuoted = afterFeeEff(v.noBid);
  // Posted no_bid, after the 0.035 maker fee, never sells YES cheaper than the typed fill.
  assert.ok(sEffQuoted + 1e-12 >= impliedProb(fill));
  const effAm = americanFromProb(sEffQuoted);
  // Conservative floor can improve the plus (e.g. +1600 → ~+1377). Never a worse (higher) plus.
  assert.ok(effAm <= fill, `fill +${fill}: after-fee ${effAm} worse than typed`);
}

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

assert.ok(isSilentQuoteFailure('Kalshi quote failed 400: {"error":{"code":"insufficient_balance"}}'));
assert.ok(isSilentQuoteFailure('Kalshi quote failed 400: invalid_yes_bid: invalid dollar precision: 0'));
assert.ok(isSilentQuoteFailure('Kalshi quote failed 400: invalid_dollar_precision'));
assert.ok(!isSilentQuoteFailure('Kalshi quote failed 400: RFQ_CLOSED'));
assert.ok(!isSilentQuoteFailure('fetch failed'));
assert.ok(!isSilentQuoteFailure('Kalshi quote failed 400: unexpected'));

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

console.log('engine.test.js ok');
