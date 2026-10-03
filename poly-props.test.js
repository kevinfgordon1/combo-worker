'use strict';
// Polymarket US player props: NFL anytime touchdowns (Kalshi KXNFLTD <-> Poly astatc-…-td-…-gteN)
// and MLB home runs (KXMLBHR <-> astatc-…-hr-…-gteN).
// REAL data: fixtures-props-captures.json (Kalshi KXNFLTD/KXMLBHR events + Poly event
// markets the crosswalk is generated from, 2026-10-01) and fixtures-props.json (Poly
// /v1/market/slug metadata for 19 prop markets + 14 real open RFQs made only of crosswalk TD legs).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('./leg-identity');
const PX = require('./player-prop-crosswalk');
const { buildPropCrosswalk } = require('./scripts/gen-prop-crosswalk');
const {
  normalizePolymarketRfq, couldMatchActiveLocks, matchPolymarketParlayDetailed,
  evaluatePolymarketRfq, countPriceableLocks, logUnpriceablePolyLocks, startPolymarketRfqLoop,
} = require('./polymarket-rfq');

const rd = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const CAP = rd('fixtures-props-captures.json');
const FX = rd('fixtures-props.json');
const XW = rd('player-prop-crosswalk.json');
const markets = new Map(Object.entries(FX.markets));
const BUY = 'SIDE_BUY';
const SELL = 'SIDE_SELL';
const clone = (x) => JSON.parse(JSON.stringify(x));
const mkRfq = (legs, extra) => ({
  id: 'rfq_test', status: 'RFQ_STATUS_OPEN', cashOrderQty: '10', symbol: 'caoc-test',
  comboLegs: legs.map(([symbol, side]) => ({ symbol, side })), ...extra,
});
const matchOf = (rfq, locks, mk) => matchPolymarketParlayDetailed(normalizePolymarketRfq(rfq), locks, { markets: mk || markets });
const byPoly = new Map(XW.players.map((p) => [`${p.poly.stem}|${p.poly.abbr}`, p]));
const polyOf = (slug) => {
  const m = /^astatc-(nfl|mlb)-(.+-\d{4}-\d\d-\d\d)-(td|hr)-([a-z0-9]+)-gte(\d)$/.exec(slug);
  return { p: byPoly.get(`${m[1]}-${m[2]}|${m[4]}`), n: Number(m[5]), kind: m[3] };
};
// Lock leg for a Poly prop slug, exactly the way Combo Locks stores legs
// ({ticker, side, label, type, game, gameKey}); label = Kalshi's own "Player: N+" sub-title.
const legFor = (slug) => {
  const { p, n } = polyOf(slug);
  return { game: 'PIT vs CLE', side: 'yes', type: 'prop', label: `${p.name}: ${n}+`, ticker: `${p.k}-${n}`, gameKey: 'nfl:x' };
};
const lockFor = (slugs, extra) => {
  const legs = slugs.map(legFor);
  return {
    ...FX.lockTemplate, id: 'lock-' + slugs.join('+').length, label: 'prop lock', legs,
    leg_keys: legs.map((l) => `${l.ticker}:yes`), starts_at: '2026-10-04T17:00:00+00:00', ...extra,
  };
};

