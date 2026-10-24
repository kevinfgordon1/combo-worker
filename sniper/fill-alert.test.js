'use strict';
const assert = require('assert');
const { formatFillAlert, legLabel, american } = require('./fill-alert');
assert.strictEqual(legLabel('KXNFLGAME-26OCT25CINBAL-CIN', 'yes'), 'CIN to win · CIN @ BAL');
assert.strictEqual(legLabel('KXNFLGAME-26OCT25CINBAL-BAL', 'no'), 'BAL to win (No) · CIN @ BAL');
assert.strictEqual(legLabel('KXNFLTD-26OCT25CINBAL-BALDHENRY22-1', 'no'), 'D. Henry anytime TD (No) · CIN @ BAL');
assert.strictEqual(legLabel('KXNFLTD-26OCT22NECHI-NEDMAYE10-1', 'no', 'Drake Maye: 1+ touchdowns'), 'Drake Maye anytime TD (No) · NE @ CHI');
assert.strictEqual(american(0.25), '+300'); assert.strictEqual(american(0.6), '-150');
const ko = { 'KXNFLGAME-26OCT25INDMIN-MIN': Date.parse('2026-10-25T17:00:00Z'), 'KXNFLGAME-26OCT22NECHI-NE': Date.parse('2026-10-23T00:15:00Z') };
const msg = formatFillAlert({
  d: { fairYes: 0.4147, quoteYes: 0.432, legDetail: [
    { ticker: 'KXNFLGAME-26OCT25INDMIN-MIN', side: 'yes', fair: 0.6, venue: 'novig', depthUsd: 2450 },
    { ticker: 'KXNFLGAME-26OCT22NECHI-NE', side: 'yes', fair: 0.6912, venue: 'kalshi', depthUsd: 1310.4 }] },
  contracts: 41, cost: 23.288, fee: 0, kickoffOf: (t) => ko[t],
});
assert.ok(msg.includes('1. MIN to win\n    IND @ MIN · Sun 1:00 PM ET'), msg);
assert.ok(msg.includes('NE @ CHI · Thu 8:15 PM ET'));
assert.ok(msg.includes('fair -150 · from opp IND +150 · $2,450 deep (to win) · Novig'), msg);
assert.ok(msg.includes('Parlay fair: +141'));
assert.ok(msg.includes('We sold at: +131'));
assert.ok(msg.includes('Risk: $23.29  →  To win: $17.71'));
assert.ok(/Edge: 3\.\d%/.test(msg), msg);
assert.ok(!/KXMVE|rfq|0\.\d{3}/.test(msg), 'no ids, tickers or decimal prices');
assert.ok(formatFillAlert({ d: { fairYes: 0.3, legs: ['KXNFLGAME-26OCT25CINBAL-CIN:yes'] }, contracts: 10, cost: 6.8 }).includes('CIN to win'));
assert.strictEqual(legLabel('KXNFLSPREAD-26OCT25NYGHOU-HOU11', 'no'), 'Texans -10.5 — No (Giants +10.5) · NYG @ HOU');
assert.strictEqual(legLabel('KXNFLSPREAD-26OCT25NYGHOU-HOU11', 'yes'), 'Texans -10.5 · NYG @ HOU');
assert.strictEqual(legLabel('KXNFLTOTAL-26OCT26DALPHI-45', 'no'), 'DAL @ PHI Over/Under 44.5 — Under · DAL @ PHI');
{ const m = formatFillAlert({ d: { fairYes: 0.3, legDetail: [
    { ticker: 'KXNFLSPREAD-26OCT25NYGHOU-HOU11', side: 'no', fair: 0.55, venue: 'kalshi', depthUsd: 3000 },
    { ticker: 'KXNFLTOTAL-26OCT26DALPHI-45', side: 'no', fair: 0.5, venue: 'novig', depthUsd: 2100 },
    { ticker: 'KXNFLTD-26OCT25CINBAL-BALDHENRY22-1', side: 'no', fair: 0.6, venue: 'novig', depthUsd: 1200 }] }, contracts: 10, cost: 7 });
  assert.ok(m.includes('from opp HOU -10.5 +122'), m); assert.ok(m.includes('from opp Over 44.5 -100'), m); assert.ok(m.includes('from opp TD Yes +150'), m); }
console.log('sniper/fill-alert.test.js ok');
