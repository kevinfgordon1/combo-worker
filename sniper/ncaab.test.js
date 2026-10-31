'use strict';
// Men's college basketball (NCAAB) moneylines on the Combo Sniper (Kevin Oct 30 2026): switch OFF by
// default, D1 vs D1 only (crosswalk), moneylines only, NCAAB-only 7% minimum, 24h tip horizon (max 36h).
const assert = require('assert');
const C = require('./ncaab');
const X = require('../ncaab-crosswalk');
const { decide, classifyLegs, settleAtMs, ncaabHorizonCheck, repriceFair } = require('./engine');
const { ALL_VENUES, legFairDepth } = require('./fair');
const { createKickoffResolver, gameIdOfTicker } = require('./kickoff');
const { createSniperFrameFilter, sniperNeedles } = require('./intake');
const { legParts } = require('./fill-alert');
const S = require('../auto-sniper');

// Real Kalshi tickers (Oct 30 2026). ND-VILL tips 2026-11-01 14:30Z (ESPN); occurrence = tip + 3h.
const VILL = 'KXNCAAMBGAME-26NOV01NDVILL-VILL'; const ND = 'KXNCAAMBGAME-26NOV01NDVILL-ND';
const FISK = 'KXNCAAMBGAME-26NOV02FISKBEL-BEL'; // D1 (Belmont) vs non-D1 (Fisk)
const SPR = 'KXNCAAMBSPREAD-26NOV01NDVILL-VILL5'; const TOT = 'KXNCAAMBTOTAL-26NOV01NDVILL-145';
const NFL = 'KXNFLGAME-26NOV01BUFKC-BUF';
const GID = 'ncaab|2026-11-01|ND+VILL';

// ── crosswalk: D1 only, verified, both venues ──
assert.ok(X.teamCount >= 250, `crosswalk teams ${X.teamCount}`);
assert.strictEqual(X.teamByCode('VILL').espnId, '222'); assert.strictEqual(X.teamByCode('ND').espnId, '87');
assert.strictEqual(X.codeForPoly('vill'), 'VILL'); assert.strictEqual(X.codeForPoly('nd'), 'ND');
assert.strictEqual(X.codeForName('Villanova Wildcats'), 'VILL'); assert.strictEqual(X.codeForName('Fisk'), null);
// Kalshi OAK = Oakland AND Oakwood (non-D1): resolved with opponent + date context (canonical table), not dropped
assert.ok(X.isAmbiguousCode('OAK'), 'OAK is ambiguous');
require('../ncaab-teams').setSchedule([{ homeId: '130', awayId: '2473', date: '2026-11-02T23:00Z' }, { homeId: '2010', awayId: '99999', date: '2026-11-02T23:00Z' }]);
assert.strictEqual(X.splitBlob('OAKMICH'), null, 'ambiguous code without a date => fail closed');
assert.deepStrictEqual(X.splitBlob('OAKMICH', { date: '2026-11-02' }), { codes: ['OAK', 'MICH'] }, 'Oakland @ Michigan (learned Kalshi game)');
assert.strictEqual(X.splitBlob('OAKAAMU', { date: '2026-11-02' }), null, 'Oakwood (non-D1) vs Alabama A&M stays out');
assert.deepStrictEqual(X.splitBlob('NDVILL').codes, ['ND', 'VILL']);
const xw = require('../ncaab-crosswalk.json');
assert.ok(xw.nonD1.includes('Fisk') && Object.values(xw.teams).every((t) => t.espnId), 'non-D1 schools never in the table');

// ── parsing ──
assert.deepStrictEqual(C.parseNcaabMl(`${VILL}:yes`), { ticker: VILL, date: '2026-11-01', codes: ['ND', 'VILL'], selection: 'VILL', gameId: GID });
assert.strictEqual(C.parseNcaabMl(FISK), null, 'D1 vs non-D1 => never parsed');
assert.strictEqual(C.isD1Game(VILL), true); assert.strictEqual(C.isD1Game(FISK), false);
assert.strictEqual(C.classifyNcaabLeg(`${VILL}:no`).team, 'ND', 'No on VILL = ND wins');
assert.strictEqual(C.classifyNcaabLeg(`${FISK}:yes`).reason, 'ncaab_unmapped');
assert.strictEqual(C.classifyNcaabLeg(`${SPR}:yes`).reason, 'ncaab_lines_off');
assert.strictEqual(C.isNcaabAny(TOT), true); assert.strictEqual(C.isNcaabTicker(TOT), false);
// every captured Kalshi D1-vs-D1 event parses; every non-D1 one does not
const cap = require('../fixtures-ncaab-captures.json');
let d1 = 0; let non = 0;
for (const e of cap.kalshi) for (const m of e.markets) { if (C.parseNcaabMl(m.ticker)) d1 += 1; else non += 1; }
assert.ok(d1 >= 270 && non >= 20, `d1=${d1} non=${non}`);

