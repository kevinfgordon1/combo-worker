'use strict';
// Polymarket US NCAAF (college football) mapping: moneyline, spread, total.
// REAL data: fixtures-ncaaf.json (Poly cfb market metadata + open RFQs + the 16 active
// Combo Locks, 2026-10-01) and fixtures-ncaaf-captures.json (Kalshi KXNCAAFGAME events
// and Poly cfb events the crosswalk was generated from).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  parseKalshiLineTicker, parseKalshiNcaafMlTicker, identityFromPolymarketLine,
  identitiesFromParlay, identitiesFromPolymarketLegs, identityFromMarket,
  identityFromPolymarketSlug, identityKey, startTimesAgree,
} = require('./leg-identity');
const NC = require('./ncaaf-crosswalk');
const { buildCrosswalk } = require('./scripts/gen-ncaaf-crosswalk');
const {
  normalizePolymarketRfq, couldMatchActiveLocks, matchPolymarketParlayDetailed,
  evaluatePolymarketRfq, countPriceableLocks, countPriceableLineLocks, logUnpriceablePolyLocks,
  startPolymarketRfqLoop,
} = require('./polymarket-rfq');

const rd = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const FX = rd('fixtures-ncaaf.json');
const CAP = rd('fixtures-ncaaf-captures.json');
const OLD = rd('fixtures-poly-line-legs.json');
const markets = new Map([...Object.entries(OLD.markets), ...Object.entries(FX.markets)]);
const lockById = (p) => FX.locks.find((l) => l.id.startsWith(p));
const BUY = 'SIDE_BUY';
const SELL = 'SIDE_SELL';
const mkRfq = (legs, extra) => ({
  id: 'rfq_test', status: 'RFQ_STATUS_OPEN', cashOrderQty: '10', symbol: 'caoc-test',
  comboLegs: legs.map(([symbol, side]) => ({ symbol, side })), ...extra,
});
const matchOf = (rfq, locks, mk) => matchPolymarketParlayDetailed(normalizePolymarketRfq(rfq), locks, { markets: mk || markets });
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── 1. Crosswalk: reproducible from real captures, safe by construction ─────
{
  const rebuilt = buildCrosswalk(CAP.kalshi, CAP.poly, { generatedAt: CAP.capturedAt });
  assert.deepStrictEqual(rebuilt.teams, rd('ncaaf-crosswalk.json').teams, 'checked-in crosswalk == regenerated from captures');
  assert.ok(NC.teamCount >= 250, `teams=${NC.teamCount}`);
  assert.strictEqual(rebuilt.conflicts.length, 0);
  // every matched game: both Kalshi names equal the Poly names and the blob splits uniquely
  for (const g of rebuilt.games) {
    const sp = NC.splitBlob(g.blob);
    assert.ok(sp, `blob splits ${g.blob}`);
    assert.deepStrictEqual(sp.codes.slice().sort(), g.teams.map((t) => t.k).sort());
    assert.deepStrictEqual(sp.pair.slice().sort(), g.teams.map((t) => t.p).sort());
  }
  // same-name collisions stay distinct teams
  const P = (c) => NC.teamByCode(c).p;
  assert.notStrictEqual(P('MIA'), P('MOH'));
  assert.strictEqual(NC.teamByCode('MIA').name, 'Miami (FL)');
  assert.strictEqual(NC.teamByCode('MOH').name, 'Miami (OH)');
  assert.notStrictEqual(P('OHIO'), P('OSU'));
  assert.notStrictEqual(P('WASH'), P('WSU'));
  assert.notStrictEqual(P('USC'), P('SCAR'));
  assert.notStrictEqual(P('UNT'), P('UNC'));
  assert.notStrictEqual(P('MSU'), P('MISS'));
  // Kalshi/Poly differ (that is the whole point): Kalshi UNT = Poly ntx, Kalshi CAL = Poly cah, ...
  assert.deepStrictEqual(['UNT', 'CAL', 'FLA', 'ORST', 'ISU', 'AFA', 'JVST', 'WKU'].map(P), ['ntx', 'cah', 'fl', 'oregst', 'iowast', 'airf', 'jaxst', 'wkent']);
  // unknown / ambiguous => null, never guessed
  assert.strictEqual(NC.splitBlob('ZZZYYY'), null);
  assert.strictEqual(NC.splitBlob('UNT'), null);
  assert.strictEqual(NC.splitBlob('UNTUNT'), null, 'same team twice');
  assert.strictEqual(NC.splitBlob('UNTTLSAX'), null);
  assert.strictEqual(NC.splitBlob(''), null);
  assert.strictEqual(NC.teamByPoly('nope'), null);
  // Listed-unmapped Kalshi games: either a team is unknown (blob does not split => unmapped), or both
  // teams are individually verified from OTHER games but Poly lists no such game that ET date - then no
  // Poly market can ever verify against it (metadata team+date checks), so it is still never quoted.
  const polyGames = new Set(CAP.poly.map((e) => {
    const m = e.slug.match(/^cfb-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d\d-\d\d)$/);
    return [m[1], m[2]].sort().join('+') + '@' + m[3];
  }));
  const MON = { OCT: '10' };
  for (const u of rebuilt.unmatchedKalshi) {
    const [, yy, mon, dd, blob] = u.kalshi.match(/^KXNCAAFGAME-(\d\d)([A-Z]{3})(\d\d)([A-Z0-9]+)$/);
    const sp = NC.splitBlob(blob);
    if (!sp) continue;
    assert.ok(!polyGames.has(sp.pair.slice().sort().join('+') + `@20${yy}-${MON[mon]}-${dd}`), `${u.kalshi} unmapped yet Poly lists it`);
  }
  assert.ok(rebuilt.unmatchedKalshi.length >= 1 && rebuilt.unmatchedPoly.length >= 1);
}
{
  // generator rules on synthetic data: every safeguard drops, never guesses
  const poly = (slug, title, t1, n1, t2, n2, gst) => ({
    slug, title, ml: {
      slug: `aec-${slug}`, gameStartTime: gst,
      sides: [{ long: true, name: n1, abbreviation: t1, league: 'cfb', ordering: 'away' }, { long: false, name: n2, abbreviation: t2, league: 'cfb', ordering: 'home' }],
    },
  });
  const kal = (ev, title, a, an, b, bn) => ({
    event_ticker: ev, title,
    markets: [{ ticker: `${ev}-${a}`, yes_sub_title: an, expected_expiration_time: '2026-10-04T00:00:00Z' },
      { ticker: `${ev}-${b}`, yes_sub_title: bn, expected_expiration_time: '2026-10-04T00:00:00Z' }],
  });
  const P1 = poly('cfb-aaa-bbb-2026-10-03', 'Alpha vs. Beta', 'aaa', 'Alpha', 'bbb', 'Beta', '2026-10-03T23:00:00Z');
  const K1 = kal('KXNCAAFGAME-26OCT03AABB', 'Alpha vs Beta', 'AA', 'Alpha', 'BB', 'Beta');
  let x = buildCrosswalk([K1], [P1]);
  assert.deepStrictEqual(x.teams, { AA: { p: 'aaa', name: 'Alpha', pname: 'Alpha' }, BB: { p: 'bbb', name: 'Beta', pname: 'Beta' } });
  // wrong date => not matched
  x = buildCrosswalk([kal('KXNCAAFGAME-26OCT04AABB', 'Alpha vs Beta', 'AA', 'Alpha', 'BB', 'Beta')], [P1]);
  assert.deepStrictEqual(x.teams, {});
  assert.strictEqual(x.unmatchedKalshi.length, 1);
  // name mismatch on ONE team => not matched
  x = buildCrosswalk([kal('KXNCAAFGAME-26OCT03AABB', 'Alpha vs Gamma', 'AA', 'Alpha', 'BB', 'Gamma')], [P1]);
  assert.deepStrictEqual(x.teams, {});
  // Miami FL vs Miami OH style: similar names never cross-match
  const PM = poly('cfb-mia-clmsn-2026-10-03', 'Miami vs. Clemson', 'mia', 'Miami', 'clmsn', 'Clemson', '2026-10-03T23:30:00Z');
  x = buildCrosswalk([kal('KXNCAAFGAME-26OCT03MOHCLEM', 'Miami (OH) vs Clemson', 'MOH', 'Miami (OH)', 'CLEM', 'Clemson')], [PM]);
  assert.deepStrictEqual(x.teams, {}, 'Miami (OH) must not match Poly Miami');
  // ambiguous: two Poly games with the same teams+date (doubleheader style) => unmatched
  const P1b = { ...P1, slug: 'cfb-aaa-bbb-2026-10-03-x' };
  x = buildCrosswalk([K1], [P1, { ...P1b, slug: 'cfb-bbb-aaa-2026-10-03', ml: { ...P1.ml, slug: 'aec-cfb-bbb-aaa-2026-10-03', sides: [P1.ml.sides[1], P1.ml.sides[0]].map((s, i) => ({ ...s, long: i === 0 })) } }]);
  assert.deepStrictEqual(x.teams, {}, 'ambiguous => nothing mapped');
  // kalshi clock far from poly kickoff => dropped
  const far = kal('KXNCAAFGAME-26OCT03AABB', 'Alpha vs Beta', 'AA', 'Alpha', 'BB', 'Beta');
  far.markets.forEach((m) => { m.expected_expiration_time = '2026-10-03T03:00:00Z'; });
  x = buildCrosswalk([far], [P1]);
  assert.deepStrictEqual(x.teams, {});
  // one Kalshi code, two different Poly teams => dropped on both
  const P2 = poly('cfb-ccc-ddd-2026-10-10', 'Alpha vs. Delta', 'ccc', 'Alpha', 'ddd', 'Delta', '2026-10-10T23:00:00Z');
  const K2 = kal('KXNCAAFGAME-26OCT10AADD', 'Alpha vs Delta', 'AA', 'Alpha', 'DD', 'Delta');
  K2.markets.forEach((m) => { m.expected_expiration_time = '2026-10-11T00:00:00Z'; });
  x = buildCrosswalk([K1, K2], [P1, P2]);
  assert.ok(!x.teams.AA && x.conflicts.length >= 1, 'conflicting code dropped');
  // a Kalshi code carrying two different names across events is dropped too
  const K3 = kal('KXNCAAFGAME-26OCT17AAEE', 'Other vs Beta', 'AA', 'Other', 'EE', 'Eps');
  x = buildCrosswalk([K1, K3], [P1]);
  assert.ok(!x.teams.AA, 'code with two names dropped');
  // poly sanity: league / slug-order problems throw (generator refuses bad source data)
  const badP = clone(P1); badP.ml.sides[0].league = 'nfl';
  assert.throws(() => buildCrosswalk([K1], [badP]));
}

