'use strict';
// UEFA Champions League, week of Nov 3–4 2026.
// Villarreal–PSG, Atlético–Bayern, Feyenoord–Inter. Yes is that club in
// regulation (or the draw on TIE). No is the same binary's No.
const assert = require('assert');
const {
  parseKalshiTicker,
  identityKey,
  normTeam,
  identitiesFromParlay,
  identitiesFromPolymarketSlugs,
  identitiesFromPolymarketLegs,
  identityFromMarket,
  identityFromNovigThreeWay,
  identityFromUclSlug,
  novigThreeWayKind,
  sameIdentitySet,
} = require('./leg-identity');
const { matchParlay } = require('./rfq');
const {
  normalizePolymarketRfq,
  couldMatchActiveLocks,
  matchPolymarketParlay,
  matchPolymarketParlayDetailed,
} = require('./polymarket-rfq');
const SL = require('./single-leg');
const { seriesOfTicker } = require('./series-fee');

const PSG = 'KXUCLGAME-26NOV03VILPSG-PSG';
const VIL = 'KXUCLGAME-26NOV03VILPSG-VIL';
const TIE = 'KXUCLGAME-26NOV03VILPSG-TIE';
const BAY = 'KXUCLGAME-26NOV03ATMBMU-BMU';
const ATM = 'KXUCLGAME-26NOV03ATMBMU-ATM';
const BAY_TIE = 'KXUCLGAME-26NOV03ATMBMU-TIE';
const INT = 'KXUCLGAME-26NOV03FEYINT-INT';
const FEY = 'KXUCLGAME-26NOV03FEYINT-FEY';
const MUN = 'KXUCLGAME-26NOV03MUNROM-MUN';

function keyOf(ticker) {
  const id = parseKalshiTicker(ticker);
  assert.ok(id, ticker);
  return identityKey(id);
}

// Names that books print for the same club.
assert.strictEqual(normTeam('ucl', 'PSG'), normTeam('ucl', 'Paris Saint-Germain'));
assert.strictEqual(normTeam('ucl', 'PSG'), normTeam('ucl', 'Paris Saint-Germain FC'));
assert.strictEqual(normTeam('ucl', 'BMU'), 'bayern');
assert.strictEqual(normTeam('ucl', 'bay'), 'bayern');
assert.strictEqual(normTeam('ucl', 'Bayern Munich'), 'bayern');
assert.strictEqual(normTeam('ucl', 'FC Bayern München'), 'bayern');
assert.strictEqual(normTeam('ucl', 'INT'), 'inter');
assert.strictEqual(normTeam('ucl', 'Inter'), 'inter');
assert.strictEqual(normTeam('ucl', 'Internazionale'), 'inter');
assert.strictEqual(normTeam('ucl', 'FC Internazionale Milano'), 'inter');
assert.strictEqual(normTeam('ucl', 'Inter Miami'), 'inter-miami');
assert.strictEqual(normTeam('ucl', 'Inter Miami CF'), 'inter-miami');
assert.notStrictEqual(normTeam('ucl', 'Inter'), normTeam('ucl', 'Inter Miami'));
// Kalshi MUN is Man United. Poly spells it mnu. Neither is Bayern.
assert.strictEqual(normTeam('ucl', 'MUN'), 'manutd');
assert.strictEqual(normTeam('ucl', 'mnu'), 'manutd');
assert.notStrictEqual(normTeam('ucl', 'MUN'), normTeam('ucl', 'BMU'));
assert.notStrictEqual(normTeam('ucl', 'MUN'), normTeam('ucl', 'Bayern Munich'));

const psgYes = parseKalshiTicker(`${PSG}:yes`);
assert.strictEqual(psgYes.league, 'ucl');
assert.strictEqual(psgYes.date, '2026-11-03');
assert.strictEqual(psgYes.marketType, 'moneyline_3way');
assert.strictEqual(psgYes.threeWay, true);
assert.strictEqual(psgYes.selection, 'psg');
assert.strictEqual(psgYes.side, 'yes');
assert.deepStrictEqual(psgYes.teams, ['psg', 'villarreal']);

const psgNo = parseKalshiTicker(`${PSG}:no`);
assert.strictEqual(psgNo.selection, 'psg');
assert.strictEqual(psgNo.side, 'no');
assert.notStrictEqual(identityKey(psgNo), identityKey(parseKalshiTicker(`${VIL}:yes`)));
assert.notStrictEqual(identityKey(psgNo), identityKey(psgYes));

