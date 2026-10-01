'use strict';
// Polymarket US spread / total leg mapping (NFL, MLB, NHL full game).
// Uses REAL captured data: fixtures-poly-line-legs.json = open RFQs from
// GET /v1/rfqs and market metadata from GET /v1/market/slug/{slug} (2026-10-01),
// plus the 16 active Combo Locks at that time.
//
// The invariant under test: a Poly RFQ matches a lock ONLY when every leg is the
// exact same event, same side, same (half-point) line. Any wrong side, line,
// team, game date/clock, missing metadata or unmapped leg type => no match.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  parseKalshiLineTicker,
  identityFromPolymarketLine,
  identitiesFromParlay,
  identitiesFromPolymarketLegs,
  identityKey,
  startTimesAgree,
} = require('./leg-identity');
const {
  normalizePolymarketRfq,
  couldMatchActiveLocks,
  matchPolymarketParlayDetailed,
  evaluatePolymarketRfq,
  countPriceableLocks,
  countPriceableLineLocks,
  startPolymarketRfqLoop,
} = require('./polymarket-rfq');

const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures-poly-line-legs.json'), 'utf8'));
const markets = new Map(Object.entries(FX.markets));
const lockById = (prefix) => FX.locks.find((l) => l.id.startsWith(prefix));
const rfqById = (prefix) => FX.rfqs.find((r) => r.id.startsWith(prefix));

const NOW = Date.parse('2026-10-01T20:00:00Z'); // before every fixture game that matters here
const oneLeg = (symbol, side) => ({ symbol, side });
const mkRfq = (legs, extra) => ({
  id: 'rfq_test', status: 'RFQ_STATUS_OPEN', cashOrderQty: '10', symbol: 'caoc-test',
  comboLegs: legs.map(([s, sd]) => oneLeg(s, sd)), ...extra,
});
const BUY = 'SIDE_BUY';
const SELL = 'SIDE_SELL';

function matchOf(rfq, locks) {
  const n = normalizePolymarketRfq(rfq);
  return matchPolymarketParlayDetailed(n, locks, { markets });
}
const kkey = (t, label) => {
  const id = parseKalshiLineTicker(t, null, label, { requireLabel: true });
  return id && identityKey(id);
};
const pkey = (slug, side) => {
  const r = identityFromPolymarketLine(slug, side, markets.get(slug));
  return r.identity && r.verified ? identityKey(r.identity) : null;
};

// ── 1. Kalshi line tickers → canonical identity (exact lines only) ──────────
{
  // SEA -6.5 (yes) and LAC +6.5 (no) are the same identity pair as Poly.
  assert.strictEqual(kkey('KXNFLSPREAD-26OCT04LACSEA-SEA7:yes', 'Seattle −6.5'),
    'nfl|2026-10-04|lac+sea|spread|full|lac|no|L6.5');
  assert.strictEqual(kkey('KXNFLSPREAD-26OCT04LACSEA-SEA7:no', 'Los Angeles C +6.5'),
    'nfl|2026-10-04|lac+sea|spread|full|lac|yes|L6.5');
  assert.strictEqual(kkey('KXNFLSPREAD-26OCT04DENSF-SF3:no', 'Denver +2.5'),
    'nfl|2026-10-04|den+sf|spread|full|den|yes|L2.5');
  assert.strictEqual(kkey('KXNFLTOTAL-26SEP27HOUIND-43:no', 'Under 42.5'),
    'nfl|2026-09-27|hou+ind|total|full|under|yes|L42.5');
  assert.strictEqual(kkey('KXNFLTOTAL-26SEP27HOUIND-43:yes', 'Over 42.5'),
    'nfl|2026-09-27|hou+ind|total|full|over|yes|L42.5');
  assert.strictEqual(kkey('KXMLBTOTAL-26SEP302200CHCSD-6:no', 'Under 5.5'),
    'mlb|2026-09-30|chc+sd|total|full|under|yes|L5.5');
  assert.strictEqual(kkey('KXMLBSPREAD-26SEP291700CWSHOU-HOU2:yes', 'Houston −1.5'),
    'mlb|2026-09-29|cws+hou|spread|full|cws|no|L1.5');
  assert.strictEqual(kkey('KXNHLTOTAL-26OCT04WPGDET-9:yes', 'Over 8.5'),
    'nhl|2026-10-04|det+wpg|total|full|over|yes|L8.5');
  assert.strictEqual(kkey('KXNHLSPREAD-26OCT04WPGDET-WPG3:yes', 'Winnipeg −2.5'),
    'nhl|2026-10-04|det+wpg|spread|full|det|no|L2.5');

  // Unprovable => null. No label, wrong label sign, wrong label line, wrong
  // Over/Under word, unknown series, college, bad team code, whole-number line.
  assert.strictEqual(kkey('KXNFLSPREAD-26OCT04LACSEA-SEA7:yes', null), null, 'label is mandatory');
  assert.strictEqual(kkey('KXNFLSPREAD-26OCT04LACSEA-SEA7:yes', 'Seattle +6.5'), null, 'sign conflict');
  assert.strictEqual(kkey('KXNFLSPREAD-26OCT04LACSEA-SEA7:yes', 'Seattle −7'), null, 'ticker 7 is 6.5 not 7');
  assert.strictEqual(kkey('KXNFLSPREAD-26OCT04LACSEA-SEA7:yes', 'Seattle −7.5'), null);
  assert.strictEqual(kkey('KXNFLSPREAD-26OCT04LACSEA-SEA7:no', 'Seattle −6.5'), null, ':no must read as opponent +6.5');
  assert.strictEqual(kkey('KXNFLTOTAL-26SEP27HOUIND-43:no', 'Over 42.5'), null, 'side word conflict');
  assert.strictEqual(kkey('KXNFLTOTAL-26SEP27HOUIND-43:yes', 'Under 42.5'), null);
  assert.strictEqual(kkey('KXNFLTOTAL-26SEP27HOUIND-43:yes', 'Over 43.5'), null, 'no snapping to nearest line');
  assert.strictEqual(kkey('KXNFLTOTAL-26SEP27HOUIND-43:yes', 'Total 42.5'), null, 'label must say Over/Under');
  assert.strictEqual(kkey('KXNCAAFSPREAD-26OCT01UNTTLSA-TLSA2:no', 'North Texas +1.5'), null, 'college not mapped');
  assert.strictEqual(kkey('KXNCAAFTOTAL-26OCT03BCSMU-56:yes', 'Over 55.5'), null);
  assert.strictEqual(kkey('KXNFLSPREAD-26OCT04LACSEA-DAL7:yes', 'Dallas −6.5'), null, 'team not in game');
  assert.strictEqual(kkey('KXNFLSPREAD-26OCT04LACSEA-SEA:yes', 'Seattle −0.5'), null);
  assert.strictEqual(kkey('KXNFLGAME-26OCT04LACSEA-SEA:yes', 'Seattle'), null, 'ML is not a line leg');
  assert.strictEqual(kkey('KXNFLSPREAD-26OCT04LACSEA-SEA7', 'Seattle −6.5'), kkey('KXNFLSPREAD-26OCT04LACSEA-SEA7:yes', 'Seattle −6.5'), 'bare ticker = yes');
}