// ── 2. The 4 active college locks ───────────────────────────────────────────
const L = { unt: 'b9a3c72b', ml3: '2c2611f8', untMl: 'd9d21c9a', ten: '14f70076' };
{
  for (const id of Object.values(L)) {
    const r = identitiesFromParlay(lockById(id), { lines: true });
    assert.ok(r.ok, `${id} maps`);
  }
  assert.strictEqual(identitiesFromParlay(lockById(L.ten), { lines: true }).identities.length, 10);
  assert.strictEqual(countPriceableLocks(FX.locks), 16);
  assert.strictEqual(countPriceableLineLocks(FX.locks), 5);
  // ML identity reader (Kalshi matcher, no lines opt) is UNCHANGED: NCAAF stays out of it
  for (const id of Object.values(L)) assert.strictEqual(identitiesFromParlay(lockById(id)).ok, false);
}

// Exact Poly RFQs for each lock (built leg by leg from the lock's own legs).
const LOCK_RFQ = {
  [L.unt]: [['asc-cfb-ntx-tulsa-2026-10-01-pos-1pt5', BUY], ['aec-nfl-den-sf-2026-10-04', BUY], ['asc-cfb-vir-flst-2026-10-03-neg-2pt5', BUY]],
  [L.ml3]: [['aec-cfb-txst-sdst-2026-10-03', BUY], ['aec-cfb-ucf-hou-2026-10-03', BUY], ['aec-cfb-aubrn-tenn-2026-10-03', BUY]],
  [L.untMl]: [['asc-nfl-gb-tb-2026-10-04-neg-3pt5', SELL], ['aec-cfb-ntx-tulsa-2026-10-01', BUY], ['aec-nfl-kc-lv-2026-10-04', SELL]],
  [L.ten]: [
    ['aec-cfb-jaxst-kenest-2026-10-07', BUY], ['aec-cfb-army-loutch-2026-10-03', BUY], ['aec-cfb-byu-tcu-2026-10-03', BUY],
    ['aec-cfb-cah-unlv-2026-10-03', BUY], ['aec-cfb-fl-missr-2026-10-03', BUY], ['aec-cfb-navy-airf-2026-10-03', SELL],
    ['aec-cfb-ohio-kentst-2026-10-03', BUY], ['aec-cfb-oregst-colst-2026-10-03', BUY], ['aec-cfb-wvir-iowast-2026-10-03', SELL],
    ['aec-cfb-wkent-nmxst-2026-10-01', BUY],
  ],
};
{
  for (const [id, legs] of Object.entries(LOCK_RFQ)) {
    const lock = lockById(id);
    const rfq = mkRfq(legs);
    const hit = matchOf(rfq, [lock]);
    assert.ok(hit.parlay && hit.parlay.id === lock.id, `exact RFQ hits lock ${id}: ${hit.reason}`);
    assert.ok(couldMatchActiveLocks(normalizePolymarketRfq(rfq), [lock]), `prefilter admits ${id}`);
    const ev = evaluatePolymarketRfq({ rfq, parlays: [lock], markets, now: Date.parse('2026-10-01T20:00:00Z'), startedFor: () => ({ started: false }) });
    assert.strictEqual(ev.action, 'quoteable', `${id} quoteable: ${ev.reason}`);
    assert.ok(ev.polyStartMs != null, 'Poly kickoff carried');
    // leg order is irrelevant
    assert.ok(matchOf(mkRfq(legs.slice().reverse()), [lock]).parlay);
    // flip EVERY leg's side, one at a time: never matches
    legs.forEach((l, i) => {
      const f = legs.map((x, j) => (i === j ? [x[0], x[1] === BUY ? SELL : BUY] : x));
      assert.strictEqual(matchOf(mkRfq(f), [lock]).parlay, null, `${id} leg ${i} side flipped`);
    });
    // drop a leg / add a leg: never matches
    assert.strictEqual(matchOf(mkRfq(legs.slice(1)), [lock]).parlay, null);
    assert.strictEqual(matchOf(mkRfq([...legs, ['aec-cfb-wisc-mst-2026-10-03', BUY]]), [lock]).parlay, null);
    // missing metadata (cache miss) => fail closed
    assert.strictEqual(matchOf(rfq, [lock], new Map()).parlay, null);
  }
  // Swap one college team in each ML lock for another game's team: no match.
  const swapIn = (id, i, slug, side) => LOCK_RFQ[id].map((x, j) => (i === j ? [slug, side] : x));
  assert.strictEqual(matchOf(mkRfq(swapIn(L.ml3, 0, 'aec-cfb-byu-tcu-2026-10-03', BUY)), [lockById(L.ml3)]).parlay, null);
  // wrong date for the same teams
  const wd = markets.get('aec-cfb-ucf-hou-2026-10-03');
  const wdm = new Map(markets);
  wdm.set('aec-cfb-ucf-hou-2026-10-10', { ...wd, slug: 'aec-cfb-ucf-hou-2026-10-10' });
  assert.strictEqual(matchOf(mkRfq(swapIn(L.ml3, 1, 'aec-cfb-ucf-hou-2026-10-10', BUY)), [lockById(L.ml3)], wdm).parlay, null,
    'metadata date != slug date and lock date differ');
  const wdm2 = new Map(markets);
  wdm2.set('aec-cfb-ucf-hou-2026-10-03', { ...wd, gameStartTime: '2026-10-10T16:00:00Z' });
  assert.strictEqual(matchOf(mkRfq(LOCK_RFQ[L.ml3]), [lockById(L.ml3)], wdm2).parlay, null, 'metadata date disagrees with slug');
}

