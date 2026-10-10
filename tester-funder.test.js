'use strict';
const assert = require('node:assert/strict');
const { planFund, canTransfer, createTesterFunder, loadFundConfig, etDayStartMs, logOwnKeyScopes } = require('./tester-funder');
const { buildTesterEnv } = require('./tester-env');

const T = 'dd23a3a8-cb45-4866-be11-df72b4767c26';
const KEVIN = '79ae1610-097e-4b46-a622-1e952f18e936';
const NOW = new Date('2026-10-09T18:00:00Z'); // 2:00 PM ET

// --- pure ----------------------------------------------------------------
const cfg = loadFundConfig({});
assert.equal(cfg.enabled, true);
assert.equal(cfg.maxMoveCents, 10000);
assert.equal(cfg.dailyCents, 25000);
assert.equal(cfg.minMoveCents, 500);
assert.equal(loadFundConfig({ TESTER_AUTOFUND: '0' }).enabled, false);
assert.equal(loadFundConfig({ TESTER_AUTOFUND: 'off' }).enabled, false);
assert.equal(canTransfer(['read', 'write']), true);
assert.equal(canTransfer(['read', 'write::trade', 'write::transfer']), true);
assert.equal(canTransfer(['read', 'write::trade']), false);
assert.equal(canTransfer(null), false);
{
  const p = (o) => planFund({ gate: null, comboCents: 0, mainCents: 100000, capCents: 25000, pendingCents: 0, todayCents: 0, config: cfg, ...o });
  assert.equal(p({}).amountCents, 10000, 'per-move limit');
  assert.equal(p({ comboCents: 20000 }).amountCents, 5000, 'cap');
  assert.equal(p({ comboCents: 20000, pendingCents: 3000 }).amountCents, 2000, 'cap counts pending moves');
  assert.equal(p({ todayCents: 22000 }).amountCents, 3000, 'daily limit');
  assert.equal(p({ mainCents: 1234 }).amountCents, 1234, 'never more than Default holds');
  assert.equal(p({ comboCents: 24800 }).reason, 'at_cap');
  assert.equal(p({ comboCents: 30000 }).action, 'hold', 'over cap: never moves');
  assert.equal(p({ todayCents: 25000 }).reason, 'daily_limit');
  assert.equal(p({ mainCents: 300 }).reason, 'default_balance');
  assert.equal(p({ gate: 'off: x' }).action, 'hold');
}
assert.equal(new Date(etDayStartMs(NOW)).toISOString(), '2026-10-09T04:00:00.000Z');

// --- fake Supabase + Kalshi -------------------------------------------------
function fakeDb(init) {
  const db = { ...init, inserts: [], updates: [], fail: init.fail || {} };
  db.from = (table) => {
    const q = { table, filters: [], op: 'select' };
    const result = () => {
      if (db.fail[table]) return { data: null, error: { message: `${table} down` } };
      if (q.op === 'insert') {
        if (db.fail.insert) return { data: null, error: { message: 'insert denied' } };
        const row = { id: `m${db.inserts.length + 1}`, created_at: NOW.toISOString(), ...q.row };
        db.inserts.push({ ...row }); db.moves.unshift(row);
        return { data: { id: row.id }, error: null };
      }
      if (q.op === 'update') {
        db.updates.push({ filters: q.filters, patch: q.patch });
        const id = (q.filters.find((f) => f[0] === 'id') || [])[1];
        const r = db.moves.find((m) => m.id === id); if (r) Object.assign(r, q.patch);
        return { data: null, error: null };
      }
      const uid = (q.filters.find((f) => f[0] === 'user_id') || [])[1];
      assert.equal(uid, T, `${table} read is scoped to the tester`);
      if (table === 'combo_live_users') return { data: db.live, error: null };
      if (table === 'combo_settings') return { data: db.settings, error: null };
      if (table === 'combo_exchange_keys') return { data: db.key, error: null };
      if (table === 'combo_fund_moves') return { data: db.moves.map((m) => ({ ...m })), error: null };
      return { data: null, error: null };
    };
    const b = {
      select() { return b; }, order() { return b; }, limit() { return b; }, gte() { return b; },
      eq(k, v) { q.filters.push([k, v]); return b; },
      insert(row) { q.op = 'insert'; q.row = row; return b; },
      update(patch) { q.op = 'update'; q.patch = patch; return b; },
      async maybeSingle() { return result(); },
      async single() { return result(); },
      then(res, rej) { return Promise.resolve(result()).then(res, rej); },
    };
    return b;
  };
  return db;
}
function fakeKalshi({ main = 50000, combo = 3000, transferStatus = 'completed', transferError = null } = {}) {
  const k = { transfers: [], records: [] };
  k.getShard = async (i) => ({ availableCents: i === 0 ? main : combo, portfolioCents: 0 });
  k.transfer = async (args) => {
    if (transferError) throw transferError;
    k.transfers.push(args);
    const id = `tr${k.transfers.length}`;
    k.records.push({ transferId: id, status: transferStatus });
    return { transferId: id };
  };
  k.getTransfers = async () => k.records;
  return k;
}
const base = () => ({
  live: { user_id: T, is_owner: false, can_trade: true, paused: false, max_per_day_usd: 250 },
  settings: { kill_switch: false },
  key: { scopes: ['read', 'write'], scope_status: 'ok' },
  moves: [],
});
const mk = (db, k, extra = {}) => createTesterFunder({ userId: T, supabase: db, client: k, env: {}, now: () => NOW, log: () => {}, sleep: async () => {}, ...extra });