// ── 1. Crosswalk: reproducible from real captures, safe by construction ─────
{
  const rebuilt = buildPropCrosswalk(CAP.kalshi, CAP.poly, { generatedAt: CAP.capturedAt });
  assert.deepStrictEqual(rebuilt.players, XW.players, 'checked-in crosswalk == regenerated from captures');
  assert.deepStrictEqual(rebuilt.unmatchedKalshi, XW.unmatchedKalshi);
  assert.ok(XW.players.length >= 300, `players=${XW.players.length}`);
  const seenK = new Set(); const seenP = new Set();
  for (const p of XW.players) {
    assert.ok(!seenK.has(p.k) && !seenP.has(`${p.poly.stem}|${p.poly.abbr}`), 'one-to-one');
    seenK.add(p.k); seenP.add(`${p.poly.stem}|${p.poly.abbr}`);
    assert.ok(!/D\/ST/i.test(p.name));
    assert.ok(p.kalshiThresholds.length && p.polyThresholds.length);
    const kb = /^KXNFLTD-\d\d[A-Z]{3}\d\d([A-Z]+)-/.exec(p.k)[1].toLowerCase();
    const kt = L.splitKnownCodes(kb, 'nfl').map((t) => L.normTeam('nfl', t)).sort().join();
    const pt = p.poly.stem.split('-').slice(1, 3).map((t) => L.normTeam('nfl', t)).sort().join();
    assert.strictEqual(kt, pt, `game teams agree ${p.k}`);
  }
  // D/ST markets are never mapped; every reason is explicit
  const dst = XW.unmatchedKalshi.filter((u) => u.why === 'team_defense_not_a_poly_player_market');
  assert.strictEqual(dst.length, 32);
  assert.ok(XW.unmatchedKalshi.every((u) => u.why));
  // names that are NOT identical stay unmapped (certainty only)
  const un = (name) => XW.unmatchedKalshi.some((u) => u.name === name && u.why === 'no_poly_player_same_full_name_and_team');
  assert.ok(un('Kenneth Walker III'), 'Poly says "Kenneth Walker": not the identical name => unmapped');
  assert.ok(un('Mitchell Tinsley'), 'Poly says "Mitch Tinsley" => unmapped');
  assert.ok(!XW.players.some((p) => p.name === 'Kenneth Walker III'));
  // MLB: the only Poly HR props are for a game whose first pitch disagrees with Kalshi's
  // (Kalshi 2:00 PM ET vs Poly "Game 3" 8:00 PM ET) => whole game stays unmapped.
  assert.strictEqual(XW.players.filter((p) => p.league === 'mlb').length, 0);
  assert.ok(XW.unmatchedKalshi.some((u) => u.kalshiEvent === 'KXMLBHR-26OCT011400PHIATL' && u.why === 'poly_first_pitch_clock_disagrees_with_kalshi'));

  // Mutations of the real captures: each breaks the pairing, never silently re-pairs.
  const mut = (fn) => { const c = clone(CAP); fn(c); return buildPropCrosswalk(c.kalshi, c.poly); };
  const ks = (x) => new Set(x.players.map((p) => p.k));
  const W = 'KXNFLTD-26OCT01PITCLE-CLEDWATSON4';
  assert.ok(ks(XW).has(W));
  // player renamed on Poly => unmapped
  let x = mut((c) => { for (const m of c.poly['nfl-pit-cle-2026-10-01'].markets) if (m.metadata.playerName === 'Deshaun Watson') m.metadata.playerName = 'Deshaun Watsonn'; });
  assert.ok(!ks(x).has(W));
  // Poly player on the OTHER team (teamId swapped) => unmapped
  x = mut((c) => { for (const m of c.poly['nfl-pit-cle-2026-10-01'].markets) if (m.metadata.playerName === 'Deshaun Watson') m.metadata.teamId = 74; });
  assert.ok(!ks(x).has(W));
  // wrong date on Poly game
  x = mut((c) => { const e = c.poly['nfl-pit-cle-2026-10-01']; delete c.poly['nfl-pit-cle-2026-10-01']; e.slug = 'nfl-pit-cle-2026-10-02'; c.poly[e.slug] = e; });
  assert.ok(!ks(x).has(W));
  // two Poly players with the same full name on one team => ambiguous, unmapped
  x = mut((c) => {
    const e = c.poly['nfl-pit-cle-2026-10-01'];
    const orig = e.markets.find((m) => m.metadata.playerName === 'Deshaun Watson' && m.line === 1);
    const dup = clone(orig); dup.slug = dup.slug.replace('deswat', 'deswa2'); dup.metadata.playerAbbreviation = 'deswa2'; dup.metadata.playerId = 999999;
    e.markets.push(dup);
  });
  assert.ok(!ks(x).has(W));
  // two Kalshi markets, same name on a team => unmapped
  x = mut((c) => {
    const e = c.kalshi.KXNFLTD.find((v) => v.event_ticker === 'KXNFLTD-26OCT01PITCLE');
    e.markets.push({ ticker: 'KXNFLTD-26OCT01PITCLE-CLEDWATSON5-1', yes_sub_title: 'Deshaun Watson: 1+' });
  });
  assert.ok(!ks(x).has(W) && !ks(x).has('KXNFLTD-26OCT01PITCLE-CLEDWATSON5'));
  // MLB first pitch agreeing (same real Poly game, Kalshi clock moved to 8:00 PM ET) => maps
  const mlbCap = clone(CAP);
  mlbCap.kalshi.KXMLBHR = mlbCap.kalshi.KXMLBHR.filter((e) => e.event_ticker.endsWith('PHIATL'))
    .map((e) => ({ ...e, event_ticker: 'KXMLBHR-26OCT012000PHIATL', markets: e.markets.map((m) => ({ ...m, ticker: m.ticker.replace('26OCT011400', '26OCT012000') })) }));
  const mlbX = buildPropCrosswalk(mlbCap.kalshi, mlbCap.poly);
  const riley = mlbX.players.find((p) => p.name === 'Austin Riley');
  assert.ok(riley && riley.kind === 'hr' && riley.poly.stem === 'mlb-phi-atl-2026-10-01', 'MLB maps only when first pitch agrees');
  assert.ok(mlbX.players.filter((p) => p.league === 'mlb').length >= 15);
  assert.ok(mlbX.unmatchedKalshi.some((u) => u.name === 'Michael Harris' && u.why === 'no_poly_player_same_full_name_and_team'), 'Poly "Michael Harris II" != Kalshi "Michael Harris"');
  // ...and fails again when the clocks differ by more than 45 minutes
  mlbCap.kalshi.KXMLBHR[0].event_ticker = 'KXMLBHR-26OCT011900PHIATL';
  mlbCap.kalshi.KXMLBHR[0].markets.forEach((m) => { m.ticker = m.ticker.replace('26OCT012000', '26OCT011900'); });
  assert.strictEqual(buildPropCrosswalk(mlbCap.kalshi, mlbCap.poly).players.filter((p) => p.league === 'mlb').length, 0);
  global.__mlbX = mlbX;
}

