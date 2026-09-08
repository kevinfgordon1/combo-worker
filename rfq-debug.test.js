'use strict';
const assert = require('assert');
const { pickDollar, formatRfqDebugLine, pickLegs } = require('./rfq-debug');

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

console.log('rfq-debug.test.js ok');