// ── 2. Poly slugs + market metadata → identity; Kalshi/Poly equivalence ─────
{
  // asc-nfl-lac-sea ... pos-6pt5 : long LAC +6.5 / short SEA -6.5
  const S = 'asc-nfl-lac-sea-2026-10-04-pos-6pt5';
  assert.strictEqual(pkey(S, BUY), 'nfl|2026-10-04|lac+sea|spread|full|lac|yes|L6.5'); // LAC +6.5
  assert.strictEqual(pkey(S, SELL), 'nfl|2026-10-04|lac+sea|spread|full|lac|no|L6.5'); // SEA -6.5
  // Kalshi SEA -6.5 == Poly SELL pos-6pt5 ; Kalshi LAC +6.5 (SEA7:no) == Poly BUY pos-6pt5
  assert.strictEqual(kkey('KXNFLSPREAD-26OCT04LACSEA-SEA7:yes', 'Seattle −6.5'), pkey(S, SELL));
  assert.strictEqual(kkey('KXNFLSPREAD-26OCT04LACSEA-SEA7:no', 'Los Angeles C +6.5'), pkey(S, BUY));
  // The neg market is a DIFFERENT line direction: LAC -6.5 / SEA +6.5.
  const N = 'asc-nfl-lac-sea-2026-10-04-neg-6pt5';
  assert.strictEqual(pkey(N, BUY), 'nfl|2026-10-04|lac+sea|spread|full|lac|yes|L-6.5'); // LAC -6.5
  assert.strictEqual(pkey(N, SELL), 'nfl|2026-10-04|lac+sea|spread|full|lac|no|L-6.5'); // SEA +6.5
  assert.notStrictEqual(pkey(N, BUY), pkey(S, BUY));
  assert.notStrictEqual(pkey(N, SELL), pkey(S, SELL));
  assert.notStrictEqual(kkey('KXNFLSPREAD-26OCT04LACSEA-SEA7:yes', 'Seattle −6.5'), pkey(N, SELL), 'SEA -6.5 != SEA +6.5');
  assert.notStrictEqual(kkey('KXNFLSPREAD-26OCT04LACSEA-SEA7:no', 'Los Angeles C +6.5'), pkey(N, BUY), 'LAC +6.5 != LAC -6.5');

  // DEN +2.5 (Kalshi SF3:no) == Poly DEN pos-2pt5 BUY == Poly DEN neg... no: neg is -2.5.
  assert.strictEqual(kkey('KXNFLSPREAD-26OCT04DENSF-SF3:no', 'Denver +2.5'), pkey('asc-nfl-den-sf-2026-10-04-pos-2pt5', BUY));
  assert.notStrictEqual(kkey('KXNFLSPREAD-26OCT04DENSF-SF3:no', 'Denver +2.5'), pkey('asc-nfl-den-sf-2026-10-04-neg-2pt5', BUY));
  assert.notStrictEqual(kkey('KXNFLSPREAD-26OCT04DENSF-SF3:no', 'Denver +2.5'), pkey('asc-nfl-den-sf-2026-10-04-pos-2pt5', SELL));
  // Kalshi SF -2.5 (SF3:yes) == Poly SELL pos-2pt5 (SF is the short side at DEN +2.5)
  assert.strictEqual(kkey('KXNFLSPREAD-26OCT04DENSF-SF3:yes', 'San Francisco −2.5'), pkey('asc-nfl-den-sf-2026-10-04-pos-2pt5', SELL));

  // Totals: BUY = Over, SELL = Under, exact line.
  const T = 'tsc-nfl-pit-cle-2026-10-01-total-37pt5';
  assert.strictEqual(pkey(T, BUY), 'nfl|2026-10-01|cle+pit|total|full|over|yes|L37.5');
  assert.strictEqual(pkey(T, SELL), 'nfl|2026-10-01|cle+pit|total|full|under|yes|L37.5');
  assert.strictEqual(kkey('KXNFLTOTAL-26OCT01PITCLE-38:yes', 'Over 37.5'), pkey(T, BUY));
  assert.strictEqual(kkey('KXNFLTOTAL-26OCT01PITCLE-38:no', 'Under 37.5'), pkey(T, SELL));
  assert.notStrictEqual(kkey('KXNFLTOTAL-26OCT01PITCLE-38:yes', 'Over 37.5'), pkey(T, SELL), 'Over != Under');
  assert.notStrictEqual(kkey('KXNFLTOTAL-26OCT01PITCLE-39:yes', 'Over 38.5'), pkey(T, BUY), '38.5 != 37.5');
  assert.notStrictEqual(kkey('KXNFLTOTAL-26OCT01PITCLE-37:yes', 'Over 36.5'), pkey(T, BUY), '36.5 != 37.5');
  // MLB / NHL totals and spreads
  assert.strictEqual(kkey('KXMLBTOTAL-26OCT012000PHIATL-7:yes', 'Over 6.5'), pkey('tsc-mlb-phi-atl-2026-10-01-6pt5', BUY));
  assert.strictEqual(pkey('tsc-mlb-phi-atl-2026-10-01-6pt5', BUY), 'mlb|2026-10-01|atl+phi|total|full|over|yes|L6.5');
  assert.strictEqual(pkey('tsc-nhl-buf-cbj-2026-10-01-3pt5', SELL), 'nhl|2026-10-01|buf+cbj|total|full|under|yes|L3.5');
  // neg-1pt5: long PHI -1.5, short ATL +1.5 ; canonical form is (atl, +1.5, yes) for ATL +1.5
  assert.strictEqual(pkey('asc-mlb-phi-atl-2026-10-01-neg-1pt5', SELL), 'mlb|2026-10-01|atl+phi|spread|full|atl|yes|L1.5');
  assert.strictEqual(pkey('asc-mlb-phi-atl-2026-10-01-neg-1pt5', BUY), 'mlb|2026-10-01|atl+phi|spread|full|atl|no|L1.5');
  // PHI -1.5 (BUY neg) and ATL +1.5 (SELL neg) are the two sides of one event.
  const a = identityFromPolymarketLine('asc-mlb-phi-atl-2026-10-01-neg-1pt5', BUY, markets.get('asc-mlb-phi-atl-2026-10-01-neg-1pt5')).identity;
  const b = identityFromPolymarketLine('asc-mlb-phi-atl-2026-10-01-neg-1pt5', SELL, markets.get('asc-mlb-phi-atl-2026-10-01-neg-1pt5')).identity;
  assert.strictEqual(a.line, b.line, 'same canonical line, complementary sides');
  assert.notStrictEqual(a.side, b.side);

  // Not mapped (never guess): period / team-total / player-prop markets.
  for (const slug of [
    'asc-nfl-pit-cle-2026-10-01-1h-neg-1pt5',
    'tsc-nfl-pit-cle-2026-10-01-1h-14pt5',
    'tsc-nfl-pit-cle-2026-10-01-tt-pit-17pt5',
    'tsc-nfl-pit-cle-2026-10-01-tt1h-pit-9pt5',
    'tsc-mlb-phi-atl-2026-10-01-f5-2pt5',
    'asc-mlb-phi-atl-2026-10-01-f5-neg-1pt5',
    'tsc-mlb-phi-atl-2026-10-01-tt-phi-2pt5',
    'tsc-nhl-phi-nj-2026-10-01-tt-phi-2pt5',
    'astatc-nfl-pit-cle-2026-10-01-td-jaywar-gte1',
    'asc-cfb-ntx-tulsa-2026-10-01-pos-1pt5',
    'tsc-cfb-ntx-tulsa-2026-10-01-total-49pt5',
  ]) {
    assert.strictEqual(identityFromPolymarketLine(slug, BUY, markets.get(slug)).identity, null, slug);
  }
}

