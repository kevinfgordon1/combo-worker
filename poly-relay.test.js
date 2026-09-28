'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  ALLOWED_HOSTS,
  CF_1015,
  createPolyRelay,
  createTokenBucket,
  secretsMatch,
  buildUpstreamUrl,
  formatMinuteLine,
} = require('./poly-relay');

const SECRET = 'test-relay-secret-0123456789';

function httpCall({ port, method, path: reqPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: method || 'GET',
      path: reqPath || '/',
      headers: headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body != null) req.end(body);
    else req.end();
  });
}

function authHeaders(host, extra) {
  return Object.assign({
    'X-Poly-Relay-Secret': SECRET,
    'X-Poly-Relay-Host': host || 'api.polymarket.us',
  }, extra || {});
}

assert.deepStrictEqual(ALLOWED_HOSTS, ['api.polymarket.us', 'gateway.polymarket.us']);
assert.strictEqual(buildUpstreamUrl('api.polymarket.us', '/v1/orders'), 'https://api.polymarket.us/v1/orders');
assert.strictEqual(
  buildUpstreamUrl('gateway.polymarket.us', '/v2/leagues/nfl/events?limit=80&active=true&closed=false'),
  'https://gateway.polymarket.us/v2/leagues/nfl/events?limit=80&active=true&closed=false'
);
assert.strictEqual(buildUpstreamUrl('clob.polymarket.com', '/v1/orders'), null);
assert.strictEqual(buildUpstreamUrl('api.polymarket.us.evil.com', '/v1/orders'), null);
assert.strictEqual(buildUpstreamUrl('https://api.polymarket.us', '/v1/orders'), null);
assert.strictEqual(buildUpstreamUrl('api.polymarket.us', '//evil.com/v1'), null);
assert.strictEqual(buildUpstreamUrl('api.polymarket.us', '/v1/foo/../orders'), null);
assert.strictEqual(secretsMatch(SECRET, SECRET), true);
assert.strictEqual(secretsMatch('nope', SECRET), false);
assert.strictEqual(secretsMatch('', SECRET), false);
assert.ok(CF_1015.test('{"error":{"code":1015}}'));
assert.ok(CF_1015.test('Error 1015 Ray ID'));
assert.ok(!CF_1015.test('{"price":1015}'));

