'use strict';
const assert = require('assert');
const { matchTapeTrades, normalizeTrade, formatLostAlert, americanFromProb, formatAmerican, toPriceDollars } = require('./tape');
const { normalizeRfq } = require('./rfq');

function parseTs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const closed = Date.parse('2026-08-12T20:00:00Z');

function n(t) { return normalizeTrade(t, parseTs); }

// dollars fields
assert.strictEqual(toPriceDollars('0.0800', null), 0.08);
assert.strictEqual(toPriceDollars(null, 8), 0.08); // cents
assert.strictEqual(toPriceDollars(null, 0.08), 0.08);

// American odds (engine math)
assert.strictEqual(americanFromProb(0.08), 1150);
assert.strictEqual(formatAmerican(1150), '+1150');
assert.strictEqual(americanFromProb(0.6), -150);

// unique size+time match
{
  const trades = [
    n({ count_fp: '10.00', no_price_dollars: '0.08', yes_price_dollars: '0.92', created_time: '2026-08-12T20:00:02Z' }),
    n({ count_fp: '1.00', no_price_dollars: '0.50', yes_price_dollars: '0.50', created_time: '2026-08-12T20:00:01Z' }),
  ];
  const r = matchTapeTrades(trades, { rfqCount: 10, closedMs: closed });
  assert.strictEqual(r.match, 'matched');
  assert.strictEqual(r.noPrice, 0.08);
  assert.strictEqual(r.count, 10);
}

// closest exact count to close when two same-price prints
{
  const trades = [
    n({ count_fp: '10.00', no_price_dollars: '0.08', yes_price_dollars: '0.92', created_time: '2026-08-12T19:59:50Z' }),
    n({ count_fp: '10.00', no_price_dollars: '0.08', yes_price_dollars: '0.92', created_time: '2026-08-12T20:00:03Z' }),
  ];
  const r = matchTapeTrades(trades, { rfqCount: 10, closedMs: closed });
  assert.strictEqual(r.match, 'matched');
  assert.strictEqual(r.tradeTs, Date.parse('2026-08-12T20:00:03Z'));
}

// ambiguous: same count, different prices
{
  const trades = [
    n({ count_fp: '10.00', no_price_dollars: '0.08', yes_price_dollars: '0.92', created_time: '2026-08-12T20:00:02Z' }),
    n({ count_fp: '10.00', no_price_dollars: '0.09', yes_price_dollars: '0.91', created_time: '2026-08-12T20:00:04Z' }),
  ];
  const r = matchTapeTrades(trades, { rfqCount: 10, closedMs: closed });
  assert.strictEqual(r.match, 'ambiguous');
}

// none: size mismatch
{
  const trades = [
    n({ count_fp: '3.00', no_price_dollars: '0.08', yes_price_dollars: '0.92', created_time: '2026-08-12T20:00:02Z' }),
  ];
  const r = matchTapeTrades(trades, { rfqCount: 10, closedMs: closed });
  assert.strictEqual(r.match, 'none');
}

// no known size: unique print → match; two prices → ambiguous
{
  const one = [n({ count_fp: '7.50', no_price_dollars: '0.11', yes_price_dollars: '0.89', created_time: '2026-08-12T20:00:02Z' })];
  assert.strictEqual(matchTapeTrades(one, { rfqCount: null, closedMs: closed }).match, 'matched');
  const two = [
    n({ count_fp: '7.50', no_price_dollars: '0.11', yes_price_dollars: '0.89', created_time: '2026-08-12T20:00:02Z' }),
    n({ count_fp: '2.00', no_price_dollars: '0.40', yes_price_dollars: '0.60', created_time: '2026-08-12T20:00:03Z' }),
  ];
  assert.strictEqual(matchTapeTrades(two, { rfqCount: null, closedMs: closed }).match, 'ambiguous');
}

// 1% size tolerance
{
  const trades = [n({ count_fp: '10.05', no_price_dollars: '0.08', yes_price_dollars: '0.92', created_time: '2026-08-12T20:00:02Z' })];
  assert.strictEqual(matchTapeTrades(trades, { rfqCount: 10, closedMs: closed }).match, 'matched');
}

// prefer exact count over 1% near-miss at a different price
{
  const trades = [
    n({ count_fp: '10.05', no_price_dollars: '0.50', yes_price_dollars: '0.50', created_time: '2026-08-12T20:00:01Z' }),
    n({ count_fp: '10.00', no_price_dollars: '0.08', yes_price_dollars: '0.92', created_time: '2026-08-12T20:00:04Z' }),
  ];
  const r = matchTapeTrades(trades, { rfqCount: 10, closedMs: closed });
  assert.strictEqual(r.match, 'matched');
  assert.strictEqual(r.noPrice, 0.08);
}

