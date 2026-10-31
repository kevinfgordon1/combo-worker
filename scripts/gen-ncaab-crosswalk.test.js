'use strict';
// The NCAAB crosswalk generator, replayed on the REAL captured Kalshi + Polymarket US data
// (fixtures-ncaab-captures.json): rebuilding it gives exactly the committed ncaab-crosswalk.json.
const assert = require('assert');
const { buildCrosswalk } = require('./gen-ncaab-crosswalk');
const cap = require('../fixtures-ncaab-captures.json');
const d1 = require('../ncaab-d1-teams.json').teams;
const committed = require('../ncaab-crosswalk.json');

const x = buildCrosswalk(cap.kalshi, cap.poly, d1, { generatedAt: committed.generatedAt });
assert.deepStrictEqual(x.teams, committed.teams, 'teams reproduce');
assert.deepStrictEqual(x.games, committed.games, 'games reproduce');
assert.ok(Object.keys(x.teams).length >= 250);
assert.ok(x.conflicts.some((c) => c.k === 'OAK'), 'ambiguous Kalshi code dropped');
assert.ok(!x.teams.OAK);
assert.ok(x.nonD1.includes('Fisk'));
assert.ok(x.games.every((g) => g.codes.every((c) => x.teams[c])), 'games are D1 vs D1 only');
assert.ok(x.unmatchedKalshi.every((u) => u.why !== 'blob_split_not_unique'), JSON.stringify(x.unmatchedKalshi.filter((u) => u.why === 'blob_split_not_unique')));
// fail closed: a Kalshi code with two names is never mapped
const evil = JSON.parse(JSON.stringify(cap.kalshi.slice(0, 5)));
evil.push({ event_ticker: 'KXNCAAMBGAME-26NOV09VILLXYZ', title: 'X', markets: [{ ticker: 'KXNCAAMBGAME-26NOV09VILLXYZ-VILL', yes_sub_title: 'Vanderbilt' }, { ticker: 'KXNCAAMBGAME-26NOV09VILLXYZ-XYZ', yes_sub_title: 'Xavier' }] });
const y = buildCrosswalk(evil, [], d1);
assert.ok(!y.teams.VILL && y.conflicts.some((c) => c.k === 'VILL'));
console.log('scripts/gen-ncaab-crosswalk.test.js ok');
