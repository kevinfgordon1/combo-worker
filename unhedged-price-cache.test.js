'use strict';
const assert = require('assert');
const {
  createUnhedgedPriceCache,
  kalshiYesProb,
  pmYesProb,
  isPmFullGameMl,
  pmMlSlugsFromKalshiLeg,
} = require('./unhedged-price-cache');
const { classifyUnhedgedRfq } = require('./unhedged-rfq');
const { normalizeRfq } = require('./rfq');
const {
  invertAmerican,
  feeIncludedAmerican,
  ourTrueFromOpponentYes,
  ourTrueProb,
  annotateLegOdds,
  KALSHI_MLB_TAKER_THETA,
  POLY_TAKER_THETA,
} = require('./unhedged-quote');
const { americanFromProb } = require('./engine');

assert.strictEqual(kalshiYesProb({
  yes_bid_dollars: '0.40',
  yes_ask_dollars: '0.50',
}), 0.45);
assert.strictEqual(kalshiYesProb({ last_price: 55 }), 0.55);
assert.strictEqual(kalshiYesProb({ last_price_dollars: '0.62' }), 0.62);
assert.strictEqual(kalshiYesProb({}), null);

// Inverse of parsePmUnhedgedSlug: codes + both orders, never spoken names.
{
  const cws = pmMlSlugsFromKalshiLeg({ ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS' });
  assert.ok(cws.includes('aec-mlb-cws-det-2026-08-14-cws'));
  assert.ok(cws.includes('aec-mlb-cws-det-2026-08-14-det'));
  assert.ok(cws.includes('aec-mlb-det-cws-2026-08-14-cws'));
  assert.ok(cws.includes('aec-mlb-det-cws-2026-08-14-det'));
  assert.ok(!cws.some((s) => /white.?sox|tigers|reds/i.test(s)));

  const wsh = pmMlSlugsFromKalshiLeg({ ticker: 'KXMLBGAME-26AUG141840WSHATL-WSH' });
  assert.ok(wsh.includes('aec-mlb-wsh-atl-2026-08-14-wsh'));
  assert.ok(wsh.includes('aec-mlb-wsh-atl-2026-08-14-atl'));
  assert.ok(!wsh.some((s) => /nationals|braves/i.test(s)));

  const cin = pmMlSlugsFromKalshiLeg({ ticker: 'KXMLBGAME-26SEP021840CINCHC-CIN' });
  assert.ok(cin.includes('aec-mlb-cin-chc-2026-09-02-cin'));
  assert.ok(cin.includes('aec-mlb-cin-chc-2026-09-02-chc'));
  assert.ok(cin.includes('aec-mlb-chc-cin-2026-09-02-cin'));
  assert.ok(cin.includes('aec-mlb-chc-cin-2026-09-02-chc'));
  assert.ok(!cin.some((s) => /reds|cubs/i.test(s)));

  const nfl = pmMlSlugsFromKalshiLeg({ ticker: 'KXNFLGAME-26SEP071330BUFKC-KC' });
  assert.ok(nfl.includes('aec-nfl-buf-kc-2026-09-07-kc'));
  assert.ok(nfl.includes('aec-nfl-buf-kc-2026-09-07-buf'));
  assert.ok(nfl.includes('aec-nfl-kc-buf-2026-09-07-kc'));

  assert.deepStrictEqual(pmMlSlugsFromKalshiLeg({ symbol: 'aec-mlb-cws-det-2026-08-14-cws' }), []);
  assert.deepStrictEqual(pmMlSlugsFromKalshiLeg({ ticker: 'KXNCAAFGAME-26SEP12OSUTEX-OSU' }), []);
}

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
  assert.ok(kalshiCalls >= 2, 'one GET per in-scope Kalshi ML series (MLB/NFL)');
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

  // Inverse on a two-way: WSH ourTrue = sign-flip of fee-included ATL, not WSH last.
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
  const expectWsh = ourTrueFromOpponentYes(0.42, KALSHI_MLB_TAKER_THETA);
  assert.ok(Math.abs(wshOur - expectWsh) < 1e-12);
  assert.ok(Math.abs(wshOur - 0.60) > 1e-6);
  assert.strictEqual(wshCache.getYesProb('kalshi', 'KXMLBGAME-26AUG141840WSHATL-WSH'), 0.60);

  // Best-of-two venues: cheaper/better opponent American after taker fee, then flip.
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
  const polyAm = feeIncludedAmerican(0.40, POLY_TAKER_THETA);
  const kalshiAm = feeIncludedAmerican(0.50, KALSHI_MLB_TAKER_THETA);
  assert.ok(polyAm > kalshiAm);
  assert.ok(Math.abs(cheapOur - ourTrueProb(polyAm)) < 1e-12);
  assert.strictEqual(americanFromProb(cheapOur), invertAmerican(polyAm));

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
  assert.ok(Math.abs(kOur - ourTrueFromOpponentYes(0.35, KALSHI_MLB_TAKER_THETA)) < 1e-12);

  // Kevin: 0.45 MLB Mariners → +118, invert Sox −118. NFL 0.45 uses 0.07 not 0.035.
  const soxLeg = {
    ticker: 'KXMLBGAME-26AUG141840BOSSEA-BOS',
    symbol: 'aec-mlb-bos-sea-2026-08-14-bos',
    league: 'mlb',
    selection: 'bos',
    teams: ['bos', 'sea'],
    date: '2026-08-14',
    side: 'yes',
  };
  const soxSea = createUnhedgedPriceCache({
    seed: {
      kalshi: {
        'KXMLBGAME-26AUG141840BOSSEA-BOS': 0.60,
        'KXMLBGAME-26AUG141840BOSSEA-SEA': 0.45,
      },
      polymarket: {
        'aec-mlb-bos-sea-2026-08-14-bos': 0.59,
        'aec-mlb-bos-sea-2026-08-14-sea': 0.50,
      },
    },
  });
  const seaKalshiAm = feeIncludedAmerican(0.45, KALSHI_MLB_TAKER_THETA);
  assert.strictEqual(seaKalshiAm, 118);
  assert.notStrictEqual(feeIncludedAmerican(0.45, 0.07), 118);
  const soxOur = soxSea.getOurTrue(soxLeg);
  assert.ok(Math.abs(soxOur - ourTrueProb(seaKalshiAm)) < 1e-12);
  assert.strictEqual(americanFromProb(soxOur), -118);
  assert.ok(Math.abs(soxOur - 0.60) > 1e-6, 'must not use same-side Sox last');
  const soxQuotes = soxSea.opponentQuotes(soxLeg);
  assert.ok(soxQuotes.every((q) => !/BOS$|-bos$/i.test(q.key)), 'opponent quotes exclude Sox last');
  assert.ok(soxQuotes.some((q) => q.venue === 'kalshi' && q.theta === 0.035));

  const nflOpp = createUnhedgedPriceCache({
    seed: {
      kalshi: {
        'KXNFLGAME-26SEP071330BUFKC-KC': 0.55,
        'KXNFLGAME-26SEP071330BUFKC-BUF': 0.45,
      },
    },
  });
  const kcOur = nflOpp.getOurTrue({
    ticker: 'KXNFLGAME-26SEP071330BUFKC-KC',
    league: 'nfl',
    selection: 'kc',
    teams: ['buf', 'kc'],
    date: '2026-09-07',
    side: 'yes',
  });
  assert.strictEqual(americanFromProb(kcOur), -114);
  assert.notStrictEqual(americanFromProb(kcOur), -118);

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

  function pmQuote(slug, yes) {
    return {
      slug,
      bestBidQuote: { value: String(yes - 0.01), currency: 'USD' },
      bestAskQuote: { value: String(yes + 0.01), currency: 'USD' },
    };
  }

  const kalshiTwoLeg = [
    { ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS', side: 'yes' },
    { ticker: 'KXMLBGAME-26AUG141840BOSPIT-PIT', side: 'yes' },
  ];
  const servedPm = {
    'aec-mlb-cws-det-2026-08-14-cws': 0.55,
    'aec-mlb-cws-det-2026-08-14-det': 0.48,
    'aec-mlb-bos-pit-2026-08-14-bos': 0.50,
    'aec-mlb-bos-pit-2026-08-14-pit': 0.62,
  };

  // Kalshi-only 2-leg MLB: watch synthesizes aec slugs; refresh fills Poly.
  const fetched = [];
  const cross = createUnhedgedPriceCache({
    intervalMs: 60 * 60 * 1000,
    seed: {
      kalshi: {
        'KXMLBGAME-26AUG141840CWSDET-CWS': 0.55,
        'KXMLBGAME-26AUG141840CWSDET-DET': 0.50,
        'KXMLBGAME-26AUG141840BOSPIT-PIT': 0.60,
        'KXMLBGAME-26AUG141840BOSPIT-BOS': 0.50,
      },
    },
    fetchPmMarket: async (slug) => {
      fetched.push(slug);
      const yes = servedPm[slug];
      return yes != null ? pmQuote(slug, yes) : null;
    },
  });
  cross.watch('kalshi', kalshiTwoLeg);
  const expectedWatch = [
    ...pmMlSlugsFromKalshiLeg(kalshiTwoLeg[0]),
    ...pmMlSlugsFromKalshiLeg(kalshiTwoLeg[1]),
  ];
  for (const s of expectedWatch) {
    assert.ok(cross._pmWatch.has(s), `watch list missing ${s}`);
  }
  await cross.refresh();
  assert.deepStrictEqual([...fetched].sort(), [...cross._pmWatch].sort());
  assert.ok(fetched.every((s) => s.startsWith('aec-mlb-')));
  assert.ok(!fetched.some((s) => /reds|sox|pirates|white/i.test(s)));

  const cwsKalshiLeg = {
    ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS',
    league: 'mlb',
    selection: 'cws',
    teams: ['cws', 'det'],
    date: '2026-08-14',
    side: 'yes',
  };
  const pitKalshiLeg = {
    ticker: 'KXMLBGAME-26AUG141840BOSPIT-PIT',
    league: 'mlb',
    selection: 'pit',
    teams: ['bos', 'pit'],
    date: '2026-08-14',
    side: 'yes',
  };
  const cwsQuotes = cross.opponentQuotes(cwsKalshiLeg);
  const pitQuotes = cross.opponentQuotes(pitKalshiLeg);
  assert.ok(cwsQuotes.some((q) => q.venue === 'kalshi'));
  assert.ok(cwsQuotes.some((q) => q.venue === 'polymarket' && q.key === 'aec-mlb-cws-det-2026-08-14-det'));
  assert.ok(pitQuotes.some((q) => q.venue === 'kalshi'));
  assert.ok(pitQuotes.some((q) => q.venue === 'polymarket' && q.key === 'aec-mlb-bos-pit-2026-08-14-bos'));

  const cwsOdds = annotateLegOdds(cwsKalshiLeg, cwsQuotes);
  const pitOdds = annotateLegOdds(pitKalshiLeg, pitQuotes);
  assert.strictEqual(cwsOdds.kalshi_opponent_american, feeIncludedAmerican(0.50, KALSHI_MLB_TAKER_THETA));
  assert.strictEqual(cwsOdds.poly_opponent_american, feeIncludedAmerican(0.48, POLY_TAKER_THETA));
  assert.strictEqual(pitOdds.kalshi_opponent_american, feeIncludedAmerican(0.50, KALSHI_MLB_TAKER_THETA));
  assert.strictEqual(pitOdds.poly_opponent_american, feeIncludedAmerican(0.50, POLY_TAKER_THETA));

  const priced = classifyUnhedgedRfq(normalizeRfq({
    type: 'rfq_created',
    msg: {
      id: 'rfq-kalshi-cross',
      contracts_fp: '10.00',
      mve_collection_ticker: 'KXMVE-X',
      mve_selected_legs: [
        { side: 'yes', market_ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS' },
        { side: 'yes', market_ticker: 'KXMLBGAME-26AUG141840BOSPIT-PIT' },
      ],
    },
  }), {
    venue: 'kalshi',
    priceCache: cross,
    now: Date.parse('2026-08-14T20:00:00Z'),
  });
  assert.strictEqual(priced.persist, true);
  const cwsRow = priced.legs.find((l) => /CWS$/i.test(l.ticker));
  const pitRow = priced.legs.find((l) => /PIT$/i.test(l.ticker));
  assert.ok(cwsRow && pitRow);
  assert.strictEqual(cwsRow.kalshi_opponent_american, cwsOdds.kalshi_opponent_american);
  assert.strictEqual(cwsRow.poly_opponent_american, cwsOdds.poly_opponent_american);
  assert.strictEqual(pitRow.kalshi_opponent_american, pitOdds.kalshi_opponent_american);
  assert.strictEqual(pitRow.poly_opponent_american, pitOdds.poly_opponent_american);
  cross.stop();

  // fetchPmMarket miss → Poly stays null, Kalshi still set (no invent).
  const missFetched = [];
  const miss = createUnhedgedPriceCache({
    intervalMs: 60 * 60 * 1000,
    seed: {
      kalshi: {
        'KXMLBGAME-26AUG141840CWSDET-CWS': 0.55,
        'KXMLBGAME-26AUG141840CWSDET-DET': 0.50,
        'KXMLBGAME-26AUG141840BOSPIT-PIT': 0.60,
        'KXMLBGAME-26AUG141840BOSPIT-BOS': 0.50,
      },
    },
    fetchPmMarket: async (slug) => {
      missFetched.push(slug);
      return null;
    },
  });
  miss.watch('kalshi', kalshiTwoLeg);
  await miss.refresh();
  assert.ok(missFetched.length > 0);
  assert.deepStrictEqual([...missFetched].sort(), [...miss._pmWatch].sort());
  const missCws = annotateLegOdds(cwsKalshiLeg, miss.opponentQuotes(cwsKalshiLeg));
  assert.strictEqual(missCws.kalshi_opponent_american, feeIncludedAmerican(0.50, KALSHI_MLB_TAKER_THETA));
  assert.strictEqual(missCws.poly_opponent_american, null);
  assert.strictEqual(miss.getYesProb('polymarket', 'aec-mlb-cws-det-2026-08-14-det'), null);
  miss.stop();

  // Poly-only RFQ still watches symbol + derived opponent (regression).
  let polyOnlyCalls = 0;
  const polyOnly = createUnhedgedPriceCache({
    intervalMs: 60 * 60 * 1000,
    fetchPmMarket: async (slug) => {
      polyOnlyCalls += 1;
      return pmQuote(slug, 0.50);
    },
  });
  polyOnly.watch('polymarket', [
    { symbol: 'aec-mlb-cws-det-2026-08-14-cws' },
    { symbol: 'aec-mlb-bos-pit-2026-08-14-pit' },
  ]);
  await polyOnly.refresh();
  assert.strictEqual(polyOnlyCalls, 4, 'each Poly slug + derived opponent');
  assert.ok(polyOnly._pmWatch.has('aec-mlb-cws-det-2026-08-14-cws'));
  assert.ok(polyOnly._pmWatch.has('aec-mlb-cws-det-2026-08-14-det'));
  assert.ok(polyOnly._pmWatch.has('aec-mlb-bos-pit-2026-08-14-pit'));
  assert.ok(polyOnly._pmWatch.has('aec-mlb-bos-pit-2026-08-14-bos'));
  const polyQuotes = polyOnly.opponentQuotes({
    symbol: 'aec-mlb-cws-det-2026-08-14-cws',
    league: 'mlb',
    selection: 'cws',
    teams: ['cws', 'det'],
    date: '2026-08-14',
    side: 'yes',
  });
  assert.ok(polyQuotes.some((q) => q.venue === 'polymarket'));
  assert.ok(!polyQuotes.some((q) => q.venue === 'kalshi'));
  polyOnly.stop();

  // CIN vs Reds: watch list is codes; fetchPmMarket is called with those slugs.
  const cinFetched = [];
  const cinCache = createUnhedgedPriceCache({
    intervalMs: 60 * 60 * 1000,
    fetchPmMarket: async (slug) => {
      cinFetched.push(slug);
      return slug.endsWith('-chc') ? pmQuote(slug, 0.44) : null;
    },
  });
  cinCache.watch('kalshi', [{ ticker: 'KXMLBGAME-26SEP021840CINCHC-CIN', side: 'yes' }]);
  await cinCache.refresh();
  const cinWatch = [...cinCache._pmWatch];
  assert.deepStrictEqual([...cinFetched].sort(), cinWatch.sort());
  assert.ok(cinWatch.includes('aec-mlb-cin-chc-2026-09-02-cin'));
  assert.ok(cinWatch.includes('aec-mlb-chc-cin-2026-09-02-cin'));
  assert.ok(!cinWatch.some((s) => /reds|cubs/i.test(s)));
  cinCache.stop();

  console.log('unhedged-price-cache.test.js ok');
}).catch((e) => {
  live.stop();
  console.error(e);
  process.exit(1);
});