const drawYes = parseKalshiTicker(`${TIE}:yes`);
assert.strictEqual(drawYes.selection, 'draw');
assert.strictEqual(drawYes.side, 'yes');
assert.deepStrictEqual(drawYes.teams, ['psg', 'villarreal']);
const drawNo = parseKalshiTicker(`${TIE}:no`);
assert.strictEqual(drawNo.selection, 'draw');
assert.strictEqual(drawNo.side, 'no');
assert.notStrictEqual(identityKey(drawNo), identityKey(psgYes));
assert.notStrictEqual(identityKey(drawNo), identityKey(parseKalshiTicker(`${VIL}:yes`)));

assert.strictEqual(parseKalshiTicker(`${BAY}:yes`).selection, 'bayern');
assert.strictEqual(parseKalshiTicker(`${INT}:yes`).selection, 'inter');
assert.strictEqual(parseKalshiTicker(`${FEY}:yes`).selection, 'feyenoord');
assert.strictEqual(parseKalshiTicker(`${MUN}:yes`).selection, 'manutd');
assert.notStrictEqual(keyOf(`${MUN}:yes`), keyOf(`${BAY}:yes`));
assert.strictEqual(parseKalshiTicker('KXUCLGAME-26NOV03VILPSG'), null);
assert.strictEqual(parseKalshiTicker('KXUCLGAME-26NOV03VILPSG-NOPE:yes'), null);

// This week's Kalshi blobs all split. Nov 4 games use the same codes.
for (const blob of ['GALVFB', 'SHASPO', 'ASKSLO', 'ATMBMU', 'BARAVL', 'BOGLIL', 'FEYINT', 'MUNROM', 'VILPSG']) {
  const codes = blob.match(/.{3}/g);
  assert.ok(parseKalshiTicker(`KXUCLGAME-26NOV03${blob}-${codes[0]}:yes`), blob);
}
for (const blob of ['AEKRMA', 'FENLFC', 'BVBRBB', 'FCPNAP', 'PSVBRU', 'RBLMCI', 'RCLCOM', 'SLAARS', 'VIKSBH']) {
  const codes = blob.match(/.{3}/g);
  assert.ok(parseKalshiTicker(`KXUCLGAME-26NOV04${blob}-${codes[1]}:yes`), blob);
}

// Polymarket US slugs from the Nov 3 board (atc-ucl-…, not aec-).
const psgSlug = 'atc-ucl-vil-psg-2026-11-03-psg';
const baySlug = 'atc-ucl-atm-bay-2026-11-03-bay';
const intSlug = 'atc-ucl-fey-int-2026-11-03-int';
const drawSlug = 'atc-ucl-vil-psg-2026-11-03-draw';
const bayDraw = 'atc-ucl-atm-bay-2026-11-03-draw';

assert.strictEqual(identityKey(identityFromUclSlug(psgSlug, 'SIDE_BUY')), keyOf(`${PSG}:yes`));
assert.strictEqual(identityKey(identityFromUclSlug(psgSlug, 'SIDE_SELL')), keyOf(`${PSG}:no`));
assert.notStrictEqual(identityKey(identityFromUclSlug(psgSlug, 'SIDE_SELL')), keyOf(`${VIL}:yes`));
assert.strictEqual(identityKey(identityFromUclSlug(baySlug, 'yes')), keyOf(`${BAY}:yes`));
assert.strictEqual(identityKey(identityFromUclSlug(intSlug, 'SIDE_BUY')), keyOf(`${INT}:yes`));
assert.strictEqual(identityKey(identityFromUclSlug(drawSlug, 'SIDE_BUY')), keyOf(`${TIE}:yes`));
assert.strictEqual(identityKey(identityFromUclSlug(bayDraw, 'SIDE_SELL')), keyOf(`${BAY_TIE}:no`));
assert.strictEqual(identityFromUclSlug('atc-ucl-vil-psg-2026-11-03-exact-score-2-0', 'yes'), null);
assert.strictEqual(identityFromUclSlug('astatc-ucl-vil-psg-2026-11-03-g-nicpep-gte1', 'yes'), null);
assert.strictEqual(identityFromUclSlug('aec-ucl-vil-psg-2026-11-03', 'yes'), null);
// Gamma event slug has no outcome. The market slug (with or without atc-) does.
assert.strictEqual(identityFromUclSlug('ucl-vil-psg-2026-11-03', 'yes'), null);
assert.strictEqual(identityKey(identityFromUclSlug('ucl-vil-psg-2026-11-03-psg', 'yes')), keyOf(`${PSG}:yes`));

