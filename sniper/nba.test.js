'use strict';
const assert = require('assert');
const B = require('./nba');
const L = require('./lines');
const { decide, classifyLegs, settleAtMs, nbaHorizonCheck, repriceFair } = require('./engine');
const { ALL_VENUES, legFairDepth } = require('./fair');
const { createKickoffResolver, gameIdOfTicker } = require('./kickoff');
const { createNflFrameFilter, NFL_NEEDLES, NBA_NEEDLES } = require('./intake');
const { legParts } = require('./fill-alert');
const S = require('../auto-sniper');

// Real Kalshi tickers (Oct 23 2026). Ticker date = ET tip date; occurrence = tip + 3h.
const IND = 'KXNBAGAME-26OCT23DALIND-IND'; const DAL = 'KXNBAGAME-26OCT23DALIND-DAL';
const GSW = 'KXNBAGAME-26OCT26GSWDEN-GSW';
const SPR = 'KXNBASPREAD-26OCT23DALIND-IND9'; const TOT = 'KXNBATOTAL-26OCT23DALIND-225';
const NFL = 'KXNFLGAME-26OCT25INDMIN-MIN';

// ── parsing + team identity ──
assert.deepStrictEqual(B.parseNbaMl(`${IND}:yes`), { ticker: IND, date: '2026-10-23', codes: ['DAL', 'IND'], selection: 'IND', gameId: 'nba|2026-10-23|DAL+IND' });
assert.strictEqual(B.parseNbaMl('KXNBAGAME-26OCT23DALXXX-DAL'), null, 'unknown code => unmapped');
assert.strictEqual(B.parseNbaMl('KXNBAPTS-26OCT23DALIND-DALCFLAGG32-15'), null, 'player props are not NBA ML');
assert.strictEqual(B.classifyNbaLeg(`${IND}:no`).team, 'DAL', 'No on IND = DAL wins');
assert.strictEqual(B.classifyNbaLeg('KXNBAGAME-26OCT23DALXXX-DAL:yes').reason, 'nba_unmapped');
for (const [n, c] of [['Golden State Warriors', 'GSW'], ['LA Clippers', 'LAC'], ['Los Angeles Lakers', 'LAL'], ['Portland Trail Blazers', 'POR'], ['Trail Blazers', 'POR'], ['76ers', 'PHI'], ['Philadelphia 76ers', 'PHI'], ['Knicks', 'NYK'], ['Los Angeles', null], ['', null]]) assert.strictEqual(B.codeForName(n), c, n);
assert.strictEqual(B.codeForPoly('gs'), 'GSW'); assert.strictEqual(B.codeForPoly('pho'), 'PHX'); assert.strictEqual(B.codeForPoly('ny'), 'NYK');
assert.strictEqual(B.codeForEspn('UTAH'), 'UTA'); assert.strictEqual(B.codeForEspn('WSH'), 'WAS'); assert.strictEqual(B.codeForEspn('SA'), 'SAS'); assert.strictEqual(B.codeForEspn('NO'), 'NOP');
assert.strictEqual(Object.keys(B.TEAMS).length, 30);

