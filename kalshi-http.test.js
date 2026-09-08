'use strict';
const assert = require('assert');
const {
  KALSHI_ORIGIN,
  REST_CONNECTIONS,
  QUOTE_CONNECTIONS,
  QUOTE_WARM_MS,
  CONNECT_TIMEOUT_MS,
  HEADERS_TIMEOUT_MS,
  BODY_TIMEOUT_MS,
  kalshiClientOptions,
  createKalshiRestPair,
  isQuoteMutationPath,
} = require('./kalshi-http');

assert.strictEqual(KALSHI_ORIGIN, 'https://external-api.kalshi.com');
assert.ok(REST_CONNECTIONS >= 2, 'background GETs must not share a single socket');
assert.ok(QUOTE_CONNECTIONS >= 3, 'quote pool needs POST + confirm + spare');
assert.ok(QUOTE_WARM_MS <= 20_000, 'warm must beat typical 30s LB idle-kill');
assert.ok(QUOTE_WARM_MS >= 5_000);

{
  const def = kalshiClientOptions();
  assert.strictEqual(def.connections, 1, 'document undici Client default we are escaping');
  assert.strictEqual(def.pipelining, 1);
  assert.strictEqual(def.keepAliveTimeout, 60_000);
  assert.strictEqual(def.keepAliveMaxTimeout, 600_000);
  assert.strictEqual(def.connectTimeout, CONNECT_TIMEOUT_MS);
  assert.strictEqual(def.headersTimeout, HEADERS_TIMEOUT_MS);
  assert.strictEqual(def.bodyTimeout, BODY_TIMEOUT_MS);
  assert.ok(def.connectTimeout <= 3_000, 'dead quote sockets must fail fast');

  const quote = kalshiClientOptions({ connections: QUOTE_CONNECTIONS });
  assert.strictEqual(quote.connections, QUOTE_CONNECTIONS);
  assert.strictEqual(quote.pipelining, 1);

  const rest = kalshiClientOptions({ connections: REST_CONNECTIONS });
  assert.strictEqual(rest.connections, REST_CONNECTIONS);
}

{
  const created = [];
  class FakeClient {
    constructor(origin, opts) {
      this.origin = origin;
      this.opts = opts;
      created.push(this);
    }
  }
  const pair = createKalshiRestPair(FakeClient);
  assert.strictEqual(created.length, 2);
  assert.strictEqual(pair.rest.opts.connections, REST_CONNECTIONS);
  assert.strictEqual(pair.quote.opts.connections, QUOTE_CONNECTIONS);
  assert.notStrictEqual(pair.rest, pair.quote, 'quote POST must not share the GET pool');
  assert.ok(created.every((c) => c.origin === KALSHI_ORIGIN));
}

assert.strictEqual(isQuoteMutationPath('/trade-api/v2/communications/quotes'), true);
assert.strictEqual(
  isQuoteMutationPath('/trade-api/v2/communications/rfqs/abc/quotes/def/confirm'),
  true
);
assert.strictEqual(isQuoteMutationPath('/trade-api/v2/communications/quotes/qid'), true);
assert.strictEqual(isQuoteMutationPath('/trade-api/v2/exchange/status'), false);
assert.strictEqual(isQuoteMutationPath('/trade-api/v2/communications/rfqs/abc'), false);
assert.strictEqual(isQuoteMutationPath('/trade-api/v2/markets'), false);

console.log('kalshi-http.test.js ok');
