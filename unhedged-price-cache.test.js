'use strict';
const assert = require('assert');
const {
  createUnhedgedPriceCache,
  kalshiYesProb,
  pmYesProb,
  isPmFullGameMl,
} = require('./unhedged-price-cache');
const { classifyUnhedgedRfq } = require('./unhedged-rfq');
const { normalizeRfq } = require('./rfq');
const {
  applyTakerFeeToProb,
  ourTrueFromOpponentYes,
  KALSHI_TAKER_THETA,
  POLY_TAKER_THETA,
} = require('./unhedged-quote');

assert.strictEqual(kalshiYesProb({
  yes_bid_dollars: '0.40',
  yes_ask_dollars: '0.50',
}), 0.45);
assert.strictEqual(kalshiYesProb({ last_price: 55 }), 0.55);
assert.strictEqual(kalshiYesProb({ last_price_dollars: '0.62' }), 0.62);
assert.strictEqual(kalshiYesProb({}), null);

assert.ok(isPmFullGameMl({ slug: 'aec-mlb-cws-det-2026-08-14-cws' }, 'aec-mlb-cws-det-2026-08-14-cws'));
assert.ok(!isPmFullGameMl({
  slug: 'asc-mlb-cws-det-2026-08-14-cws',
  sportsMarketType: 'SPORTS_MARKET_TYPE_SPREAD',
}, 'asc-mlb-cws-det-2026-08-14-cws'));

assert.strictEqual(pmYesProb({
  bestBidQuote: { value: '0.41', currency: 'USD' },
  bestAskQuote: { value: '0.43', currency: 'USD' },
}), 0.42);
assert.strictEqual(pmYesProb({
  marketSides: [{ long: true, price: '0.61' }],
}), 0.61);
assert.strictEqual(pmYesProb({ outcomePrices: '["0.33","0.67"]' }), 0.33);

const cache = createUnhedgedPriceCache({
  seed: {
    kalshi: { 'KXMLBGAME-26AUG141840CWSDET-CWS': 0.55 },
    polymarket: { 'aec-mlb-cws-det-2026-08-14-cws': 0.55 },
  },
});
assert.strictEqual(cache.getYesProb('kalshi', 'KXMLBGAME-26AUG141840CWSDET-CWS'), 0.55);
assert.strictEqual(cache.getYesProb('kalshi', 'KXMLBGAME-26AUG141840CWSDET-CWS:yes'), 0.55);
assert.strictEqual(cache.getYesProb('polymarket', 'aec-mlb-cws-det-2026-08-14-cws'), 0.55);
assert.strictEqual(cache.getYesProb('kalshi', 'KXMLBGAME-MISSING'), null);
assert.strictEqual(cache.getOurTrue({
  ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS',
  league: 'mlb',
  selection: 'cws',
  teams: ['cws', 'det'],
  date: '2026-08-14',
}), null, 'same-side last is not fair when opponent is missing');

cache.ingestKalshiMarkets([
  { ticker: 'KXNFLGAME-26SEP071330BUFKC-KC', yes_bid_dollars: '0.48', yes_ask_dollars: '0.52' },
  { ticker: 'KXNBAGAME-26JAN01NYKBOS-NYK', yes_bid_dollars: '0.60', yes_ask_dollars: '0.62' },
]);
assert.strictEqual(cache.getYesProb('kalshi', 'KXNFLGAME-26SEP071330BUFKC-KC'), 0.50);
assert.strictEqual(cache.getYesProb('kalshi', 'KXNBAGAME-26JAN01NYKBOS-NYK'), null, 'non-ML series ignored');

