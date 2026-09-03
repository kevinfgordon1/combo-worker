'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createUnhedgedPriceCache,
  pickYesProb,
  pickYesAskProb,
  kalshiYesProb,
  pmYesProb,
  pmTeamYesProbs,
  isPmFullGameMl,
  isPmGameSlug,
  pmGameSlugOf,
  pmMlSlugsFromKalshiLeg,
  mapLimit,
  DEFAULT_PM_WATCH_GAMES,
  DEFAULT_PM_REFRESH_CONCURRENCY,
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
  KALSHI_TAKER_THETA,
  POLY_TAKER_THETA,
} = require('./unhedged-quote');
const { americanFromProb } = require('./engine');

// Mid helper still averages when both sides exist — opponent path must not.
assert.strictEqual(pickYesProb(0.38, 0.39), 0.385);
assert.strictEqual(pickYesProb(0.62, 0.63), 0.625);
assert.strictEqual(pickYesAskProb(0.38, 0.39), 0.39);
assert.strictEqual(pickYesAskProb(0.62, 0.63), 0.63);
assert.strictEqual(pickYesAskProb(0.38, null, 0.40), 0.38, 'ask missing → bid');
assert.strictEqual(pickYesAskProb(null, null, 0.55), 0.55, 'ask+bid missing → last');
assert.notStrictEqual(pickYesAskProb(0.38, 0.39), pickYesProb(0.38, 0.39));

assert.strictEqual(kalshiYesProb({
  yes_bid_dollars: '0.40',
  yes_ask_dollars: '0.50',
}), 0.50, 'opponent ingest uses ask, not mid 0.45');
assert.strictEqual(kalshiYesProb({
  yes_bid_dollars: '0.38',
  yes_ask_dollars: '0.39',
}), 0.39);
assert.strictEqual(kalshiYesProb({
  yes_bid_dollars: '0.62',
  yes_ask_dollars: '0.63',
}), 0.63);
assert.strictEqual(kalshiYesProb({ last_price: 55 }), 0.55);
assert.strictEqual(kalshiYesProb({ last_price_dollars: '0.62' }), 0.62);
assert.strictEqual(kalshiYesProb({ yes_bid_dollars: '0.38' }), 0.38);
assert.strictEqual(kalshiYesProb({}), null);

