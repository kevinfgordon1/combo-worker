'use strict';
// Trade->RFQ matching window, size consistency, ambiguity, min-price prints, expiry/memory,
// quote eviction => pulled, PROMO-only caps, void-leg settlement, real kickoffs, TTL seen-set.
const assert = require('assert');
const { createNoBoostShadow } = require('./shadow');
const { createPaperRun, sizeCheck } = require('./paper');
const { createRiskBook } = require('./risk');
const { createTtlSet } = require('./ttl-set');
const { priceCombo, configFromEnv } = require('./quote');
const { espnKickoffs, oddsKickoffs } = require('./kickoffs');
const { makeBook } = require('./test-util');

const G1 = { game: '26OCT04ARINYG', a: 'ARI', b: 'NYG', askA: 0.52, bidA: 0.50, askB: 0.50, bidB: 0.48 };
const G2 = { game: '26OCT04DENSF', a: 'DEN', b: 'SF', askA: 0.40, bidA: 0.38, askB: 0.62, bidB: 0.60 };
const keys = ['KXNFLGAME-26OCT04ARINYG-ARI:yes', 'KXNFLGAME-26OCT04DENSF-DEN:yes'];
const base = { NOBOOST_SHADOW: '1', NOBOOST_FAIR_METHOD: 'mid', NOBOOST_MARGIN: '0.10' };
const quiet = () => {};

function setup({ env = {}, primaryEnv = {}, lockEnv = {}, promoEnv = null } = {}) {
  let t = Date.now();
  const clock = { now: () => t, adv: (ms) => { t += ms; } };
  const book = makeBook([G1, G2], clock.now);
  const mk = (e, label) => createNoBoostShadow({ book, env: { ...base, ...env, ...e }, log: quiet, now: clock.now, label });
  const primary = mk({ NOBOOST_GUARDRAIL: 'off', ...primaryEnv }, 'PRIMARY');
  const lockcf = mk({ NOBOOST_GUARDRAIL: 'lock', ...lockEnv }, 'LOCKCF');
  const promo = promoEnv ? mk({ NOBOOST_GUARDRAIL: 'off', ...promoEnv }, 'PROMO') : null;
  const rows = []; const patches = [];
  const run = createPaperRun({
    book, primary, lockcf, promo, margin: 0.1, runId: 'test-run', now: clock.now, graceMs: 2000, tradeLagMs: 15000,
    persist: (r, k) => (k === 'patch' ? patches.push(r) : rows.push(r)), persistStats: quiet, samplePct: 100,
  });
  const rfq = (id, extra = {}) => ({ rfqId: id, marketTicker: 'KXMVE-COMBO', legKeys: keys, contracts: 20, createdMs: t - 1000, ...extra });
  const trade = (id, ms, extra = {}) => ({ id, ticker: 'KXMVE-COMBO', yes: 0.5, count: 20, takerSide: 'yes', ms, ...extra });
  return { clock, book, primary, lockcf, promo, run, rows, patches, rfq, trade };
}

// 1. a print BEFORE we saw the RFQ never matches (old code had a 2s look-back)
{
  const S = setup();
  const rec = S.run.onRfq(S.rfq('a'));
  assert.ok(rec && rec.primary.action === 'would_quote');
  assert.strictEqual(S.run.onTrade(S.trade('t-before', rec.seen_ms - 500)), null);
  assert.strictEqual(S.run.onTrade(S.trade('t-same', rec.seen_ms)), null, 'trade must be strictly after seen');
  assert.strictEqual(rec.outcome, 'pending');
  assert.strictEqual(S.run._delta().trades.no_candidate, 2);
}

