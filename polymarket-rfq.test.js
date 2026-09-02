'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { decideAtFill } = require('./engine');
const { sumOutstanding } = require('./reserve');
const { shouldConfirmPolymarketAccept } = require('./polymarket-quote');
const {
  sign,
  authHeaders,
  signPath,
  isPolymarketRfqLive,
} = require('./polymarket-auth');
const { parsePrivateMessage } = require('./polymarket-client');
const {
  normalizePolymarketSide,
  polymarketLegKey,
  mapComboLegs,
  normalizePolymarketRfq,
  couldMatchActiveLocks,
  cheapDirectMatch,
  matchPolymarketParlay,
  matchPolymarketParlayDetailed,
  evaluatePolymarketRfq,
  shouldPostNow,
  shouldConfirmNow,
  quoteBodyFromEval,
  startPolymarketRfqLoop,
} = require('./polymarket-rfq');
const { createMarketCache } = require('./polymarket-market-cache');

// Fixed seed / timestamp / path — do not rotate these; they are the signing fixture.
const SEED_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const TS = '1756670000000';
const SIGN_PATH = '/v1/rfqs/user-id';
const EXPECTED_SIG = 'pczC6rEQ8RqRZznY8PNfSp8AWmWzRq582bIKIZSIfJqT6NoO181hx1SI+PiRqC4qTKq1bvQKysEieo4cO6gVCg==';

assert.strictEqual(signPath('/v1/rfqs?status=RFQ_STATUS_OPEN'), '/v1/rfqs');
assert.strictEqual(sign(SEED_B64, TS, 'GET', SIGN_PATH), EXPECTED_SIG);
assert.strictEqual(sign(SEED_B64, TS, 'get', `${SIGN_PATH}?x=1`), EXPECTED_SIG);

const headers = authHeaders({
  keyId: 'key-id-fixture',
  secretKey: SEED_B64,
  method: 'GET',
  path: SIGN_PATH,
  ts: Number(TS),
});
assert.strictEqual(headers['X-PM-Access-Key'], 'key-id-fixture');
assert.strictEqual(headers['X-PM-Timestamp'], TS);
assert.strictEqual(headers['X-PM-Signature'], EXPECTED_SIG);
assert.ok(!('account' in headers));

const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const seed = Buffer.from(SEED_B64, 'base64');
const pub = crypto.createPublicKey({
  key: crypto.createPrivateKey({
    key: Buffer.concat([prefix, seed]),
    format: 'der',
    type: 'pkcs8',
  }),
});
assert.ok(crypto.verify(
  null,
  Buffer.from(TS + 'GET' + SIGN_PATH, 'utf8'),
  pub,
  Buffer.from(EXPECTED_SIG, 'base64')
));

assert.strictEqual(isPolymarketRfqLive({}), false);
assert.strictEqual(isPolymarketRfqLive({ POLYMARKET_RFQ_LIVE: '' }), false);
assert.strictEqual(isPolymarketRfqLive({ POLYMARKET_RFQ_LIVE: 'false' }), false);
assert.strictEqual(isPolymarketRfqLive({ POLYMARKET_RFQ_LIVE: '0' }), false);
assert.strictEqual(isPolymarketRfqLive({ POLYMARKET_RFQ_LIVE: 'true' }), true);
assert.strictEqual(isPolymarketRfqLive({ POLYMARKET_RFQ_LIVE: '1' }), true);
assert.strictEqual(isPolymarketRfqLive({ POLYMARKET_RFQ_LIVE: 'YES' }), true);

assert.strictEqual(normalizePolymarketSide('SIDE_BUY'), 'yes');
assert.strictEqual(normalizePolymarketSide('buy'), 'yes');
assert.strictEqual(normalizePolymarketSide('SIDE_SELL'), 'no');
assert.strictEqual(normalizePolymarketSide('SIDE_UNSPECIFIED'), null);

assert.strictEqual(
  polymarketLegKey({ symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'SIDE_BUY' }),
  'AEC-MLB-CWS-DET-2026-08-14-CWS:yes'
);
assert.strictEqual(polymarketLegKey({ side: 'SIDE_BUY' }), null);
assert.strictEqual(polymarketLegKey({ symbol: 'aec-x', side: 'SIDE_NOPE' }), null);

const mappedSkip = mapComboLegs([
  { symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'SIDE_BUY' },
  { side: 'SIDE_BUY' },
]);
assert.strictEqual(mappedSkip.ok, false);
assert.strictEqual(mappedSkip.reason, 'unmatched_leg');
assert.strictEqual(mappedSkip.skipped.length, 1);