// ── 3. Lock leg mutations (ticker / label / side / line / date / game text) ─
{
  const unt = lockById(L.unt);
  const idsOf = (lock) => identitiesFromParlay(lock, { lines: true });
  const mut = (id, fn) => { const l = clone(lockById(id)); fn(l); return l; };
  const legIdx = (l, frag) => l.legs.findIndex((g) => g.ticker.includes(frag));
  const bad = (name, lock) => assert.strictEqual(idsOf(lock).ok, false, `must NOT map: ${name}`);
  // spread label / side / line
  bad('label team swapped', mut(L.unt, (l) => { l.legs[legIdx(l, 'UNTTLSA')].label = 'Tulsa +1.5'; }));
  bad('label sign flipped', mut(L.unt, (l) => { l.legs[legIdx(l, 'UNTTLSA')].label = 'North Texas −1.5'; }));
  bad('label line 2.5', mut(L.unt, (l) => { l.legs[legIdx(l, 'UNTTLSA')].label = 'North Texas +2.5'; }));
  bad('side flipped', mut(L.unt, (l) => { l.legs[legIdx(l, 'UNTTLSA')].side = 'yes'; }));
  bad('no label', mut(L.unt, (l) => { l.legs[legIdx(l, 'UNTTLSA')].label = ''; }));
  bad('UVA label wrong team', mut(L.unt, (l) => { l.legs[legIdx(l, 'UVAFSU')].label = 'Florida St. −2.5'; }));
  bad('UVA label wrong line', mut(L.unt, (l) => { l.legs[legIdx(l, 'UVAFSU')].label = 'Virginia −3.5'; }));
  // game text must name both teams
  bad('game text other game', mut(L.unt, (l) => { l.legs[legIdx(l, 'UNTTLSA')].game = 'North Texas vs Rice'; }));
  bad('game text missing', mut(L.unt, (l) => { delete l.legs[legIdx(l, 'UNTTLSA')].game; }));
  // ML labels
  bad('ML label other team', mut(L.ml3, (l) => { l.legs[legIdx(l, 'UCFHOU')].label = 'Houston'; }));
  bad('ML game text other', mut(L.ml3, (l) => { l.legs[legIdx(l, 'UCFHOU')].game = 'UCF vs Houston Christian'; }));
  bad('ML side no', mut(L.ml3, (l) => { l.legs[legIdx(l, 'UCFHOU')].side = 'no'; l.leg_keys = l.leg_keys.map((k) => (k.includes('UCFHOU') ? k.replace(':yes', ':no') : k)); }));
  bad('ML unknown team code', mut(L.ml3, (l) => { const g = l.legs[legIdx(l, 'UCFHOU')]; g.ticker = 'KXNCAAFGAME-26OCT03UCFZZZ-UCF'; l.leg_keys = l.leg_keys.map((k) => k.replace('UCFHOU', 'UCFZZZ')); }));
  bad('ML pick not in game', mut(L.ml3, (l) => { const g = l.legs[legIdx(l, 'UCFHOU')]; g.ticker = 'KXNCAAFGAME-26OCT03UCFHOU-TXST'; l.leg_keys = l.leg_keys.map((k) => k.replace('UCFHOU-UCF', 'UCFHOU-TXST')); }));
  bad('ML clock in ticker', mut(L.ml3, (l) => { const g = l.legs[legIdx(l, 'UCFHOU')]; g.ticker = 'KXNCAAFGAME-26OCT031200UCFHOU-UCF'; l.leg_keys = l.leg_keys.map((k) => k.replace('26OCT03UCFHOU', '26OCT031200UCFHOU')); }));
  // date flips are mapped (a different identity), but then never match the Poly game
  for (const lockId of [L.ml3, L.ten]) {
    const lock = lockById(lockId);
    const l2 = mut(lockId, (l) => {
      const g = l.legs.find((x) => x.ticker.includes('26OCT03'));
      const t = g.ticker.replace('26OCT03', '26OCT04');
      l.leg_keys = l.leg_keys.map((k) => k.replace(g.ticker, t)); g.ticker = t;
    });
    assert.strictEqual(matchOf(mkRfq(LOCK_RFQ[lockId]), [l2]).parlay, null, 'one leg a day off');
    assert.ok(matchOf(mkRfq(LOCK_RFQ[lockId]), [lock]).parlay);
  }
  assert.ok(idsOf(unt).ok);
}

