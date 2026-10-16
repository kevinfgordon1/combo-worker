'use strict';
const assert = require('assert');
const { createTdBook, parseTdTicker, vwapFor } = require('./td-book');
const { classifyNfl } = require('./shadow');

const t = parseTdTicker('KXNFLTD-26OCT18PITTB-PITKWETJEN10-1');
assert.strictEqual(t.gameId, 'nfl|2026-10-18|pit+tb');
assert.strictEqual(parseTdTicker('KXNFLTD-26OCT18PITTB-PITKWETJEN10-2'), null); // 2+ TDs not anytime
assert.strictEqual(vwapFor([[0.5, 100]], 500), null); // $50 of depth < $500
let now = 0;
const tb = createTdBook({ now: () => now });
tb.ingest([{ ticker: 'KXNFLTD-26OCT18PITTB-PITKWETJEN10-1', orderbook_fp: { yes_dollars: [['0.30', '5000']], no_dollars: [['0.65', '5000']] } }]);
const s = tb.legStats({ id: 'KXNFLTD-26OCT18PITTB-PITKWETJEN10-1', side: 'yes' });
// yes ask 0.35 (+fee 0.015925), no ask 0.70 (+fee 0.0147)
assert(Math.abs(s.lockCost - 0.365925) < 1e-9);
assert(Math.abs(s.inverse - (1 - 0.7147)) < 1e-9);
assert(Math.abs(s.mid - 0.365925 / (0.365925 + 0.7147)) < 1e-9);
const n = tb.legStats({ id: 'KXNFLTD-26OCT18PITTB-PITKWETJEN10-1', side: 'no' });
assert(Math.abs(n.mid + s.mid - 1) < 1e-9);
now = 20000; assert.strictEqual(tb.legStats({ id: 'KXNFLTD-26OCT18PITTB-PITKWETJEN10-1', side: 'yes' }), null); // stale
tb.ingest([{ ticker: 'KXNFLTD-26OCT18NYJNE-NYJGWILSON5-1', orderbook_fp: { yes_dollars: [['0.30', '10']], no_dollars: [['0.65', '5000']] } }]);
assert.strictEqual(tb.legStats({ id: 'KXNFLTD-26OCT18NYJNE-NYJGWILSON5-1', side: 'yes' }), null); // thin No side
assert.strictEqual(tb.takeFails().depth, 1);

const legs = ['KXNFLTD-26OCT18PITTB-PITKWETJEN10-1:yes', 'KXNFLGAME-26OCT18NYJNE-NE:yes'];
assert.strictEqual(classifyNfl({ legKeys: legs }, 'kalshi').ok, false); // TD off by default
const c = classifyNfl({ legKeys: legs }, 'kalshi', { td: true });
assert(c.ok && c.legs[0].kind === 'td' && c.legs.length === 2);
const same = classifyNfl({ legKeys: ['KXNFLTD-26OCT18NYJNE-NYJGWILSON5-1:yes', 'KXNFLGAME-26OCT18NYJNE-NE:yes'] }, 'kalshi', { td: true });
assert.strictEqual(same.reason, 'correlated_same_game');
console.log('noboost/td-book.test.js ok');