{
  const src = fs.readFileSync(path.join(__dirname, 'poly-relay.js'), 'utf8');
  const start = fs.readFileSync(path.join(__dirname, 'start-poly-relay.js'), 'utf8');
  const banned = [
    'live-runner',
    'kalshi-ws',
    'quote-hot',
    'rfq',
    'reserve',
    'fills-reader',
    'fills-attr',
    'kalshi-fill-confirm',
    'start-live',
    'polymarket-auth',
    'polymarket-client',
    'worker-mode',
    'odds-relay',
  ];
  for (const name of banned) {
    assert.ok(!src.includes(`require('./${name}`), name);
    assert.ok(!start.includes(`require('./${name}`), name);
  }
  assert.ok(!/require\('\.\/fills-/.test(src));
  assert.ok(!src.includes('POLYMARKET_SECRET_KEY'));
  assert.ok(!src.includes('POLYMARKET_KEY_ID'));
  assert.ok(src.includes('timingSafeEqual'));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts['start:poly-relay'], 'node start-poly-relay.js');
  assert.ok(pkg.scripts.test.includes('node poly-relay.test.js'));
}

{
  let now = 5_000;
  const full = createTokenBucket({ rate: 15, capacity: 15, now: () => now });
  for (let i = 0; i < 15; i += 1) assert.strictEqual(full.tryTake().ok, true);
  const denied = full.tryTake();
  assert.strictEqual(denied.ok, false);
  assert.ok(denied.retryAfterSec > 0 && denied.retryAfterSec <= 1);
  const bucket = createTokenBucket({ rate: 1, capacity: 1, now: () => now });
  assert.strictEqual(bucket.tryTake().ok, true);
  assert.strictEqual(bucket.tryTake().ok, false);
  now += 1000;
  assert.strictEqual(bucket.tryTake().ok, true);
  assert.strictEqual(bucket.tryTake().ok, false);
}

(async () => {
  const lines = [];
  let calls = 0;
  let upstream = async () => new Response('unused', { status: 500 });
  const relay = createPolyRelay({
    env: {
      POLY_RELAY_SECRET: SECRET,
      POLY_RELAY_RPS: '15',
      POLY_RELAY_BURST: '15',
      POLY_RELAY_MAX_BODY: '1024',
    },
    egressIp: '203.0.113.10',
    logger: (line) => { lines.push(line); },
    fetchImpl: (url, init) => {
      calls += 1;
      return upstream(url, init);
    },
  });
  const addr = await relay.listen(0, '127.0.0.1');
  const port = addr.port;

  const health = await httpCall({ port, path: '/healthz' });
  assert.strictEqual(health.status, 200);
  const healthJson = JSON.parse(health.body);
  assert.strictEqual(healthJson.ok, true);
  assert.strictEqual(healthJson.service, 'poly-relay');
  assert.strictEqual(healthJson.egressIp, '203.0.113.10');
  assert.strictEqual(typeof healthJson.uptimeSec, 'number');
  assert.ok(!health.body.includes(SECRET));
  assert.strictEqual(calls, 0);

  upstream = async () => new Response('{"ok":true}', { status: 200 });
  const missing = await httpCall({
    port,
    path: '/v1/orders',
    headers: { 'X-Poly-Relay-Host': 'api.polymarket.us' },
  });
  assert.strictEqual(missing.status, 401);
  assert.strictEqual(JSON.parse(missing.body).error, 'unauthorized');
  const wrong = await httpCall({
    port,
    path: '/v1/orders',
    headers: authHeaders('api.polymarket.us', { 'X-Poly-Relay-Secret': 'wrong-secret-value-xxxx' }),
  });
  assert.strictEqual(wrong.status, 401);
  assert.ok(!wrong.body.includes(SECRET));
  assert.strictEqual(calls, 0);

  const blocked = [
    '',
    'clob.polymarket.com',
    'gamma-api.polymarket.com',
    'api.polymarket.us.evil.com',
    'https://api.polymarket.us',
    'evil.example',
  ];
  for (const host of blocked) {
    const res = await httpCall({
      port,
      path: '/v1/orders',
      headers: host ? authHeaders(host) : { 'X-Poly-Relay-Secret': SECRET },
    });
    assert.strictEqual(res.status, 403, host || '(missing host)');
    assert.strictEqual(JSON.parse(res.body).error, 'upstream_not_allowed');
  }
  assert.strictEqual(calls, 0);

  const signature = 'abc+def/ghi==SIGVALUE_DO_NOT_LOG_999';
  const orderBody = '{"superSecretOrder":"do-not-log-this-body"}';
  let captured = null;
  upstream = async (url, init) => {
    captured = {
      url,
      method: init.method,
      headers: init.headers,
      redirect: init.redirect,
      body: init.body ? Buffer.from(init.body).toString('utf8') : '',
    };
    return new Response('{"id":"ord_1"}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-upstream': 'yes' },
    });
  };
  const posted = await httpCall({
    port,
    method: 'POST',
    path: '/v1/orders?cursor=abc%3D',
    headers: authHeaders('api.polymarket.us', {
      'X-PM-Access-Key': 'key-id-fixture',
      'X-PM-Timestamp': '1700000000000',
      'X-PM-Signature': signature,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Connection: 'close, x-hop-demo',
      'X-Hop-Demo': 'nope',
      'X-Forwarded-For': '203.0.113.8',
    }),
    body: orderBody,
  });
  assert.strictEqual(posted.status, 200);
  assert.strictEqual(posted.body, '{"id":"ord_1"}');
  assert.strictEqual(posted.headers['x-upstream'], 'yes');
  assert.strictEqual(captured.url, 'https://api.polymarket.us/v1/orders?cursor=abc%3D');
  assert.strictEqual(captured.method, 'POST');
  assert.strictEqual(captured.redirect, 'manual');
  assert.strictEqual(captured.body, orderBody);
  assert.strictEqual(captured.headers['X-PM-Access-Key'], 'key-id-fixture');
  assert.strictEqual(captured.headers['X-PM-Timestamp'], '1700000000000');
  assert.strictEqual(captured.headers['X-PM-Signature'], signature);
  assert.strictEqual(captured.headers['Content-Type'], 'application/json');
  assert.strictEqual(captured.headers['X-Hop-Demo'], undefined);
  assert.strictEqual(captured.headers['x-hop-demo'], undefined);
  assert.strictEqual(captured.headers.Connection, undefined);
  assert.strictEqual(captured.headers.connection, undefined);
  assert.strictEqual(captured.headers['X-Poly-Relay-Secret'], undefined);
  assert.strictEqual(captured.headers['X-Poly-Relay-Host'], undefined);
  assert.strictEqual(captured.headers['X-Forwarded-For'], undefined);
  assert.ok(!JSON.stringify(captured.headers).includes(SECRET));

  upstream = async () => new Response('{"events":[]}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const gateway = await httpCall({
    port,
    path: '/v2/leagues/nfl/events?limit=80&active=true&closed=false',
    headers: authHeaders('gateway.polymarket.us'),
  });
  assert.strictEqual(gateway.status, 200);
  assert.strictEqual(calls, 2);

  let followUps = 0;
  upstream = async (url) => {
    followUps += 1;
    assert.strictEqual(url, 'https://api.polymarket.us/v1/orders');
    return new Response('moved', {
      status: 302,
      headers: { location: 'https://evil.example/steal' },
    });
  };
  const redirected = await httpCall({
    port,
    path: '/v1/orders',
    headers: authHeaders('api.polymarket.us'),
  });
  assert.strictEqual(redirected.status, 302);
  assert.strictEqual(redirected.headers.location, 'https://evil.example/steal');
  assert.strictEqual(followUps, 1);

  upstream = async () => new Response(
    '{"success":false,"error":{"code":1015,"message":"You are being rate limited"}}',
    {
      status: 429,
      headers: { 'retry-after': '7', 'content-type': 'application/json' },
    }
  );
  const limited = await httpCall({
    port,
    method: 'POST',
    path: '/v1/orders',
    headers: authHeaders('api.polymarket.us', { 'Content-Type': 'application/json' }),
    body: '{}',
  });
  assert.strictEqual(limited.status, 429);
  assert.strictEqual(limited.headers['retry-after'], '7');
  assert.ok(limited.body.includes('"code":1015'));
  assert.ok(!limited.body.includes('relay_rate_limited'));

  upstream = async () => new Response('{"error":"slow down"}', {
    status: 429,
    headers: { 'retry-after': '4', 'content-type': 'application/json' },
  });
  const plain = await httpCall({
    port,
    path: '/v1/portfolio/positions',
    headers: authHeaders('api.polymarket.us'),
  });
  assert.strictEqual(plain.status, 429);
  assert.strictEqual(plain.headers['retry-after'], '4');
  assert.strictEqual(plain.body, '{"error":"slow down"}');
  assert.strictEqual(relay.stats.total.upstream429, 2);
  assert.strictEqual(relay.stats.total.cloudflare1015, 1);

  const tooBig = await httpCall({
    port,
    method: 'POST',
    path: '/v1/orders',
    headers: authHeaders('api.polymarket.us', {
      'Content-Type': 'application/json',
      'Content-Length': '2048',
    }),
    body: 'x'.repeat(2048),
  });
  assert.strictEqual(tooBig.status, 413);
  assert.strictEqual(JSON.parse(tooBig.body).error, 'body_too_large');

  const logged = relay.flushMinute();
  assert.ok(logged.requests > 0);
  assert.ok(logged.forwarded >= 4);
  assert.strictEqual(logged.upstream429, 2);
  assert.strictEqual(logged.cloudflare1015, 1);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0], formatMinuteLine(logged));
  assert.ok(!lines[0].includes(signature));
  assert.ok(!lines[0].includes(SECRET));
  assert.ok(!lines[0].includes('do-not-log-this-body'));
  assert.strictEqual(relay.stats.minute.requests, 0);

  await relay.close();

  let now = 20_000;
  let governorCalls = 0;
  const governor = createPolyRelay({
    env: {
      POLY_RELAY_SECRET: SECRET,
      POLY_RELAY_RPS: '1',
      POLY_RELAY_BURST: '1',
    },
    now: () => now,
    logger() {},
    fetchImpl: async () => {
      governorCalls += 1;
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    },
  });
  const gaddr = await governor.listen(0, '127.0.0.1');
  const first = await httpCall({
    port: gaddr.port,
    path: '/v1/orders/open',
    headers: authHeaders('api.polymarket.us'),
  });
  const second = await httpCall({
    port: gaddr.port,
    path: '/v1/orders/open',
    headers: authHeaders('api.polymarket.us'),
  });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body, 'ok');
  assert.strictEqual(second.status, 429);
  assert.strictEqual(second.headers['retry-after'], '1');
  assert.strictEqual(JSON.parse(second.body).error, 'relay_rate_limited');
  assert.strictEqual(governorCalls, 1);
  now += 1000;
  const third = await httpCall({
    port: gaddr.port,
    path: '/v1/orders/open',
    headers: authHeaders('api.polymarket.us'),
  });
  assert.strictEqual(third.status, 200);
  assert.strictEqual(governorCalls, 2);
  await governor.close();

  const capped = createPolyRelay({
    env: { POLY_RELAY_SECRET: SECRET, POLY_RELAY_RPS: '100', POLY_RELAY_BURST: '100' },
    logger() {},
    fetchImpl: async () => new Response('ok'),
  });
  assert.strictEqual(capped.rps, 19);
  assert.strictEqual(capped.burst, 19);
  await capped.close();

  const open = createPolyRelay({
    env: {},
    logger() {},
    fetchImpl: async () => {
      throw new Error('must not be called');
    },
  });
  const oaddr = await open.listen(0, '127.0.0.1');
  const unconfigured = await httpCall({
    port: oaddr.port,
    path: '/v1/orders',
    headers: authHeaders('api.polymarket.us'),
  });
  assert.strictEqual(unconfigured.status, 503);
  assert.strictEqual(JSON.parse(unconfigured.body).error, 'relay_not_configured');
  const stillHealthy = await httpCall({ port: oaddr.port, path: '/healthz' });
  assert.strictEqual(stillHealthy.status, 200);
  await open.close();

  console.log('poly-relay.test.js ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
