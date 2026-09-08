'use strict';
const assert = require('assert');
const { normalizeRfq } = require('./rfq');
const {
  DEFAULT_COOLDOWN_MS,
  REPEAT_SKIP_REASON,
  compactNum,
  fingerprintRfq,
  readCooldownMs,
  formatRepeatSkipAlert,
  createRepeatGuard,
} = require('./rfq-repeat');

function kalshiEnv(id, legs, extra = {}) {
  return {
    type: 'rfq_created',
    msg: {
      id,
      contracts_fp: extra.contracts != null ? extra.contracts : '6.00',
      target_cost_dollars: extra.targetCost,
      creator_id: extra.creatorId,
      mve_collection_ticker: extra.collection || 'KXMVESPORTSMULTIGAMEEXTENDED-R',
      mve_selected_legs: legs,
    },
  };
}

const ariJaxLegs = [
  { side: 'yes', market_ticker: 'KXNFLGAME-26SEP131320CLEJAC-JAC' },
  { side: 'yes', market_ticker: 'KXNFLGAME-26SEP131320ARILAC-ARI' },
];
const seaPhiLegs = [
  { side: 'yes', market_ticker: 'KXNFLGAME-26SEP13NESEA-SEA' },
  { side: 'yes', market_ticker: 'KXNFLGAME-26SEP13WASPHI-PHI' },
];

assert.strictEqual(DEFAULT_COOLDOWN_MS, 90_000);
assert.strictEqual(REPEAT_SKIP_REASON, 'rfq_repeat');
assert.strictEqual(compactNum(6), '6');
assert.strictEqual(compactNum('6.00'), '6');
assert.strictEqual(compactNum(6.5), '6.5');
assert.strictEqual(compactNum(null), '');

assert.strictEqual(readCooldownMs({}), 90_000);
assert.strictEqual(readCooldownMs({ RFQ_REPEAT_COOLDOWN_MS: '' }), 90_000);
assert.strictEqual(readCooldownMs({ RFQ_REPEAT_COOLDOWN_MS: '120000' }), 120_000);
assert.strictEqual(readCooldownMs({ RFQ_REPEAT_COOLDOWN_MS: '0' }), 0);
assert.strictEqual(readCooldownMs({ RFQ_REPEAT_COOLDOWN_MS: '-5' }), 90_000);
assert.strictEqual(readCooldownMs({ RFQ_REPEAT_COOLDOWN_MS: 'nope' }), 90_000);

{
  const a = fingerprintRfq(normalizeRfq(kalshiEnv('rfq-1', ariJaxLegs, { contracts: '6.00' })));
  const b = fingerprintRfq(normalizeRfq(kalshiEnv('rfq-2', [...ariJaxLegs].reverse(), { contracts: 6 })));
  assert.ok(a);
  assert.strictEqual(a, b, 'sorted legs + compact contracts must match without creator');
  assert.ok(a.startsWith('v1|'));
  assert.ok(a.includes('KXNFLGAME-26SEP131320ARILAC-ARI:yes'));
  assert.ok(a.includes('KXNFLGAME-26SEP131320CLEJAC-JAC:yes'));
  assert.ok(a.includes('|c=6|'));
  assert.ok(a.endsWith('|u='), 'empty creator_id must not invent a user');
}

{
  const withCreator = fingerprintRfq(normalizeRfq(kalshiEnv('rfq-c', ariJaxLegs, {
    contracts: 6, creatorId: 'user-abc',
  })));
  const empty = fingerprintRfq(normalizeRfq(kalshiEnv('rfq-e', ariJaxLegs, {
    contracts: 6, creatorId: '   ',
  })));
  const missing = fingerprintRfq(normalizeRfq(kalshiEnv('rfq-m', ariJaxLegs, { contracts: 6 })));
  assert.ok(withCreator.includes('|u=user-abc'));
  assert.strictEqual(empty, missing);
  assert.notStrictEqual(withCreator, missing);
}

