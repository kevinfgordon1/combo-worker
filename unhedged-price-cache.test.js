'use strict';
const assert = require('assert');
const {
  KALSHI_COMBO_MAKER,
  YES_MARGIN,
  makerFeeCoeff,
  fairYesProb,
  netCostYes,
  wouldQuoteYesRaw,
  wouldQuoteYesProb,
  quoteUnhedged,
  yesProbFromKalshiMarket,
  yesProbFromPmMarket,
  createUnhedgedPriceCache,
} = require('./unhedged-price-cache');

assert.strictEqual(KALSHI_COMBO_MAKER, 0.035);
assert.strictEqual(YES_MARGIN, 1.05);

const nflLegs = [
  { league: 'nfl', ticker: 'KXNFLGAME-A-BUF', side: 'yes' },
  { league: 'nfl', ticker: 'KXNFLGAME-B-KC', side: 'yes' },
];
const mlbLegs = [
  { league: 'mlb', ticker: 'KXMLBGAME-A-CWS', side: 'yes' },
  { league: 'mlb', ticker: 'KXMLBGAME-B-PIT', side: 'yes' },
];
const mixedLegs = [
  { league: 'nfl', ticker: 'KXNFLGAME-A-BUF', side: 'yes' },
  { league: 'ncaaf', ticker: 'KXNCAAFGAME-A-OSU', side: 'yes' },
];
const pmLegs = [
  { league: 'mlb', symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'yes' },
  { league: 'mlb', symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'yes' },
];

assert.strictEqual(makerFeeCoeff('kalshi', nflLegs), 0);
assert.strictEqual(makerFeeCoeff('kalshi', mlbLegs), 0.035);
assert.strictEqual(makerFeeCoeff('kalshi', mixedLegs), 0.035);
assert.strictEqual(makerFeeCoeff('polymarket', pmLegs), 0);

// Independent product, NO side flips the YES price.
assert.strictEqual(fairYesProb([0.4, 0.5], ['yes', 'yes']), 0.2);
assert.ok(Math.abs(fairYesProb([0.7, 0.7], ['yes', 'no']) - 0.21) < 1e-12);

// MLB fair 0.10 → net ~0.10315 → raw ~0.108 → penny 0.11 (above fair).
{
  const fairP = 0.10;
  const net = netCostYes(fairP, 'kalshi', mlbLegs);
  assert.ok(Math.abs(net - 0.10315) < 1e-12);
  const raw = wouldQuoteYesRaw(fairP, { venue: 'kalshi', legs: mlbLegs });
  assert.ok(Math.abs(raw - 1.05 * 0.10315) < 1e-12);
  assert.ok(raw > fairP);
  assert.strictEqual(wouldQuoteYesProb(fairP, { venue: 'kalshi', legs: mlbLegs }), 0.11);
}

// NFL independent 0.10 → net 0.10 → 0.105 → 0.11. Same as Poly (maker cost 0).
{
  const fairP = 0.10;
  assert.strictEqual(netCostYes(fairP, 'kalshi', nflLegs), 0.10);
  assert.strictEqual(wouldQuoteYesRaw(fairP, { venue: 'kalshi', legs: nflLegs }), 0.105);
  assert.strictEqual(wouldQuoteYesProb(fairP, { venue: 'kalshi', legs: nflLegs }), 0.11);

  const polyRaw = wouldQuoteYesRaw(fairP, { venue: 'polymarket', legs: pmLegs });
  const nflRaw = wouldQuoteYesRaw(fairP, { venue: 'kalshi', legs: nflLegs });
  assert.strictEqual(polyRaw, nflRaw);
  assert.ok(polyRaw < 1.05 * 0.10315, 'Poly has no 0.035 and no rebate — same as NFL, below MLB raw');
  assert.strictEqual(wouldQuoteYesProb(fairP, { venue: 'polymarket', legs: pmLegs }), 0.11);
}

// Wrong sign is gone: quote YES is never fair minus a cushion.
{
  const fairP = 0.16;
  const mlb = wouldQuoteYesRaw(fairP, { venue: 'kalshi', legs: mlbLegs });
  const nfl = wouldQuoteYesRaw(fairP, { venue: 'kalshi', legs: nflLegs });
  const poly = wouldQuoteYesRaw(fairP, { venue: 'polymarket', legs: pmLegs });
  assert.ok(mlb > nfl);
  assert.strictEqual(poly, nfl);
  assert.ok(mlb > fairP && nfl > fairP && poly > fairP);
  assert.ok(nfl !== fairP - 0.05);
}

