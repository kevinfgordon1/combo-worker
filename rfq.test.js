'use strict';
const assert = require('assert');
const {
  normalizeRfq,
  normalizeLeg,
  normalizeLegKey,
  canonicalizeLegKey,
  matchParlay,
  describeLockOverlap,
  parlayKeys,
} = require('./rfq');

function kalshiEnv(id, legs, extra = {}) {
  return {
    type: 'rfq_created',
    msg: {
      id,
      contracts_fp: extra.contracts != null ? extra.contracts : '10.00',
      target_cost_dollars: extra.targetCost,
      mve_collection_ticker: extra.collection || 'KXMVESPORTSMULTIGAMEEXTENDED-R',
      mve_selected_legs: legs,
    },
  };
}

function legsFromKeys(keys) {
  return keys.map((k) => {
    const i = String(k).lastIndexOf(':');
    const ticker = i === -1 ? k : k.slice(0, i);
    const side = i === -1 ? 'yes' : k.slice(i + 1);
    return { side, market_ticker: ticker };
  });
}

const ariJacDateOnly = {
  id: '98d3e355-4a1d-4f60-91ed-a7c1517c60ad',
  label: 'Arizona + Jacksonville',
  leg_keys: [
    'KXNFLGAME-26SEP13ARILAC-ARI:yes',
    'KXNFLGAME-26SEP13CLEJAC-JAC:yes',
  ],
};

const seaPhiLarDateOnly = {
  id: 'sea-phi-lar',
  label: 'SEA + PHI + LAR',
  leg_keys: [
    'KXNFLGAME-26SEP13SEASF-SEA:yes',
    'KXNFLGAME-26SEP13DALPHI-PHI:yes',
    'KXNFLGAME-26SEP13LARHOU-LAR:yes',
  ],
};

const mixedSpreadDateOnly = {
  id: 'mixed-car-ne-cle',
  label: 'Panthers + NE +3.5 + CLE/JAX o40.5',
  leg_keys: [
    'KXNFLGAME-26SEP13CARNE-CAR:yes',
    'KXNFLSPREAD-26SEP13CARNE-NE3:yes',
    'KXNFLTOTAL-26SEP13CLEJAC-40:yes',
  ],
};

// String legs must keep lowercase :yes — previous toUpperCase() made :YES
// and exact-match against Combo Locks failed.
assert.strictEqual(
  normalizeLeg('KXNFLGAME-26SEP13ARILAC-ARI:yes'),
  'KXNFLGAME-26SEP13ARILAC-ARI:yes'
);
assert.strictEqual(
  normalizeLegKey('kxnflgame-26sep13arilac-ari:YES'),
  'KXNFLGAME-26SEP13ARILAC-ARI:yes'
);
assert.strictEqual(
  canonicalizeLegKey('KXNFLGAME-26SEP131330ARILAC-ARI:yes'),
  'KXNFLGAME-26SEP13ARILAC-ARI:yes'
);
assert.strictEqual(
  canonicalizeLegKey('KXNFLGAME-26SEP13ARILAC-ARI:yes'),
  'KXNFLGAME-26SEP13ARILAC-ARI:yes'
);
assert.strictEqual(
  canonicalizeLegKey('KXNFLSPREAD-26SEP131330CARNE-NE3:yes'),
  'KXNFLSPREAD-26SEP13CARNE-NE3:yes'
);

// Exact match still wins (MLB timed tickers on both sides).
{
  const lock = {
    id: 'mlb',
    label: 'CWS + PIT',
    leg_keys: [
      'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
      'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
    ],
  };
  const rfq = normalizeRfq(kalshiEnv('rfq-mlb', legsFromKeys(lock.leg_keys)));
  assert.deepStrictEqual(matchParlay(rfq, [lock]).id, 'mlb');
}

// Production smoking gun: date-only NFL Combo Locks vs timed Kalshi RFQ tickers.
{
  const rfq = normalizeRfq(kalshiEnv('rfq-ari-jac-timed', [
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP131320ARILAC-ARI' },
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP131320CLEJAC-JAC' },
  ]));
  assert.ok(rfq.isCombo);
  assert.ok(rfq.legKeys.length === 2);
  assert.notStrictEqual(
    rfq.legKeys.slice().sort().join('|'),
    ariJacDateOnly.leg_keys.slice().sort().join('|'),
    'timed RFQ keys must differ from date-only lock keys (the bug surface)'
  );
  const hit = matchParlay(rfq, [ariJacDateOnly, seaPhiLarDateOnly]);
  assert.ok(hit);
  assert.strictEqual(hit.id, ariJacDateOnly.id);
}

// SEA+PHI+LAR: three-leg date-only lock vs Sunday 1pm HHMM RFQ.
{
  const rfq = normalizeRfq(kalshiEnv('rfq-sea-phi-lar', [
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP131320SEASF-SEA' },
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP131320DALPHI-PHI' },
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP131320LARHOU-LAR' },
  ]));
  const hit = matchParlay(rfq, [ariJacDateOnly, seaPhiLarDateOnly]);
  assert.strictEqual(hit && hit.id, seaPhiLarDateOnly.id);
}