// ── 2. Kalshi ticker -> identity (label REQUIRED; exact N, name, game) ─────────
const T = 'KXNFLTD-26OCT01PITCLE-CLEDWATSON4';
const idOf = (ticker, label, side) => L.parseKalshiPropTicker(ticker, side || null, label);
{
  const a = idOf(`${T}-1`, 'Deshaun Watson: 1+');
  assert.ok(a && a.marketType === 'td' && a.line === 1 && a.side === 'yes' && a.selection === 'p.deswat');
  assert.deepStrictEqual(a.teams, ['cle', 'pit']);
  assert.strictEqual(a.date, '2026-10-01');
  // threshold: 1+ and 2+ are different keys; ticker N must equal label N
  const b = idOf(`${T}-2`, 'Deshaun Watson: 2+');
  assert.ok(b && b.line === 2);
  assert.notStrictEqual(L.identityKey(a), L.identityKey(b));
  assert.strictEqual(idOf(`${T}-1`, 'Deshaun Watson: 2+'), null, 'label threshold disagrees');
  assert.strictEqual(idOf(`${T}-2`, 'Deshaun Watson: 1+'), null);
  assert.strictEqual(idOf(`${T}-3`, 'Deshaun Watson: 3+'), null, 'no Poly gte3 for Watson');
  // label required, and must name the same full player
  assert.strictEqual(idOf(`${T}-1`, null), null);
  assert.strictEqual(idOf(`${T}-1`, ''), null);
  assert.strictEqual(idOf(`${T}-1`, 'Aaron Rodgers: 1+'), null);
  assert.strictEqual(idOf(`${T}-1`, 'Deshaun Watson'), null);
  assert.strictEqual(idOf(`${T}-1`, 'Deshaun Watson: 1+ touchdowns'), null);
  // :no is not mapped; unknown side tokens neither
  assert.strictEqual(idOf(`${T}-1`, 'Deshaun Watson: 1+', 'no'), null);
  assert.strictEqual(L.parseKalshiPropTicker(`${T}-1:no`, null, 'Deshaun Watson: 1+'), null);
  assert.ok(L.parseKalshiPropTicker(`${T}-1:yes`, null, 'Deshaun Watson: 1+'));
  // player not in crosswalk / D/ST / wrong team in ticker / wrong game / wrong date
  assert.strictEqual(idOf('KXNFLTD-26OCT01PITCLE-CLECLEDST-1', 'CLE Browns D/ST: 1+'), null);
  assert.strictEqual(idOf('KXNFLTD-26OCT01PITCLE-PITDWATSON4-1', 'Deshaun Watson: 1+'), null);
  assert.strictEqual(idOf('KXNFLTD-26OCT01PITCLE-CLEKWALKER9-1', 'Kenneth Walker: 1+'), null);
  assert.strictEqual(idOf('KXNFLTD-26OCT02PITCLE-CLEDWATSON4-1', 'Deshaun Watson: 1+'), null, 'date flipped');
  assert.strictEqual(idOf('KXNFLTD-26OCT01PITBAL-CLEDWATSON4-1', 'Deshaun Watson: 1+'), null, 'teams flipped');
  assert.strictEqual(idOf('KXNFLTD-26OCT01CLEPIT-CLEDWATSON4-1', 'Deshaun Watson: 1+'), null, 'ticker not in crosswalk (event blob differs)');
  // other prop series are never mapped
  assert.strictEqual(idOf('KXNFLPASSTDS-26OCT01PITCLE-CLEDWATSON4-1', 'Deshaun Watson: 1+'), null);
  assert.strictEqual(idOf('KXNFLFIRSTTD-26OCT01PITCLE-CLEDWATSON4', 'Deshaun Watson: 1+'), null);
  // same player/threshold on a different real game => its own identity
  const mur = XW.players.find((p) => p.name === 'Kyler Murray');
  const c = idOf(`${mur.k}-1`, 'Kyler Murray: 1+');
  assert.ok(c && c.date === '2026-10-04' && c.selection === 'p.kylmur');
  assert.notStrictEqual(L.identityKey(a), L.identityKey(c));
}