// Missing / invalid leg price → no fair (do not invent).
assert.strictEqual(fairYesProb([0.4, null], ['yes', 'yes']), null);
assert.strictEqual(quoteUnhedged('kalshi', mlbLegs, [0.4, null], ['yes', 'yes']).fairAmerican, null);

{
  const priced = quoteUnhedged('kalshi', nflLegs, [0.4, 0.4], ['yes', 'yes']);
  assert.ok(priced.fairAmerican != null);
  assert.ok(priced.quoteAmerican != null);
  assert.ok(priced.quoteP > priced.fairP, 'sell YES above fair');
  assert.ok(priced.quoteAmerican < priced.fairAmerican, 'worse American for the taker');
}

assert.strictEqual(yesProbFromKalshiMarket({
  yes_bid_dollars: '0.40',
  yes_ask_dollars: '0.44',
}), 0.42);
assert.strictEqual(yesProbFromKalshiMarket({ last_price: 55 }), 0.55);
assert.strictEqual(yesProbFromPmMarket({
  bestBid: { value: '0.30', currency: 'USD' },
  bestAsk: { value: '0.34', currency: 'USD' },
}), 0.32);

// Cache: sync lookup, no fetch on price(); missing leg → both null.
{
  let kalshiLists = 0;
  let pmFetches = 0;
  const cache = createUnhedgedPriceCache({
    listKalshiMarkets: async (series) => {
      kalshiLists += 1;
      if (series !== 'KXMLBGAME') return { markets: [] };
      return {
        markets: [
          { ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS', yes_bid_dollars: '0.40', yes_ask_dollars: '0.40' },
          { ticker: 'KXMLBGAME-26AUG141840BOSPIT-PIT', last_price_dollars: '0.50' },
          { ticker: 'KXMLBSPREAD-26AUG141840CWSDET-CWS', yes_bid_dollars: '0.99' },
        ],
      };
    },
    fetchPmMarket: async (slug) => {
      pmFetches += 1;
      if (slug === 'aec-mlb-cws-det-2026-08-14-cws') {
        return { lastTradePrice: 0.40 };
      }
      if (slug === 'aec-mlb-bos-pit-2026-08-14-pit') {
        return { lastTradePrice: 0.50 };
      }
      return null;
    },
  });

  const before = cache.price('kalshi', mlbLegs);
  assert.strictEqual(before.fairAmerican, null);
  assert.strictEqual(before.quoteAmerican, null);
  assert.strictEqual(kalshiLists, 0);
  assert.strictEqual(pmFetches, 0);

  return cache.refresh().then((n) => {
    assert.strictEqual(n.kalshi, 2);
    assert.ok(kalshiLists >= 3, 'lists each ML series');
    assert.strictEqual(pmFetches, 0);

    const hit = cache.price('kalshi', [
      { league: 'mlb', ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS', side: 'yes' },
      { league: 'mlb', ticker: 'KXMLBGAME-26AUG141840BOSPIT-PIT', side: 'yes' },
    ]);
    assert.ok(hit.fairAmerican != null);
    assert.ok(hit.quoteAmerican != null);
    assert.ok(hit.quoteP > hit.fairP);

    const miss = cache.price('kalshi', [
      { league: 'mlb', ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS', side: 'yes' },
      { league: 'mlb', ticker: 'KXMLBGAME-MISSING', side: 'yes' },
    ]);
    assert.strictEqual(miss.fairAmerican, null);
    assert.strictEqual(miss.quoteAmerican, null);

    cache.remember('polymarket', pmLegs);
    return cache.refresh();
  }).then(() => {
    assert.ok(pmFetches >= 2);
    const pm = cache.price('polymarket', pmLegs);
    assert.ok(pm.fairAmerican != null);
    assert.ok(pm.quoteAmerican != null);
    assert.ok(pm.quoteP > pm.fairP);
    assert.strictEqual(pm.quoteP, wouldQuoteYesProb(pm.fairP, { venue: 'polymarket', legs: pmLegs }));

    console.log('unhedged-price-cache.test.js ok');
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
