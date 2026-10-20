'use strict';
const assert = require('assert');
const Q = require('./quote');
const { checkSandboxEnv, assertSandboxUrl } = require('./guard');
const { fairFromLadders, dnbFair } = require('./pricer');
const { strikesFromEvent, soccerName, isHalf } = require('./catalog');
const { createSession, toMs } = require('./auth');
const { confirmPriceOf, payloadOf } = require('./runner');

let n = 0;
async function t(name, fn) { await fn(); n += 1; }

(async () => {
  const now = 1_800_000_000_000;
  const base = { PX_SANDBOX: '1', PROPHETX_SANDBOX_API_KEY: 'a', PROPHETX_SANDBOX_SECRET_KEY: 'b' };

  await t('guard: sandbox env passes', () => assert.ok(checkSandboxEnv(base).ok));
  await t('guard: PX_SANDBOX required', () => assert.ok(!checkSandboxEnv({ ...base, PX_SANDBOX: '0' }).ok));
  await t('guard: production host refused', () => {
    assert.ok(!checkSandboxEnv({ ...base, PX_API_BASE: 'https://cash.api.prophetx.co/partner' }).ok);
    assert.ok(!checkSandboxEnv({ ...base, PX_PARLAY_BASE: 'https://cash.api.prophetx.co/parlay/sp/v2' }).ok);
    assert.ok(!checkSandboxEnv({ ...base, PX_API_BASE: 'https://sandbox.prophetx.dev.evil.com/x' }).ok);
  });
  await t('guard: trading keys refused', () => {
    for (const k of ['KALSHI_PRIVATE_KEY', 'KALSHI_API_KEY_ID', 'POLYMARKET_SECRET_KEY', 'POLY_API_KEY', 'PROPHETX_API_KEY', 'NOVIG_API_TOKEN']) {
      const r = checkSandboxEnv({ ...base, [k]: 'x' });
      assert.ok(!r.ok, k);
      assert.ok(!r.problems.join(' ').includes('x\''), 'never echoes values');
    }
  });
  await t('guard: callback host must be sandbox', () => {
    assert.ok(assertSandboxUrl('https://api.sandbox.prophetx.dev/parlay/sp/v2/orders/offers?x=1'));
    assert.throws(() => assertSandboxUrl('https://cash.api.prophetx.co/parlay/sp/v2/orders/offers'));
    assert.throws(() => assertSandboxUrl('https://evil.com/?h=sandbox.prophetx.dev'));
  });

  const known = new Map([
    ['s1', { strikeId: 's1', eventId: 1, startMs: now + 3600e3 }],
    ['s2', { strikeId: 's2', eventId: 2, startMs: now + 3600e3 }],
    ['s1b', { strikeId: 's1b', eventId: 1, startMs: now + 3600e3 }],
    ['old', { strikeId: 'old', eventId: 3, startMs: now - 1 }],
  ]);
  await t('screen: declines unsupported / correlated / started / size', () => {
    assert.strictEqual(Q.screenLegs([{ strike_id: 's1' }, { strike_id: 's2' }], { known, nowMs: now }), null);
    assert.strictEqual(Q.screenLegs([{ strike_id: 's1' }], { known, nowMs: now }), 'too_few_legs');
    assert.strictEqual(Q.screenLegs([{ strike_id: 's1' }, { strike_id: 'zz' }], { known, nowMs: now }), 'unsupported_leg');
    assert.strictEqual(Q.screenLegs([{ strike_id: 's1' }, { strike_id: 's1b' }], { known, nowMs: now }), 'correlated_same_game');
    assert.strictEqual(Q.screenLegs([{ strike_id: 's1', sport_event_id: 9 }, { strike_id: 's2', sport_event_id: 9 }], { known, nowMs: now }), 'correlated_same_game');
    assert.strictEqual(Q.screenLegs([{ strike_id: 's1' }, { strike_id: 'old' }], { known, nowMs: now }), 'game_started');
    assert.strictEqual(Q.screenLegs([{ strike_id: 's1' }, { strike_id: 's1' }], { known, nowMs: now }), 'duplicate_leg');
    assert.strictEqual(Q.screenLegs([{ line_id: 's1' }, { line_id: 's2' }], { known, nowMs: now }), null);
  });

  await t('price: product of legs × 1.05 margin, participant side floored', () => {
    const r = Q.priceParlay([{ strike_id: 'a', p: 0.4, at: now }, { strike_id: 'b', p: 0.55, at: now }], { nowMs: now });
    assert.strictEqual(r.decline, null);
    assert.ok(Math.abs(r.fairP - 0.22) < 1e-12);
    assert.ok(Math.abs(r.quoteP - 0.231) < 1e-12);
    assert.strictEqual(r.fairAmerican, 355);
    assert.strictEqual(r.participantAmerican, 332); // 0.231 → +332.9, floored in our favor
    assert.ok(Q.impliedFromAmerican(r.participantAmerican) >= r.quoteP);
    assert.strictEqual(r.estimated.length, 2);
  });
  await t('price: 15-second stale rule declines', () => {
    assert.strictEqual(Q.priceParlay([{ strike_id: 'a', p: 0.4, at: now - 15_001 }, { strike_id: 'b', p: 0.5, at: now }], { nowMs: now }).decline, 'leg_stale');
    assert.strictEqual(Q.priceParlay([{ strike_id: 'a', p: 0.4, at: now - 15_000 }, { strike_id: 'b', p: 0.5, at: now }], { nowMs: now }).decline, null);
    assert.strictEqual(Q.priceParlay([{ strike_id: 'a', p: null, at: now }], { nowMs: now }).decline, 'leg_unpriced');
  });

  await t('probabilities reconstruct the mirror of confirmed price (docs +4146 case)', () => {
    const legs = [0.5, 0.45, 0.4, 0.35, 0.3].map((p, i) => ({ strike_id: `s${i}`, p }));
    // Docs: confirmed +4146 → target is implied(−4146), NOT implied(+4146).
    assert.ok(Math.abs(Q.mirrorTarget(4146) - 4146 / 4246) < 1e-12);
    // Our normal case: ProphetX echoes the MM-side price (−participant) → target = participant implied.
    const target = Q.mirrorTarget(-4146);
    assert.ok(Math.abs(target - 100 / 4246) < 1e-12);
    const out = Q.legProbabilities(legs, target);
    const prod = out.reduce((a, x) => a * x.probability, 1);
    assert.ok(Math.abs(prod - target) < 1e-12);
    // ratios between legs preserved
    assert.ok(Math.abs(out[0].probability / out[1].probability - 0.5 / 0.45) < 1e-9);
    assert.strictEqual(Q.legProbabilities(legs, 0.99), null); // impossible target → null, never > 1
  });

  await t('inverse method: best complete $500 blend across venues, sign-flipped', () => {
    // Opponent ladders (fee-included Americans, $ stake sizes).
    const r = fairFromLadders({
      kalshi: [{ american: 130, size: 1000 }],
      novig: [{ american: 140, size: 100 }, { american: 120, size: 1000 }], // blends below +130
      polymarket: [{ american: 160, size: 50 }], // cannot fund $500 profit → ignored
    });
    assert.strictEqual(r.best.venue, 'kalshi');
    assert.strictEqual(r.venues.polymarket, null);
    // ourTrue = 1 − implied(+130) = sign-flip → −130
    assert.ok(Math.abs(r.p - 130 / 230) < 1e-12);
    assert.strictEqual(fairFromLadders({ kalshi: [] }).p, null);
  });

  await t('catalog: full-game moneyline strikes only', () => {
    const ev = { event_id: 7, scheduled: '2026-10-20T00:15:00Z', competitors: [{ id: 1, side: 'home', display_name: 'San Francisco 49ers' }, { id: 2, side: 'away', display_name: 'Washington Commanders' }] };
    const markets = [
      { type: 'moneyline', sub_type: 'first_half_moneyline', selections: [[{ strike_id: 'h1', competitor_id: 1 }], [{ strike_id: 'h2', competitor_id: 2 }]] },
      { type: 'moneyline', sub_type: 'moneyline', status: 'active', selections: [[{ strike_id: 'm1', competitor_id: 1, outcome_id: 4 }], [{ strike_id: 'm2', competitor_id: 2, outcome_id: 5 }]] },
    ];
    const s = strikesFromEvent(ev, markets, { sport: 'americanfootball_nfl', league: 'nfl' });
    markets.push(
      { type: 'total', sub_type: 'total', market_strikes: [{ selections: [[{ strike_id: 'u43', outcome_id: 13, strike: 43, name: 'under 43' }], [{ strike_id: 'o43', outcome_id: 12, strike: 43, name: 'over 43' }]] }] },
      { type: 'spread', sub_type: 'spread', market_strikes: [{ selections: [[{ strike_id: 'h-6', competitor_id: 1, outcome_id: 1714, strike: -6.5 }], [{ strike_id: 'a+6', competitor_id: 2, outcome_id: 1715, strike: 6.5 }]] }] },
      { type: 'total', sub_type: 'first_half_total', market_strikes: [{ selections: [[{ strike_id: 'x1', strike: 20 }], [{ strike_id: 'x2', strike: 20 }]] }] },
    );
    const s2 = strikesFromEvent(ev, markets, { sport: 'americanfootball_nfl', league: 'nfl' });
    assert.deepStrictEqual(s2.map((x) => [x.strikeId, x.kind, x.oppLabel]), [
      ['m1', 'ML', 'Washington Commanders'], ['m2', 'ML', 'San Francisco 49ers'],
      ['u43', 'TOT', 'o43'], ['o43', 'TOT', 'u43'],
      ['h-6', 'SPR', 'Washington Commanders +6.5'], ['a+6', 'SPR', 'San Francisco 49ers -6.5'],
    ]);
    assert.deepStrictEqual(s.map((x) => [x.strikeId, x.team, x.opp]), [['m1', 'San Francisco 49ers', 'Washington Commanders'], ['m2', 'Washington Commanders', 'San Francisco 49ers']]);
    assert.strictEqual(s[0].game, 'Washington Commanders @ San Francisco 49ers');
  });

  await t('soccer: names cleaned for venue matching', () => {
    assert.strictEqual(soccerName('Tottenham Hotspur FC'), 'Tottenham Hotspur');
    assert.strictEqual(soccerName('Fenerbahçe SK'), 'Fenerbahce');
    assert.strictEqual(soccerName('AC Milan'), 'Milan');
    assert.ok(isHalf(2.5) && isHalf(-0.5) && !isHalf(2) && !isHalf(-1) && !isHalf(2.25));
  });

  await t('soccer: market mapping + draw handling', () => {
    const ev = { event_id: 9, scheduled: '2026-10-20T16:45:00Z', competitors: [
      { id: 10, side: 'home', display_name: 'Fenerbahçe SK' }, { id: 20, side: 'away', display_name: 'SK Slavia Praha' }] };
    const yesNo = (a, b) => [[{ strike_id: a, outcome_id: 1, name: 'YES' }], [{ strike_id: b, outcome_id: 2, name: 'NO' }]];
    const markets = [
      // 2-way: draw handling undocumented → never priced
      { id: 11, type: 'moneyline', sub_type: 'moneyline', name: 'Moneyline (2 Way)', selections: [[{ strike_id: 'ml2h', competitor_id: 10, outcome_id: 4 }], [{ strike_id: 'ml2a', competitor_id: 20, outcome_id: 5 }]] },
      { id: 1325, type: 'moneyline', sub_type: 'moneyline_3_way', name: 'Fenerbahçe SK to Win (90 Min)', selections: yesNo('hY', 'hN') },
      { id: 1326, type: 'moneyline', sub_type: 'moneyline_3_way', name: 'SK Slavia Praha to Win (90 Min)', selections: yesNo('aY', 'aN') },
      { id: 1327, type: 'moneyline', sub_type: 'moneyline_3_way', name: 'Draw (90 Min)', selections: yesNo('dY', 'dN') },
      { id: 1318, type: 'moneyline', sub_type: 'both_teams_to_score', name: 'Both Teams To Score', selections: yesNo('bY', 'bN') },
      { id: 18, type: 'total', sub_type: 'total', name: 'Total Goals (Regular Time)', market_strikes: [
        { selections: [[{ strike_id: 'u25', outcome_id: 13, strike: 2.5, name: 'under 2.5' }], [{ strike_id: 'o25', outcome_id: 12, strike: 2.5, name: 'over 2.5' }]] },
        { selections: [[{ strike_id: 'u2', outcome_id: 13, strike: 2 }], [{ strike_id: 'o2', outcome_id: 12, strike: 2 }]] }] },
      { id: 16, type: 'spread', sub_type: 'spread', name: 'Spread (Regular Time)', market_strikes: [
        { selections: [[{ strike_id: 'h-1', competitor_id: 10, outcome_id: 1714, strike: -1 }], [{ strike_id: 'a+1', competitor_id: 20, outcome_id: 1715, strike: 1 }]] },
        { selections: [[{ strike_id: 'h-.5', competitor_id: 10, outcome_id: 1714, strike: -0.5 }], [{ strike_id: 'a+.5', competitor_id: 20, outcome_id: 1715, strike: 0.5 }]] },
        { selections: [[{ strike_id: 'h-1.5', competitor_id: 10, outcome_id: 1714, strike: -1.5 }], [{ strike_id: 'a+1.5', competitor_id: 20, outcome_id: 1715, strike: 1.5 }]] }] },
    ];
    const s = strikesFromEvent(ev, markets, { sport: 'soccer_uefa_champs_league', league: 'ucl', soccer: true });
    const m = Object.fromEntries(s.map((x) => [x.strikeId, [x.kind, x.oppLabel]]));
    // Inverse for 3-way: YES's opponent is that outcome's own NO; NO's opponent is its YES.
    assert.deepStrictEqual(m.hY, ['ML', 'Fenerbahce no']);
    assert.deepStrictEqual(m.hN, ['ML', 'Fenerbahce']);
    assert.deepStrictEqual(m.aY, ['ML', 'Slavia Praha no']);
    assert.deepStrictEqual(m.dY, ['ML', 'Draw no']);
    assert.deepStrictEqual(m.dN, ['ML', 'Draw']);
    // Half-goal totals only (a whole line can push).
    assert.deepStrictEqual(m.o25, ['TOT', 'u2.5']);
    assert.deepStrictEqual(m.u25, ['TOT', 'o2.5']);
    assert.ok(!m.o2 && !m.u2);
    // ±0.5 handicap = 3-way result: home −0.5 = home wins → opponent home NO;
    // away +0.5 = away win or draw → opponent home wins YES.
    assert.deepStrictEqual(m['h-.5'], ['ML', 'Fenerbahce no']);
    assert.deepStrictEqual(m['a+.5'], ['ML', 'Fenerbahce']);
    assert.deepStrictEqual(m['h-1.5'], ['SPR', 'Slavia Praha +1.5']);
    assert.deepStrictEqual(m['a+1.5'], ['SPR', 'Fenerbahce -1.5']);
    // Not priced: 2-way moneyline, whole-goal handicap, BTTS.
    for (const k of ['h-1', 'a+1', 'bY', 'bN']) assert.ok(!m[k], k);
    // 2-way ML (sandbox): draw-no-bet, opponent = other team's win + draw.
    assert.deepStrictEqual(m.ml2h, ['DNB', 'Slavia Praha']);
    assert.deepStrictEqual(m.ml2a, ['DNB', 'Fenerbahce']);
    assert.strictEqual(s.find((x) => x.strikeId === 'ml2h').drawLabel, 'Draw no');
    assert.strictEqual(s[0].game, 'Slavia Praha @ Fenerbahce');
    // Two legs from this match → correlated → declined.
    const known = new Map(s.map((x) => [x.strikeId, x]));
    assert.strictEqual(Q.screenLegs([{ strike_id: 'hY' }, { strike_id: 'o25' }], { known, nowMs: Date.parse('2026-10-20T00:00:00Z') }), 'correlated_same_game');
  });

  await t('draw-no-bet fair: 1 − P(other | no draw), both from inverse asks', () => {
    // Other team YES ask +300 (p .25), Draw-No ask −300 (→ pDraw = 1 − .75 = .25).
    const r = dnbFair({ kalshi: [{ american: 300, size: 1000 }] }, { kalshi: [{ american: -300, size: 5000 }] });
    assert.ok(Math.abs(r.p - (1 - 0.25 / 0.75)) < 1e-9);
    assert.strictEqual(dnbFair({ kalshi: [] }, { kalshi: [{ american: -300, size: 5000 }] }).p, null);
  });

  await t('auth: one login, then refresh (no second login)', async () => {
    let clock = now;
    const calls = [];
    const f = async (url, init) => {
      calls.push(new URL(url).pathname);
      return { status: 200, json: async () => ({ data: { access_token: `t${calls.length}`, refresh_token: 'r', access_expire_time: Math.floor((clock + 600e3) / 1000), refresh_expire_time: Math.floor((clock + 3 * 86400e3) / 1000) } }) };
    };
    const s = createSession({ apiBase: 'https://api.sandbox.prophetx.dev/partner', accessKey: 'a', secretKey: 'b', fetch: f, now: () => clock, logger: { log() {}, warn() {} } });
    await s.token(); await s.token();
    clock += 500e3; await s.token();
    clock += 500e3; await s.token();
    assert.deepStrictEqual(calls, ['/partner/auth/login', '/partner/auth/refresh', '/partner/auth/refresh']);
    assert.strictEqual(s.stats().logins, 1);
    assert.strictEqual(toMs(1792421207150942200), 1792421207150);
  });

  await t('runner helpers', () => {
    assert.strictEqual(confirmPriceOf({ odds: -1180 }), -1180);
    assert.strictEqual(confirmPriceOf({ price: '250' }), 250);
    assert.deepStrictEqual(payloadOf({ payload: { a: 1 } }), { a: 1 });
    assert.deepStrictEqual(payloadOf({ a: 1 }), { a: 1 });
  });

  await t('nba: tournament + Kalshi series; full-game spread/total only, exact lines', () => {
    const { TOURNAMENTS } = require('./catalog');
    const { KALSHI_SERIES, lineEqual } = require('./vendor/book-depth');
    const T = TOURNAMENTS.find((x) => x.id === 132);
    assert.strictEqual(T.sport, 'basketball_nba');
    assert.deepStrictEqual(KALSHI_SERIES.basketball_nba, { ML: 'KXNBAGAME', SPR: 'KXNBASPREAD', TOT: 'KXNBATOTAL' });
    const ev = { event_id: 9, scheduled: '2026-10-21T01:30:00Z', competitors: [{ id: 1, side: 'home', name: 'San Antonio Spurs' }, { id: 2, side: 'away', name: 'Oklahoma City Thunder' }] };
    const pair = (a, b) => ({ selections: [[a], [b]] });
    const markets = [
      { type: 'moneyline', sub_type: 'moneyline', selections: [[{ strike_id: 'm1', competitor_id: 1 }], [{ strike_id: 'm2', competitor_id: 2 }]] },
      { type: 'spread', sub_type: 'spread', market_strikes: [pair({ strike_id: 's1', competitor_id: 1, strike: 6.5 }, { strike_id: 's2', competitor_id: 2, strike: -6.5 })] },
      { type: 'total', sub_type: 'total', market_strikes: [pair({ strike_id: 't1', outcome_id: 12, name: 'over 224.5', strike: 224.5 }, { strike_id: 't2', outcome_id: 13, name: 'under 224.5', strike: 224.5 })] },
      { type: 'spread', sub_type: 'first_half_spread', market_strikes: [pair({ strike_id: 'h1', competitor_id: 1, strike: 3.5 }, { strike_id: 'h2', competitor_id: 2, strike: -3.5 })] },
      { type: 'total', sub_type: 'team_total_points', market_strikes: [pair({ strike_id: 'tt1', outcome_id: 12, strike: 110.5 }, { strike_id: 'tt2', outcome_id: 13, strike: 110.5 })] },
    ];
    const ss = strikesFromEvent(ev, markets, T);
    assert.deepStrictEqual(ss.map((x) => x.strikeId).sort(), ['m1', 'm2', 's1', 's2', 't1', 't2']);
    const s1 = ss.find((x) => x.strikeId === 's1');
    assert.strictEqual(s1.oppLabel, 'Oklahoma City Thunder -6.5');
    assert.strictEqual(ss.find((x) => x.strikeId === 't1').oppLabel, 'u224.5');
    assert.ok(lineEqual(224.5, 224.5) && !lineEqual(224.5, 225.5));
  });

  await t('screen: same-game ML+spread / spread+total declined', () => {
    const known = new Map([['a', { eventId: 1 }], ['b', { eventId: 1 }], ['c', { eventId: 2 }]]);
    assert.strictEqual(Q.screenLegs([{ strike_id: 'a', sport_event_id: 1 }, { strike_id: 'b', sport_event_id: 1 }], { known, nowMs: now }), 'correlated_same_game');
    assert.strictEqual(Q.screenLegs([{ strike_id: 'a', sport_event_id: 1 }, { strike_id: 'c', sport_event_id: 2 }], { known, nowMs: now }), null);
  });

  console.log(`px tests ok (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });

{ // UFC: fight-winner ML only, no rounds/props
  const { strikesFromEvent, TOURNAMENTS } = require('./catalog');
  const t = TOURNAMENTS.find((x) => x.league === 'ufc');
  const ev = { event_id: 1, scheduled: '2026-10-24T04:00:00Z', competitors: [{ id: 10, side: 'home', name: 'A' }, { id: 20, side: 'away', name: 'B' }] };
  const mk = [
    { type: 'moneyline', sub_type: 'moneyline', selections: [[{ strike_id: 's1', competitor_id: 10 }], [{ strike_id: 's2', competitor_id: 20 }]] },
    { type: 'total', sub_type: 'total', market_strikes: [{ selections: [[{ strike_id: 's3', strike: 1.5, outcome_id: 12 }], [{ strike_id: 's4', strike: 1.5 }]] }] },
  ];
  const ss = strikesFromEvent(ev, mk, t);
  assert.deepStrictEqual(ss.map((s) => [s.kind, s.team, s.opp]), [['ML', 'A', 'B'], ['ML', 'B', 'A']]);
}
