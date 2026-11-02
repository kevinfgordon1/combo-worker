// Kevin Nov 1: every sniper minimum edge is 8% (Kalshi sniper and Polymarket sniper), highest rule wins.
// The fly toml [env] values override the code defaults in prod, so this pins the toml files.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../auto-sniper');
const P = require('../poly-sniper/engine');
const read = (f) => fs.readFileSync(path.join(__dirname, '../fly', f), 'utf8');
const val = (toml, k) => Number((toml.match(new RegExp(`^\\s*${k}\\s*=\\s*"([^"]+)"`, 'm')) || [])[1]);

// Kalshi sniper (kaygo-sniper, fly/sniper.toml)
const kt = read('sniper.toml');
const KK = ['SNIPER_MIN_ROI', 'SNIPER_MIN_ROI_LINES', 'SNIPER_MIN_ROI_NCAAF', 'SNIPER_MIN_ROI_NBA', 'SNIPER_MIN_ROI_TD', 'SNIPER_MIN_ROI_NCAAB'];
for (const k of KK) assert.strictEqual(val(kt, k), 0.08, `${k} 8%`);
const kc = S.sniperConfig(Object.fromEntries(KK.map((k) => [k, String(val(kt, k))])));
assert.deepStrictEqual([kc.minRoi, kc.minRoiLines, kc.minRoiNcaaf, kc.minRoiNba, kc.minRoiTd, kc.minRoiNcaab], [0.08, 0.08, 0.08, 0.08, 0.08, 0.08]);

// Polymarket sniper (kaygo-poly-worker, fly/poly-worker.toml): every minimum set explicitly (no 5-6% code default leaks)
const pt = read('poly-worker.toml');
const PK = ['POLY_SNIPER_MIN_ROI_NFL_ML', 'POLY_SNIPER_MIN_ROI_NFL', 'POLY_SNIPER_MIN_ROI_TD', 'POLY_SNIPER_MIN_ROI_NCAAF', 'POLY_SNIPER_MIN_ROI_NBA', 'POLY_SNIPER_MIN_ROI_NCAAB'];
for (const k of PK) assert.strictEqual(val(pt, k), 0.08, `${k} 8%`);
const pc = P.polySniperConfig(Object.fromEntries(PK.map((k) => [k, String(val(pt, k))])));
assert.deepStrictEqual([pc.minRoiNflMl, pc.minRoiNfl, pc.minRoiTd, pc.minRoiNcaaf, pc.minRoiNba, pc.minRoiNcaab], [0.08, 0.08, 0.08, 0.08, 0.08, 0.08]);
for (const legs of [[{ kind: 'ml' }], [{ kind: 'ml' }, { kind: 'line', league: 'nfl' }], [{ kind: 'td' }], [{ kind: 'ncaaf' }], [{ kind: 'nba' }], [{ kind: 'ncaab' }]]) {
  assert.strictEqual(P.polyMinRoi(legs, pc), 0.08, JSON.stringify(legs));
}
console.log('min-edge.test ok');