// ── book: inverse-bet fair, each venue's own fee, real depth, 15s staleness ──
let t = Date.parse('2026-11-01T12:00:00Z');
const book = C.createNcaabBook({ now: () => t, staleMs: 15000, depthUsd: 1000 });
book.ingestKalshiOrderbooks([
  { ticker: VILL, orderbook_fp: { yes_dollars: [['0.55', '50000']], no_dollars: [['0.43', '50000']] } },
  { ticker: ND, orderbook_fp: { yes_dollars: [['0.43', '50000']], no_dollars: [['0.55', '50000']] } },
  { ticker: FISK, orderbook_fp: { yes_dollars: [['0.97', '50000']], no_dollars: [['0.02', '50000']] } },
]);
assert.strictEqual(book.gameCount(), 1, 'non-D1 game never booked');
let f = book.legFair(GID, 'VILL'); assert.ok(f.p > 0.52 && f.p < 0.57, JSON.stringify(f)); assert.ok(/^kalshi/.test(f.best));
// Polymarket US: identity from the cbb slug (aec-cbb-vill-nd :yes = VILL, the first slug team)
const at = new Date(t).toISOString();
assert.strictEqual(book.ingestRelay('polymarket', [{ bet_type: 'moneyline', feed: 'polymarket-us', side: 'Notre Dame', odds: 0.40, token_id: 'us:aec-cbb-vill-nd-2026-11-01:no', start: '2026-11-01T14:30:00Z', updated_at: at, depth: [{ odds: 0.40, size: 100000 }] }]), 1);
f = book.legFair(GID, 'VILL'); assert.strictEqual(f.best, 'polymarket'); assert.ok(Math.abs(f.p - (1 - (0.40 + 0.0695 * 0.40 * 0.60))) < 1e-9, String(f.p));
// slug / name disagreement => ignored
assert.strictEqual(book.ingestRelay('polymarket', [{ bet_type: 'moneyline', feed: 'polymarket-us', side: 'Villanova', odds: 0.1, token_id: 'us:aec-cbb-vill-nd-2026-11-01:no', start: '2026-11-01T14:30:00Z', updated_at: at, depth: [{ odds: 0.1, size: 1e6 }] }]), 0);
// Novig (ESPN-style names, no pregame fee)
book.ingestRelay('novig', [{ bet_type: 'moneyline', away: 'Villanova', home: 'Notre Dame', side: 'Notre Dame', odds: 0.38, depth: [{ odds: 0.38, size: 100000 }], start: '2026-11-01T14:30:00Z', updated_at: at }], { feedLive: true, polledAt: t });
f = book.legFair(GID, 'VILL'); assert.strictEqual(f.best, 'novig'); assert.ok(Math.abs(f.p - 0.62) < 1e-9);
// spreads / totals quotes are never ingested (moneylines only)
assert.strictEqual(book.ingestRelay('novig', [{ bet_type: 'spread', line: 4.5, away: 'Villanova', home: 'Notre Dame', side: 'Notre Dame', odds: 0.3, start: '2026-11-01T14:30:00Z', updated_at: at }], { feedLive: true, polledAt: t }), 0);
assert.ok(/^novig/.test(legFairDepth({ kind: 'ncaab', gameId: GID, team: 'VILL' }, { ncaabBook: book, venues: ALL_VENUES }).best));
assert.strictEqual(legFairDepth({ kind: 'ncaab', gameId: GID, team: 'VILL' }, { venues: ALL_VENUES }).reason, 'no_ncaab_book');
t += 16000; assert.strictEqual(book.legFair(GID, 'VILL').p, null, 'stale after 15s');