// ── 3. Metadata cross-checks: any disagreement => no identity ───────────────
{
  const slug = 'asc-nfl-lac-sea-2026-10-04-pos-6pt5';
  const good = markets.get(slug);
  assert.ok(identityFromPolymarketLine(slug, BUY, good).verified);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const bad = (mut) => {
    const m = clone(good);
    mut(m);
    return identityFromPolymarketLine(slug, BUY, m).identity;
  };
  assert.strictEqual(bad((m) => { m.line = -6.5; }), null, 'line sign disagrees with slug');
  assert.strictEqual(bad((m) => { m.line = 7.5; }), null, 'line value disagrees');
  assert.strictEqual(bad((m) => { m.marketSides[0].team.abbreviation = 'sea'; m.marketSides[1].team.abbreviation = 'lac'; }), null, 'long team != first slug team');
  assert.strictEqual(bad((m) => { m.marketSides[0].long = false; m.marketSides[1].long = true; }), null);
  assert.strictEqual(bad((m) => { m.marketSides[0].description = '-6.50'; }), null, 'long side printed handicap != signed line');
  assert.strictEqual(bad((m) => { m.sportsMarketType = 'football_team_first_half_spread'; }), null, 'period market');
  assert.strictEqual(bad((m) => { m.sportsMarketType = 'football_team_full_game_total'; }), null, 'kind mismatch');
  assert.strictEqual(bad((m) => { m.gameStartTime = '2026-10-11T20:25:00Z'; }), null, 'different game date');
  assert.strictEqual(bad((m) => { m.slug = 'asc-nfl-lac-sea-2026-10-04-neg-6pt5'; }), null, 'slug mismatch');
  assert.strictEqual(bad((m) => { m.marketSides.pop(); }), null);
  assert.strictEqual(identityFromPolymarketLine(slug, BUY, null).verified, false, 'no metadata => unverified');
  // missing metadata => identitiesFromPolymarketLegs refuses line legs outright
  const r = identitiesFromPolymarketLegs([oneLeg(slug, BUY), oneLeg('aec-nfl-pit-cle-2026-10-01', BUY)], new Map());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'missing_metadata');
  // totals: Over must be the long side
  const T = 'tsc-nfl-pit-cle-2026-10-01-total-37pt5';
  const tm = clone(markets.get(T));
  tm.marketSides[0].description = 'Under';
  tm.marketSides[1].description = 'Over';
  assert.strictEqual(identityFromPolymarketLine(T, BUY, tm).identity, null, 'Over/Under inverted metadata');
}