// ── 4. Kalshi spread/total line tickers: exact lines through the crosswalk ──
{
  const k = (t, label, game) => {
    const id = parseKalshiLineTicker(t, null, label, { requireLabel: true, game });
    return id && identityKey(id);
  };
  const G = 'North Texas vs Tulsa';
  assert.ok(k('KXNCAAFSPREAD-26OCT01UNTTLSA-TLSA2:no', 'North Texas +1.5', G));
  assert.strictEqual(k('KXNCAAFSPREAD-26OCT01UNTTLSA-TLSA2:no', 'North Texas +1.5', 'Tulsa vs Rice'), null);
  assert.strictEqual(k('KXNCAAFSPREAD-26OCT01UNTTLSA-TLSA2:no', 'North Texas +1.5', null), null, 'game text required');
  assert.strictEqual(k('KXNCAAFSPREAD-26OCT01UNTTLSA-TLSA2:yes', 'North Texas +1.5', G), null);
  assert.strictEqual(k('KXNCAAFSPREAD-26OCT01UNTTLSA-TLSA2:no', 'North Texas +2', G), null, 'no whole numbers');
  assert.strictEqual(k('KXNCAAFSPREAD-26OCT01UNTTLSA-RICE2:no', 'Rice +1.5', G), null, 'team not in game');
  assert.strictEqual(k('KXNCAAFSPREAD-26OCT01UNTTLSA-TLSA2:no', 'Tulsa +1.5', G), null);
  // four different propositions (NTX +1.5, NTX -1.5, Tulsa +1.5, Tulsa -1.5): four different keys
  const a = k('KXNCAAFSPREAD-26OCT01UNTTLSA-TLSA2:no', 'North Texas +1.5', G);
  const b = k('KXNCAAFSPREAD-26OCT01UNTTLSA-UNT2:yes', 'North Texas −1.5', G);
  const c = k('KXNCAAFSPREAD-26OCT01UNTTLSA-UNT2:no', 'Tulsa +1.5', G);
  const d = k('KXNCAAFSPREAD-26OCT01UNTTLSA-TLSA2:yes', 'Tulsa −1.5', G);
  assert.ok(a && b && c && d);
  assert.strictEqual(new Set([a, b, c, d]).size, 4);
  // totals
  assert.ok(k('KXNCAAFTOTAL-26OCT03BCSMU-56:yes', 'Over 55.5', 'Boston College vs SMU'));
  assert.strictEqual(k('KXNCAAFTOTAL-26OCT03BCSMU-56:yes', 'Under 55.5', 'Boston College vs SMU'), null);
  assert.strictEqual(k('KXNCAAFTOTAL-26OCT03BCSMU-56:yes', 'Over 56.5', 'Boston College vs SMU'), null);
  assert.strictEqual(k('KXNCAAFTOTAL-26OCT03ZZZYYY-56:yes', 'Over 55.5', 'A vs B'), null, 'unknown teams');
  // ML ticker parser
  const m = (t, label, game) => { const id = parseKalshiNcaafMlTicker(t, null, label, { requireLabel: true, game }); return id && identityKey(id); };
  assert.ok(m('KXNCAAFGAME-26OCT01UNTTLSA-UNT:yes', 'North Texas', G));
  assert.strictEqual(m('KXNCAAFGAME-26OCT01UNTTLSA-UNT:no', 'North Texas', G), null);
  assert.strictEqual(m('KXNCAAFGAME-26OCT01UNTTLSA-UNT:yes', 'Tulsa', G), null);
  assert.strictEqual(m('KXNCAAFGAME-26OCT01UNTTLSA-UNT:yes', null, G), null);
  assert.strictEqual(m('KXNFLGAME-26OCT04DENSF-DEN:yes', 'Denver', 'x vs y'), null);
  assert.strictEqual(m('KXNCAAFGAME-26OCT01UNTTLSA-UNT:yes', 'North Texas', 'North Texas vs Rice'), null);
}