// 2. inside the window and before quote expiry => win + fill; carries run_id + window fields
{
  const S = setup();
  const rec = S.run.onRfq(S.rfq('b'));
  const hit = S.run.onTrade(S.trade('t-in', rec.seen_ms + 5000, { yes: rec.primary.quoteYes + 0.05 }));
  assert.strictEqual(hit, rec);
  assert.strictEqual(rec.outcome, 'traded');
  assert.strictEqual(rec.primary.beat, 'win'); assert.strictEqual(rec.primary.fill, true);
  assert.strictEqual(rec.run_id, 'test-run');
  assert.strictEqual(rec.quote_expires_ms, rec.seen_ms + S.run.ttlMs);
  assert.strictEqual(rec.match_ambiguous, false);
  assert.strictEqual(S.rows[S.rows.length - 1].run_id, 'test-run');
}

// 3. after the quote lifetime but inside the grace => matched (RFQ is done) but NOT a fill;
//    after lifetime + grace => no match at all (no more 4-70h-later in-game prints)
{
  const S = setup();
  const rec = S.run.onRfq(S.rfq('c'));
  const ttl = S.run.ttlMs;
  assert.strictEqual(ttl, 20000);
  assert.strictEqual(S.run.onTrade(S.trade('t-late', rec.seen_ms + ttl + 2001, { yes: 0.9 })), null);
  assert.strictEqual(rec.outcome, 'pending');
  S.run.onTrade(S.trade('t-grace', rec.seen_ms + ttl + 1000, { yes: rec.primary.quoteYes + 0.05 }));
  assert.strictEqual(rec.outcome, 'traded');
  assert.strictEqual(rec.primary.beat, 'expired'); assert.ok(!rec.primary.fill);
  // a 70h-later print on the same combo cannot match anything
  const S2 = setup();
  const r2 = S2.run.onRfq(S2.rfq('c2'));
  assert.strictEqual(S2.run.onTrade(S2.trade('t-70h', r2.seen_ms + 70 * 3600e3, { yes: 0.9 })), null);
}

// 4. size: a 93k-contract print never matches a 20-contract RFQ; dollar RFQs compare notional
{
  const S = setup();
  const rec = S.run.onRfq(S.rfq('d'));
  assert.strictEqual(S.run.onTrade(S.trade('t-huge', rec.seen_ms + 1000, { count: 93155.16, yes: 0.9 })), null);
  assert.strictEqual(rec.outcome, 'pending');
  assert.strictEqual(S.run._delta().trades.size_mismatch, 1);
  assert.strictEqual(sizeCheck({ rfq_contracts: 20 }, 20.2, 0.3).verdict, 'ok');
  assert.strictEqual(sizeCheck({ rfq_contracts: 20 }, 25, 0.3).verdict, 'mismatch');
  // $10 target at 2.1c: 444.44 contracts (fee comes out of the $10) => ok; 4444 => mismatch
  assert.strictEqual(sizeCheck({ rfq_target_cost: 10 }, 444.44, 0.021).verdict, 'ok');
  assert.strictEqual(sizeCheck({ rfq_target_cost: 10 }, 4444.4, 0.021).verdict, 'mismatch');
  assert.strictEqual(sizeCheck({}, 10, 0.5).verdict, 'unknown');
}

// 5. ambiguity: two in-window RFQs of the same size on one combo => most recent matched, flagged;
//    one print credits at most one RFQ
{
  const S = setup();
  const r1 = S.run.onRfq(S.rfq('e1'));
  S.clock.adv(3000);
  const r2 = S.run.onRfq(S.rfq('e2'));
  const m = S.run.onTrade(S.trade('t-amb', r2.seen_ms + 1000, { yes: r2.primary.quoteYes + 0.05 }));
  assert.strictEqual(m, r2);
  assert.strictEqual(r2.match_ambiguous, true); assert.strictEqual(r2.match_candidates, 2);
  assert.strictEqual(r1.outcome, 'pending', 'the other candidate is untouched');
  assert.strictEqual(S.run._delta().trades.ambiguous, 1);
}

