'use strict';
const assert = require('assert');
const { legFair, pickBestAmerican, blendAskLadderToPayout, imp, toAm } = require('./promo-fair');
const { gameEntries } = require('./odds-ingest');
const { createNoBoostShadow } = require('./shadow');
const { createPaperRun, toRow } = require('./paper');
const { makeBook } = require('./test-util');

const NOW = 1e12;
const q = (book, a, o, at = NOW - 5000) => ({ book, american: a, oppAmerican: o, at });
const base = [q('pinnacle', 132, -147), q('draftkings', 124, -148), q('fanduel', 122, -144), q('betmgm', 125, -145), q('novig', 135, -138), q('polymarket', 127, -145)];

// de-vig + blend
const f = legFair(base, null, { now: NOW });
assert.ok(f && f.n === 6 && f.nBooks >= 3 && f.nExchange === 2);
assert.ok(f.consensus > 0.40 && f.consensus < 0.46, `consensus ${f.consensus}`);
assert.ok(f.promoBest > f.consensus - 0.02 && f.promoBest < 0.5, 'promoBest is the line-shopped (high) estimate');
assert.ok(Math.abs(toAm(f.consensus)) >= 100);

// Fliff / Courtside / unknown books never count
const withBad = legFair([...base, q('fliff', 900, -1500), q('courtside', 800, -1200), q('somebook', 700, -900)], null, { now: NOW });
assert.strictEqual(withBad.n, 6); assert.ok(!withBad.books.includes('fliff') && !withBad.books.includes('courtside') && !withBad.books.includes('somebook'));
// outlier rejection
const out = legFair([...base, q('betus', 300, -400)], null, { now: NOW });
assert.ok(!out.books.includes('betus'));
// incoherent two-way (sum far from 1) ignored
assert.ok(!legFair([...base, q('betrivers', 200, 200)], null, { now: NOW }).books.includes('betrivers'));
// stale book dropped, too few components => null (never invents)
assert.strictEqual(legFair(base.map((b) => ({ ...b, at: NOW - 3600e3 })), null, { now: NOW }), null);
assert.strictEqual(legFair([q('pinnacle', 132, -147), q('draftkings', 124, -148)], null, { now: NOW }), null);
// exchanges alone (no sportsbook) is not enough
assert.strictEqual(legFair([q('kalshi', 124, -148), q('novig', 135, -138), q('polymarket', 127, -145)], null, { now: NOW }), null);
// live kalshi mid replaces cached kalshi; stale live ignored
const lv = legFair([...base, q('kalshi', 124, -148)], { mid: 0.43, at: NOW - 1000 }, { now: NOW });
assert.ok(lv.books.includes('kalshi_live') && !lv.books.includes('kalshi'));
const lvStale = legFair([...base, q('kalshi', 124, -148)], { mid: 0.43, at: NOW - 60000 }, { now: NOW });
assert.ok(lvStale.books.includes('kalshi') && !lvStale.books.includes('kalshi_live'));

// pickBestAmerican guards: drops an absurd wrong-side quote
const pb = pickBestAmerican([{ american: 140, book: 'a' }, { american: 135, book: 'b' }, { american: 138, book: 'c' }, { american: -300, book: 'x' }, { american: 900, book: 'bad' }]);
assert.strictEqual(pb.american, 140);
// ladder blend
const bl = blendAskLadderToPayout([{ american: 110, size: 100 }, { american: 120, size: 1000 }].reverse(), 500);
assert.ok(bl && bl.american > 100 && bl.complete);

// odds_cache parser: team->code, fliff dropped, untrusted dropped
const game = { commence_time: '2026-10-04T17:00:00Z', bookmakers: [
  { key: 'pinnacle', markets: [{ key: 'h2h', last_update: '2026-10-01T14:30:00Z', outcomes: [{ name: 'Arizona Cardinals', price: 132 }, { name: 'New York Giants', price: -147 }] }] },
  { key: 'fliff', markets: [{ key: 'h2h', outcomes: [{ name: 'Arizona Cardinals', price: 120 }, { name: 'New York Giants', price: -155 }] }] },
  { key: 'pmu_fr', markets: [{ key: 'h2h', outcomes: [{ name: 'Arizona Cardinals', price: 100 }, { name: 'New York Giants', price: -195 }] }] },
] };
const ents = gameEntries([game]);
assert.strictEqual(ents.length, 2); assert.ok(ents.every((e) => e.gameId === 'nfl|2026-10-04|ari+nyg' && e.quotes.length === 1 && e.quotes[0].book === 'pinnacle'));

// END-TO-END: promo shadow in the paper run; book feed is background-only
let t = Date.now();
const G1 = { game: '26OCT04ARINYG', a: 'ARI', b: 'NYG', askA: 0.52, bidA: 0.50, askB: 0.50, bidB: 0.48 };
const G2 = { game: '26OCT04DENSF', a: 'DEN', b: 'SF', askA: 0.40, bidA: 0.38, askB: 0.62, bidB: 0.60 };
const book = makeBook([G1, G2], () => Date.now());
const mkq = (aA, aB, ex) => [q('pinnacle', aA, aB, Date.now()), q('draftkings', aA, aB, Date.now()), q('fanduel', aA, aB, Date.now()), q('novig', aA, aB, Date.now())].concat(ex || []);
const quiet = () => {};
const env = { NOBOOST_SHADOW: '1', NOBOOST_FAIR_METHOD: 'mid', NOBOOST_MARGIN: '0.10' };
const lines = [];
const primary = createNoBoostShadow({ book, env: { ...env, NOBOOST_GUARDRAIL: 'off' }, log: quiet, label: 'PRIMARY' });
const lockcf = createNoBoostShadow({ book, env: { ...env, NOBOOST_GUARDRAIL: 'lock' }, log: quiet, label: 'LOCKCF' });
const promo = createNoBoostShadow({ book, env: { ...env, NOBOOST_FAIR_METHOD: 'promo', NOBOOST_GUARDRAIL: 'off' }, log: (l) => lines.push(l), label: 'PROMO' });
const rows = [];
const run = createPaperRun({ book, primary, lockcf, promo, margin: 0.1, persist: (r, k) => k !== 'patch' && rows.push(r) });
const keys = ['KXNFLGAME-26OCT04ARINYG-ARI:yes', 'KXNFLGAME-26OCT04DENSF-DEN:yes'];
const rfq = (id) => ({ rfqId: id, marketTicker: `KXMVE-${id}`, legKeys: keys, contracts: 20, createdMs: Date.now() });

