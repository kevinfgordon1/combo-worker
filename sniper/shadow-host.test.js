// The shadow tape must log while SNIPER_ENABLED and POLY_SNIPER_ENABLED are
// unset, and it must be unable to send a quote.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createSniperShadow, shadowPricingEnv } = require('./shadow-host');
const { createPolySniper } = require('../poly-sniper');
const { createKalshiIndex } = require('../poly-sniper/map');
const { fairVenues } = require('../poly-sniper/feed');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const NOW = Date.parse('2026-10-24T16:00:00Z');

function fakeFeed() {
  const index = createKalshiIndex();
  index.ingestMarkets(['PHIWAS-PHI', 'PHIWAS-WAS', 'NYGDEN-NYG', 'NYGDEN-DEN'].map((x) => ({ ticker: `KXNFLGAME-26OCT25${x}` })));
  return {
    index,
    venues: fairVenues({}),
    pricesHealthy: () => true,
    tdBook: null,
    ncaafBook: null,
    linesBook: null,
    nbaBook: null,
    ncaabBook: null,
    kickoffs: { kickoffFor: () => Date.parse('2026-10-25T17:00:00Z') },
    pmLive: { legFair: () => ({ sources: [
      { venue: 'kalshi', used: true, reason: 'ok', cost: 0.40, ageMs: 800 },
      { venue: 'novig', used: true, reason: 'ok', cost: 0.45, ageMs: 1200 },
      { venue: 'polymarket', used: true, reason: 'ok', cost: 0.42, ageMs: 500 },
      { venue: 'prophetx', used: true, reason: 'ok', cost: 0.47, ageMs: 900 },
    ] }) },
  };
}