// 6. $0.001 minimum-price prints are ignored
{
  const S = setup();
  const rec = S.run.onRfq(S.rfq('f'));
  assert.strictEqual(S.run.onTrade(S.trade('t-min', rec.seen_ms + 1000, { yes: 0.001 })), null);
  assert.strictEqual(rec.outcome, 'pending');
  assert.strictEqual(S.run._delta().trades.min_price_print, 1);
  // and quotes are floored: never quote below NOBOOST_MIN_QUOTE_YES (default $0.005)
  assert.strictEqual(configFromEnv({}).minQuoteYes, 0.005);
  const src = { legStats: () => ({ inverse: 0.05, mid: 0.05, lockCost: 0.06, ageMs: 0 }) };
  const tiny = priceCombo([{}, {}, {}], src, { cfg: { ...configFromEnv({ NOBOOST_FAIR_METHOD: 'mid', NOBOOST_GUARDRAIL: 'off' }) } });
  assert.strictEqual(tiny.ok, false); assert.strictEqual(tiny.reason, 'below_min_quote');
}

// 7. expiry: pending RFQs finalize as no_trade after ttl+grace+lag and leave memory (no leak, no orphan)
{
  const S = setup();
  const rec = S.run.onRfq(S.rfq('g'));
  S.clock.adv(S.run.ttlMs + 2000 + 14000);
  S.run.expire();
  assert.strictEqual(rec.outcome, 'pending', 'still waiting on trade-feed lag');
  S.clock.adv(2000);
  S.run.expire();
  assert.strictEqual(rec.outcome, 'no_trade');
  assert.strictEqual(S.run.byId.size, 0); assert.strictEqual(S.run.byTicker.size, 0);
  // reprocessing the same RFQ id while it is in memory is ignored (old bug orphaned the first record)
  const S2 = setup();
  const a = S2.run.onRfq(S2.rfq('dup'));
  assert.strictEqual(S2.run.onRfq(S2.rfq('dup')), null);
  assert.strictEqual(S2.run.byTicker.get('KXMVE-COMBO').length, 1);
  assert.ok(a);
}

// 8. eviction at the open-quote cap marks the quote PULLED (at eviction time); TTL pull time = expiry
{
  const S = setup({ env: { NOBOOST_MAX_OPEN_QUOTES: '2' } });
  const recs = ['h1', 'h2', 'h3'].map((id) => { const r = S.run.onRfq(S.rfq(id)); S.clock.adv(100); return r; });
  assert.ok(recs.every((r) => r.primary.action === 'would_quote'));
  assert.strictEqual(S.primary.risk.snapshot().openQuotes, 2);
  S.run.sweep();
  assert.ok(recs[0].primary.pulled, 'evicted quote is marked pulled');
  assert.strictEqual(recs[0].primary.pulled.reason, 'evicted');
  assert.strictEqual(recs[0].primary.pulled.at, recs[2].seen_ms);
  assert.strictEqual(S.primary.counts.evicted, 1);
  assert.strictEqual(S.primary.risk.snapshot().evictions, 1);
  // with three same-size candidates the most recently seen (h3, still live) takes the print
  S.run.onTrade(S.trade('t-ev', recs[2].seen_ms + 500, { count: 20, yes: recs[0].primary.quoteYes + 0.05 }));
  assert.strictEqual(recs[2].outcome, 'traded'); assert.strictEqual(recs[2].primary.fill, true);
  assert.strictEqual(recs[2].match_candidates, 3);
  // TTL: risk book reports the exact expiry time as the pull time
  let t = 1e12;
  const rb = createRiskBook({ ttlMs: 20000, maxOpenQuotes: 5 }, { now: () => t });
  rb.registerQuote('q1', { quoteYes: 0.3, fair: 0.25, legs: [] });
  t += 25000;
  const pulled = rb.sweepQuotes(() => ({ fair: 0.25 }));
  assert.deepStrictEqual(pulled.map((p) => [p.rfqId, p.reason, p.at]), [['q1', 'ttl', 1e12 + 20000]]);
  // eviction drops expired quotes first instead of evicting a live one
  const rb2 = createRiskBook({ ttlMs: 20000, maxOpenQuotes: 2 }, { now: () => t });
  rb2.registerQuote('old', { quoteYes: 0.3, legs: [] });
  t += 21000;
  rb2.registerQuote('live1', { quoteYes: 0.3, legs: [] });
  const ev = rb2.registerQuote('live2', { quoteYes: 0.3, legs: [] });
  assert.deepStrictEqual(ev, [], 'expired quote is TTL-pulled, not an eviction');
  assert.deepStrictEqual(rb2.sweepQuotes(() => ({ fair: 0.25 })).map((p) => [p.rfqId, p.reason]), [['old', 'ttl']]);
}