// ── 3b. Oracle fuzz: identity equality <=> proposition equality ────────────
// Independent truth tables (final score margins), no use of the identity code:
//   Kalshi spread TEAMn:yes  = TEAM wins by more than n-0.5 ; :no = the complement
//   Poly asc BUY  = long (first slug team) covers its signed line ; SELL = complement
//   Kalshi total N:yes = points > N-0.5 ; :no = <= ; Poly tsc BUY = Over, SELL = Under
{
  const mkMeta = (kind, slug, t1, t2, line, date) => ({
    slug, sportsMarketType: kind === 'spread' ? 'football_team_full_game_spread' : 'football_team_full_game_total',
    line, gameStartTime: `${date}T17:00:00Z`,
    marketSides: kind === 'spread'
      ? [{ long: true, description: (line > 0 ? '+' : '') + line.toFixed(2), team: { abbreviation: t1, league: 'nfl' } },
        { long: false, description: (line > 0 ? '-' : '+') + Math.abs(line).toFixed(2), team: { abbreviation: t2, league: 'nfl' } }]
      : [{ long: true, description: 'Over' }, { long: false, description: 'Under' }],
  });
  const sfmt = (m) => `${String(Math.floor(m)).padStart(1, '0')}pt${Math.round((m % 1) * 10)}`;
  const A = 'lac';
  const B = 'sea';
  const date = '2026-10-04';
  const margins = [];
  for (let m = -40; m <= 40; m += 1) margins.push(m); // margin = LAC - SEA (0 = tie, included)
  const vec = (f) => margins.map((m) => (f(m) ? '1' : '0')).join('');
  const props = []; // { id, vec }
  let n = 0;
  for (let mag = 0.5; mag <= 14.5; mag += 1) {
    const num = Math.round(mag + 0.5);
    const ml = (Math.abs(mag) % 1).toFixed(1) === '0.5';
    assert.ok(ml);
    for (const team of ['LAC', 'SEA']) {
      for (const sd of ['yes', 'no']) {
        const sgnTeam = team === 'LAC' ? 1 : -1;
        const wins = (m) => sgnTeam * m > mag; // team wins by more than mag
        const truth = sd === 'yes' ? vec(wins) : vec((m) => !wins(m));
        const opp = team === 'LAC' ? 'Seattle' : 'Los Angeles C';
        const nm = team === 'LAC' ? 'Los Angeles C' : 'Seattle';
        const label = sd === 'yes' ? `${nm} −${mag}` : `${opp} +${mag}`;
        const key = kkey(`KXNFLSPREAD-26OCT04LACSEA-${team}${num}:${sd}`, label);
        assert.ok(key, `kalshi ${team}${num}:${sd} parses`);
        props.push({ src: `K ${team}${num}:${sd}`, key, truth });
        n += 1;
      }
    }
    for (const dir of ['neg', 'pos']) {
      const slug = `asc-nfl-lac-sea-2026-10-04-${dir}-${sfmt(mag)}`;
      const signed = dir === 'neg' ? -mag : mag;
      markets.set(slug, mkMeta('spread', slug, A, B, signed, date));
      for (const [sd, side] of [['BUY', BUY], ['SELL', SELL]]) {
        const covers = (m) => m + signed > 0; // LAC (long) covers
        const truth = sd === 'BUY' ? vec(covers) : vec((m) => !covers(m));
        const key = pkey(slug, side);
        assert.ok(key, `poly ${slug} ${sd} parses`);
        props.push({ src: `P ${slug} ${sd}`, key, truth });
        n += 1;
      }
    }
  }
  const totals = [];
  for (let line = 20.5; line <= 60.5; line += 1) {
    const num = Math.round(line + 0.5);
    for (const sd of ['yes', 'no']) {
      const pts = []; for (let t = 0; t <= 100; t += 1) pts.push(t);
      const tv = (f) => pts.map((t) => (f(t) ? '1' : '0')).join('');
      const over = (t) => t > line;
      const truth = sd === 'yes' ? tv(over) : tv((t) => !over(t));
      const key = kkey(`KXNFLTOTAL-26OCT04LACSEA-${num}:${sd}`, `${sd === 'yes' ? 'Over' : 'Under'} ${line}`);
      assert.ok(key);
      totals.push({ src: `K total ${num}:${sd}`, key, truth });
    }
    const slug = `tsc-nfl-lac-sea-2026-10-04-total-${sfmt(line)}`;
    markets.set(slug, mkMeta('total', slug, A, B, line, date));
    for (const [sd, side] of [['BUY', BUY], ['SELL', SELL]]) {
      const over = (t) => t > line;
      const truth = (() => { const pts = []; for (let t = 0; t <= 100; t += 1) pts.push(t); return pts.map((t) => ((sd === 'BUY' ? over(t) : !over(t)) ? '1' : '0')).join(''); })();
      const key = pkey(slug, side);
      assert.ok(key);
      totals.push({ src: `P ${slug} ${sd}`, key, truth });
    }
  }
  let pairs = 0;
  for (const group of [props, totals]) {
    for (const x of group) {
      for (const y of group) {
        if (x === y) continue;
        pairs += 1;
        const sameKey = x.key === y.key;
        const sameTruth = x.truth === y.truth;
        assert.strictEqual(sameKey, sameTruth, `identity equality must equal proposition equality: ${x.src} vs ${y.src}`);
      }
    }
  }
  assert.ok(pairs > 20000, `fuzz pairs=${pairs} props=${n}`);
}