// ── ML book: inverse-bet fair, best opposing price, real depth, 15s staleness ──
let t = Date.parse('2026-10-23T20:00:00Z');
const book = B.createNbaBook({ now: () => t, staleMs: 15000, depthUsd: 2000 });
book.ingestKalshiOrderbooks([
  { ticker: IND, orderbook_fp: { yes_dollars: [['0.70', '50000']], no_dollars: [['0.28', '50000']] } },
  { ticker: DAL, orderbook_fp: { yes_dollars: [['0.29', '50000']], no_dollars: [['0.69', '50000']] } },
]);
const GID = 'nba|2026-10-23|DAL+IND';
let f = book.legFair(GID, 'IND');
assert.ok(f.p > 0.66 && f.p < 0.71, JSON.stringify(f)); assert.ok(/^kalshi/.test(f.best));
// Polymarket US: identity from the slug; aec-nba-dal-ind :no = IND side... here :yes = DAL (first slug team)
assert.strictEqual(book.ingestRelay('polymarket', [{ bet_type: 'moneyline', feed: 'polymarket-us', side: 'Mavericks', odds: 0.25, token_id: 'us:aec-nba-dal-ind-2026-10-23:yes', start: '2026-10-23T23:00:00Z', updated_at: new Date(t).toISOString(), depth: [{ odds: 0.25, size: 100000 }] }]), 1);
f = book.legFair(GID, 'IND'); assert.strictEqual(f.best, 'polymarket'); assert.ok(Math.abs(f.p - (1 - (0.25 + 0.0695 * 0.25 * 0.75))) < 1e-9);
// slug/name disagreement => ignored
assert.strictEqual(book.ingestRelay('polymarket', [{ bet_type: 'moneyline', feed: 'polymarket-us', side: 'Pacers', odds: 0.1, token_id: 'us:aec-nba-dal-ind-2026-10-23:yes', start: '2026-10-23T23:00:00Z', updated_at: new Date(t).toISOString(), depth: [{ odds: 0.1, size: 1e6 }] }]), 0);
// Novig (full names, $0 pregame fee) cheaper => best
book.ingestRelay('novig', [{ bet_type: 'moneyline', away: 'Dallas Mavericks', home: 'Indiana Pacers', side: 'Dallas Mavericks', odds: 0.24, depth: [{ odds: 0.24, size: 100000 }], start: '2026-10-23T23:00:00Z', updated_at: new Date(t).toISOString() }], { feedLive: true, polledAt: t });
f = book.legFair(GID, 'IND'); assert.strictEqual(f.best, 'novig'); assert.ok(Math.abs(f.p - 0.76) < 1e-9);
// ProphetX: 2% commission folded in (pxEffective) — 0.20 raw => worse than its face price
book.ingestRelay('prophetx', [{ bet_type: 'moneyline', away: 'Dallas Mavericks', home: 'Indiana Pacers', side: 'Dallas Mavericks', odds: 0.2, depth: [{ odds: 0.2, size: 5000 }], start: '2026-10-23T23:00:00Z', updated_at: new Date(t).toISOString() }], { feedLive: true, polledAt: t });
f = book.legFair(GID, 'IND'); assert.strictEqual(f.best, 'prophetx'); assert.ok(f.p < 0.8 && f.p > 0.79, String(f.p));
// depth below $2,000 never counts: thin ProphetX ($100) is skipped
const thin = B.createNbaBook({ now: () => t, depthUsd: 2000 });
thin.ingestKalshiOrderbooks([{ ticker: IND, orderbook_fp: { yes_dollars: [['0.70', '50000']], no_dollars: [['0.28', '50000']] } }]);
thin.ingestRelay('prophetx', [{ bet_type: 'moneyline', away: 'Dallas Mavericks', home: 'Indiana Pacers', side: 'Dallas Mavericks', odds: 0.29, depth: [{ odds: 0.29, size: 10 }], start: '2026-10-23T23:00:00Z', updated_at: new Date(t).toISOString() }], { feedLive: true, polledAt: t });
assert.ok(/^kalshi/.test(legFairDepth({ kind: 'nba', gameId: GID, team: 'IND' }, { nbaBook: thin, venues: ALL_VENUES }).best));
t += 16000; assert.strictEqual(book.legFair(GID, 'IND').p, null, 'stale after 15s');

// ── spreads / totals through lines.js (same gameId) ──
assert.deepStrictEqual(L.parseLineTicker(SPR).yesKey, 'spread:IND:-8.5'); assert.deepStrictEqual(L.parseLineTicker(SPR).noKey, 'spread:DAL:+8.5');
assert.strictEqual(L.parseLineTicker(SPR).gameId, GID);
assert.strictEqual(L.classifyLineLeg(`${TOT}:no`).outcome, 'total:under:224.5');
let lt = Date.parse('2026-10-23T20:00:00Z');
const lines = L.createLinesBook({ now: () => lt, depthUsd: 2000 });
lines.addGamesFromTickers([SPR, TOT]);
const q = (o) => ({ start: '2026-10-23T23:00:00Z', updated_at: new Date(lt).toISOString(), away: 'Dallas Mavericks', home: 'Indiana Pacers', ...o });
lines.ingestRelay('novig', 'nba', [q({ bet_type: 'total', line: 224.5, side: 'Over', side_type: 'Over', odds: 0.5, depth: [{ odds: 0.5, size: 50000 }] }), q({ bet_type: 'spread', line: 8.5, side: 'Dallas Mavericks', odds: 0.52, depth: [{ odds: 0.52, size: 50000 }] })], { feedLive: true, polledAt: lt });
assert.deepStrictEqual(lines.mainTickers([SPR, TOT, 'KXNBATOTAL-26OCT23DALIND-263']), [SPR, TOT], 'only main-line strikes polled');
let lf = lines.legFair(L.classifyLineLeg(`${TOT}:no`)); assert.strictEqual(lf.best, 'novig'); assert.ok(Math.abs(lf.p - 0.5) < 1e-9);
lf = lines.legFair(L.classifyLineLeg(`${SPR}:yes`)); assert.ok(Math.abs(lf.p - 0.48) < 1e-9, JSON.stringify(lf));
// Polymarket US lines: nickname + slug abbr identity
lines.ingestRelay('polymarket', 'nba', [q({ feed: 'polymarket-us-lines', bet_type: 'spread', line: 8.5, away: 'Mavericks', home: 'Pacers', away_abbr: 'dal', home_abbr: 'ind', side: 'Mavericks', side_abbr: 'dal', odds: 0.45, depth: [{ odds: 0.45, size: 50000 }], confirmed_at: new Date(lt).toISOString() })]);
lf = lines.legFair(L.classifyLineLeg(`${SPR}:yes`)); assert.strictEqual(lf.best, 'polymarket');

