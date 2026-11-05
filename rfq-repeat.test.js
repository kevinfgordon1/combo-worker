'use strict';
const assert = require('assert');
const { normalizeRfq } = require('./rfq');
const repeat = require('./rfq-repeat');
const {
  REPEAT_SKIP_REASON,
  compactNum,
  normalizedCreatorId,
  fingerprintRfq,
  isAnonymousFingerprint,
  creatorIdFromQuoteResponse,
} = repeat;

// Repeat-request cooldown removed (Kevin Nov 4 2026): no guard, no env knobs, no skip alert.
for (const gone of ['createRepeatGuard', 'cooldownFingerprint', 'readCooldownMs', 'readMaxQuotes', 'formatRepeatSkipAlert', 'DEFAULT_COOLDOWN_MS', 'DEFAULT_MAX_QUOTES']) {
  assert.strictEqual(repeat[gone], undefined, `${gone} must be gone`);
}

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

assert.strictEqual(REPEAT_SKIP_REASON, 'rfq_repeat');
assert.strictEqual(compactNum(6), '6');
assert.strictEqual(compactNum('6.00'), '6');
assert.strictEqual(compactNum(6.5), '6.5');
assert.strictEqual(compactNum(null), '');

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
  assert.ok(isAnonymousFingerprint(a));
}

{
  const withCreator = normalizeRfq(kalshiEnv('rfq-c', ariJaxLegs, {
    contracts: 6, creatorId: 'user-abc',
  }));
  const empty = normalizeRfq(kalshiEnv('rfq-e', ariJaxLegs, {
    contracts: 6, creatorId: '   ',
  }));
  const missing = normalizeRfq(kalshiEnv('rfq-m', ariJaxLegs, { contracts: 6 }));
  assert.strictEqual(normalizedCreatorId(withCreator), 'user-abc');
  assert.strictEqual(normalizedCreatorId(empty), '');
  assert.strictEqual(normalizedCreatorId(missing), '');
  assert.ok(fingerprintRfq(withCreator).includes('|u=user-abc'));
  assert.strictEqual(fingerprintRfq(empty), fingerprintRfq(missing));
  assert.notStrictEqual(fingerprintRfq(withCreator), fingerprintRfq(missing));
  assert.ok(!isAnonymousFingerprint(fingerprintRfq(withCreator)));
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
  const alice = normalizeRfq(kalshiEnv('a', ariJaxLegs, { contracts: 6, creatorId: 'alice' }));
  const bob = normalizeRfq(kalshiEnv('b', ariJaxLegs, { contracts: 6, creatorId: 'bob' }));
  assert.notStrictEqual(fingerprintRfq(alice), fingerprintRfq(bob));
  assert.ok(fingerprintRfq(alice).includes('|u=alice'));
  assert.ok(fingerprintRfq(bob).includes('|u=bob'));
}

assert.strictEqual(fingerprintRfq({ contracts: 6 }), null);
assert.strictEqual(fingerprintRfq({ legKeys: [] }), null);
assert.strictEqual(fingerprintRfq(null), null);

{
  assert.strictEqual(creatorIdFromQuoteResponse(null), null);
  assert.strictEqual(creatorIdFromQuoteResponse({ id: 'q1' }), null);
  assert.strictEqual(creatorIdFromQuoteResponse({ id: 'q1', rfq_creator_id: 'rest-user' }), 'rest-user');
  assert.strictEqual(creatorIdFromQuoteResponse({ id: 'q1', creator_id: '  ' }), null);
  assert.strictEqual(creatorIdFromQuoteResponse({ quote: { rfq_creator_id: 'nested-q' } }), 'nested-q');
}

console.log('rfq-repeat.test.js ok');