const psgMarket = {
  slug: psgSlug,
  sportsMarketType: 'soccer_team_full_time_winner',
  question: 'Will Paris Saint-Germain FC win against Villarreal CF in the UEFA Champions League match scheduled for Nov 3, 2026?',
  gameStartTime: '2026-11-03T20:00:00Z',
  marketSides: [
    { long: true, team: { abbreviation: 'psg', name: 'Paris Saint-Germain FC', league: 'ucl' } },
    { long: false, team: { abbreviation: 'psg', name: 'Paris Saint-Germain FC', league: 'ucl' } },
  ],
};
const gotYes = identityFromMarket(psgMarket, 'yes');
assert.strictEqual(identityKey(gotYes.identity), keyOf(`${PSG}:yes`));
const gotNo = identityFromMarket(psgMarket, 'no');
assert.strictEqual(gotNo.identity.selection, 'psg');
assert.strictEqual(gotNo.identity.side, 'no');
assert.strictEqual(identityFromMarket({
  ...psgMarket,
  question: 'Will Villarreal CF win against Paris Saint-Germain FC in the UEFA Champions League match scheduled for Nov 3, 2026?',
}, 'yes').reason, 'not_priceable');
assert.strictEqual(identityFromMarket({
  slug: 'atc-ucl-vil-psg-2026-11-03-exact-score-2-0',
  sportsMarketType: 'soccer_game_exact_score',
  question: 'Will VIL vs PSG finish VIL wins 2-0?',
}, 'yes').reason, 'not_priceable');
assert.strictEqual(identityFromMarket({
  slug: baySlug,
  sportsMarketType: 'soccer_team_full_time_winner',
  question: 'Will FC Bayern München win against Club Atlético de Madrid in the UEFA Champions League match scheduled for Nov 3, 2026?',
  gameStartTime: '2026-11-03T20:00:00Z',
  marketSides: [
    { long: true, team: { abbreviation: 'bay', name: 'FC Bayern München', league: 'ucl' } },
    { long: false, team: { abbreviation: 'bay', name: 'FC Bayern München', league: 'ucl' } },
  ],
}, 'yes').identity.selection, 'bayern');
assert.strictEqual(identityFromMarket({
  slug: drawSlug,
  sportsMarketType: 'soccer_team_full_time_winner',
  question: 'Will the UEFA Champions League match Villarreal CF vs Paris Saint-Germain FC scheduled for Nov 3, 2026 end in a draw?',
  gameStartTime: '2026-11-03T20:00:00Z',
}, 'yes').identity.selection, 'draw');

const lockYes = {
  id: 'ucl-yes',
  leg_keys: [`${PSG}:yes`, `${INT}:yes`],
};
const lockNo = {
  id: 'ucl-no',
  leg_keys: [`${PSG}:no`, `${INT}:yes`],
};
const locks = [lockYes, lockNo];
assert.ok(identitiesFromParlay(lockYes).ok);
assert.ok(identitiesFromParlay(lockNo).ok);
assert.ok(!sameIdentitySet(identitiesFromParlay(lockYes).keys, identitiesFromParlay(lockNo).keys));

// Kalshi RFQ keeps the side. PSG:no is not Villarreal:yes and not the yes lock.
assert.strictEqual(matchParlay({ legKeys: [`${PSG}:no`, `${INT}:yes`] }, locks).id, 'ucl-no');
assert.strictEqual(matchParlay({ legKeys: [`${PSG}:yes`, `${INT}:yes`] }, locks).id, 'ucl-yes');
assert.strictEqual(matchParlay({ legKeys: [`${VIL}:yes`, `${INT}:yes`] }, locks), null);

const polyNo = normalizePolymarketRfq({
  id: 'rfq_ucl_no',
  comboLegs: [
    { symbol: psgSlug, side: 'SIDE_SELL' },
    { symbol: intSlug, side: 'SIDE_BUY' },
  ],
});
assert.strictEqual(couldMatchActiveLocks(polyNo, locks), true);
assert.strictEqual(matchPolymarketParlay(polyNo, locks).id, 'ucl-no');
const slugIds = identitiesFromPolymarketSlugs(polyNo.comboLegs);
assert.ok(slugIds.ok);
assert.ok(sameIdentitySet(slugIds.keys, identitiesFromParlay(lockNo).keys));

