// Shadow tape: inverse-bet would-be quotes at 3% and at the live minimum.
// The shadow path has no quote client. Turning the flag on must not post.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { shadowMinEdge, considerShadow, shadowThenLive, createShadowLogger, bestCompeting } = require('./shadow');
const { legFairDepth, ALL_VENUES } = require('./fair');
const { decide } = require('./engine');
const { sniperConfig, createSniperLedger, minQuotePrice } = require('../auto-sniper');
const { americanFromProb } = require('../engine');
const { liveGate } = require('./gates');
const { polyComboMakerFeeDollars } = require('../poly-combo-fee');
const { gradeShadow, formatGrade, wouldTake, makerPnl, SHADOW_COLS } = require('../scripts/sniper-shadow-grade');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const active = (toml, key) => toml.split('\n').some((line) => {
  const s = line.trim();
  return s && !s.startsWith('#') && new RegExp(`^${key}\\s*=`).test(s);
});

assert.strictEqual(shadowMinEdge({}), null);
assert.strictEqual(shadowMinEdge({ SNIPER_SHADOW_MIN_EDGE: '' }), null);
assert.strictEqual(shadowMinEdge({ SNIPER_SHADOW_MIN_EDGE: '0' }), null);
assert.strictEqual(shadowMinEdge({ SNIPER_SHADOW_MIN_EDGE: '1' }), null);
assert.strictEqual(shadowMinEdge({ SNIPER_SHADOW_MIN_EDGE: 'no' }), null);
assert.strictEqual(shadowMinEdge({ SNIPER_SHADOW_MIN_EDGE: '0.03' }), 0.03);