const P = 'ae7a56e8-8ee3-478d-96fa-7c167c20d46e';
const kalshiParlay = {
  id: P,
  user_id: 'u1',
  label: 'White Sox ML + Pirates ML',
  parlay_stake: 100,
  parlay_american: 400,
  fill_american: 350,
  hedge_mode: '1x',
  max_contracts: 116,
  leg_keys: [
    'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
    'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
  ],
  legs: [
    { ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS', side: 'yes' },
    { ticker: 'KXMLBGAME-26AUG141840BOSPIT-PIT', side: 'yes' },
  ],
};

const pmRfq = {
  id: 'rfq_open_1',
  status: 'RFQ_STATUS_OPEN',
  qtyDecimal: '10',
  symbol: 'caoc-abc',
  comboLegs: [
    { symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'SIDE_BUY' },
    { symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'SIDE_BUY' },
  ],
};

const skipped = evaluatePolymarketRfq({ rfq: pmRfq, parlays: [kalshiParlay] });
assert.strictEqual(skipped.action, 'skip');
assert.strictEqual(skipped.reason, 'missing_metadata');
assert.strictEqual(matchPolymarketParlay(normalizePolymarketRfq(pmRfq), [kalshiParlay]), null);

const cwsMeta = {
  metadata: {
    event_id: 'mlb-cws-det-2026-08-14',
    event_start_time: '2026-08-14T22:40:00Z',
    event_subcategory: 'BASEBALL',
    market_sport_type: 'baseball_team_full_game_winner',
    outcome_strike: '0.0',
    long_participant_id: 'mlb-cws',
    short_participant_id: 'mlb-det',
  },
};
const pitMeta = {
  metadata: {
    event_id: 'mlb-bos-pit-2026-08-14',
    event_start_time: '2026-08-14T22:40:00Z',
    event_subcategory: 'BASEBALL',
    market_sport_type: 'baseball_team_full_game_winner',
    outcome_strike: '0.0',
    long_participant_id: 'mlb-pit',
    short_participant_id: 'mlb-bos',
  },
};
const lockMarkets = new Map([
  ['aec-mlb-cws-det-2026-08-14-cws', cwsMeta],
  ['aec-mlb-bos-pit-2026-08-14-pit', pitMeta],
]);

const BEFORE_PITCH = Date.parse('2026-08-14T20:00:00Z');
const AFTER_PITCH = Date.parse('2026-08-14T23:44:00Z');
const lockMatch = evaluatePolymarketRfq({
  rfq: pmRfq,
  parlays: [kalshiParlay],
  markets: lockMarkets,
  now: BEFORE_PITCH,
});
assert.strictEqual(lockMatch.action, 'quoteable');
assert.strictEqual(lockMatch.parlay.id, P);
assert.strictEqual(lockMatch.quote.buyPrice, '0.222');

// After first pitch (Kalshi ticker HHMM on the lock): skip — do not quote.
const startedLock = evaluatePolymarketRfq({
  rfq: pmRfq,
  parlays: [kalshiParlay],
  markets: lockMarkets,
  now: AFTER_PITCH,
});
assert.strictEqual(startedLock.action, 'skip');
assert.strictEqual(startedLock.reason, 'game_started');
assert.ok(startedLock.started && startedLock.started.started);
assert.strictEqual(
  matchPolymarketParlay(normalizePolymarketRfq(pmRfq), [kalshiParlay], { markets: lockMarkets }).id,
  P
);

const sellRfq = {
  ...pmRfq,
  id: 'rfq_sell',
  comboLegs: [
    { symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'SIDE_SELL' },
    { symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'SIDE_SELL' },
  ],
};
const sellSkip = evaluatePolymarketRfq({
  rfq: sellRfq,
  parlays: [kalshiParlay],
  markets: lockMarkets,
});
assert.strictEqual(sellSkip.action, 'skip');
assert.strictEqual(sellSkip.reason, 'unmatched');

const wrongDateMarkets = new Map([
  ['aec-mlb-cws-det-2026-08-14-cws', {
    metadata: { ...cwsMeta.metadata, event_start_time: '2026-08-15T22:40:00Z' },
  }],
  ['aec-mlb-bos-pit-2026-08-14-pit', pitMeta],
]);
assert.strictEqual(evaluatePolymarketRfq({
  rfq: pmRfq, parlays: [kalshiParlay], markets: wrongDateMarkets,
}).reason, 'unmatched');

const spreadMarkets = new Map([
  ['aec-mlb-cws-det-2026-08-14-cws', {
    metadata: { ...cwsMeta.metadata, market_sport_type: 'baseball_team_full_game_spread', outcome_strike: '1.5' },
  }],
  ['aec-mlb-bos-pit-2026-08-14-pit', pitMeta],
]);
assert.strictEqual(evaluatePolymarketRfq({
  rfq: pmRfq, parlays: [kalshiParlay], markets: spreadMarkets,
}).reason, 'not_priceable');

const twin = { ...kalshiParlay, id: 'twin-lock', label: 'Twin' };
assert.strictEqual(
  matchPolymarketParlayDetailed(
    normalizePolymarketRfq(pmRfq),
    [kalshiParlay, twin],
    { markets: lockMarkets }
  ).reason,
  'ambiguous'
);
assert.strictEqual(evaluatePolymarketRfq({
  rfq: { ...pmRfq, id: 'rfq_amb' },
  parlays: [kalshiParlay, twin],
  markets: lockMarkets,
}).reason, 'ambiguous');

const noSymbolRfq = {
  id: 'rfq_bad_leg',
  status: 'RFQ_STATUS_OPEN',
  qtyDecimal: '10',
  comboLegs: [
    { symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'SIDE_BUY' },
    { side: 'SIDE_BUY' },
  ],
};
const unmatchedLeg = evaluatePolymarketRfq({ rfq: noSymbolRfq, parlays: [kalshiParlay] });
assert.strictEqual(unmatchedLeg.action, 'skip');
assert.strictEqual(unmatchedLeg.reason, 'unmatched_leg');

const pmParlay = {
  ...kalshiParlay,
  id: 'pm-parlay',
  label: 'PM Sox/Pirates',
  leg_keys: [
    'AEC-MLB-BOS-PIT-2026-08-14-PIT:yes',
    'AEC-MLB-CWS-DET-2026-08-14-CWS:yes',
  ],
  legs: [
    { symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'SIDE_BUY' },
    { symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'SIDE_BUY' },
  ],
};

const matched = matchPolymarketParlay(normalizePolymarketRfq(pmRfq), [kalshiParlay, pmParlay]);
assert.ok(matched);
assert.strictEqual(matched.id, 'pm-parlay');

const viaLegsOnly = matchPolymarketParlay(
  normalizePolymarketRfq(pmRfq),
  [{ ...pmParlay, leg_keys: ['KXMLBGAME-X:yes'], legs: pmParlay.legs }]
);
assert.ok(viaLegsOnly);
assert.strictEqual(viaLegsOnly.id, 'pm-parlay');

const tennisRfq = {
  id: 'rfq_tennis_1',
  status: 'RFQ_STATUS_OPEN',
  qtyDecimal: '10',
  comboLegs: [
    { symbol: 'aec-atp-djokovic-alcaraz-2026-08-14-djokovic', side: 'SIDE_BUY' },
    { symbol: 'aec-atp-sinner-medvedev-2026-08-14-sinner', side: 'SIDE_BUY' },
  ],
};
const lolRfq = {
  id: 'rfq_lol_1',
  status: 'RFQ_STATUS_OPEN',
  qtyDecimal: '10',
  comboLegs: [
    { symbol: 'aec-lol-t1-geng-2026-08-14-t1', side: 'SIDE_BUY' },
    { symbol: 'aec-lol-hlei-blg-2026-08-14-hlei', side: 'SIDE_BUY' },
  ],
};
const soccerRfq = {
  id: 'rfq_soccer_1',
  status: 'RFQ_STATUS_OPEN',
  qtyDecimal: '10',
  comboLegs: [
    { symbol: 'aec-epl-ars-che-2026-08-14-ars', side: 'SIDE_BUY' },
    { symbol: 'aec-mls-mia-nyc-2026-08-14-mia', side: 'SIDE_BUY' },
  ],
};
const cs2Rfq = {
  id: 'rfq_cs2_1',
  status: 'RFQ_STATUS_OPEN',
  qtyDecimal: '10',
  comboLegs: [
    { symbol: 'aec-cs2-navi-faze-2026-08-14-navi', side: 'SIDE_BUY' },
    { symbol: 'aec-cs2-vitality-mouz-2026-08-14-vitality', side: 'SIDE_BUY' },
  ],
};

assert.strictEqual(couldMatchActiveLocks(normalizePolymarketRfq(pmRfq), [kalshiParlay]), true);
assert.strictEqual(couldMatchActiveLocks(normalizePolymarketRfq(pmRfq), [pmParlay]), true);
assert.ok(cheapDirectMatch(normalizePolymarketRfq(pmRfq), [pmParlay]));
assert.strictEqual(couldMatchActiveLocks(normalizePolymarketRfq(pmRfq), []), false);
assert.strictEqual(couldMatchActiveLocks(normalizePolymarketRfq(sellRfq), [kalshiParlay]), false);
assert.strictEqual(couldMatchActiveLocks(normalizePolymarketRfq(tennisRfq), [kalshiParlay]), false);
assert.strictEqual(couldMatchActiveLocks(normalizePolymarketRfq(lolRfq), [kalshiParlay]), false);
assert.strictEqual(couldMatchActiveLocks(normalizePolymarketRfq(soccerRfq), [kalshiParlay]), false);
assert.strictEqual(couldMatchActiveLocks(normalizePolymarketRfq(cs2Rfq), [kalshiParlay]), false);
assert.strictEqual(
  couldMatchActiveLocks(normalizePolymarketRfq({
    ...pmRfq,
    id: 'rfq_other_mlb',
    comboLegs: [
      { symbol: 'aec-mlb-nyy-bos-2026-08-14-nyy', side: 'SIDE_BUY' },
      { symbol: 'aec-mlb-lad-sd-2026-08-14-lad', side: 'SIDE_BUY' },
    ],
  }), [kalshiParlay]),
  false
);

const nflLock = {
  id: 'nfl-lock',
  user_id: 'u1',
  label: 'Chiefs ML + Lions ML',
  parlay_stake: 100,
  parlay_american: 400,
  fill_american: 350,
  hedge_mode: '1x',
  max_contracts: 116,
  leg_keys: [
    'KXNFLGAME-26SEP071330BUFKC-KC:yes',
    'KXNFLGAME-26SEP071330DETMIA-DET:yes',
  ],
  legs: [],
};
const nflRfq = {
  id: 'rfq_nfl_1',
  status: 'RFQ_STATUS_OPEN',
  qtyDecimal: '10',
  comboLegs: [
    { symbol: 'aec-nfl-buf-kc-2026-09-07-kc', side: 'SIDE_BUY' },
    { symbol: 'aec-nfl-det-mia-2026-09-07-det', side: 'SIDE_BUY' },
  ],
};
assert.strictEqual(couldMatchActiveLocks(normalizePolymarketRfq(nflRfq), [nflLock]), true);
assert.strictEqual(couldMatchActiveLocks(normalizePolymarketRfq(pmRfq), [nflLock]), false);
assert.strictEqual(couldMatchActiveLocks(normalizePolymarketRfq(tennisRfq), [nflLock]), false);

const ncaafRfq = {
  id: 'rfq_ncaaf_1',
  status: 'RFQ_STATUS_OPEN',
  qtyDecimal: '10',
  comboLegs: [
    { symbol: 'aec-ncaaf-ala-uga-2026-09-07-ala', side: 'SIDE_BUY' },
    { symbol: 'aec-ncaaf-osu-mich-2026-09-07-osu', side: 'SIDE_BUY' },
  ],
};
const ncaafPmLock = {
  id: 'ncaaf-pm',
  user_id: 'u1',
  label: 'Bama + OSU',
  parlay_stake: 100,
  parlay_american: 400,
  fill_american: 350,
  hedge_mode: '1x',
  max_contracts: 50,
  leg_keys: [
    'AEC-NCAAF-ALA-UGA-2026-09-07-ALA:yes',
    'AEC-NCAAF-OSU-MICH-2026-09-07-OSU:yes',
  ],
  legs: [
    { symbol: 'aec-ncaaf-ala-uga-2026-09-07-ala', side: 'SIDE_BUY' },
    { symbol: 'aec-ncaaf-osu-mich-2026-09-07-osu', side: 'SIDE_BUY' },
  ],
};
assert.strictEqual(couldMatchActiveLocks(normalizePolymarketRfq(ncaafRfq), [ncaafPmLock]), true);
assert.strictEqual(
  evaluatePolymarketRfq({ rfq: ncaafRfq, parlays: [ncaafPmLock] }).action,
  'quoteable'
);

const quoteable = evaluatePolymarketRfq({
  rfq: pmRfq,
  parlays: [pmParlay],
  filledSoFar: 0,
  outstanding: 0,
});
assert.strictEqual(quoteable.action, 'quoteable');
assert.strictEqual(quoteable.quote.buyPrice, '0.222');
assert.strictEqual(quoteable.quote.sellPrice, '0');
assert.strictEqual(quoteable.quote.estimatedContracts, 10);
assert.ok(quoteable.decision.ok);
assert.strictEqual(quoteable.decision.contracts, 10);
assert.deepStrictEqual(quoteBodyFromEval(quoteable), {
  rfqId: 'rfq_open_1',
  buyPrice: '0.222',
  sellPrice: '0',
  restRemainder: false,
});
assert.ok(!('account' in quoteBodyFromEval(quoteable)));

assert.deepStrictEqual(shouldPostNow(quoteable, { live: false }), { post: false, reason: 'live_off' });
assert.deepStrictEqual(shouldPostNow(quoteable, { live: true }), { post: true, reason: null });
assert.deepStrictEqual(shouldPostNow(skipped, { live: true }), { post: false, reason: 'missing_metadata' });

assert.strictEqual(shouldConfirmPolymarketAccept('SIDE_BUY'), true);
assert.strictEqual(shouldConfirmPolymarketAccept('SIDE_SELL'), false);
assert.deepStrictEqual(shouldConfirmNow('SIDE_BUY', { live: false }), { confirm: false, reason: 'live_off' });
assert.deepStrictEqual(shouldConfirmNow('SIDE_BUY', { live: true }), { confirm: true, reason: null });
assert.deepStrictEqual(shouldConfirmNow('SIDE_SELL', { live: true }), { confirm: false, reason: 'side_not_buy' });
assert.deepStrictEqual(shouldConfirmNow('sell', { live: true }), { confirm: false, reason: 'side_not_buy' });
assert.deepStrictEqual(
  shouldConfirmNow('SIDE_BUY', { live: true, started: { started: true } }),
  { confirm: false, reason: 'game_started' }
);
assert.deepStrictEqual(
  shouldConfirmNow('SIDE_BUY', { live: true, started: { started: false } }),
  { confirm: true, reason: null }
);

// Date-only PM slugs must not count as midnight starts; starts_at still gates.
assert.strictEqual(evaluatePolymarketRfq({
  rfq: pmRfq,
  parlays: [pmParlay],
  now: AFTER_PITCH,
}).action, 'quoteable');
assert.strictEqual(evaluatePolymarketRfq({
  rfq: pmRfq,
  parlays: [{ ...pmParlay, starts_at: '2026-08-14T22:41:00.000Z' }],
  now: BEFORE_PITCH,
}).action, 'quoteable');
assert.strictEqual(evaluatePolymarketRfq({
  rfq: pmRfq,
  parlays: [{ ...pmParlay, starts_at: '2026-08-14T22:41:00.000Z' }],
  now: AFTER_PITCH,
}).reason, 'game_started');
assert.strictEqual(evaluatePolymarketRfq({
  rfq: pmRfq,
  parlays: [{
    ...pmParlay,
    legs: [
      { ...pmParlay.legs[0], commence_time: '2026-08-14T22:40:00.000Z' },
      pmParlay.legs[1],
    ],
  }],
  now: AFTER_PITCH,
}).reason, 'game_started');

// Shared remaining: Kalshi 43 + another 43 leaves 30; a $10 cash PM RFQ is 45 and must skip.
const SIZE = 43;
const kalshiPending = new Map();
kalshiPending.set('q-kalshi-1', { parlayId: 'pm-parlay', contracts: SIZE });
kalshiPending.set('q-kalshi-2', { parlayId: 'pm-parlay', contracts: SIZE });
const polyPending = new Map();
const sharedOut = sumOutstanding(kalshiPending, 'pm-parlay') + sumOutstanding(polyPending, 'pm-parlay');
assert.strictEqual(sharedOut, SIZE * 2);

const cashRfq = {
  id: 'rfq_cash_45',
  status: 'RFQ_STATUS_OPEN',
  cashOrderQty: '10',
  comboLegs: pmRfq.comboLegs,
};
const cashEval = evaluatePolymarketRfq({
  rfq: cashRfq,
  parlays: [pmParlay],
  filledSoFar: 0,
  outstanding: sharedOut,
});
assert.strictEqual(cashEval.quote.estimatedContracts, 45);
assert.strictEqual(cashEval.action, 'skip');
assert.strictEqual(cashEval.reason, 'rfq_too_large');
assert.strictEqual(cashEval.decision.remaining, 116 - SIZE * 2);

const cashAlone = evaluatePolymarketRfq({
  rfq: cashRfq,
  parlays: [pmParlay],
  filledSoFar: 0,
  outstanding: SIZE,
});
assert.strictEqual(cashAlone.action, 'quoteable');
assert.strictEqual(cashAlone.decision.contracts, 45);
assert.strictEqual(cashAlone.decision.outstanding, SIZE);

const qtyFit = evaluatePolymarketRfq({
  rfq: { ...pmRfq, id: 'rfq_qty_10', qtyDecimal: '10' },
  parlays: [pmParlay],
  filledSoFar: 0,
  outstanding: SIZE,
});
assert.strictEqual(qtyFit.action, 'quoteable');
assert.strictEqual(qtyFit.decision.contracts, 10);
assert.strictEqual(qtyFit.decision.outstanding, SIZE);

const afterBoth = decideAtFill({
  parlayStake: 100,
  parlayAmerican: 400,
  fillAmerican: 350,
  rfqContracts: 10,
  hedgeMode: '1x',
  maxContracts: 116,
  filledSoFar: 0,
  outstanding: SIZE + 10,
});
assert.ok(afterBoth.ok);
assert.strictEqual(afterBoth.remaining, 116 - SIZE - 10 - 10);

const over = evaluatePolymarketRfq({
  rfq: { ...pmRfq, id: 'rfq_qty_80', qtyDecimal: '80' },
  parlays: [pmParlay],
  filledSoFar: 0,
  outstanding: SIZE,
});
assert.strictEqual(over.action, 'skip');
assert.strictEqual(over.reason, 'rfq_too_large');

// Live flag off: handleRfq must not POST even when quoteable.
const posts = [];
const confirms = [];
const fakeHttp = {
  async getUserId() { return { rfqUserId: 'rfquser_test' }; },
  async listRfqs() { return { rfqs: [] }; },
  async listQuotes() { return { quotes: [] }; },
  async getCombo() { return { combos: [] }; },
  async createQuote(body) {
    posts.push(body);
    return { quoteId: 'quote_posted' };
  },
  async confirmQuote(rfqId, quoteId) {
    confirms.push({ rfqId, quoteId });
    return {};
  },
  async deleteQuote() { return { statusCode: 200 }; },
  close() {},
};

const loopOff = startPolymarketRfqLoop({
  env: {
    POLYMARKET_KEY_ID: 'key-id-fixture',
    POLYMARKET_SECRET_KEY: SEED_B64,
    POLYMARKET_RFQ_LIVE: 'false',
  },
  http: fakeHttp,
  startWs: false,
  getParlays: () => [pmParlay],
  filledSoFarFor: () => 0,
  getOutstanding: (id) => sumOutstanding(kalshiPending, id) + sumOutstanding(polyPending, id),
  pendingQuotes: polyPending,
  kalshiPendingQuotes: kalshiPending,
  reconcileMs: 60 * 60 * 1000,
});
assert.strictEqual(loopOff.live, false);

Promise.resolve(loopOff.handleRfq(pmRfq)).then(async (out) => {
  assert.strictEqual(out.post, false);
  assert.strictEqual(out.reason, 'live_off');
  assert.strictEqual(posts.length, 0);
  assert.strictEqual(polyPending.size, 0);

  const accSell = await loopOff.handleQuoteAccepted({
    quote: { id: 'quote_x', rfqId: 'rfq_open_1', acceptedSide: 'SIDE_SELL' },
  });
  assert.strictEqual(accSell.confirmed, false);
  assert.strictEqual(accSell.reason, 'side_not_buy');
  assert.strictEqual(confirms.length, 0);

  const accBuy = await loopOff.handleQuoteAccepted({
    quote: { id: 'quote_x', rfqId: 'rfq_open_1', acceptedSide: 'SIDE_BUY' },
  });
  assert.strictEqual(accBuy.confirmed, false);
  assert.strictEqual(accBuy.reason, 'live_off');
  assert.strictEqual(confirms.length, 0);

  loopOff.stop();

  const lockLoop = startPolymarketRfqLoop({
    env: {
      POLYMARKET_KEY_ID: 'key-id-fixture',
      POLYMARKET_SECRET_KEY: SEED_B64,
      POLYMARKET_RFQ_LIVE: 'false',
    },
    http: fakeHttp,
    startWs: false,
    getParlays: () => [kalshiParlay],
    fetchMarket: async (slug) => lockMarkets.get(slug) || null,
    startedFor: () => ({ started: false }),
    filledSoFarFor: () => 0,
    getOutstanding: () => 0,
    pendingQuotes: new Map(),
    reconcileMs: 60 * 60 * 1000,
  });
  const lockOut = await lockLoop.handleRfq({ ...pmRfq, id: 'rfq_lock_map' });
  assert.strictEqual(lockOut.action, 'quoteable');
  assert.strictEqual(lockOut.parlay.id, P);
  assert.strictEqual(lockOut.post, false);
  assert.strictEqual(lockOut.reason, 'live_off');
  assert.strictEqual(posts.length, 0);
  lockLoop.stop();

  const livePending = new Map();
  const loopOn = startPolymarketRfqLoop({
    env: {
      POLYMARKET_KEY_ID: 'key-id-fixture',
      POLYMARKET_SECRET_KEY: SEED_B64,
      POLYMARKET_RFQ_LIVE: 'true',
    },
    http: fakeHttp,
    startWs: false,
    getParlays: () => [pmParlay],
    filledSoFarFor: () => 0,
    getOutstanding: (id, ex) => sumOutstanding(kalshiPending, id, ex) + sumOutstanding(livePending, id, ex),
    pendingQuotes: livePending,
    kalshiPendingQuotes: kalshiPending,
    reconcileMs: 60 * 60 * 1000,
  });
  assert.strictEqual(loopOn.live, true);

  const posted = await loopOn.handleRfq({ ...pmRfq, id: 'rfq_live_1' });
  assert.strictEqual(posted.post, true);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].buyPrice, '0.222');
  assert.strictEqual(posts[0].sellPrice, '0');
  assert.ok(!('account' in posts[0]));
  assert.ok(livePending.has('quote_posted'));
  assert.strictEqual(sumOutstanding(livePending, 'pm-parlay'), 10);
  assert.strictEqual(
    sumOutstanding(kalshiPending, 'pm-parlay') + sumOutstanding(livePending, 'pm-parlay'),
    SIZE * 2 + 10
  );

  const sellLive = await loopOn.handleQuoteAccepted({
    quote: { id: 'quote_posted', rfqId: 'rfq_live_1', acceptedSide: 'SIDE_SELL' },
  });
  assert.strictEqual(sellLive.confirmed, false);
  assert.strictEqual(sellLive.reason, 'side_not_buy');
  assert.strictEqual(confirms.length, 0);

  livePending.set('quote_posted', {
    ...livePending.get('quote_posted'),
    parlayId: 'pm-parlay',
    contracts: 10,
    maxContracts: 116,
    rfqId: 'rfq_live_1',
    label: 'PM Sox/Pirates',
  });
  const buyLive = await loopOn.handleQuoteAccepted({
    quote: { id: 'quote_posted', rfqId: 'rfq_live_1', acceptedSide: 'SIDE_BUY' },
  });
  assert.strictEqual(buyLive.confirmed, true);
  assert.strictEqual(confirms.length, 1);
  assert.deepStrictEqual(confirms[0], { rfqId: 'rfq_live_1', quoteId: 'quote_posted' });

  loopOn.stop();

  // Confirm-after-start: BUY accept must not confirm; quote is deleted.
  const startedDeletes = [];
  const startedConfirms = [];
  const startedHttp = {
    async getUserId() { return { rfqUserId: 'rfquser_test' }; },
    async listRfqs() { return { rfqs: [] }; },
    async listQuotes() { return { quotes: [] }; },
    async getCombo() { return { combos: [] }; },
    async createQuote() { return { quoteId: 'quote_started' }; },
    async confirmQuote(rfqId, quoteId) {
      startedConfirms.push({ rfqId, quoteId });
      return {};
    },
    async deleteQuote(rfqId, quoteId) {
      startedDeletes.push({ rfqId, quoteId });
      return { statusCode: 200 };
    },
    close() {},
  };
  const startedPending = new Map();
  const startedHit = {
    started: true,
    reason: 'game_started',
    source: 'parlay.starts_at',
    at: '2026-08-14T22:41:00.000Z',
  };
  startedPending.set('quote_started', {
    parlayId: 'pm-parlay',
    contracts: 10,
    maxContracts: 116,
    rfqId: 'rfq_started',
    label: 'PM Sox/Pirates',
    starts_at: '2026-08-14T22:41:00.000Z',
    legs: pmParlay.legs,
    leg_keys: pmParlay.leg_keys,
  });
  const loopStarted = startPolymarketRfqLoop({
    env: {
      POLYMARKET_KEY_ID: 'key-id-fixture',
      POLYMARKET_SECRET_KEY: SEED_B64,
      POLYMARKET_RFQ_LIVE: 'true',
    },
    http: startedHttp,
    startWs: false,
    getParlays: () => [{ ...pmParlay, starts_at: '2026-08-14T22:41:00.000Z' }],
    startedFor: () => startedHit,
    filledSoFarFor: () => 0,
    getOutstanding: () => 0,
    pendingQuotes: startedPending,
    reconcileMs: 60 * 60 * 1000,
  });
  const accStarted = await loopStarted.handleQuoteAccepted({
    quote: { id: 'quote_started', rfqId: 'rfq_started', acceptedSide: 'SIDE_BUY' },
  });
  assert.strictEqual(accStarted.confirmed, false);
  assert.strictEqual(accStarted.reason, 'game_started');
  assert.strictEqual(startedConfirms.length, 0);
  assert.deepStrictEqual(startedDeletes, [{ rfqId: 'rfq_started', quoteId: 'quote_started' }]);
  assert.ok(!startedPending.has('quote_started'));
  loopStarted.stop();

  // Cancel-on-start: resting quote for a started lock is deleted (Kalshi analog).
  const cancelDeletes = [];
  const cancelHttp = {
    async getUserId() { return { rfqUserId: 'rfquser_test' }; },
    async listRfqs() { return { rfqs: [] }; },
    async listQuotes() { return { quotes: [] }; },
    async getCombo() { return { combos: [] }; },
    async createQuote() { return { quoteId: 'quote_rest' }; },
    async confirmQuote() { return {}; },
    async deleteQuote(rfqId, quoteId) {
      cancelDeletes.push({ rfqId, quoteId });
      return { statusCode: 200 };
    },
    close() {},
  };
  const resting = new Map();
  resting.set('quote_rest', {
    parlayId: 'pm-parlay',
    contracts: 10,
    maxContracts: 116,
    rfqId: 'rfq_rest',
    label: 'PM Sox/Pirates',
    starts_at: '2026-08-14T22:41:00.000Z',
  });
  resting.set('quote_other', {
    parlayId: 'other-lock',
    contracts: 5,
    maxContracts: 50,
    rfqId: 'rfq_other',
    label: 'Still pregame',
  });
  const loopCancel = startPolymarketRfqLoop({
    env: {
      POLYMARKET_KEY_ID: 'key-id-fixture',
      POLYMARKET_SECRET_KEY: SEED_B64,
      POLYMARKET_RFQ_LIVE: 'true',
    },
    http: cancelHttp,
    startWs: false,
    getParlays: () => [
      { ...pmParlay, starts_at: '2026-08-14T22:41:00.000Z' },
      { id: 'other-lock', label: 'Still pregame' },
    ],
    startedFor: (p) => (p && p.id === 'pm-parlay' ? startedHit : { started: false }),
    filledSoFarFor: () => 0,
    getOutstanding: () => 0,
    pendingQuotes: resting,
    reconcileMs: 60 * 60 * 1000,
  });
  await loopCancel.cancelStartedQuotes();
  assert.deepStrictEqual(cancelDeletes, [{ rfqId: 'rfq_rest', quoteId: 'quote_rest' }]);
  assert.ok(!resting.has('quote_rest'));
  assert.ok(resting.has('quote_other'));

  // New RFQ for a started lock also cancels that lock's resting quotes.
  resting.set('quote_rest2', {
    parlayId: 'pm-parlay',
    contracts: 10,
    maxContracts: 116,
    rfqId: 'rfq_rest2',
    label: 'PM Sox/Pirates',
    starts_at: '2026-08-14T22:41:00.000Z',
  });
  const skipStarted = await loopCancel.handleRfq({ ...pmRfq, id: 'rfq_after_start' });
  assert.strictEqual(skipStarted.action, 'skip');
  assert.strictEqual(skipStarted.reason, 'game_started');
  assert.ok(cancelDeletes.some((d) => d.quoteId === 'quote_rest2'));
  assert.ok(!resting.has('quote_rest2'));
  assert.ok(resting.has('quote_other'));
  loopCancel.stop();

  const lru = createMarketCache({
    maxEntries: 2,
    fetchMarket: async (slug) => ({ slug }),
  });
  await lru.get('a');
  await lru.get('b');
  await lru.get('c');
  assert.strictEqual(lru._map.size, 2);
  assert.ok(!lru.peek('a'));
  assert.ok(lru.peek('b'));
  assert.ok(lru.peek('c'));

  let firehoseFetches = 0;
  let firehoseList = 0;
  let firehoseCombo = 0;
  const firehoseHttp = {
    async getUserId() { return { rfqUserId: 'rfquser_test' }; },
    async listRfqs() { firehoseList += 1; return { rfqs: [] }; },
    async listQuotes() { return { quotes: [] }; },
    async getCombo() { firehoseCombo += 1; return { combos: [] }; },
    async createQuote(body) {
      posts.push(body);
      return { quoteId: 'quote_posted' };
    },
    async confirmQuote() { return {}; },
    async deleteQuote() { return { statusCode: 200 }; },
    close() {},
  };
  let currentLocks = [];
  const firehoseLoop = startPolymarketRfqLoop({
    env: {
      POLYMARKET_KEY_ID: 'key-id-fixture',
      POLYMARKET_SECRET_KEY: SEED_B64,
      POLYMARKET_RFQ_LIVE: 'false',
    },
    http: firehoseHttp,
    startWs: false,
    getParlays: () => currentLocks,
    fetchMarket: async (slug) => {
      firehoseFetches += 1;
      return lockMarkets.get(slug) || null;
    },
    startedFor: () => ({ started: false }),
    filledSoFarFor: () => 0,
    getOutstanding: () => 0,
    pendingQuotes: new Map(),
    reconcileMs: 60 * 60 * 1000,
  });
  const listAfterStart = firehoseList;

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); origLog(...args); };
  try {
    currentLocks = [kalshiParlay];
    const skipTennis = await firehoseLoop.handleRfq(tennisRfq);
    const skipLol = await firehoseLoop.handleRfq(lolRfq);
    const skipSoccer = await firehoseLoop.handleRfq(soccerRfq);
    const skipCs2 = await firehoseLoop.handleRfq(cs2Rfq);
    for (let i = 0; i < 40; i += 1) {
      await firehoseLoop.handleRfq({
        ...tennisRfq,
        id: `rfq_tennis_wall_${i}`,
      });
    }
    assert.strictEqual(skipTennis.reason, 'no_lock_overlap');
    assert.strictEqual(skipLol.reason, 'no_lock_overlap');
    assert.strictEqual(skipSoccer.reason, 'no_lock_overlap');
    assert.strictEqual(skipCs2.reason, 'no_lock_overlap');
    assert.strictEqual(firehoseFetches, 0);
    assert.strictEqual(firehoseCombo, 0);
    assert.strictEqual(firehoseList, listAfterStart);
    assert.strictEqual(firehoseLoop.marketCache._map.size, 0);
    assert.strictEqual(firehoseLoop.seenRfqs.size, 0);
    assert.ok(!logs.some((l) => l.includes('SKIP unmatched') && l.includes('legs=')));

    currentLocks = [];
    const noLocks = await firehoseLoop.handleRfq({ ...pmRfq, id: 'rfq_later_lock' });
    assert.strictEqual(noLocks.reason, 'no_locks');
    assert.strictEqual(firehoseFetches, 0);
    assert.strictEqual(firehoseLoop.seenRfqs.size, 0);

    currentLocks = [kalshiParlay];
    const later = await firehoseLoop.handleRfq({ ...pmRfq, id: 'rfq_later_lock' });
    assert.strictEqual(later.action, 'quoteable');
    assert.strictEqual(later.parlay.id, P);
    assert.ok(firehoseFetches >= 2);
    assert.ok(firehoseLoop.seenRfqs.has('rfq_later_lock'));
    assert.ok(firehoseLoop.seenRfqs.size <= 8);

    const again = await firehoseLoop.handleRfq({ ...pmRfq, id: 'rfq_later_lock' });
    assert.strictEqual(again.reason, 'seen');

    firehoseLoop.handleRfqClosed({ rfq: { id: 'rfq_later_lock' } });
    assert.ok(!firehoseLoop.seenRfqs.has('rfq_later_lock'));
  } finally {
    console.log = origLog;
    firehoseLoop.stop();
  }

  let hydrateList = 0;
  const hydrateHttp = {
    async getUserId() { return { rfqUserId: 'rfquser_test' }; },
    async listRfqs(query) {
      hydrateList += 1;
      if (query && query.rfqId === 'rfq_ws_bare') {
        return { rfqs: [{ ...pmRfq, id: 'rfq_ws_bare' }] };
      }
      if (query && query.rfqId === 'rfq_ws_tennis') {
        return { rfqs: [{ ...tennisRfq, id: 'rfq_ws_tennis' }] };
      }
      return { rfqs: [] };
    },
    async listQuotes() { return { quotes: [] }; },
    async getCombo() { throw new Error('getCombo should not run after listRfqs fills legs'); },
    async createQuote() { return { quoteId: 'x' }; },
    async confirmQuote() { return {}; },
    async deleteQuote() { return { statusCode: 200 }; },
    close() {},
  };
  let hydrateFetches = 0;
  const hydrateLoop = startPolymarketRfqLoop({
    env: {
      POLYMARKET_KEY_ID: 'key-id-fixture',
      POLYMARKET_SECRET_KEY: SEED_B64,
      POLYMARKET_RFQ_LIVE: 'false',
    },
    http: hydrateHttp,
    startWs: false,
    getParlays: () => [kalshiParlay],
    fetchMarket: async (slug) => {
      hydrateFetches += 1;
      return lockMarkets.get(slug) || null;
    },
    startedFor: () => ({ started: false }),
    filledSoFarFor: () => 0,
    getOutstanding: () => 0,
    pendingQuotes: new Map(),
    reconcileMs: 60 * 60 * 1000,
  });
  const listBeforeBare = hydrateList;
  const bareOut = await hydrateLoop.handleRfq({
    id: 'rfq_ws_bare',
    symbol: 'caoc-x',
    status: 'RFQ_STATUS_OPEN',
  });
  assert.strictEqual(bareOut.action, 'quoteable');
  assert.strictEqual(bareOut.parlay.id, P);
  assert.ok(hydrateList > listBeforeBare);
  assert.ok(hydrateFetches >= 2);

  const tennisBareFetches = hydrateFetches;
  const tennisBareList = hydrateList;
  const tennisBare = await hydrateLoop.handleRfq({
    id: 'rfq_ws_tennis',
    symbol: 'caoc-tennis',
    status: 'RFQ_STATUS_OPEN',
  });
  assert.strictEqual(tennisBare.reason, 'no_lock_overlap');
  assert.ok(hydrateList > tennisBareList);
  assert.strictEqual(hydrateFetches, tennisBareFetches);
  hydrateLoop.stop();

  // Unhedged shadow: in-scope unmatched persist; tennis / lock-match do not.
  const unhedgedRows = [];
  let unhedgedFetches = 0;
  const unhedgedLoop = startPolymarketRfqLoop({
    env: {
      POLYMARKET_KEY_ID: 'key-id-fixture',
      POLYMARKET_SECRET_KEY: SEED_B64,
      POLYMARKET_RFQ_LIVE: 'false',
    },
    http: {
      async getUserId() { return { rfqUserId: 'rfquser_test' }; },
      async listRfqs() { return { rfqs: [] }; },
      async listQuotes() { return { quotes: [] }; },
      async getCombo() { throw new Error('unhedged must not hydrate'); },
      async createQuote() { throw new Error('unhedged must not POST'); },
      async confirmQuote() { throw new Error('unhedged must not confirm'); },
      async deleteQuote() { return { statusCode: 200 }; },
      close() {},
    },
    startWs: false,
    getParlays: () => [kalshiParlay],
    fetchMarket: async (slug) => {
      unhedgedFetches += 1;
      return lockMarkets.get(slug) || null;
    },
    persistUnhedged: async (row) => { unhedgedRows.push(row); },
    startedFor: () => ({ started: false }),
    filledSoFarFor: () => 0,
    getOutstanding: () => 0,
    pendingQuotes: new Map(),
    reconcileMs: 60 * 60 * 1000,
  });
  await new Promise((r) => setTimeout(r, 15));
  const tennisShadow = await unhedgedLoop.handleRfq(tennisRfq);
  assert.strictEqual(tennisShadow.reason, 'no_lock_overlap');
  const threeMlb = await unhedgedLoop.handleRfq({
    id: 'rfq_unhedged_mlb3',
    status: 'RFQ_STATUS_OPEN',
    qtyDecimal: '8',
    comboLegs: [
      { symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'SIDE_BUY' },
      { symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'SIDE_BUY' },
      { symbol: 'aec-mlb-nyy-bal-2026-08-14-nyy', side: 'SIDE_BUY' },
    ],
  });
  assert.strictEqual(threeMlb.reason, 'no_lock_overlap');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(unhedgedFetches, 0);
  assert.ok(unhedgedRows.some((r) => r.rfq_id === 'rfq_unhedged_mlb3'));
  assert.ok(!unhedgedRows.some((r) => r.rfq_id === tennisRfq.id));
  const beforeLock = unhedgedRows.length;
  const lockShadow = await unhedgedLoop.handleRfq({ ...pmRfq, id: 'rfq_lock_not_unhedged' });
  assert.strictEqual(lockShadow.action, 'quoteable');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(unhedgedRows.length, beforeLock);
  unhedgedLoop.stop();

  const parsed = parsePrivateMessage(JSON.stringify({
    requestId: 'rfq-sub-1',
    subscriptionType: 'SUBSCRIPTION_TYPE_RFQ',
    rfqEvent: {
      rfqCreated: {
        rfq: { id: 'rfq_ws', symbol: 'caoc-x', status: 'RFQ_STATUS_OPEN' },
      },
    },
  }));
  assert.strictEqual(parsed.type, 'rfqCreated');
  assert.strictEqual(parsed.rfq.id, 'rfq_ws');

  console.log('polymarket-rfq.test.js ok');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
