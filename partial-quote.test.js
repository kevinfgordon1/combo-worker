'use strict';
const assert = require('assert');
const fs = require('fs');
const {
  FLAG, VENUE_ALLOWS_PARTIAL_QUOTE, isPartialQuoteFlagOn, partialQuoteActive,
  createPartialQuoteDryRun, hourKey,
} = require('./partial-quote');
const { decideAtFill } = require('./engine');
const { startHeartbeat } = require('./heartbeat');

assert.strictEqual(FLAG, 'COMBO_PARTIAL_QUOTE_OVERSIZED');

// flag defaults OFF, parses truthy values only
assert.strictEqual(isPartialQuoteFlagOn({}), false);
assert.strictEqual(isPartialQuoteFlagOn({ [FLAG]: '' }), false);
assert.strictEqual(isPartialQuoteFlagOn({ [FLAG]: '0' }), false);
assert.strictEqual(isPartialQuoteFlagOn({ [FLAG]: 'off' }), false);
for (const v of ['1', 'true', 'ON', 'yes']) assert.strictEqual(isPartialQuoteFlagOn({ [FLAG]: v }), true);

// venue semantics: neither venue can quote fewer contracts than the RFQ
assert.deepStrictEqual({ ...VENUE_ALLOWS_PARTIAL_QUOTE }, { kalshi: false, polymarket: false });
assert.strictEqual(partialQuoteActive('kalshi', { [FLAG]: 'true' }), false, 'ON is still a no-op on Kalshi');
assert.strictEqual(partialQuoteActive('polymarket', { [FLAG]: 'true' }), false);
assert.strictEqual(partialQuoteActive('kalshi', {}), false);

// engine still declines oversized for Kalshi (no allowPartial) — behaviour unchanged
{
  const d = decideAtFill({
    parlayStake: 100, parlayAmerican: 400, fillAmerican: 350, rfqContracts: 1975,
    hedgeMode: '1x', maxContracts: 800, filledSoFar: 0, outstanding: 0,
  });
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.reason, 'rfq_too_large');
  assert.strictEqual(d.remaining, 800);
}

// dry-run counter
{
  let t = Date.parse('2026-10-01T02:10:00Z');
  const dr = createPartialQuoteDryRun({ now: () => t, env: {} });
  assert.strictEqual(dr.mode(), 'dry-run');
  assert.strictEqual(dr.note({ rfqContracts: 1975, remaining: 800, parlayId: 'a' }), 800);
  assert.strictEqual(dr.note({ rfqContracts: 2000, remaining: 555, parlayId: 'b' }), 555);
  assert.strictEqual(dr.note({ rfqContracts: 700, remaining: 800 }), 0, 'not oversized');
  assert.strictEqual(dr.note({ rfqContracts: 700, remaining: 0 }), 0, 'no remaining cap');
  assert.strictEqual(dr.note({ rfqContracts: 700, remaining: null }), 0);
  const s = dr.snapshot();
  assert.strictEqual(s.hour, '2026-10-01T02');
  assert.strictEqual(s.would_quote, 2);
  assert.strictEqual(s.clip_contracts, 1355);
  assert.strictEqual(s.rfq_contracts, 3975);
  assert.strictEqual(s.parlays, 2);
  assert.deepStrictEqual(s.venues, { kalshi: 2 });
  // hourly line only when the hour rolls
  const lines = [];
  assert.strictEqual(dr.tick((l) => lines.push(l)), null);
  t = Date.parse('2026-10-01T02:50:00Z');
  assert.strictEqual(dr.tick((l) => lines.push(l)), null);
  t = Date.parse('2026-10-01T03:00:05Z');
  dr.note({ rfqContracts: 900, remaining: 100 });
  const done = dr.tick((l) => lines.push(l));
  assert.strictEqual(done.would_quote, 2);
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].startsWith('[LIVE] partial-quote dry-run hour=2026-10-01T02Z would_quote=2 clip_contracts=1355 rfq_contracts=3975 locks=2 venues=kalshi:2'));
  assert.ok(lines[0].includes('rolling_24h_would_quote=3'));
  assert.ok(lines[0].includes('active=false'));
  assert.strictEqual(dr.statsJson().would_quote, 1);
  assert.strictEqual(dr.statsJson().mode, 'dry-run');
  assert.strictEqual(createPartialQuoteDryRun({ env: { [FLAG]: '1' } }).mode(), 'flag-on-noop');
  // bounded history
  const small = createPartialQuoteDryRun({ now: () => t, keepHours: 2 });
  for (let h = 0; h < 10; h += 1) { t += 3600 * 1000; small.note({ rfqContracts: 10, remaining: 5 }); }
  assert.ok(small.last24h().would_quote <= 3);
  assert.strictEqual(hourKey(Date.parse('2026-10-01T03:59:59Z')), '2026-10-01T03');
}

// live-runner wiring: counter only on the Kalshi oversized-decline branch, never alters the quote path
{
  const src = fs.readFileSync(require.resolve('./live-runner.js'), 'utf8');
  assert.ok(/partialQuote\.note\(\{\s*venue: 'kalshi'/.test(src));
  assert.ok(!/allowPartial/.test(src.slice(src.indexOf('async function onRfq'), src.indexOf('async function onRfq') + 20000)),
    'Kalshi decideAtFill must stay full-RFQ only');
  assert.ok(/createPartialQuoteDryRun\(\)/.test(src));
}

// heartbeat: extras merged; falls back to the base row when a column is missing
(async () => {
  const inserts = [];
  const mkSb = (failExtra) => ({
    from: () => ({
      insert: async (row) => {
        inserts.push(row);
        if (failExtra && 'partial_quote' in row) return { error: { message: "Could not find the 'partial_quote' column" } };
        return { error: null };
      },
    }),
  });
  let stop = startHeartbeat(mkSb(false), 'LIVE', { rfqs: 1 }, () => 3, 3600000, () => ({ partial_quote: { would_quote: 2 } }));
  await new Promise((r) => setTimeout(r, 20)); stop();
  assert.strictEqual(inserts.length, 1);
  assert.deepStrictEqual(inserts[0].partial_quote, { would_quote: 2 });
  inserts.length = 0;
  stop = startHeartbeat(mkSb(true), 'LIVE', { rfqs: 1 }, () => 3, 3600000, () => ({ partial_quote: { would_quote: 2 } }));
  await new Promise((r) => setTimeout(r, 20)); stop();
  assert.strictEqual(inserts.length, 2);
  assert.ok(!('partial_quote' in inserts[1]), 'retried without the extra column');
  console.log('partial-quote.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
