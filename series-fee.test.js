'use strict';
const assert = require('assert');
const { makerRateFromSeries, seriesOfTicker, createSeriesFeeCache, FALLBACK_MAKER_RATE } = require('./series-fee');
const { fillView, decideAtFill, americanFromProb } = require('./engine');

assert.strictEqual(makerRateFromSeries('quadratic', 1), 0);
assert.strictEqual(makerRateFromSeries('quadratic_with_maker_fees', 1), 0.0175);
assert.strictEqual(makerRateFromSeries('quadratic_with_maker_fees', 0.5), 0.00875);
assert.strictEqual(makerRateFromSeries('quadratic_with_combo_maker_fees', 1), 0.035);
assert.strictEqual(makerRateFromSeries('flat', 1), FALLBACK_MAKER_RATE);
assert.strictEqual(seriesOfTicker('KXMVECROSSCATEGORY0-S2026A0E24EEACD4-D44B4A1E301'), 'KXMVECROSSCATEGORY0');
assert.strictEqual(seriesOfTicker(null), null);

// Kenny's lock 799f71e3: fill +1188 on KXMVECROSSCATEGORY0 (quadratic) → YES 7.8¢ (NO 0.922), buyer +1104.
{
  const v = fillView(1188, { subcent: true, makerRate: 0 });
  assert.strictEqual(v.noBid, '0.922');
  const yes = 1 - parseFloat(v.noBid);
  const buyer = americanFromProb(yes + 0.07 * yes * (1 - yes));
  assert.strictEqual(buyer, 1104);
  // Old fixed 0.0175 quoted 7.9¢.
  assert.strictEqual(fillView(1188, { subcent: true, makerRate: 0.0175 }).noBid, '0.921');
  // Combo maker series (0.035) quotes further from the target.
  assert.ok(parseFloat(fillView(1188, { subcent: true, makerRate: 0.035 }).noBid) < 0.921);
  const d = decideAtFill({ parlayStake: 10, parlayAmerican: 1613, fillAmerican: 1188, rfqContracts: 12, maxContracts: 171, subcent: true, makerRate: 0 });
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.quote.no_bid, '0.922');
}

(async () => {
  let calls = 0;
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const c = createSeriesFeeCache({ fetchImpl: async (u) => { calls++; if (u.includes('KXMVECROSSCATEGORY0')) return ok({ series: { fee_type: 'quadratic', fee_multiplier: 1 } }); if (u.includes('BROKEN')) return { ok: false, status: 503 }; return ok({ series: { fee_type: 'quadratic_with_combo_maker_fees', fee_multiplier: 1 } }); } });
  assert.strictEqual(c.rateForTicker('KXMVECROSSCATEGORY0-X-Y'), FALLBACK_MAKER_RATE); // cold → conservative
  await c.prefetchTickers(['KXMVECROSSCATEGORY0-X-Y', 'KXMVECROSSCATEGORY-A-B', 'BROKEN-1']);
  assert.strictEqual(c.rateForTicker('KXMVECROSSCATEGORY0-Z'), 0);
  assert.strictEqual(c.rateForTicker('KXMVECROSSCATEGORY-Z'), 0.035);
  assert.strictEqual(c.rateForTicker('BROKEN-2'), FALLBACK_MAKER_RATE);
  const before = calls;
  await c.prefetchTickers(['KXMVECROSSCATEGORY0-Q']);
  assert.strictEqual(calls, before); // cached
  console.log('series-fee.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