// ── classify: NBA off by default; on => ML via nba.js, lines via lines.js; same-game blocked ──
assert.strictEqual(classifyLegs({ legKeys: [`${IND}:yes`, `${NFL}:yes`] }, { lines: true }).reason, 'nba_off');
const c = classifyLegs({ legKeys: [`${IND}:yes`, `${NFL}:yes`, `${GSW}:no`] }, { lines: true, nba: true });
assert.ok(c.ok); assert.deepStrictEqual(c.legs.map((l) => l.kind || 'ml'), ['nba', 'ml', 'nba']); assert.strictEqual(c.legs[2].team, 'DEN');
assert.strictEqual(classifyLegs({ legKeys: [`${IND}:yes`, `${SPR}:no`] }, { lines: true, nba: true }).reason, 'correlated_same_game');
assert.strictEqual(classifyLegs({ legKeys: [`${IND}:yes`, 'KXNBAPTS-26OCT23DALIND-DALCFLAGG32-15:yes'] }, { lines: true, nba: true }).ok, false, 'no NBA player props');
assert.strictEqual(classifyLegs({ legKeys: [`${IND}:yes`, `${SPR}:no`.replace('DALIND', 'GSWDEN').replace('IND9', 'DEN9')] }, { lines: false, nba: true }).reason, 'lines_off');

