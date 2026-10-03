'use strict';
// These cases pin the legacy floor-to-tick price (POLY_EXACT_TARGET=0). The exact-target default is covered
// in poly-exact-target.test.js.
process.env.POLY_EXACT_TARGET = '0';
// Polymarket US quote sizing: CreateQuote has no size field, so the venue fills
// the FULL RFQ size. We must never "clip" on Poly; oversized RFQs are declined
// and the confirm-time cap uses the venue-recorded size.
const assert = require('assert');
const fs = require('fs');
const { sumOutstanding } = require('./reserve');
const {
  evaluatePolymarketRfq, quoteBodyFromEval, startPolymarketRfqLoop, acceptedVenueQty,
} = require('./polymarket-rfq');
const { maxPolymarketFillSize } = require('./cap-confirm');

const SEED_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const lock = {
  id: 'lk', user_id: 'u1', label: 'White Sox ML + Pirates ML',
  parlay_stake: 100, parlay_american: 400, fill_american: 350, hedge_mode: '1x', max_contracts: 116,
  leg_keys: ['AEC-MLB-BOS-PIT-2026-08-14-PIT:yes', 'AEC-MLB-CWS-DET-2026-08-14-CWS:yes'],
  legs: [
    { symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'SIDE_BUY' },
    { symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'SIDE_BUY' },
  ],
};
const legs = lock.legs;
const ev = (rfq, over = {}) => evaluatePolymarketRfq({
  rfq: { status: 'RFQ_STATUS_OPEN', comboLegs: legs, ...rfq }, parlays: [lock],
  filledSoFar: 0, outstanding: 0, now: Date.parse('2026-08-14T12:00:00Z'), ...over,
});

// source guard: no clip path, no size field on CreateQuote
const src = fs.readFileSync(require.resolve('./polymarket-rfq.js'), 'utf8');
assert.ok(!/allowPartial:\s*true/.test(src));
assert.ok(!/body\.qtyDecimal/.test(src));

// qty RFQ that fits -> full size, body has only documented fields
const fits = ev({ id: 'a', qtyDecimal: '100' });
assert.strictEqual(fits.action, 'quoteable');
assert.strictEqual(fits.decision.contracts, 100);
assert.strictEqual(fits.decision.partial, false);
assert.deepStrictEqual(Object.keys(quoteBodyFromEval(fits)).sort(), ['buyPrice', 'restRemainder', 'rfqId', 'sellPrice']);

// qty RFQ larger than the lock cap -> declined (was: clipped to 116 and quoted at full size by the venue)
const big = ev({ id: 'b', qtyDecimal: '1000' });
assert.strictEqual(big.action, 'skip');
assert.strictEqual(big.reason, 'rfq_too_large');
assert.strictEqual(big.decision.remaining, 116);

// remaining shrinks with fills / outstanding: 100 > 116-30 -> declined
assert.strictEqual(ev({ id: 'c', qtyDecimal: '100' }, { filledSoFar: 30 }).reason, 'rfq_too_large');
assert.strictEqual(ev({ id: 'c2', qtyDecimal: '100' }, { outstanding: 30 }).reason, 'rfq_too_large');
// exactly equal to remaining still quotes
assert.strictEqual(ev({ id: 'c3', qtyDecimal: '86' }, { filledSoFar: 30 }).action, 'quoteable');

// cash RFQ edge: $200 at 0.222 -> floor(200/0.222)=900 contracts > cap -> declined, never clipped
const cashBig = ev({ id: 'd', cashOrderQty: '200' });
assert.strictEqual(cashBig.action, 'skip');
assert.strictEqual(cashBig.reason, 'rfq_too_large');
// small cash RFQ fits
const cashOk = ev({ id: 'e', cashOrderQty: '10' });
assert.strictEqual(cashOk.action, 'quoteable');
assert.strictEqual(cashOk.decision.contracts, 45);

// per-fill hedge cap (not just remaining) also declines
const lowCap = { ...lock, max_contracts: 100000 };
const hedge = evaluatePolymarketRfq({
  rfq: { id: 'f', status: 'RFQ_STATUS_OPEN', qtyDecimal: '100000', comboLegs: legs }, parlays: [lowCap],
  filledSoFar: 0, outstanding: 0, now: Date.parse('2026-08-14T12:00:00Z'),
});
assert.strictEqual(hedge.reason, 'rfq_too_large');

