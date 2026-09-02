'use strict';
const assert = require('assert');
const {
  KALSHI_COMBO_MAKER,
  POLY_MAKER_REBATE,
  DEFAULT_CUSHION,
  yesCushion,
  makerFeeCoeff,
  fairYesProb,
  wouldQuoteYesProb,
  polyNetYes,
  quoteUnhedged,
  yesProbFromKalshiMarket,
  yesProbFromPmMarket,
  createUnhedgedPriceCache,
} = require('./unhedged-price-cache');

assert.strictEqual(KALSHI_COMBO_MAKER, 0.035);
assert.strictEqual(POLY_MAKER_REBATE, 0.0125);
assert.strictEqual(DEFAULT_CUSHION, 0.05);
assert.strictEqual(yesCushion({}), 0.05);
assert.strictEqual(yesCushion({ UNHEDGED_YES_CUSHION: '0.03' }), 0.03);

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

// NFL 0 fee vs MLB 0.035: same fair, MLB posts a higher YES so net keeps the cushion.
{
  const fairP = 0.16;
  const cushion = 0.05;
  const nfl = wouldQuoteYesProb(fairP, { venue: 'kalshi', legs: nflLegs, cushion });
  const mlb = wouldQuoteYesProb(fairP, { venue: 'kalshi', legs: mlbLegs, cushion });
  assert.strictEqual(nfl, 0.11);
  assert.ok(mlb > nfl, 'MLB bakes 0.035 so posted YES > NFL');
  const mlbNet = mlb - 0.035 * mlb * (1 - mlb);
  assert.ok(Math.abs(mlbNet - 0.11) < 1e-12, 'MLB net after 0.035 still has the 5¢ cushion');
}

// Poly rebate path: no maker fee charged; rebate can slightly improve net.
{
  const fairP = 0.16;
  const poly = wouldQuoteYesProb(fairP, { venue: 'polymarket', legs: pmLegs, cushion: 0.05 });
  assert.strictEqual(poly, 0.11);
  assert.strictEqual(poly, wouldQuoteYesProb(fairP, { venue: 'kalshi', legs: nflLegs, cushion: 0.05 }));
  const net = polyNetYes(poly);
  assert.ok(net > poly, 'rebate improves net vs posted YES');
  assert.ok(net < fairP, 'still not quoting fair');
}

// Missing / invalid leg price → no fair (do not invent).
assert.strictEqual(fairYesProb([0.4, null], ['yes', 'yes']), null);
assert.strictEqual(quoteUnhedged('kalshi', mlbLegs, [0.4, null], ['yes', 'yes']).fairAmerican, null);

{
  const priced = quoteUnhedged('kalshi', nflLegs, [0.4, 0.4], ['yes', 'yes'], { UNHEDGED_YES_CUSHION: '0.05' });
  assert.ok(priced.fairAmerican != null);
  assert.ok(priced.quoteAmerican != null);
  assert.ok(priced.quoteAmerican > priced.fairAmerican, 'would-quote is longer than fair');
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
    const net = polyNetYes(pm.quoteP);
    assert.ok(net > pm.quoteP);

    console.log('unhedged-price-cache.test.js ok');
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
