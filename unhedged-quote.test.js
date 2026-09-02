'use strict';
const assert = require('assert');
const { americanFromProb } = require('./engine');
const {
  KALSHI_COMBO_MAKER,
  KALSHI_NFL_MAKER,
  POLY_MAKER_REBATE,
  DEFAULT_QUOTE_MULT,
  isUnhedgedRfqLive,
  makerFee,
  isKalshiNflOnly,
  kalshiMakerRate,
  venueMakerRate,
  netCostFromFair,
  quoteYesFromFair,
  ceil2,
  priceUnhedgedCombo,
} = require('./unhedged-quote');

assert.strictEqual(isUnhedgedRfqLive({}), false);
assert.strictEqual(isUnhedgedRfqLive({ UNHEDGED_RFQ_LIVE: '' }), false);
assert.strictEqual(isUnhedgedRfqLive({ UNHEDGED_RFQ_LIVE: 'false' }), false);
assert.strictEqual(isUnhedgedRfqLive({ UNHEDGED_RFQ_LIVE: 'true' }), true);
assert.strictEqual(DEFAULT_QUOTE_MULT, 1.05);
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
const ncaafLegs = [
  { league: 'ncaaf', ticker: 'KXNCAAFGAME-A-OSU', side: 'yes' },
  { league: 'ncaaf', ticker: 'KXNCAAFGAME-B-TEX', side: 'yes' },
];
const mixedLegs = [
  { league: 'nfl', ticker: 'KXNFLGAME-A-KC', side: 'yes' },
  { league: 'mlb', ticker: 'KXMLBGAME-B-PIT', side: 'yes' },
];

assert.strictEqual(isKalshiNflOnly(nflLegs), true);
assert.strictEqual(isKalshiNflOnly(mlbLegs), false);
assert.strictEqual(isKalshiNflOnly(ncaafLegs), false);
assert.strictEqual(isKalshiNflOnly(mixedLegs), false);
assert.strictEqual(kalshiMakerRate(nflLegs), 0);
assert.strictEqual(kalshiMakerRate(mlbLegs), 0.035);
assert.strictEqual(kalshiMakerRate(ncaafLegs), 0.035);
assert.strictEqual(kalshiMakerRate(mixedLegs), 0.035);
assert.strictEqual(venueMakerRate('polymarket', mlbLegs), -0.0125);

// Kevin: fair 0.10, MLB, fee 0.035*0.1*0.9=0.00315, net=0.10315,
// quote YES=0.1083 → 0.11 after penny grid.
const kevinFair = 0.10;
const kevinFee = 0.035 * 0.1 * 0.9;
assert.ok(Math.abs(kevinFee - 0.00315) < 1e-12);
assert.ok(Math.abs(netCostFromFair(kevinFair, 0.035) - 0.10315) < 1e-12);
assert.ok(Math.abs(1.05 * 0.10315 - 0.1083075) < 1e-12);
assert.strictEqual(ceil2(0.1083), 0.11);
assert.strictEqual(quoteYesFromFair(kevinFair, { feeRate: 0.035 }), 0.11);

assert.strictEqual(makerFee(kevinFair, 0), 0);
assert.strictEqual(quoteYesFromFair(kevinFair, { feeRate: 0 }), 0.11);
assert.ok(netCostFromFair(kevinFair, 0) < netCostFromFair(kevinFair, 0.035));

const polyNet = kevinFair - 0.0125 * 0.1 * 0.9;
assert.ok(Math.abs(netCostFromFair(kevinFair, -0.0125) - polyNet) < 1e-12);
assert.ok(polyNet < kevinFair);
assert.strictEqual(quoteYesFromFair(kevinFair, { feeRate: -0.0125 }), 0.11);

// 2-leg even money: fair = 0.25
const fair = 0.25;
assert.strictEqual(makerFee(fair, 0), 0);
assert.strictEqual(makerFee(fair, 0.035), 0.035 * 0.25 * 0.75);
assert.strictEqual(makerFee(fair, -0.0125), -0.0125 * 0.25 * 0.75);

const nflQuoteYes = quoteYesFromFair(fair, { feeRate: 0 });
const mlbQuoteYes = quoteYesFromFair(fair, { feeRate: 0.035 });
const polyQuoteYes = quoteYesFromFair(fair, { feeRate: -0.0125 });
assert.strictEqual(nflQuoteYes, 0.27);
assert.strictEqual(mlbQuoteYes, 0.27);
assert.strictEqual(polyQuoteYes, 0.27);
assert.ok(netCostFromFair(fair, 0.035) > netCostFromFair(fair, 0));
assert.ok(netCostFromFair(fair, -0.0125) < netCostFromFair(fair, 0));

const prices = {
  'KXNFLGAME-A-KC': 0.5,
  'KXNFLGAME-B-BUF': 0.5,
  'KXMLBGAME-A-CWS': 0.5,
  'KXMLBGAME-B-PIT': 0.5,
  'KXNCAAFGAME-A-OSU': 0.4,
  'KXNCAAFGAME-B-TEX': 0.25,
  'aec-mlb-cws-det-2026-08-14-cws': 0.5,
  'aec-mlb-bos-pit-2026-08-14-pit': 0.5,
};

function lookup(_venue, key) {
  return prices[key] != null ? prices[key] : null;
}

{
  const nfl = priceUnhedgedCombo({ venue: 'kalshi', legs: nflLegs, getYesProb: lookup });
  assert.strictEqual(nfl.fairYes, 0.25);
  assert.strictEqual(nfl.quoteYes, 0.27);
  assert.strictEqual(nfl.feeRate, 0);
  assert.strictEqual(nfl.netCost, 0.25);
  assert.strictEqual(nfl.our_fair_american, americanFromProb(0.25));
  assert.strictEqual(nfl.our_quote_american, americanFromProb(0.27));
}

{
  const mlb = priceUnhedgedCombo({ venue: 'kalshi', legs: mlbLegs, getYesProb: lookup });
  assert.strictEqual(mlb.fairYes, 0.25);
  assert.strictEqual(mlb.quoteYes, 0.27);
  assert.strictEqual(mlb.feeRate, 0.035);
  assert.ok(mlb.netCost > 0.25);
  assert.strictEqual(mlb.our_fair_american, americanFromProb(0.25));
  assert.strictEqual(mlb.our_quote_american, americanFromProb(0.27));
}

{
  const ncaaf = priceUnhedgedCombo({ venue: 'kalshi', legs: ncaafLegs, getYesProb: lookup });
  assert.strictEqual(ncaaf.feeRate, 0.035);
  assert.ok(Math.abs(ncaaf.fairYes - 0.1) < 1e-12);
  assert.strictEqual(ncaaf.quoteYes, 0.11);
}

{
  const mixed = priceUnhedgedCombo({ venue: 'kalshi', legs: mixedLegs, getYesProb: lookup });
  assert.strictEqual(mixed.feeRate, 0.035);
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
  assert.ok(poly.netCost < 0.25);
  assert.strictEqual(poly.quoteYes, 0.27);
  assert.strictEqual(poly.our_quote_american, americanFromProb(0.27));
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
