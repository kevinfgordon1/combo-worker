'use strict';
// Oct 30 fix: startup loads ALL exposure rows (ordered + paged, never cut off by stale 'quoted' rows)
// and stale 'quoted' rows are expired at startup / on a sweep so no ledger quote sits forever.
const assert = require('assert');
const { createPolySniperStore } = require('./store');

// Minimal PostgREST-ish fake: select / in / eq / gte / lt / order / range / limit / update.
function fakeDb(rows, { failOn } = {}) {
  const calls = [];
  const from = () => {
    const q = { filters: [], orders: [], range: null, limit: null, update: null };
    const run = () => {
      calls.push(q);
      if (failOn && failOn(q)) return { data: null, error: { message: 'boom' } };
      let out = rows.filter((r) => q.filters.every((f) => f(r)));
      if (q.update) { out.forEach((r) => Object.assign(r, q.update)); return { data: null, error: null }; }
      for (const [col, asc] of [...q.orders].reverse()) out = out.slice().sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
      if (q.limit != null) out = out.slice(0, q.limit);
      return { data: out.map((r) => ({ ...r })), error: null };
    };
    const b = {
      select() { return b; },
      update(p) { q.update = p; return b; },
      in(c, v) { q.filters.push((r) => v.includes(r[c])); return b; },
      eq(c, v) { q.filters.push((r) => r[c] === v); return b; },
      gte(c, v) { q.filters.push((r) => r[c] >= v); return b; },
      lt(c, v) { q.filters.push((r) => r[c] < v); return b; },
      order(c, o = {}) { q.orders.push([c, o.ascending !== false]); return b; },
      range(a, z) { q.range = [a, z]; return b; },
      limit(n) { q.limit = n; return b; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    return b;
  };
  return { from, calls };
}

const NOW = Date.parse('2026-10-30T06:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const pad = (n) => String(n).padStart(6, '0');

(async () => {
  // 1) 6,000 stale 'quoted' rows created BEFORE the real positions: the old unordered limit(5000) over
  //    all open phases could miss them. Every exposure row must load; stale quoted rows must not.
  const rows = [];
  for (let i = 0; i < 6000; i += 1) rows.push({ quote_id: `stale${pad(i)}`, phase: 'quoted', created_at: iso(8 * 3600e3 - i) });
  rows.push({ quote_id: 'fill1', phase: 'filled', created_at: iso(3600e3), filled_contracts: 10, risk: 5 });
  rows.push({ quote_id: 'fill2', phase: 'filled', created_at: iso(1800e3), filled_contracts: 20, risk: 7 });
  rows.push({ quote_id: 'conf1', phase: 'confirmed', created_at: iso(60e3), risk: 3 });
  rows.push({ quote_id: 'acc1', phase: 'accepted', created_at: iso(5e3), risk: 2 });
  rows.push({ quote_id: 'fresh1', phase: 'quoted', created_at: iso(20e3) });
  rows.push({ quote_id: 'done1', phase: 'settled', created_at: iso(9e6) });
  const db = fakeDb(rows);
  const store = createPolySniperStore({ supabase: db, log: () => {}, retries: 0, sleep: async () => {} });
  const got = await store.hydrateOpen({ staleQuotedMs: 15 * 60000, nowMs: NOW, pageSize: 1000 });
  const ids = got.map((r) => r.quote_id).sort();
  assert.deepStrictEqual(ids, ['acc1', 'conf1', 'fill1', 'fill2', 'fresh1'], 'all exposure + only fresh quoted');
  assert.ok(db.calls.every((q) => q.update || (q.orders.length && q.range)), 'every hydrate read is ordered and paged');

  // 2) paging: 2,500 filled rows over pages of 1,000 -> all 2,500, no duplicates.
  const many = [];
  for (let i = 0; i < 2500; i += 1) many.push({ quote_id: `f${pad(i)}`, phase: 'filled', created_at: iso(10e6 - i * 1000) });
  const s2 = createPolySniperStore({ supabase: fakeDb(many), log: () => {}, retries: 0, sleep: async () => {} });
  const g2 = await s2.hydrateOpen({ nowMs: NOW, pageSize: 1000 });
  assert.strictEqual(g2.length, 2500);
  assert.strictEqual(new Set(g2.map((r) => r.quote_id)).size, 2500);

  // 3) a failed page fails CLOSED (throws) instead of returning a partial book.
  const s3 = createPolySniperStore({ supabase: fakeDb(many, { failOn: (q) => q.range && q.range[0] === 1000 }), log: () => {}, retries: 0, sleep: async () => {} });
  await assert.rejects(() => s3.hydrateOpen({ nowMs: NOW, pageSize: 1000 }), /hydrate exposure: boom/);
  // ... and a runaway table refuses a partial load.
  const s3b = createPolySniperStore({ supabase: fakeDb(many), log: () => {}, retries: 0, sleep: async () => {} });
  await assert.rejects(() => s3b.hydrateOpen({ nowMs: NOW, pageSize: 1000, maxPages: 2 }), /refusing a partial load/);

  // 4) expireStaleQuoted: old 'quoted' -> 'expired' in batches; fresh quoted, kept ids and real
  //    positions untouched.
  const r4 = [
    { quote_id: 'old1', rfq_id: 'r1', phase: 'quoted', created_at: iso(2 * 3600e3) },
    { quote_id: 'old2', rfq_id: 'r2', phase: 'quoted', created_at: iso(30 * 60000) },
    { quote_id: 'keep', rfq_id: 'r3', phase: 'quoted', created_at: iso(40 * 60000) },
    { quote_id: 'new1', rfq_id: 'r4', phase: 'quoted', created_at: iso(30e3) },
    { quote_id: 'pos1', rfq_id: 'r5', phase: 'filled', created_at: iso(5 * 3600e3) },
  ];
  const s4 = createPolySniperStore({ supabase: fakeDb(r4), log: () => {}, retries: 0, sleep: async () => {} });
  const exp = await s4.expireStaleQuoted({ staleQuotedMs: 15 * 60000, nowMs: NOW, keepIds: new Set(['keep']) });
  assert.deepStrictEqual(exp.map((r) => r.quote_id).sort(), ['old1', 'old2']);
  const ph = Object.fromEntries(r4.map((r) => [r.quote_id, r.phase]));
  assert.deepStrictEqual(ph, { old1: 'expired', old2: 'expired', keep: 'quoted', new1: 'quoted', pos1: 'filled' });
  assert.strictEqual(r4[0].cancel_reason, 'stale_quoted_sweep');
  // batch limit: 1,200 stale rows, batch 500 -> 500 per sweep, all gone after 3 sweeps.
  const r5 = []; for (let i = 0; i < 1200; i += 1) r5.push({ quote_id: `s${pad(i)}`, rfq_id: `r${i}`, phase: 'quoted', created_at: iso(3600e3 + i) });
  const s5 = createPolySniperStore({ supabase: fakeDb(r5), log: () => {}, retries: 0, sleep: async () => {} });
  const counts = [];
  for (let k = 0; k < 4; k += 1) counts.push((await s5.expireStaleQuoted({ nowMs: NOW, batch: 500 })).length);
  assert.deepStrictEqual(counts, [500, 500, 200, 0]);
  assert.ok(r5.every((r) => r.phase === 'expired'));

  // 5) live layer: attach runs the stale sweep once, queues best-effort venue deletes (rows < 24h old
  //    only), and drains them only while the real cancel lane is idle.
  const { createPolySniperLive } = require('./live');
  const r6 = [
    { quote_id: 'lq1', rfq_id: 'rr1', phase: 'quoted', created_at: iso(3 * 3600e3) },
    { quote_id: 'lq2', rfq_id: 'rr2', phase: 'quoted', created_at: iso(2 * 864e5) },
    { quote_id: 'lf1', rfq_id: 'rr3', phase: 'filled', created_at: iso(3600e3), buy_price: 0.5, filled_contracts: 10, filled_cost: 5, risk: 5, contracts: 10, games: ['g1'], legs: ['L1:yes'], settle_at: new Date(NOW + 864e5).toISOString() },
  ];
  const sdb = createPolySniperStore({ supabase: fakeDb(r6), log: () => {}, retries: 0, sleep: async () => {} });
  const store6 = {
    hydrateOpen: (o) => sdb.hydrateOpen(o), expireStaleQuoted: (o) => sdb.expireStaleQuoted(o),
    async readControl() { return { live: false }; }, insertQuote: () => Promise.resolve(true), patch: () => Promise.resolve(true),
    async dayTotals() { return { realized: 0, filledRisk: 0 }; }, async flush() {}, stats: () => ({}),
  };
  const dels = [];
  const http = {
    async createQuote() { return { quoteId: 'x' }; }, async confirmQuote() { return {}; },
    async deleteQuote(r, q) { dels.push(q); if (q === 'lq1') { const e = new Error('400'); e.statusCode = 400; throw e; } return {}; },
    async getOrder() { return null; }, async listQuotes() { return { quotes: [] }; }, async listRfqs() { return { rfqs: [] }; },
    async request() { return { statusCode: 200, json: { balances: [{ currency: 'USD', currentBalance: 20000, buyingPower: 20000 }] } }; },
  };
  const logs = [];
  const L = createPolySniperLive({ env: {}, engineConfig: {}, feed: { pricesHealthy: () => true }, store: store6, log: (m) => logs.push(m), alert: () => {}, now: () => NOW, timers: false });
  await L.attach({ http, comboConfirming: () => 0 });
  const I = L._internal;
  assert.ok(I.quotes.has('lf1'), 'filled position loaded');
  assert.strictEqual(r6[0].phase, 'expired'); assert.strictEqual(r6[1].phase, 'expired');
  assert.deepStrictEqual(I.staleDeletes.map((j) => j.quoteId), ['lq1'], 'only rows < 24h old get a venue delete');
  I.cancelQueue.push({ quoteId: 'busy', rfqId: 'b', tries: 0 });
  assert.strictEqual(await I.drainStaleDeletes(5), 0, 'waits while real cancels are queued');
  I.cancelQueue.length = 0;
  assert.strictEqual(await I.drainStaleDeletes(5), 1);
  assert.deepStrictEqual(dels, ['lq1'], 'a gone quote (400) is just counted, never retried');
  assert.ok(logs.some((m) => /stale sweep: expired 2/.test(m)));
  console.log('poly-sniper hydrate + stale sweep: ok');
})().catch((e) => { console.error(e); process.exit(1); });
