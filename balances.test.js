'use strict';
const assert = require('node:assert/strict');
const br = require('./balance-reporter');

function fakeSupabase() {
  const ops = [];
  const api = {
    ops,
    from(table) {
      return {
        upsert(rows, opts) { ops.push({ op: 'upsert', table, rows: [].concat(rows), opts }); return Promise.resolve({ error: null }); },
        update(patch) {
          const q = { op: 'update', table, patch, eq: [] };
          ops.push(q);
          const chain = { eq(k, v) { q.eq.push([k, v]); return chain; }, then(r) { return Promise.resolve({ error: null }).then(r); } };
          return chain;
        },
      };
    },
  };
  return api;
}

function kalshiSigned(byShard) {
  const calls = [];
  const f = async (method, signPath, opts) => {
    calls.push({ method, path: opts.path });
    const shard = Number(new URL('http://x' + opts.path).searchParams.get('exchange_index'));
    const v = byShard[shard];
    if (v instanceof Error) throw v;
    if (typeof v === 'number') return { statusCode: v, text: '{"error":{"message":"secret-ish echo"}}' };
    return { statusCode: 200, text: JSON.stringify(v) };
  };
  f.calls = calls;
  return f;
}

(async () => {
  assert.equal(br.reportIntervalMs({}), 60000);
  assert.equal(br.reportIntervalMs({ BALANCE_REPORT_MS: '1000' }), 15000);
  assert.equal(br.reportIntervalMs({ BALANCE_REPORT_MS: '90000' }), 90000);
  assert.equal(br.reportEnabled({}), true);
  assert.equal(br.reportEnabled({ BALANCE_REPORT: '0' }), false);
  assert.equal(br.errorLabel({ statusCode: 401, message: 'Kalshi GET 401 {"key":"abc"}' }), 'HTTP 401');
  assert.equal(br.errorLabel(new Error('connect ETIMEDOUT')), 'timeout');
  assert.deepEqual(br.polyBalanceFromJson({ balances: [{ currency: 'USD', currentBalance: 1000.004, buyingPower: 850.5 }] }), { cash: 1000, buyingPower: 850.5 });
  assert.equal(br.polyBalanceFromJson({ balances: [] }), null);

  // Kalshi both shards + Polymarket, one tick, GET only.
  {
    const sb = fakeSupabase();
    const signed = kalshiSigned({ 0: { balance: 12345, portfolio_value: 500 }, 1: { balance_dollars: '987.65', portfolio_value_dollars: '10.00' } });
    const poly = { calls: [], async request(m, p) { this.calls.push([m, p]); return { statusCode: 200, json: { balances: [{ currency: 'USD', currentBalance: 300, buyingPower: 250.25 }] } }; } };
    const r = br.createBalanceReporter({ supabase: sb, userId: 'u1', signed, polyHttp: poly, now: () => new Date('2026-10-08T18:00:00Z'), log: () => {} });
    const rows = await r.tick();
    assert.ok(signed.calls.every((c) => c.method === 'GET'));
    assert.ok(poly.calls.every(([m]) => m === 'GET'));
    assert.deepEqual(poly.calls[0], ['GET', '/v1/account/balances']);
    const by = Object.fromEntries(rows.map((x) => [`${x.venue}:${x.shard}`, x]));
    assert.equal(by['kalshi:1'].available_usd, 987.65);
    assert.equal(by['kalshi:1'].portfolio_usd, 10);
    assert.equal(by['kalshi:0'].available_usd, 123.45);
    assert.equal(by['kalshi:0'].portfolio_usd, 5);
    assert.equal(by['polymarket_us:0'].available_usd, 250.25, 'buying power is what can be traded');
    assert.equal(by['polymarket_us:0'].buying_power_usd, 250.25);
    assert.ok(rows.every((x) => x.user_id === 'u1' && x.ok && x.error === null && x.fetched_at === '2026-10-08T18:00:00.000Z'));
    assert.equal(sb.ops.length, 1);
    assert.equal(sb.ops[0].table, 'combo_balances');
    assert.equal(sb.ops[0].opts.onConflict, 'user_id,venue,shard');
    assert.equal(sb.ops[0].rows.length, 3);
  }

  // Failure after a good read keeps the last amount; error is generic (no response text).
  {
    const sb = fakeSupabase();
    const byShard = { 0: { balance: 100 }, 1: { balance: 200 } };
    const signed = kalshiSigned(byShard);
    let t = new Date('2026-10-08T18:00:00Z');
    const r = br.createBalanceReporter({ supabase: sb, userId: 'u2', signed, now: () => t, log: () => {} });
    await r.tick();
    byShard[1] = 401;
    t = new Date('2026-10-08T18:01:00Z');
    const rows = await r.tick();
    const s1 = rows.find((x) => x.shard === 1);
    assert.equal(s1.ok, false);
    assert.equal(s1.error, 'HTTP 401');
    assert.equal(s1.available_usd, 2, 'last good amount kept');
    assert.equal(s1.fetched_at, '2026-10-08T18:00:00.000Z');
    assert.equal(s1.checked_at, '2026-10-08T18:01:00.000Z');
    assert.ok(!JSON.stringify(sb.ops).includes('secret-ish'), 'response text never stored');
  }

  // First-ever read fails: status-only write, amounts untouched.
  {
    const sb = fakeSupabase();
    const logs = [];
    const r = br.createBalanceReporter({ supabase: sb, userId: 'u3', signed: kalshiSigned({ 0: 500, 1: 500 }), log: (m) => logs.push(m) });
    const rows = await r.tick();
    assert.ok(rows.every((x) => x.ok === false && x.available_usd === undefined));
    const ins = sb.ops.filter((o) => o.op === 'upsert');
    assert.ok(ins.every((o) => o.opts.ignoreDuplicates === true));
    assert.ok(ins.every((o) => o.rows.every((x) => !('available_usd' in x))));
    const upd = sb.ops.filter((o) => o.op === 'update');
    assert.equal(upd.length, 2);
    assert.deepEqual(Object.keys(upd[0].patch).sort(), ['checked_at', 'error', 'ok']);
    assert.equal(logs.length, 1);
    assert.ok(!logs[0].includes('secret-ish'));
  }

  // Wiring: owner worker writes under Kevin's main id; tester under its own; invalid/disabled -> null.
  {
    const scopeOwner = { userIds: ['a', 'b'], writeUserId: null, isTester: false, invalid: false };
    const scopeTester = { userIds: ['t'], writeUserId: 'dd23a3a8-cb45-4866-be11-df72b4767c26', isTester: true, invalid: false };
    const made = [];
    const polyFactory = (o) => { made.push(Object.keys(o).sort()); return { request: async () => ({ statusCode: 500 }) }; };
    const sb = fakeSupabase();
    const logs = [];
    const a = br.startBalanceReporter({ supabase: sb, scope: scopeOwner, env: {}, signed: kalshiSigned({ 0: { balance: 1 }, 1: { balance: 2 } }), log: (m) => logs.push(m), polyFactory });
    assert.ok(a); a.stop();
    assert.match(logs[0], /user=79ae1610/);
    assert.equal(made.length, 0, 'no Polymarket client without keys');
    const b = br.startBalanceReporter({ supabase: sb, scope: scopeTester, env: { POLYMARKET_KEY_ID: 'k', POLYMARKET_SECRET_KEY: 's' }, signed: kalshiSigned({}), log: (m) => logs.push(m), polyFactory });
    assert.ok(b); b.stop();
    assert.match(logs[1], /user=dd23a3a8 \(kalshi \+ polymarket_us\)/);
    assert.ok(!logs.join(' ').includes('"s"') && !/secret/i.test(logs.join(' ')));
    assert.equal(br.startBalanceReporter({ supabase: sb, scope: { invalid: true }, env: {} }), null);
    assert.equal(br.startBalanceReporter({ supabase: sb, scope: scopeOwner, env: { BALANCE_REPORT: 'off' } }), null);
  }

  // live-runner wires it once, after the bucket manager, behind unlessQuoteHot.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'live-runner.js'), 'utf8');
    assert.equal((src.match(/startBalanceReporter\(/g) || []).length, 1);
    assert.match(src, /wrap: unlessQuoteHot/);
  }
  console.log('balances.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
