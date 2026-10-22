'use strict';
const assert = require('assert');
const { formatFillAlert, legLabel, american } = require('./fill-alert');
assert.strictEqual(legLabel('KXNFLGAME-26OCT25CINBAL-CIN', 'yes'), 'CIN to beat BAL · Moneyline · Yes');
assert.strictEqual(legLabel('KXNFLGAME-26OCT25CINBAL-BAL', 'no'), 'BAL to beat CIN · Moneyline · No');
assert.strictEqual(legLabel('KXNFLTD-26OCT25CINBAL-BALDHENRY22-1', 'no'), 'D. Henry (BAL) · Anytime TD · No');
assert.strictEqual(legLabel('KXNFLTD-26OCT25CINBAL-BALDHENRY22-1', 'yes', 'Derrick Henry: 1+ touchdowns'), 'Derrick Henry (BAL) · Anytime TD · Yes');
assert.strictEqual(american(0.25), '+300'); assert.strictEqual(american(0.6), '-150');
const msg = formatFillAlert({
  d: { fairYes: 0.4147, quoteYes: 0.432, legDetail: [
    { ticker: 'KXNFLGAME-26OCT25INDMIN-MIN', side: 'yes', fair: 0.6, venue: 'novig', depthUsd: 2450 },
    { ticker: 'KXNFLGAME-26OCT25SFATL-SF', side: 'yes', fair: 0.6912, venue: 'kalshi', depthUsd: 1310.4 }] },
  rfq: { marketTicker: 'KXMVECROSSCATEGORY0-X' }, contracts: 41, cost: 23.288, fee: 0,
});
assert.ok(msg.includes('1. MIN to beat IND · Moneyline · Yes'));
assert.ok(msg.includes('fair -150 · $2,450 deep · Novig'));
assert.ok(msg.includes('fair -224 · $1,310 deep · Kalshi'));
assert.ok(msg.includes('Parlay fair: +141'));
assert.ok(msg.includes('Sold at: +131  (we hold No at -131)'));
assert.ok(msg.includes('Risk: $23.29  →  To win: $17.71'));
assert.ok(/Edge: 3\.\d%/.test(msg), msg);
// old decisions without legDetail still render
assert.ok(formatFillAlert({ d: { fairYes: 0.3, legs: ['KXNFLGAME-26OCT25CINBAL-CIN:yes'] }, contracts: 10, cost: 6.8 }).includes('CIN to beat BAL'));
console.log('sniper/fill-alert.test.js ok');