// 8b. eviction then print => 'pulled' for the evicted RFQ
{
  const S = setup({ env: { NOBOOST_MAX_OPEN_QUOTES: '1' } });
  const a = S.run.onRfq(S.rfq('p1', { contracts: 30 }));
  S.clock.adv(500);
  S.run.onRfq(S.rfq('p2', { contracts: 40 }));
  S.run.sweep();
  assert.strictEqual(a.primary.pulled.reason, 'evicted');
  S.run.onTrade(S.trade('t-p1', a.seen_ms + 2000, { count: 30, yes: a.primary.quoteYes + 0.05 }));
  assert.strictEqual(a.outcome, 'traded');
  assert.strictEqual(a.primary.beat, 'pulled'); assert.ok(!a.primary.fill);
}

// 9. PROMO-only quote (standard + lock skip on risk) still runs per-game/per-team caps and books game exposure
{
  const S = setup({
    primaryEnv: { NOBOOST_MAX_COMBO_LOSS: '0.01' }, lockEnv: { NOBOOST_MAX_COMBO_LOSS: '0.01' },
    promoEnv: { NOBOOST_MAX_GAME_LOSS: '1000', NOBOOST_MAX_SELECTION_LOSS: '20' },
  });
  const rec = S.run.onRfq(S.rfq('m'));
  assert.ok(/^risk:/.test(rec.primary.reason) && /^risk:/.test(rec.lockcf.reason));
  assert.strictEqual(rec.promo.action, 'would_quote');
  assert.ok(Array.isArray(rec.cls) && rec.cls.length === 2, 'legs classified even when primary/lock skip');
  S.run.onTrade(S.trade('t-m', rec.seen_ms + 1000, { yes: rec.promo.quoteYes + 0.05 }));
  assert.strictEqual(rec.promo.fill, true);
  assert.strictEqual(S.promo.risk._gameLoss.size, 2, 'promo fill books per-game exposure');
  assert.strictEqual(S.promo.risk._selLoss.size, 2, 'promo fill books per-team exposure');
  // the next promo fill on the same team breaches the $20 per-team cap
  S.clock.adv(1000);
  const rec2 = S.run.onRfq(S.rfq('m2', { contracts: 20 }));
  assert.ok(rec2.promo.action === 'skip' && rec2.promo.reason === 'risk:selection_cap', rec2.promo.reason);
}

// 10. settlement: void legs are removed; all-void = push (P&L 0, exposure released)
{
  (async () => {
    const S = setup();
    const r1 = S.run.onRfq(S.rfq('v1'));
    S.run.onTrade(S.trade('t-v1', r1.seen_ms + 1000, { yes: r1.primary.quoteYes + 0.05 }));
    S.clock.adv(1000);
    const r2 = S.run.onRfq(S.rfq('v2', { marketTicker: 'KXMVE-OTHER' }));
    S.run.onTrade(S.trade('t-v2', r2.seen_ms + 1000, { ticker: 'KXMVE-OTHER', yes: r2.primary.quoteYes + 0.05 }));
    assert.ok(r1.primary.fill && r2.primary.fill);
    // v1: ARI void, DEN won => hit (remaining leg won).  v2 handled below
    await S.run.settle(async (tk) => (tk.endsWith('ARI') ? 'void' : 'yes'));
    const p1 = S.patches.find((p) => p.rfq_id === 'v1');
    assert.strictEqual(p1.hit, true); assert.strictEqual(p1.void_legs, 1); assert.ok(p1.primary_pnl < 0);
    const S2 = setup();
    const r3 = S2.run.onRfq(S2.rfq('v3'));
    S2.run.onTrade(S2.trade('t-v3', r3.seen_ms + 1000, { yes: r3.primary.quoteYes + 0.05 }));
    await S2.run.settle(async () => 'void');
    const p3 = S2.patches.find((p) => p.rfq_id === 'v3');
    assert.strictEqual(p3.push, true); assert.strictEqual(p3.primary_pnl, 0);
    assert.strictEqual(S2.primary.risk.total(), 0, 'exposure released on push');
    console.log('noboost/matching.test.js ok');
  })().catch((e) => { console.error(e); process.exit(1); });
}

