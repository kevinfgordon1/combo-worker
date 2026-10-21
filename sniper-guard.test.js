'use strict';
const assert = require('assert');
const { createSniperGuard } = require('./sniper-guard');
const db = (rows, err) => ({ from: () => ({ select: () => ({ eq: (col, val) => ({ limit: async () => (err ? { error: err } : { data: rows.filter((r) => r[col] === val), error: null }) }) }) }) });
(async () => {
  const g = createSniperGuard({ supabase: db([{ rfq_id: 'r', quote_id: 'Q', order_id: 'O', market_ticker: 'KXMVE-S' }]) });
  assert.deepStrictEqual(await g.isSniperQuote('Q'), { sniper: true });
  assert.deepStrictEqual(await g.isSniperQuote('X'), { sniper: false });
  assert.strictEqual(await g.isSniperFill({ order_id: 'O' }), true);
  assert.strictEqual(await g.isSniperFill({ order_id: 'Z', ticker: 'KXMVE-S' }), true);
  assert.strictEqual(await g.isSniperFill({ order_id: 'Z', ticker: 'KXMVE-L' }), false);
  const none = createSniperGuard({ supabase: db([], { code: '42P01', message: 'relation does not exist' }) });
  assert.deepStrictEqual(await none.isSniperQuote('Q'), { sniper: false });
  const bad = createSniperGuard({ supabase: db([], { message: 'timeout' }) });
  assert.strictEqual((await bad.isSniperQuote('Q')).unknown, true);
  console.log('sniper-guard.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
