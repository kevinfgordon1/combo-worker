'use strict';
const assert = require('assert');
const { decideAtFill, fillView, buildQuoteBody, yesBidForQuote, shouldPostQuote, isSilentQuoteFailure, YES_DECLINE } = require('./engine');
const { normalizeRfq } = require('./rfq');

assert.strictEqual(YES_DECLINE, '0.00');
assert.strictEqual(yesBidForQuote(undefined), '0.00');
assert.strictEqual(yesBidForQuote(null), '0.00');
assert.strictEqual(yesBidForQuote(''), '0.00');
assert.strictEqual(yesBidForQuote('0'), '0.00');
assert.strictEqual(yesBidForQuote(0), '0.00');
assert.strictEqual(yesBidForQuote('0.00'), '0.00');
assert.notStrictEqual(yesBidForQuote('0'), '0');

const d = decideAtFill({
  parlayStake: 100,
  parlayAmerican: 400,
  fillAmerican: 1100,
  rfqContracts: 10,
  hedgeMode: '1x',
  maxContracts: 50,
});
assert.ok(d.ok);
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
assert.strictEqual(dollarFit.quote.yes_bid, '0.00');
assert.notStrictEqual(dollarFit.quote.yes_bid, '0');
assert.strictEqual(dollarFit.quote.no_bid, fillView(350).noBid);
assert.strictEqual(dollarFit.contracts, 43);

const dollarPosted = buildQuoteBody('rfq-dollar-fit', dollarFit.quote.no_bid, dollarFit.quote.yes_bid, dollarFit.quote.rest_remainder);
assert.strictEqual(dollarPosted.yes_bid, '0.00');
assert.notStrictEqual(dollarPosted.yes_bid, '0');
assert.strictEqual(dollarPosted.no_bid, dollarFit.quote.no_bid);

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
assert.ok(!shouldPostQuote({ source: 'dollar', contracts: 0, targetCost: 10 }));

assert.ok(isSilentQuoteFailure('Kalshi quote failed 400: {"error":{"code":"insufficient_balance"}}'));
assert.ok(isSilentQuoteFailure('Kalshi quote failed 400: invalid_yes_bid: invalid dollar precision: 0'));
assert.ok(isSilentQuoteFailure('Kalshi quote failed 400: invalid_dollar_precision'));
assert.ok(!isSilentQuoteFailure('Kalshi quote failed 400: RFQ_CLOSED'));
assert.ok(!isSilentQuoteFailure('fetch failed'));
assert.ok(!isSilentQuoteFailure('Kalshi quote failed 400: unexpected'));

console.log('engine.test.js ok');
