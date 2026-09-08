'use strict';
const assert = require('assert');
const { generateKeyPairSync } = require('crypto');
const crypto = require('crypto');
const {
  applyServerDate,
  applyResponseDate,
  resetClockOffset,
  clockOffset,
  signedNow,
  authHeaders,
  isTimestampExpired,
  signedRequest,
  DATE_NOISE_MS,
  privateKeyObject,
  sign,
} = require('./kalshi-auth');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });

function dateUtc(ms) {
  return new Date(ms).toUTCString();
}

{
  resetClockOffset();
  const now = Date.now();
  const offset = applyServerDate(dateUtc(now));
  assert.strictEqual(offset, 0, 'Date for "now" must not invent a clock offset');
  assert.strictEqual(clockOffset(), 0);
  const ts = Number(authHeaders({
    keyId: 'k', pem: PEM, method: 'POST', signPath: '/trade-api/v2/communications/quotes',
  })['KALSHI-ACCESS-TIMESTAMP']);
  assert.ok(Math.abs(ts - Date.now()) < 50, `signed ts should track Date.now(), got drift ${ts - Date.now()}`);
}

{
  resetClockOffset();
  // PR #61 used server - Date.now(), which is ~-0..-999ms for a healthy clock.
  // That past-skew is what expired live quote POSTs after the WS Date sync.
  applyServerDate(dateUtc(Date.now() - 800));
  assert.strictEqual(clockOffset(), 0, 'sub-second Date truncation must not apply a negative offset');
}

{
  resetClockOffset();
  const past = dateUtc(Date.now() - 12_000);
  const offset = applyServerDate(past);
  assert.ok(offset < -8000, `expected negative offset for 12s-slow Date, got ${offset}`);
  const ts = Number(authHeaders({
    keyId: 'k', pem: PEM, method: 'GET', signPath: '/trade-api/ws/v2',
  })['KALSHI-ACCESS-TIMESTAMP']);
  assert.ok(Math.abs(ts - signedNow()) < 50);
  resetClockOffset();
}

{
  resetClockOffset();
  const future = dateUtc(Date.now() + 12_000);
  const offset = applyServerDate(future);
  assert.ok(offset > 8000, `expected positive offset for 12s-fast Date, got ${offset}`);
  resetClockOffset();
}

{
  resetClockOffset();
  applyServerDate(dateUtc(Date.now() - 12_000));
  assert.ok(clockOffset() < -8000);
  applyResponseDate({ date: dateUtc(Date.now()) });
  assert.strictEqual(clockOffset(), 0, 'Date that agrees with local must clear a stale offset');
}

{
  assert.strictEqual(isTimestampExpired(401, '{"error":{"code":"header_timestamp_expired"}}'), true);
  assert.strictEqual(isTimestampExpired(401, 'header timestamp expired'), true);
  assert.strictEqual(isTimestampExpired(401, '{"error":{"code":"invalid_signature"}}'), false);
  assert.strictEqual(isTimestampExpired(400, 'header_timestamp_expired'), false);
  assert.ok(DATE_NOISE_MS >= 1000);
}

{
  const first = privateKeyObject(PEM);
  const second = privateKeyObject(PEM);
  assert.strictEqual(first, second, 'PEM must parse once and reuse the KeyObject');
  const ts = 1_700_000_000_000;
  const sig = sign(PEM, ts, 'POST', '/trade-api/v2/communications/quotes');
  const msg = String(ts) + 'POST' + '/trade-api/v2/communications/quotes';
  const ok = crypto.verify(
    'sha256',
    Buffer.from(msg, 'utf8'),
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    },
    Buffer.from(sig, 'base64')
  );
  assert.ok(ok, 'cached KeyObject must produce a valid RSA-PSS signature');
}

async function runAsync() {
  resetClockOffset();
  const calls = [];
  const res = await signedRequest(async ({ headers, method, path }) => {
    calls.push({
      method,
      path,
      ts: headers['KALSHI-ACCESS-TIMESTAMP'],
    });
    if (calls.length === 1) {
      return {
        statusCode: 401,
        headers: { date: dateUtc(Date.now()) },
        text: '{"error":{"code":"header_timestamp_expired","message":"header timestamp expired"}}',
      };
    }
    return { statusCode: 201, headers: { date: dateUtc(Date.now()) }, text: '{"id":"q1"}' };
  }, {
    keyId: 'k',
    pem: PEM,
    method: 'POST',
    signPath: '/trade-api/v2/communications/quotes',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.strictEqual(calls.length, 2, 'timestamp 401 must retry once');
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.text, '{"id":"q1"}');
  assert.ok(calls[0].ts);
  assert.ok(calls[1].ts);
  assert.ok(Number(calls[1].ts) >= Number(calls[0].ts), 'retry must resign immediately before send');
  assert.strictEqual(clockOffset(), 0);

  resetClockOffset();
  let once = 0;
  const ok = await signedRequest(async () => {
    once += 1;
    return { statusCode: 200, headers: {}, text: '{}' };
  }, { keyId: 'k', pem: PEM, method: 'GET', signPath: '/trade-api/v2/exchange/status' });
  assert.strictEqual(once, 1, 'success must not retry');
  assert.strictEqual(ok.statusCode, 200);

  resetClockOffset();
  let bad = 0;
  const stillBad = await signedRequest(async () => {
    bad += 1;
    return {
      statusCode: 401,
      headers: { date: dateUtc(Date.now() - 12_000) },
      text: '{"error":{"code":"header_timestamp_expired"}}',
    };
  }, { keyId: 'k', pem: PEM, method: 'POST', signPath: '/trade-api/v2/communications/quotes' });
  assert.strictEqual(bad, 2, 'expired 401 retries only once');
  assert.strictEqual(stillBad.statusCode, 401);
  assert.ok(clockOffset() < -8000, 'retry still applies Date from the failed response');

  console.log('kalshi-auth.test.js ok');
}

runAsync().catch((e) => {
  console.error(e);
  process.exit(1);
});
