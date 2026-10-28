'use strict';
// Exact-line matching gaps found replaying every line leg in Combo Locks since 2026-10-20
// against Polymarket US's REAL markets (fixtures-poly-aliases.json, fetched 2026-10-28):
//   (a) Kalshi KXNBA* uses SAS for the Spurs; Polymarket US slugs use `sa`.
//   (b) Polymarket renamed two cfb teams after the crosswalk was generated:
//       kanst "Kansas State" -> "K-State", loutch "Louisiana Tech" -> "LA Tech".
// Exact lines only: nothing here loosens a line, side, date or team check.
process.env.POLY_NBA_LINES = '1';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const I = require('./leg-identity');
const NC = require('./ncaaf-crosswalk');

const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures-poly-aliases.json'), 'utf8'));
const markets = new Map(Object.entries(FX.markets));
const BUY = 'SIDE_BUY';
const SELL = 'SIDE_SELL';
const polyKeys = (legs, mk) => {
  const r = I.identitiesFromPolymarketLegs(legs.map(([symbol, side]) => ({ symbol, side })), mk || markets);
  return r.ok ? r.keys : r.reason;
};
const lockKeys = (prefix, only) => {
  const l = FX.locks.find((x) => x.id.startsWith(prefix));
  assert.ok(l, prefix);
  const lock = only ? { ...l, leg_keys: undefined, legs: l.legs.filter((g) => only.test(g.ticker)) } : l;
  const r = I.identitiesFromParlay(lock, { lines: true });
  assert.ok(r.ok, `lock ${prefix} maps`);
  return r.keys;
};
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── (a) Spurs: Kalshi SAS == Polymarket sa ────────────────────────────────
{
  assert.strictEqual(I.normTeam('nba', 'SAS'), 'sa');
  assert.strictEqual(I.normTeam('nba', 'sa'), 'sa');
  assert.strictEqual(I.normTeam('nhl', 'sas'), 'sas', 'league-scoped: NBA alias only');
  // moneyline: San Antonio yes (lock 873e2f25) == SELL aec-nba-okc-sa (short side = sa)
  assert.deepStrictEqual(lockKeys('873e2f25', /OKCSAS/), polyKeys([['aec-nba-okc-sa-2026-10-20', SELL]]));
  assert.deepStrictEqual(lockKeys('8fe618e1', /OKCSAS/), polyKeys([['aec-nba-okc-sa-2026-10-20', BUY]]));
  assert.notDeepStrictEqual(lockKeys('873e2f25', /OKCSAS/), polyKeys([['aec-nba-okc-sa-2026-10-20', BUY]]), 'side still exact');
  // spread: KXNBASPREAD SAS19:yes "San Antonio −18.5" == SELL asc-nba-sac-sa-…-pos-18pt5 (Sac +18.5 short)
  assert.deepStrictEqual(lockKeys('e1a486d4', /SACSAS/), polyKeys([['asc-nba-sac-sa-2026-10-27-pos-18pt5', SELL]]));
  assert.notDeepStrictEqual(lockKeys('e1a486d4', /SACSAS/), polyKeys([['asc-nba-sac-sa-2026-10-27-pos-18pt5', BUY]]));
  assert.notDeepStrictEqual(lockKeys('e1a486d4', /SACSAS/), polyKeys([['asc-nba-sac-sa-2026-10-27-pos-1pt5', SELL]]), 'line still exact');
  // total: KXNBATOTAL SACSAS-233:no "Under 232.5" == SELL tsc-nba-sac-sa-…-232pt5
  assert.deepStrictEqual(lockKeys('6fcec435', /SACSAS/), polyKeys([['tsc-nba-sac-sa-2026-10-27-232pt5', SELL]]));
  assert.notDeepStrictEqual(lockKeys('6fcec435', /SACSAS/), polyKeys([['tsc-nba-sac-sa-2026-10-27-232pt5', BUY]]));
  // a full real lock: NYK ML + LAL ML + SAC/SAS under 232.5 — every leg ties now
  const full = lockKeys('6fcec435');
  assert.strictEqual(full.length, 3);
  assert.ok(full.every((k) => k.includes('|')));
  // the date on the slug must still agree with the lock's date
  assert.notDeepStrictEqual(lockKeys('873e2f25', /OKCSAS/), polyKeys([['aec-nba-sac-sa-2026-10-27', SELL]]));
}

