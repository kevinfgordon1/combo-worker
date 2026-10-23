'use strict';
const assert = require('assert');
const N = require('./ncaaf');
const { decide, classifyLegs, repriceFair } = require('./engine');
const { ALL_VENUES, legFairDepth } = require('./fair');
const { createKickoffResolver } = require('./kickoff');
const { createNflFrameFilter } = require('./intake');
const { createLockCoord } = require('./coord');
const { legLabel } = require('./fill-alert');
const { makerRateFromSeries, seriesOfTicker } = require('../series-fee');
const S = require('../auto-sniper');

const LIB = 'KXNCAAFGAME-26OCT22LIBKENN-LIB'; const KENN = 'KXNCAAFGAME-26OCT22LIBKENN-KENN';
const TXST = 'KXNCAAFGAME-26OCT24USUTXST-TXST';
const NFL = 'KXNFLGAME-26OCT25INDMIN-MIN';

// ── ticker parsing via the verified crosswalk (real Kalshi tickers, Oct 22 2026) ──
assert.deepStrictEqual(N.parseNcaafMl(`${LIB}:yes`), { ticker: LIB, date: '2026-10-22', codes: ['LIB', 'KENN'], selection: 'LIB', gameId: 'ncaaf|2026-10-22|KENN+LIB' });
assert.strictEqual(N.parseNcaafMl('KXNCAAFGAME-26OCT31UNACARK-UNA'), null, 'team not in crosswalk => unmapped');
assert.strictEqual(N.parseNcaafMl('KXNCAAFSPREAD-26OCT22LIBKENN-LIB7'), null, 'spreads are not ML');
assert.deepStrictEqual(N.classifyNcaafLeg(`${LIB}:no`).team, 'KENN', 'No on LIB = KENN wins');
assert.strictEqual(N.codeForPoly('librty'), 'LIB'); assert.strictEqual(N.codeForPoly('kenest'), 'KENN');
assert.strictEqual(N.codeForName('Kennesaw State'), 'KENN'); assert.strictEqual(N.codeForName('Miami Ohio'), 'MOH'); assert.strictEqual(N.codeForName('Miami Florida'), 'MIA');

// ── book: inverse-bet fair, best opposite price across Kalshi / Polymarket US / Novig ──
let t = Date.parse('2026-10-22T20:00:00Z');
const book = N.createNcaafBook({ now: () => t, staleMs: 15000, depthUsd: 1000 });
// Kalshi orderbook_fp lists BIDS: KENN yes bids at 0.20 => LIB No... LIB yes ask = 1 - KENN-ticker no bid.
book.ingestKalshiOrderbooks([
  { ticker: LIB, orderbook_fp: { yes_dollars: [['0.76', '5000']], no_dollars: [['0.22', '5000']] } },
  { ticker: KENN, orderbook_fp: { yes_dollars: [['0.21', '5000']], no_dollars: [['0.77', '5000']] } },
]);
// Kalshi cost to buy "LIB loses": Yes on KENN ask 0.23 or No on LIB ask 0.24 (+ fee)
let f = book.legFair('ncaaf|2026-10-22|KENN+LIB', 'LIB');
assert.ok(f.p > 0.74 && f.p < 0.77, JSON.stringify(f)); assert.ok(/^kalshi/.test(f.best));
// Polymarket US: identity from the slug, depth ladder; cheaper KENN ask => becomes best
book.ingestRelay('polymarket', [{ bet_type: 'moneyline', feed: 'polymarket-us', side: 'Kennesaw State', odds: 0.2, token_id: 'us:aec-cfb-librty-kenest-2026-10-22:no', start: '2026-10-22T23:00:00Z', updated_at: new Date(t).toISOString(), depth: [{ odds: 0.2, size: 100000 }] }]);
f = book.legFair('ncaaf|2026-10-22|KENN+LIB', 'LIB');
assert.strictEqual(f.best, 'polymarket'); assert.ok(Math.abs(f.p - (1 - (0.2 + 0.0695 * 0.2 * 0.8))) < 1e-9);
// a Polymarket quote whose name disagrees with its slug is ignored
assert.strictEqual(book.ingestRelay('polymarket', [{ bet_type: 'moneyline', feed: 'polymarket-us', side: 'Liberty', odds: 0.1, token_id: 'us:aec-cfb-librty-kenest-2026-10-22:no', start: '2026-10-22T23:00:00Z', updated_at: new Date(t).toISOString(), depth: [{ odds: 0.1, size: 1e6 }] }]), 0);
// Novig: names mapped through the crosswalk; top-of-book only never counts
book.ingestRelay('novig', [{ bet_type: 'moneyline', away: 'Liberty', home: 'Kennesaw State', side: 'Kennesaw State', odds: 0.15, start: '2026-10-22T23:00:00Z', updated_at: new Date(t).toISOString() }], { feedLive: true, polledAt: t });
assert.strictEqual(legFairDepth({ kind: 'ncaaf', gameId: 'ncaaf|2026-10-22|KENN+LIB', team: 'LIB' }, { ncaafBook: book, venues: ALL_VENUES }).venue, 'polymarket', 'top-only Novig ignored by bestCost');
// stale after 15s
t += 16000; assert.strictEqual(book.legFair('ncaaf|2026-10-22|KENN+LIB', 'LIB').p, null);