const shadowSrc = read('sniper/shadow.js');
const shadowCode = shadowSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
assert.ok(!/\.postQuote\s*\(|\.createQuote\s*\(|\.confirmQuote\s*\(|\.send\s*\(|\bfetch\s*\(/.test(shadowCode), 'shadow module must not call a quote client');
assert.ok(!/midpoint|fairMethod:\s*'mid'/.test(shadowCode), 'shadow pricing stays on the inverse-bet fair');
assert.ok(!/select\s*\(\s*['"]\*['"]\s*\)/.test(shadowCode), 'shadow writes must not poll select *');

const fair = legFairDepth({ gameId: 'g', team: 'A' }, {
  pmLive: { legFair: () => ({ sources: [
    { venue: 'kalshi', cost: 0.40, reason: 'ok', used: true, ageMs: 1000 },
    { venue: 'novig', cost: 0.55, reason: 'ok', used: true, ageMs: 2000 },
    { venue: 'polymarket', cost: 0.70, reason: 'top_only', used: true, ageMs: 100 },
  ] }) },
  venues: ALL_VENUES,
});
assert.strictEqual(fair.venue, 'kalshi');
assert.ok(Math.abs(fair.p - 0.60) < 1e-9, 'fair is 1 - best opposing cost, not a midpoint');
assert.strictEqual(fair.ageMs, 1000);

const legs = [
  { ticker: 'KXNFLGAME-26NOV15BUFKC-BUF', side: 'yes', fair_yes: 0.5, age_ms: 1000, venue: 'novig' },
  { ticker: 'KXNFLGAME-26NOV15PHINYG-PHI', side: 'yes', fair_yes: 0.5, age_ms: 1500, venue: 'kalshi' },
];
const base = {
  shadowEdge: 0.03,
  liveEdge: 0.08,
  venue: 'kalshi',
  rfq: { rfqId: 'rfq-1', marketTicker: 'KXMVE-1' },
  row: { legs, contracts: 100 },
  makerRate: 0,
  tick: 0.001,
  nowMs: Date.parse('2026-11-14T18:00:01.000Z'),
  rfqAgeMs: 1000,
  maxAgeMs: 2000,
  pricesHealthy: true,
};
const priced = considerShadow(base);
assert.ok(priced, '3% quote exists');
assert.ok(Math.abs(priced.fair_yes - 0.25) < 1e-12);
assert.strictEqual(priced.fair_american, americanFromProb(0.25));
assert.strictEqual(priced.quote_yes_shadow, minQuotePrice({ fair: 0.25, contracts: 100, makerRate: 0, minRoi: 0.03, tick: 0.001 }).q);
assert.strictEqual(priced.quote_yes_live, minQuotePrice({ fair: 0.25, contracts: 100, makerRate: 0, minRoi: 0.08, tick: 0.001 }).q);
assert.ok(priced.quote_yes_shadow < priced.quote_yes_live, '3% is a more competitive YES price than 8%');
assert.ok(priced.quote_yes_shadow > priced.fair_yes);
assert.strictEqual(priced.quote_american_shadow, americanFromProb(priced.quote_yes_shadow));
assert.strictEqual(priced.quote_american_live, americanFromProb(priced.quote_yes_live));
assert.strictEqual(priced.contracts, 100);
assert.deepStrictEqual(priced.legs.map((l) => l.age_ms), [1000, 1500]);
assert.strictEqual(priced.filled, null);
assert.strictEqual(considerShadow({ ...base, pricesHealthy: false }), null);
assert.strictEqual(considerShadow({ ...base, rfqAgeMs: 5000, maxAgeMs: 2000 }), null);
assert.strictEqual(considerShadow({ ...base, decision: { action: 'skip', reason: 'game_started' } }), null);
assert.strictEqual(considerShadow({ ...base, row: { legs: [legs[0], { ...legs[1], fair_yes: null }], contracts: 100 } }), null);
assert.strictEqual(considerShadow({ ...base, shadowEdge: null, env: {} }), null);

const withFee = considerShadow({ ...base, makerRate: 0.035 });
assert.ok(withFee.fee_shadow > 0, 'Kalshi maker fee is in the 3% quote');
assert.ok(withFee.quote_yes_shadow + 1e-12 >= priced.quote_yes_shadow);

const beforeFee = Date.parse('2026-11-13T00:00:00Z');
const afterFee = Date.parse('2026-11-14T05:00:00Z');
const polyBase = { ...base, venue: 'polymarket', makerRate: 0 };
const polyFree = considerShadow({ ...polyBase, nowMs: beforeFee, feeDollars: (n, q) => polyComboMakerFeeDollars(n, q, beforeFee) });
const polyPaid = considerShadow({ ...polyBase, nowMs: afterFee, feeDollars: (n, q) => polyComboMakerFeeDollars(n, q, afterFee) });
assert.strictEqual(polyFree.fee_shadow, 0);
assert.ok(polyPaid.fee_shadow > 0);
assert.ok(polyPaid.quote_yes_shadow + 1e-12 >= polyFree.quote_yes_shadow);

const comp = bestCompeting({ quotes: [
  { status: 'open', no_bid_dollars: '0.70' },
  { status: 'open', no_bid_dollars: '0.60' },
  { status: 'cancelled', no_bid_dollars: '0.80' },
] });
assert.ok(Math.abs(comp.yes - 0.30) < 1e-9);
assert.strictEqual(comp.american, americanFromProb(0.30));
const filled = considerShadow({ ...base, rfq: { ...base.rfq, tradedYes: 0.29, quotes: [{ status: 'open', yes_bid: '0.30' }] } });
assert.strictEqual(filled.filled, true);
assert.strictEqual(filled.trade_yes, 0.29);
assert.strictEqual(filled.trade_american, americanFromProb(0.29));
assert.strictEqual(filled.best_competing_american, americanFromProb(0.30));

let posts = 0;
const spy = () => { posts += 1; };
assert.throws(() => considerShadow({ ...base, postQuote: spy }), /refuses postQuote/);
assert.throws(() => shadowThenLive({ ...base, send: spy, trader: { postQuote: spy } }), /refuses/);
assert.strictEqual(posts, 0);
const evil = { push(row) { evil.rows.push(row); }, rows: [], postQuote: spy, send: spy, createQuote: spy };
const held = shadowThenLive(base, evil);
assert.strictEqual(held.posted, false);
assert.strictEqual(posts, 0);
assert.strictEqual(evil.rows.length, 1);
assert.strictEqual(held.row.rfq_id, 'rfq-1');

const pmLive = { legFair: () => ({ sources: [{ venue: 'kalshi', cost: 0.6, reason: 'ok', used: true, ageMs: 800 }, { venue: 'novig', cost: 0.58, reason: 'ok', used: true, ageMs: 1200 }] }) };
const tdBook = { legMulti: () => ({ sources: [{ venue: 'kalshi', cost: 0.7, reason: 'ok', used: true, ageMs: 900 }] }), kickoffMs: () => null };
const nowMs = Date.parse('2026-10-21T05:00:00Z');
const rfq = { rfqId: 'q1', marketTicker: 'KXMVECROSSCATEGORY0-X', legKeys: ['KXNFLGAME-26OCT25INDMIN-MIN:yes', 'KXNFLTD-26OCT25CINBAL-BALDHENRY22-1:yes'], contracts: 20, createdTs: new Date(nowMs - 200).toISOString() };
const liveCfg = sniperConfig({
  SNIPER_ENABLED: '1', SNIPER_MIN_ROI: '0.08', SNIPER_MIN_ROI_LINES: '0.08', SNIPER_MIN_ROI_NCAAF: '0.08',
  SNIPER_MIN_ROI_NBA: '0.08', SNIPER_MIN_ROI_TD: '100', SNIPER_MIN_ROI_NCAAB: '0.08',
});
const ledger = createSniperLedger();
const decided = decide(rfq, { config: liveCfg, ledger, pmLive, tdBook, venues: ALL_VENUES, kickoffFor: () => Date.parse('2026-10-25T17:00:00Z'), makerRate: 0.035, nowMs });
assert.strictEqual(decided.decision.action, 'skip');
assert.strictEqual(decided.decision.minRoi, 100);
assert.strictEqual(ledger.positions.size, 0);
const missedLive = considerShadow({
  shadowEdge: 0.03, liveEdge: decided.decision.minRoi, venue: 'kalshi', rfq, row: decided.row, decision: decided.decision,
  makerRate: 0.035, tick: 0.001, nowMs, rfqAgeMs: 200, maxAgeMs: 2000, pricesHealthy: true,
});
assert.ok(missedLive && missedLive.quote_yes_shadow > missedLive.fair_yes);
assert.strictEqual(missedLive.quote_yes_live, null, 'a 100% live bar does not invent an 8% quote');
assert.strictEqual(missedLive.legs[0].age_ms, 1200);
assert.strictEqual(ledger.positions.size, 0, 'shadow pricing does not reserve exposure');

(async () => {
  const calls = [];
  const supabase = {
    from(table) {
      return {
        insert: async () => { throw new Error(`insert ${table}`); },
        select: () => { throw new Error('select not allowed'); },
        upsert: async (rows, opts) => { calls.push({ table, rows, opts }); return { error: null }; },
      };
    },
  };
  const logger = createShadowLogger({ supabase, log: () => {}, batchMs: 60000 });
  logger.push(priced);
  logger.push({ ...priced, rfq_id: 'rfq-2' });
  await logger.flush();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].table, 'sniper_shadow_quotes');
  assert.strictEqual(calls[0].rows.length, 2);
  assert.strictEqual(calls[0].opts.returning, 'minimal');
  assert.strictEqual(calls[0].opts.ignoreDuplicates, true);
  assert.deepStrictEqual(calls[0].opts.onConflict, 'venue,rfq_id');
  calls.length = 0;
  const missing = createShadowLogger({
    supabase: { from: () => ({ upsert: async () => { calls.push('up'); return { error: { message: 'relation sniper_shadow_quotes does not exist' } }; }, select: () => { throw new Error('select'); } }) },
    log: () => {}, batchMs: 60000,
  });
  missing.push(priced);
  await missing.flush();
  assert.strictEqual(calls.length, 1);
  missing.push({ ...priced, rfq_id: 'later' });
  await missing.flush();
  assert.strictEqual(calls.length, 1, 'a missing table disables further writes');
  logger.stop(); missing.stop();

  const closes = [
    { leg_key: 'KXNFLGAME-26NOV15BUFKC-BUF:yes', fair_yes: 0.52 },
    { leg_key: 'KXNFLGAME-26NOV15PHINYG-PHI:yes', fair_yes: 0.50 },
  ];
  const trades = [{ ticker: 'KXMVE-1', yes: 0.29, ts: priced.seen_at ? Date.parse(priced.seen_at) + 5000 : Date.parse('2026-11-14T18:00:06Z'), count: 100 }];
  const results = [
    { ticker: 'KXNFLGAME-26NOV15BUFKC-BUF', result: 'no' },
    { ticker: 'KXNFLGAME-26NOV15PHINYG-PHI', result: 'no' },
  ];
  const report = gradeShadow([priced], { trades, closes, results, windowMs: 60000 });
  const shadowLv = report.levels.find((l) => l.kind === 'shadow');
  const liveLv = report.levels.find((l) => l.kind === 'live');
  assert.strictEqual(shadowLv.wouldQuote, 1);
  assert.strictEqual(shadowLv.filledBySomeone, 1);
  assert.strictEqual(shadowLv.wouldFill, 1);
  assert.strictEqual(liveLv.wouldFill, 0, '0.29 is through the 3% quote and not the 8% quote');
  assert.strictEqual(liveLv.filledBySomeone, 1);
  assert.ok(Math.abs(shadowLv.fills[0].pnl - makerPnl(priced.quote_yes_shadow, 100, 0, 'no')) < 1e-9);
  assert.ok(shadowLv.fills[0].pnl > 0);
  assert.strictEqual(shadowLv.fills[0].quoteAmerican, priced.quote_american_shadow);
  assert.strictEqual(shadowLv.fills[0].closeAmerican, americanFromProb(0.26));
  assert.ok(Math.abs(shadowLv.fills[0].clvCents - (priced.quote_yes_shadow - 0.26) * 100) < 1e-9);
  const text = formatGrade(report);
  assert.ok(text.includes(`+${priced.quote_american_shadow}`) || text.includes(String(priced.quote_american_shadow)));
  assert.ok(text.includes('would-fill 1'));
  assert.ok(/Prices are American/.test(text));
  assert.strictEqual(wouldTake(0.272, 0.272), true);
  assert.strictEqual(wouldTake(0.306, 0.29), false);
  assert.ok(!SHADOW_COLS.includes('*'));

  const sniperToml = read('fly/sniper.toml');
  const polyToml = read('fly/poly-worker.toml');
  assert.ok(/SNIPER_DRY_RUN\s*=\s*"1"/.test(sniperToml));
  assert.ok(!active(sniperToml, 'SNIPER_ENABLED'));
  assert.ok(!active(sniperToml, 'SNIPER_SHADOW_MIN_EDGE'));
  assert.ok(!active(polyToml, 'POLY_SNIPER_ENABLED'));
  assert.ok(!active(polyToml, 'POLY_SNIPER_DRY_RUN'));
  assert.ok(!active(polyToml, 'SNIPER_SHADOW_MIN_EDGE'));
  assert.strictEqual(liveGate({ SNIPER_SHADOW_MIN_EDGE: '0.03', SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '1' }).live, false);
  assert.strictEqual(liveGate({
    SNIPER_SHADOW_MIN_EDGE: '0.03', SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '0',
    SNIPER_LIVE_CONFIRM: 'I_UNDERSTAND_SNIPER_TRADES_REAL_MONEY',
    SNIPER_KALSHI_KEY_ID: 'k', SNIPER_KALSHI_PRIVATE_KEY: 'p', SNIPER_KALSHI_SUBACCOUNT: '1',
  }).live, true, 'the shadow flag does not change the live gate');

  const runner = read('sniper/runner.js');
  const sendAt = runner.indexOf('liveSniper.send(');
  const shadowAt = runner.indexOf('shadowThenLive(');
  assert.ok(shadowAt > 0 && sendAt > shadowAt);
  assert.ok(!/postQuote|createQuote|liveSniper/.test(runner.slice(shadowAt, shadowAt + 700)));
  const polySrc = read('poly-sniper/index.js');
  const polyShadow = polySrc.indexOf('shadowThenLive(');
  const polyLive = polySrc.indexOf('live.onDecision(');
  assert.ok(polyShadow > 0 && polyLive > polyShadow);
  assert.ok(!/onDecision|postQuote|createQuote/.test(polySrc.slice(polyShadow, polyShadow + 900)));

  const sql = read('migrations/20261114_sniper_shadow_quotes.sql');
  assert.ok(/enable row level security/i.test(sql));
  assert.ok(!/create policy/i.test(sql));
  assert.ok(!/select\s+\*/i.test(sql));
  assert.ok(/sniper_shadow_quotes/.test(sql));

  const { createPolySniper } = require('../poly-sniper');
  const { createKalshiIndex } = require('../poly-sniper/map');
  const { fairVenues } = require('../poly-sniper/feed');
  assert.strictEqual(createPolySniper({ env: { SNIPER_SHADOW_MIN_EDGE: '0.03' } }), null, 'the shadow flag does not enable the Polymarket sniper');
  const index = createKalshiIndex();
  index.ingestMarkets(['PHIWAS-PHI', 'PHIWAS-WAS', 'NYGDEN-NYG', 'NYGDEN-DEN'].map((x) => ({ ticker: `KXNFLGAME-26OCT25${x}` })));
  const feed = {
    index, venues: fairVenues({}), pricesHealthy: () => true, tdBook: null, ncaafBook: null,
    kickoffs: { kickoffFor: () => Date.parse('2026-10-25T17:00:00Z') },
    pmLive: { legFair: () => ({ sources: [
      { venue: 'novig', used: true, reason: 'ok', cost: 0.45, ageMs: 2000 },
      { venue: 'polymarket', used: true, reason: 'ok', cost: 0.30, ageMs: 500, availUsd: 2500 },
    ] }) },
  };
  const seen = [];
  const db = { from(table) { return {
    insert: async (rows) => { seen.push({ op: 'insert', table }); return { error: null }; },
    upsert: async (rows, opts) => { seen.push({ op: 'upsert', table, rows, opts }); return { error: null }; },
    select() { throw new Error('select'); },
  }; } };
  let polyPosts = 0;
  const s = createPolySniper({
    env: {
      POLY_SNIPER_ENABLED: '1', POLY_SNIPER_DRY_RUN: '1', SNIPER_SHADOW_MIN_EDGE: '0.03',
      POLY_SNIPER_MIN_ROI_NFL_ML: '0.08', POLY_SNIPER_MIN_ROI_NFL: '0.08', POLY_SNIPER_MIN_ROI_TD: '0.08',
      POLY_SNIPER_MIN_ROI_NCAAF: '0.08', POLY_SNIPER_MIN_ROI_NBA: '0.08', POLY_SNIPER_MIN_ROI_NCAAB: '0.08',
    },
    supabase: db, feed, log: () => {}, now: () => Date.parse('2026-10-24T16:00:00Z'),
  });
  assert.strictEqual(s.live, null);
  const d = s.observe({ rfq: { id: 'poly-1', symbol: 'crossd-x', qtyDecimal: '100', tickSize: 0.001, createdTime: '2026-10-24T15:59:59.900Z', comboLegs: [
    { symbol: 'aec-nfl-phi-was-2026-10-25', side: 'SIDE_BUY' },
    { symbol: 'aec-nfl-nyg-den-2026-10-25', side: 'SIDE_SELL' },
  ] } }, 'ws');
  assert.strictEqual(d.action, 'quote', d.reason);
  await s.flush();
  const up = seen.filter((c) => c.op === 'upsert' && c.table === 'sniper_shadow_quotes');
  assert.strictEqual(up.length, 1);
  assert.strictEqual(up[0].opts.returning, 'minimal');
  assert.ok(Math.abs(up[0].rows[0].fair_yes - 0.7 * 0.7) < 1e-9, 'poly fair is the inverse of the best opposing ask');
  assert.ok(up[0].rows[0].quote_yes_shadow <= up[0].rows[0].quote_yes_live);
  assert.strictEqual(up[0].rows[0].min_edge_shadow, 0.03);
  assert.strictEqual(up[0].rows[0].min_edge_live, 0.08);
  assert.strictEqual(up[0].rows[0].venue, 'polymarket');
  assert.strictEqual(polyPosts, 0);
  assert.ok(seen.every((c) => c.table === 'poly_sniper_decisions' || c.table === 'sniper_shadow_quotes'));
  console.log('sniper/shadow.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
