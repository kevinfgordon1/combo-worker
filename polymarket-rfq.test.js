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
  matchPolymarketParlay,
  evaluatePolymarketRfq,
  shouldPostNow,
  shouldConfirmNow,
  quoteBodyFromEval,
  startPolymarketRfqLoop,
} = require('./polymarket-rfq');

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
assert.strictEqual(skipped.reason, 'unmatched');
assert.strictEqual(matchPolymarketParlay(normalizePolymarketRfq(pmRfq), [kalshiParlay]), null);

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
assert.deepStrictEqual(shouldPostNow(skipped, { live: true }), { post: false, reason: 'unmatched' });

assert.strictEqual(shouldConfirmPolymarketAccept('SIDE_BUY'), true);
assert.strictEqual(shouldConfirmPolymarketAccept('SIDE_SELL'), false);
assert.deepStrictEqual(shouldConfirmNow('SIDE_BUY', { live: false }), { confirm: false, reason: 'live_off' });
assert.deepStrictEqual(shouldConfirmNow('SIDE_BUY', { live: true }), { confirm: true, reason: null });
assert.deepStrictEqual(shouldConfirmNow('SIDE_SELL', { live: true }), { confirm: false, reason: 'side_not_buy' });
assert.deepStrictEqual(shouldConfirmNow('sell', { live: true }), { confirm: false, reason: 'side_not_buy' });

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
