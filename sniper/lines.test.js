'use strict';
const assert = require('assert');
const L = require('./lines');
const { decide, classifyLegs } = require('./engine');
const { legFairDepth, ALL_VENUES } = require('./fair');
const { gameIdOfTicker } = require('./kickoff');
const { createNflFrameFilter } = require('./intake');

const SP = 'KXNFLSPREAD-26OCT29CARGB-GB8'; // GB −7.5
const TO = 'KXNFLTOTAL-26OCT29CARGB-45';  // Over 44.5
const ML = 'KXNFLGAME-26OCT25CINBAL-BAL';
// parse
assert.deepStrictEqual([L.parseLineTicker(SP).yesKey, L.parseLineTicker(SP).noKey], ['spread:gb:-7.5', 'spread:car:+7.5']);
assert.deepStrictEqual([L.parseLineTicker(TO).yesKey, L.parseLineTicker(TO).noKey], ['total:over:44.5', 'total:under:44.5']);
assert.strictEqual(L.parseLineTicker(SP).gameId, 'nfl|2026-10-29|car+gb', 'same gameId as the ML ticker');
assert.strictEqual(gameIdOfTicker(SP), 'nfl|2026-10-29|car+gb');
assert.strictEqual(L.classifyLineLeg('KXNCAAFSPREAD-26OCT24UTRGVCARK-UTRGV8:yes').reason, 'ncaaf_fcs');
assert.strictEqual(createNflFrameFilter()(Buffer.from(`{"x":"${SP}"}`)), false, 'spread frames not dropped');

let t = 1e12; const now = () => t;
const book = L.createLinesBook({ now, depthUsd: 2000 });
book.addGamesFromTickers([SP, TO]);
const upd = new Date(t).toISOString();
const q = (o) => ({ league: 'NFL', away: 'Carolina Panthers', home: 'Green Bay Packers', start: '2026-10-29T17:00:00Z', updated_at: upd, is_alt: false, ...o });
// Novig: main spread GB −7.5 / CAR +7.5, main total 44.5
book.ingestRelay('novig', 'nfl', [
  q({ bet_type: 'spread', side: 'Green Bay Packers', line: -7.5, odds: 0.5, depth: [{ odds: 0.5, size: 10000 }] }),
  q({ bet_type: 'spread', side: 'Carolina Panthers', line: 7.5, odds: 0.52, depth: [{ odds: 0.52, size: 10000 }] }),
  q({ bet_type: 'spread', side: 'Carolina Panthers', line: 10.5, odds: 0.3, is_alt: true, depth: [{ odds: 0.3, size: 10000 }] }),
  q({ bet_type: 'total', side: 'Over', side_type: 'Over', line: 44.5, odds: 0.5, depth: [{ odds: 0.5, size: 10000 }] }),
  q({ bet_type: 'total', side: 'Under', side_type: 'Under', line: 44.5, odds: 0.51, depth: [{ odds: 0.51, size: 1500 }] }), // < $2,000
]);
// ProphetX quotes the total on a different number: must be ignored for 44.5 (exact line)
book.ingestRelay('prophetx', 'nfl', [q({ bet_type: 'total', side: 'Under', side_type: 'Under', line: 45.5, odds: 0.4, depth: [{ odds: 0.4, size: 10000 }] })], { feedLive: true, polledAt: t });
assert.deepStrictEqual(book.mainTickers([SP, TO, 'KXNFLSPREAD-26OCT29CARGB-GB11', 'KXNFLSPREAD-26OCT29CARGB-CAR8']), [SP, TO], 'main-line strikes only');
// Kalshi GB −7.5 book: no-bids at 0.45 => Yes ask 0.55; yes-bids 0.40 => No ask 0.60
book.ingestKalshiOrderbooks([{ ticker: SP, orderbook_fp: { no_dollars: [[0.45, 10000]], yes_dollars: [[0.40, 10000]] } }]);

const gbLeg = L.classifyLineLeg(`${SP}:yes`);
const f = book.legFair(gbLeg); // opposite = CAR +7.5: Novig 0.52 (no fee) vs Kalshi No 0.60+fee
assert.strictEqual(f.best, 'novig'); assert.ok(Math.abs(f.p - 0.48) < 1e-9);
const carLeg = L.classifyLineLeg(`${SP}:no`); // CAR +7.5, opposite GB −7.5: Novig 0.50 vs Kalshi 0.55+fee
assert.ok(Math.abs(book.legFair(carLeg).p - 0.5) < 1e-9);
// Over 44.5: opposite Under 44.5 only $1,500 on Novig, PX on 45.5 ignored => no fair
assert.strictEqual(book.legFair(L.classifyLineLeg(`${TO}:yes`)).reason, 'no_venue_depth');
// Alt line => not main => skip
assert.strictEqual(book.legFair(L.classifyLineLeg('KXNFLSPREAD-26OCT29CARGB-CAR11:no')).reason, 'not_main_line');
// stale => skip
t += 20000; assert.strictEqual(book.legFair(gbLeg).p, null); t -= 20000;
assert.strictEqual(legFairDepth(gbLeg, { linesBook: book, venues: ALL_VENUES }).venue, 'novig');

// classify: lines off => skip; same-game ML + spread => correlated
assert.strictEqual(classifyLegs({ legKeys: [`${SP}:yes`, `${ML}:yes`] }, { td: false, ncaaf: true }).reason, 'lines_off');
assert.strictEqual(classifyLegs({ legKeys: [`${SP}:yes`, 'KXNFLGAME-26OCT29CARGB-GB:yes'] }, { td: false, ncaaf: true, lines: true }).reason, 'correlated_same_game');
assert.strictEqual(classifyLegs({ legKeys: [`${SP}:yes`, `${TO}:yes`] }, { td: false, ncaaf: true, lines: true }).reason, 'correlated_same_game');
const ok = classifyLegs({ legKeys: [`${SP}:yes`, `${ML}:yes`] }, { td: false, ncaaf: true, lines: true });
assert.ok(ok.ok && ok.legs[0].kind === 'line' && ok.legs[1].gameId === 'nfl|2026-10-25|bal+cin');

// min edge: spread leg => 4% minimum (3% only when every leg is an NFL moneyline)
const pmLive = { legFair: () => ({ sources: [{ venue: 'novig', used: true, reason: 'ok', cost: 0.4, availUsd: 5000 }] }) };
const S = require('../auto-sniper');
const config = S.sniperConfig({ SNIPER_ENABLED: '1' });
assert.strictEqual(config.minRoiLines, 0.04);
const { decision } = decide({ rfqId: 'r1', legKeys: [`${SP}:yes`, `${ML}:yes`], contracts: 100 }, { config, ledger: S.createSniperLedger(), pmLive, tdBook: null, linesBook: book, venues: ALL_VENUES, kickoffFor: () => 2e12, makerRate: 0.035, nowMs: t });
const hi = decide({ rfqId: 'r2', legKeys: [`${SP}:yes`, `${ML}:yes`], contracts: 100 }, { config: S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_MIN_ROI_LINES: '1000' }), ledger: S.createSniperLedger(), pmLive, tdBook: null, linesBook: book, venues: ALL_VENUES, kickoffFor: () => 2e12, makerRate: 0.035, nowMs: t }).decision;
assert.strictEqual(hi.reason, 'roi_below_min_lines');
assert.notStrictEqual(decision.reason, 'scope_lines_off');
if (decision.action === 'quote') { assert.strictEqual(decision.minRoi, 0.04); assert.strictEqual(decision.hasLine, true); }
console.log('lines.test ok', decision.action, decision.reason || '');
