'use strict';
// Oct 30: confirmed-but-unbooked Kalshi sniper quotes are checked against Kalshi (quote + fills by
// order id) and booked or released; nothing is released without Kalshi showing no fill.
const assert = require('assert');
const { createUnbookedReconcile, quoteOrderId, executedAtMs } = require('./unbooked-reconcile');
const { createBalanceSnapshot } = require('./balance-snapshot');

const NOW = Date.parse('2026-10-30T06:30:00Z');
function fakeSupabase(rows) {
  const inserts = [];
  return {
    inserts,
    from(table) {
      const q = { table, filters: [] };
      const b = {
        select() { return b; }, eq(c, v) { q.filters.push((r) => r[c] === v); return b; },
        or() { q.filters.push((r) => !(Number(r.filled_contracts) > 0)); return b; },
        lt(c, v) { q.filters.push((r) => r[c] < v); return b; }, order() { return b; }, limit(n) { q.limit = n; return b; },
        insert: async (row) => { inserts.push([table, row]); return { error: null }; },
        then(res, rej) { return Promise.resolve({ data: rows.filter((r) => q.filters.every((f) => f(r))).slice(0, q.limit || 1e9), error: null }).then(res, rej); },
      };
      return b;
    },
  };
}
const row = (id, extra = {}) => ({ rfq_id: id, quote_id: `q_${id}`, order_id: null, market_ticker: `KXMVE-${id}`, legs: ['a:yes', 'b:yes'], risk: 50, status: 'open', phase: 'accepted', dry_run: false, filled_contracts: 0, created_at: '2026-10-29T15:02:05Z', updated_at: '2026-10-29T15:02:19Z', ...extra });
function fakeStore(rows) {
  const s = { updates: [], releases: [] };
  s.update = async (id, p) => { s.updates.push([id, p]); const r = rows.find((x) => x.rfq_id === id); if (r) Object.assign(r, p); };
  s.release = async (id, phase) => { s.releases.push([id, phase]); const r = rows.find((x) => x.rfq_id === id); if (r) Object.assign(r, { status: 'released', phase }); };
  return s;
}