// venue-recorded size helper
assert.strictEqual(acceptedVenueQty({ quote: { buyQtyDecimal: '566.2', sellQtyDecimal: '0' } }, 'SIDE_BUY'), 566.2);
assert.strictEqual(acceptedVenueQty({ quote: { buyQtyDecimal: '566.2', sellQtyDecimal: '12' } }, 'SIDE_SELL'), 12);
assert.strictEqual(acceptedVenueQty({ quote: {} }, 'SIDE_BUY'), 0);

// confirm-time: venue says the quote is bigger than what is left -> NOT confirmed, quote deleted
(async () => {
  const confirms = [];
  const deletes = [];
  const pending = new Map();
  const logs = [];
  const origWarn = console.warn;
  console.warn = (...a) => logs.push(a.join(' '));
  const loop = startPolymarketRfqLoop({
    env: { POLYMARKET_KEY_ID: 'k', POLYMARKET_SECRET_KEY: SEED_B64, POLYMARKET_RFQ_LIVE: 'true' },
    http: {
      async getUserId() { return {}; }, async listRfqs() { return { rfqs: [] }; },
      async listQuotes() { return { quotes: [] }; }, async getCombo() { return { combos: [] }; },
      async createQuote() { return { quoteId: 'q1' }; },
      async confirmQuote(r, q) { confirms.push([r, q]); return {}; },
      async deleteQuote(r, q) { deletes.push([r, q]); return {}; },
      close() {},
    },
    startWs: false, crawl: false, polyHeartbeatMs: 0,
    getParlays: () => [lock], startedFor: () => ({ started: false }),
    filledSoFarFor: () => 0, getOutstanding: (id, ex) => sumOutstanding(pending, id, ex),
    pendingQuotes: pending, reconcileMs: 3600000,
  });
  try {
    // we booked 100 (fits 116) but the venue recorded 566.2 -> exceeds the cap -> decline
    pending.set('q-venue-big', {
      parlayId: 'lk', contracts: 100, maxContracts: 116, rfqId: 'r1', label: lock.label, cashOrderQty: 150, buyPrice: '0.2650',
    });
    const out = await loop.handleQuoteAccepted({
      quote: { id: 'q-venue-big', rfqId: 'r1', acceptedSide: 'SIDE_BUY', buyQtyDecimal: '566.2' },
    });
    assert.strictEqual(out.confirmed, false);
    assert.strictEqual(out.reason, 'cap_exceeded');
    assert.strictEqual(confirms.length, 0);
    assert.strictEqual(deletes.length, 1);
    assert.ok(logs.some((l) => l.includes('SIZE MISMATCH') && l.includes('venue=566.2')));

    // cash RFQ where cash/price alone exceeds the cap -> decline even if venue size is absent on the event
    pending.set('q-cash-big', {
      parlayId: 'lk', contracts: 100, maxContracts: 116, rfqId: 'r2', label: lock.label, cashOrderQty: 100, buyPrice: '0.2220',
    });
    const out2 = await loop.handleQuoteAccepted({ quote: { id: 'q-cash-big', rfqId: 'r2', acceptedSide: 'SIDE_BUY' } });
    assert.strictEqual(out2.confirmed, false);
    assert.strictEqual(out2.reason, 'cap_exceeded');
    assert.strictEqual(maxPolymarketFillSize({ contracts: 100, cashOrderQty: 100, buyPrice: '0.2220' }, null) > 450, true);

    // a quote that fits (venue size == ours <= remaining) confirms
    pending.set('q-fits', { parlayId: 'lk', contracts: 100, maxContracts: 116, rfqId: 'r3', label: lock.label, rfqQty: 100 });
    const out3 = await loop.handleQuoteAccepted({
      quote: { id: 'q-fits', rfqId: 'r3', acceptedSide: 'SIDE_BUY', buyQtyDecimal: '100' },
    });
    assert.strictEqual(out3.confirmed, true);
    assert.strictEqual(confirms.length, 1);
  } finally {
    console.warn = origWarn;
    loop.stop();
  }
  console.log('poly-quote-size.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