(async () => {
  // Happy path: logged first, own Default (0) -> own Combos (1), confirmed.
  {
    const db = fakeDb(base()); const k = fakeKalshi();
    const r = await mk(db, k).check('test');
    assert.equal(r.moved, 10000);
    assert.deepEqual(k.transfers, [{ amountCenticents: 1_000_000, fromShard: 0, toShard: 1 }]);
    assert.equal(db.inserts.length, 1);
    const row = db.inserts[0];
    assert.equal(row.user_id, T); assert.equal(row.status, 'sending'); assert.equal(row.amount_usd, 100);
    assert.equal(row.from_shard, 0); assert.equal(row.to_shard, 1); assert.equal(row.cap_usd, 250);
    assert.equal(db.moves[0].status, 'confirmed');
    assert.equal(db.moves[0].transfer_id, 'tr1');
    for (const u of db.updates) assert.deepEqual(u.filters.find((f) => f[0] === 'user_id'), ['user_id', T]);
  }
  // Granular Read + Trade + Transfers also funds.
  {
    const s = base(); s.key = { scopes: ['read', 'write::trade', 'write::transfer'], scope_status: 'ok' };
    const db = fakeDb(s); const k = fakeKalshi();
    assert.equal((await mk(db, k).check()).moved, 10000);
  }
  // Cap: Combos $230 of a $250 limit -> moves $20 only.
  {
    const db = fakeDb(base()); const k = fakeKalshi({ combo: 23000 });
    assert.equal((await mk(db, k).check()).moved, 2000);
  }
  // Daily limit counted from the log (persisted across restarts).
  {
    const s = base(); s.moves = [{ id: 'old', amount_usd: 220, status: 'confirmed', created_at: '2026-10-09T13:00:00Z' }, { id: 'y', amount_usd: 100, status: 'confirmed', created_at: '2026-10-08T20:00:00Z' }];
    const db = fakeDb(s); const k = fakeKalshi();
    assert.equal((await mk(db, k).check()).moved, 3000, 'yesterday does not count; today $220 of $250');
  }
  // Every off switch -> no transfer, no log row.
  const offCases = [
    ['global', (s) => s, { env: { TESTER_AUTOFUND: '0' } }],
    ['kill switch on', (s) => { s.settings = { kill_switch: true }; return s; }],
    ['no settings row (kill engaged by default)', (s) => { s.settings = null; return s; }],
    ['paused', (s) => { s.live.paused = true; return s; }],
    ['can_trade false', (s) => { s.live.can_trade = false; return s; }],
    ['no transfer scope', (s) => { s.key = { scopes: ['read', 'write::trade'], scope_status: 'ok' }; return s; }],
    ['unverified scopes', (s) => { s.key = { scopes: ['read', 'write'], scope_status: 'unverified' }; return s; }],
    ['no daily limit', (s) => { s.live.max_per_day_usd = null; return s; }],
    ['owner row', (s) => { s.live.is_owner = true; return s; }],
    ['pending move', (s) => { s.moves = [{ id: 'p', amount_usd: 50, status: 'accepted', transfer_id: 'trX', created_at: '2026-10-09T17:59:00Z' }]; return s; }],
    ['state read fails', (s) => { s.fail = { combo_settings: true }; return s; }],
    ['log write fails', (s) => { s.fail = { insert: true }; return s; }],
  ];
  for (const [name, f, extra] of offCases) {
    const db = fakeDb(f(base())); const k = fakeKalshi();
    await mk(db, k, extra || {}).check();
    assert.equal(k.transfers.length, 0, name);
    if (name !== 'log write fails') assert.equal(db.inserts.length, 0, name);
  }
  // Kevin's id never funds, even with a stray tester-shaped config.
  {
    const db = fakeDb(base()); const k = fakeKalshi();
    const f = createTesterFunder({ userId: KEVIN, supabase: db, client: k, env: {}, now: () => NOW, log: () => {}, sleep: async () => {} });
    await f.check().catch(() => {});
    assert.equal(k.transfers.length, 0);
  }
  // Kalshi refuses the permission: logged failed, no more attempts this run.
  {
    const e = new Error('Kalshi POST 403 forbidden'); e.statusCode = 403;
    const db = fakeDb(base()); const k = fakeKalshi({ transferError: e });
    const f = mk(db, k);
    assert.equal((await f.check()).failed, true);
    assert.equal(db.moves[0].status, 'failed');
    assert.match(db.moves[0].error, /HTTP 403/);
    k.transferError = null;
    db.moves[0].created_at = '2026-10-09T10:00:00Z';
    await f.check();
    assert.equal(k.transfers.length, 0, 'refused key stops auto-funding until the child restarts');
  }
  // Pending move settles from Kalshi's record, then funding resumes next check.
  {
    const s = base(); s.moves = [{ id: 'p', amount_usd: 50, status: 'accepted', transfer_id: 'trA', created_at: '2026-10-09T17:59:00Z' }];
    const db = fakeDb(s); const k = fakeKalshi(); k.records.push({ transferId: 'trA', status: 'completed' });
    const f = mk(db, k);
    const r = await f.check();
    assert.equal(db.moves.find((m) => m.id === 'p').status, 'confirmed');
    assert.equal(r.moved, 10000);
  }
  // A move the worker never finished sending counts toward today (may have landed).
  {
    const s = base(); s.moves = [{ id: 's', amount_usd: 200, status: 'sending', created_at: '2026-10-09T17:00:00Z' }];
    const db = fakeDb(s); const k = fakeKalshi();
    const r = await mk(db, k).check();
    assert.match(db.moves.find((m) => m.id === 's').error, /^unconfirmed/);
    assert.equal(r.moved, 5000);
  }
  // Tester's own cap ($120) wins when below the daily limit; never above it.
  {
    const s1 = base(); s1.settings = { kill_switch: false, autofund_cap_usd: 120 };
    const db = fakeDb(s1); const k = fakeKalshi({ combo: 5000 });
    assert.equal((await mk(db, k).check()).moved, 7000, '$50 in Combos, cap $120 -> $70');
    assert.equal(db.inserts[0].cap_usd, 120);
    const s2 = base(); s2.settings = { kill_switch: false, autofund_cap_usd: 900 };
    const db2 = fakeDb(s2); const k2 = fakeKalshi({ combo: 20000 });
    assert.equal((await mk(db2, k2).check()).moved, 5000, 'cap above the $250 daily limit is clamped to it');
    const s3 = base(); s3.settings = { kill_switch: false, autofund_cap_usd: 0 };
    const db3 = fakeDb(s3); const k3 = fakeKalshi();
    await mk(db3, k3).check();
    assert.equal(k3.transfers.length, 0, 'cap $0 = auto-funding off');
  }
  // Sweep: Combos cash above the cap goes back to Default (own account only).
  {
    const s1 = base(); s1.settings = { kill_switch: false, autofund_cap_usd: 100 };
    const db = fakeDb(s1); const k = fakeKalshi({ combo: 16000 });
    const r = await mk(db, k).check();
    assert.equal(r.swept, 6000);
    assert.deepEqual(k.transfers, [{ amountCenticents: 600_000, fromShard: 1, toShard: 0 }]);
    assert.equal(db.inserts[0].from_shard, 1); assert.equal(db.inserts[0].to_shard, 0);
    assert.equal(db.moves[0].status, 'confirmed');
  }
  // Sweeps do not use up the daily top-up limit.
  {
    const s1 = base(); s1.moves = [{ id: 'sw', amount_usd: 200, status: 'confirmed', from_shard: 1, to_shard: 0, created_at: '2026-10-09T15:00:00Z' }];
    const db = fakeDb(s1); const k = fakeKalshi();
    assert.equal((await mk(db, k).check()).moved, 10000);
  }
  // Hard guard on the money call.
  {
    const f = mk(fakeDb(base()), fakeKalshi());
    await assert.rejects(f._moveBetweenOwnBalances(100, 0, 0), /only Default <-> Combos/);
    await assert.rejects(f._moveBetweenOwnBalances(100, 0, 2), /only Default <-> Combos/);
  }
  // Hard guard on the money call.
  {
    const f = mk(fakeDb(base()), fakeKalshi());
    await assert.rejects(f._moveDefaultToCombos(10001), /outside limits/);
    await assert.rejects(f._moveDefaultToCombos(0), /outside limits/);
  }
  // Boot scope log: names only.
  {
    const lines = [];
    const signed = async () => ({ statusCode: 200, text: JSON.stringify({ api_keys: [{ api_key_id: 'KID-1', scopes: ['read', 'write'] }] }) });
    const sc = await logOwnKeyScopes({ signed, keyId: 'KID-1', log: (m) => lines.push(m) });
    assert.deepEqual(sc, ['read', 'write']);
    assert.match(lines[0], /scopes: read,write transfer=yes/);
    assert.ok(!lines[0].includes('KID-1'));
  }
  // Tester env: global switch + limits pass through; Kevin's bucket flags never do.
  {
    const env = buildTesterEnv({ TESTER_AUTOFUND: '0', TESTER_FUND_MAX_MOVE_USD: '50', KALSHI_BUCKET_AUTO: '1', KALSHI_KEY_ID: 'kevin' }, { userId: T, kalshi: { keyId: 'k', secret: 's' } });
    assert.equal(env.TESTER_AUTOFUND, '0');
    assert.equal(env.TESTER_FUND_MAX_MOVE_USD, '50');
    assert.equal(env.KALSHI_BUCKET_AUTO, '0');
    assert.equal(env.KALSHI_KEY_ID, 'k');
  }
  // fund_unlimited tester: only their own Amount to keep for combos limits moves.
  {
    const s = base(); s.live = { ...s.live, fund_unlimited: true, max_per_day_usd: null }; s.settings = { kill_switch: false, autofund_cap_usd: 2000 };
    s.moves = [{ id: 'old', amount_usd: 900, status: 'confirmed', created_at: '2026-10-09T13:00:00Z' }];
    const db = fakeDb(s); const k = fakeKalshi({ main: 500000, combo: 30000 });
    const r = await mk(db, k).check();
    assert.equal(r.moved, 170000, 'no $100 per-move or $250 daily limit; tops up to $2,000');
    assert.deepEqual(k.transfers, [{ amountCenticents: 170000 * 100, fromShard: 0, toShard: 1 }]);
    assert.equal(db.inserts[0].cap_usd, 2000);
  }
  {
    const s = base(); s.live = { ...s.live, fund_unlimited: true, max_per_day_usd: null }; s.settings = { kill_switch: false, autofund_cap_usd: 500 };
    const db = fakeDb(s); const k = fakeKalshi({ combo: 150000 });
    assert.equal((await mk(db, k).check()).swept, 100000, 'sweep above own cap, no per-move limit');
    assert.deepEqual(k.transfers[0].fromShard, 1);
  }
  for (const cap of [undefined, null, 0]) {
    const s = base(); s.live = { ...s.live, fund_unlimited: true, max_per_day_usd: null }; s.settings = { kill_switch: false, autofund_cap_usd: cap };
    const db = fakeDb(s); const k = fakeKalshi();
    const r = await mk(db, k).check();
    assert.equal(k.transfers.length, 0, `blank cap (${cap}) never moves`); assert.equal(db.inserts.length, 0);
    assert.match(String(r.skipped), /no Amount to keep/);
  }
  {
    const s = base(); s.live = { ...s.live, fund_unlimited: true }; s.settings = { kill_switch: true, autofund_cap_usd: 2000 };
    const db = fakeDb(s); const k = fakeKalshi();
    await mk(db, k).check(); assert.equal(k.transfers.length, 0, 'kill switch still stops unlimited tester');
  }
  console.log('tester-funder.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