// ── 4. Locks: which active locks are mapped (real production lock rows) ─────
{
  const jac = lockById('12e698d5'); // JAC ML + SEA -6.5 + DEN +2.5
  const hou = lockById('3bdc5fdd'); // HOU -2.5 + NE ML + LV +4.5 + LAR ML
  const gb = lockById('9058322b'); // DEN ML + TB +3.5 + LV ML
  const unt = lockById('b9a3c72b'); // NCAAF spreads + DEN ML
  const mlOnly = lockById('86833295');
  assert.ok(identitiesFromParlay(jac).ok === false, 'ML-only identity reader unchanged (Kalshi path)');
  assert.ok(identitiesFromParlay(jac, { lines: true }).ok);
  assert.ok(identitiesFromParlay(hou, { lines: true }).ok);
  assert.ok(identitiesFromParlay(gb, { lines: true }).ok);
  assert.strictEqual(identitiesFromParlay(unt, { lines: true }).ok, false, 'NCAAF spread not mapped');
  assert.ok(identitiesFromParlay(mlOnly, { lines: true }).ok);
  // Same lock with a stripped label / conflicting leg side is NOT mapped.
  const noLabel = JSON.parse(JSON.stringify(jac));
  noLabel.legs[1].label = '';
  assert.strictEqual(identitiesFromParlay(noLabel, { lines: true }).ok, false);
  const wrongSide = JSON.parse(JSON.stringify(jac));
  wrongSide.legs[1].side = 'no'; // leg row says no, key says yes
  assert.strictEqual(identitiesFromParlay(wrongSide, { lines: true }).ok, false);
  const wrongLabel = JSON.parse(JSON.stringify(jac));
  wrongLabel.legs[1].label = 'Seattle +6.5';
  assert.strictEqual(identitiesFromParlay(wrongLabel, { lines: true }).ok, false);

  assert.strictEqual(countPriceableLocks(FX.locks), 12, '12 of 16 active locks are Poly-mappable (9 before)');
  assert.strictEqual(countPriceableLineLocks(FX.locks), 3);
  const mlBefore = FX.locks.filter((l) => identitiesFromParlay(l).ok).length;
  assert.strictEqual(mlBefore, 9);
}

// ── 5. End to end with REAL captured RFQs + a lock built from the same legs ─
function lockFor(label, tickers, extra) {
  // tickers: [[ticker, side, legLabel, type]]
  return {
    id: `lock-${label}`, user_id: 'u1', label,
    leg_keys: tickers.map(([t, s]) => `${t}:${s}`),
    legs: tickers.map(([t, s, lab, type]) => ({ ticker: t, side: s, label: lab, type: type || 'spread' })),
    parlay_stake: 100, parlay_american: 300, fill_american: 260, fair_american: 280,
    hedge_mode: '1x', max_contracts: 500, starts_at: '2026-10-02T00:15:00+00:00',
    ...extra,
  };
}
const PIT_ML = ['KXNFLGAME-26OCT01PITCLE-PIT', 'yes', 'Pittsburgh', 'side'];
const CLE_ML = ['KXNFLGAME-26OCT01PITCLE-CLE', 'yes', 'Cleveland', 'side'];

{
  // Real RFQ d24e24d6: PIT ML BUY + total 37.5 BUY (Over 37.5)
  const real = rfqById('d24e24d6');
  assert.ok(real, 'fixture rfq present');
  const goodLock = lockFor('pit+o37.5', [PIT_ML, ['KXNFLTOTAL-26OCT01PITCLE-38', 'yes', 'Over 37.5', 'total']]);
  const m = matchOf(real, [goodLock]);
  assert.ok(m.parlay && m.parlay.id === goodLock.id, 'exact legs match');
  assert.strictEqual(m.polyStartMs, Date.parse('2026-10-02T00:15:00Z'));
  assert.ok(couldMatchActiveLocks(normalizePolymarketRfq(real), [goodLock]), 'prefilter admits exact candidates');

  // Every single-field mutation of the lock must break the match.
  const mutants = {
    'Under instead of Over': lockFor('m1', [PIT_ML, ['KXNFLTOTAL-26OCT01PITCLE-38', 'no', 'Under 37.5', 'total']]),
    'line 38.5': lockFor('m2', [PIT_ML, ['KXNFLTOTAL-26OCT01PITCLE-39', 'yes', 'Over 38.5', 'total']]),
    'line 36.5': lockFor('m3', [PIT_ML, ['KXNFLTOTAL-26OCT01PITCLE-37', 'yes', 'Over 36.5', 'total']]),
    'CLE ML instead of PIT': lockFor('m4', [CLE_ML, ['KXNFLTOTAL-26OCT01PITCLE-38', 'yes', 'Over 37.5', 'total']]),
    'extra leg': lockFor('m5', [PIT_ML, ['KXNFLTOTAL-26OCT01PITCLE-38', 'yes', 'Over 37.5', 'total'], ['KXNFLGAME-26OCT04DENSF-DEN', 'yes', 'Denver', 'side']]),
    'missing total leg': lockFor('m6', [PIT_ML, ['KXNFLGAME-26OCT04DENSF-DEN', 'yes', 'Denver', 'side']]),
    'other date': lockFor('m7', [PIT_ML, ['KXNFLTOTAL-26OCT04PITCLE-38', 'yes', 'Over 37.5', 'total']]),
  };
  for (const [name, lock] of Object.entries(mutants)) {
    const mm = matchOf(real, [lock]);
    assert.strictEqual(mm.parlay, null, `must NOT match: ${name}`);
  }
  // …and the mutants DO match the RFQ that actually carries their legs
  // (proves the mutants are well-formed, not just unparseable).
  const underRfq = mkRfq([['aec-nfl-pit-cle-2026-10-01', BUY], ['tsc-nfl-pit-cle-2026-10-01-total-37pt5', SELL]]);
  assert.ok(matchOf(underRfq, [mutants['Under instead of Over']]).parlay);
  assert.strictEqual(matchOf(underRfq, [goodLock]).parlay, null, 'Under RFQ must not hit the Over lock');
  const o385 = mkRfq([['aec-nfl-pit-cle-2026-10-01', BUY], ['tsc-nfl-pit-cle-2026-10-01-total-38pt5', BUY]]);
  markets.set('tsc-nfl-pit-cle-2026-10-01-total-38pt5', markets.get('tsc-nfl-pit-cle-2026-10-01-total-38pt5') || {
    slug: 'tsc-nfl-pit-cle-2026-10-01-total-38pt5', sportsMarketType: 'football_team_full_game_total', line: 38.5,
    gameStartTime: '2026-10-02T00:15:00Z', marketSides: [{ long: true, description: 'Over' }, { long: false, description: 'Under' }],
  });
  assert.ok(matchOf(o385, [mutants['line 38.5']]).parlay);
  assert.strictEqual(matchOf(o385, [goodLock]).parlay, null, '38.5 RFQ must not hit the 37.5 lock');
  assert.strictEqual(matchOf(real, [mutants['line 38.5']]).parlay, null, '37.5 RFQ must not hit the 38.5 lock');
}

