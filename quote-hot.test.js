'use strict';
const assert = require('assert');
const {
  teamPairFromTicker,
  aliasTeamPairs,
  needlesFromTicker,
  lockNeedlesFromParlays,
  rawLooksLikeLock,
  createQuoteHot,
} = require('./quote-hot');

const seaPhiLar = {
  id: 'sea-phi-lar',
  label: 'SEA + PHI + LAR',
  leg_keys: [
    'KXNFLGAME-26SEP13NESEA-SEA:yes',
    'KXNFLGAME-26SEP13SFLAR-LAR:yes',
    'KXNFLGAME-26SEP13WASPHI-PHI:yes',
  ],
};

const ariJac = {
  id: 'ari-jac',
  label: 'Arizona + Jacksonville',
  leg_keys: [
    'KXNFLGAME-26SEP13ARILAC-ARI:yes',
    'KXNFLGAME-26SEP13CLEJAC-JAC:yes',
  ],
};

assert.strictEqual(teamPairFromTicker('KXNFLGAME-26SEP13NESEA-SEA:yes'), 'NESEA');
assert.strictEqual(teamPairFromTicker('KXNFLGAME-26SEP131330NESEA-SEA:yes'), 'NESEA');
assert.strictEqual(teamPairFromTicker('KXNFLGAME-26SEP13CLEJAC-JAC:yes'), 'CLEJAC');
assert.strictEqual(teamPairFromTicker('KXNFLSPREAD-26SEP13CARNE-NE3:yes'), 'CARNE');
assert.strictEqual(teamPairFromTicker(''), null);

{
  const aliased = aliasTeamPairs('CLEJAC');
  assert.ok(aliased.includes('CLEJAC'));
  assert.ok(aliased.includes('CLEJAX'), 'JAC/JAX lock vs RFQ ticker');
}

{
  const n = new Set(needlesFromTicker('KXNFLGAME-26SEP13CLEJAC-JAC:yes'));
  assert.ok(n.has('CLEJAC'));
  assert.ok(n.has('CLEJAX'));
  assert.ok(![...n].some((x) => x.length < 4), 'no 2-3 letter team-code needles');
}

{
  const needles = lockNeedlesFromParlays([seaPhiLar, ariJac]);
  assert.ok(needles.includes('NESEA'));
  assert.ok(needles.includes('WASPHI'));
  assert.ok(needles.includes('SFLAR'));
  assert.ok(needles.includes('ARILAC'));
  assert.ok(needles.includes('CLEJAC'));
  assert.ok(!needles.includes('SEA'), '3-letter label tokens must not be needles');
  assert.ok(!needles.includes('PHI'));
  assert.ok(!needles.includes('LAR'));
}

{
  const needles = lockNeedlesFromParlays([seaPhiLar]);
  const timed = JSON.stringify({
    type: 'rfq_created',
    msg: {
      mve_selected_legs: [
        { market_ticker: 'KXNFLGAME-26SEP131330NESEA-SEA', side: 'yes' },
        { market_ticker: 'KXNFLGAME-26SEP131330WASPHI-PHI', side: 'yes' },
        { market_ticker: 'KXNFLGAME-26SEP131330SFLAR-LAR', side: 'yes' },
      ],
    },
  });
  assert.strictEqual(rawLooksLikeLock(timed, needles), true, 'HHMM RFQ still hits date-only pair');

  const other = JSON.stringify({
    type: 'rfq_created',
    msg: {
      mve_selected_legs: [
        { market_ticker: 'KXNFLGAME-26SEP13ARILAC-ARI', side: 'yes' },
        { market_ticker: 'KXNFLGAME-26SEP13CLEJAC-JAC', side: 'yes' },
      ],
    },
  });
  assert.strictEqual(rawLooksLikeLock(other, needles), false);
}

{
  const hot = createQuoteHot();
  assert.strictEqual(hot.shouldDeferCreated('{"type":"rfq_created","msg":{"x":"NESEA"}}'), false);
  hot.begin();
  assert.strictEqual(hot.inFlight, 1);
  assert.strictEqual(
    hot.shouldDeferCreated('{"type":"rfq_created","msg":{"x":"NESEA"}}'),
    false,
    'empty needles must not defer — would hide the matching lock'
  );
  hot.setNeedles(lockNeedlesFromParlays([seaPhiLar]));
  assert.strictEqual(hot.shouldDeferCreated('{"type":"rfq_created","legs":"KXNFLGAME-26SEP13BOSTON-BOS"}'), true);
  assert.strictEqual(hot.shouldDeferCreated('{"type":"rfq_created","legs":"KXNFLGAME-26SEP131330NESEA-SEA"}'), false);
  hot.end();
  assert.strictEqual(hot.inFlight, 0);
  assert.strictEqual(hot.shouldDeferCreated('{"type":"rfq_created","legs":"KXNFLGAME-26SEP13BOSTON-BOS"}'), false);
}

{
  const hot = createQuoteHot();
  hot.begin();
  hot.begin();
  hot.end();
  assert.strictEqual(hot.inFlight, 1);
  hot.end();
  hot.end();
  assert.strictEqual(hot.inFlight, 0);
}

console.log('quote-hot.test.js ok');
