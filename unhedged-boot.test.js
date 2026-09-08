'use strict';
const assert = require('assert');
const {
  createPolyUnhedgedHttp,
  createUnhedgedVenueFetchers,
  handleKalshiUnhedgedCreated,
  startUnhedgedSide,
} = require('./unhedged-boot');
const { normalizeRfq } = require('./rfq');

assert.strictEqual(createPolyUnhedgedHttp({}), null);
assert.strictEqual(createPolyUnhedgedHttp({ POLYMARKET_KEY_ID: 'x' }), null);

const soxPirates = {
  id: 'lock-1',
  label: 'CWS + PIT',
  legs: [],
  leg_keys: [
    'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
    'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
  ],
};

const lockRfq = normalizeRfq({
  type: 'rfq_created',
  msg: {
    id: 'rfq-lock',
    contracts_fp: '10.00',
    mve_collection_ticker: 'KXMVE-X',
    mve_selected_legs: [
      { side: 'yes', event_ticker: 'KXMLBGAME-26AUG141840CWSDET', market_ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS' },
      { side: 'yes', event_ticker: 'KXMLBGAME-26AUG141840BOSPIT', market_ticker: 'KXMLBGAME-26AUG141840BOSPIT-PIT' },
    ],
  },
});

const missRfq = normalizeRfq({
  type: 'rfq_created',
  msg: {
    id: 'rfq-miss',
    contracts_fp: '8.00',
    mve_collection_ticker: 'KXMVE-Y',
    mve_selected_legs: [
      { side: 'yes', event_ticker: 'KXMLBGAME-26AUG141840NYYBAL', market_ticker: 'KXMLBGAME-26AUG141840NYYBAL-NYY' },
      { side: 'yes', event_ticker: 'KXMLBGAME-26AUG141840TBTEX', market_ticker: 'KXMLBGAME-26AUG141840TBTEX-TB' },
    ],
  },
});

assert.deepStrictEqual(
  handleKalshiUnhedgedCreated({ isCombo: false, contracts: 2 }, { parlays: [soxPirates] }),
  { action: 'skip', reason: 'not_combo' }
);
assert.deepStrictEqual(
  handleKalshiUnhedgedCreated({ isCombo: true }, { parlays: [soxPirates] }),
  { action: 'skip', reason: 'no_size' }
);
assert.deepStrictEqual(
  handleKalshiUnhedgedCreated(lockRfq, { parlays: [soxPirates] }),
  { action: 'skip', reason: 'combo_lock' }
);

(async () => {
  const calls = [];
  const { fetchUnhedgedVenueRfq } = createUnhedgedVenueFetchers({
    fetchKalshiRfq: async (id) => { calls.push(['k-rfq', id]); return { id }; },
    fetchKalshiTrades: async (t) => { calls.push(['k-tr', t]); return [{ t }]; },
    polyHttp: null,
  });
  assert.strictEqual(await fetchUnhedgedVenueRfq('rfq-pm', { venue: 'polymarket' }), null);
  assert.deepStrictEqual(await fetchUnhedgedVenueRfq('rfq-k', { venue: 'kalshi' }), { id: 'rfq-k' });
  assert.deepStrictEqual(calls[0], ['k-rfq', 'rfq-k']);

  const out = handleKalshiUnhedgedCreated(missRfq, {
    parlays: [soxPirates],
    env: { UNHEDGED_RFQ_SHADOW: 'true' },
    persist: async () => {},
  });
  assert.strictEqual(out.action, 'shadow');
  assert.notStrictEqual(out.reason, 'combo_lock');

  let markets = 0;
  const side = startUnhedgedSide({
    supabase: {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          neq() { return this; },
          in() { return this; },
          is() { return this; },
          gte() { return this; },
          lte() { return this; },
          order() { return this; },
          limit() { return Promise.resolve({ data: [], error: null }); },
          update() { return this; },
          insert() { return Promise.resolve({ error: null }); },
        };
      },
    },
    env: { UNHEDGED_RFQ_SHADOW: 'true' },
    autoStart: false,
    autoHydrate: false,
    autoTick: false,
    kalshiGet: async (path) => {
      if (String(path).includes('/markets')) markets += 1;
      return { statusCode: 200, json: { markets: [] } };
    },
  });
  assert.ok(side.prices);
  assert.ok(side.fills);
  assert.strictEqual(typeof side.persist, 'function');
  assert.strictEqual(typeof side.fetchUnhedgedVenueRfq, 'function');
  side.stop();
  assert.strictEqual(markets, 0, 'autoStart=false must not poll /markets');

  console.log('unhedged-boot.test.js ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