// ── (b) college renamed teams: K-State / LA Tech ──────────────────────────
{
  const ksu = NC.teamByPoly('kanst');
  const lt = NC.teamByPoly('loutch');
  assert.ok(ksu && lt);
  assert.strictEqual(ksu.pname, 'Kansas State', 'crosswalk itself unchanged');
  assert.ok(NC.polyNameIs(ksu, 'K-State') && NC.polyNameIs(ksu, 'Kansas State'));
  assert.ok(NC.polyNameIs(lt, 'LA Tech') && NC.polyNameIs(lt, 'Louisiana Tech'));
  assert.ok(!NC.polyNameIs(ksu, 'Kansas'), 'Kansas is a different team');
  assert.ok(!NC.polyNameIs(ksu, 'LA Tech'), 'aliases are per abbreviation');
  assert.ok(!NC.polyNameIs(NC.teamByPoly('arzst'), 'K-State'));
  assert.ok(!NC.polyNameIs(ksu, ''));
  // total: KXNCAAFTOTAL KSUASU-52:no "Under 51.5" == SELL tsc-cfb-kanst-arzst-…-total-51pt5
  assert.deepStrictEqual(lockKeys('699f11f4', /KSUASU/), polyKeys([['tsc-cfb-kanst-arzst-2026-10-24-total-51pt5', SELL]]));
  // spread: KXNCAAFSPREAD KSUASU-KSU2:no "Arizona St. +1.5" == SELL asc-cfb-kanst-arzst-…-neg-1pt5 (K-State −1.5 short)
  assert.deepStrictEqual(lockKeys('8438abf8', /KSUASU/), polyKeys([['asc-cfb-kanst-arzst-2026-10-24-neg-1pt5', SELL]]));
  assert.notDeepStrictEqual(lockKeys('8438abf8', /KSUASU/), polyKeys([['asc-cfb-kanst-arzst-2026-10-24-neg-1pt5', BUY]]));
  // LA Tech moneyline + spread now verify
  assert.ok(Array.isArray(polyKeys([['aec-cfb-loutch-sala-2026-10-31', BUY]])));
  assert.ok(Array.isArray(polyKeys([['asc-cfb-loutch-sala-2026-10-31-neg-10pt5', BUY]])));
  // any OTHER name disagreement is still rejected (no loosening)
  const sp = 'asc-cfb-kanst-arzst-2026-10-24-neg-1pt5';
  const bad = clone(FX.markets[sp]);
  const side = (bad.marketSides || []).find((x) => x.team && x.team.abbreviation === 'kanst');
  side.team.name = 'Kansas';
  assert.strictEqual(polyKeys([[sp, SELL]], new Map([[sp, bad]])), 'meta_mismatch');
  const tot = 'tsc-cfb-kanst-arzst-2026-10-24-total-51pt5';
  const badT = clone(FX.markets[tot]);
  badT.question = 'Will the total in Kansas vs. Arizona State be more than 51.5?';
  assert.strictEqual(polyKeys([[tot, SELL]], new Map([[tot, badT]])), 'meta_mismatch');
  const ml = 'aec-cfb-loutch-sala-2026-10-31';
  const badM = clone(FX.markets[ml]);
  (badM.marketSides || []).find((x) => x.team && x.team.abbreviation === 'loutch').team.name = 'Louisiana';
  assert.notStrictEqual(Array.isArray(polyKeys([[ml, BUY]], new Map([[ml, badM]]))), true);
}

console.log('poly-line-aliases.test.js ok');