// ── 3. Poly metadata -> identity (verified) ───────────────────────────────────
const W1 = 'astatc-nfl-pit-cle-2026-10-01-td-deswat-gte1';
const W2 = 'astatc-nfl-pit-cle-2026-10-01-td-deswat-gte2';
{
  const kal = idOf(`${T}-1`, 'Deshaun Watson: 1+');
  const buy = L.identityFromPolymarketProp(W1, 'yes', markets.get(W1));
  assert.ok(buy.verified && buy.identity);
  assert.strictEqual(L.identityKey(buy.identity), L.identityKey(kal), 'BUY Yes == Kalshi :yes');
  assert.strictEqual(buy.identity.startMs, Date.parse('2026-10-02T00:15:00Z'));
  const sell = L.identityFromPolymarketProp(W1, 'no', markets.get(W1));
  assert.notStrictEqual(L.identityKey(sell.identity), L.identityKey(kal), 'SELL (No) != Kalshi :yes');
  const g2 = L.identityFromPolymarketProp(W2, 'yes', markets.get(W2));
  assert.notStrictEqual(L.identityKey(g2.identity), L.identityKey(kal), 'gte2 != 1+');
  assert.strictEqual(L.identityKey(g2.identity), L.identityKey(idOf(`${T}-2`, 'Deshaun Watson: 2+')));
  // slug-only (no metadata) is a prefilter candidate, never verified
  assert.strictEqual(L.identityFromPolymarketProp(W1, 'yes', null).verified, false);
  // not mapped: passing TD, first TD, other prop families, non-crosswalk player, D/ST-like
  for (const s of ['astatc-nfl-pit-cle-2026-10-01-ptd-deswat-gte1', 'astatc-nfl-pit-cle-2026-10-01-firsttd-deswat',
    'astatc-nfl-pit-cle-2026-10-01-recyd-deswat-gte50', 'astatc-nfl-pit-cle-2026-10-01-td-nobody-gte1',
    'astatc-nfl-pit-cle-2026-10-01-td-deswat-gte4', 'astatc-nfl-pit-cle-2026-10-02-td-deswat-gte1',
    'astatc-mlb-pit-cle-2026-10-01-td-deswat-gte1', 'astatc-nfl-pit-cle-2026-10-01-hr-deswat-gte1']) {
    assert.strictEqual(L.identityFromPolymarketProp(s, 'yes', markets.get(s) || markets.get(W1)).identity, null, s);
  }
  // metadata mutations: every one fails closed
  const bad = (fn) => { const m = clone(markets.get(W1)); fn(m); return L.identityFromPolymarketProp(W1, 'yes', m); };
  const failing = [
    (m) => { m.sportsMarketType = 'football_player_passing_touchdowns'; },
    (m) => { m.sportsMarketType = 'football_player_first_touchdown'; },
    (m) => { m.line = 2; },
    (m) => { m.line = 0.5; },
    (m) => { m.slug = W2; },
    (m) => { m.metadata.playerName = 'Aaron Rodgers'; },
    (m) => { m.metadata.playerAbbreviation = 'aarrod'; },
    (m) => { m.metadata.playerId = 4032; },
    (m) => { m.metadata.teamId = 74; },
    (m) => { m.metadata.lineLabel = '2+'; },
    (m) => { m.gameStartTime = '2026-10-03T00:15:00Z'; },
    (m) => { m.gameStartTime = '2026-10-02T03:00:00Z'; },
    (m) => { m.gameStartTime = null; },
    (m) => { m.marketSides = m.marketSides.map((s) => ({ ...s, long: !s.long })); },
    (m) => { m.marketSides[0].description = 'No'; },
    (m) => { m.marketSides = [m.marketSides[0]]; },
    (m) => { delete m.metadata; },
  ];
  failing.forEach((fn, i) => assert.strictEqual(bad(fn).identity, null, `mutation ${i}`));
  assert.strictEqual(L.identityFromPolymarketProp(W1, 'yes', {}).identity, null);
  // sanity: the unmutated copy works
  assert.ok(bad(() => {}).identity);
}