{
  // Real RFQ 9e0f2856: PIT ML BUY + asc-nfl-pit-cle neg-2pt5 SELL = CLE +2.5
  const real = rfqById('9e0f2856');
  assert.ok(real);
  const cleP25 = lockFor('pit+cle+2.5', [PIT_ML, ['KXNFLSPREAD-26OCT01PITCLE-PIT3', 'no', 'Cleveland +2.5']]);
  assert.ok(matchOf(real, [cleP25]).parlay, 'PIT ML + CLE +2.5 (PIT3:no) == neg-2pt5 SELL');
  const wrong = {
    'PIT -2.5 instead (yes)': lockFor('w1', [PIT_ML, ['KXNFLSPREAD-26OCT01PITCLE-PIT3', 'yes', 'Pittsburgh −2.5']]),
    'CLE -2.5 (CLE3 yes)': lockFor('w2', [PIT_ML, ['KXNFLSPREAD-26OCT01PITCLE-CLE3', 'yes', 'Cleveland −2.5']]),
    'CLE +3.5': lockFor('w3', [PIT_ML, ['KXNFLSPREAD-26OCT01PITCLE-PIT4', 'no', 'Cleveland +3.5']]),
    'CLE +1.5': lockFor('w4', [PIT_ML, ['KXNFLSPREAD-26OCT01PITCLE-PIT2', 'no', 'Cleveland +1.5']]),
    'PIT +2.5': lockFor('w5', [PIT_ML, ['KXNFLSPREAD-26OCT01PITCLE-CLE3', 'no', 'Pittsburgh +2.5']]),
  };
  for (const [name, lock] of Object.entries(wrong)) {
    assert.strictEqual(matchOf(real, [lock]).parlay, null, `must NOT match: ${name}`);
  }
  // CLE3:yes label says CLE -2.5; CLE3:no says PIT +2.5; the RFQ is CLE +2.5.
}

{
  // Real RFQ 30684e36: asc neg-2pt5 BUY (PIT -2.5) + total 37.5 SELL (Under)
  const real = rfqById('30684e36');
  assert.ok(real);
  const lock = lockFor('pit-2.5+u37.5', [
    ['KXNFLSPREAD-26OCT01PITCLE-PIT3', 'yes', 'Pittsburgh −2.5'],
    ['KXNFLTOTAL-26OCT01PITCLE-38', 'no', 'Under 37.5', 'total'],
  ]);
  assert.ok(matchOf(real, [lock]).parlay);
  // Same game, same lines, every side flipped one at a time:
  const flipSpread = lockFor('f1', [
    ['KXNFLSPREAD-26OCT01PITCLE-PIT3', 'no', 'Cleveland +2.5'],
    ['KXNFLTOTAL-26OCT01PITCLE-38', 'no', 'Under 37.5', 'total'],
  ]);
  const flipTotal = lockFor('f2', [
    ['KXNFLSPREAD-26OCT01PITCLE-PIT3', 'yes', 'Pittsburgh −2.5'],
    ['KXNFLTOTAL-26OCT01PITCLE-38', 'yes', 'Over 37.5', 'total'],
  ]);
  assert.strictEqual(matchOf(real, [flipSpread]).parlay, null);
  assert.strictEqual(matchOf(real, [flipTotal]).parlay, null);
}

{
  // MLB real RFQ d58ce761: ATL +1.5 (neg-1pt5 SELL) + total 6.5 Over (BUY)
  const real = rfqById('d58ce761');
  assert.ok(real);
  const mk = (ticker, side, labelTxt, type) => [ticker, side, labelTxt, type];
  const lock = lockFor('atl+1.5 o6.5', [
    mk('KXMLBSPREAD-26OCT012000PHIATL-PHI2', 'no', 'Atlanta +1.5'),
    mk('KXMLBTOTAL-26OCT012000PHIATL-7', 'yes', 'Over 6.5', 'total'),
  ], { starts_at: '2026-10-02T00:00:00+00:00' });
  assert.ok(matchOf(real, [lock]).parlay, 'MLB exact legs + matching first pitch (20:00 ET = Poly gameStartTime 2026-10-02T00:00Z)');
  // Same legs but Kalshi ticker says a different first pitch (doubleheader game 2): no.
  const g2 = lockFor('dh2', [
    mk('KXMLBSPREAD-26OCT011400PHIATL-PHI2', 'no', 'Atlanta +1.5'),
    mk('KXMLBTOTAL-26OCT011400PHIATL-7', 'yes', 'Over 6.5', 'total'),
  ]);
  const dh = matchOf(real, [g2]);
  assert.strictEqual(dh.parlay, null, 'first-pitch mismatch must not match');
  assert.strictEqual(dh.reason, 'start_mismatch');
  // MLB line leg with no clock in the lock ticker is refused (cannot rule out a DH).
  const noClock = lockFor('noclock', [
    mk('KXMLBSPREAD-26OCT01PHIATL-PHI2', 'no', 'Atlanta +1.5'),
    mk('KXMLBTOTAL-26OCT01PHIATL-7', 'yes', 'Over 6.5', 'total'),
  ]);
  assert.strictEqual(matchOf(real, [noClock]).parlay, null);
}

{
  // NHL real total RFQ ab52f148 has a total (5.5 Over) + two ML.
  const real = rfqById('ab52f148');
  assert.ok(real);
  const lock = lockFor('nhl', [
    ['KXNHLGAME-26OCT012200EDMVAN-EDM', 'yes', 'Edmonton', 'side'],
    ['KXNHLGAME-26OCT011900MINNAS-MIN', 'yes', 'Minnesota', 'side'],
    ['KXNHLTOTAL-26OCT011900BUFCBJ-6', 'yes', 'Over 5.5', 'total'],
  ]);
  const hit = matchOf(real, [lock]);
  assert.ok(hit.parlay, `NHL ML+ML+total maps: ${hit.reason}`);
  const lock65 = lockFor('nhl65', [
    ['KXNHLGAME-26OCT012200EDMVAN-EDM', 'yes', 'Edmonton', 'side'],
    ['KXNHLGAME-26OCT011900MINNAS-MIN', 'yes', 'Minnesota', 'side'],
    ['KXNHLTOTAL-26OCT011900BUFCBJ-7', 'yes', 'Over 6.5', 'total'],
  ]);
  assert.strictEqual(matchOf(real, [lock65]).parlay, null);
}

