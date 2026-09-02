'use strict';
const assert = require('assert');
const { americanFromProb } = require('./engine');
const {
  KALSHI_COMBO_MAKER,
  KALSHI_NFL_MAKER,
  POLY_MAKER_RATE,
  DEFAULT_QUOTE_MULT,
  KALSHI_TAKER_THETA,
  POLY_TAKER_THETA,
  isUnhedgedRfqLive,
  makerFee,
  isKalshiNflOnly,
  kalshiMakerRate,
  venueMakerRate,
  netCostFromFair,
  quoteYesFromFair,
  ceil2,
  priceUnhedgedCombo,
  applyTakerFeeToProb,
  feeIncludedAmerican,
  invertAmerican,
  bestOpponentAmerican,
  ourTrueFromOpponentYes,
  ourTrueFromOpponents,
  ourTrueProb,
  trueProb,
} = require('./unhedged-quote');

assert.strictEqual(isUnhedgedRfqLive({}), false);
assert.strictEqual(isUnhedgedRfqLive({ UNHEDGED_RFQ_LIVE: '' }), false);
assert.strictEqual(isUnhedgedRfqLive({ UNHEDGED_RFQ_LIVE: 'false' }), false);
assert.strictEqual(isUnhedgedRfqLive({ UNHEDGED_RFQ_LIVE: 'true' }), true);
assert.strictEqual(DEFAULT_QUOTE_MULT, 1.05);
assert.strictEqual(KALSHI_NFL_MAKER, 0);
assert.strictEqual(KALSHI_COMBO_MAKER, 0.035);
assert.strictEqual(POLY_MAKER_RATE, 0);
assert.strictEqual(KALSHI_TAKER_THETA, 0.07);
assert.strictEqual(POLY_TAKER_THETA, 0.05);

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
assert.strictEqual(venueMakerRate('polymarket', mlbLegs), 0);
assert.strictEqual(venueMakerRate('polymarket', nflLegs), 0);

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

assert.strictEqual(netCostFromFair(kevinFair, 0), kevinFair);
assert.strictEqual(quoteYesFromFair(kevinFair, { feeRate: 0 }), 0.11);

// 2-leg even money: fair = 0.25
const fair = 0.25;
assert.strictEqual(makerFee(fair, 0), 0);
assert.strictEqual(makerFee(fair, 0.035), 0.035 * 0.25 * 0.75);
const nflQuoteYes = quoteYesFromFair(fair, { feeRate: 0 });
const mlbQuoteYes = quoteYesFromFair(fair, { feeRate: 0.035 });
const polyQuoteYes = quoteYesFromFair(fair, { feeRate: 0 });
assert.strictEqual(nflQuoteYes, 0.27);
assert.strictEqual(mlbQuoteYes, 0.27);
assert.strictEqual(polyQuoteYes, 0.27);
assert.ok(netCostFromFair(fair, 0.035) > netCostFromFair(fair, 0));
assert.strictEqual(netCostFromFair(fair, 0), fair);

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
  assert.strictEqual(poly.feeRate, 0);
  assert.strictEqual(poly.netCost, poly.fairYes);
  assert.strictEqual(poly.netCost, 0.25);
  assert.ok(poly.netCost !== 0.25 - (0.0125 * 0.25 * 0.75), 'rebate must not lower net_cost');
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

// Kevin: opponent +118 → our -118 (not -114). Opponent -140 → our +140.
{
  assert.strictEqual(invertAmerican(118), -118);
  assert.notStrictEqual(invertAmerican(118), -114);
  assert.strictEqual(invertAmerican(-140), 140);
  assert.strictEqual(americanFromProb(ourTrueProb(118)), -118);
  assert.notStrictEqual(americanFromProb(ourTrueProb(118)), -114);
  assert.strictEqual(americanFromProb(ourTrueProb(-140)), 140);
  const fromPlus = ourTrueFromOpponents([{ american: 118 }]);
  const fromMinus = ourTrueFromOpponents([{ american: -140 }]);
  assert.strictEqual(americanFromProb(fromPlus), -118);
  assert.notStrictEqual(americanFromProb(fromPlus), -114);
  assert.strictEqual(americanFromProb(fromMinus), 140);
}

// Best-of-two already-fee-included Americans: more plus / less minus, then flip.
{
  assert.strictEqual(bestOpponentAmerican([{ american: 118 }, { american: -140 }]), 118);
  assert.strictEqual(invertAmerican(118), -118);
  assert.strictEqual(
    americanFromProb(ourTrueFromOpponents([{ american: 118 }, { american: -140 }])),
    -118
  );
  assert.strictEqual(bestOpponentAmerican([{ american: 150 }, { american: 118 }]), 150);
  assert.strictEqual(invertAmerican(150), -150);
  assert.strictEqual(bestOpponentAmerican([{ american: -110 }, { american: -140 }]), -110);
  assert.strictEqual(invertAmerican(-110), 110);
}

// Kevin: fee-included Mariners +118 (Kalshi) vs Poly Mariners +105 — pick +118, invert to Sox -118.
// Same-side Sox last is not an opponent quote and must not win the pick.
{
  const marinersKalshi = { venue: 'kalshi', american: 118 };
  const marinersPoly = { venue: 'polymarket', american: 105 };
  const soxLast = { venue: 'kalshi', american: -150 };
  assert.strictEqual(bestOpponentAmerican([marinersKalshi, marinersPoly]), 118);
  const soxTrue = ourTrueFromOpponents([marinersKalshi, marinersPoly]);
  assert.strictEqual(americanFromProb(soxTrue), -118);
  assert.notStrictEqual(americanFromProb(soxTrue), -114);
  assert.notStrictEqual(americanFromProb(soxTrue), invertAmerican(soxLast.american));
  assert.strictEqual(invertAmerican(bestOpponentAmerican([marinersKalshi])), -118);
}