// no sportsbook feed yet => promo cannot price (never invents), others still quote
let r0 = run.onRfq(rfq('n0'));
assert.strictEqual(r0.primary.action, 'would_quote');
assert.strictEqual(r0.promo.action, 'skip'); assert.ok(/promo|unpriceable|no_/.test(r0.promo.reason), r0.promo.reason);

// background feed (the ONLY place sportsbook data enters)
const ARI = [q('pinnacle', 108, -118, Date.now()), q('draftkings', 105, -125, Date.now()), q('fanduel', 105, -125, Date.now()), q('novig', 110, -120, Date.now())];
const NYG = ARI.map((x) => ({ ...x, american: x.oppAmerican, oppAmerican: x.american }));
const DEN = [q('pinnacle', 250, -300, Date.now()), q('draftkings', 245, -310, Date.now()), q('fanduel', 240, -300, Date.now()), q('novig', 250, -290, Date.now())];
const SF = DEN.map((x) => ({ ...x, american: x.oppAmerican, oppAmerican: x.american }));
const n = book.setBooks([{ gameId: 'nfl|2026-10-04|ari+nyg', team: 'ari', quotes: ARI }, { gameId: 'nfl|2026-10-04|ari+nyg', team: 'nyg', quotes: NYG }, { gameId: 'nfl|2026-10-04|den+sf', team: 'den', quotes: DEN }, { gameId: 'nfl|2026-10-04|den+sf', team: 'sf', quotes: SF }]);
assert.strictEqual(n, 2);
const r1 = run.onRfq(rfq('n1'));
assert.strictEqual(r1.promo.action, 'would_quote', JSON.stringify(r1.promo));
assert.ok(Number.isInteger(r1.fair_promo_american) && Number.isInteger(r1.fair_promo_best_american));
assert.ok(r1.promo.quote_american !== null && r1.promo_n_books.every((x) => x >= 3));
// promo quote = ~10% over the CONSENSUS fair (not the exchange mid)
assert.ok(Math.abs(r1.promo.quoteYes / r1.fairPromo - 1.10) < 0.03, `promo quote ${r1.promo.quoteYes} vs fair ${r1.fairPromo}`);
assert.ok(lines.some((l) => /\[NOBOOST\]\[PROMO\] WOULD_QUOTE/.test(l) && /promoFair=[+-]\d+/.test(l) && !/%/.test(l)), lines.join('\n'));
// decision stays in-memory fast
assert.ok(r1.decision_ms < 50);

// win/fill/row for the third variant
const r2 = run.onRfq(rfq('n2'));
run.onTrade({ id: 'p1', ticker: 'KXMVE-n2', yes: Math.min(0.99, r2.promo.quoteYes + 0.05), count: 20, takerSide: 'yes', ms: Date.now() });
assert.strictEqual(r2.promo.beat, 'win'); assert.strictEqual(r2.promo.fill, true);
assert.ok(r2.promo.position.ev_vs_promo > 0 && r2.promo.position.caps_ok);
assert.ok(promo.risk.total() > 0);
const row = toRow(r2);
for (const k of ['quote_promo_american', 'promo_action', 'promo_beat', 'promo_fill', 'promo_position', 'fair_promo_american', 'fair_promo_best_american', 'promo_n_books', 'promo_max_age_ms']) assert.ok(k in row, k);
assert.strictEqual(row.promo_beat, 'win');

// stale sportsbook feed => promo refuses
const bookOld = makeBook([G1, G2], () => Date.now());
bookOld.setBooks([{ gameId: 'nfl|2026-10-04|ari+nyg', team: 'ari', quotes: ARI }, { gameId: 'nfl|2026-10-04|ari+nyg', team: 'nyg', quotes: NYG }], Date.now() - 20 * 60 * 1000);
const staleShadow = createNoBoostShadow({ book: bookOld, env: { ...env, NOBOOST_FAIR_METHOD: 'promo', NOBOOST_GUARDRAIL: 'off' }, log: quiet, label: 'PROMO' });
const sd = staleShadow.onRfq({ rfqId: 's', legKeys: ['KXNFLGAME-26OCT04ARINYG-ARI:yes', 'KXNFLGAME-26OCT04DENSF-DEN:yes'], contracts: 5 }, { venue: 'kalshi' });
assert.notStrictEqual(sd.action, 'would_quote');
// two-variant runs (flag off) still work and have no promo columns
const run2 = createPaperRun({ book, primary, lockcf, margin: 0.1, persist: () => {} });
const rr = run2.onRfq(rfq('z')); assert.ok(!rr.promo); assert.ok(!('promo_action' in toRow(rr)));
console.log('noboost/promo-fair.test.js ok');