// ── 6. Real production locks vs real open RFQs ──────────────────────────────
{
  // JAX/CIN + SEA -6.5 + DEN +2.5 (lock 12e698d5): build the exact Poly RFQ.
  const jacLock = lockById('12e698d5');
  const exact = mkRfq([
    ['aec-nfl-jax-cin-2026-10-04', BUY], // JAC ML (Poly uses jax)
    ['asc-nfl-lac-sea-2026-10-04-pos-6pt5', SELL], // SEA -6.5
    ['asc-nfl-den-sf-2026-10-04-pos-2pt5', BUY], // DEN +2.5
  ]);
  const hit = matchOf(exact, [jacLock]);
  assert.ok(hit.parlay && hit.parlay.id === jacLock.id, `prod lock maps: ${hit.reason}`);
  // Flip each leg on its own: none may match.
  const flips = [
    [['aec-nfl-jax-cin-2026-10-04', SELL], ['asc-nfl-lac-sea-2026-10-04-pos-6pt5', SELL], ['asc-nfl-den-sf-2026-10-04-pos-2pt5', BUY]],
    [['aec-nfl-jax-cin-2026-10-04', BUY], ['asc-nfl-lac-sea-2026-10-04-pos-6pt5', BUY], ['asc-nfl-den-sf-2026-10-04-pos-2pt5', BUY]],
    [['aec-nfl-jax-cin-2026-10-04', BUY], ['asc-nfl-lac-sea-2026-10-04-pos-6pt5', SELL], ['asc-nfl-den-sf-2026-10-04-pos-2pt5', SELL]],
    [['aec-nfl-jax-cin-2026-10-04', BUY], ['asc-nfl-lac-sea-2026-10-04-neg-6pt5', SELL], ['asc-nfl-den-sf-2026-10-04-pos-2pt5', BUY]],
    [['aec-nfl-jax-cin-2026-10-04', BUY], ['asc-nfl-lac-sea-2026-10-04-pos-6pt5', SELL], ['asc-nfl-den-sf-2026-10-04-neg-2pt5', BUY]],
    [['aec-nfl-jax-cin-2026-10-04', BUY], ['asc-nfl-lac-sea-2026-10-04-pos-6pt5', SELL], ['asc-nfl-den-sf-2026-10-04-neg-2pt5', SELL]],
  ];
  for (const legs of flips) assert.strictEqual(matchOf(mkRfq(legs), [jacLock]).parlay, null, JSON.stringify(legs));
  // Leg order must not matter.
  const reordered = mkRfq([exact.comboLegs[2], exact.comboLegs[0], exact.comboLegs[1]].map((l) => [l.symbol, l.side]));
  assert.ok(matchOf(reordered, [jacLock]).parlay);
  // Not enough metadata (cache miss) => never matches.
  const nr = normalizePolymarketRfq(exact);
  assert.strictEqual(matchPolymarketParlayDetailed(nr, [jacLock], { markets: new Map() }).parlay, null);

  // GB +3.5 (KXNFLSPREAD GB4:no) / HOU -2.5 / KC5:no (LV +4.5)
  const gbLock = lockById('9058322b');
  const gbRfq = mkRfq([
    ['aec-nfl-den-sf-2026-10-04', BUY],
    ['aec-nfl-kc-lv-2026-10-04', SELL],
    ['asc-nfl-gb-tb-2026-10-04-neg-3pt5', SELL], // TB +3.5
  ]);
  const gbHit = matchOf(gbRfq, [gbLock]);
  assert.ok(gbHit.parlay, `GB/TB: ${gbHit.reason}`);
  assert.strictEqual(matchOf(mkRfq([
    ['aec-nfl-den-sf-2026-10-04', BUY], ['aec-nfl-kc-lv-2026-10-04', SELL],
    ['asc-nfl-gb-tb-2026-10-04-pos-3pt5', SELL], // TB -3.5: wrong side
  ]), [gbLock]).parlay, null);
  const houLock = lockById('3bdc5fdd');
  const houRfq = mkRfq([
    ['aec-nfl-lar-phi-2026-10-04', BUY],
    ['aec-nfl-ne-buf-2026-10-04', BUY],
    ['asc-nfl-dal-hou-2026-10-04-pos-2pt5', SELL], // HOU -2.5
    ['asc-nfl-kc-lv-2026-10-04-neg-4pt5', SELL], // LV +4.5
  ]);
  const houHit = matchOf(houRfq, [houLock]);
  assert.ok(houHit.parlay, `HOU/LV: ${houHit.reason}`);
}

// ── 7. Every fixture RFQ against every lock: matches must be exactly the ones
//       we can independently prove (none today) — no accidental matches. ─────
{
  let matched = 0;
  for (const r of FX.rfqs) {
    const m = matchOf(r, FX.locks);
    if (m.parlay) matched += 1;
  }
  assert.strictEqual(matched, 0, 'no fixture RFQ equals an active lock (RFQs are other users\' combos)');
}

