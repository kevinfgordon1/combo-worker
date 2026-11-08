'use strict';
// Low-balance-only pre-quote cash gate (Kevin Nov 4 2026).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const G = require('./balance-gate');
const { createBalanceReporter } = require('./balance-reporter');

const T0 = Date.parse('2026-11-05T03:00:00Z');
const row = (venue, shard, usd, extra = {}) => ({ venue, shard, ok: true, available_usd: usd, fetched_at: new Date(T0).toISOString(), ...extra });

// env knobs
assert.strictEqual(G.gateEnabled({}), true);
assert.strictEqual(G.gateEnabled({ COMBO_BALANCE_GATE: '0' }), false);
assert.strictEqual(G.gateEnabled({ COMBO_BALANCE_GATE: 'off' }), false);
assert.strictEqual(G.readComfort({}), 2);
assert.strictEqual(G.readComfort({ COMBO_BALANCE_GATE_COMFORT: '3' }), 3);
assert.strictEqual(G.readComfort({ COMBO_BALANCE_GATE_COMFORT: '0.5' }), 1);
assert.strictEqual(G.readComfort({ COMBO_BALANCE_GATE_COMFORT: 'x' }), 2);
assert.strictEqual(G.readMaxAgeMs({}), 180000);
assert.strictEqual(G.venueKey('kalshi'), 'kalshi:1', 'Kalshi combos clear on the combo bucket (shard 1)');
assert.strictEqual(G.venueKey('polymarket'), 'polymarket_us:0');
assert.strictEqual(G.venueKey('nope'), null);

// cost helpers
assert.strictEqual(G.quoteCostUsd(10, 0.8), 8);
assert.strictEqual(G.quoteCostUsd(0, 0.8), 0);
assert.strictEqual(G.quoteCostUsd(10, 0), 0);
assert.strictEqual(G.kalshiPendingCostUsd({ contracts: 10, noBid: '0.75' }), 7.5);
assert.ok(Math.abs(G.kalshiPendingCostUsd({ contracts: 10, yesBid: '0.25' }) - 7.5) < 1e-9);
assert.strictEqual(G.kalshiPendingCostUsd({ contracts: 10, yesBid: '0.00' }), 10, 'unknown price: $1/contract (conservative)');
assert.ok(Math.abs(G.polyPendingCostUsd({ contracts: 10, buyPrice: '0.222' }) - 7.78) < 1e-9);
assert.strictEqual(G.sumHoldsUsd(new Map([['a', { contracts: 2, noBid: 0.5 }], ['b', { contracts: 4, noBid: 0.5 }]]), G.kalshiPendingCostUsd), 3);
assert.strictEqual(G.sumHoldsUsd(null, G.kalshiPendingCostUsd), 0);

