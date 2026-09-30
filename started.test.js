'use strict';
const assert = require('assert');
const { parseTs, parseKalshiTickerStart, findStartedEvent } = require('./started');
const { normalizeRfq } = require('./rfq');

// Sox/Pirates first pitch: ticker 26AUG141840 = 18:40 ET = 22:40 UTC (EDT).
const FIRST_PITCH = Date.parse('2026-08-14T22:40:00Z');
const AFTER = Date.parse('2026-08-14T23:44:00Z'); // when tonight's fills landed
const BEFORE = Date.parse('2026-08-14T22:00:00Z');

assert.strictEqual(parseTs('2026-08-14T22:41:00Z'), Date.parse('2026-08-14T22:41:00Z'));
assert.strictEqual(parseTs(1786752000), 1786752000 * 1000); // unix seconds
assert.strictEqual(parseTs(null), null);

assert.strictEqual(parseKalshiTickerStart('KXMLBGAME-26AUG141840CWSDET-CWS'), FIRST_PITCH);
assert.strictEqual(parseKalshiTickerStart('KXMLBGAME-26AUG141840BOSPIT-PIT:yes'), FIRST_PITCH);
assert.strictEqual(parseKalshiTickerStart('26AUG141840CWSDET'), FIRST_PITCH);
assert.strictEqual(parseKalshiTickerStart('KXMVESPORTSMULTIGAMEEXTENDED-S2026FF44193FD94'), null);

