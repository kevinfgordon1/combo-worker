'use strict';
const assert = require('assert');
const { sign, authHeaders } = require('./polymarket-auth');
const { createPolymarketHttp, queryString, parsePrivateMessage } = require('./polymarket-client');

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

  const snakeFill = parsePrivateMessage(JSON.stringify({
    request_id: 'order-sub-1',
    subscription_type: 1,
    order_subscription_update: {
      execution: {
        id: 'exec-456',
        type: 2,
        last_shares: '50',
        trade_id: 'trade-789',
        order: { id: 'order-123', quote_id: 'quote-abc' },
      },
    },
  }));
  assert.strictEqual(snakeFill.type, 'orderExecution');
  assert.strictEqual(snakeFill.execution.type, 2);
  assert.strictEqual(snakeFill.execution.last_shares, '50');
  assert.strictEqual(snakeFill.execution.order.quote_id, 'quote-abc');
  assert.strictEqual(snakeFill.executions.length, 1);

  const camelFill = parsePrivateMessage({
    orderSubscriptionUpdate: {
      execution: { type: 'EXECUTION_TYPE_PARTIAL_FILL', lastShares: '10', order: { id: 'o1' } },
    },
  });
  assert.strictEqual(camelFill.type, 'orderExecution');
  assert.strictEqual(camelFill.execution.type, 'EXECUTION_TYPE_PARTIAL_FILL');

  const many = parsePrivateMessage({
    order_subscription_update: {
      executions: [
        { type: 1, last_shares: 20, order: { id: 'o1' } },
        { type: 2, last_shares: 30, order: { id: 'o1' } },
      ],
    },
  });
  assert.strictEqual(many.executions.length, 2);
  assert.strictEqual(many.execution.type, 1);

  assert.strictEqual(parsePrivateMessage({ ping: true }).type, 'other');

  const bareExec = parsePrivateMessage({
    type: 2,
    last_shares: '12',
    order: { id: 'order-bare', quote_id: 'quote-bare' },
  });
  assert.strictEqual(bareExec.type, 'orderExecution');
  assert.strictEqual(bareExec.execution.order.quote_id, 'quote-bare');

  const orderCalls = [];
  const orderHttp = createPolymarketHttp({
    keyId: 'key-id-fixture',
    secretKey: SEED_B64,
    requestFn: async (req) => {
      orderCalls.push(req);
      if (req.path.endsWith('/missing')) return { statusCode: 404, json: null, text: '' };
      return { statusCode: 200, json: { order: { id: 'o1', cumQuantity: 10, state: 'ORDER_STATE_FILLED' } } };
    },
  });
  const missing = await orderHttp.getOrder('missing');
  assert.strictEqual(missing, null);
  const got = await orderHttp.getOrder('o1');
  assert.strictEqual(got.id, 'o1');
  assert.strictEqual(got.cumQuantity, 10);
  assert.ok(orderCalls.some((c) => c.path === '/v1/order/o1'));
  orderHttp.close();

  console.log('polymarket-client.test.js ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