// 11. real kickoffs: ESPN/odds_cache override the Kalshi-3h guess; ESPN in-progress => started
{
  const S = setup();
  const gid = 'nfl|2026-10-04|ari+nyg';
  assert.strictEqual(S.book.kickoffSource(gid), 'kalshi_occ_minus_3h');
  const future = S.clock.now() + 3 * 3600e3;
  S.book.setKickoffs([{ gameId: gid, kickoffMs: future, source: 'odds_cache' }]);
  assert.strictEqual(S.book.kickoffMs(gid), future); assert.strictEqual(S.book.kickoffSource(gid), 'odds_cache');
  const k1 = S.run.onRfq(S.rfq('k1'));
  assert.strictEqual(k1.primary.action, 'would_quote', k1.primary.reason);
  S.book.setKickoffs([{ gameId: gid, kickoffMs: future, state: 'in', source: 'espn' }]);
  assert.strictEqual(S.book.hasStarted(gid), true);
  const r = S.run.onRfq(S.rfq('k2'));
  assert.strictEqual(r.primary.reason, 'game_started');
  // a lower-ranked source does not override ESPN
  S.book.setKickoffs([{ gameId: gid, kickoffMs: future + 1, source: 'odds_cache' }]);
  assert.strictEqual(S.book.kickoffSource(gid), 'espn');
  // parsers
  const espn = espnKickoffs({ events: [{ date: '2026-10-11T13:30Z', status: { type: { state: 'pre' } }, competitions: [{ date: '2026-10-11T13:30Z', competitors: [{ team: { displayName: 'Jacksonville Jaguars' } }, { team: { displayName: 'Philadelphia Eagles' } }] }] }] });
  assert.deepStrictEqual(espn, [{ gameId: 'nfl|2026-10-11|jax+phi', kickoffMs: Date.parse('2026-10-11T13:30Z'), state: 'pre', source: 'espn' }]);
  const odds = oddsKickoffs([{ commence_time: '2026-10-09T00:15:00Z', home_team: 'Dallas Cowboys', away_team: 'Tampa Bay Buccaneers' }]);
  assert.deepStrictEqual(odds, [{ gameId: 'nfl|2026-10-08|dal+tb', kickoffMs: Date.parse('2026-10-09T00:15:00Z'), source: 'odds_cache' }]);
}

// 12. TTL seen-set: remembers >= ttl, forgets after 2·ttl, bounded, never a wholesale clear of fresh ids
{
  let t = 0;
  const s = createTtlSet({ ttlMs: 1000, maxPerGen: 3, now: () => t });
  assert.strictEqual(s.addIfNew('a'), true); assert.strictEqual(s.addIfNew('a'), false);
  t = 999; assert.strictEqual(s.has('a'), true);
  t = 1500; s.add('b'); assert.strictEqual(s.has('a'), true, 'still remembered after one rotation');
  t = 2600; assert.strictEqual(s.has('a'), false); assert.strictEqual(s.has('b'), true);
  t = 10000; assert.strictEqual(s.has('b'), false); assert.strictEqual(s.size(), 0);
  ['c', 'd', 'e', 'f'].forEach((k) => s.add(k));
  assert.strictEqual(s.stats.early_rotations, 1);
  assert.ok(['c', 'd', 'e', 'f'].every((k) => s.has(k)), 'early rotation keeps the previous generation');
}