const polyYes = normalizePolymarketRfq({
  id: 'rfq_ucl_yes',
  comboLegs: [
    { symbol: psgSlug, side: 'SIDE_BUY' },
    { symbol: intSlug, side: 'SIDE_BUY' },
  ],
});
assert.strictEqual(matchPolymarketParlay(polyYes, locks).id, 'ucl-yes');

const withMarkets = identitiesFromPolymarketLegs([
  { symbol: psgSlug, side: 'SIDE_SELL', market: psgMarket },
  { symbol: intSlug, side: 'SIDE_BUY', market: {
    slug: intSlug,
    sportsMarketType: 'soccer_team_full_time_winner',
    question: 'Will FC Internazionale Milano win against Feyenoord Rotterdam in the UEFA Champions League match scheduled for Nov 3, 2026?',
    gameStartTime: '2026-11-03T20:00:00Z',
    marketSides: [
      { long: true, team: { abbreviation: 'int', name: 'FC Internazionale Milano', league: 'ucl' } },
      { long: false, team: { abbreviation: 'int', name: 'FC Internazionale Milano', league: 'ucl' } },
    ],
  } },
]);
assert.strictEqual(withMarkets.ok, true, JSON.stringify(withMarkets));
assert.ok(sameIdentitySet(withMarkets.keys, identitiesFromParlay(lockNo).keys));

const exact = normalizePolymarketRfq({
  id: 'rfq_exact',
  comboLegs: [
    { symbol: 'atc-ucl-vil-psg-2026-11-03-exact-score-2-0', side: 'SIDE_BUY' },
    { symbol: intSlug, side: 'SIDE_BUY' },
  ],
});
assert.strictEqual(matchPolymarketParlay(exact, locks), null);
const prop = matchPolymarketParlayDetailed(normalizePolymarketRfq({
  id: 'rfq_prop',
  comboLegs: [
    { symbol: psgSlug, side: 'SIDE_BUY', market: psgMarket },
    { symbol: 'astatc-ucl-vil-psg-2026-11-03-g-nicpep-gte1', side: 'SIDE_BUY', market: { slug: 'astatc-ucl-vil-psg-2026-11-03-g-nicpep-gte1', sportsMarketType: 'soccer_player_goals' } },
  ],
}), locks);
assert.notStrictEqual(prop.parlay && prop.parlay.id, 'ucl-yes');

// Novig: MONEYLINE_3_WAY_WIN / DRAW. MONEY (2-way) is not a UCL result.
assert.strictEqual(novigThreeWayKind('MONEY'), null);
assert.strictEqual(novigThreeWayKind('MONEYLINE_3_WAY_WIN'), 'win');
assert.strictEqual(novigThreeWayKind('MONEYLINE_3_WAY_DRAW'), 'draw');
const novigCtx = { away: 'FC Internazionale Milano', home: 'Feyenoord Rotterdam', start: '2026-11-03T20:00:00Z' };
const novigInterNo = identityFromNovigThreeWay(
  { marketType: 'MONEYLINE_3_WAY_WIN', description: 'Inter MONEYLINE_3_WAY_WIN' },
  { ...novigCtx, side: 'no' },
);
assert.strictEqual(identityKey(novigInterNo), keyOf(`${INT}:no`));
const novigDraw = identityFromNovigThreeWay(
  { marketType: 'MONEYLINE_3_WAY_DRAW', description: 'Inter @ Feyenoord MONEYLINE_3_WAY_DRAW' },
  { ...novigCtx, outcome: 'Yes' },
);
assert.strictEqual(identityKey(novigDraw), keyOf('KXUCLGAME-26NOV03FEYINT-TIE:yes'));
assert.strictEqual(identityFromNovigThreeWay(
  { marketType: 'MONEY', description: 'Inter' },
  { ...novigCtx, side: 'yes' },
), null);
assert.strictEqual(identityFromNovigThreeWay(
  { marketType: 'MONEYLINE_3_WAY_WIN', description: 'Inter MONEYLINE_3_WAY_WIN' },
  { away: 'Inter Miami CF', home: 'Orlando City SC', start: '2026-11-03T23:00:00Z', side: 'yes' },
), null);
const novigBay = identityFromNovigThreeWay(
  { marketType: 'MONEYLINE_3_WAY_WIN', description: 'Bayern Munich MONEYLINE_3_WAY_WIN' },
  { away: 'FC Bayern München', home: 'Club Atlético de Madrid', startsTs: Date.parse('2026-11-03T20:00:00Z'), side: 'yes' },
);
assert.strictEqual(identityKey(novigBay), keyOf(`${BAY}:yes`));
assert.notStrictEqual(identityKey(novigBay), keyOf(`${MUN}:yes`));

