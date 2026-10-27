const assert = require('assert');
const { midGuard, midGuardConfig } = require('./mid-guard');
const { legFairDepth } = require('./fair');
const am = (p) => (p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p));
const V = ['kalshi', 'polymarket', 'novig', 'prophetx'];
const cfg = midGuardConfig({});
assert.deepStrictEqual([cfg.mode, cfg.maxBelow, cfg.thinSlip, cfg.secondTol], ['enforce', 0.05, 0.03, 0.05]);
const src = (venue, topCost, cost) => ({ venue, used: cost != null, reason: cost != null ? 'ok' : 'depth', cost, topAmerican: am(topCost), availUsd: 2000 });
// UNM: SJSU top ask 15c (UNM ~85%), $2,000 walk cost 87c -> fair 13% -> blocked
let s = [src('kalshi', 0.15, 0.87)];
assert.strictEqual(midGuard(0.13, 'kalshi', s, V, cfg).skip, 'fair_below_mid');
assert.strictEqual(legFairDepth({ kind: 'ncaaf', gameId: 'g', team: 'UNM' }, { venues: V, ncaafBook: { legFair: () => ({ sources: s }) }, rogue: { mode: 'off' } }).reason, 'fair_below_mid');
// Liquid NFL leg: top 40c, walk 41c -> fair 59% vs ref 60% -> quoted
s = [src('kalshi', 0.40, 0.41), src('polymarket', 0.405, 0.415)];
assert.strictEqual(midGuard(0.59, 'kalshi', s, V, cfg).skip, null);
const f = legFairDepth({ kind: 'ncaaf', gameId: 'g', team: 'X' }, { venues: V, ncaafBook: { legFair: () => ({ sources: s }) }, rogue: { mode: 'off' } });
assert.ok(Math.abs(f.p - 0.59) < 1e-9 && f.ref > 0.59);
// Thin Kalshi-only: slipped 4pp (<5pp) and no second venue -> single_venue_thin
s = [src('kalshi', 0.30, 0.34)];
assert.strictEqual(midGuard(0.66, 'kalshi', s, V, cfg).skip, 'single_venue_thin');
// ...same, but Polymarket agrees (top 67%) -> allowed
s = [src('kalshi', 0.30, 0.34), src('polymarket', 0.33, null)];
assert.strictEqual(midGuard(0.66, 'kalshi', s, V, cfg).skip, null);
// No Kalshi: falls back to other venues' median top
s = [src('polymarket', 0.20, 0.30), src('novig', 0.22, null)];
assert.strictEqual(midGuard(0.70, 'polymarket', s, V, cfg).skip, 'fair_below_mid');
// shadow / off never block
assert.strictEqual(legFairDepth({ kind: 'ncaaf', gameId: 'g', team: 'UNM' }, { venues: V, ncaafBook: { legFair: () => ({ sources: [src('kalshi', 0.15, 0.87)] }) }, rogue: { mode: 'off' }, mid: { ...cfg, mode: 'shadow' } }).p > 0.12, true);
assert.strictEqual(midGuard(0.13, 'kalshi', [src('kalshi', 0.15, 0.87)], V, { ...cfg, mode: 'off' }).skip, null);
console.log('mid-guard.test ok');
// Kevin: lone venue with BOTH sides asked at 99c (-10000 each) -> sweep fair ~1% -> must skip
{
  const s99 = [src('kalshi', 0.99, 0.99)];
  const own = [{ venue: 'kalshi', topAmerican: am(0.99) }];
  assert.strictEqual(midGuard(0.01, 'kalshi', s99, V, cfg, own).skip, 'book_overround');
  assert.strictEqual(midGuard(0.01, 'kalshi', s99, V, cfg).skip, 'single_venue_thin'); // even without own-side book
  const r = legFairDepth({ kind: 'nba', gameId: 'g', team: 'A' }, { venues: V, nbaBook: { legFair: () => ({ sources: s99, own }) }, rogue: { mode: 'off' } });
  assert.strictEqual(r.p, null); assert.strictEqual(r.reason, 'book_overround');
  // normal book: 52c + 50c = 102% -> fine
  assert.strictEqual(midGuard(0.495, 'kalshi', [src('kalshi', 0.50, 0.505), src('polymarket', 0.5, 0.51)], V, cfg, [{ venue: 'kalshi', topAmerican: am(0.52) }]).skip, null);
}
console.log('mid-guard overround ok');