// RFQ block print wins over a same-size ordinary book print at a different price
{
  const trades = [
    n({ count_fp: '10.00', no_price_dollars: '0.50', yes_price_dollars: '0.50', created_time: '2026-08-12T20:00:01Z', is_block_trade: false }),
    n({ count_fp: '10.00', no_price_dollars: '0.92', yes_price_dollars: '0.08', created_time: '2026-08-12T20:00:03Z', is_block_trade: true }),
  ];
  const r = matchTapeTrades(trades, { rfqCount: 10, closedMs: closed });
  assert.strictEqual(r.match, 'matched');
  assert.strictEqual(r.noPrice, 0.92);
  assert.strictEqual(r.trade.isBlockTrade, true);
}

// only book prints (flag present, all false) → fall back and match by size/time
{
  const trades = [
    n({ count_fp: '10.00', no_price_dollars: '0.92', yes_price_dollars: '0.08', created_time: '2026-08-12T20:00:02Z', is_block_trade: false }),
  ];
  const r = matchTapeTrades(trades, { rfqCount: 10, closedMs: closed });
  assert.strictEqual(r.match, 'matched');
  assert.strictEqual(r.noPrice, 0.92);
}

// $1 combo print shape: ~9.31 count, non-block, near RFQ close
{
  const trades = [
    n({ count_fp: '9.31', no_price_dollars: '0.8990', yes_price_dollars: '0.1010', created_time: '2026-08-12T22:10:01.336863Z', is_block_trade: false }),
  ];
  const r = matchTapeTrades(trades, { rfqCount: 9, closedMs: Date.parse('2026-08-12T22:10:01Z') });
  assert.strictEqual(r.match, 'matched');
  assert.strictEqual(r.yesPrice, 0.101);
  assert.strictEqual(r.noPrice, 0.899);
}

// multiple block prints at the same size but different prices → ambiguous
{
  const trades = [
    n({ count_fp: '10.00', no_price_dollars: '0.92', yes_price_dollars: '0.08', created_time: '2026-08-12T20:00:02Z', is_block_trade: true }),
    n({ count_fp: '10.00', no_price_dollars: '0.91', yes_price_dollars: '0.09', created_time: '2026-08-12T20:00:04Z', is_block_trade: true }),
    n({ count_fp: '10.00', no_price_dollars: '0.50', yes_price_dollars: '0.50', created_time: '2026-08-12T20:00:03Z', is_block_trade: false }),
  ];
  assert.strictEqual(matchTapeTrades(trades, { rfqCount: 10, closedMs: closed }).match, 'ambiguous');
}

// two block prints at the same price: pick closest to RFQ close
{
  const trades = [
    n({ count_fp: '10.00', no_price_dollars: '0.92', yes_price_dollars: '0.08', created_time: '2026-08-12T19:59:50Z', is_block_trade: true }),
    n({ count_fp: '10.00', no_price_dollars: '0.92', yes_price_dollars: '0.08', created_time: '2026-08-12T20:00:03Z', is_block_trade: true }),
  ];
  const r = matchTapeTrades(trades, { rfqCount: 10, closedMs: closed });
  assert.strictEqual(r.match, 'matched');
  assert.strictEqual(r.tradeTs, Date.parse('2026-08-12T20:00:03Z'));
}

// alert text
{
  const text = formatLostAlert({
    label: 'BOS/BAL/HOU',
    rfqId: 'abc',
    lossReason: 'outbid',
    tape: { match: 'matched', noPrice: 0.92, yesPrice: 0.08, count: 10 },
    ourNo: 0.91,
  });
  assert.ok(text.includes('LOST (outbid)'));
  assert.ok(text.includes('Tape: NO @ $0.92 (~YES +1150) · 10 contracts'));
  assert.ok(text.includes('Our quote was NO @ $0.91'));
}
{
  const text = formatLostAlert({ label: 'X', rfqId: 'r', lossReason: 'outbid', tape: { match: 'none' }, ourNo: 0.07 });
  assert.ok(text.includes('No clean tape match'));

{
  const text = formatLostAlert({ label: 'X', rfqId: 'r', lossReason: 'no_purchase', tape: { match: 'none' }, ourNo: 0.07 });
  assert.ok(text.includes('LOST (no_purchase)'));
  assert.ok(text.includes('No purchase'));
}
}

{
  const rfq = normalizeRfq({
    type: 'rfq_created',
    msg: { id: 'rfq-1', market_ticker: 'KXMVE-ABC', contracts_fp: '10.00' },
  });
  assert.strictEqual(rfq.marketTicker, 'KXMVE-ABC');
  assert.strictEqual(rfq.contracts, 10);
  const rfq2 = normalizeRfq({ msg: { id: 'rfq-2', ticker: 'FALLBACK', contracts: 3 } });
  assert.strictEqual(rfq2.marketTicker, 'FALLBACK');
  assert.strictEqual(rfq2.contracts, 3);
}

console.log('tape.test.js ok');