// ── classify: off by default; moneylines only; same game blocked ──
assert.strictEqual(classifyLegs({ legKeys: [`${VILL}:yes`, `${NFL}:yes`] }, { ncaaf: true }).reason, 'ncaab_off');
const c = classifyLegs({ legKeys: [`${VILL}:yes`, `${NFL}:yes`] }, { ncaaf: true, ncaab: true });
assert.ok(c.ok, JSON.stringify(c)); assert.deepStrictEqual(c.legs.map((l) => l.kind || 'ml'), ['ncaab', 'ml']);
assert.strictEqual(classifyLegs({ legKeys: [`${VILL}:yes`, `${SPR}:no`] }, { ncaab: true, lines: true }).reason, 'ncaab_lines_off');
assert.strictEqual(classifyLegs({ legKeys: [`${TOT}:yes`, `${NFL}:yes`] }, { ncaab: true, lines: true }).reason, 'ncaab_lines_off');
assert.strictEqual(classifyLegs({ legKeys: [`${VILL}:yes`, `${ND}:no`] }, { ncaab: true }).reason, 'correlated_same_game');
assert.strictEqual(classifyLegs({ legKeys: [`${FISK}:yes`, `${NFL}:yes`] }, { ncaab: true }).reason, 'ncaab_unmapped');

// ── config: OFF by default, 7% NCAAB-only minimum, 24h horizon capped at 36h; other minimums untouched ──
const base = S.sniperConfig({});
assert.strictEqual(base.ncaab, false); assert.strictEqual(base.minRoiNcaab, 0.07);
assert.strictEqual(base.ncaabHours, 24); assert.strictEqual(S.sniperConfig({ SNIPER_NCAAB_HOURS: '72' }).ncaabHours, 36);
assert.strictEqual(base.ncaabGameHours, 3);
assert.strictEqual(base.minRoi, 0.04); assert.strictEqual(base.minRoiNcaaf, 0.06); assert.strictEqual(base.minRoiNba, 0.06); assert.strictEqual(base.minRoiTd, 0.07);

// ── decide ──
const src = (venue, cost) => ({ venue, cost, reason: 'ok', used: true, availUsd: 5000 });
const pmLive = { legFair: () => ({ sources: [src('kalshi', 0.45)] }) };
const ncaabBook = { legFair: () => ({ sources: [src('novig', 0.3)] }) };
const tip = Date.parse('2026-11-01T14:30:00Z'); const nflKo = Date.parse('2026-11-01T18:00:00Z');
const kickoffFor = (tk) => (/^KXNCAAMB/.test(tk) ? tip : nflKo);
const ctx = (env = {}, extra = {}) => ({ config: S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_NCAAB: '1', ...env }), ledger: S.createSniperLedger(), pmLive, tdBook: null, ncaabBook, venues: ALL_VENUES, kickoffFor, makerRate: 0.035, nowMs: Date.parse('2026-11-01T06:00:00Z'), ...extra });
const rq = { rfqId: 'c1', marketTicker: 'KXMVECROSSCATEGORY-X', legKeys: [`${VILL}:yes`, `${NFL}:yes`], contracts: 20 };
const d = decide(rq, ctx()).decision;
assert.strictEqual(d.action, 'quote', JSON.stringify(d)); assert.strictEqual(d.minRoi, 0.07); assert.strictEqual(d.hasNcaab, true);
assert.ok(Math.abs(d.fairYes - 0.7 * 0.55) < 1e-9); assert.strictEqual(d.legDetail[0].venue, 'novig');
assert.strictEqual(decide({ ...rq, rfqId: 'c2' }, ctx({ SNIPER_NCAAB: '0' })).decision.reason, 'scope_ncaab_off', 'switch off');
assert.strictEqual(decide({ ...rq, rfqId: 'c3' }, ctx({}, { ncaabBook: null })).decision.reason, 'scope_ncaab_off', 'no book => off');
assert.strictEqual(decide({ ...rq, rfqId: 'c4' }, ctx({ SNIPER_MIN_ROI_NCAAB: '1000' })).decision.reason, 'roi_below_min_ncaab');
// NFL-only parlays keep their own minimum (NCAAB rule never applies)
const nflOnly = decide({ ...rq, rfqId: 'c5', legKeys: [`${NFL}:yes`, 'KXNFLGAME-26NOV01DALPHI-PHI:yes'] }, ctx()).decision;
assert.notStrictEqual(nflOnly.minRoi, 0.07);
// higher rules still win
assert.strictEqual(decide({ ...rq, rfqId: 'c6' }, ctx({ SNIPER_MIN_ROI: '0.09' })).decision.minRoi, 0.09);
// horizon: a leg tipping 30h out is skipped at the 24h default, quoted at 36h, never beyond 36h
const nowMs = Date.parse('2026-11-01T06:00:00Z'); const far = (tk) => (/^KXNCAAMB/.test(tk) ? nowMs + 30 * 3600e3 : nflKo);
assert.strictEqual(decide({ ...rq, rfqId: 'c7' }, ctx({}, { kickoffFor: far })).decision.reason, 'ncaab_beyond_horizon');
assert.strictEqual(decide({ ...rq, rfqId: 'c8' }, ctx({ SNIPER_NCAAB_HOURS: '36' }, { kickoffFor: far })).decision.action, 'quote');
const far40 = (tk) => (/^KXNCAAMB/.test(tk) ? nowMs + 40 * 3600e3 : nflKo);
assert.strictEqual(decide({ ...rq, rfqId: 'c9' }, ctx({ SNIPER_NCAAB_HOURS: '72' }, { kickoffFor: far40 })).decision.reason, 'ncaab_beyond_horizon', '36h hard cap');
assert.strictEqual(ncaabHorizonCheck([`${NFL}:yes`], () => nowMs + 100 * 3600e3, nowMs, 24), null, 'NFL legs not affected');
assert.strictEqual(decide({ ...rq, rfqId: 'c10' }, ctx({}, { kickoffFor: (tk) => (/^KXNCAAMB/.test(tk) ? null : nflKo) })).decision.reason, 'no_kickoff');
// caps: $500 per quote / $1,000 per leg come from the normal sniper caps (unchanged)
const capped = decide({ ...rq, rfqId: 'c11', contracts: 100000 }, ctx({ SNIPER_MAX_RISK: '500', SNIPER_MAX_PAYOUT: '100000', SNIPER_PER_LEG_CAP: '1000' })).decision;
assert.ok(capped.action === 'skip' || capped.risk <= 500 + 1e-9, JSON.stringify(capped));
// settle: last tip + 3h for college basketball legs
assert.strictEqual(settleAtMs([`${VILL}:yes`, `${ND}:no`], kickoffFor, 4, 3, 3), tip + 3 * 3600e3);
assert.ok(Math.abs(repriceFair(rq, { pmLive, tdBook: null, venues: ALL_VENUES, ncaabBook }) - 0.7 * 0.55) < 1e-9);

