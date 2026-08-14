'use strict';
const assert = require('assert');
const { fillView } = require('./engine');
const {
  tickerMatchesCollection,
  attributeParlay,
  sumFillCounts,
  remainingContracts,
  formatRealFillAlert,
  noBidMatchesFill,
} = require('./fills-attr');

const soxLabel = 'Chicago White Sox ML + Pittsburgh Pirates ML + Baltimore Orioles ML';
const sox = {
  id: 'p-sox',
  label: soxLabel,
  mve_collection: 'KXMVESPORTSMULTIGAMEEXTENDED-R',
  active: true,
  max_contracts: 2816,
  fill_american: 1100,
};
const other = {
  id: 'p-other',
  label: 'Other parlay',
  mve_collection: 'KXMVECROSSCATEGORY-R',
  active: true,
  max_contracts: 100,
  fill_american: 350,
};

const soxNoBid = parseFloat(fillView(1100).noBid);
assert.ok(Number.isFinite(soxNoBid));
const otherNoBid = parseFloat(fillView(350).noBid);
assert.ok(Math.abs(soxNoBid - otherNoBid) > 0.01);

// Collection: exact substring still works
assert.ok(tickerMatchesCollection(
  'KXMVESPORTSMULTIGAMEEXTENDED-R-26AUG14CHW',
  sox.mve_collection
));

// Collection: -R vs -S suffix must not miss
assert.ok(tickerMatchesCollection(
  'KXMVESPORTSMULTIGAMEEXTENDED-S-26AUG14CHWMLPITMLBALML',
  sox.mve_collection
));
assert.ok(!tickerMatchesCollection(
  'KXMVESPORTSMULTIGAMEEXTENDED-S-26AUG14CHW',
  other.mve_collection
));

// Collection: ticker starts with / contains the prefix (no -R/-S on ticker)
assert.ok(tickerMatchesCollection(
  'KXMVESPORTSMULTIGAMEEXTENDED-26AUG14CHW',
  sox.mve_collection
));

assert.ok(!tickerMatchesCollection('KXMVEUNKNOWN-XYZ', sox.mve_collection));
assert.ok(!tickerMatchesCollection('KXMVE-ABC', null));
assert.ok(!tickerMatchesCollection(null, sox.mve_collection));

// Unique collection match wins even when another parlay is active
{
  const hit = attributeParlay(
    'KXMVESPORTSMULTIGAMEEXTENDED-S-26AUG14CHWMLPITMLBALML',
    { no_price: otherNoBid },
    [sox, other]
  );
  assert.strictEqual(hit && hit.id, 'p-sox');
}

// No collection match → unique active no_bid (within a cent) via fillView
assert.ok(noBidMatchesFill(soxNoBid, 1100));
assert.ok(noBidMatchesFill(soxNoBid + 0.01, 1100)); // within a cent
assert.ok(!noBidMatchesFill(soxNoBid + 0.02, 1100));
{
  const hit = attributeParlay('KXMVEUNKNOWN-XYZ', { no_price: soxNoBid }, [sox, other]);
  assert.strictEqual(hit && hit.id, 'p-sox');
}

// Two active parlays with the same no_bid → unattributed (do not guess)
{
  const twin = { ...other, id: 'p-twin', fill_american: 1100, mve_collection: 'KXMVEOTHER-R' };
  const hit = attributeParlay('KXMVEUNKNOWN-XYZ', { no_price: soxNoBid }, [sox, twin]);
  assert.strictEqual(hit, null);
}

// Inactive parlays are ignored for the no_bid fallback
{
  const inactiveSox = { ...sox, active: false };
  const hit = attributeParlay('KXMVEUNKNOWN-XYZ', { no_price: soxNoBid }, [inactiveSox, other]);
  assert.strictEqual(hit, null);
}

// Ambiguous collection + unique no_bid among those hits
{
  const sameColl = { ...other, id: 'p-same', mve_collection: sox.mve_collection, fill_american: 350 };
  const hit = attributeParlay(
    'KXMVESPORTSMULTIGAMEEXTENDED-S-FOO',
    { no_price: soxNoBid },
    [sox, sameColl]
  );
  assert.strictEqual(hit && hit.id, 'p-sox');
}

// Old "exactly one active parlay" fallback is gone — no invented attribution
{
  const hit = attributeParlay('KXMVEUNKNOWN-XYZ', { no_price: otherNoBid }, [sox]);
  assert.strictEqual(hit, null);
}

// Remaining is max - summed fills; missing max → no remaining
assert.strictEqual(sumFillCounts([{ count: 45.78 }, { count: 704.22 }]), 750);
assert.strictEqual(remainingContracts(2816, 750), 2066);
assert.strictEqual(remainingContracts(2816, 2816), 0);
assert.strictEqual(remainingContracts(2816, 3000), 0);
assert.strictEqual(remainingContracts(null, 750), null);
assert.strictEqual(remainingContracts(0, 750), null);
assert.strictEqual(remainingContracts(2816, null), null);
assert.strictEqual(sumFillCounts(null), null);

const fillRow = {
  fill_id: 'abcde1dff5',
  ticker: 'KXMVESPORTSMULTIGAMEEXTENDED-S-26AUG14CHW',
  action: 'buy',
  count: 704.22,
  outcome_side: 'no',
  no_price: 0.92,
};

{
  const text = formatRealFillAlert({ parlay: sox, row: fillRow, filled: 750 });
  assert.strictEqual(
    text,
    `💰 REAL FILL — ${soxLabel}\n` +
    `buy 704.22 NO @ $0.92\n` +
    `session 750/2816 · 2066 left · fill 1dff5`
  );
}

{
  const text = formatRealFillAlert({ parlay: sox, row: fillRow, filled: null });
  assert.ok(!/session /.test(text));
  assert.ok(!/left/.test(text));
  assert.match(text, /fill 1dff5$/);
}

{
  const noMax = { ...sox, max_contracts: null };
  const text = formatRealFillAlert({ parlay: noMax, row: fillRow, filled: 750 });
  assert.ok(!/session /.test(text));
  assert.ok(!/2066/.test(text));
}

{
  const text = formatRealFillAlert({ parlay: null, row: fillRow });
  assert.strictEqual(
    text,
    `💰 REAL FILL (from Kalshi account) — ${fillRow.ticker}\n` +
    `buy 704.22 contracts · no @ $0.92\n` +
    `unattributed combo fill · fill 1dff5`
  );
  assert.ok(!/session /.test(text));
  assert.ok(!/left/.test(text));
}

console.log('fills-reader.test.js ok');