// Case / missing :side on the lock still matches.
{
  const lock = {
    id: 'ari-jac-bare',
    label: 'Arizona + Jacksonville',
    leg_keys: [
      'KXNFLGAME-26SEP13ARILAC-ARI',
      'KXNFLGAME-26SEP13CLEJAC-JAC',
    ],
  };
  const rfq = normalizeRfq(kalshiEnv('rfq-bare', legsFromKeys(ariJacDateOnly.leg_keys)));
  assert.strictEqual(matchParlay(rfq, [lock]).id, 'ari-jac-bare');
}

// parlay.legs fallback when leg_keys is missing (Combo Locks rows).
{
  const lock = {
    id: 'from-legs',
    label: 'Arizona + Jacksonville',
    legs: [
      { ticker: 'KXNFLGAME-26SEP13ARILAC-ARI', side: 'yes' },
      { ticker: 'KXNFLGAME-26SEP13CLEJAC-JAC', side: 'yes' },
    ],
  };
  assert.deepStrictEqual(parlayKeys(lock).sort(), [
    'KXNFLGAME-26SEP13ARILAC-ARI:yes',
    'KXNFLGAME-26SEP13CLEJAC-JAC:yes',
  ]);
  const rfq = normalizeRfq(kalshiEnv('rfq-from-legs', [
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP131320ARILAC-ARI' },
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP131320CLEJAC-JAC' },
  ]));
  assert.strictEqual(matchParlay(rfq, [lock]).id, 'from-legs');
}

// JAC vs JAX alias via identity (Kalshi JAC vs spoken JAX).
{
  const lockJac = {
    id: 'jac',
    label: 'Arizona + Jacksonville',
    leg_keys: [
      'KXNFLGAME-26SEP13ARILAC-ARI:yes',
      'KXNFLGAME-26SEP13CLEJAC-JAC:yes',
    ],
  };
  const rfqJax = normalizeRfq(kalshiEnv('rfq-jax', [
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP13ARILAC-ARI' },
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP13CLEJAX-JAX' },
  ]));
  assert.strictEqual(matchParlay(rfqJax, [lockJac]).id, 'jac');
}

// Mixed SPREAD/TOTAL: identity cannot parse non-GAME series; HHMM strip must.
{
  const rfq = normalizeRfq(kalshiEnv('rfq-mixed', [
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP131320CARNE-CAR' },
    { side: 'yes', market_ticker: 'KXNFLSPREAD-26SEP131320CARNE-NE3' },
    { side: 'yes', market_ticker: 'KXNFLTOTAL-26SEP131320CLEJAC-40' },
  ]));
  const hit = matchParlay(rfq, [mixedSpreadDateOnly, ariJacDateOnly]);
  assert.strictEqual(hit && hit.id, mixedSpreadDateOnly.id);
}

// Opponent side / different selection must not match.
{
  const rfqOpp = normalizeRfq(kalshiEnv('rfq-opp', [
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP13ARILAC-LAC' },
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP13CLEJAC-CLE' },
  ]));
  assert.strictEqual(matchParlay(rfqOpp, [ariJacDateOnly]), null);
}

// Wrong date must not match.
{
  const rfqWrongDay = normalizeRfq(kalshiEnv('rfq-wrong-day', [
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP14ARILAC-ARI' },
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP14CLEJAC-JAC' },
  ]));
  assert.strictEqual(matchParlay(rfqWrongDay, [ariJacDateOnly]), null);
}

// Ambiguous identical identity → no guess.
{
  const twin = { ...ariJacDateOnly, id: 'twin' };
  const rfq = normalizeRfq(kalshiEnv('rfq-ambig', [
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP131320ARILAC-ARI' },
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP131320CLEJAC-JAC' },
  ]));
  assert.strictEqual(matchParlay(rfq, [ariJacDateOnly, twin]), null);
}

// Empty / missing legs never match (collection-only combo).
{
  const rfq = normalizeRfq({
    type: 'rfq_created',
    msg: {
      id: 'rfq-no-legs',
      contracts_fp: '10.00',
      mve_collection_ticker: 'KXMVE-X',
    },
  });
  assert.ok(rfq.isCombo);
  assert.ok(!rfq.legKeys || !rfq.legKeys.length);
  assert.strictEqual(matchParlay(rfq, [ariJacDateOnly]), null);
}

// Dollar field aliases (docs + AsyncAPI).
{
  const viaAlias = normalizeRfq({
    type: 'rfq_created',
    msg: {
      id: 'rfq-dollar-alias',
      rfq_target_cost_dollars: '25.00',
      mve_collection_ticker: 'KXMVE-X',
      mve_selected_legs: legsFromKeys(ariJacDateOnly.leg_keys),
    },
  });
  assert.strictEqual(viaAlias.contracts, null);
  assert.strictEqual(viaAlias.targetCostDollars, 25);
}

// Overlap helper for LOCK-MISS logs.
{
  const rfq = normalizeRfq(kalshiEnv('rfq-overlap', [
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP131320ARILAC-ARI' },
    { side: 'yes', market_ticker: 'KXNFLGAME-26SEP131320SEAARI-SEA' },
  ]));
  const overlap = describeLockOverlap(rfq, [ariJacDateOnly, seaPhiLarDateOnly]);
  assert.ok(overlap.includes('Arizona + Jacksonville:1/2'));
  assert.ok(!overlap.includes('SEA + PHI + LAR'));
}

console.log('rfq.test.js ok');