// ── classify: NFL-only path unchanged; mixed + NCAAF-only; correlation; off switch ──
assert.strictEqual(classifyLegs({ legKeys: [`${NFL}:yes`, 'KXNFLGAME-26OCT25CINBAL-BAL:yes'] }, { td: false, ncaaf: true }).legs.length, 2);
const mixed = classifyLegs({ legKeys: [`${LIB}:yes`, `${NFL}:yes`, `${TXST}:no`] }, { td: false, ncaaf: true });
assert.ok(mixed.ok); assert.deepStrictEqual(mixed.legs.map((l) => l.kind || 'ml'), ['ncaaf', 'ml', 'ncaaf']);
assert.strictEqual(mixed.legs[1].gameId, 'nfl|2026-10-25|ind+min'); assert.strictEqual(mixed.legs[2].team, 'USU');
assert.strictEqual(classifyLegs({ legKeys: [`${LIB}:yes`, `${KENN}:no`] }, { ncaaf: true }).reason, 'correlated_same_game');
assert.strictEqual(classifyLegs({ legKeys: [`${LIB}:yes`, 'KXNCAAFGAME-26OCT31UNACARK-UNA:yes'] }, { ncaaf: true }).reason, 'ncaaf_unmapped');
assert.strictEqual(classifyLegs({ legKeys: [`${LIB}:yes`, 'KXNBAGAME-26OCT25LALBOS-LAL:yes'] }, { ncaaf: true }).reason, 'nba_off'); // NBA needs SNIPER_NBA=1 (sniper/nba.test.js)
assert.strictEqual(classifyLegs({ legKeys: [`${LIB}:yes`, `${NFL}:yes`] }, { ncaaf: false }).reason, 'ncaaf_off');
assert.strictEqual(classifyLegs({ legKeys: [`${LIB}:yes`, 'KXNCAAFSPREAD-26OCT22LIBKENN-LIB7:yes'] }, { ncaaf: true }).reason, 'lines_off');

