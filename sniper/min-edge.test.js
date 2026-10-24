// Kevin Oct 24: +1% on every sniper min-edge rule (highest applicable rule still wins).
const assert = require('assert');
const S = require('../auto-sniper');
const c = S.sniperConfig({});
assert.strictEqual(c.minRoi, 0.04, 'all-NFL-ML 4%');
assert.strictEqual(c.minRoiLines, 0.05, 'other NFL 5%');
assert.strictEqual(c.minRoiNcaaf, 0.06, 'NCAAF 6%');
assert.strictEqual(c.minRoiNba, 0.06, 'NBA 6%');
assert.strictEqual(c.minRoiTd, 0.07, 'NFL TD 7%');
// fly/sniper.toml [env] must match the code defaults (it overrides them in prod)
const toml = require('fs').readFileSync(require('path').join(__dirname, '../fly/sniper.toml'), 'utf8');
const v = (k) => Number((toml.match(new RegExp(`^\\s*${k}\\s*=\\s*"([^"]+)"`, 'm')) || [])[1]);
assert.strictEqual(v('SNIPER_MIN_ROI'), 0.04); assert.strictEqual(v('SNIPER_MIN_ROI_LINES'), 0.05);
assert.strictEqual(v('SNIPER_MIN_ROI_NCAAF'), 0.06); assert.strictEqual(v('SNIPER_MIN_ROI_NBA'), 0.06);
assert.strictEqual(v('SNIPER_MIN_ROI_TD'), 0.07);
const tc = S.sniperConfig(Object.fromEntries(['SNIPER_MIN_ROI', 'SNIPER_MIN_ROI_LINES', 'SNIPER_MIN_ROI_NCAAF', 'SNIPER_MIN_ROI_NBA', 'SNIPER_MIN_ROI_TD'].map((k) => [k, String(v(k))])));
assert.deepStrictEqual([tc.minRoi, tc.minRoiLines, tc.minRoiNcaaf, tc.minRoiNba, tc.minRoiTd], [0.04, 0.05, 0.06, 0.06, 0.07]);
console.log('min-edge.test ok');
