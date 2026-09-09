'use strict';
const assert = require('assert');
const {
  peekJwtRole,
  inspectSupabaseEnv,
  isTransientSupabaseFailure,
  isRetryHttpStatus,
  formatSupabaseFailure,
  createRateLimitedLogger,
  withTransientRetry,
  createPersistGate,
  createSupabaseFetch,
  createUnhedgedSupabaseClient,
} = require('./supabase-http');

function fakeJwt(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${b64}.x`;
}

assert.strictEqual(peekJwtRole(fakeJwt({ role: 'service_role' })), 'service_role');
assert.strictEqual(peekJwtRole(fakeJwt({ role: 'anon' })), 'anon');
assert.strictEqual(peekJwtRole('not-a-jwt'), null);

{
  const bad = inspectSupabaseEnv({});
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, 'missing SUPABASE_URL');
  const noKey = inspectSupabaseEnv({ SUPABASE_URL: 'https://abc.supabase.co' });
  assert.strictEqual(noKey.reason, 'missing SUPABASE_SERVICE_KEY');
  const pg = inspectSupabaseEnv({
    SUPABASE_URL: 'postgresql://postgres:pw@db.abc.supabase.co:5432/postgres',
    SUPABASE_SERVICE_KEY: fakeJwt({ role: 'service_role' }),
  });
  assert.ok(pg.warnings.some((w) => /Postgres URI/.test(w)));
  const ok = inspectSupabaseEnv({
    SUPABASE_URL: 'https://abc.supabase.co',
    SUPABASE_SERVICE_KEY: fakeJwt({ role: 'service_role' }),
  });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.host, 'abc.supabase.co');
  assert.strictEqual(ok.keyRole, 'service_role');
  assert.ok(/host=abc\.supabase\.co/.test(ok.summary));
  const quoted = inspectSupabaseEnv({
    SUPABASE_URL: '"https://abc.supabase.co"',
    SUPABASE_SERVICE_KEY: fakeJwt({ role: 'anon' }),
  });
  assert.strictEqual(quoted.host, 'abc.supabase.co');
  assert.ok(quoted.warnings.some((w) => /role=anon/.test(w)));
}

assert.ok(isTransientSupabaseFailure({ message: 'TypeError: fetch failed' }));
assert.ok(isTransientSupabaseFailure({ message: 'fetch failed', cause: { code: 'ECONNRESET' } }));
assert.ok(isTransientSupabaseFailure({ message: 'ConnectTimeoutError' }));
assert.ok(isTransientSupabaseFailure({ message: '<html>Cloudflare</html>', status: 522 }));
assert.ok(isTransientSupabaseFailure(520));
assert.ok(isRetryHttpStatus(522));
assert.ok(!isTransientSupabaseFailure({ code: '23505', message: 'duplicate key' }));
assert.ok(!isTransientSupabaseFailure({ message: "Could not find the 'updated_at' column of 'unhedged_rfqs' in the schema cache" }));
assert.ok(!isTransientSupabaseFailure({ message: 'JWT expired' }));
assert.ok(!isRetryHttpStatus(401));
assert.ok(!isRetryHttpStatus(409));

assert.ok(/fetch failed/.test(formatSupabaseFailure({ message: 'fetch failed', cause: { code: 'ENOTFOUND' } })));
assert.ok(/cause=ENOTFOUND/.test(formatSupabaseFailure({ message: 'fetch failed', cause: { code: 'ENOTFOUND' } })));

{
  const lines = [];
  let t = 0;
  const log = createRateLimitedLogger({
    intervalMs: 1000,
    now: () => t,
    write: (m) => lines.push(m),
  });
  for (let i = 0; i < 20; i++) log.log('x', 'boom');
  assert.strictEqual(lines.length, 1);
  t = 1000;
  log.log('x', 'boom');
  assert.strictEqual(lines.length, 2);
  assert.ok(/20 in 1000ms/.test(lines[1]));
}

(async () => {
  let n = 0;
  const out = await withTransientRetry(async () => {
    n += 1;
    if (n < 3) return { ok: false, error: { message: 'TypeError: fetch failed' } };
    return { ok: true };
  }, { maxAttempts: 4, delaysMs: [0, 0, 0], sleep: async () => {} });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(n, 3);

  n = 0;
  const uniq = await withTransientRetry(async () => {
    n += 1;
    return { ok: false, error: { code: '23505', message: 'duplicate key' } };
  }, { maxAttempts: 4, delaysMs: [0, 0, 0] });
  assert.strictEqual(uniq.ok, false);
  assert.strictEqual(n, 1);

  let thrown = 0;
  try {
    await withTransientRetry(async () => {
      thrown += 1;
      const e = new TypeError('fetch failed');
      e.cause = { code: 'ECONNRESET' };
      throw e;
    }, { maxAttempts: 3, delaysMs: [0, 0], sleep: async () => {} });
    assert.fail('should throw');
  } catch (e) {
    assert.strictEqual(e.message, 'fetch failed');
    assert.strictEqual(thrown, 3);
  }

  const gate = createPersistGate({ maxInFlight: 1, maxQueuedSeen: 1 });
  let release;
  const blocker = new Promise((r) => { release = r; });
  const first = gate.enqueue('seen', () => blocker.then(() => ({ ok: true, id: 1 })));
  const secondP = gate.enqueue('seen', () => ({ ok: true, id: 2 }));
  const shed = await gate.enqueue('seen', () => ({ ok: true, id: 3 }));
  assert.strictEqual(shed.reason, 'persist_shed');
  const fillP = gate.enqueue('fill', () => ({ ok: true, id: 'fill' }));
  release();
  assert.deepStrictEqual(await first, { ok: true, id: 1 });
  assert.deepStrictEqual(await secondP, { ok: true, id: 2 });
  assert.deepStrictEqual(await fillP, { ok: true, id: 'fill' });
  assert.strictEqual(gate.stats().droppedSeen, 1);

  const calls = [];
  const fakeFetch = async (input, init) => {
    calls.push({ input, hasDispatcher: !!(init && init.dispatcher) });
    if (calls.length < 3) {
      const e = new TypeError('fetch failed');
      e.cause = { code: 'ECONNRESET' };
      throw e;
    }
    return { status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  }
  const FakeAgent = function FakeAgent() { this.tag = 'agent'; };
  const wrapped = createSupabaseFetch({
    fetch: fakeFetch,
    Agent: FakeAgent,
    maxAttempts: 3,
    delaysMs: [0, 0],
    sleep: async () => {},
    timeoutMs: 5000,
    logger: createRateLimitedLogger({ write: () => {} }),
  });
  const res = await wrapped('https://abc.supabase.co/rest/v1/unhedged_rfqs', { method: 'POST' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.length, 3);
  assert.ok(calls[0].hasDispatcher);

  const statuses = [];
  const statusFetch = async () => {
    statuses.push(1);
    return {
      status: statuses.length < 2 ? 522 : 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  const wrapped520 = createSupabaseFetch({
    fetch: statusFetch,
    maxAttempts: 3,
    delaysMs: [0, 0],
    sleep: async () => {},
    timeoutMs: 5000,
    logger: createRateLimitedLogger({ write: () => {} }),
  });
  const okRes = await wrapped520('https://abc.supabase.co/rest/v1/unhedged_rfqs');
  assert.strictEqual(okRes.status, 200);
  assert.strictEqual(statuses.length, 2);

  const created = [];
  const client = createUnhedgedSupabaseClient({
    createClient: (url, key, opts) => {
      created.push({ url, key, opts });
      return { url, key, opts };
    },
    env: {
      SUPABASE_URL: 'https://abc.supabase.co',
      SUPABASE_SERVICE_KEY: fakeJwt({ role: 'service_role' }),
    },
    fetch: async () => ({ status: 200 }),
    Agent: FakeAgent,
    logger: { log() {}, warn() {}, error() {} },
  });
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].url, 'https://abc.supabase.co');
  assert.strictEqual(typeof created[0].opts.global.fetch, 'function');
  assert.strictEqual(created[0].opts.auth.persistSession, false);
  assert.ok(client);

  console.log('supabase-http.test.js ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
