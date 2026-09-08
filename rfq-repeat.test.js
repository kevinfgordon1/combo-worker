'use strict';
const assert = require('assert');
const { normalizeRfq } = require('./rfq');
const {
  DEFAULT_COOLDOWN_MS,
  REPEAT_SKIP_REASON,
  compactNum,
  normalizedCreatorId,
  fingerprintRfq,
  cooldownFingerprint,
  isAnonymousFingerprint,
  creatorIdFromQuoteResponse,
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
  assert.ok(isAnonymousFingerprint(a));
  assert.strictEqual(
    cooldownFingerprint(normalizeRfq(kalshiEnv('rfq-1', ariJaxLegs, { contracts: 6 }))),
    null,
    'anonymous History fingerprint must not be a cooldown key'
  );
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
  assert.strictEqual(cooldownFingerprint(empty), null);
  assert.strictEqual(cooldownFingerprint(missing), null);
  assert.strictEqual(cooldownFingerprint(withCreator), fingerprintRfq(withCreator));
  assert.ok(!isAnonymousFingerprint(cooldownFingerprint(withCreator)));
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
  assert.notStrictEqual(cooldownFingerprint(alice), cooldownFingerprint(bob));
  assert.ok(cooldownFingerprint(alice).includes('|u=alice'));
  assert.ok(cooldownFingerprint(bob).includes('|u=bob'));
}

assert.strictEqual(fingerprintRfq({ contracts: 6 }), null);
assert.strictEqual(fingerprintRfq({ legKeys: [] }), null);
assert.strictEqual(fingerprintRfq(null), null);
assert.strictEqual(cooldownFingerprint({ contracts: 6, creatorId: 'x' }), null);
assert.strictEqual(cooldownFingerprint(null), null);

{
  assert.strictEqual(creatorIdFromQuoteResponse(null), null);
  assert.strictEqual(creatorIdFromQuoteResponse({ id: 'q1' }), null);
  assert.strictEqual(creatorIdFromQuoteResponse({ id: 'q1', rfq_creator_id: 'rest-user' }), 'rest-user');
  assert.strictEqual(creatorIdFromQuoteResponse({ id: 'q1', creator_id: '  ' }), null);
  assert.strictEqual(creatorIdFromQuoteResponse({ quote: { rfq_creator_id: 'nested-q' } }), 'nested-q');
}

{
  let t = 1_000_000;
  const g = createRepeatGuard({ cooldownMs: 90_000, now: () => t });
  const anon = fingerprintRfq(normalizeRfq(kalshiEnv('anon-1', ariJaxLegs, { contracts: 6 })));
  assert.ok(isAnonymousFingerprint(anon));
  assert.strictEqual(g.claim(anon).skip, false);
  assert.strictEqual(g.claim(anon).skip, false, 'anonymous identical RFQs must all quote');
  assert.strictEqual(g.claim(null).skip, false);
  assert.strictEqual(g.claim('').skip, false);
  assert.strictEqual(g.size, 0, 'anonymous claims must not occupy the cooldown map');
}

{
  let t = 1_000_000;
  const g = createRepeatGuard({ cooldownMs: 90_000, now: () => t });
  const alice = cooldownFingerprint(normalizeRfq(kalshiEnv('a1', ariJaxLegs, {
    contracts: 6, creatorId: 'alice',
  })));
  const bob = cooldownFingerprint(normalizeRfq(kalshiEnv('b1', ariJaxLegs, {
    contracts: 6, creatorId: 'bob',
  })));
  const first = g.claim(alice);
  assert.strictEqual(first.skip, false);
  assert.strictEqual(first.gated, true);
  const second = g.claim(alice);
  assert.strictEqual(second.skip, true);
  assert.strictEqual(second.alert, true, 'Telegram once when creator-gated cooldown applies');
  assert.strictEqual(second.skipCount, 1);
  assert.strictEqual(second.remainingMs, 90_000);
  const third = g.claim(alice);
  assert.strictEqual(third.skip, true);
  assert.strictEqual(third.alert, false, 'Telegram only once per cooldown window');
  assert.strictEqual(third.skipCount, 2);

  const otherSize = g.claim(cooldownFingerprint(normalizeRfq(kalshiEnv('a10', ariJaxLegs, {
    contracts: 10, creatorId: 'alice',
  }))));
  assert.strictEqual(otherSize.skip, false, 'distinct contracts must still quote');

  const otherUser = g.claim(bob);
  assert.strictEqual(otherUser.skip, false, 'different known creators must not share cooldown');

  t += 90_000;
  const after = g.claim(alice);
  assert.strictEqual(after.skip, false, 'same creator+fingerprint quotes again after cooldown');
}

{
  const g = createRepeatGuard({ cooldownMs: 0, now: () => 5 });
  const fp = cooldownFingerprint(normalizeRfq(kalshiEnv('x', ariJaxLegs, {
    contracts: 6, creatorId: 'alice',
  })));
  assert.ok(fp);
  assert.strictEqual(g.claim(fp).skip, false);
  assert.strictEqual(g.claim(fp).skip, false, '0 disables cooldown even when creator is known');
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
