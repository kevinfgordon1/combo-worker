// Nov 2 2026: kaygo-sniper 409 quote_timed_out. Dollar RFQs were quoted with yes_bid = 1 - no_bid,
// i.e. a YES bid ABOVE fair by our whole edge; requesters accepted that side, the sniper declined
// (it only sells parlays) and Kalshi put the maker in a ~4-5 min quote timeout per decline.
// The YES bid is now shaded to fair * (1 - SNIPER_YES_BID_SHADE).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../engine');
const { createSniperTrader } = require('./trader');
const TEST_PEM = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

// engine.shadedYesBid
// Real Nov 2 quote: fair YES 5.36% (+1765), we sell YES at 12.8c (+681), NO bid 0.870 -> old YES bid 0.130.
assert.strictEqual(E.shadedYesBid('0.130', 0.0536, 0.08, '0.870'), '0.049');
assert.strictEqual(E.shadedYesBid('0.13', 0.0536, 0.08, '0.87'), '0.04');
// Never above the implied YES (yes + no <= $1)
assert.strictEqual(E.shadedYesBid('0.30', 0.9, 0.08, '0.70'), '0.30');
// Never below 1c
assert.strictEqual(E.shadedYesBid('0.05', 0.005, 0.08, '0.95'), '0.01');
// Off / bad inputs -> unchanged
assert.strictEqual(E.shadedYesBid('0.130', 0.0536, 0, '0.870'), '0.130');
assert.strictEqual(E.shadedYesBid('0.130', null, 0.08, '0.870'), '0.130');
assert.strictEqual(E.shadedYesBid('0.130', 1.2, 0.08, '0.870'), '0.130');
assert.strictEqual(E.shadedYesBid(E.YES_DECLINE, 0.2, 0.08, '0.70'), E.YES_DECLINE);
// Accept rule unchanged: a real YES bid still confirms only the NO side.
assert.strictEqual(E.shouldConfirmAccept('0.049', 'yes'), false);
assert.strictEqual(E.shouldConfirmAccept('0.049', 'no'), true);

// trader.postQuote body
(async () => {
  const bodies = [];
  const mk = (yesShade) => createSniperTrader({ gate: { live: true }, keyId: 'test-key', pem: TEST_PEM, subaccount: 1, log: () => {}, yesShade,
    request: async ({ body }) => { bodies.push(JSON.parse(body)); return { statusCode: 201, headers: {}, text: '{"id":"q1"}' }; } });
  const rfqDollar = { rfqId: 'R1', createdTs: new Date().toISOString() };
  const rfqCount = { rfqId: 'R2', createdTs: new Date().toISOString(), contracts: 10 };

  let r = await mk(0.08).postQuote(rfqDollar, 0.128, 0.001, { fairYes: 0.0536 });
  assert.deepStrictEqual([bodies[0].no_bid, bodies[0].yes_bid, r.yesBid], ['0.872', '0.049', '0.049']);
  // shade off (code default) = old behaviour: implied YES
  r = await mk(0).postQuote(rfqDollar, 0.128, 0.001, { fairYes: 0.0536 });
  assert.deepStrictEqual([bodies[1].no_bid, bodies[1].yes_bid], ['0.872', '0.128']);
  // no fair passed -> unchanged
  await mk(0.08).postQuote(rfqDollar, 0.128, 0.001, {});
  assert.strictEqual(bodies[2].yes_bid, '0.128');
  // contract-count RFQ: YES still declined with 0.00
  await mk(0.08).postQuote(rfqCount, 0.128, 0.001, { fairYes: 0.0536 });
  assert.strictEqual(bodies[3].yes_bid, '0.00');

  // prod toml turns it on at 8%
  const toml = fs.readFileSync(path.join(__dirname, '../fly/sniper.toml'), 'utf8');
  assert.strictEqual((toml.match(/^\s*SNIPER_YES_BID_SHADE\s*=\s*"([^"]+)"/m) || [])[1], '0.08');
  console.log('yes-shade ok');
})().catch((e) => { console.error(e); process.exit(1); });
