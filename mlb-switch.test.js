'use strict';
const assert = require('assert');
const { mlbOn, withoutMlb } = require('./mlb-switch');
assert.strictEqual(mlbOn({}), false, 'default off');
assert.strictEqual(mlbOn({ MLB_ENABLED: '1' }), true);
assert.strictEqual(mlbOn({ MLB_ENABLED: 'on' }), true);
assert.strictEqual(mlbOn({ MLB_ENABLED: '0' }), false);
assert.deepStrictEqual(withoutMlb(['NFL', 'MLB', 'NBA'], {}), ['NFL', 'NBA']);
assert.deepStrictEqual(withoutMlb(['NFL', 'MLB', 'NBA'], { MLB_ENABLED: '1' }), ['NFL', 'MLB', 'NBA']);
// relay league lists honor the switch (module evaluated with MLB_ENABLED unset here)
const R = require('./odds-relay');
assert.ok(!R.LEAGUES.includes('MLB'), 'relay serves no MLB by default');
assert.ok(R.LEAGUES.includes('NFL') && R.LEAGUES.includes('NBA'));
console.log('mlb switch ok');