// gate paths
{
  let t = T0 + 10_000;
  const g = G.createBalanceGate({ env: {}, now: () => t });
  // no snapshot yet -> allow, holds never computed
  let holdsCalls = 0;
  const holds = () => { holdsCalls += 1; return 0; };
  assert.deepStrictEqual(g.check({ venue: 'kalshi', costUsd: 50, holdsUsd: holds }), { ok: true, path: 'no_data' });
  assert.strictEqual(holdsCalls, 0);

  g.update([row('kalshi', 1, 1000), row('kalshi', 0, 5), row('polymarket_us', 0, 40)]);
  assert.strictEqual(g.cashFor('kalshi'), 1000);
  assert.strictEqual(g.cashFor('polymarket'), 40);

  // normal cash: fast path
  assert.strictEqual(g.check({ venue: 'kalshi', costUsd: 50, holdsUsd: 100 }).path, 'fast');
  // low cash but this quote still fits after holds: allowed ('checked')
  const c = g.check({ venue: 'polymarket', costUsd: 15, holdsUsd: 10, unitCost: 0.5 });
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.path, 'checked');
  assert.strictEqual(c.freeUsd, 30);
  assert.strictEqual(c.maxContracts, 60);
  // low cash: holds eat it -> skip
  const s = g.check({ venue: 'polymarket', costUsd: 15, holdsUsd: () => 30, unitCost: 0.5 });
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.reason, 'insufficient_balance');
  assert.strictEqual(s.freeUsd, 10);
  assert.strictEqual(s.maxContracts, 20, 'reports what would fit (venues quote full RFQ size, so it skips)');
  // quote alone above cash
  assert.strictEqual(g.check({ venue: 'kalshi', costUsd: 1500 }).ok, false);
  // no cost / unknown venue -> allow
  assert.strictEqual(g.check({ venue: 'kalshi', costUsd: 0 }).path, 'no_cost');
  assert.strictEqual(g.check({ venue: 'other', costUsd: 10 }).path, 'no_data');

  // failed reads do not overwrite the last good amount
  g.update([{ venue: 'kalshi', shard: 1, ok: false, available_usd: 0, fetched_at: new Date(T0).toISOString() }]);
  assert.strictEqual(g.cashFor('kalshi'), 1000);

  // stale snapshot (reporter stalled) never blocks quoting
  t = T0 + 181_000;
  assert.strictEqual(g.cashFor('kalshi'), null);
  assert.strictEqual(g.check({ venue: 'kalshi', costUsd: 5000 }).path, 'no_data');
  // A stalled reading must not block the accept. Kalshi rejects if we cannot pay.
  const stale = g.afford({ venue: 'kalshi', costUsd: 5000, holdsUsd: 0 });
  assert.strictEqual(stale.ok, true);
  assert.strictEqual(stale.path, 'unknown');
  const st = g.stats();
  assert.ok(st.fast >= 1 && st.checked >= 1 && st.skipped >= 2 && st.noData >= 1);
}
{
  const off = G.createBalanceGate({ env: { COMBO_BALANCE_GATE: '0' }, now: () => T0 });
  off.update([row('kalshi', 1, 0)]);
  assert.deepStrictEqual(off.check({ venue: 'kalshi', costUsd: 50 }), { ok: true, path: 'off' });
  assert.strictEqual(off.afford({ venue: 'kalshi', costUsd: 50 }).path, 'off');
}
{
  const g = G.createBalanceGate({ env: {}, now: () => T0 });
  assert.strictEqual(g.afford({ venue: 'kalshi', costUsd: 10 }).ok, true);
  assert.strictEqual(g.afford({ venue: 'kalshi', costUsd: 10 }).path, 'unknown');
  assert.strictEqual(g.afford({ venue: 'kalshi', costUsd: 0 }).path, 'no_cost');
  g.update([row('kalshi', 1, 25)]);
  assert.strictEqual(g.afford({ venue: 'kalshi', costUsd: 10, holdsUsd: () => 20 }).ok, false);
  assert.strictEqual(g.afford({ venue: 'kalshi', costUsd: 10, holdsUsd: 0 }).ok, true);
  g.update([{ venue: 'kalshi', shard: 1, ok: false, available_usd: 9999, fetched_at: new Date(T0).toISOString() }]);
  assert.strictEqual(g.knownCash('kalshi'), 25, 'a failed read must not raise the known cash');
}

// Reporter hands its reads to onRows (before the DB write) — no extra exchange call.
(async () => {
  const got = [];
  const supabase = {
    from() {
      return {
        upsert: async () => ({ error: { message: 'db down' } }),
        update() { return { eq() { return this; }, then: (r) => r({ error: null }) }; },
      };
    },
  };
  const polyHttp = { request: async () => ({ statusCode: 200, json: { balances: [{ currency: 'USD', currentBalance: 50, buyingPower: 42 }] } }) };
  const rep = createBalanceReporter({ supabase, userId: 'u1', signed: null, polyHttp, log: () => {}, onRows: (rows) => got.push(rows) });
  await rep.tick();
  assert.strictEqual(got.length, 1, 'onRows fires even when the DB write fails');
  assert.strictEqual(got[0][0].venue, 'polymarket_us');
  assert.strictEqual(got[0][0].available_usd, 42);
  const g = G.createBalanceGate({ env: {} });
  g.update(got[0]);
  assert.strictEqual(g.cashFor('polymarket'), 42);

  // Wiring: Kalshi quote path checks the gate before reserving/POSTing, with no I/O.
  const live = fs.readFileSync(path.join(__dirname, 'live-runner.js'), 'utf8');
  assert.ok(/onRows: \(rows\) => balanceGate\.update\(rows\)/.test(live), 'reporter feeds the gate');
  assert.ok(/balanceGate,\n/.test(live), 'gate handed to the Polymarket loop');
  const gateAt = live.indexOf("venue: 'kalshi',\n      costUsd: gateCostUsd(d.contracts, noBid)");
  const reserveAt = live.indexOf('const reserveKey = `reserve:${++reserveSeq}`;');
  const postAt = live.indexOf('result = await postQuote(rfq.rfqId, sentNoBid');
  assert.ok(gateAt > 0 && gateAt < reserveAt && reserveAt < postAt, 'gate runs before reserve + POST');
  assert.ok(/logFundingSkip\(p, rfq, d, \{ costDollars: cash\.costUsd \}\)/.test(live), 'skip uses the insufficient_balance path (top-up + alerts)');
  const gateSrc = fs.readFileSync(path.join(__dirname, 'balance-gate.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/require\(|fetch\(|\.from\(|request\(/.test(gateSrc), 'balance-gate.js does no I/O');
  console.log('balance-gate.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