{
  const six = fingerprintRfq(normalizeRfq(kalshiEnv('rfq-6', ariJaxLegs, { contracts: 6 })));
  const ten = fingerprintRfq(normalizeRfq(kalshiEnv('rfq-10', ariJaxLegs, { contracts: 10 })));
  const dollar = fingerprintRfq(normalizeRfq({
    type: 'rfq_created',
    msg: {
      id: 'rfq-$',
      target_cost_dollars: '25.00',
      mve_collection_ticker: 'KXMVESPORTSMULTIGAMEEXTENDED-R',
      mve_selected_legs: ariJaxLegs,
    },
  }));
  const otherLegs = fingerprintRfq(normalizeRfq(kalshiEnv('rfq-sea', seaPhiLegs, { contracts: 6 })));
  assert.notStrictEqual(six, ten);
  assert.notStrictEqual(six, dollar);
  assert.notStrictEqual(six, otherLegs);
  assert.ok(dollar.includes('|t=25|'));
  assert.ok(dollar.includes('|c=|'));
}

{
  const twoCreators = [
    fingerprintRfq(normalizeRfq(kalshiEnv('a', ariJaxLegs, { contracts: 6, creatorId: 'alice' }))),
    fingerprintRfq(normalizeRfq(kalshiEnv('b', ariJaxLegs, { contracts: 6, creatorId: 'bob' }))),
  ];
  assert.notStrictEqual(twoCreators[0], twoCreators[1]);
}

assert.strictEqual(fingerprintRfq({ contracts: 6 }), null);
assert.strictEqual(fingerprintRfq({ legKeys: [] }), null);
assert.strictEqual(fingerprintRfq(null), null);

{
  let t = 1_000_000;
  const g = createRepeatGuard({ cooldownMs: 90_000, now: () => t });
  const fp = 'v1|ARI:yes,JAC:yes|c=6|t=|u=';
  const first = g.claim(fp);
  assert.strictEqual(first.skip, false);
  const second = g.claim(fp);
  assert.strictEqual(second.skip, true);
  assert.strictEqual(second.alert, true);
  assert.strictEqual(second.skipCount, 1);
  assert.strictEqual(second.remainingMs, 90_000);
  const third = g.claim(fp);
  assert.strictEqual(third.skip, true);
  assert.strictEqual(third.alert, false, 'Telegram only once per cooldown window');
  assert.strictEqual(third.skipCount, 2);

  const other = g.claim('v1|ARI:yes,JAC:yes|c=10|t=|u=');
  assert.strictEqual(other.skip, false, 'distinct contracts must still quote');

  t += 90_000;
  const after = g.claim(fp);
  assert.strictEqual(after.skip, false, 'same fingerprint quotes again after cooldown');
}

{
  const g = createRepeatGuard({ cooldownMs: 0, now: () => 5 });
  const fp = 'v1|x|c=6|t=|u=';
  assert.strictEqual(g.claim(fp).skip, false);
  assert.strictEqual(g.claim(fp).skip, false, '0 disables cooldown');
}

{
  const g = createRepeatGuard({ cooldownMs: 90_000, now: () => 1 });
  assert.strictEqual(g.claim(null).skip, false);
  assert.strictEqual(g.claim('').skip, false);
}

{
  const text = formatRepeatSkipAlert({
    label: 'Arizona + Jacksonville',
    contracts: 6,
    cooldownMs: 90_000,
    skipCount: 1,
  });
  assert.ok(text.includes('⏭️ RFQ REPEAT — Arizona + Jacksonville'));
  assert.ok(text.includes('same 6-contract fingerprint'));
  assert.ok(text.includes('cooling 90s'));
  assert.ok(text.includes('Miss tape: rfq_repeat'));
  assert.ok(!text.includes('×1'));
}

console.log('rfq-repeat.test.js ok');
