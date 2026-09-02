'use strict';
const assert = require('assert');
const { americanFromProb } = require('./engine');
const {
  KALSHI_COMBO_MAKER,
  KALSHI_NFL_MAKER,
  POLY_MAKER_REBATE,
  DEFAULT_CUSHION_YES,
  isUnhedgedRfqLive,
  makerFee,
  isKalshiNflOnly,
  kalshiMakerRate,
  venueMakerRate,
  quoteYesFromFair,
  priceUnhedgedCombo,
} = require('./unhedged-quote');

assert.strictEqual(isUnhedgedRfqLive({}), false);
assert.strictEqual(isUnhedgedRfqLive({ UNHEDGED_RFQ_LIVE: '' }), false);
assert.strictEqual(isUnhedgedRfqLive({ UNHEDGED_RFQ_LIVE: 'false' }), false);
assert.strictEqual(isUnhedgedRfqLive({ UNHEDGED_RFQ_LIVE: 'true' }), true);
assert.strictEqual(DEFAULT_CUSHION_YES, 0.05);
assert.strictEqual(KALSHI_NFL_MAKER, 0);
assert.strictEqual(KALSHI_COMBO_MAKER, 0.035);
assert.strictEqual(POLY_MAKER_REBATE, 0.0125);

const nflLegs = [
  { league: 'nfl', ticker: 'KXNFLGAME-A-KC', side: 'yes' },
  { league: 'nfl', ticker: 'KXNFLGAME-B-BUF', side: 'yes' },
];
const mlbLegs = [
  { league: 'mlb', ticker: 'KXMLBGAME-A-CWS', side: 'yes' },
  { league: 'mlb', ticker: 'KXMLBGAME-B-PIT', side: 'yes' },
];
const mixedLegs = [
  { league: 'nfl', ticker: 'KXNFLGAME-A-KC', side: 'yes' },
  { league: 'mlb', ticker: 'KXMLBGAME-B-PIT', side: 'yes' },
];

assert.strictEqual(isKalshiNflOnly(nflLegs), true);
assert.strictEqual(isKalshiNflOnly(mlbLegs), false);
assert.strictEqual(isKalshiNflOnly(mixedLegs), false);
assert.strictEqual(kalshiMakerRate(nflLegs), 0);
assert.strictEqual(kalshiMakerRate(mlbLegs), 0.035);
assert.strictEqual(venueMakerRate('polymarket', mlbLegs), -0.0125);

// 2-leg even money: fair = 0.25
const fair = 0.25;
assert.strictEqual(makerFee(fair, 0), 0);
assert.strictEqual(makerFee(fair, 0.035), 0.035 * 0.25 * 0.75);
assert.strictEqual(makerFee(fair, -0.0125), -0.0125 * 0.25 * 0.75);

const nflQuoteYes = quoteYesFromFair(fair, { feeRate: 0, cushion: 0.05 });
assert.strictEqual(nflQuoteYes, 0.20);

const mlbFee = 0.035 * 0.25 * 0.75; // 0.0065625
const mlbQuoteYes = quoteYesFromFair(fair, { feeRate: 0.035, cushion: 0.05 });
assert.strictEqual(mlbQuoteYes, 0.19);
assert.ok(mlbQuoteYes < nflQuoteYes);

const polyQuoteYes = quoteYesFromFair(fair, { feeRate: -0.0125, cushion: 0.05 });
assert.strictEqual(polyQuoteYes, 0.20);

const prices = {
  'KXNFLGAME-A-KC': 0.5,
  'KXNFLGAME-B-BUF': 0.5,
  'KXMLBGAME-A-CWS': 0.5,
  'KXMLBGAME-B-PIT': 0.5,
  'aec-mlb-cws-det-2026-08-14-cws': 0.5,
  'aec-mlb-bos-pit-2026-08-14-pit': 0.5,
};

function lookup(_venue, key) {
  return prices[key] != null ? prices[key] : null;
}

{
  const nfl = priceUnhedgedCombo({ venue: 'kalshi', legs: nflLegs, getYesProb: lookup });
  assert.strictEqual(nfl.fairYes, 0.25);
  assert.strictEqual(nfl.quoteYes, 0.20);
  assert.strictEqual(nfl.feeRate, 0);
  assert.strictEqual(nfl.our_fair_american, americanFromProb(0.25));
  assert.strictEqual(nfl.our_quote_american, americanFromProb(0.20));
}

{
  const mlb = priceUnhedgedCombo({ venue: 'kalshi', legs: mlbLegs, getYesProb: lookup });
  assert.strictEqual(mlb.fairYes, 0.25);
  assert.strictEqual(mlb.quoteYes, 0.19);
  assert.strictEqual(mlb.feeRate, 0.035);
  assert.strictEqual(mlb.our_fair_american, americanFromProb(0.25));
  assert.strictEqual(mlb.our_quote_american, americanFromProb(0.19));
  const nfl = priceUnhedgedCombo({ venue: 'kalshi', legs: nflLegs, getYesProb: lookup });
  assert.ok(mlb.our_quote_american > nfl.our_quote_american, 'MLB fee makes a worse (longer) YES quote');
}

{
  const poly = priceUnhedgedCombo({
    venue: 'polymarket',
    legs: [
      { league: 'mlb', symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'yes' },
      { league: 'mlb', symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'yes' },
    ],
    getYesProb: lookup,
  });
  assert.strictEqual(poly.feeRate, -0.0125);
  assert.strictEqual(poly.quoteYes, 0.20);
  assert.strictEqual(poly.our_quote_american, americanFromProb(0.20));
}

{
  const noSide = priceUnhedgedCombo({
    venue: 'kalshi',
    legs: [
      { league: 'mlb', ticker: 'KXMLBGAME-A-CWS', side: 'no' },
      { league: 'mlb', ticker: 'KXMLBGAME-B-PIT', side: 'yes' },
    ],
    getYesProb: () => 0.6,
  });
  assert.ok(Math.abs(noSide.fairYes - (0.4 * 0.6)) < 1e-12);
}

{
  const missing = priceUnhedgedCombo({
    venue: 'kalshi',
    legs: mlbLegs,
    getYesProb: (_v, key) => (key === 'KXMLBGAME-A-CWS' ? 0.5 : null),
  });
  assert.strictEqual(missing.our_fair_american, null);
  assert.strictEqual(missing.our_quote_american, null);
}

{
  const noLookup = priceUnhedgedCombo({ venue: 'kalshi', legs: mlbLegs });
  assert.strictEqual(noLookup.our_fair_american, null);
  assert.strictEqual(noLookup.our_quote_american, null);
}

console.log('unhedged-quote.test.js ok');
