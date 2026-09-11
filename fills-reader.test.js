'use strict';
const assert = require('assert');
const { fillView } = require('./engine');
const {
  tickerMatchesCollection,
  attributeParlay,
  attributeComboFill,
  attributeFromSubmissions,
  sumFillCounts,
  sumAttributedFillCounts,
  remainingContracts,
  formatRealFillAlert,
  noBidMatchesFill,
  liveRunnerFillRow,
  existingFillNeedsParlay,
  submissionFilledPatch,
  canStampSubmission,
  pickFillForSum,
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

// CROSSCATEGORY shard ticker does not match KXMVESPORTSMULTIGAMEEXTENDED-R
{
  const shard = 'KXMVECROSSCATEGORY0-SHARD1-S20260E99CE0B6F9-BD36A940BEC';
  assert.ok(!tickerMatchesCollection(shard, sox.mve_collection));
  const sea = {
    id: 'p-sea',
    label: 'Seattle Seahawks ML + Philadelphia Eagles ML + Los Angeles Rams ML',
    mve_collection: 'KXMVESPORTSMULTIGAMEEXTENDED-R',
    active: true,
    max_contracts: 408,
    fill_american: 290,
  };
  const bears = {
    id: 'p-bears',
    label: 'Chicago Bears ML + Los Angeles Rams ML + Detroit Lions ML',
    mve_collection: 'KXMVESPORTSMULTIGAMEEXTENDED-R',
    active: true,
    max_contracts: 201,
    fill_american: 280,
  };
  const fill = {
    fill_id: '07228709-6229-8235-5047-44b3103ff56b',
    order_id: '01a081a8-4a08-7823-a57f-2273007cd403',
    ticker: shard,
    count: 98,
    no_price: 0.74,
    kalshi_created_time: '2026-09-08T15:34:45.573097Z',
  };
  // +280 no_bid is 0.73 — within a cent of the 0.74 fill, so price is ambiguous.
  assert.ok(noBidMatchesFill(0.74, 290));
  assert.ok(noBidMatchesFill(0.74, 280));
  assert.strictEqual(attributeParlay(shard, fill, [sea, bears]), null);

  // Two locks at +290 → do not guess from price; quote window recovers.
  const twinSea = { ...sea, id: 'p-sea-2', label: 'Seattle twin' };
  assert.strictEqual(attributeParlay(shard, fill, [sea, twinSea]), null);

  const subs = [
    {
      id: 'sub-105',
      parlay_id: 'p-sea',
      quote_id: '23e32a31-748d-4cc5-9bbb-6769ad52a8e1',
      order_id: null,
      contracts: 105,
      status: 'unfilled',
      created_at: '2026-09-08T15:34:43.104357Z',
    },
    {
      id: 'sub-103',
      parlay_id: 'p-sea',
      quote_id: 'cf66e4f4-77c9-43a0-9ec7-c452f8deda44',
      order_id: null,
      contracts: 103,
      status: 'unfilled',
      created_at: '2026-09-08T15:34:40.755887Z',
    },
    {
      id: 'sub-bears',
      parlay_id: 'p-bears',
      quote_id: '227c4eb0-247d-45c1-b6ce-0f1bd555355d',
      order_id: null,
      contracts: 37,
      status: 'unfilled',
      created_at: '2026-09-08T15:34:18.835924Z',
    },
    {
      id: 'sub-declined',
      parlay_id: 'p-bears',
      quote_id: null,
      contracts: 1000,
      status: 'declined',
      created_at: '2026-09-08T15:34:42.000Z',
    },
  ];
  const viaQuotes = attributeFromSubmissions(fill, subs, [sea, bears, twinSea]);
  assert.strictEqual(viaQuotes && viaQuotes.parlay && viaQuotes.parlay.id, 'p-sea');
  assert.strictEqual(viaQuotes.reason, 'quote_window');
  assert.strictEqual(viaQuotes.submission && viaQuotes.submission.id, 'sub-105');

  const viaCombo = attributeComboFill(shard, fill, [sea, twinSea], { submissions: subs });
  assert.strictEqual(viaCombo && viaCombo.parlay && viaCombo.parlay.id, 'p-sea');
  assert.ok(viaCombo.reason === 'quote_window' || viaCombo.reason === 'collection_or_price');

  const stamped = { ...subs[0], order_id: fill.order_id };
  const viaOrder = attributeComboFill(shard, fill, [sea, twinSea], { submissions: [stamped] });
  assert.strictEqual(viaOrder && viaOrder.reason, 'order_id');
  assert.strictEqual(viaOrder.parlay.id, 'p-sea');

  const twin = liveRunnerFillRow({
    quoteId: '23e32a31-748d-4cc5-9bbb-6769ad52a8e1',
    orderId: fill.order_id,
    parlayId: 'p-sea',
    count: 105,
  });
  assert.strictEqual(twin.fill_id, fill.order_id);
  assert.strictEqual(twin.raw.source, 'live-runner');
  assert.strictEqual(twin.raw.venue, 'kalshi');

  const polyTwin = liveRunnerFillRow({
    quoteId: 'OtcRsZDF0D6mfW7LaRSoLOESiNL1BLpPsICTa6Rh2G0',
    orderId: 'poly-order-1',
    fillId: 'poly-exec-1',
    parlayId: 'p-jets',
    count: 107.68,
    venue: 'polymarket',
    rfqId: 'f27cfa32-644a-4b2e-90e8-416d7d99fd74',
    label: 'Jets + Rams + Ravens',
  });
  assert.strictEqual(polyTwin.fill_id, 'poly-exec-1');
  assert.strictEqual(polyTwin.order_id, 'poly-order-1');
  assert.strictEqual(polyTwin.parlay_id, 'p-jets');
  assert.strictEqual(polyTwin.count, 107.68);
  assert.strictEqual(polyTwin.raw.venue, 'polymarket');
  assert.strictEqual(polyTwin.raw.quote_id, 'OtcRsZDF0D6mfW7LaRSoLOESiNL1BLpPsICTa6Rh2G0');
  const viaTwin = attributeComboFill(shard, fill, [sea, twinSea], { existingFills: [twin] });
  assert.strictEqual(viaTwin && viaTwin.reason, 'order_id_fill');
  assert.strictEqual(viaTwin.parlay.id, 'p-sea');

  assert.strictEqual(existingFillNeedsParlay(null, 'p-sea'), true);
  assert.strictEqual(existingFillNeedsParlay({ parlay_id: null }, 'p-sea'), true);
  assert.strictEqual(existingFillNeedsParlay({ parlay_id: 'p-sea' }, 'p-sea'), false);

  const patch = submissionFilledPatch(fill);
  assert.strictEqual(patch.status, 'filled');
  assert.strictEqual(patch.order_id, fill.order_id);
  assert.ok(canStampSubmission(subs[0], fill));
  assert.ok(!canStampSubmission({ id: 'x', status: 'shadow' }, fill));
  assert.ok(!canStampSubmission({ id: 'x', order_id: 'other' }, fill));

  const summed = sumAttributedFillCounts([twin, { ...fill, parlay_id: 'p-sea' }]);
  assert.strictEqual(summed, 98);
  const picked = pickFillForSum([twin, { ...fill, parlay_id: 'p-sea' }]);
  assert.strictEqual(picked.length, 1);
  assert.strictEqual(picked[0].fill_id, fill.fill_id);

  // Two parlays both quoted covering size in-window → do not guess
  const ambiguous = attributeFromSubmissions(fill, [
    ...subs,
    {
      id: 'sub-other',
      parlay_id: 'p-sea-2',
      quote_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      contracts: 100,
      status: 'unfilled',
      created_at: '2026-09-08T15:34:44.000Z',
    },
  ], [sea, twinSea]);
  assert.strictEqual(ambiguous, null);
}

{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'fills-reader.js'), 'utf8');
  assert.ok(!/ignoreDuplicates:\s*true/.test(src), 'must update parlay_id on existing unattributed fill_id');
  assert.ok(/attributeComboFill/.test(src) && /stampSubmissionFilled/.test(src));
  assert.ok(/REATTRIBUTED/.test(src));
  const repair = fs.readFileSync(path.join(__dirname, 'sql/repair_20260908_sea_phi_lar_fill.sql'), 'utf8');
  assert.ok(repair.includes('07228709-6229-8235-5047-44b3103ff56b'));
  assert.ok(repair.includes('01a081a8-4a08-7823-a57f-2273007cd403'));
  assert.ok(repair.includes('2a01055d-4fcb-446e-be1b-19e98984ca3c'));
  assert.ok(repair.includes('bfde99f4-1b12-4244-a84e-a706b439a108'));
}

console.log('fills-reader.test.js ok');
