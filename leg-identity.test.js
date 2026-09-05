'use strict';
const assert = require('assert');
const {
  parseKalshiTicker,
  kalshiTickerPieces,
  identitiesFromParlay,
  identityFromMarket,
  identityFromPolymarketSlug,
  identitiesFromPolymarketSlugs,
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

// Raw ticker codes stay as-written (wsh, cin). Identity still aliases wsh→was.
const wshPieces = kalshiTickerPieces('KXMLBGAME-26AUG141840WSHATL-WSH:yes');
assert.ok(wshPieces);
assert.deepStrictEqual(wshPieces.teams, ['wsh', 'atl']);
assert.strictEqual(wshPieces.selection, 'wsh');
assert.strictEqual(wshPieces.date, '2026-08-14');
const wshId = parseKalshiTicker('KXMLBGAME-26AUG141840WSHATL-WSH:yes');
assert.strictEqual(wshId.selection, 'was');
assert.deepStrictEqual(wshId.teams, ['atl', 'was']);
const cinPieces = kalshiTickerPieces('KXMLBGAME-26SEP021840CINCHC-CIN:yes');
assert.deepStrictEqual(cinPieces.teams, ['cin', 'chc']);
assert.strictEqual(cinPieces.selection, 'cin');

// Athletics: Kalshi OAK (legacy) and ATH (current) are the same club as Poly ath.
const oakId = parseKalshiTicker('KXMLBGAME-26SEP031840OAKSEA-OAK:yes');
const athId = parseKalshiTicker('KXMLBGAME-26SEP031840ATHSEA-ATH:yes');
assert.ok(oakId);
assert.ok(athId);
assert.strictEqual(oakId.selection, 'ath');
assert.deepStrictEqual(oakId.teams, ['ath', 'sea']);
assert.strictEqual(athId.selection, 'ath');
assert.deepStrictEqual(athId.teams, ['ath', 'sea']);
assert.strictEqual(identityKey(oakId), identityKey(athId));
assert.strictEqual(
  identityKey(oakId),
  'mlb|2026-09-03|ath+sea|moneyline|full|ath|yes'
);
const oakPieces = kalshiTickerPieces('KXMLBGAME-26SEP031840OAKSEA-OAK:yes');
assert.deepStrictEqual(oakPieces.teams, ['oak', 'sea']);
assert.strictEqual(oakPieces.selection, 'oak');

const athMarket = {
  metadata: {
    event_id: 'mlb-ath-sea-2026-09-03',
    event_start_time: '2026-09-03T22:40:00Z',
    event_subcategory: 'BASEBALL',
    market_sport_type: 'baseball_team_full_game_winner',
    outcome_strike: '0.0',
    long_participant_id: 'mlb-ath',
    short_participant_id: 'mlb-sea',
  },
};
const buyAth = identityFromMarket(athMarket, 'yes');
assert.ok(buyAth.identity);
assert.strictEqual(identityKey(buyAth.identity), identityKey(oakId));
assert.ok(sameIdentitySet([identityKey(oakId)], [identityKey(buyAth.identity)]));

const oakLock = identitiesFromParlay({
  label: 'Athletics ML + Angels ML',
  leg_keys: [
    'KXMLBGAME-26SEP031840OAKSEA-OAK:yes',
    'KXMLBGAME-26SEP031840LAAPIT-LAA:yes',
  ],
});
const athLock = identitiesFromParlay({
  label: 'Athletics ML + Angels ML',
  leg_keys: [
    'KXMLBGAME-26SEP031840ATHSEA-ATH:yes',
    'KXMLBGAME-26SEP031840LAAPIT-LAA:yes',
  ],
});
assert.ok(oakLock.ok);
assert.ok(athLock.ok);
assert.ok(sameIdentitySet(oakLock.keys, athLock.keys));

// Length-5 / mixed 2-char Kalshi MLB blobs (TBTEX, SDCIN, …). teamLen=3
// even-split only accepts 6; greedy known-code split covers 2+3 / 3+2 / 2+2.
const mlbMixed = [
  ['KXMLBGAME-26SEP031840TBTEX-TEX:yes', ['tb', 'tex'], 'tex'],
  ['KXMLBGAME-26SEP031840SDCIN-SD:yes', ['sd', 'cin'], 'sd'],
  ['KXMLBGAME-26SEP031840SFPIT-SF:yes', ['sf', 'pit'], 'sf'],
  ['KXMLBGAME-26SEP031840KCCLE-KC:yes', ['kc', 'cle'], 'kc'],
  ['KXMLBGAME-26SEP031840PHIAZ-PHI:yes', ['phi', 'az'], 'phi'],
  ['KXMLBGAME-26SEP031840SDTB-SD:yes', ['sd', 'tb'], 'sd'],
];
for (const [ticker, teams, selection] of mlbMixed) {
  const pieces = kalshiTickerPieces(ticker);
  assert.ok(pieces, ticker);
  assert.deepStrictEqual(pieces.teams, teams, ticker);
  assert.strictEqual(pieces.selection, selection, ticker);
  const id = parseKalshiTicker(ticker);
  assert.ok(id, ticker);
  assert.deepStrictEqual(id.teams, teams.slice().sort(), ticker);
  assert.strictEqual(id.selection, selection, ticker);
}

const texLaaLock = identitiesFromParlay({
  label: 'Texas Rangers ML + Angels ML',
  leg_keys: [
    'KXMLBGAME-26SEP031840TBTEX-TEX:yes',
    'KXMLBGAME-26SEP031840LAAPIT-LAA:yes',
  ],
});
assert.ok(texLaaLock.ok);
assert.strictEqual(texLaaLock.keys.length, 2);
assert.ok(texLaaLock.keys.some((k) => k.includes('tb+tex') && k.endsWith('|tex|yes')));
assert.ok(texLaaLock.keys.some((k) => k.includes('laa+pit') && k.endsWith('|laa|yes')));

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
assert.strictEqual(sellCws.identity.side, 'yes');
assert.strictEqual(sellCws.identity.selection, 'det');
assert.notStrictEqual(identityKey(sellCws.identity), identityKey(cwsId));
assert.strictEqual(
  identityKey(sellCws.identity),
  'mlb|2026-08-14|cws+det|moneyline|full|det|yes'
);

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
assert.ok(noMeta.ok, 'game/pick slugs match Combo Locks without market HTTP');
assert.ok(sameIdentitySet(noMeta.keys, lock.keys));

const texYes = parseKalshiTicker('KXMLBGAME-26SEP031840TBTEX-TEX:yes');
const gameSellTex = identityFromPolymarketSlug('aec-mlb-tb-tex-2026-09-03', 'no');
assert.ok(gameSellTex);
assert.strictEqual(identityKey(gameSellTex), identityKey(texYes));
const gameBuyTb = identityFromPolymarketSlug('aec-mlb-tb-tex-2026-09-03', 'yes');
assert.strictEqual(gameBuyTb.selection, 'tb');
assert.notStrictEqual(identityKey(gameBuyTb), identityKey(texYes));

const tbTexMarket = {
  metadata: {
    event_id: 'mlb-tb-tex-2026-09-03',
    event_start_time: '2026-09-03T22:40:00Z',
    event_subcategory: 'BASEBALL',
    market_sport_type: 'baseball_team_full_game_winner',
    long_participant_id: 'mlb-tb',
    short_participant_id: 'mlb-tex',
  },
};
const metaSellTex = identityFromMarket(tbTexMarket, 'no');
assert.ok(metaSellTex.identity);
assert.strictEqual(identityKey(metaSellTex.identity), identityKey(texYes));

const laaTexSlugs = identitiesFromPolymarketSlugs([
  { symbol: 'aec-mlb-laa-pit-2026-09-04', side: 'SIDE_BUY' },
  { symbol: 'aec-mlb-tb-tex-2026-09-04', side: 'SIDE_SELL' },
]);
const laaTexLock = identitiesFromParlay({
  leg_keys: [
    'KXMLBGAME-26SEP041845LAAPIT-LAA:yes',
    'KXMLBGAME-26SEP042005TBTEX-TEX:yes',
  ],
});
assert.ok(laaTexSlugs.ok);
assert.ok(laaTexLock.ok);
assert.ok(sameIdentitySet(laaTexSlugs.keys, laaTexLock.keys));

const pitTbSlugs = identitiesFromPolymarketSlugs([
  { symbol: 'aec-mlb-laa-pit-2026-09-04', side: 'SIDE_SELL' },
  { symbol: 'aec-mlb-tb-tex-2026-09-04', side: 'SIDE_BUY' },
]);
assert.ok(pitTbSlugs.ok);
assert.ok(!sameIdentitySet(pitTbSlugs.keys, laaTexLock.keys));

// Kalshi D-backs are AZ; Poly slugs use ari.
const azLock = parseKalshiTicker('KXMLBGAME-26SEP012140PHIAZ-AZ:yes');
assert.ok(azLock);
assert.strictEqual(azLock.selection, 'az');
assert.deepStrictEqual(azLock.teams, ['az', 'phi']);
const ariSlug = identityFromPolymarketSlug('aec-mlb-ari-phi-2026-09-01', 'yes');
assert.ok(ariSlug);
assert.strictEqual(ariSlug.selection, 'az');
assert.deepStrictEqual(ariSlug.teams, ['az', 'phi']);
assert.strictEqual(identityKey(azLock), identityKey(ariSlug));

const dhSlug = identityFromPolymarketSlug('aec-mlb-det-cle-2026-09-04-dh1', 'yes');
assert.ok(dhSlug);
assert.strictEqual(dhSlug.selection, 'det');
assert.strictEqual(dhSlug.period, 'full-dh1');
const detYes = parseKalshiTicker('KXMLBGAME-26SEP041845DETCLE-DET:yes');
assert.ok(detYes);
assert.notStrictEqual(identityKey(dhSlug), identityKey(detYes));

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

  const lru = require('./polymarket-market-cache').createMarketCache({
    maxEntries: 2,
    fetchMarket: async (slug) => ({ slug }),
  });
  await lru.get('one');
  await lru.get('two');
  await lru.get('three');
  assert.strictEqual(lru._map.size, 2);
  assert.ok(!lru.peek('one'));
  assert.ok(lru.peek('two'));
  assert.ok(lru.peek('three'));

  console.log('leg-identity.test.js ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