(async () => {
  const env = { SNIPER_SHADOW_MIN_EDGE: '0.03' };
  assert.strictEqual(env.SNIPER_ENABLED, undefined);
  assert.strictEqual(env.POLY_SNIPER_ENABLED, undefined);
  const priced = shadowPricingEnv({ SNIPER_ENABLED: '1', POLY_SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '0', SNIPER_SHADOW_MIN_EDGE: '0.03' });
  assert.strictEqual(priced.SNIPER_ENABLED, '0');
  assert.strictEqual(priced.SNIPER_DRY_RUN, '1');
  assert.strictEqual(priced.POLY_SNIPER_ENABLED, undefined);
  assert.strictEqual(priced.POLY_SNIPER_DRY_RUN, '1');
  assert.strictEqual(priced.SNIPER_MIN_ROI, '0.08');

  const calls = [];
  let posts = 0;
  const supabase = { from(table) { return {
    upsert: async (rows, opts) => { calls.push({ table, rows, opts }); return { error: null }; },
    insert: async () => { throw new Error('insert'); },
    select() { throw new Error('select'); },
  }; } };
  const host = createSniperShadow({
    env, supabase, feed: fakeFeed(), log: () => {}, now: () => NOW,
    feeCache: { prefetch: async () => ({ rate: 0 }) },
  });
  assert.ok(host, 'shadow host starts from the flag alone');
  assert.strictEqual(env.SNIPER_ENABLED, undefined, 'creating the host must not set SNIPER_ENABLED');
  assert.strictEqual(env.POLY_SNIPER_ENABLED, undefined);
  assert.strictEqual(createPolySniper({ env }), null, 'the shadow flag does not enable the Polymarket sniper');
  assert.throws(() => host.attachTrading({ createQuote() { posts += 1; }, postQuote() { posts += 1; } }), /no quote client/);
  assert.strictEqual(posts, 0);

  const kalshi = await host.onKalshiRfq({
    isCombo: true, rfqId: 'k-shadow', marketTicker: 'KXMVECROSSCATEGORY0-X', contracts: 20,
    createdTs: new Date(NOW - 100).toISOString(),
    legKeys: ['KXNFLGAME-26OCT25PHIWAS-PHI:yes', 'KXNFLGAME-26OCT25NYGDEN-NYG:yes'],
  });
  assert.ok(kalshi && kalshi.row, JSON.stringify(kalshi));
  assert.strictEqual(kalshi.posted, false);
  assert.strictEqual(kalshi.row.venue, 'kalshi');
  assert.ok(kalshi.row.quote_yes_shadow < kalshi.row.quote_yes_live);
  assert.strictEqual(kalshi.row.min_edge_shadow, 0.03);
  assert.strictEqual(kalshi.row.min_edge_live, 0.08);
  assert.ok(Math.abs(kalshi.row.fair_yes - 0.6 * 0.6) < 1e-9, 'fair is the inverse of the best opposing ask');

  const stale = await host.onKalshiRfq({
    isCombo: true, rfqId: 'k-stale', marketTicker: 'KXMVECROSSCATEGORY0-X', contracts: 20,
    createdTs: new Date(NOW - 10000).toISOString(),
    legKeys: ['KXNFLGAME-26OCT25PHIWAS-PHI:yes', 'KXNFLGAME-26OCT25NYGDEN-NYG:yes'],
  });
  assert.strictEqual(stale.posted, false);
  assert.strictEqual(stale.row, null, 'the sniper age gate still drops a 10s-old RFQ');

  const poly = host.onPolyRfq({ rfq: {
    id: 'p-shadow', symbol: 'crossd-x', qtyDecimal: '100', tickSize: 0.001,
    createdTime: new Date(NOW - 50).toISOString(),
    comboLegs: [
      { symbol: 'aec-nfl-phi-was-2026-10-25', side: 'SIDE_BUY' },
      { symbol: 'aec-nfl-nyg-den-2026-10-25', side: 'SIDE_SELL' },
    ],
  } });
  assert.ok(poly && poly.row, JSON.stringify(poly));
  assert.strictEqual(poly.posted, false);
  assert.strictEqual(poly.row.venue, 'polymarket');
  assert.strictEqual(posts, 0);

  await host.flush();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].table, 'sniper_shadow_quotes');
  assert.strictEqual(calls[0].rows.length, 2);
  assert.strictEqual(calls[0].opts.returning, 'minimal');
  assert.deepStrictEqual(calls[0].rows.map((r) => r.rfq_id).sort(), ['k-shadow', 'p-shadow']);
  host.stop();

  const hostSrc = read('sniper/shadow-host.js');
  const hostCode = hostSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\.postQuote\s*\(|\.createQuote\s*\(|\.confirmQuote\s*\(|polymarket-client|sniper\/trader|sniper\/live|process\.env\.SNIPER_ENABLED\s*=|process\.env\.POLY_SNIPER_ENABLED\s*=/.test(hostCode));

  const live = read('live-runner.js');
  const hook = live.indexOf('noteSniperShadowKalshi(rfq)');
  assert.ok(hook > 0);
  assert.ok(!/postQuote|createQuote/.test(live.slice(hook, hook + 180)));
  assert.ok(live.includes('sniperShadow.onPolyRfq'));
  assert.ok(live.includes('while POLY_SNIPER_ENABLED is off') || live.includes('POLY_SNIPER_ENABLED is off'));

  const active = (toml, key) => toml.split('\n').some((line) => {
    const s = line.trim();
    return s && !s.startsWith('#') && new RegExp(`^${key}\\s*=`).test(s);
  });
  assert.ok(!active(read('fly/combo-worker.toml'), 'SNIPER_SHADOW_MIN_EDGE'));
  assert.ok(!active(read('fly/combo-worker.toml'), 'SNIPER_ENABLED'));
  assert.ok(!active(read('fly/poly-worker.toml'), 'SNIPER_SHADOW_MIN_EDGE'));
  assert.ok(!active(read('fly/poly-worker.toml'), 'POLY_SNIPER_ENABLED'));
  assert.ok(!active(read('fly/sniper.toml'), 'SNIPER_ENABLED'));
  assert.ok(/kaygo-combo-worker/.test(read('fly/sniper.toml')));
  console.log('sniper/shadow-host.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