// Inverse of parsePmUnhedgedSlug: codes + both orders, never spoken names.
{
  const cws = pmMlSlugsFromKalshiLeg({ ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS' });
  assert.ok(cws.includes('aec-mlb-cws-det-2026-08-14'));
  assert.ok(cws.includes('aec-mlb-det-cws-2026-08-14'));
  assert.ok(!cws.includes('aec-mlb-cws-det-2026-08-14-cws'));
  assert.ok(!cws.includes('aec-mlb-cws-det-2026-08-14-det'));
  assert.ok(cws.every((s) => isPmGameSlug(s)));
  assert.ok(!cws.some((s) => /white.?sox|tigers|reds/i.test(s)));

  const wsh = pmMlSlugsFromKalshiLeg({ ticker: 'KXMLBGAME-26AUG141840WSHATL-WSH' });
  assert.ok(wsh.includes('aec-mlb-wsh-atl-2026-08-14'));
  assert.ok(!wsh.includes('aec-mlb-wsh-atl-2026-08-14-wsh'));
  assert.ok(!wsh.includes('aec-mlb-wsh-atl-2026-08-14-atl'));
  assert.ok(!wsh.some((s) => /nationals|braves/i.test(s)));

  const cin = pmMlSlugsFromKalshiLeg({ ticker: 'KXMLBGAME-26SEP021840CINCHC-CIN' });
  assert.ok(cin.includes('aec-mlb-cin-chc-2026-09-02'));
  assert.ok(cin.includes('aec-mlb-chc-cin-2026-09-02'));
  assert.ok(!cin.includes('aec-mlb-cin-chc-2026-09-02-cin'));
  assert.ok(!cin.includes('aec-mlb-cin-chc-2026-09-02-chc'));
  assert.ok(cin.every((s) => isPmGameSlug(s)));
  assert.ok(!cin.some((s) => /reds|cubs/i.test(s)));

  const nfl = pmMlSlugsFromKalshiLeg({ ticker: 'KXNFLGAME-26SEP071330BUFKC-KC' });
  assert.ok(nfl.includes('aec-nfl-buf-kc-2026-09-07'));
  assert.ok(nfl.includes('aec-nfl-kc-buf-2026-09-07'));
  assert.ok(!nfl.includes('aec-nfl-buf-kc-2026-09-07-kc'));
  assert.ok(!nfl.includes('aec-nfl-buf-kc-2026-09-07-buf'));
  assert.ok(nfl.every((s) => isPmGameSlug(s)));

  assert.deepStrictEqual(pmMlSlugsFromKalshiLeg({ symbol: 'aec-mlb-cws-det-2026-08-14-cws' }), []);
  assert.deepStrictEqual(pmMlSlugsFromKalshiLeg({ ticker: 'KXNCAAFGAME-26SEP12OSUTEX-OSU' }), []);
}

assert.ok(isPmFullGameMl({ slug: 'aec-mlb-cws-det-2026-08-14-cws' }, 'aec-mlb-cws-det-2026-08-14-cws'));
assert.ok(isPmFullGameMl({ slug: 'aec-mlb-bos-nyy-2026-08-30' }, 'aec-mlb-bos-nyy-2026-08-30'));
assert.ok(!isPmFullGameMl({
  slug: 'asc-mlb-cws-det-2026-08-14-cws',
  sportsMarketType: 'SPORTS_MARKET_TYPE_SPREAD',
}, 'asc-mlb-cws-det-2026-08-14-cws'));

assert.ok(isPmGameSlug('aec-mlb-cin-chc-2026-09-02'));
assert.ok(isPmGameSlug('aec-mlb-bos-nyy-2026-08-30'));
assert.ok(!isPmGameSlug('aec-mlb-cin-chc-2026-09-02-cin'));
assert.strictEqual(pmGameSlugOf('aec-mlb-cin-chc-2026-09-02-cin'), 'aec-mlb-cin-chc-2026-09-02');
assert.strictEqual(pmGameSlugOf('aec-mlb-cin-chc-2026-09-02'), 'aec-mlb-cin-chc-2026-09-02');

function twoOutcomeGame(slug, longTeam, shortTeam, longYes, shortYes, date = '2026-09-02', league = 'mlb') {
  return {
    slug,
    metadata: {
      market_sport_type: league === 'nfl' ? 'football_team_full_game_winner' : 'baseball_team_full_game_winner',
      event_start_time: `${date}T22:40:00Z`,
      long_participant_id: `${league}-${longTeam}`,
      short_participant_id: `${league}-${shortTeam}`,
    },
    marketSides: [
      { long: true, team: { abbreviation: longTeam, league }, price: String(longYes) },
      { long: false, team: { abbreviation: shortTeam, league }, price: String(shortYes) },
    ],
    outcomePrices: JSON.stringify([String(longYes), String(shortYes)]),
  };
}

assert.strictEqual(pmYesProb({
  bestBidQuote: { value: '0.41', currency: 'USD' },
  bestAskQuote: { value: '0.43', currency: 'USD' },
}), 0.43, 'Poly opponent YES uses ask, not mid 0.42');
assert.strictEqual(pmYesProb({
  marketSides: [{ long: true, price: '0.61' }],
}), 0.61);
assert.strictEqual(pmYesProb({ outcomePrices: '["0.33","0.67"]' }), 0.33);

{
  const two = pmTeamYesProbs({
    slug: 'aec-mlb-cin-chc-2026-09-02',
    metadata: {
      market_sport_type: 'baseball_team_full_game_winner',
      event_start_time: '2026-09-02T22:40:00Z',
      long_participant_id: 'mlb-cin',
      short_participant_id: 'mlb-chc',
    },
    marketSides: [
      { long: true, team: { abbreviation: 'CIN', league: 'mlb' }, price: '0.46' },
      { long: false, team: { abbreviation: 'CHC', league: 'mlb' }, price: '0.53' },
    ],
    outcomePrices: '["0.46","0.53"]',
  }, 'aec-mlb-cin-chc-2026-09-02');
  assert.ok(two && two.length >= 2);
  const cinYes = two.find((r) => r.team === 'cin');
  const chcYes = two.find((r) => r.team === 'chc');
  assert.strictEqual(cinYes.yesProb, 0.46);
  assert.strictEqual(chcYes.yesProb, 0.53);
  assert.ok(Math.abs((cinYes.yesProb + chcYes.yesProb) - 1) > 1e-9, 'must not invent 1-p');

  const viaOutcomes = pmTeamYesProbs({
    slug: 'aec-mlb-cin-chc-2026-09-02',
    metadata: {
      market_sport_type: 'baseball_team_full_game_winner',
      event_start_time: '2026-09-02T22:40:00Z',
      long_participant_id: 'mlb-cin',
      short_participant_id: 'mlb-chc',
    },
    outcomePrices: '["0.46","0.53"]',
  }, 'aec-mlb-cin-chc-2026-09-02');
  assert.strictEqual(viaOutcomes.find((r) => r.team === 'cin').yesProb, 0.46);
  assert.strictEqual(viaOutcomes.find((r) => r.team === 'chc').yesProb, 0.53);
}

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
assert.strictEqual(cache.getYesProb('kalshi', 'KXNFLGAME-26SEP071330BUFKC-KC'), 0.52);
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
    if (slug === 'aec-mlb-cws-det-2026-08-14') {
      return twoOutcomeGame(slug, 'cws', 'det', 0.45, 0.52, '2026-08-14');
    }
    return null;
  },
});
live.watch('polymarket', [{ symbol: 'aec-mlb-cws-det-2026-08-14-cws' }]);

