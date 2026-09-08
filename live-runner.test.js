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
assert.ok(!/polyLoop\.fetchUnhedgedRfq/.test(liveSrc));
assert.ok(
  !/from\('unhedged_rfqs'\)[\s\S]{0,160}\.select\([^)]*market_ticker/.test(liveSrc),
  'live-runner must not select market_ticker from unhedged_rfqs'
);
assert.ok(
  /enableUnhedged:\s*runUnhedged/.test(liveSrc) &&
    /http:\s*\(runUnhedged && polyUnhedgedHttp\) \|\| undefined/.test(liveSrc),
  'Poly quoting loop gets unhedged HTTP only when WORKER_MODE=all'
);
assert.ok(
  /UNHEDGED_RFQ_LIVE=\$\{isUnhedgedRfqLive\(process\.env\) \? 'on' : 'off'\}/.test(liveSrc),
  'UNHEDGED_RFQ_LIVE must stay off unless explicitly enabled'
);
assert.ok(
  /require\('\.\/worker-mode'\)/.test(liveSrc) &&
    /shouldRunUnhedged\(process\.env\)/.test(liveSrc),
  'Combo Locks must resolve WORKER_MODE before scheduling unhedged work'
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
    /require\('\.\/rfq-debug'\)/.test(wsSrc) &&
      /setImmediate\(\(\) => \{ try \{ capture\(env\)/.test(wsSrc),
    'RFQ_DEBUG_NEEDLE capture must be wired inside kalshi-ws off the WS tick'
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
  /signedRequest/.test(liveSrc) && /function kalshiSigned\(/.test(liveSrc),
  'Combo Locks Kalshi REST must go through signedRequest (fresh ts + timestamp retry)'
);
assert.ok(
  /kalshiSigned\('POST', QUOTE_PATH/.test(liveSrc),
  'postQuote must sign immediately via kalshiSigned, not a pre-built timestamp'
);
assert.ok(
  /kalshiSigned\('PUT', path/.test(liveSrc) && /kalshiSigned\('DELETE', path/.test(liveSrc),
  'confirm and cancel must share the same signed REST helper as quote POST'
);
assert.ok(
  /kalshiSigned\('GET', WARM_PATH/.test(liveSrc) && /kalshiSigned\('GET', path/.test(liveSrc),
  'warm + GET must apply the same clock offset / retry as quote POST'
);
assert.ok(
  !/authHeaders\(\{ keyId: KEY_ID, pem: PEM, method: 'POST'/.test(liveSrc),
  'do not sign quote POST outside signedRequest (timestamp would age before send)'
);

assert.ok(
  /RETAINED after soft-fail/.test(liveSrc),
  'live refresh must log RETAINED + lock labels when parlays query soft-fails'
);
assert.ok(
  /require\('\.\/refresh-state'\)/.test(liveSrc) && /applyRefreshParlays/.test(liveSrc),
  'live refresh must apply parlays/settings/fills via refresh-state (keep prior on soft-fail)'
);
assert.ok(
  !/parlays = p \|\| \[\]/.test(liveSrc),
  'live refresh must not coerce null parlays data to []'
);
assert.ok(
  /applyRefreshKillByUser/.test(liveSrc) && /applyRefreshFilledByParlay/.test(liveSrc),
  'live refresh must keep killByUser / filledByParlay when those queries soft-fail'
);
assert.ok(
  /require\('\.\/refresh-state'\)/.test(shadowSrc) && /applyRefreshParlays/.test(shadowSrc),
  'shadow refresh must use the same soft-fail keep-previous helpers'
);
assert.ok(
  /RETAINED after soft-fail/.test(shadowSrc),
  'shadow refresh must log RETAINED when parlays query soft-fails'
);
assert.ok(
  !/parlays = p \|\| \[\]/.test(shadowSrc),
  'shadow refresh must not coerce null parlays data to []'
);
assert.ok(
  /require\('\.\/rfq-repeat'\)/.test(liveSrc) &&
    /cooldownFingerprint\(rfq\)/.test(liveSrc) &&
    /cooldownFp \? repeatGuard\.peek\(cooldownFp\)/.test(liveSrc),
  'Kalshi quote path must peek cooldown only when creator_id is known'
);
assert.ok(
  /peeked\.skip \? repeatGuard\.noteSkip\(cooldownFp\)/.test(liveSrc),
  'repeat skip must noteSkip without claiming a new window'
);
assert.ok(
  /if \(cooldownFp\) repeatGuard\.claim\(cooldownFp\)/.test(liveSrc) &&
    /await postQuote\(rfq\.rfqId/.test(liveSrc),
  'creator-gated cooldown starts only after a successful quote POST'
);
assert.ok(
  liveSrc.indexOf('await postQuote(rfq.rfqId') < liveSrc.indexOf('if (cooldownFp) repeatGuard.claim(cooldownFp)'),
  'claim must sit after postQuote so 409 rfq_closed cannot start the 90s skip'
);
assert.ok(
  /skipReason:\s*REPEAT_SKIP_REASON/.test(liveSrc) && liveSrc.includes('rfq_fingerprint'),
  'repeat skips must persist skip_reason=rfq_repeat + rfq_fingerprint'
);
assert.ok(
  /if \(claimed\.alert\) \{[\s\S]*?sendAlert\(formatRepeatSkipAlert/.test(liveSrc),
  'Telegram only when creator-gated cooldown applies — not every repeat tick'
);
assert.ok(
  /RFQ_REPEAT_COOLDOWN_MS/.test(liveSrc) && /rfqRepeat:\s*0/.test(liveSrc),
  'cooldown must be env-tunable and tallied'
);
assert.ok(
  /creator-gated/.test(liveSrc) && /empty creator_id always quotes/.test(liveSrc),
  'startup log must say anonymous RFQs still quote'
);
assert.ok(
  /creatorIdFromQuoteResponse\(result\)/.test(liveSrc) &&
    /await postQuote\(rfq\.rfqId/.test(liveSrc),
  'REST rfq_creator_id is stored after a successful POST, not before'
);
assert.ok(
  /http: kalshiQuoteHttp/.test(liveSrc) &&
    /createKalshiRestPair/.test(liveSrc),
  'quote POST/confirm/cancel must use the dedicated quote HTTP client'
);
assert.ok(
  /kalshiSigned\('POST', QUOTE_PATH[\s\S]*?http: kalshiQuoteHttp/.test(liveSrc),
  'postQuote must send on kalshiQuoteHttp, not the GET pool'
);
assert.ok(
  /kalshiSigned\('PUT', path[\s\S]*?http: kalshiQuoteHttp/.test(liveSrc) &&
    /kalshiSigned\('DELETE', path, \{ http: kalshiQuoteHttp \}/.test(liveSrc),
  'confirm and cancel share the quote client'
);
assert.ok(
  /warmOne\(kalshiHttp, 'rest'\)/.test(liveSrc) &&
    /warmOne\(kalshiQuoteHttp, 'quote'\)/.test(liveSrc),
  'both REST pools must be warmed so the first quote POST is not a cold TLS'
);
assert.ok(
  /if \(runUnhedged\) \{[\s\S]*?setImmediate\(\(\) => \{[\s\S]*?shadowUnhedgedMiss\(missRfq/.test(liveSrc),
  'unhedged miss persist is WORKER_MODE=all only and must yield so a lock can POST first'
);
assert.ok(
  /setImmediate\(\(\) => \{[\s\S]*?RFQ-SAMPLE/.test(liveSrc) &&
    /setImmediate\(\(\) => \{[\s\S]*?EMPTY-LEGS/.test(liveSrc) &&
    /setImmediate\(\(\) => \{[\s\S]*?describeLockOverlap/.test(liveSrc),
  'RFQ-SAMPLE / EMPTY-LEGS / LOCK-MISS logs must not run on the quote tick'
);
assert.ok(
  /function unlessQuoteHot\(/.test(liveSrc) &&
    /setInterval\(unlessQuoteHot\(\(\) => \{ refresh\(\); \}\)/.test(liveSrc) &&
    /setInterval\(unlessQuoteHot\(\(\) => \{[\s\S]*?cancelUnacceptedQuotes/.test(liveSrc) &&
    /setInterval\(unlessQuoteHot\(\(\) => \{[\s\S]*?reconcileSkipTapes/.test(liveSrc),
  'refresh / cancel / skip-tape must pause while quote-hot'
);
assert.ok(
  !/setInterval\(unlessQuoteHot\(\(\) => \{[\s\S]*?unhedgedFills\.tick/.test(liveSrc),
  'combo default must not schedule unhedged fill ticks on the Combo Locks timer'
);
assert.ok(
  /if \(runUnhedged\) \{[\s\S]*?startUnhedgedSide\(/.test(liveSrc) &&
    /shouldPause:\s*\(\) => quoteHot\.inFlight/.test(liveSrc),
  'WORKER_MODE=all still boots unhedged via startUnhedgedSide and pauses /markets while quote-hot'
);
assert.ok(
  /Unhedged \/markets, fill ticks, and shadow miss are off/.test(liveSrc),
  'combo default startup log says unhedged is a separate Railway job'
);
assert.ok(
  /WORKER_MODE=unhedged — use start-unhedged/.test(liveSrc),
  'live-runner must refuse WORKER_MODE=unhedged (wrong entrypoint)'
);
assert.ok(
  /skip_reason: 'rfq_closed'/.test(liveSrc) &&
    /QUOTE LATE/.test(liveSrc) &&
    /formatQuoteLatency/.test(liveSrc) &&
    /isRfqClosedFailure/.test(liveSrc),
  '409 rfq_closed must persist skip_reason, log QUOTE LATE with [LAT] ms'
);
assert.ok(
  /✅ QUOTED[\s\S]*?match→POST \$\{totalMs\}ms/.test(liveSrc) &&
    /❌ QUOTE LATE[\s\S]*?match→POST \$\{totalMs\}ms/.test(liveSrc),
  'QUOTED and QUOTE LATE Telegram both include match→POST total ms'
);
assert.ok(
  /require\('\.\/kalshi-http'\)/.test(liveSrc) &&
    !/new Client\('https:\/\/external-api\.kalshi\.com'/.test(liveSrc),
  'do not construct a single shared undici Client for all Kalshi REST'
);
assert.ok(
  !/await fetchSkipRfq\(rfq\.rfqId\)/.test(liveSrc.split('async function onRfq')[1] || ''),
  'first quote must not wait on REST GET for creator_id'
);
assert.ok(
  !/require\('\.\/quote-watcher'\)/.test(liveSrc),
  'quote-watcher stays parked'
);
assert.ok(
  /require\('\.\/quote-hot'\)/.test(liveSrc) &&
    /createQuoteHot/.test(liveSrc) &&
    /lockNeedlesFromParlays/.test(liveSrc),
  'quote-hot needles + in-flight tracker must be wired'
);
assert.ok(
  /shouldDeferCreated:\s*\(raw\) => quoteHot\.shouldDeferCreated\(raw\)/.test(liveSrc),
  'Kalshi WS must defer unmatched firehose frames while a quote POST is in flight'
);
assert.ok(
  /function withQuoteHot\(/.test(liveSrc) &&
    /return withQuoteHot\(async \(\) => \{/.test(liveSrc),
  'quote POST and confirm must mark quote-hot so the firehose yields'
);
assert.ok(
  liveSrc.indexOf('async function postQuote') < liveSrc.indexOf('async function confirmQuote') &&
    /async function postQuote[\s\S]*?withQuoteHot[\s\S]*?async function confirmQuote[\s\S]*?withQuoteHot/.test(liveSrc),
  'both POST and confirm wrap withQuoteHot'
);
assert.ok(
  /if \(!quoteHot\.inFlight\) tasks\.push\(warmOne\(kalshiQuoteHttp, 'quote'\)\)/.test(liveSrc),
  'do not steal the quote pool for a warm GET during POST/confirm'
);
assert.ok(
  /setInterval\(warmConnection, QUOTE_WARM_MS\)/.test(liveSrc) &&
    /QUOTE_WARM_MS/.test(liveSrc),
  'quote pool warm must use QUOTE_WARM_MS (15s), not a 45s idle gap'
);
assert.ok(
  /quoteHot\.setNeedles\(lockNeedlesFromParlays\(parlays\)\)/.test(liveSrc),
  'refresh must restage lock needles after parlays apply'
);
assert.ok(
  !/setInterval\(warmConnection, 45000\)/.test(liveSrc),
  '45s warm left a dead quote socket for the next auction'
);
assert.ok(
  !/require\('\.\/rfq-repeat'\)/.test(fs.readFileSync(path.join(__dirname, 'polymarket-rfq.js'), 'utf8')),
  'Poly path is not wired unless the same spam pattern appears'
);

assert.ok(
  !/unhedgedFills\.tick\(\)[\s\S]{0,80}SKIP_TAPE_TICK_MS/.test(liveSrc)
);
assert.ok(
  /enableLocks:\s*true/.test(liveSrc) &&
    !/enableUnhedged:\s*true/.test(liveSrc),
  'Combo Locks Poly path keeps lock quoting; unhedged is env-gated not hard-on'
);

console.log('live-runner.test.js ok');