let kalshiCalls = 0;
let pmCalls = 0;
const live = createUnhedgedPriceCache({
  intervalMs: 60 * 60 * 1000,
  fetchKalshiMarkets: async (series) => {
    kalshiCalls += 1;
    if (series === 'KXMLBGAME') {
      return { markets: [{ ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS', last_price_dollars: '0.58' }] };
    }
    if (series === 'KXNFLGAME') {
      return { markets: [{ ticker: 'KXNFLGAME-26SEP071330BUFKC-KC', last_price_dollars: '0.61' }] };
    }
    return { markets: [] };
  },
  fetchPmMarket: async (slug) => {
    pmCalls += 1;
    return {
      slug,
      bestBidQuote: { value: '0.44', currency: 'USD' },
      bestAskQuote: { value: '0.46', currency: 'USD' },
    };
  },
});
live.watch('polymarket', [{ symbol: 'aec-mlb-cws-det-2026-08-14-cws' }]);

return live.refresh().then(async () => {
  assert.ok(kalshiCalls >= 3, 'one GET per Kalshi ML series');
  assert.strictEqual(pmCalls, 2, 'watch RFQ slug + derived opponent aec-*');
  assert.strictEqual(live.getYesProb('kalshi', 'KXMLBGAME-26AUG141840CWSDET-CWS'), 0.58);
  assert.strictEqual(live.getYesProb('kalshi', 'KXNFLGAME-26SEP071330BUFKC-KC'), 0.61);
  assert.strictEqual(live.getYesProb('polymarket', 'aec-mlb-cws-det-2026-08-14-cws'), 0.45);

  const before = { kalshiCalls, pmCalls };
  const rfq = normalizeRfq({
    type: 'rfq_created',
    msg: {
      id: 'rfq-no-http',
      contracts_fp: '10.00',
      mve_collection_ticker: 'KXMVE-X',
      mve_selected_legs: [
        { side: 'yes', market_ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS' },
        { side: 'yes', market_ticker: 'KXMLBGAME-26AUG141840BOSPIT-PIT' },
      ],
    },
  });
  classifyUnhedgedRfq(rfq, {
    venue: 'kalshi',
    priceCache: live,
    now: Date.parse('2026-08-14T20:00:00Z'),
  });
  assert.strictEqual(kalshiCalls, before.kalshiCalls, 'classify must not HTTP');
  assert.strictEqual(pmCalls, before.pmCalls, 'classify must not HTTP');

  live.stop();

  // Inverse on a two-way: WSH ourTrue = 1 − fee-adjusted ATL, not WSH last.
  const wshCache = createUnhedgedPriceCache({
    seed: {
      kalshi: {
        'KXMLBGAME-26AUG141840WSHATL-WSH': 0.60,
        'KXMLBGAME-26AUG141840WSHATL-ATL': 0.42,
      },
    },
  });
  const wshLeg = {
    ticker: 'KXMLBGAME-26AUG141840WSHATL-WSH',
    league: 'mlb',
    selection: 'wsh',
    teams: ['wsh', 'atl'],
    date: '2026-08-14',
    side: 'yes',
  };
  const wshOur = wshCache.getOurTrue(wshLeg);
  const expectWsh = ourTrueFromOpponentYes(0.42, KALSHI_TAKER_THETA);
  assert.ok(Math.abs(wshOur - expectWsh) < 1e-12);
  assert.ok(Math.abs(wshOur - 0.60) > 1e-6);
  assert.strictEqual(wshCache.getYesProb('kalshi', 'KXMLBGAME-26AUG141840WSHATL-WSH'), 0.60);

  // Best-of-two venues: cheaper opponent YES after taker fee.
  const bothVenues = createUnhedgedPriceCache({
    seed: {
      kalshi: {
        'KXMLBGAME-26AUG141840WSHATL-WSH': 0.60,
        'KXMLBGAME-26AUG141840WSHATL-ATL': 0.50,
      },
      polymarket: {
        'aec-mlb-wsh-atl-2026-08-14-wsh': 0.59,
        'aec-mlb-wsh-atl-2026-08-14-atl': 0.40,
      },
    },
  });
  const cheapOur = bothVenues.getOurTrue(wshLeg);
  const polyEff = applyTakerFeeToProb(0.40, POLY_TAKER_THETA);
  const kalshiEff = applyTakerFeeToProb(0.50, KALSHI_TAKER_THETA);
  assert.ok(polyEff < kalshiEff);
  assert.ok(Math.abs(cheapOur - (1 - polyEff)) < 1e-12);

  const kalshiCheaper = createUnhedgedPriceCache({
    seed: {
      kalshi: {
        'KXMLBGAME-26AUG141840WSHATL-WSH': 0.60,
        'KXMLBGAME-26AUG141840WSHATL-ATL': 0.35,
      },
      polymarket: {
        'aec-mlb-wsh-atl-2026-08-14-atl': 0.40,
      },
    },
  });
  const kOur = kalshiCheaper.getOurTrue(wshLeg);
  assert.ok(Math.abs(kOur - ourTrueFromOpponentYes(0.35, KALSHI_TAKER_THETA)) < 1e-12);

  // Ingest by event_ticker pairs the other Kalshi ticker.
  const eventCache = createUnhedgedPriceCache();
  eventCache.ingestKalshiMarkets([
    {
      ticker: 'KXMLBGAME-26AUG141840WSHATL-WSH',
      event_ticker: 'KXMLBGAME-26AUG141840WSHATL',
      last_price_dollars: '0.60',
    },
    {
      ticker: 'KXMLBGAME-26AUG141840WSHATL-ATL',
      event_ticker: 'KXMLBGAME-26AUG141840WSHATL',
      last_price_dollars: '0.42',
    },
  ]);
  assert.ok(Math.abs(eventCache.getOurTrue(wshLeg) - expectWsh) < 1e-12);

  console.log('unhedged-price-cache.test.js ok');
}).catch((e) => {
  live.stop();
  console.error(e);
  process.exit(1);
});