// Inverse: WSH fair = sign-flip of fee-included ATL American, not WSH last.
{
  const atl = 0.42;
  const wshLast = 0.60;
  const atlEff = applyTakerFeeToProb(atl, KALSHI_TAKER_THETA);
  assert.ok(Math.abs(atlEff - (0.42 * (1 + 0.07 * 0.58))) < 1e-12);
  const atlAm = feeIncludedAmerican(atl, KALSHI_TAKER_THETA);
  assert.strictEqual(atlAm, americanFromProb(atlEff));
  const wshOur = ourTrueFromOpponentYes(atl, KALSHI_TAKER_THETA);
  assert.ok(Math.abs(wshOur - ourTrueProb(atlAm)) < 1e-12);
  assert.strictEqual(americanFromProb(wshOur), invertAmerican(atlAm));
  assert.ok(Math.abs(wshOur - (1 - wshLast)) > 1e-6, 'must not use 1-WSH last');
  assert.ok(Math.abs(wshOur - wshLast) > 1e-6, 'must not use WSH last as fair');
  assert.ok(trueProb(-150) > 0.59 && trueProb(-150) < 0.61);
}

// Best-of-two venues: cheaper/better opponent American (more plus), then flip.
{
  const kalshiAtl = 0.50;
  const polyAtl = 0.40;
  const kalshiAm = feeIncludedAmerican(kalshiAtl, KALSHI_TAKER_THETA);
  const polyAm = feeIncludedAmerican(polyAtl, POLY_TAKER_THETA);
  assert.ok(polyAm > kalshiAm, 'poly 0.40 after 5% is a better opponent American than kalshi 0.50 after 7%');
  const our = ourTrueFromOpponents([
    { venue: 'kalshi', yesProb: kalshiAtl },
    { venue: 'polymarket', yesProb: polyAtl },
  ]);
  assert.strictEqual(bestOpponentAmerican([
    { venue: 'kalshi', yesProb: kalshiAtl },
    { venue: 'polymarket', yesProb: polyAtl },
  ]), polyAm);
  assert.ok(Math.abs(our - ourTrueProb(polyAm)) < 1e-12);
  assert.strictEqual(americanFromProb(our), invertAmerican(polyAm));
  assert.ok(Math.abs(our - ourTrueProb(kalshiAm)) > 1e-6);
}

{
  const kalshiAtl = 0.35;
  const polyAtl = 0.40;
  const kalshiAm = feeIncludedAmerican(kalshiAtl, KALSHI_TAKER_THETA);
  const polyAm = feeIncludedAmerican(polyAtl, POLY_TAKER_THETA);
  assert.ok(kalshiAm > polyAm);
  const our = ourTrueFromOpponents([
    { venue: 'kalshi', yesProb: kalshiAtl },
    { venue: 'polymarket', yesProb: polyAtl },
  ]);
  assert.ok(Math.abs(our - ourTrueProb(kalshiAm)) < 1e-12);
  assert.strictEqual(americanFromProb(our), invertAmerican(kalshiAm));
}

{
  const wshOur = ourTrueFromOpponentYes(0.42, KALSHI_TAKER_THETA);
  const cwsOur = ourTrueFromOpponentYes(0.50, KALSHI_TAKER_THETA);
  const inverse = priceUnhedgedCombo({
    venue: 'kalshi',
    legs: [
      { league: 'mlb', ticker: 'KXMLBGAME-WSHATL-WSH', side: 'yes' },
      { league: 'mlb', ticker: 'KXMLBGAME-CWSDET-CWS', side: 'yes' },
    ],
    getOurTrue: (leg) => (String(leg.ticker).includes('WSH') ? wshOur : cwsOur),
  });
  const fair = wshOur * cwsOur;
  assert.ok(Math.abs(inverse.fairYes - fair) < 1e-12);
  assert.strictEqual(inverse.feeRate, 0.035);
  assert.ok(inverse.netCost > inverse.fairYes);

  const nflInv = priceUnhedgedCombo({
    venue: 'kalshi',
    legs: nflLegs,
    getOurTrue: () => 0.5,
  });
  assert.strictEqual(nflInv.feeRate, 0);
  assert.strictEqual(nflInv.netCost, 0.25);

  const polyInv = priceUnhedgedCombo({
    venue: 'polymarket',
    legs: [
      { league: 'mlb', symbol: 'aec-mlb-wsh-atl-2026-08-14-wsh', side: 'yes' },
      { league: 'mlb', symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'yes' },
    ],
    getOurTrue: () => 0.5,
  });
  assert.strictEqual(polyInv.netCost, polyInv.fairYes);
  assert.ok(polyInv.netCost !== 0.25 - (0.0125 * 0.25 * 0.75));

  const noSideInv = priceUnhedgedCombo({
    venue: 'kalshi',
    legs: [
      { league: 'mlb', ticker: 'KXMLBGAME-WSHATL-WSH', side: 'no' },
      { league: 'mlb', ticker: 'KXMLBGAME-CWSDET-CWS', side: 'yes' },
    ],
    getOurTrue: (leg) => (String(leg.ticker).includes('WSH') ? wshOur : cwsOur),
  });
  assert.ok(Math.abs(noSideInv.fairYes - ((1 - wshOur) * cwsOur)) < 1e-12);
}

{
  const missingOpp = priceUnhedgedCombo({
    venue: 'kalshi',
    legs: mlbLegs,
    getOurTrue: () => null,
  });
  assert.strictEqual(missingOpp.our_fair_american, null);
  assert.strictEqual(missingOpp.our_quote_american, null);
}

console.log('unhedged-quote.test.js ok');