// ── decide: 5% NCAAF minimum (SNIPER_MIN_ROI_NCAAF), NFL stays 3%, same caps ──
const src = (venue, cost) => ({ venue, cost, reason: 'ok', used: true, availUsd: 5000 });
const pmLive = { legFair: () => ({ sources: [src('kalshi', 0.45)] }) };
const ncaafBook = { legFair: () => ({ sources: [src('polymarket', 0.3)] }) };
const ctx = (env = {}) => ({ config: S.sniperConfig({ SNIPER_ENABLED: '1', ...env }), ledger: S.createSniperLedger(), pmLive, tdBook: null, ncaafBook, venues: ALL_VENUES, kickoffFor: () => Date.parse('2026-10-25T17:00:00Z'), makerRate: 0.035, nowMs: Date.parse('2026-10-21T05:00:00Z') });
const rq = { rfqId: 'n1', marketTicker: 'KXMVECROSSCATEGORY-X', legKeys: [`${LIB}:yes`, `${NFL}:yes`], contracts: 20 };
assert.strictEqual(S.sniperConfig({}).minRoiNcaaf, 0.05);
assert.strictEqual(S.sniperConfig({ SNIPER_MIN_ROI_NCAAF: '0.07' }).minRoiNcaaf, 0.07);
const q = decide(rq, ctx()).decision;
assert.strictEqual(q.action, 'quote', JSON.stringify(q));
assert.strictEqual(q.minRoi, 0.05); assert.strictEqual(q.hasNcaaf, true); assert.ok(q.roi >= 0.05 - 1e-9);
assert.ok(Math.abs(q.fairYes - 0.7 * 0.55) < 1e-9);
assert.strictEqual(q.legDetail[0].venue, 'polymarket');
const hi = decide({ ...rq, rfqId: 'n2' }, ctx({ SNIPER_MIN_ROI_NCAAF: '1000' })).decision;
assert.strictEqual(hi.reason, 'roi_below_min_ncaaf');
// NFL-only RFQ ignores the NCAAF minimum
const nflOnly = decide({ ...rq, rfqId: 'n3', legKeys: [`${NFL}:yes`, 'KXNFLGAME-26OCT25CINBAL-BAL:yes'] }, ctx({ SNIPER_MIN_ROI_NCAAF: '1000' })).decision;
assert.strictEqual(nflOnly.action, 'quote'); assert.strictEqual(nflOnly.minRoi, 0.03); assert.strictEqual(nflOnly.hasNcaaf, false);
// kill switch
assert.strictEqual(decide({ ...rq, rfqId: 'n4' }, ctx({ SNIPER_NCAAF: '0' })).decision.reason, 'scope_ncaaf_off');
// missing NCAAF price => skip (never guessed)
assert.strictEqual(decide({ ...rq, rfqId: 'n5' }, { ...ctx(), ncaafBook: { legFair: () => null } }).decision.action, 'skip');
// same max-risk-per-quote cap ($100) applies
assert.ok(q.risk <= 100 + 1e-9);
// reprice for send/confirm uses the same books
assert.ok(Math.abs(repriceFair(rq, { pmLive, tdBook: null, venues: ALL_VENUES, ncaafBook }) - 0.7 * 0.55) < 1e-9);

// ── kickoffs: ESPN college-football scoreboard (real, trimmed) ──
const espn = require('./fixtures-espn-cfb-2026-10-22.json');
const ks = N.espnNcaafKickoffs(espn);
assert.ok(ks.some((k) => k.gameId === 'ncaaf|2026-10-22|KENN+LIB' && k.kickoffMs === Date.parse('2026-10-22T23:00:00Z')));
const K = createKickoffResolver();
K.setKalshiOccurrence(LIB, Date.parse('2026-10-23T02:00:00Z'));
K.setKickoffs(ks);
assert.strictEqual(K.resolve(LIB).source, 'espn'); assert.strictEqual(K.kickoffFor(`${KENN}`), Date.parse('2026-10-22T23:00:00Z'));
const live = JSON.parse(JSON.stringify(espn)); live.events.forEach((e) => { e.status.type.state = 'in'; });
K.setKickoffs(N.espnNcaafKickoffs(live)); assert.strictEqual(K.kickoffFor(LIB), 0, 'in progress => started');
assert.strictEqual(N.oddsNcaafKickoffs([{ commence_time: '2026-10-24T23:30:00Z', home_team: 'Texas State', away_team: 'Utah State' }])[0].gameId, 'ncaaf|2026-10-24|TXST+USU');

// ── intake: NCAAF frames are no longer dropped before parse ──
assert.strictEqual(createNflFrameFilter()(Buffer.from(`{"mve_selected_legs":[{"market_ticker":"${LIB}"}]}`)), false);
assert.strictEqual(createNflFrameFilter()(Buffer.from('{"mve_selected_legs":[{"market_ticker":"KXNBAGAME-X"}]}')), true);

// ── Combo Locks overlap skip still works for NCAAF legs ──
const coord = createLockCoord({ supabase: null });
coord.setLocks([{ id: 'L1', leg_keys: [`${LIB}:yes`, 'KXNFLGAME-26OCT25NYGPHI-NYG:yes'] }]);
assert.strictEqual(coord.blockReason({ rfqId: 'x', legKeys: [`${LIB}:yes`, `${NFL}:yes`] }), 'overlaps_combo_lock');
coord.setLocks([{ id: 'L2', leg_keys: [`${TXST}:yes`, 'KXNFLGAME-26OCT25NYGPHI-NYG:yes'] }]);
assert.strictEqual(coord.blockReason({ rfqId: 'y', legKeys: [`${LIB}:yes`, `${NFL}:yes`] }), null);