return live.refresh().then(async () => {
  assert.ok(kalshiCalls >= 2, 'one GET per in-scope Kalshi ML series (MLB/NFL)');
  assert.strictEqual(pmCalls, 1, 'one game slug, not RFQ + opponent + game');
  assert.ok(live._pmWatch.has('aec-mlb-cws-det-2026-08-14'));
  assert.ok(!live._pmWatch.has('aec-mlb-cws-det-2026-08-14-cws'));
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

  // Kevin 2026-09-03: KXNFLGAME-26SEP09NESEA — opponent ASK, not mid.
  // Live book: NE YES 0.38/0.39, SEA YES 0.62/0.63. NFL θ=0.07.
  // SEA ask → −183; NE ask → +146. Mid would be −179 / +149.
  {
    const neSea = createUnhedgedPriceCache();
    neSea.ingestKalshiMarkets([
      {
        ticker: 'KXNFLGAME-26SEP09NESEA-NE',
        event_ticker: 'KXNFLGAME-26SEP09NESEA',
        yes_bid_dollars: '0.38',
        yes_ask_dollars: '0.39',
      },
      {
        ticker: 'KXNFLGAME-26SEP09NESEA-SEA',
        event_ticker: 'KXNFLGAME-26SEP09NESEA',
        yes_bid_dollars: '0.62',
        yes_ask_dollars: '0.63',
      },
    ]);
    assert.strictEqual(neSea.getYesProb('kalshi', 'KXNFLGAME-26SEP09NESEA-NE'), 0.39);
    assert.strictEqual(neSea.getYesProb('kalshi', 'KXNFLGAME-26SEP09NESEA-SEA'), 0.63);
    assert.notStrictEqual(neSea.getYesProb('kalshi', 'KXNFLGAME-26SEP09NESEA-NE'), 0.385);
    assert.notStrictEqual(neSea.getYesProb('kalshi', 'KXNFLGAME-26SEP09NESEA-SEA'), 0.625);

    const neLeg = {
      ticker: 'KXNFLGAME-26SEP09NESEA-NE',
      league: 'nfl',
      selection: 'ne',
      teams: ['ne', 'sea'],
      date: '2026-09-09',
      side: 'yes',
    };
    const seaLeg = {
      ticker: 'KXNFLGAME-26SEP09NESEA-SEA',
      league: 'nfl',
      selection: 'sea',
      teams: ['ne', 'sea'],
      date: '2026-09-09',
      side: 'yes',
    };
    const neQuotes = neSea.opponentQuotes(neLeg);
    const seaQuotes = neSea.opponentQuotes(seaLeg);
    assert.ok(neQuotes.some((q) => q.venue === 'kalshi' && q.yesProb === 0.63 && q.theta === 0.07));
    assert.ok(seaQuotes.some((q) => q.venue === 'kalshi' && q.yesProb === 0.39 && q.theta === 0.07));
    assert.ok(!neQuotes.some((q) => q.yesProb === 0.625 || q.yesProb === 0.385));
    assert.ok(!seaQuotes.some((q) => q.yesProb === 0.625 || q.yesProb === 0.385));

    const neOdds = annotateLegOdds(neLeg, neQuotes);
    const seaOdds = annotateLegOdds(seaLeg, seaQuotes);
    const neAskAm = feeIncludedAmerican(0.39, KALSHI_TAKER_THETA);
    const seaAskAm = feeIncludedAmerican(0.63, KALSHI_TAKER_THETA);
    const neMidAm = feeIncludedAmerican(0.385, KALSHI_TAKER_THETA);
    const seaMidAm = feeIncludedAmerican(0.625, KALSHI_TAKER_THETA);
    assert.strictEqual(seaAskAm, -183);
    assert.strictEqual(neAskAm, 146);
    assert.strictEqual(neOdds.kalshi_opponent_american, -183);
    assert.strictEqual(seaOdds.kalshi_opponent_american, 146);
    assert.notStrictEqual(neOdds.kalshi_opponent_american, seaMidAm);
    assert.notStrictEqual(seaOdds.kalshi_opponent_american, neMidAm);
    assert.strictEqual(neOdds.fair_american, invertAmerican(neOdds.kalshi_opponent_american));
    assert.strictEqual(seaOdds.fair_american, invertAmerican(seaOdds.kalshi_opponent_american));
    neSea.stop();
  }

  // Poly opponent YES is also the ask (not mid), same NE/SEA book.
  {
    const polyNeSea = createUnhedgedPriceCache();
    const polyGame = {
      slug: 'aec-nfl-ne-sea-2026-09-09',
      metadata: {
        market_sport_type: 'football_team_full_game_winner',
        event_start_time: '2026-09-09T00:15:00Z',
        long_participant_id: 'nfl-ne',
        short_participant_id: 'nfl-sea',
      },
      marketSides: [
        {
          long: true,
          team: { abbreviation: 'NE', league: 'nfl' },
          bestBid: '0.38',
          bestAsk: '0.39',
          price: '0.385',
        },
        {
          long: false,
          team: { abbreviation: 'SEA', league: 'nfl' },
          bestBid: '0.62',
          bestAsk: '0.63',
          price: '0.625',
        },
      ],
      outcomePrices: '["0.385","0.625"]',
    };
    const teamRows = pmTeamYesProbs(polyGame, 'aec-nfl-ne-sea-2026-09-09');
    assert.strictEqual(teamRows.find((r) => r.team === 'ne').yesProb, 0.39);
    assert.strictEqual(teamRows.find((r) => r.team === 'sea').yesProb, 0.63);
    assert.ok(polyNeSea.ingestPmMarket('aec-nfl-ne-sea-2026-09-09', polyGame));
    assert.strictEqual(polyNeSea.getYesProb('polymarket', 'aec-nfl-ne-sea-2026-09-09-ne'), 0.39);
    assert.strictEqual(polyNeSea.getYesProb('polymarket', 'aec-nfl-ne-sea-2026-09-09-sea'), 0.63);

    const neLeg = {
      symbol: 'aec-nfl-ne-sea-2026-09-09-ne',
      league: 'nfl',
      selection: 'ne',
      teams: ['ne', 'sea'],
      date: '2026-09-09',
      side: 'yes',
    };
    const seaLeg = {
      symbol: 'aec-nfl-ne-sea-2026-09-09-sea',
      league: 'nfl',
      selection: 'sea',
      teams: ['ne', 'sea'],
      date: '2026-09-09',
      side: 'yes',
    };
    const neOdds = annotateLegOdds(neLeg, polyNeSea.opponentQuotes(neLeg));
    const seaOdds = annotateLegOdds(seaLeg, polyNeSea.opponentQuotes(seaLeg));
    const seaAskAm = feeIncludedAmerican(0.63, POLY_TAKER_THETA);
    const neAskAm = feeIncludedAmerican(0.39, POLY_TAKER_THETA);
    const seaMidAm = feeIncludedAmerican(0.625, POLY_TAKER_THETA);
    const neMidAm = feeIncludedAmerican(0.385, POLY_TAKER_THETA);
    assert.strictEqual(neOdds.poly_opponent_american, seaAskAm);
    assert.strictEqual(seaOdds.poly_opponent_american, neAskAm);
    assert.notStrictEqual(neOdds.poly_opponent_american, seaMidAm);
    assert.notStrictEqual(seaOdds.poly_opponent_american, neMidAm);
    polyNeSea.stop();
  }

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
  const servedGame = {
    'aec-mlb-cws-det-2026-08-14': { long: 'cws', short: 'det', longYes: 0.55, shortYes: 0.48 },
    'aec-mlb-bos-pit-2026-08-14': { long: 'bos', short: 'pit', longYes: 0.50, shortYes: 0.62 },
  };

  // Kalshi-only 2-leg MLB: watch synthesizes game slugs; refresh fills Poly.
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
      const hit = servedGame[slug];
      return hit
        ? twoOutcomeGame(slug, hit.long, hit.short, hit.longYes, hit.shortYes, '2026-08-14')
        : null;
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

  // Poly-only RFQ watches the game slug of each symbol (not pick + opp + game).
  let polyOnlyCalls = 0;
  const polyOnly = createUnhedgedPriceCache({
    intervalMs: 60 * 60 * 1000,
    fetchPmMarket: async (slug) => {
      polyOnlyCalls += 1;
      if (slug === 'aec-mlb-cws-det-2026-08-14') {
        return twoOutcomeGame(slug, 'cws', 'det', 0.50, 0.50, '2026-08-14');
      }
      if (slug === 'aec-mlb-bos-pit-2026-08-14') {
        return twoOutcomeGame(slug, 'bos', 'pit', 0.50, 0.50, '2026-08-14');
      }
      return null;
    },
  });
  polyOnly.watch('polymarket', [
    { symbol: 'aec-mlb-cws-det-2026-08-14-cws' },
    { symbol: 'aec-mlb-bos-pit-2026-08-14-pit' },
  ]);
  await polyOnly.refresh();
  assert.strictEqual(polyOnlyCalls, 2, 'one game slug per Poly RFQ symbol');
  assert.ok(!polyOnly._pmWatch.has('aec-mlb-cws-det-2026-08-14-cws'));
  assert.ok(!polyOnly._pmWatch.has('aec-mlb-cws-det-2026-08-14-det'));
  assert.ok(polyOnly._pmWatch.has('aec-mlb-cws-det-2026-08-14'));
  assert.ok(!polyOnly._pmWatch.has('aec-mlb-bos-pit-2026-08-14-pit'));
  assert.ok(!polyOnly._pmWatch.has('aec-mlb-bos-pit-2026-08-14-bos'));
  assert.ok(polyOnly._pmWatch.has('aec-mlb-bos-pit-2026-08-14'));
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
  assert.ok(cinWatch.includes('aec-mlb-cin-chc-2026-09-02'));
  assert.ok(cinWatch.includes('aec-mlb-chc-cin-2026-09-02'));
  assert.ok(!cinWatch.includes('aec-mlb-cin-chc-2026-09-02-cin'));
  assert.ok(!cinWatch.includes('aec-mlb-chc-cin-2026-09-02-cin'));
  assert.ok(cinWatch.every((s) => isPmGameSlug(s)));
  assert.ok(!cinWatch.some((s) => /reds|cubs/i.test(s)));
  cinCache.stop();

  const cinKalshiLeg = {
    ticker: 'KXMLBGAME-26SEP021840CINCHC-CIN',
    league: 'mlb',
    selection: 'cin',
    teams: ['cin', 'chc'],
    date: '2026-09-02',
    side: 'yes',
  };

  // Suffixed 404 + production game slug hit → per-team YES, Poly opponent set.
  const gameFetched = [];
  const gameHit = createUnhedgedPriceCache({
    intervalMs: 60 * 60 * 1000,
    seed: {
      kalshi: {
        'KXMLBGAME-26SEP021840CINCHC-CIN': 0.47,
        'KXMLBGAME-26SEP021840CINCHC-CHC': 0.51,
      },
    },
    fetchPmMarket: async (slug) => {
      gameFetched.push(slug);
      if (slug === 'aec-mlb-cin-chc-2026-09-02') {
        return twoOutcomeGame(slug, 'cin', 'chc', 0.46, 0.53);
      }
      return null;
    },
  });
  gameHit.watch('kalshi', [{ ticker: 'KXMLBGAME-26SEP021840CINCHC-CIN', side: 'yes' }]);
  assert.ok(gameHit._pmWatch.has('aec-mlb-cin-chc-2026-09-02'));
  assert.ok(gameHit._pmWatch.has('aec-mlb-chc-cin-2026-09-02'));
  const gameRefresh = await gameHit.refresh();
  assert.ok(gameRefresh.pmMiss > 0);
  assert.ok(gameFetched.includes('aec-mlb-cin-chc-2026-09-02'));
  assert.ok(!gameFetched.some((s) => s.endsWith('-cin')), 'does not probe suffixed pick slugs');
  const gameQuotes = gameHit.opponentQuotes(cinKalshiLeg);
  assert.ok(gameQuotes.some((q) => q.venue === 'polymarket' && q.yesProb === 0.53 && q.theta === POLY_TAKER_THETA));
  assert.ok(!gameQuotes.some((q) => q.venue === 'polymarket' && q.yesProb === 0.46), 'CIN last is not opponent');
  const gameOdds = annotateLegOdds(cinKalshiLeg, gameQuotes);
  assert.strictEqual(gameOdds.poly_opponent_american, feeIncludedAmerican(0.53, POLY_TAKER_THETA));
  assert.strictEqual(gameOdds.kalshi_opponent_american, feeIncludedAmerican(0.51, KALSHI_MLB_TAKER_THETA));
  const pricedGame = classifyUnhedgedRfq(normalizeRfq({
    type: 'rfq_created',
    msg: {
      id: 'rfq-cin-game-slug',
      contracts_fp: '10.00',
      mve_collection_ticker: 'KXMVE-X',
      mve_selected_legs: [
        { side: 'yes', market_ticker: 'KXMLBGAME-26SEP021840CINCHC-CIN' },
        { side: 'yes', market_ticker: 'KXMLBGAME-26SEP021840ATLPHI-ATL' },
      ],
    },
  }), {
    venue: 'kalshi',
    priceCache: gameHit,
    now: Date.parse('2026-09-02T20:00:00Z'),
  });
  const cinRow = pricedGame.legs && pricedGame.legs.find((l) => /CIN$/i.test(l.ticker));
  assert.ok(cinRow);
  assert.strictEqual(cinRow.poly_opponent_american, gameOdds.poly_opponent_american);
  gameHit.stop();

  // Total miss stays null (no invent).
  const allMiss = createUnhedgedPriceCache({
    intervalMs: 60 * 60 * 1000,
    seed: {
      kalshi: {
        'KXMLBGAME-26SEP021840CINCHC-CIN': 0.47,
        'KXMLBGAME-26SEP021840CINCHC-CHC': 0.51,
      },
    },
    fetchPmMarket: async () => null,
  });
  allMiss.watch('kalshi', [{ ticker: 'KXMLBGAME-26SEP021840CINCHC-CIN', side: 'yes' }]);
  const missRefresh = await allMiss.refresh();
  assert.ok(missRefresh.pmMiss > 0);
  const missOdds = annotateLegOdds(cinKalshiLeg, allMiss.opponentQuotes(cinKalshiLeg));
  assert.strictEqual(missOdds.poly_opponent_american, null);
  assert.strictEqual(missOdds.kalshi_opponent_american, feeIncludedAmerican(0.51, KALSHI_MLB_TAKER_THETA));
  allMiss.stop();

  // Combo Locks quote / skip-tape / reserve files stay unwired from this cache.
  {
    const comboFiles = ['engine.js', 'skip-tape.js', 'reserve.js', 'quote-watcher.js'];
    for (const f of comboFiles) {
      const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
      assert.ok(!src.includes('pmWatch'), `${f} must not touch pmWatch`);
      assert.ok(!src.includes('createUnhedgedPriceCache'), `${f} must not import the price cache`);
      assert.ok(!src.includes('UNHEDGED_PM_WATCH'), `${f} must stay Combo Locks-only`);
    }
    assert.ok(DEFAULT_PM_WATCH_GAMES >= 32 && DEFAULT_PM_WATCH_GAMES <= 64);
    assert.strictEqual(DEFAULT_PM_REFRESH_CONCURRENCY, 4);
  }

  function mlbTicker(i) {
    const a = `A${String(i).padStart(2, '0')}`;
    const b = `B${String(i).padStart(2, '0')}`;
    return `KXMLBGAME-26SEP021840${a}${b}-${a}`;
  }
  function mlbGameSlugs(i) {
    const a = `a${String(i).padStart(2, '0')}`;
    const b = `b${String(i).padStart(2, '0')}`;
    return [`aec-mlb-${a}-${b}-2026-09-02`, `aec-mlb-${b}-${a}-2026-09-02`];
  }

  // Watch list never exceeds the game cap; extra Kalshi RFQs evict the oldest.
  {
    const cap = 8;
    const lru = createUnhedgedPriceCache({
      intervalMs: 60 * 60 * 1000,
      maxPmWatchGames: cap,
    });
    for (let i = 0; i < 20; i += 1) {
      lru.watch('kalshi', [{ ticker: mlbTicker(i), side: 'yes' }]);
      assert.ok(lru._pmWatchGames.size <= cap, `game count ${lru._pmWatchGames.size} exceeded cap ${cap}`);
      assert.ok(lru._pmWatch.size <= cap * 4, 'slug list stays bounded to game slugs');
      assert.ok([...lru._pmWatch].every((s) => isPmGameSlug(s)));
    }
    assert.strictEqual(lru._pmWatchGames.size, cap);
    for (const s of mlbGameSlugs(0)) {
      assert.ok(!lru._pmWatch.has(s), `oldest game 0 should be evicted (${s})`);
    }
    const latest = mlbGameSlugs(19);
    assert.ok(latest.some((s) => lru._pmWatch.has(s)), 'newest Kalshi RFQ stays watched');
    for (const s of mlbGameSlugs(11)) {
      assert.ok(!lru._pmWatch.has(s), 'game 11 is among the evicted oldest');
    }
    const kept = mlbGameSlugs(12);
    assert.ok(kept.some((s) => lru._pmWatch.has(s)), 'oldest remaining game 12 stays');

    // Re-watch an older remaining game, then add one more — the untouched oldest goes.
    lru.watch('kalshi', [{ ticker: mlbTicker(16), side: 'yes' }]);
    lru.watch('kalshi', [{ ticker: mlbTicker(20), side: 'yes' }]);
    assert.strictEqual(lru._pmWatchGames.size, cap);
    assert.ok(mlbGameSlugs(16).some((s) => lru._pmWatch.has(s)), 'touched game 16 survives');
    assert.ok(mlbGameSlugs(20).some((s) => lru._pmWatch.has(s)), 'new game 20 is watched');
    lru.stop();
  }

  // refreshPm concurrency is bounded — never Promise.all the whole list.
  {
    let inflight = 0;
    let maxInflight = 0;
    const conc = 4;
    const pool = createUnhedgedPriceCache({
      intervalMs: 60 * 60 * 1000,
      maxPmWatchGames: 16,
      pmRefreshConcurrency: conc,
      fetchPmMarket: async () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 15));
        inflight -= 1;
        return null;
      },
    });
    for (let i = 0; i < 12; i += 1) {
      pool.watch('kalshi', [{ ticker: mlbTicker(i), side: 'yes' }]);
    }
    assert.ok(pool._pmWatch.size > conc, 'enough slugs to saturate the pool');
    await pool.refresh();
    assert.ok(maxInflight <= conc, `inflight ${maxInflight} exceeded ${conc}`);
    assert.ok(maxInflight >= 2, 'pool actually overlapped fetches');
    pool.stop();
  }

  {
    let inflight = 0;
    let maxInflight = 0;
    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight -= 1;
    });
    assert.ok(maxInflight <= 3);
    assert.strictEqual(maxInflight, 3);
  }

  // Stale kalshi / polymarket rows older than N minutes are evicted.
  {
    let t = 1_000_000;
    const stale = createUnhedgedPriceCache({
      intervalMs: 60 * 60 * 1000,
      staleMs: 60_000,
      now: () => t,
      seed: {
        kalshi: { 'KXMLBGAME-26AUG141840CWSDET-CWS': 0.55 },
        polymarket: { 'aec-mlb-cws-det-2026-08-14-cws': 0.55 },
      },
    });
    assert.strictEqual(stale.getYesProb('kalshi', 'KXMLBGAME-26AUG141840CWSDET-CWS'), 0.55);
    assert.strictEqual(stale.getYesProb('polymarket', 'aec-mlb-cws-det-2026-08-14-cws'), 0.55);
    t += 120_000;
    await stale.refresh();
    assert.strictEqual(stale.getYesProb('kalshi', 'KXMLBGAME-26AUG141840CWSDET-CWS'), null);
    assert.strictEqual(stale.getYesProb('polymarket', 'aec-mlb-cws-det-2026-08-14-cws'), null);
    stale.stop();
  }

  console.log('unhedged-price-cache.test.js ok');
}).catch((e) => {
  live.stop();
  console.error(e);
  process.exit(1);
});
