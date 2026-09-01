'use strict';
const assert = require('assert');
const {
  parseKalshiTicker,
  identitiesFromParlay,
  identityFromMarket,
  identitiesFromPolymarketLegs,
  identityKey,
  sameIdentitySet,
} = require('./leg-identity');
const { createMarketCache } = require('./polymarket-market-cache');

const FIRST_PITCH = '2026-08-14T22:40:00Z'; // 18:40 ET

const cwsMarket = {
  metadata: {
    event_id: 'mlb-cws-det-2026-08-14',
    event_start_time: FIRST_PITCH,
    event_subcategory: 'BASEBALL',
    market_sport_type: 'baseball_team_full_game_winner',
    outcome_strike: '0.0',
    long_participant_id: 'mlb-cws',
    short_participant_id: 'mlb-det',
  },
};
const pitMarket = {
  metadata: {
    event_id: 'mlb-bos-pit-2026-08-14',
    event_start_time: FIRST_PITCH,
    event_subcategory: 'BASEBALL',
    market_sport_type: 'baseball_team_full_game_winner',
    outcome_strike: '0.0',
    long_participant_id: 'mlb-pit',
    short_participant_id: 'mlb-bos',
  },
};
const spreadMarket = {
  metadata: {
    event_id: 'mlb-cws-det-2026-08-14',
    event_start_time: FIRST_PITCH,
    event_subcategory: 'BASEBALL',
    market_sport_type: 'baseball_team_full_game_spread',
    outcome_strike: '1.5',
    long_participant_id: 'mlb-cws',
    short_participant_id: 'mlb-det',
  },
};
const wrongDateMarket = {
  metadata: {
    ...cwsMarket.metadata,
    event_id: 'mlb-cws-det-2026-08-15',
    event_start_time: '2026-08-15T22:40:00Z',
  },
};
const detLongMarket = {
  metadata: {
    ...cwsMarket.metadata,
    long_participant_id: 'mlb-det',
    short_participant_id: 'mlb-cws',
  },
};

const cwsId = parseKalshiTicker('KXMLBGAME-26AUG141840CWSDET-CWS:yes');
assert.ok(cwsId);
assert.strictEqual(cwsId.league, 'mlb');
assert.strictEqual(cwsId.date, '2026-08-14');
assert.deepStrictEqual(cwsId.teams, ['cws', 'det']);
assert.strictEqual(cwsId.marketType, 'moneyline');
assert.strictEqual(cwsId.selection, 'cws');
assert.strictEqual(cwsId.side, 'yes');
assert.strictEqual(
  identityKey(cwsId),
  'mlb|2026-08-14|cws+det|moneyline|full|cws|yes'
);

const pitId = parseKalshiTicker('KXMLBGAME-26AUG141840BOSPIT-PIT:yes');
assert.strictEqual(pitId.selection, 'pit');
assert.deepStrictEqual(pitId.teams, ['bos', 'pit']);

assert.strictEqual(parseKalshiTicker('KXMVESPORTSMULTIGAMEEXTENDED-S2026FF'), null);
assert.strictEqual(parseKalshiTicker('KXMLBGAME-26AUG141840CWSDET-CWS:yes').side, 'yes');

const lock = identitiesFromParlay({
  leg_keys: [
    'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
    'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
  ],
});
assert.ok(lock.ok);
assert.strictEqual(lock.keys.length, 2);

const buyCws = identityFromMarket(cwsMarket, 'yes');
assert.ok(buyCws.identity);
assert.strictEqual(identityKey(buyCws.identity), identityKey(cwsId));

const sellCws = identityFromMarket(cwsMarket, 'no');
assert.ok(sellCws.identity);
assert.strictEqual(sellCws.identity.side, 'no');
assert.notStrictEqual(identityKey(sellCws.identity), identityKey(cwsId));

const retail = identityFromMarket({
  sportsMarketType: 'moneyline',
  sportsMarketTypeV2: 'SPORTS_MARKET_TYPE_MONEYLINE',
  gameStartTime: FIRST_PITCH,
  marketSides: [
    { long: true, team: { abbreviation: 'cws', league: 'mlb' } },
    { long: false, team: { abbreviation: 'det', league: 'mlb' } },
  ],
}, 'yes');
assert.ok(retail.identity);
assert.strictEqual(identityKey(retail.identity), identityKey(cwsId));

assert.strictEqual(identityFromMarket(spreadMarket, 'yes').reason, 'not_priceable');
assert.strictEqual(identityFromMarket(null, 'yes').reason, 'missing_metadata');
assert.strictEqual(identityFromMarket({}, 'yes').reason, 'missing_metadata');

const markets = new Map([
  ['aec-mlb-cws-det-2026-08-14-cws', cwsMarket],
  ['aec-mlb-bos-pit-2026-08-14-pit', pitMarket],
]);
const pmBuy = identitiesFromPolymarketLegs([
  { symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'SIDE_BUY' },
  { symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'SIDE_BUY' },
], markets);
assert.ok(pmBuy.ok);
assert.ok(sameIdentitySet(pmBuy.keys, lock.keys));

const pmSell = identitiesFromPolymarketLegs([
  { symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'SIDE_SELL' },
  { symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'SIDE_SELL' },
], markets);
assert.ok(pmSell.ok);
assert.ok(!sameIdentitySet(pmSell.keys, lock.keys));

const noMeta = identitiesFromPolymarketLegs([
  { symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'SIDE_BUY' },
  { symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'SIDE_BUY' },
], new Map());
assert.strictEqual(noMeta.ok, false);
assert.strictEqual(noMeta.reason, 'missing_metadata');

const wrongDate = identitiesFromPolymarketLegs([
  { symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'SIDE_BUY' },
  { symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'SIDE_BUY' },
], new Map([
  ['aec-mlb-cws-det-2026-08-14-cws', wrongDateMarket],
  ['aec-mlb-bos-pit-2026-08-14-pit', pitMarket],
]));
assert.ok(wrongDate.ok);
assert.ok(!sameIdentitySet(wrongDate.keys, lock.keys));

const wrongTeam = identitiesFromPolymarketLegs([
  { symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'SIDE_BUY' },
  { symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'SIDE_BUY' },
], new Map([
  ['aec-mlb-cws-det-2026-08-14-cws', detLongMarket],
  ['aec-mlb-bos-pit-2026-08-14-pit', pitMarket],
]));
assert.ok(wrongTeam.ok);
assert.ok(!sameIdentitySet(wrongTeam.keys, lock.keys));

const spreadLegs = identitiesFromPolymarketLegs([
  { symbol: 'asc-mlb-cws-det-2026-08-14-cws', side: 'SIDE_BUY' },
  { symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'SIDE_BUY' },
], new Map([
  ['asc-mlb-cws-det-2026-08-14-cws', spreadMarket],
  ['aec-mlb-bos-pit-2026-08-14-pit', pitMarket],
]));
assert.strictEqual(spreadLegs.ok, false);
assert.strictEqual(spreadLegs.reason, 'not_priceable');

let fetches = 0;
const cache = createMarketCache({
  fetchMarket: async (slug) => {
    fetches += 1;
    return markets.get(slug) || null;
  },
});

(async () => {
  assert.ok(await cache.get('aec-mlb-cws-det-2026-08-14-cws'));
  assert.ok(await cache.get('aec-mlb-cws-det-2026-08-14-cws'));
  assert.strictEqual(fetches, 1);
  console.log('leg-identity.test.js ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