// ── Kalshi maker fee: read per RFQ from the combo's own MVE series (GET /series) ──
assert.strictEqual(seriesOfTicker('KXMVECROSSCATEGORY-S2026ABC-DEF'), 'KXMVECROSSCATEGORY');
assert.strictEqual(makerRateFromSeries('quadratic_with_combo_maker_fees', 1), 0.035);
assert.strictEqual(makerRateFromSeries('quadratic', 1), 0);
assert.strictEqual(makerRateFromSeries(undefined), 0.035, 'unknown => conservative 0.035');

// ── fill alert label ──
assert.strictEqual(legLabel(LIB, 'yes'), 'Liberty to win · Liberty @ Kennesaw St.');
assert.strictEqual(legLabel(LIB, 'no'), 'Liberty to win (No) · Liberty @ Kennesaw St.');
// ── FBS only: any leg with an FCS team is skipped (explicit ESPN FBS list) ──
const FCS = 'KXNCAAFGAME-26OCT31GRAMTXSO-TXSO'; // Grambling vs Texas Southern (both FCS, both in crosswalk)
assert.ok(N.parseNcaafMl(FCS), 'FCS ticker parses through the crosswalk');
assert.strictEqual(N.isFbsGame(FCS), false); assert.strictEqual(N.isFbsGame(LIB), true);
assert.strictEqual(N.classifyNcaafLeg(`${FCS}:yes`).reason, 'ncaaf_fcs');
assert.strictEqual(classifyLegs({ legKeys: [`${LIB}:yes`, `${FCS}:no`] }, { ncaaf: true }).reason, 'ncaaf_fcs');
assert.strictEqual(decide({ ...rq, rfqId: 'f1', legKeys: [`${NFL}:yes`, `${FCS}:yes`] }, ctx()).decision.reason, 'scope_ncaaf_fcs');
assert.ok(N.isFbs('LIB') && N.isFbs('MIA') && N.isFbs('KENN') && N.isFbs('SAC') && !N.isFbs('GRAM') && !N.isFbs('TXSO') && !N.isFbs('NICH'));
assert.ok(N.FBS_COUNT >= 134 && N.FBS_COUNT <= 140, `FBS list size ${N.FBS_COUNT}`);
// a hypothetical FBS-vs-FCS game is also skipped (one team off the list)
assert.strictEqual(['LIB', 'GRAM'].every(N.isFbs), false);
console.log('sniper/ncaaf.test.js ok');

// ProphetX via relay (NCAAF): commission folded via pxEffective, size = stake $, unmatched teams skipped.
{
  const { pxEffective } = require('../noboost/pm-live');
  const before = book.legFair ? null : null;
  const unmatched = book.ingestRelay('prophetx', [{ bet_type: 'moneyline', away: 'Nowhere Tech', home: 'Kennesaw State', side: 'Kennesaw State', odds: 0.1, size: 1e5, start: '2026-10-22T23:00:00Z', updated_at: new Date().toISOString() }], { feedLive: true, polledAt: Date.now() });
  assert.strictEqual(unmatched, 0, 'unmatched ProphetX NCAAF team must be skipped');
  const n = book.ingestRelay('prophetx', [{ bet_type: 'moneyline', away: 'Liberty', home: 'Kennesaw State', side: 'Kennesaw State', odds: 0.05, size: 5000, start: '2026-10-22T23:00:00Z', updated_at: new Date().toISOString(), depth: [{ odds: 0.05, size: 5000 }] }], { feedLive: true, polledAt: Date.now() });
  assert.strictEqual(n, 1);
  const lv = [...book._asks.values()].map((o) => o.prophetx).filter(Boolean)[0];
  assert.ok(lv && Math.abs(lv.levels[0][0] - pxEffective(0.05)) < 1e-12 && Math.abs(lv.levels[0][1] - 100000) < 1e-6, 'px level = pxEffective(odds), contracts = stake/odds');
  console.log('ncaaf prophetx relay ok');
}