// ── decide: 5% NBA minimum (highest rule wins), 36h horizon, settle = last tip + 3h ──
const src = (venue, cost) => ({ venue, cost, reason: 'ok', used: true, availUsd: 5000 });
const pmLive = { legFair: () => ({ sources: [src('kalshi', 0.45)] }) };
const nbaBook = { legFair: () => ({ sources: [src('novig', 0.3)] }) };
const linesBook = { legFair: () => ({ sources: [src('novig', 0.5)] }) };
const tip = Date.parse('2026-10-23T23:00:00Z'); const nflKo = Date.parse('2026-10-25T17:00:00Z');
const kickoffFor = (tk) => (/^KXNBA/.test(tk) ? tip : nflKo);
const ctx = (env = {}, extra = {}) => ({ config: S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_NBA: '1', ...env }), ledger: S.createSniperLedger(), pmLive, tdBook: null, nbaBook, linesBook, venues: ALL_VENUES, kickoffFor, makerRate: 0.035, nowMs: Date.parse('2026-10-23T15:00:00Z'), ...extra });
assert.strictEqual(S.sniperConfig({}).nba, false); assert.strictEqual(S.sniperConfig({}).minRoiNba, 0.06);
assert.strictEqual(S.sniperConfig({}).nbaHours, 36); assert.strictEqual(S.sniperConfig({}).nbaGameHours, 3);
const rq = { rfqId: 'b1', marketTicker: 'KXMVECROSSCATEGORY-X', legKeys: [`${IND}:yes`, `${NFL}:yes`], contracts: 20 };
const d = decide(rq, ctx()).decision;
assert.strictEqual(d.action, 'quote', JSON.stringify(d)); assert.strictEqual(d.minRoi, 0.06); assert.strictEqual(d.hasNba, true);
assert.ok(Math.abs(d.fairYes - 0.7 * 0.55) < 1e-9); assert.strictEqual(d.legDetail[0].venue, 'novig');
assert.strictEqual(d.settleAt, nflKo + 4 * 3600e3, 'NFL leg ends last');
assert.strictEqual(decide({ ...rq, rfqId: 'b2' }, ctx({ SNIPER_MIN_ROI_NBA: '1000' })).decision.reason, 'roi_below_min_nba');
assert.strictEqual(decide({ ...rq, rfqId: 'b3' }, ctx({ SNIPER_NBA: '0' })).decision.reason, 'scope_nba_off');
assert.strictEqual(decide({ ...rq, rfqId: 'b4' }, { ...ctx(), nbaBook: null }).decision.reason, 'scope_nba_off');
// NBA TD-style higher rules still win: a 7% rule beats NBA 6%
const hi = decide({ ...rq, rfqId: 'b5', legKeys: [`${IND}:yes`, `${SPR.replace('DALIND', 'GSWDEN').replace('IND9', 'DEN9')}:no`] }, ctx({ SNIPER_MIN_ROI_LINES: '0.07' })).decision;
assert.strictEqual(hi.action, 'quote', JSON.stringify(hi)); assert.strictEqual(hi.minRoi, 0.07);
// lines-only NBA parlay still gets 5% (not the 4% NFL lines rule)
const lo = decide({ ...rq, rfqId: 'b6', legKeys: [`${TOT}:no`, `${NFL}:yes`] }, ctx()).decision; assert.strictEqual(lo.minRoi, 0.06);
// NBA-only parlay: settle = last tip + 3h
const nbaOnly = decide({ ...rq, rfqId: 'b7', legKeys: [`${IND}:yes`, `${GSW}:yes`] }, ctx()).decision;
assert.strictEqual(nbaOnly.action, 'quote'); assert.strictEqual(nbaOnly.settleAt, tip + 3 * 3600e3);
// 36h horizon: an NBA leg tipping 40h out is skipped; NFL legs are not affected by it
const far = (tk) => (/^KXNBA/.test(tk) ? Date.parse('2026-10-25T07:00:00Z') : nflKo);
assert.strictEqual(decide({ ...rq, rfqId: 'b8' }, ctx({}, { kickoffFor: far })).decision.reason, 'nba_beyond_horizon');
assert.strictEqual(nbaHorizonCheck([`${NFL}:yes`], () => nflKo, Date.parse('2026-10-23T15:00:00Z'), 36), null);
assert.strictEqual(nbaHorizonCheck([`${IND}:yes`], () => tip, tip - 36 * 3600e3, 36), null, 'exactly 36h is inside');
assert.strictEqual(decide({ ...rq, rfqId: 'b9' }, ctx({ SNIPER_NBA_HOURS: '48' }, { kickoffFor: far })).decision.action, 'quote');
// unknown tip => no_kickoff skip (never guessed)
assert.strictEqual(decide({ ...rq, rfqId: 'b10' }, ctx({}, { kickoffFor: (tk) => (/^KXNBA/.test(tk) ? null : nflKo) })).decision.reason, 'no_kickoff');
assert.strictEqual(settleAtMs([`${IND}:yes`, `${NFL}:no`], kickoffFor, 4, 3), nflKo + 4 * 3600e3);
assert.ok(Math.abs(repriceFair(rq, { pmLive, tdBook: null, venues: ALL_VENUES, nbaBook, linesBook }) - 0.7 * 0.55) < 1e-9);
assert.strictEqual(d.risk <= 200 + 1e-9 || d.risk <= 100 + 1e-9, true);

// ── kickoffs: ESPN NBA scoreboard (real abbreviations, trimmed) ──
assert.strictEqual(gameIdOfTicker(IND), GID); assert.strictEqual(gameIdOfTicker(SPR), GID); assert.strictEqual(gameIdOfTicker(TOT), GID);
const espn = { events: [
  { date: '2026-10-23T23:00Z', competitions: [{ date: '2026-10-23T23:00Z', competitors: [{ team: { abbreviation: 'IND', displayName: 'Indiana Pacers' } }, { team: { abbreviation: 'DAL', displayName: 'Dallas Mavericks' } }] }], status: { type: { state: 'pre' } } },
  { date: '2026-10-24T02:00Z', competitions: [{ date: '2026-10-24T02:00Z', competitors: [{ team: { abbreviation: 'GS' } }, { team: { abbreviation: 'MEM' } }] }], status: { type: { state: 'pre' } } },
  { date: '2026-10-24T01:30Z', competitions: [{ date: '2026-10-24T01:30Z', competitors: [{ team: { abbreviation: 'UTAH' } }, { team: { abbreviation: 'NO' } }] }], status: { type: { state: 'in' } } },
] };
const ks = B.espnNbaKickoffs(espn);
assert.deepStrictEqual(ks.map((k) => k.gameId), ['nba|2026-10-23|DAL+IND', 'nba|2026-10-23|GSW+MEM', 'nba|2026-10-23|NOP+UTA'], '10 PM ET tip keeps the ET date');
const kr = createKickoffResolver(); kr.setKickoffs(ks);
assert.strictEqual(kr.kickoffFor(IND), Date.parse('2026-10-23T23:00Z')); assert.strictEqual(kr.resolve(SPR).source, 'espn');
assert.strictEqual(kr.kickoffFor('KXNBAGAME-26OCT23MEMGSW-GSW'), Date.parse('2026-10-24T02:00Z'));
assert.strictEqual(kr.kickoffFor('KXNBAGAME-26OCT23NOPUTA-UTA'), 0, 'in progress => started');
// a ticker dated one day early still finds its single game (college-style safety net)
assert.strictEqual(kr.kickoffFor('KXNBAGAME-26OCT22DALIND-IND'), Date.parse('2026-10-23T23:00Z'));
// Kalshi fallback = occurrence − 3h (NBA occurrence is tip + 3h)
const kr2 = createKickoffResolver(); kr2.setKalshiOccurrence(GSW, Date.parse('2026-10-27T05:00:00Z'));
assert.strictEqual(kr2.kickoffFor(GSW), Date.parse('2026-10-27T02:00:00Z'));
assert.strictEqual(B.espnNbaUrls(Date.parse('2026-10-23T19:00:00Z')).length, 2);
assert.ok(B.espnNbaUrls(Date.parse('2026-10-24T03:30:00Z'))[0].endsWith('dates=20261023'), 'ET date, not UTC');