// ── 5. Poly metadata cross-checks: any disagreement => no identity ──────────
{
  const slugs = {
    spread: 'asc-cfb-ntx-tulsa-2026-10-01-pos-1pt5',
    total: Object.keys(FX.markets).find((s) => /^tsc-cfb-/.test(s) && /-total-/.test(s)),
    ml: 'aec-cfb-ntx-tulsa-2026-10-01',
  };
  assert.ok(markets.get(slugs.spread) && markets.get(slugs.total) && markets.get(slugs.ml));
  const okSp = identityFromPolymarketLine(slugs.spread, BUY, markets.get(slugs.spread));
  assert.ok(okSp.identity && okSp.verified);
  const okTot = identityFromPolymarketLine(slugs.total, BUY, markets.get(slugs.total));
  assert.ok(okTot.identity && okTot.verified, okTot.reason);
  assert.ok(identityFromMarket(markets.get(slugs.ml), 'yes', { ncaaf: true }).identity);
  const tweak = (slug, fn) => { const m = clone(markets.get(slug)); fn(m); return m; };
  const spBad = {
    line: tweak(slugs.spread, (m) => { m.line = 2.5; }),
    date: tweak(slugs.spread, (m) => { m.gameStartTime = '2026-10-08T01:00:00Z'; }),
    type: tweak(slugs.spread, (m) => { m.sportsMarketType = 'football_team_first_half_spread'; }),
    longTeam: tweak(slugs.spread, (m) => { m.marketSides[0].team.abbreviation = 'rice'; }),
    shortTeam: tweak(slugs.spread, (m) => { m.marketSides[1].team.abbreviation = 'rice'; }),
    swap: tweak(slugs.spread, (m) => { m.marketSides.forEach((x) => { x.long = !x.long; }); }),
    league: tweak(slugs.spread, (m) => { m.marketSides[0].team.league = 'nfl'; }),
    name: tweak(slugs.spread, (m) => { m.marketSides[0].team.name = 'North Texas State'; }),
    desc: tweak(slugs.spread, (m) => { m.marketSides[0].description = '+2.50'; }),
    slug: tweak(slugs.spread, (m) => { m.slug = 'asc-cfb-ntx-tulsa-2026-10-01-pos-2pt5'; }),
  };
  for (const [n, m] of Object.entries(spBad)) {
    assert.strictEqual(identityFromPolymarketLine(slugs.spread, BUY, m).identity, null, `spread meta ${n}`);
  }
  const totBad = {
    line: tweak(slugs.total, (m) => { m.line += 1; }),
    type: tweak(slugs.total, (m) => { m.sportsMarketType = 'football_team_first_half_total'; }),
    overUnder: tweak(slugs.total, (m) => { m.marketSides.forEach((x) => { x.long = !x.long; }); }),
    date: tweak(slugs.total, (m) => { m.gameStartTime = '2026-12-01T01:00:00Z'; }),
    question: tweak(slugs.total, (m) => { m.question = 'Will the total in Rice vs. UTSA be more than 49.5?'; }),
  };
  for (const [n, m] of Object.entries(totBad)) {
    assert.strictEqual(identityFromPolymarketLine(slugs.total, BUY, m).identity, null, `total meta ${n}`);
  }
  const mlBad = {
    type: tweak(slugs.ml, (m) => { m.sportsMarketType = 'football_team_first_half_winner'; }),
    date: tweak(slugs.ml, (m) => { m.gameStartTime = '2026-10-09T01:00:00Z'; }),
    swap: tweak(slugs.ml, (m) => { m.marketSides.forEach((x) => { x.long = !x.long; }); }),
    team: tweak(slugs.ml, (m) => { m.marketSides[1].team.abbreviation = 'rice'; }),
    name: tweak(slugs.ml, (m) => { m.marketSides[0].team.name = 'Somebody Else'; }),
    league: tweak(slugs.ml, (m) => { m.marketSides[0].team.league = 'nfl'; }),
    slug: tweak(slugs.ml, (m) => { m.slug = 'aec-cfb-tulsa-ntx-2026-10-01'; }),
  };
  for (const [n, m] of Object.entries(mlBad)) {
    assert.strictEqual(identityFromMarket(m, 'yes', { ncaaf: true }).identity, null, `ml meta ${n}`);
  }
  // no metadata: college ML never falls back to the slug
  const legs = [{ symbol: slugs.ml, side: BUY }];
  assert.strictEqual(identitiesFromPolymarketLegs(legs, new Map()).ok, false);
  assert.strictEqual(identitiesFromPolymarketLegs(legs, new Map([[slugs.ml, mlBad.swap]])).ok, false);
  assert.ok(identityFromPolymarketSlug('aec-cfb-ntx-tulsa-2026-10-01', BUY), 'slug-derived college ML is only a prefilter for known teams');
  // unknown cfb teams: slug prefilter refuses
  assert.strictEqual(identityFromPolymarketSlug('aec-cfb-zzz-yyy-2026-10-01', BUY), null);
  assert.strictEqual(identityFromPolymarketLine('asc-cfb-zzz-yyy-2026-10-01-pos-1pt5', BUY, null).identity, null);
  // non-full-game / team-total / period markets are never mapped
  for (const slug of Object.keys(FX.markets)) {
    if (!/-cfb-/.test(slug)) continue;
    if (/^(asc|tsc)-cfb-[a-z0-9]+-[a-z0-9]+-\d{4}-\d\d-\d\d-(neg-|pos-|total-)\d+pt\d$/.test(slug)) continue;
    if (/^aec-/.test(slug)) continue;
    assert.strictEqual(identityFromPolymarketLine(slug, BUY, markets.get(slug)).identity, null, `unmapped ${slug}`);
  }
  // the real half-point lines in the capture all verify (spread + total)
  let verified = 0;
  for (const [slug, mk] of Object.entries(FX.markets)) {
    if (!/^(asc|tsc)-cfb-[a-z0-9]+-[a-z0-9]+-\d{4}-\d\d-\d\d-(neg-|pos-|total-)\d+pt\d$/.test(slug)) continue;
    const r = identityFromPolymarketLine(slug, BUY, mk);
    if (r.identity && r.verified) verified += 1;
  }
  assert.ok(verified > 300, `verified real lines=${verified}`);
}