// Hedge is No on the same contract. Fees stay the inverse-bet rates:
// Kalshi taker 0.07*P*(1-P), Polymarket US 0.095*P*(1-P), Novig $0 pregame,
// ProphetX 2% of net winnings. Maker fee is the KXUCLGAME series rate.
assert.strictEqual(SL.KALSHI_TAKER_K, 0.07);
assert.strictEqual(SL.POLY_TAKER_THETA, 0.095);
assert.strictEqual(seriesOfTicker(`${PSG}:yes`), 'KXUCLGAME');
assert.strictEqual(seriesOfTicker('caoc-ucl'), null);
const kalshiFee = (p) => 0.07 * p * (1 - p);
const polyFee = (p) => 0.095 * p * (1 - p);
const noAsk = 0.45;
const oppYes = 0.20;
const fair = 1 - (noAsk + kalshiFee(noAsk));
assert.ok(Math.abs(fair - (1 - (0.45 + 0.07 * 0.45 * 0.55))) < 1e-12);
assert.ok(Math.abs(fair - (1 - (oppYes + kalshiFee(oppYes)))) > 0.2, 'opponent Yes is not the inverse');
assert.ok(fair < 0.6);
const novigPregameFee = () => 0;
assert.strictEqual(novigPregameFee(noAsk), 0);
assert.ok(Math.abs((1 - noAsk) - (1 - (noAsk + novigPregameFee(noAsk)))) < 1e-12);
const px = 0.5;
const pxFee = px / (0.98 + 0.02 * px) - px;
assert.ok(Math.abs(pxFee - (0.5 / 0.99 - 0.5)) < 1e-12);
const pmFair = 1 - (0.40 + polyFee(0.40));
assert.ok(pmFair > fair);

const hedge = SL.kalshiHedge({ ticker: PSG, side: 'yes' }, 100, 0);
assert.deepStrictEqual(hedge, { ticker: PSG, side: 'no', priceCents: 50 });
assert.notStrictEqual(hedge.ticker, VIL);
const slugs = SL.polySlugCandidates(`${PSG}:yes`);
assert.ok(slugs.includes(psgSlug), slugs.join(','));
assert.ok(slugs.every((s) => s.startsWith('atc-ucl-') && !s.startsWith('aec-')));
const baySlugs = SL.polySlugCandidates(`${BAY}:yes`);
assert.ok(baySlugs.includes(baySlug), baySlugs.join(','));
const tieSlugs = SL.polySlugCandidates(`${TIE}:yes`);
assert.ok(tieSlugs.includes(drawSlug), tieSlugs.join(','));

assert.strictEqual(SL.polyHedgeIntent({ ticker: PSG, side: 'yes' }, psgMarket).intent, 'ORDER_INTENT_BUY_SHORT');
assert.strictEqual(SL.polyHedgeIntent({ ticker: PSG, side: 'no' }, psgMarket).intent, 'ORDER_INTENT_BUY_LONG');
assert.strictEqual(SL.polyHedgeIntent({ ticker: VIL, side: 'yes' }, psgMarket), null);
assert.strictEqual(SL.polyHedgeIntent({ ticker: ATM, side: 'yes' }, psgMarket), null);
const bayMarket = {
  slug: baySlug,
  sportsMarketType: 'soccer_team_full_time_winner',
  question: 'Will FC Bayern München win against Club Atlético de Madrid in the UEFA Champions League match scheduled for Nov 3, 2026?',
  gameStartTime: '2026-11-03T20:00:00Z',
  marketSides: [
    { long: true, team: { abbreviation: 'bay', name: 'FC Bayern München', league: 'ucl' } },
    { long: false, team: { abbreviation: 'bay', name: 'FC Bayern München', league: 'ucl' } },
  ],
};
assert.strictEqual(SL.polyHedgeIntent({ ticker: BAY, side: 'yes' }, bayMarket).intent, 'ORDER_INTENT_BUY_SHORT');
assert.strictEqual(SL.polyHedgeIntent({ ticker: MUN, side: 'yes' }, bayMarket), null);

console.log('ucl locks ok', fair.toFixed(4), pmFair.toFixed(4));