// ── intake + alert ──
assert.strictEqual(createNflFrameFilter()(`{"legs":["${IND}"]}`), true, 'NBA off => dropped');
const drop = createNflFrameFilter([...NFL_NEEDLES, ...NBA_NEEDLES]);
assert.strictEqual(drop(Buffer.from(`{"legs":["${IND}"]}`)), false); assert.strictEqual(drop(`{"legs":["${TOT}"]}`), false);
assert.strictEqual(drop('{"legs":["KXNBAPTS-26OCT23DALIND-DALCFLAGG32-15"]}'), true, 'NBA props dropped before parse');
assert.deepStrictEqual(legParts(IND, 'yes'), { bet: 'Pacers to win', game: 'DAL @ IND', opp: 'DAL' });
assert.deepStrictEqual(legParts(SPR, 'no'), { bet: 'Pacers -8.5 — No (Mavericks +8.5)', game: 'DAL @ IND', opp: 'IND -8.5' });
assert.deepStrictEqual(legParts(TOT, 'yes').opp, 'Under 224.5');

// ── relay: NBA feeds (Polymarket US / Novig / ProphetX read-only) ──
const PL = require('../poly-us-lines'); const px = require('../prophetx-feed'); const R = require('../odds-relay');
assert.strictEqual(px.TOURNAMENTS.NBA, 132);
assert.ok(R.novigFeed.LEAGUES.includes('NBA'));
assert.strictEqual(R.pairKeyFromSlug('nba-dal-ind-2026-10-23'), 'dal|ind');
const ev = { slug: 'nba-dal-ind-2026-10-23', startTime: '2026-10-23T23:00:00Z', teams: [{ abbreviation: 'dal', name: 'Mavericks' }, { abbreviation: 'ind', name: 'Pacers' }], markets: [
  { slug: 'asc-nba-dal-ind-2026-10-23-pos-8pt5', sportsMarketType: 'basketball_team_full_game_spread', line: 8.5, bestBidQuote: { value: '0.48' }, bestAskQuote: { value: '0.50' }, marketSides: [{ long: true, team: { name: 'Mavericks', abbreviation: 'dal', ordering: 'away' } }, { long: false, team: { name: 'Pacers', abbreviation: 'ind', ordering: 'home' } }] },
  { slug: 'tsc-nba-dal-ind-2026-10-23-224pt5', sportsMarketType: 'basketball_team_full_game_total', line: 224.5, bestBidQuote: { value: '0.49' }, bestAskQuote: { value: '0.51' }, marketSides: [{ long: true }, { long: false }] },
  { slug: 'tsc-nba-dal-ind-2026-10-23-tt-ind-fg-113pt5', sportsMarketType: 'basketball_team_total_points', line: 113.5, marketSides: [{ long: true }, { long: false }] },
] };
const lm = PL.lineMarketsFromEvent(ev, 'NBA', 2);
assert.deepStrictEqual(lm.map((m) => m.betType).sort(), ['spread', 'total'], 'team totals are not full-game totals');
const us = R.usMarketsFromEvents([{ slug: 'nba-dal-ind-2026-10-23', startTime: new Date(Date.now() + 3600e3).toISOString(), markets: [{ slug: 'aec-nba-dal-ind-2026-10-23', sportsMarketType: 'basketball_team_full_game_winner', marketSides: [{ long: true, team: { name: 'Mavericks', ordering: 'away' } }, { long: false, team: { name: 'Pacers', ordering: 'home' } }] }] }], 'NBA', Date.now());
assert.strictEqual(us.length, 1, 'NBA winner markets now discovered');
console.log('sniper/nba.test.js ok');
