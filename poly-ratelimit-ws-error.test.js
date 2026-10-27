'use strict';
const assert = require('assert');
const { parseRetryAfterMs, sanitizeWsPayload, wsPayloadText, shortWsError, isWsErrorMessage } = require('./polymarket-client');
const { crawlOpenRfqs } = require('./poly-intake');
const { fmtCause } = require('./poly-stall-alert');

(async () => {
  // Retry-After: seconds and HTTP-date
  assert.strictEqual(parseRetryAfterMs('5'), 5000);
  assert.strictEqual(parseRetryAfterMs(null), null);
  const now = Date.parse('2026-10-27T17:00:00Z');
  assert.strictEqual(parseRetryAfterMs('Tue, 27 Oct 2026 17:00:30 GMT', now), 30000);
  assert.strictEqual(parseRetryAfterMs('garbage'), null);

  // Sanitizer never leaks credentials
  const raw = { error: { code: 'RATE_LIMITED', message: 'too many requests' }, apiKey: 'K', headers: { 'X-PM-Access-Signature': 's', Authorization: 'a' }, token: 't' };
  const txt = wsPayloadText(raw);
  for (const bad of ['"K"', '"s"', '"a"', '"t"']) assert.ok(!txt.includes(bad), txt);
  assert.ok(txt.includes('RATE_LIMITED'));
  assert.strictEqual(sanitizeWsPayload(raw).apiKey, '[redacted]');
  assert.ok(isWsErrorMessage(raw));
  assert.ok(!isWsErrorMessage({ subscribed: true }));
  assert.strictEqual(shortWsError(raw), 'RATE_LIMITED too many requests');
  assert.strictEqual(shortWsError({ error: 'boom' }), 'boom');

  // Stall alert text includes the short error
  const cause = fmtCause({ silentMs: 35000, lastMessageType: 'other:error', lastError: 'RATE_LIMITED too many requests', messagesThisConn: 1, ping: { state: 'pong-ok' } });
  assert.ok(cause.includes('error: RATE_LIMITED too many requests'), cause);

  // Crawl: 429 mid-crawl retries same cursor with backoff and widens spacing
  let calls = 0;
  const seenCursors = [];
  const http = {
    async listRfqs(q) {
      calls += 1; seenCursors.push(q.cursor || null);
      if (calls === 2) { const e = new Error('Polymarket GET /v1/rfqs 429'); e.statusCode = 429; e.backoffMs = 3000; throw e; }
      const n = calls; return { rfqs: [{ id: `r${n}` }], cursor: n >= 3 ? null : `c${n}` };
    },
  };
  const sleeps = [];
  const res = await crawlOpenRfqs(http, { pageDelayMs: 1200, sleep: async (ms) => sleeps.push(ms), random: () => 0.5 });
  assert.strictEqual(res.truncated, false);
  assert.strictEqual(res.rows.length, 2);
  assert.strictEqual(res.rateLimited, 1);
  assert.deepStrictEqual(seenCursors, [null, 'c1', 'c1']);
  assert.deepStrictEqual(sleeps, [1200, 3000]); // page delay, then Retry-After wait
  assert.strictEqual(res.pageDelayMs, 2400);

  // Crawl: persistent 429 gives up after max retries and keeps rows
  let c2 = 0;
  const http2 = { async listRfqs() { c2 += 1; if (c2 > 1) { const e = new Error('429'); e.statusCode = 429; throw e; } return { rfqs: [{ id: 'a' }], cursor: 'x' }; } };
  const r2 = await crawlOpenRfqs(http2, { pageDelayMs: 0, sleep: async () => {}, max429Retries: 2 });
  assert.strictEqual(r2.truncated, true);
  assert.strictEqual(r2.rows.length, 1);
  assert.strictEqual(c2, 4);
  assert.strictEqual(r2.error.rateLimited, true);

  // Local limiter drops are not retried (don't queue behind our own budget)
  let c3 = 0;
  const http3 = { async listRfqs() { c3 += 1; if (c3 > 1) { const e = new Error('429'); e.statusCode = 429; e.limiterDrop = true; throw e; } return { rfqs: [{ id: 'a' }], cursor: 'x' }; } };
  const r3 = await crawlOpenRfqs(http3, { pageDelayMs: 0, sleep: async () => {} });
  assert.strictEqual(c3, 2); assert.strictEqual(r3.truncated, true);

  // Activities: spaced pages
  const { listActivitiesForMarketSlugs } = require('./polymarket-fill-reconcile');
  assert.strictEqual(typeof listActivitiesForMarketSlugs, 'function');
  console.log('poly-ratelimit-ws-error tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