// ── 4. MLB home runs through an MLB-capable crosswalk index ───────────────────
{
  const idx = PX.index(global.__mlbX.players);
  const ril = global.__mlbX.players.find((p) => p.name === 'Austin Riley');
  assert.ok(ril);
  const k = idOfIdx(`${ril.k}-1`, 'Austin Riley: 1+');
  function idOfIdx(t, label) { return L.parseKalshiPropTicker(t, null, label, { idx }); }
  assert.ok(k && k.marketType === 'hr' && k.line === 1 && k.startMs === Date.parse('2026-10-01T20:00:00-04:00'));
  assert.strictEqual(k.date, '2026-10-01');
  assert.strictEqual(idOfIdx(`${ril.k}-2`, 'Austin Riley: 2+') && idOfIdx(`${ril.k}-2`, 'Austin Riley: 2+').line, 2);
  assert.strictEqual(idOfIdx(`${ril.k}-1`, 'Austin Riley: 2+'), null);
  // a real Poly HR market (Schwarber) for the same game verifies; BUY==Yes only
  const S1 = 'astatc-mlb-phi-atl-2026-10-01-hr-kylsch-gte1';
  const sch = global.__mlbX.players.find((p) => p.name === 'Kyle Schwarber');
  const kk = idOfIdx(`${sch.k}-1`, 'Kyle Schwarber: 1+');
  const pp = L.identityFromPolymarketProp(S1, 'yes', markets.get(S1), { idx });
  assert.ok(pp.verified && L.identityKey(pp.identity) === L.identityKey(kk));
  assert.notStrictEqual(L.identityKey(L.identityFromPolymarketProp(S1, 'no', markets.get(S1), { idx }).identity), L.identityKey(kk));
  const S2 = 'astatc-mlb-phi-atl-2026-10-01-hr-kylsch-gte2';
  assert.notStrictEqual(L.identityKey(L.identityFromPolymarketProp(S2, 'yes', markets.get(S2), { idx }).identity), L.identityKey(kk));
  // hr slug with a td market type / wrong league mutate => null
  const mm = clone(markets.get(S1)); mm.sportsMarketType = 'football_player_touchdowns';
  assert.strictEqual(L.identityFromPolymarketProp(S1, 'yes', mm, { idx }).identity, null);
  // first-pitch gating: startTimesAgree rejects a doubleheader-style clock mismatch
  const lockId = kk; const polyId = pp.identity;
  assert.ok(L.startTimesAgree([lockId], [polyId]));
  assert.ok(!L.startTimesAgree([{ ...lockId, startMs: lockId.startMs - 6 * 3600e3 }], [polyId]), 'Kalshi 2PM vs Poly 8PM');
  assert.ok(!L.startTimesAgree([{ ...lockId, startMs: undefined }], [polyId]), 'MLB without a Kalshi clock never matches');
  // Without the MLB crosswalk entries (production today), MLB legs are unmapped
  assert.strictEqual(L.parseKalshiPropTicker(`${ril.k}-1`, null, 'Austin Riley: 1+'), null);
  assert.strictEqual(L.identityFromPolymarketProp(S1, 'yes', markets.get(S1)).identity, null);
}