const soxPirates = {
  id: 'ae7a56e8-8ee3-478d-96fa-7c167c20d46e',
  label: 'Chicago White Sox ML + Pittsburgh Pirates ML',
  starts_at: '2026-08-14T22:41:00.000Z',
  legs: [
    { ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS', gameKey: '26AUG141840CWSDET', side: 'yes' },
    { ticker: 'KXMLBGAME-26AUG141840BOSPIT-PIT', gameKey: '26AUG141840BOSPIT', side: 'yes' },
  ],
  leg_keys: [
    'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
    'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
  ],
};

const rfq = normalizeRfq({
  type: 'rfq_created',
  msg: {
    id: 'rfq-sox-pirates',
    contracts_fp: '10.00',
    mve_collection_ticker: 'KXMVE-X',
    mve_selected_legs: [
      { side: 'yes', event_ticker: 'KXMLBGAME-26AUG141840CWSDET', market_ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS' },
      { side: 'yes', event_ticker: 'KXMLBGAME-26AUG141840BOSPIT', market_ticker: 'KXMLBGAME-26AUG141840BOSPIT-PIT' },
    ],
  },
});

// After first pitch: skip (this is the live bug — starts_at was set and unused).
{
  const hit = findStartedEvent(rfq, soxPirates, null, AFTER);
  assert.strictEqual(hit.started, true);
  assert.strictEqual(hit.reason, 'game_started');
  assert.ok(hit.source);
  assert.ok(Date.parse(hit.at) <= AFTER);
}

// Before first pitch: still quotable.
{
  const hit = findStartedEvent(rfq, soxPirates, null, BEFORE);
  assert.strictEqual(hit.started, false);
}

// starts_at exactly now → started (<=).
{
  const at = Date.parse(soxPirates.starts_at);
  const hit = findStartedEvent(null, { starts_at: soxPirates.starts_at }, null, at);
  assert.strictEqual(hit.started, true);
  assert.strictEqual(hit.source, 'parlay.starts_at');
}

// Per-leg commence_time on the lock (even if starts_at is missing / later).
{
  const parlay = {
    starts_at: '2026-08-14T23:59:00.000Z',
    legs: [
      { commence_time: '2026-08-14T22:40:00.000Z', ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS' },
      { commence_time: '2026-08-14T23:10:00.000Z' },
    ],
  };
  const hit = findStartedEvent(null, parlay, null, AFTER);
  assert.strictEqual(hit.started, true);
  assert.match(hit.source, /commence_time/);
}

// Kalshi RFQ explicit start_time (not in captured payloads today; still honored).
{
  const hit = findStartedEvent(
    { isCombo: true },
    { starts_at: '2026-08-15T03:00:00.000Z' },
    { msg: { start_time: '2026-08-14T22:40:00.000Z' } },
    AFTER
  );
  assert.strictEqual(hit.started, true);
  assert.strictEqual(hit.source, 'rfq.start_time');
}

// RFQ leg commence_time.
{
  const hit = findStartedEvent(
    { legs: [{ commence_time: '2026-08-14T22:40:00.000Z' }] },
    { starts_at: '2026-08-15T03:00:00.000Z' },
    null,
    AFTER
  );
  assert.strictEqual(hit.started, true);
  assert.match(hit.source, /rfq\.leg/);
}

// Ticker-only (no starts_at): still skip after first pitch.
{
  const hit = findStartedEvent(rfq, { legs: soxPirates.legs }, null, AFTER);
  assert.strictEqual(hit.started, true);
}

// No times at all → do not block (don't invent a start).
{
  const hit = findStartedEvent({ isCombo: true, legKeys: ['FOO:yes'] }, { label: 'x' }, null, AFTER);
  assert.strictEqual(hit.started, false);
}

// Date-only Polymarket slugs (aec-mlb-…-2026-08-14) are not midnight starts.
{
  const hit = findStartedEvent(
    {
      isCombo: true,
      legKeys: [
        'AEC-MLB-CWS-DET-2026-08-14-CWS:yes',
        'AEC-MLB-BOS-PIT-2026-08-14-PIT:yes',
      ],
    },
    {
      label: 'pm-date-only',
      legs: [
        { symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'yes' },
        { symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'yes' },
      ],
    },
    null,
    AFTER
  );
  assert.strictEqual(hit.started, false);
}

// ANY source started wins — later starts_at cannot override an earlier ticker.
{
  const hit = findStartedEvent(
    rfq,
    { starts_at: '2026-08-15T04:00:00.000Z', legs: soxPirates.legs },
    null,
    AFTER
  );
  assert.strictEqual(hit.started, true);
}

// NHL: KXNHLGAME keys are date-only (26SEP30PITPHI) — no HHMM, so the ticker alone
// never reads as "started". Combo Locks stamps the exact puck drop on parlay.starts_at
// and each leg.starts_at; that is what gates quoting.
{
  assert.strictEqual(parseKalshiTickerStart('KXNHLGAME-26SEP30PITPHI-PHI'), null);
  assert.strictEqual(parseKalshiTickerStart('KXNHLTOTAL-26OCT01TBNYR-7:no'), null);
  assert.strictEqual(parseKalshiTickerStart('KXNHLSPREAD-26OCT01FLASJ-SJ2'), null);
  const PUCK = '2026-09-30T23:30:00.000Z'; // 7:30 PM ET
  const lock = {
    starts_at: PUCK,
    legs: [
      { ticker: 'KXNHLGAME-26SEP30PITPHI-PHI', side: 'yes', gameKey: 'nhl:26SEP30PITPHI', starts_at: PUCK },
      { ticker: 'KXNHLTOTAL-26SEP30LACOL-7', side: 'yes', gameKey: 'nhl:26SEP30LACOL', starts_at: '2026-10-01T02:00:00.000Z' },
    ],
  };
  assert.strictEqual(findStartedEvent(null, lock, null, Date.parse('2026-09-30T23:29:00Z')).started, false);
  const hit = findStartedEvent(null, lock, null, Date.parse('2026-09-30T23:31:00Z'));
  assert.strictEqual(hit.started, true);
  assert.strictEqual(hit.atMs, Date.parse(PUCK));
  // Leg-level stamp alone (older lock without parlay.starts_at) still gates.
  const legOnly = { legs: lock.legs };
  assert.strictEqual(findStartedEvent(null, legOnly, null, Date.parse('2026-09-30T23:31:00Z')).started, true);
  assert.strictEqual(findStartedEvent(null, legOnly, null, Date.parse('2026-09-30T20:00:00Z')).started, false);
}

console.log('started.test.js ok');
