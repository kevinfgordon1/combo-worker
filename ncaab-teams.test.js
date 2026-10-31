// Canonical NCAAB team table (ncaab-teams.json + ncaab-teams.js), Kevin Oct 30 2026.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const T = require('./ncaab-teams');
const table = require('./ncaab-teams.json');
const cap = require('./fixtures-ncaab-teams-capture.json');
const overrides = require('./ncaab-team-overrides.json');
const { buildTeams } = require('./scripts/gen-ncaab-teams');
const { checkCapture } = require('./scripts/check-ncaab-teams');

// 1. all 365 D1 schools, one row per ESPN id
assert.strictEqual(table.teams.length, 365, `D1 teams ${table.teams.length}`);
assert.strictEqual(new Set(table.teams.map((t) => t.espnId)).size, 365, 'unique ESPN ids');
assert.strictEqual(crypto.createHash('sha256').update(JSON.stringify(table.teams) + JSON.stringify(table.ambiguous)).digest('hex').slice(0, 16), table.contentHash, 'contentHash');

// 2. the committed table is exactly what the generator builds from the committed capture (no hand edits)
const { table: rebuilt, report } = buildTeams(cap, overrides);
assert.strictEqual(rebuilt.contentHash, table.contentHash, 'ncaab-teams.json is stale: node scripts/gen-ncaab-teams.js --capture=fixtures-ncaab-teams-capture.json');

// 3. a code belongs to ONE team per source unless it is listed as ambiguous (then context decides)
for (const src of ['kalshi', 'polymarket', 'underdog', 'kalshiFutures', 'polymarketFutures']) {
  const owner = new Map();
  for (const t of table.teams) for (const c of (t.aliases[src] && t.aliases[src].codes) || []) {
    assert.ok(!owner.has(c), `${src} code ${c} used by ${owner.get(c)} and ${t.espnId}`);
    owner.set(c, t.espnId);
  }
}
// every Kalshi code must split back to its own team
for (const t of table.teams) for (const c of (t.aliases.kalshi && t.aliases.kalshi.codes) || []) assert.strictEqual(T.resolveTeam('kalshi', { code: c }).espnId, t.espnId, `kalshi ${c}`);

// 4. coverage of the live games / futures in the capture, per source, with the RUNTIME resolver
const res = checkCapture(cap);
const MIN = { kalshi: 99, polymarket: 99, underdog: 99, novig: 99, oddsapi: 99, kalshiFutures: 100, polymarketFutures: 100 };
for (const [src, min] of Object.entries(MIN)) {
  const c = res.coverage[src];
  assert.ok(c && c.total > 0, `${src}: no data in the capture`);
  assert.ok(c.coveragePct >= min, `${src} coverage ${c.coveragePct}% < ${min}% (unmatched: ${JSON.stringify(res.unmatched[src] || [])})`);
}
for (const [src, c] of Object.entries(res.coverage)) if (src.startsWith('books:')) assert.ok(c.coveragePct >= 98, `${src} ${c.coveragePct}%`);
// matched games are the RIGHT games: ESPN lists the same pairing (Polymarket lists a few games ESPN does not yet)
for (const src of ['kalshi', 'underdog', 'novig', 'oddsapi']) assert.strictEqual(report.coverage[src].scheduleMissing, 0, `${src} pairing not on ESPN: ${JSON.stringify(report.scheduleMissing[src])}`);
assert.ok(report.coverage.polymarket.scheduleConfirmed / report.coverage.polymarket.matched >= 0.99, 'polymarket pairings confirmed by ESPN');
// Kalshi codes exist for (nearly) every school (open games + last season's settled games)
assert.ok(table.teams.filter((t) => t.aliases.kalshi && t.aliases.kalshi.codes && t.aliases.kalshi.codes.length).length >= 355, 'kalshi codes');

// 5. ambiguity is resolved with opponent + tip context, not dropped and not guessed
T.setSchedule(cap.espn.games);
assert.strictEqual(T.resolveTeam('kalshi', { code: 'OAK' }).espnId, null, 'OAK alone: Oakland or Oakwood');
assert.strictEqual(T.resolveTeam('kalshi', { code: 'OAK', name: 'Oakland' }).espnId, '2473');
assert.strictEqual(T.resolveTeam('kalshi', { code: 'OAK', name: 'Oakwood' }).why, 'non_d1');
assert.strictEqual(T.resolveTeam('kalshi', { code: 'OAK' }, { opponentId: '130', date: '2026-11-02' }).espnId, '2473', 'OAK vs Michigan = Oakland');
assert.strictEqual(T.resolveTeam('kalshi', { code: 'OAK' }, { opponentId: '2010', date: '2026-11-02' }).espnId, null, 'OAK vs Alabama A&M = Oakwood (non-D1)');
assert.deepStrictEqual(T.splitKalshiBlob('OAKMICH', { date: '2026-11-02' }).espnIds, ['2473', '130']);
assert.strictEqual(T.splitKalshiBlob('OAKAAMU', { date: '2026-11-02' }), null);
const g = T.resolveGame('oddsapi', { away: { name: 'Villanova Wildcats' }, home: { name: 'Notre Dame Fighting Irish' } });
assert.deepStrictEqual([g.awayId, g.homeId], ['222', '87']);

// 6. names that commonly collide across venues
const want = {
  'Miami (OH)': '193', 'Miami (FL)': '2390', Miami: '2390', 'Miami Hurricanes': '2390', 'Miami (OH) RedHawks': '193',
  "St. John's": '2599', 'Saint Johns': '2599', "St. Mary's": '2608', "Saint Mary's Gaels": '2608', UConn: '41', Connecticut: '41',
  'Ole Miss': '145', Mississippi: '145', 'NC State': '152', 'Texas A&M': '245', 'Texas A&M-CC': '357', 'Texas A&M-Corpus Christi': '357',
  'Loyola (Chi)': '2350', 'Loyola Chicago': '2350', 'Loyola Marymount': '2351', 'Loyola Maryland': '2352',
  USC: '30', 'USC Upstate': '2908', 'South Carolina': '2579', Kansas: '2305', 'Kansas State': '2306', 'K-State': '2306', 'Kansas City': '140', UMKC: '140',
  California: '25', 'Cal Poly': '13', 'Grand Canyon Antelopes': '2253', 'GW Revolutionaries': '45', 'Army Knights': '349', 'Dixie State': '3101',
  "Hawai'i": '62', Hawaii: '62', 'App State': '2026', LIU: '112358', 'UL Monroe': '2433', Pitt: '221', Pittsburgh: '221',
};
for (const [n, id] of Object.entries(want)) assert.strictEqual(T.resolveTeam('books', { name: n }).espnId, id, `${n} -> ${id} (${JSON.stringify(T.resolveTeam('books', { name: n }))})`);
for (const n of ['Fisk', 'Oakwood', 'Bethesda', 'Hartford Hawks', 'St. Francis (PA) Red Flash', 'Kansas Christian Falcons']) assert.strictEqual(T.resolveTeam('books', { name: n }).espnId, null, `${n} is not D1`);
// Polymarket US slug abbreviations
for (const [c, id] of Object.entries({ vill: '222', nd: '87', tamu: '357', txam: '245', miaoh: '193', mia: '2390', loych: '2350' })) assert.strictEqual(T.resolveTeam('polymarket', { code: c }).espnId, id, `poly ${c}`);

console.log(`ncaab-teams ok (${Object.entries(res.coverage).map(([s, c]) => `${s} ${c.coveragePct}%`).join(', ')})`);