// ── 8. Game-start gating + size/profit safeguards still apply ───────────────
{
  const real = rfqById('d24e24d6');
  const lock = lockFor('pit+o37.5', [PIT_ML, ['KXNFLTOTAL-26OCT01PITCLE-38', 'yes', 'Over 37.5', 'total']]);
  const base = {
    rfq: real, parlays: [lock], markets, filledSoFar: 0, outstanding: 0,
    startedFor: () => ({ started: false }),
  };
  // Poly kickoff 2026-10-02T00:15Z; after it => game_started even though lock starts_at/startedFor say no.
  const before = evaluatePolymarketRfq({ ...base, now: Date.parse('2026-10-02T00:14:00Z') });
  assert.strictEqual(before.action, 'quoteable');
  assert.strictEqual(before.polyStartMs, Date.parse('2026-10-02T00:15:00Z'));
  const after = evaluatePolymarketRfq({ ...base, now: Date.parse('2026-10-02T00:16:00Z') });
  assert.strictEqual(after.reason, 'game_started');
  assert.strictEqual(after.started.source, 'poly.market.gameStartTime');
  // Price never worse than the lock fill: buyPrice <= implied prob of fill odds.
  const q = before.quote;
  assert.ok(Number(q.buyPrice) > 0 && Number(q.buyPrice) <= 1 / (1 + 260 / 100) + 1e-9 + 0.0005, `buyPrice ${q.buyPrice}`);
  assert.strictEqual(q.sellPrice, '0');
  // Oversized => decline, never clip.
  const big = evaluatePolymarketRfq({ ...base, rfq: { ...real, cashOrderQty: undefined, qtyDecimal: '100000' }, now: NOW });
  assert.strictEqual(big.action, 'skip');
  assert.strictEqual(big.reason, 'rfq_too_large');
}

// ── 9. Live loop: quote body goes through for a line lock; wrong side never ──
(async () => {
  const SEED_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  const posts = [];
  const http = {
    async getUserId() { return { rfqUserId: 'rfquser_test' }; },
    async listRfqs() { return { rfqs: [] }; },
    async listQuotes() { return { quotes: [] }; },
    async getCombo() { return { combos: [] }; },
    async createQuote(body) { posts.push(body); return { quoteId: 'quote_line' }; },
    async confirmQuote() { return {}; },
    async deleteQuote() { return { statusCode: 200 }; },
    close() {},
  };
  const lock = lockFor('pit+o37.5', [PIT_ML, ['KXNFLTOTAL-26OCT01PITCLE-38', 'yes', 'Over 37.5', 'total']]);
  const pending = new Map();
  const fetched = [];
  const loop = startPolymarketRfqLoop({
    env: { POLYMARKET_KEY_ID: 'key-id-fixture', POLYMARKET_SECRET_KEY: SEED_B64, POLYMARKET_RFQ_LIVE: 'true' },
    http,
    startWs: false,
    getParlays: () => [lock],
    fetchMarket: async (slug) => { fetched.push(slug); return FX.markets[slug] || null; },
    startedFor: () => ({ started: false }),
    filledSoFarFor: () => 0,
    getOutstanding: () => 0,
    pendingQuotes: pending,
    reconcileMs: 60 * 60 * 1000,
    crawl: false,
  });
  const origLog = console.log;
  console.log = () => {};
  try {
    // wrong side (Under) must not post
    const wrongSide = await loop.handleRfq({ ...mkRfq([['aec-nfl-pit-cle-2026-10-01', BUY], ['tsc-nfl-pit-cle-2026-10-01-total-37pt5', SELL]]), id: 'rfq_wrong_side', createdTime: new Date().toISOString() });
    assert.ok(!wrongSide.post, 'Under RFQ must not quote the Over lock');
    assert.strictEqual(posts.length, 0);
    // wrong line must not post
    const wrongLine = await loop.handleRfq({ ...mkRfq([['aec-nfl-pit-cle-2026-10-01', BUY], ['tsc-nfl-pit-cle-2026-10-01-total-38pt5', BUY]]), id: 'rfq_wrong_line' });
    assert.ok(!wrongLine.post);
    assert.strictEqual(posts.length, 0);
    // metadata unavailable => fail closed
    const noMeta = startPolymarketRfqLoop({
      env: { POLYMARKET_KEY_ID: 'key-id-fixture', POLYMARKET_SECRET_KEY: SEED_B64, POLYMARKET_RFQ_LIVE: 'true' },
      http, startWs: false, getParlays: () => [lock], fetchMarket: async () => null,
      startedFor: () => ({ started: false }), filledSoFarFor: () => 0, getOutstanding: () => 0,
      pendingQuotes: new Map(), reconcileMs: 60 * 60 * 1000, crawl: false,
    });
    const nm = await noMeta.handleRfq({ ...mkRfq([['aec-nfl-pit-cle-2026-10-01', BUY], ['tsc-nfl-pit-cle-2026-10-01-total-37pt5', BUY]]), id: 'rfq_nometa' });
    assert.ok(!nm.post);
    assert.strictEqual(posts.length, 0);
    noMeta.stop();
    // the exact RFQ is the only one that posts (kickoff is 2026-10-02T00:15Z: use a clock before it)
    const realNow = Date.now;
    Date.now = () => Date.parse('2026-10-01T20:00:00Z');
    let good;
    try {
      good = await loop.handleRfq({ ...mkRfq([['aec-nfl-pit-cle-2026-10-01', BUY], ['tsc-nfl-pit-cle-2026-10-01-total-37pt5', BUY]]), id: 'rfq_good' });
    } finally { Date.now = realNow; }
    assert.ok(good.post, `exact RFQ quotes: ${good.reason}`);
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].rfqId, 'rfq_good');
    assert.strictEqual(posts[0].sellPrice, '0');
    assert.ok(Array.from(pending.values()).some((p) => p.polyStartMs === Date.parse('2026-10-02T00:15:00Z')), 'kickoff carried to confirm');
    // confirm after Poly kickoff is refused even if lock gates say not started
    const entry = Array.from(pending.entries()).find(([, p]) => p.polyStartMs);
    const confirmHttp = [];
    http.confirmQuote = async (r, q) => { confirmHttp.push([r, q]); return {}; };
    entry[1].polyStartMs = Date.now() - 1000;
    const acc = await loop.handleQuoteAccepted({ quote: { id: entry[0], rfqId: 'rfq_good', acceptedSide: 'SIDE_BUY' } });
    assert.strictEqual(acc.confirmed, false);
    assert.strictEqual(acc.reason, 'game_started');
    assert.strictEqual(confirmHttp.length, 0);
  } finally {
    console.log = origLog;
    loop.stop();
  }
  console.log('poly-line-legs.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
