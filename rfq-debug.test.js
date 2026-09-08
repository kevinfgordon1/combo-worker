'use strict';
const assert = require('assert');
const {
  pickDollar, formatRfqDebugLine, pickLegs,
  hayContainsNeedle, readDebugNeedles, allowDebugLog, resetDebugLogBudget,
  DEBUG_LOG_BUDGET,
} = require('./rfq-debug');

{
  assert.strictEqual(pickDollar({ target_cost_dollars: '25.00' }, {}), '25.00');
  assert.strictEqual(pickDollar({}, { target_cost: '10' }), '10');
  assert.strictEqual(pickDollar({ contracts_fp: '5' }, {}), null);
}

{
  const contractLine = formatRfqDebugLine({
    rfqId: '79387ff8',
    collection: 'KXMVE',
    contracts: '5',
    dollar: null,
    legs: ['KXNFLGAME-26SEP13ARILAC-ARI:yes', 'KXNFLGAME-26SEP13CLEJAC-JAC:yes'],
  });
  assert.ok(contractLine.includes('contracts=5'));
  assert.ok(contractLine.includes('dollar=(none)'));

  const dollarLine = formatRfqDebugLine({
    rfqId: 'b3dc86cb',
    collection: 'KXMVE',
    contracts: null,
    dollar: '15.00',
    legs: ['KXNFLGAME-26SEP13ARILAC-ARI:yes'],
  });
  assert.ok(dollarLine.includes('contracts=(none)'));
  assert.ok(dollarLine.includes('dollar=15.00'), dollarLine);
}

{
  const legs = pickLegs({
    mve_selected_legs: [
      { market_ticker: 'KXNFLGAME-26SEP13ARILAC-ARI', side: 'yes' },
    ],
  });
  assert.strictEqual(legs.length, 1);
}

{
  const legs = [
    { market_ticker: 'KXNFLGAME-26SEP13NESEA-SEA', side: 'yes' },
    { market_ticker: 'KXNFLGAME-26SEP13WASPHI-PHI', side: 'yes' },
  ];
  assert.strictEqual(hayContainsNeedle(['NESEA'], null, null, legs), true);
  assert.strictEqual(hayContainsNeedle(['ARILAC'], null, null, legs), false);
  assert.strictEqual(hayContainsNeedle(['KXMVE'], 'KXMVE-X', null, null), true);
  assert.strictEqual(hayContainsNeedle(['NESEA'], null, 'KXNFLGAME-26SEP13NESEA-SEA', null), true);
}

{
  assert.strictEqual(readDebugNeedles({}), null);
  assert.strictEqual(readDebugNeedles({ RFQ_DEBUG_NEEDLE: '' }), null);
  assert.deepStrictEqual(readDebugNeedles({ RFQ_DEBUG_NEEDLE: 'NESEA, WASPHI' }), ['NESEA', 'WASPHI']);
}

{
  resetDebugLogBudget();
  const t0 = 1_700_000_000_000;
  let allowed = 0;
  for (let i = 0; i < DEBUG_LOG_BUDGET + 5; i++) {
    if (allowDebugLog(t0)) allowed += 1;
  }
  assert.strictEqual(allowed, DEBUG_LOG_BUDGET, 'RFQ-DEBUG must cap stdout per second');
  assert.ok(allowDebugLog(t0 + 1001), 'budget resets on the next window');
  resetDebugLogBudget();
}

console.log('rfq-debug.test.js ok');
