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
  liveSrc.includes('persistLockTape — not Railway-only') || liveSrc.includes('venue=polymarket'),
  'Kalshi runner comment must document Poly Miss tape writes'
);
assert.ok(
  /status:\s*'filled',[\s\S]*?venue:\s*'kalshi'/.test(liveSrc),
  'Kalshi filled insert-fallback must include venue kalshi'
);
assert.ok(
  /combo_submissions'\)\.insert\(\{[\s\S]*venue:\s*'kalshi'/.test(shadowSrc),
  'shadow-runner Combo Locks inserts must stamp venue kalshi'
);
assert.ok(
  liveSrc.includes('fetchPolymarketUnhedgedRfq'),
  'shared tracker Poly fetchRfq must call fetchPolymarketUnhedgedRfq, not wait for polyLoop'
);
assert.ok(!/polyLoop\.fetchUnhedgedRfq/.test(liveSrc));
assert.ok(
  !/from\('unhedged_rfqs'\)[\s\S]{0,160}\.select\([^)]*market_ticker/.test(liveSrc),
  'live-runner must not select market_ticker from unhedged_rfqs'
);
assert.ok(
  /http:\s*polyUnhedgedHttp \|\| undefined/.test(liveSrc),
  'quoting loop should reuse the same Poly HTTP the fill tracker already has'
);
assert.ok(
  /UNHEDGED_RFQ_LIVE=\$\{isUnhedgedRfqLive\(process\.env\) \? 'on' : 'off'\}/.test(liveSrc),
  'UNHEDGED_RFQ_LIVE must stay off unless explicitly enabled'
);
assert.ok(
  liveSrc.includes('quoteFailureSkipReason'),
  'Kalshi POST/confirm must classify underfunded rejects'
);
assert.ok(
  /if \(quoteFailureSkipReason\(e\.message\)\) \{[\s\S]*?logFundingSkip\(p, rfq, d\)/.test(liveSrc),
  'underfunded Kalshi POST must persist declined + skip_reason, not silent unfilled'
);
assert.ok(
  /logFundingSkip\(p, rfq, d\)/.test(liveSrc) && /logAsync\(p, rfq, d, 'unfilled'\)/.test(liveSrc),
  'non-funding POST fails stay unfilled'
);
assert.ok(
  /persistQuoteSkip\(quoteId, skipReason/.test(liveSrc),
  'underfunded Kalshi confirm must stamp skip_reason on the quoted row'
);
assert.ok(
  /CONFIRM FAILED[\s\S]*?if \(!isSilentQuoteFailure\(e\.message\)\) \{[\s\S]*?sendAlert/.test(liveSrc),
  'underfunded confirm stays off Telegram; other confirm fails still alert'
);
assert.ok(
  /persistQuoteSkip:\s*\(quoteId, skipReason, fallback\) =>\s*persistQuoteSkip\(quoteId, skipReason, fallback\)/.test(liveSrc),
  'Poly loop must receive persistQuoteSkip so confirm can update the attempt'
);

{
  const funded = logAsyncBody(parlay, rfq, { contracts: 10, worst: 2, fillAmerican: 350 }, 'declined', {
    skip_reason: 'insufficient_balance', contracts: 10,
  });
  assert.strictEqual(funded.venue, 'kalshi');
  assert.strictEqual(funded.status, 'declined');
  assert.strictEqual(funded.skip_reason, 'insufficient_balance');
  assert.strictEqual(funded.contracts, 10);

  const polyFunded = polyLogAsyncBody(parlay, rfq, { contracts: 8 }, 'declined', {
    skip_reason: 'insufficient_balance', contracts: 8,
  });
  assert.strictEqual(polyFunded.venue, 'polymarket');
  assert.strictEqual(polyFunded.skip_reason, 'insufficient_balance');
  assert.strictEqual(polyFunded.status, 'declined');
}
assert.ok(
  /lockMiss:\s*0/.test(liveSrc) && /emptyLegs:\s*0/.test(liveSrc),
  'Kalshi tallies must include lockMiss (no parlay) distinct from noLock'
);
assert.ok(
  /if \(!p\) \{[\s\S]*?counts\.lockMiss\+\+/.test(liveSrc),
  'unmatched Kalshi combo RFQs must increment lockMiss, not only shadow unhedged'
);
assert.ok(
  liveSrc.includes('LOCK-MISS'),
  'Kalshi lock misses must log keys so date-only vs HHMM is visible'
);
assert.ok(
  /if \(rfq\.targetCostDollars > 0\) counts\.dollarRfqs\+\+/.test(liveSrc),
  'dollarRfqs must count at combo classification, before matchParlay'
);
assert.ok(
  liveSrc.includes('RFQ-SAMPLE'),
  'first combo RFQs must log contracts/dollar/keys so classification is visible'
);
assert.ok(
  liveSrc.includes('EMPTY-LEGS') && /msgKeys=/.test(liveSrc),
  'first empty-legKey combo RFQs must log raw msg keys (renamed legs field)'
);
{
  const wsSrc = fs.readFileSync(path.join(__dirname, 'kalshi-ws.js'), 'utf8');
  assert.ok(
    /require\('\.\/rfq-debug'\)/.test(wsSrc) && /captureRfq\(env\)/.test(wsSrc),
    'RFQ_DEBUG_NEEDLE capture must be wired inside kalshi-ws (every communications consumer)'
  );
  assert.ok(
    /unexpected-response/.test(wsSrc) && /auth_timestamp/.test(wsSrc),
    'Kalshi WS must reconnect on handshake 401 (ws does not emit close)'
  );
  assert.ok(
    /stalled/.test(wsSrc) && /forceReconnect\('stall'\)/.test(wsSrc),
    'Kalshi WS must force-reconnect when communications goes silent'
  );
  assert.ok(
    !/require\('\.\/rfq-debug'\)/.test(liveSrc),
    'live-runner must not double-fire captureRfq; kalshi-ws owns the hook'
  );
}
assert.ok(
  !/if \(size\.source === 'dollar'\) counts\.dollarRfqs\+\+/.test(liveSrc),
  'do not count dollarRfqs only after a lock match'
);
assert.ok(
  /describeLockOverlap/.test(liveSrc),
  'LOCK-MISS logs should include overlap against staged locks'
);

assert.ok(
  /unhedgedFills\.tick\(\)[\s\S]{0,120}FILL_TICK_MS/.test(liveSrc),
  'unhedged fill tick must not share the 15s skip-tape interval'
);
assert.ok(
  !/unhedgedFills\.tick\(\)[\s\S]{0,80}SKIP_TAPE_TICK_MS/.test(liveSrc)
);

console.log('live-runner.test.js ok');
