'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createUnhedgedRuntime,
  considerKalshiUnhedged,
  DEFAULT_FILL_TICK_MS,
} = require('./unhedged-runtime');

const lock = {
  id: 'p1',
  label: 'Sox',
  leg_keys: ['KXMLBGAME-26AUG14BOSNYY-BOS:yes'],
};

{
  assert.deepStrictEqual(
    considerKalshiUnhedged({ isCombo: false, contracts: 10 }, [lock]),
    { action: 'skip', reason: 'not_combo' }
  );
  assert.deepStrictEqual(
    considerKalshiUnhedged({ isCombo: true }, [lock]),
    { action: 'skip', reason: 'no_size' }
  );
  const matched = considerKalshiUnhedged({
    isCombo: true,
    contracts: 10,
    legKeys: ['KXMLBGAME-26AUG14BOSNYY-BOS:yes'],
  }, [lock]);
  assert.strictEqual(matched.reason, 'lock_match');
  assert.strictEqual(matched.parlay.id, 'p1');

  const miss = considerKalshiUnhedged({
    isCombo: true,
    contracts: 10,
    legKeys: [
      'KXMLBGAME-26AUG14CWSDET-CWS:yes',
      'KXMLBGAME-26AUG14BOSPIT-PIT:yes',
    ],
  }, [lock]);
  assert.deepStrictEqual(miss, { action: 'shadow', reason: 'lock_miss' });
}

(async () => {
  const persisted = [];
  const kalshiRfqs = [];
  const runtime = createUnhedgedRuntime({
    env: { UNHEDGED_RFQ_SHADOW: 'true' },
    persist: async (row) => { persisted.push(row); return { row }; },
    polyHttp: null,
    fetchKalshiRfq: async (id) => { kalshiRfqs.push(id); return { id, status: 'closed' }; },
    fetchKalshiTrades: async () => [],
    fetchKalshiMarkets: async () => ({ statusCode: 200, json: { markets: [] } }),
  });
  assert.ok(runtime.fills);
  assert.ok(runtime.prices);
  assert.strictEqual(runtime.polyHttp, null);
  assert.ok(DEFAULT_FILL_TICK_MS <= 1000);

  const row = { venue: 'kalshi', rfq_id: 'rfq-1', status: 'seen', legs: [] };
  await runtime.persistRow(row);
  assert.strictEqual(persisted.length, 1);
  assert.strictEqual(persisted[0].rfq_id, 'rfq-1');

  const got = await runtime.fetchVenueRfq('rfq-1', { venue: 'kalshi' });
  assert.strictEqual(got.id, 'rfq-1');
  assert.deepStrictEqual(kalshiRfqs, ['rfq-1']);

  const polyMiss = await runtime.fetchVenueRfq('pm-1', { venue: 'polymarket' });
  assert.strictEqual(polyMiss, null);

  runtime.stop();

  const src = fs.readFileSync(path.join(__dirname, 'unhedged-runtime.js'), 'utf8');
  assert.ok(!/require\(['"]\.\/quote-watcher['"]\)/.test(src));
  assert.ok(!src.includes('combo_submissions'));
  assert.ok(!/buildQuoteBody|postQuote|createQuote/.test(src));
  assert.ok(src.includes('fetchPolymarketUnhedgedRfq'));
  assert.ok(src.includes('createUnhedgedFillTracker'));
  assert.ok(src.includes('createUnhedgedPriceCache'));
  assert.ok(/market_ticker:\s*\(rfq && \(rfq\.marketTicker/.test(src));

  console.log('unhedged-runtime.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