// ── 6. Oracle fuzz: identity equality <=> proposition equality (college) ────
{
  // margin = NTX - TULSA. Kalshi tickers use Kalshi codes (UNT, TLSA); Poly uses ntx/tulsa.
  const G = 'North Texas vs Tulsa';
  const sfmt = (m) => `${Math.floor(m)}pt${Math.round((m % 1) * 10)}`;
  const meta = (kind, slug, line) => ({
    slug, sportsMarketType: kind === 'spread' ? 'football_team_full_game_spread' : 'football_team_full_game_total', line,
    gameStartTime: '2026-10-02T01:00:00Z', question: 'Will the total in North Texas vs. Tulsa be more than 49.5?',
    marketSides: kind === 'spread'
      ? [{ long: true, description: (line > 0 ? '+' : '') + line.toFixed(2), team: { name: 'North Texas', abbreviation: 'ntx', league: 'cfb' } },
        { long: false, description: (line > 0 ? '-' : '+') + Math.abs(line).toFixed(2), team: { name: 'Tulsa', abbreviation: 'tulsa', league: 'cfb' } }]
      : [{ long: true, description: 'Over' }, { long: false, description: 'Under' }],
  });
  const margins = []; for (let m = -40; m <= 40; m += 1) margins.push(m);
  const vec = (f) => margins.map((m) => (f(m) ? '1' : '0')).join('');
  const props = [];
  const fm = new Map();
  for (let mag = 0.5; mag <= 14.5; mag += 1) {
    const num = Math.round(mag + 0.5);
    for (const [team, kc, nm, opp] of [['NTX', 'UNT', 'North Texas', 'Tulsa'], ['TUL', 'TLSA', 'Tulsa', 'North Texas']]) {
      for (const sd of ['yes', 'no']) {
        const sgn = team === 'NTX' ? 1 : -1;
        const wins = (m) => sgn * m > mag;
        const truth = sd === 'yes' ? vec(wins) : vec((m) => !wins(m));
        const label = sd === 'yes' ? `${nm} −${mag}` : `${opp} +${mag}`;
        const id = parseKalshiLineTicker(`KXNCAAFSPREAD-26OCT01UNTTLSA-${kc}${num}:${sd}`, null, label, { requireLabel: true, game: G });
        assert.ok(id, `kalshi ${kc}${num}:${sd}`);
        props.push({ src: `K ${kc}${num}:${sd}`, key: identityKey(id), truth });
      }
    }
    for (const dir of ['neg', 'pos']) {
      const slug = `asc-cfb-ntx-tulsa-2026-10-01-${dir}-${sfmt(mag)}`;
      const signed = dir === 'neg' ? -mag : mag;
      fm.set(slug, meta('spread', slug, signed));
      for (const [sd, side] of [['BUY', BUY], ['SELL', SELL]]) {
        const covers = (m) => m + signed > 0;
        const truth = sd === 'BUY' ? vec(covers) : vec((m) => !covers(m));
        const r = identityFromPolymarketLine(slug, side, fm.get(slug));
        assert.ok(r.identity && r.verified, `${slug} ${sd}`);
        props.push({ src: `P ${slug} ${sd}`, key: identityKey(r.identity), truth });
      }
    }
  }
  const totals = [];
  const pts = []; for (let t = 0; t <= 120; t += 1) pts.push(t);
  const tv = (f) => pts.map((t) => (f(t) ? '1' : '0')).join('');
  for (let line = 30.5; line <= 80.5; line += 1) {
    const num = Math.round(line + 0.5);
    for (const sd of ['yes', 'no']) {
      const over = (t) => t > line;
      const id = parseKalshiLineTicker(`KXNCAAFTOTAL-26OCT01UNTTLSA-${num}:${sd}`, null, `${sd === 'yes' ? 'Over' : 'Under'} ${line}`, { requireLabel: true, game: G });
      assert.ok(id);
      totals.push({ src: `K total ${num}:${sd}`, key: identityKey(id), truth: sd === 'yes' ? tv(over) : tv((t) => !over(t)) });
    }
    const slug = `tsc-cfb-ntx-tulsa-2026-10-01-total-${sfmt(line)}`;
    fm.set(slug, meta('total', slug, line));
    for (const [sd, side] of [['BUY', BUY], ['SELL', SELL]]) {
      const over = (t) => t > line;
      const r = identityFromPolymarketLine(slug, side, fm.get(slug));
      assert.ok(r.identity && r.verified);
      totals.push({ src: `P ${slug} ${sd}`, key: identityKey(r.identity), truth: sd === 'BUY' ? tv(over) : tv((t) => !over(t)) });
    }
  }
  let pairs = 0;
  for (const group of [props, totals]) {
    for (const x of group) for (const y of group) {
      if (x === y) continue;
      pairs += 1;
      assert.strictEqual(x.key === y.key, x.truth === y.truth, `identity equality must equal proposition equality: ${x.src} vs ${y.src}`);
    }
  }
  assert.ok(pairs > 20000, `pairs=${pairs}`);
  // moneyline oracle across the 4 combinations: Kalshi UNT:yes == Poly ntx BUY == tulsa SELL; others differ
  const mlK = (t, lab) => identityKey(parseKalshiNcaafMlTicker(t, null, lab, { requireLabel: true, game: G }));
  const mlP = (side) => identityKey(identityFromMarket(markets.get('aec-cfb-ntx-tulsa-2026-10-01'), side === BUY ? 'yes' : 'no', { ncaaf: true }).identity);
  const kUnt = mlK('KXNCAAFGAME-26OCT01UNTTLSA-UNT:yes', 'North Texas');
  const kTul = mlK('KXNCAAFGAME-26OCT01UNTTLSA-TLSA:yes', 'Tulsa');
  assert.strictEqual(kUnt, mlP(BUY));
  assert.strictEqual(kTul, mlP(SELL));
  assert.notStrictEqual(kUnt, kTul);
}

