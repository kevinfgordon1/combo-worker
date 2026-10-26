'use strict';
const assert = require('assert');
const { maxLegDaysCheck } = require('./engine');
const { createCandidateFilter } = require('./intake-filter');

const now = Date.parse('2026-10-26T05:00:00Z'); const D = 864e5;
const near = 'KXNFLGAME-26OCT26WASKC-KC:yes';      // tonight
const far = 'KXNFLGAME-26NOV08BUFKC-KC:yes';       // 13 days
const day8 = 'KXNCAAFGAME-26NOV03OSUMICH-OSU:yes'; // ticker date 8 days out
// known kickoffs
const ko = (m) => (t) => (t in m ? m[t] : null);
assert.strictEqual(maxLegDaysCheck([near], ko({ 'KXNFLGAME-26OCT26WASKC-KC': now + 0.6 * D }), now, 7), null);
assert.strictEqual(maxLegDaysCheck([near, far], ko({ 'KXNFLGAME-26OCT26WASKC-KC': now + D, 'KXNFLGAME-26NOV08BUFKC-KC': now + 13 * D }), now, 7), 'leg_beyond_max_days');
assert.strictEqual(maxLegDaysCheck([near], ko({ 'KXNFLGAME-26OCT26WASKC-KC': now + 7 * D - 1 }), now, 7), null);
assert.strictEqual(maxLegDaysCheck([near], ko({ 'KXNFLGAME-26OCT26WASKC-KC': now + 7 * D + 60e3 }), now, 7), 'leg_beyond_max_days');
// unknown kickoff -> ticker date
assert.strictEqual(maxLegDaysCheck([day8], () => null, now, 7), 'leg_beyond_max_days');
assert.strictEqual(maxLegDaysCheck(['KXNBASPREAD-26NOV02PHXOKC-OKC10:no'], () => null, now, 7), null); // day 7 start not > 7d
assert.strictEqual(maxLegDaysCheck(['WEIRDTICKER:yes'], () => null, now, 7), null); // no date -> not rejected here
assert.strictEqual(maxLegDaysCheck([far], () => null, now, 0), null); // 0 = off
// known kickoff wins over ticker date
assert.strictEqual(maxLegDaysCheck([day8], () => now + 2 * D, now, 7), null);
// intake worker drop (ticker date only)
const sk = {}; const f = createCandidateFilter({ maxAgeMs: 5000, maxLegDays: 7 }, { now: () => now, clock: () => now, bump: (k) => { sk[k] = (sk[k] || 0) + 1; } });
const base = { rfqId: 'x', isCombo: true, createdTs: new Date(now - 100).toISOString() };
assert.strictEqual(f({ ...base, legKeys: [near, far] }), null);
assert.strictEqual(sk.leg_beyond_max_days_intake, 1);
assert.ok(f({ ...base, rfqId: 'y', legKeys: [near, 'KXNFLGAME-26OCT27NYGPHI-PHI:yes'] }));
// config default
const env = require('../auto-sniper');
const loader = Object.values(env).find((v) => typeof v === 'function' && /SNIPER_NBA_HOURS/.test(String(v)));
if (loader) { assert.strictEqual(loader({}).maxLegDays, 7); assert.strictEqual(loader({ SNIPER_MAX_LEG_DAYS: '3' }).maxLegDays, 3); }
console.log('max-leg-days ok', loader ? '(config checked)' : '');
