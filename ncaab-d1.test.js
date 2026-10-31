'use strict';
const assert = require('assert');
const D1 = require('./ncaab-d1');

assert.ok(D1.D1_TEAM_COUNT >= 360, `D1 list size ${D1.D1_TEAM_COUNT}`);
// Venue spellings -> one ESPN D1 team
for (const [n, want] of [['Villanova', 'Villanova Wildcats'], ['Villanova Wildcats', 'Villanova Wildcats'], ['Notre Dame', 'Notre Dame Fighting Irish'],
  ['St. Thomas (MN)', 'St. Thomas Tommies'], ['K-State', 'Kansas State Wildcats'], ['LA Tech', 'Louisiana Tech Bulldogs'], ['NM State', 'New Mexico State Aggies'],
  ['Southeastern Louisiana', 'SE Louisiana Lions'], ["St. Mary's", "Saint Mary's Gaels"], ['Miami (FL)', 'Miami Hurricanes'], ['Miami (OH)', 'Miami (OH) RedHawks']]) {
  const t = D1.d1Team(n);
  assert.ok(t, `${n} resolves`);
  assert.strictEqual(t.display, want, n);
}
// Non-D1 opponents (Kalshi lists them) fail closed
for (const n of ['Fisk', 'Bethesda', 'Willamette', 'Kentucky Christian', 'Oakwood', '']) assert.strictEqual(D1.d1Team(n), null, n);
assert.strictEqual(D1.isD1Game('Villanova', 'Notre Dame'), true);
assert.strictEqual(D1.isD1Game('Fisk', 'Belmont'), false);
assert.strictEqual(D1.isD1Game('Duke', 'Duke Blue Devils'), false, 'same team twice is not a game');
assert.strictEqual(D1.teamById(D1.d1Team('Duke').espnId).display, 'Duke Blue Devils');
console.log('ncaab-d1 ok');