// ── 7. Real open RFQs (cfb legs) vs the 16 active locks: only provable hits ─
{
  let matched = 0; let seenCfb = 0;
  for (const r of FX.rfqs) {
    seenCfb += 1;
    if (matchOf(r, FX.locks).parlay) matched += 1;
  }
  assert.ok(seenCfb >= 50);
  assert.strictEqual(matched, 0, 'no captured third-party RFQ equals an active lock');
  // Every real captured cfb leg whose metadata is in the capture yields an identity or a clean refusal (no throw)
  for (const r of FX.rfqs) identitiesFromPolymarketLegs(r.comboLegs, markets);
}

// ── 8. Safeguards: game start, size, price ceiling, live loop ───────────────
(async () => {
  const lock = lockById(L.ml3);
  const rfq = mkRfq(LOCK_RFQ[L.ml3]);
  const base = { rfq, parlays: [lock], markets, filledSoFar: 0, outstanding: 0, startedFor: () => ({ started: false }) };
  const kick = Date.parse('2026-10-03T16:00:00Z'); // UCF-Houston, earliest of the 3 legs
  const before = evaluatePolymarketRfq({ ...base, now: kick - 60000 });
  assert.strictEqual(before.action, 'quoteable');
  assert.strictEqual(before.polyStartMs, kick, 'earliest Poly kickoff across NCAAF legs');
  const after = evaluatePolymarketRfq({ ...base, now: kick + 60000 });
  assert.strictEqual(after.reason, 'game_started');
  assert.strictEqual(after.started.source, 'poly.market.gameStartTime');
  const q = before.quote;
  assert.strictEqual(q.sellPrice, '0');
  assert.ok(Number(q.buyPrice) > 0 && Number(q.buyPrice) <= 1 / (1 + lock.fill_american / 100) + 1e-9 + 0.0005, `never worse than lock: ${q.buyPrice}`);
  const big = evaluatePolymarketRfq({ ...base, rfq: { ...rfq, cashOrderQty: undefined, qtyDecimal: '1000000' }, now: kick - 60000 });
  assert.strictEqual(big.reason, 'rfq_too_large');

  // lock logging: mapped college locks are no longer reported unpriceable
  const logs = [];
  assert.strictEqual(logUnpriceablePolyLocks(FX.locks, (m) => logs.push(m)), 0);
  const broken = clone(lockById(L.unt)); broken.legs[0].label = 'Nobody +1.5';
  const logs2 = [];
  assert.strictEqual(logUnpriceablePolyLocks([broken], (m) => logs2.push(m)), 1);
  assert.ok(logs2.some((l) => l.includes('why=ncaaf_not_mapped')));

  // live loop: exact college RFQ posts; a flipped leg never does
  const SEED_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  const posts = [];
  const http = {
    async getUserId() { return { rfqUserId: 'rfquser_test' }; },
    async listRfqs() { return { rfqs: [] }; },
    async listQuotes() { return { quotes: [] }; },
    async getCombo() { return { combos: [] }; },
    async createQuote(body) { posts.push(body); return { quoteId: 'quote_ncaaf' }; },
    async confirmQuote() { return {}; },
    async deleteQuote() { return { statusCode: 200 }; },
    close() {},
  };
  const pending = new Map();
  const loop = startPolymarketRfqLoop({
    env: { POLYMARKET_KEY_ID: 'key-id-fixture', POLYMARKET_SECRET_KEY: SEED_B64, POLYMARKET_RFQ_LIVE: 'true' },
    http, startWs: false, getParlays: () => [lock],
    fetchMarket: async (slug) => markets.get(slug) || null,
    startedFor: () => ({ started: false }), filledSoFarFor: () => 0, getOutstanding: () => 0,
    pendingQuotes: pending, reconcileMs: 60 * 60 * 1000, crawl: false,
  });
  const origLog = console.log; console.log = () => {};
  const realNow = Date.now; Date.now = () => Date.parse('2026-10-03T12:00:00Z');
  try {
    const flipped = LOCK_RFQ[L.ml3].map((x, i) => (i === 1 ? [x[0], SELL] : x));
    const bad = await loop.handleRfq({ ...mkRfq(flipped), id: 'rfq_flip', createdTime: new Date().toISOString() });
    assert.ok(!bad.post);
    assert.strictEqual(posts.length, 0);
    const good = await loop.handleRfq({ ...mkRfq(LOCK_RFQ[L.ml3]), id: 'rfq_good', createdTime: new Date().toISOString() });
    assert.ok(good.post, `exact college RFQ quotes: ${good.reason}`);
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].sellPrice, '0');
    assert.ok(Array.from(pending.values()).some((p) => p.polyStartMs === kick), 'kickoff carried to confirm');
    const entry = Array.from(pending.entries()).find(([, p]) => p.polyStartMs);
    entry[1].polyStartMs = Date.now() - 1000;
    const acc = await loop.handleQuoteAccepted({ quote: { id: entry[0], rfqId: 'rfq_good', acceptedSide: 'SIDE_BUY' } });
    assert.strictEqual(acc.confirmed, false);
    assert.strictEqual(acc.reason, 'game_started');
  } finally {
    Date.now = realNow; console.log = origLog; loop.stop();
  }
  console.log('poly-ncaaf.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