(async () => {
  assert.strictEqual(quoteOrderId({ creator_order_id: 'o1' }), 'o1');
  assert.strictEqual(executedAtMs({ executed_ts: '2026-10-29T15:02:12Z' }), Date.parse('2026-10-29T15:02:12Z'));

  // The Oct 29 shape: quote executed on Kalshi, order id stamped, but ZERO fills and no position.
  const rows = [
    row('phantom', { order_id: 'ord_phantom' }),                                  // executed 15h ago, no fill -> release
    row('late', { order_id: 'ord_late' }),                                        // fills exist -> book
    row('fresh_exec', { order_id: 'ord_fresh' }),                                 // executed 5m ago, no fill -> leave (grace)
    row('noorder'),                                                               // order id only on the quote -> book
    row('gone'),                                                                  // quote cancelled, no order -> release
    row('readerr', { order_id: 'ord_err' }),                                      // fills read fails -> leave
    row('young', { updated_at: new Date(NOW - 60000).toISOString() }),            // < 10m -> not a candidate
    row('booked', { filled_contracts: 10, phase: 'filled' }),                     // already booked -> not a candidate
  ];
  const quotes = {
    q_phantom: { status: 'executed', executed_ts: '2026-10-29T15:02:12Z', creator_order_id: 'ord_phantom' },
    q_late: { status: 'executed', executed_ts: '2026-10-29T15:02:12Z' },
    q_fresh_exec: { status: 'executed', executed_ts: new Date(NOW - 5 * 60000).toISOString() },
    q_noorder: { status: 'executed', executed_ts: '2026-10-29T15:02:12Z', creator_order_id: 'ord_noorder' },
    q_gone: { status: 'cancelled' },
    q_readerr: { status: 'executed', executed_ts: '2026-10-29T15:02:12Z' },
  };
  const fills = {
    ord_late: { reason: 'confirmed', contracts: 40, book: [{ fill_id: 'f1', count: 40, no_price: 0.7, fee: 0.5, ticker: 'KXMVE-late' }] },
    ord_noorder: { reason: 'confirmed', contracts: 10, book: [{ fill_id: 'f2', count: 10, no_price: 0.6, fee: 0 }] },
  };
  const reads = [];
  const trader = {
    async getQuote(id) { reads.push(['quote', id]); return quotes[id] || null; },
    async fillsForOrder(o) { reads.push(['fills', o]); if (o === 'ord_err') throw new Error('fills read 503'); return fills[o] || { book: [], contracts: 0, reason: 'no-portfolio-fill' }; },
    async postQuote() { throw new Error('must not post'); }, async confirm() { throw new Error('must not confirm'); }, async cancel() { throw new Error('must not cancel'); },
  };
  const store = fakeStore(rows);
  const forgot = []; const alerts = []; const decisions = [];
  const rec = createUnbookedReconcile({
    supabase: fakeSupabase(rows), trader, store, liveSniper: { forgetRfq: (id) => forgot.push(id) },
    log: () => {}, alert: (m) => alerts.push(m), decision: (d) => decisions.push(d), now: () => NOW,
  });
  const { results } = await rec.tick();
  const out = Object.fromEntries(results);
  assert.deepStrictEqual(out, {
    phantom: 'executed_no_fill', late: 'booked', fresh_exec: 'left_executed', noorder: 'booked', gone: 'not_executed_cancelled', readerr: 'left_read_error',
  });
  assert.deepStrictEqual(store.releases.map((r) => r[0]).sort(), ['gone', 'phantom']);
  assert.ok(store.releases.every((r) => r[1] === 'declined'));
  const lateUpd = store.updates.find((u) => u[0] === 'late')[1];
  assert.strictEqual(lateUpd.phase, 'filled'); assert.strictEqual(lateUpd.filled_contracts, 40); assert.strictEqual(lateUpd.filled_cost, 28); assert.strictEqual(lateUpd.filled_fee, 0.5);
  assert.deepStrictEqual(lateUpd.fill_ids, ['f1']); assert.strictEqual(lateUpd.order_id, 'ord_late');
  assert.strictEqual(store.updates.find((u) => u[0] === 'noorder')[1].order_id, 'ord_noorder', 'order id taken from the quote');
  assert.deepStrictEqual(forgot.sort(), ['gone', 'late', 'noorder', 'phantom']);
  assert.strictEqual(alerts.length, 2, 'one alert per late-booked fill');
  assert.ok(decisions.every((d) => d.action === 'unbooked_reconcile'));
  assert.ok(!reads.some((r) => r[1] === 'q_young' || r[1] === 'q_booked'));
  // Second cycle: only the rows that were left come back; nothing is double-booked.
  const again = Object.fromEntries((await rec.tick()).results);
  assert.deepStrictEqual(Object.keys(again).sort(), ['fresh_exec', 'readerr']);
  assert.strictEqual(store.updates.filter((u) => u[1].phase === 'filled').length, 2);

  // A quote read error never releases (cannot prove no fill).
  const r2 = [row('qerr')];
  const s2 = fakeStore(r2);
  const rc2 = createUnbookedReconcile({ supabase: fakeSupabase(r2), trader: { async getQuote() { throw new Error('quote read 500'); }, async fillsForOrder() { return { book: [], contracts: 0, reason: 'no-portfolio-fill' }; } }, store: s2, log: () => {}, now: () => NOW });
  assert.deepStrictEqual((await rc2.tick()).results, [['qerr', 'left_read_error']]);
  assert.strictEqual(s2.releases.length, 0);

  // Balance snapshot: one kalshi_account_snapshots row, cents, sniper source tag; read failure writes nothing.
  const sb = fakeSupabase([]);
  const snap = createBalanceSnapshot({ supabase: sb, fetchBalanceUsd: async () => 10551.0709, subaccount: 1, totals: () => ({ committed: 4959.04, resting: 5645.15, total: 6370.33 }), positions: () => 174, now: () => NOW, log: () => {} });
  const w = await snap.tick();
  assert.strictEqual(sb.inserts.length, 1); assert.strictEqual(sb.inserts[0][0], 'kalshi_account_snapshots');
  assert.strictEqual(w.balance_cents, 1055107); assert.strictEqual(w.open_exposure_cents, 495904); assert.strictEqual(w.open_position_count, 174);
  assert.strictEqual(w.raw_portfolio.source, 'kalshi_sniper'); assert.strictEqual(w.raw_portfolio.subaccount, 1);
  const bad = createBalanceSnapshot({ supabase: sb, fetchBalanceUsd: async () => { throw new Error('subaccount balance read 503'); }, log: () => {} });
  assert.strictEqual(await bad.tick(), null); assert.strictEqual(sb.inserts.length, 1);

  // trader.getQuote: read-only GET on the quote path, null on 404, works with the live gate CLOSED.
  {
    const crypto = require('crypto');
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const { createSniperTrader } = require('./trader');
    const seen = [];
    const t = createSniperTrader({ gate: { live: false }, keyId: 'test', pem, log: () => {}, request: async (r) => { seen.push([r.method, r.path]); return r.path.endsWith('/missing') ? { statusCode: 404, headers: {}, text: '{}' } : { statusCode: 200, headers: {}, text: JSON.stringify({ quote: { id: 'abc', status: 'executed', creator_order_id: 'o9' } }) }; } });
    const q = await t.getQuote('abc');
    assert.strictEqual(q.status, 'executed'); assert.strictEqual(quoteOrderId(q), 'o9');
    assert.strictEqual(await t.getQuote('missing'), null);
    assert.deepStrictEqual(seen.map((x) => x[0]), ['GET', 'GET']);
    assert.strictEqual(seen[0][1], '/trade-api/v2/communications/quotes/abc');
  }
  console.log('sniper unbooked reconcile + balance snapshot: ok');
})().catch((e) => { console.error(e); process.exit(1); });