// ── kickoffs: ESPN D1 scoreboard by ESPN team id ──
assert.strictEqual(gameIdOfTicker(VILL), GID); assert.strictEqual(gameIdOfTicker(FISK), null);
const espn = { events: [
  { date: '2026-11-01T14:30Z', competitions: [{ date: '2026-11-01T14:30Z', competitors: [{ id: '87', team: { id: '87', abbreviation: 'ND' } }, { id: '222', team: { id: '222', abbreviation: 'VILL' } }] }], status: { type: { state: 'pre' } } },
  { date: '2026-11-02T00:00Z', competitions: [{ date: '2026-11-02T00:00Z', competitors: [{ team: { id: '999999', abbreviation: 'FISK' } }, { team: { id: '2057', abbreviation: 'BEL' } }] }], status: { type: { state: 'pre' } } },
] };
const ks = C.espnNcaabKickoffs(espn);
assert.deepStrictEqual(ks.map((k) => k.gameId), [GID], 'non-D1 game has no kickoff entry');
const kr = createKickoffResolver(); kr.setKickoffs(ks);
assert.strictEqual(kr.kickoffFor(VILL), tip);
const kr2 = createKickoffResolver(); kr2.setKalshiOccurrence(VILL, tip + 3 * 3600e3);
assert.strictEqual(kr2.kickoffFor(VILL), tip, 'Kalshi fallback = occurrence − 3h');
assert.ok(C.espnNcaabUrls(Date.parse('2026-11-02T03:30:00Z'))[0].endsWith('groups=50&limit=500&dates=20261101'), 'ET date, D1 board');

// ── intake: moneyline needle only, and only when on ──
assert.ok(!sniperNeedles({}).some((n) => n.toString().startsWith('KXNCAAMB')), 'off => no NCAAB needle');
const on = createSniperFrameFilter({ ncaab: true });
assert.strictEqual(on(`{"selected_legs":[{"market_ticker":"${VILL}"},{"market_ticker":"${NFL}"}]}`), false, 'ML kept');
assert.strictEqual(on(`{"selected_legs":[{"market_ticker":"${SPR}"},{"market_ticker":"${NFL}"}]}`), true, 'spread leg => dropped before parse');
assert.strictEqual(createSniperFrameFilter({})(`{"selected_legs":[{"market_ticker":"${VILL}"},{"market_ticker":"${NFL}"}]}`), true, 'off => dropped');

// ── fill alert ──
assert.deepStrictEqual(legParts(VILL, 'yes'), { bet: 'Villanova to win', game: 'Notre Dame vs Villanova', opp: 'Notre Dame' });
assert.deepStrictEqual(legParts(VILL, 'no').bet, 'Villanova to win (No)');
console.log('sniper/ncaab.test.js ok');
