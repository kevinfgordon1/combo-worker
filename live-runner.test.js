'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { withVenue } = require('./skip-tape');

const liveSrc = fs.readFileSync(path.join(__dirname, 'live-runner.js'), 'utf8');
const shadowSrc = fs.readFileSync(path.join(__dirname, 'shadow-runner.js'), 'utf8');

function logAsyncBody(p, rfq, d, status, extra = {}) {
  const contracts =
    extra.contracts != null ? extra.contracts
      : d && d.contracts != null ? d.contracts
        : rfq.contracts != null ? rfq.contracts : null;
  return {
    user_id: p.user_id,
    parlay_id: p.id,
    rfq_id: rfq.rfqId,
    label: p.label,
    fill_american: (d && d.fillAmerican != null) ? d.fillAmerican : p.fill_american,
    contracts,
    worst_lock: d ? d.worst : null,
    status,
    ...withVenue(extra),
  };
}

function polyLogAsyncBody(p, rfq, d, status, extra = {}) {
  return logAsyncBody(p, rfq, d, status, withVenue(extra, 'polymarket'));
}

const parlay = { user_id: 'u1', id: 'p1', label: 'Sox + Pirates', fill_american: 350 };
const rfq = { rfqId: 'rfq-1', contracts: 10 };

{
  const quoted = logAsyncBody(parlay, rfq, { contracts: 10, worst: 2, fillAmerican: 350 }, 'quoted');
  assert.strictEqual(quoted.venue, 'kalshi');
  assert.strictEqual(quoted.rfq_id, 'rfq-1');
  assert.strictEqual(quoted.contracts, 10);

  const skip = logAsyncBody(parlay, rfq, null, 'declined', { skip_reason: 'oversized', contracts: 8000 });
  assert.strictEqual(skip.venue, 'kalshi');
  assert.strictEqual(skip.skip_reason, 'oversized');

  const caller = logAsyncBody(parlay, rfq, null, 'shadow', { venue: 'polymarket' });
  assert.strictEqual(caller.venue, 'polymarket');
}

{
  const quoted = polyLogAsyncBody(parlay, rfq, { contracts: 8 }, 'quoted', {
    quote_id: 'q-pm', is_live: true, contracts: 8,
  });
  assert.strictEqual(quoted.venue, 'polymarket');
  assert.strictEqual(quoted.quote_id, 'q-pm');
  assert.strictEqual(quoted.contracts, 8);

  const shadow = polyLogAsyncBody(parlay, rfq, { contracts: 8 }, 'shadow');
  assert.strictEqual(shadow.venue, 'polymarket');

  const unfilled = polyLogAsyncBody(parlay, rfq, { contracts: 8 }, 'unfilled');
  assert.strictEqual(unfilled.venue, 'polymarket');

  const already = polyLogAsyncBody(parlay, rfq, null, 'declined', { venue: 'polymarket' });
  assert.strictEqual(already.venue, 'polymarket');
}

assert.ok(
  /function logAsync\(p, rfq, d, status, extra = \{\}\) \{[\s\S]*?\.\.\.withVenue\(extra\)/.test(liveSrc),
  'logAsync insert body must stamp venue via withVenue(extra) (kalshi default)'
);
assert.ok(
  /logAsync:\s*\(p, rfq, d, status, extra = \{\}\) =>\s*logAsync\(p, rfq, d, status, withVenue\(extra, 'polymarket'\)\)/.test(liveSrc),
  'Poly loop logAsync wrapper must stamp venue polymarket'
);
assert.ok(
  /status:\s*'filled',[\s\S]*?venue:\s*'kalshi'/.test(liveSrc),
  'Kalshi filled insert-fallback must include venue kalshi'
);
assert.ok(
  /combo_submissions'\)\.insert\(\{[\s\S]*venue:\s*'kalshi'/.test(shadowSrc),
  'shadow-runner Combo Locks inserts must stamp venue kalshi'
);

console.log('live-runner.test.js ok');
