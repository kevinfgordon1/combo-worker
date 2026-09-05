'use strict';
const assert = require('assert');
const { sign, authHeaders } = require('./polymarket-auth');
const { createPolymarketHttp, queryString } = require('./polymarket-client');

const SEED_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

assert.strictEqual(queryString({ status: 'RFQ_STATUS_OPEN', limit: 100 }), '?status=RFQ_STATUS_OPEN&limit=100');
assert.strictEqual(queryString({}), '');

(async () => {
  const calls = [];
  const http = createPolymarketHttp({
    keyId: '  key-id-fixture  ',
    secretKey: ` "${SEED_B64}" `,
    requestFn: async (req) => {
      calls.push(req);
      if (req.signMode === 'path' && req.fullPath.includes('status=')) {
        return { statusCode: 401, json: { message: 'invalid signature' }, text: 'invalid signature' };
      }
      return { statusCode: 200, json: { rfqs: [{ id: 'rfq_open' }] } };
    },
  });
  const listed = await http.listRfqs({ status: 'RFQ_STATUS_OPEN', limit: 100 });
  assert.strictEqual((listed.rfqs || []).length, 1);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].signMode, 'path');
  assert.strictEqual(calls[0].signedPath, '/v1/rfqs');
  assert.strictEqual(calls[1].signMode, 'path+query');
  assert.strictEqual(calls[1].signedPath, '/v1/rfqs?status=RFQ_STATUS_OPEN&limit=100');
  assert.strictEqual(http.getSignMode(), 'path+query');
  assert.strictEqual(calls[0].headers['X-PM-Access-Key'], 'key-id-fixture');
  const pathSig = authHeaders({
    keyId: 'key-id-fixture',
    secretKey: SEED_B64,
    method: 'GET',
    path: '/v1/rfqs',
    ts: Number(calls[0].headers['X-PM-Timestamp']),
  })['X-PM-Signature'];
  assert.strictEqual(calls[0].headers['X-PM-Signature'], pathSig);
  const qSig = sign(
    SEED_B64,
    calls[1].headers['X-PM-Timestamp'],
    'GET',
    calls[1].signedPath,
    { includeQuery: true }
  );
  assert.strictEqual(calls[1].headers['X-PM-Signature'], qSig);

  calls.length = 0;
  await http.listRfqs({ status: 'RFQ_STATUS_OPEN', limit: 100 });
  assert.strictEqual(calls.length, 1, 'latched path+query must not retry pathname');
  assert.strictEqual(calls[0].signMode, 'path+query');
  http.close();

  const failCalls = [];
  const failHttp = createPolymarketHttp({
    keyId: 'key-id-fixture',
    secretKey: SEED_B64,
    requestFn: async (req) => {
      failCalls.push(req);
      return {
        statusCode: 401,
        json: { message: `bad key ${SEED_B64}` },
        text: 'unauthorized',
      };
    },
  });
  await assert.rejects(
    () => failHttp.listRfqs({ status: 'RFQ_STATUS_OPEN', limit: 1 }),
    (err) => {
      assert.strictEqual(err.statusCode, 401);
      assert.ok(String(err.message).includes('Polymarket GET /v1/rfqs 401'));
      assert.ok(!String(err.message).includes(SEED_B64), 'must not leak secret');
      assert.strictEqual(err.auth.needsRotate, true);
      return true;
    }
  );
  assert.strictEqual(failCalls.length, 2, 'one pathname 401 then one path+query probe');
  failCalls.length = 0;
  await assert.rejects(() => failHttp.listRfqs({ status: 'RFQ_STATUS_OPEN', limit: 1 }));
  assert.strictEqual(failCalls.length, 1, 'failed query-sign probe must not double every reconcile');
  failHttp.close();

  const userHttp = createPolymarketHttp({
    keyId: 'key-id-fixture',
    secretKey: SEED_B64,
    requestFn: async () => ({ statusCode: 200, json: { rfqUserId: 'rfquser_ok' } }),
  });
  const j = await userHttp.getUserId();
  assert.strictEqual(j.rfqUserId, 'rfquser_ok');
  assert.strictEqual(userHttp.getSignMode(), 'path');
  userHttp.close();

  const headerBag = [];
  const headerHttp = createPolymarketHttp({
    keyId: 'key-id-fixture',
    secretKey: SEED_B64,
    requestFn: async (req) => {
      headerBag.push(req.headers);
      return { statusCode: 200, json: { rfqs: [] } };
    },
  });
  await headerHttp.listRfqs({ status: 'RFQ_STATUS_OPEN', limit: 100 });
  assert.ok(headerBag[0]['X-PM-Access-Key']);
  assert.ok(headerBag[0]['X-PM-Timestamp']);
  assert.ok(headerBag[0]['X-PM-Signature']);
  assert.ok(!('POLY-API-KEY' in headerBag[0]));
  assert.ok(!('account' in headerBag[0]));
  headerHttp.close();

  console.log('polymarket-client.test.js ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