// ── 5. Real open RFQs <-> locks built from the same legs ──────────────────────
(async () => {
  assert.ok(FX.rfqs.length >= 10);
  let checked = 0;
  for (const raw of FX.rfqs) {
    const legs = raw.comboLegs.map((l) => [l.symbol, l.side]);
    assert.ok(legs.every(([, s]) => s === BUY), 'real captured RFQs are BUY(Yes) legs');
    const lock = lockFor(legs.map(([s]) => s));
    assert.strictEqual(L.identitiesFromParlay(lock, { lines: true }).ok, true, 'lock readable');
    const rfq = { ...raw, status: 'RFQ_STATUS_OPEN' };
    const hit = matchOf(rfq, [lock]);
    assert.ok(hit.parlay && hit.parlay.id === lock.id, `real RFQ ${raw.id} hits its lock: ${hit.reason}`);
    assert.ok(couldMatchActiveLocks(normalizePolymarketRfq(rfq), [lock]), 'prefilter admits');
    const ev = evaluatePolymarketRfq({ rfq, parlays: [lock], markets, now: Date.parse('2026-10-01T20:00:00Z'), startedFor: () => ({ started: false }) });
    assert.strictEqual(ev.action, 'quoteable', ev.reason);
    assert.ok(ev.polyStartMs != null);
    const q = ev.quote;
    assert.strictEqual(q.sellPrice, '0');
    {
      // POLY_EXACT_TARGET (default on): price + maker rebate never nets below the lock target, and is never
      // more than the rebate (theta/4) below it or one tick above it.
      const target = 1 / (1 + lock.fill_american / 100);
      const px = Number(q.buyPrice);
      assert.ok(px > 0 && px <= 1, `price ${q.buyPrice}`);
      assert.ok(px + (ev.quote.rebateCredit || 0) + 1e-9 >= target, `never worse than lock ${q.buyPrice} vs ${target}`);
      assert.ok(px <= target + 0.001 + 1e-9 && px >= target - 0.0032, `within a tick of lock ${q.buyPrice} vs ${target}`);
    }
    // leg order irrelevant
    assert.ok(matchOf(mkRfq(legs.slice().reverse()), [lock]).parlay);
    // flip every leg's side (BUY->SELL): never matches
    legs.forEach((l, i) => {
      const f = legs.map((x, j) => (i === j ? [x[0], SELL] : x));
      assert.strictEqual(matchOf(mkRfq(f), [lock]).parlay, null, 'side flipped');
    });
    // threshold flip: gte1 <-> gte2 on each leg (Poly market metadata present for the swap)
    legs.forEach((l, i) => {
      const m = /gte(\d)$/.exec(l[0]); const n = Number(m[1]);
      const other = l[0].replace(/gte\d$/, `gte${n === 1 ? 2 : 1}`);
      const mk = new Map(markets);
      const base = markets.get(l[0]);
      if (base) mk.set(other, { ...clone(base), slug: other, line: n === 1 ? 2 : 1, metadata: { ...base.metadata, lineLabel: `${n === 1 ? 2 : 1}+` } });
      const f = legs.map((x, j) => (i === j ? [other, x[1]] : x));
      assert.strictEqual(matchOf(mkRfq(f), [lock], mk).parlay, null, `threshold flipped ${l[0]}`);
    });
    // swap a leg's player for another crosswalk player (same game): never matches
    const swapTo = (slug) => { const m = /^(.*-td-)([a-z0-9]+)(-gte\d)$/.exec(slug); const { p } = polyOf(slug);
      const other = XW.players.find((q) => q.poly.stem === p.poly.stem && q.poly.abbr !== p.poly.abbr && q.kind === 'td' && !legs.some(([s]) => s.includes(`-td-${q.poly.abbr}-`)));
      return other ? `${m[1]}${other.poly.abbr}${m[3]}` : null; };
    const sw = swapTo(legs[0][0]);
    if (sw) assert.strictEqual(matchOf(mkRfq(legs.map((x, j) => (j === 0 ? [sw, x[1]] : x))), [lock]).parlay, null, 'player swapped');
    // date flip on the slug (+ metadata still the old date): never matches
    assert.strictEqual(matchOf(mkRfq(legs.map((x, j) => (j === 0 ? [x[0].replace(/-2026-10-0\d-/, '-2026-10-09-'), x[1]] : x))), [lock]).parlay, null, 'date flipped');
    // drop / add leg; cache miss
    assert.strictEqual(matchOf(mkRfq(legs.slice(1)), [lock]).parlay, null);
    assert.strictEqual(matchOf(mkRfq([...legs, [W2, BUY]]), [lock]).parlay, null);
    assert.strictEqual(matchOf(rfq, [lock], new Map()).parlay, null, 'metadata miss => fail closed');
    checked += 1;
  }
  assert.ok(checked >= 10);

  // real RFQ with a gte2 leg (Watson 2+?) / mixed: take a real RFQ containing gte2 if its lock is readable
  const two = FX.rfqs.find((r) => r.comboLegs.some((l) => /gte2$/.test(l.symbol)));
  assert.ok(two, 'real RFQ with a 2+ TD leg captured');
  const lock2 = lockFor(two.comboLegs.map((l) => l.symbol));
  assert.ok(lock2.legs.some((l) => /-2$/.test(l.ticker)));
  assert.ok(matchOf(two, [lock2]).parlay, '2+ lock matches its own 2+ RFQ');
  const as1 = two.comboLegs.map((l) => [l.symbol.replace(/gte2$/, 'gte1'), l.side]);
  const mk1 = new Map(markets);
  for (const l of two.comboLegs) if (/gte2$/.test(l.symbol)) { const s1 = l.symbol.replace(/gte2$/, 'gte1'); const b = markets.get(l.symbol); mk1.set(s1, { ...clone(b), slug: s1, line: 1, metadata: { ...b.metadata, lineLabel: '1+' } }); }
  assert.strictEqual(matchOf(mkRfq(as1), [lock2], mk1).parlay, null, '2+ lock never fills a 1+ RFQ');

  // lock-side label / ticker mutations => lock unreadable => never quoted
  const good = lockFor([W1, 'astatc-nfl-mia-min-2026-10-04-td-kylmur-gte1']);
  assert.ok(L.identitiesFromParlay(good, { lines: true }).ok);
  const mutLock = (fn) => { const l = clone(good); fn(l); return L.identitiesFromParlay(l, { lines: true }).ok; };
  assert.strictEqual(mutLock((l) => { l.legs[0].label = 'Deshaun Watson'; }), false, 'label without N+');
  assert.strictEqual(mutLock((l) => { l.legs[0].label = 'Deshaun Watson: 2+'; }), false, 'label N != ticker N');
  assert.strictEqual(mutLock((l) => { delete l.legs[0].label; }), false, 'no label');
  assert.strictEqual(mutLock((l) => { l.legs[0].label = 'Jaylen Warren: 1+'; }), false, 'wrong player label');
  assert.strictEqual(mutLock((l) => { l.legs[0].side = 'no'; l.leg_keys[0] = l.leg_keys[0].replace(':yes', ':no'); }), false, ':no not mapped');
  assert.strictEqual(mutLock((l) => { l.legs[0].ticker = l.legs[0].ticker.replace(/-1$/, '-3'); l.leg_keys[0] = l.legs[0].ticker + ':yes'; }), false, 'threshold absent on Poly');
  assert.strictEqual(mutLock(() => {}), true);
  // a lock containing an unmapped player (Kenneth Walker III) / D/ST is not priceable
  const unm = clone(good); unm.legs[0] = { ...unm.legs[0], ticker: 'KXNFLTD-26OCT04KCLV-KCKWALKER9-1', label: 'Kenneth Walker III: 1+' };
  unm.leg_keys[0] = 'KXNFLTD-26OCT04KCLV-KCKWALKER9-1:yes';
  assert.strictEqual(countPriceableLocks([unm]), 0);
  const logs = [];
  assert.strictEqual(logUnpriceablePolyLocks([unm, good], (m) => logs.push(m)), 1);
  assert.ok(logs.some((m) => m.includes('why=prop_not_mapped')), logs.join('|'));
  assert.strictEqual(countPriceableLocks([good]), 1);

  // game-start gating (Poly kickoff carried; Kalshi-side startedFor also honoured)
  const lockG = lockFor(FX.rfqs[0].comboLegs.map((l) => l.symbol));
  const rfqG = FX.rfqs[0];
  const kick = Date.parse('2026-10-02T00:15:00Z');
  const base = { rfq: rfqG, parlays: [lockG], markets, filledSoFar: 0, outstanding: 0, startedFor: () => ({ started: false }) };
  const bef = evaluatePolymarketRfq({ ...base, now: kick - 60000 });
  assert.strictEqual(bef.action, 'quoteable');
  assert.strictEqual(bef.polyStartMs, Math.min(...FX.rfqs[0].comboLegs.map((l) => Date.parse(markets.get(l.symbol).gameStartTime))));
  assert.strictEqual(evaluatePolymarketRfq({ ...base, now: bef.polyStartMs + 60000 }).reason, 'game_started');
  assert.strictEqual(evaluatePolymarketRfq({ ...base, now: kick - 60000, startedFor: () => ({ started: true, reason: 'game_started' }) }).reason, 'game_started');
  const big = evaluatePolymarketRfq({ ...base, rfq: { ...rfqG, cashOrderQty: undefined, qtyDecimal: '1000000' }, now: kick - 60000 });
  assert.strictEqual(big.reason, 'rfq_too_large');

  // live loop: an exact real RFQ posts; a flipped leg never does; confirm blocked after start
  const SEED_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  const posts = [];
  const http = {
    async getUserId() { return { rfqUserId: 'rfquser_test' }; },
    async listRfqs() { return { rfqs: [] }; },
    async listQuotes() { return { quotes: [] }; },
    async getCombo() { return { combos: [] }; },
    async createQuote(body) { posts.push(body); return { quoteId: 'quote_prop' }; },
    async confirmQuote() { return {}; },
    async deleteQuote() { return { statusCode: 200 }; },
    close() {},
  };
  const pending = new Map();
  const loop = startPolymarketRfqLoop({
    env: { POLYMARKET_KEY_ID: 'key-id-fixture', POLYMARKET_SECRET_KEY: SEED_B64, POLYMARKET_RFQ_LIVE: 'true' },
    http, startWs: false, getParlays: () => [lockG],
    fetchMarket: async (slug) => markets.get(slug) || null,
    startedFor: () => ({ started: false }), filledSoFarFor: () => 0, getOutstanding: () => 0,
    pendingQuotes: pending, reconcileMs: 60 * 60 * 1000, crawl: false,
  });
  const origLog = console.log; console.log = () => {};
  const realNow = Date.now; Date.now = () => Date.parse('2026-10-01T20:00:00Z');
  try {
    const flipped = rfqG.comboLegs.map((l, i) => [l.symbol, i === 0 ? SELL : l.side]);
    const badR = await loop.handleRfq({ ...mkRfq(flipped), id: 'rfq_flip', createdTime: new Date().toISOString() });
    assert.ok(!badR.post);
    assert.strictEqual(posts.length, 0);
    const goodR = await loop.handleRfq({ ...rfqG, id: 'rfq_good', createdTime: new Date().toISOString() });
    assert.ok(goodR.post, `exact prop RFQ quotes: ${goodR.reason}`);
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].sellPrice, '0');
    const entry = Array.from(pending.entries()).find(([, p]) => p.polyStartMs);
    assert.ok(entry, 'kickoff carried to confirm');
    entry[1].polyStartMs = Date.now() - 1000;
    const acc = await loop.handleQuoteAccepted({ quote: { id: entry[0], rfqId: 'rfq_good', acceptedSide: 'SIDE_BUY' } });
    assert.strictEqual(acc.confirmed, false);
    assert.strictEqual(acc.reason, 'game_started');
  } finally {
    Date.now = realNow; console.log = origLog; loop.stop();
  }
  console.log('poly-props.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
