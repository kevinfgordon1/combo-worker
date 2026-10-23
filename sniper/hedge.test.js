'use strict';
// Logged sportsbook hedges: net worst-case math, in-memory cap mirror, daily P&L, book-arb skip, SQL parity.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { decimalOf, hedgeOutcome, netRiskOf, hedgePnl } = require('./hedge');
const { createSniperLedger } = require('../auto-sniper');
const { createLedgerStore } = require('./ledger-store');
const { createBookArbWatch } = require('./book-arb-watch');
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

(async () => {
  near(decimalOf(798), 8.98); near(decimalOf(-150), 1 + 100 / 150); assert.strictEqual(decimalOf(50), null); assert.strictEqual(decimalOf('x'), null);

  // Emanuel Wilson + Woody Marks (prod): n 64.75, cost 52.7713, fee 0.0001; FanDuel +798, $7.21 -> ~$4.77 locked.
  const wm = { n: 64.75, cost: 52.7713, fee: 0.0001 };
  const o = hedgeOutcome(wm, [{ book: 'FanDuel', american: 798, stake: 7.21 }]);
  near(o.hit, 7.21 * 7.98 - 52.7714); near(o.miss, 64.75 - 52.7714 - 7.21);
  assert.ok(o.locked && o.worst > 4.76 && o.worst < 4.8, JSON.stringify(o));
  assert.strictEqual(o.netRisk, 0);
  const row = { risk: 52.77, phase: 'filled', filled_contracts: 64.75, filled_cost: 52.7713, filled_fee: 0.0001 };
  assert.strictEqual(netRiskOf(row, [{ american: 798, stake: 7.21 }]), 0);
  // partial: $3 -> hit loss 52.7714 - 23.94
  near(netRiskOf(row, [{ american: 798, stake: 3 }]), 52.7714 - 23.94);
  // over-hedge: never below the miss-side loss, can exceed gross
  near(netRiskOf(row, [{ american: 798, stake: 20 }]), 20 - (64.75 - 52.7714));
  assert.ok(netRiskOf(row, [{ american: 798, stake: 200 }]) > row.risk);
  // void / bad / unfilled hedges never reduce risk
  assert.strictEqual(netRiskOf(row, [{ american: 798, stake: 7.21, status: 'void' }]), 52.77);
  assert.strictEqual(netRiskOf(row, [{ american: 20, stake: 7.21 }]), 52.77);
  assert.strictEqual(netRiskOf({ ...row, phase: 'quoted' }, [{ american: 798, stake: 7.21 }]), 52.77);
  assert.strictEqual(netRiskOf({ ...row, filled_contracts: 0 }, [{ american: 798, stake: 7.21 }]), 52.77);
  // reduction never exceeds the real worst case, for random hedges
  for (let i = 0; i < 2000; i += 1) {
    const hs = [{ american: Math.random() < 0.5 ? 100 + Math.floor(Math.random() * 2000) : -100 - Math.floor(Math.random() * 400), stake: Math.random() * 80 }];
    const x = hedgeOutcome(wm, hs); const net = netRiskOf(row, hs);
    assert.ok(net + 1e-9 >= -Math.min(x.hit, x.miss), 'net >= real worst-case loss');
  }
  near(hedgePnl('yes', [{ american: 798, stake: 7.21 }]), 7.21 * 7.98); near(hedgePnl('no', [{ american: 798, stake: 7.21 }]), -7.21);
  assert.strictEqual(hedgePnl('void', [{ american: 798, stake: 7.21 }]), 0);

  // In-memory mirror: refreshHedges sets pos.risk = net, restores gross when the hedge goes away; errors keep gross.
  let hedgeRows = [{ rfq_id: 'wm', american: 798, stake: 7.21, status: 'active' }]; let failHedges = false;
  const ledgerRows = [{ rfq_id: 'wm', ...row }, { rfq_id: 'u', risk: 100, phase: 'filled', filled_contracts: 120, filled_cost: 100, filled_fee: 0 }];
  const mk = (table) => { const q = { select() { return q; }, eq() { return q; }, in() { return q; }, limit() { return q; },
    then(res, rej) { return Promise.resolve(table === 'sniper_hedges' ? (failHedges ? { data: null, error: { message: 'x' } } : { data: hedgeRows, error: null }) : { data: ledgerRows, error: null }).then(res, rej); } }; return q; };
  const store = createLedgerStore({ supabase: { from: mk, rpc: async () => ({ data: {}, error: null }) }, log: () => {} });
  const L = createSniperLedger({ dayRiskOnAdd: false });
  L.positions.set('wm', { combo: 'a', games: ['G1'], legs: ['L1'], risk: 52.77, releaseAt: Date.now() + 1e9 });
  L.positions.set('u', { combo: 'b', games: ['G1'], legs: ['L2'], risk: 100, releaseAt: Date.now() + 1e9 });
  near(await store.refreshHedges(L, { live: true }), 52.77);
  assert.strictEqual(L.totals().total, 100); assert.strictEqual(L.totals().games.get('G1'), 100);
  failHedges = true; await store.refreshHedges(L, { live: true }); assert.strictEqual(L.positions.get('wm').risk, 52.77, 'read error -> gross (conservative)');
  failHedges = false; hedgeRows = []; await store.refreshHedges(L, { live: true });
  assert.strictEqual(L.positions.get('wm').risk, 52.77, 'gross restored when hedge deleted');

  // dayRealized adds hedge P&L of fills settled today; a failed hedge read throws (daily stop never under-counts).
  const settled = [{ rfq_id: 'wm', realized_pnl: -52.7714, market_result: 'yes' }];
  hedgeRows = [{ rfq_id: 'wm', american: 798, stake: 7.21, status: 'active' }];
  const store2 = createLedgerStore({ supabase: { from: (t) => { const q = mk(t); if (t === 'sniper_ledger') q.then = (res, rej) => Promise.resolve({ data: settled, error: null }).then(res, rej); q.gte = () => q; return q; } }, log: () => {} });
  near(await store2.dayRealized('2026-10-25T04:00:00Z'), -52.7714 + 7.21 * 7.98);
  failHedges = true; await assert.rejects(store2.dayRealized('2026-10-25T04:00:00Z')); failHedges = false;

  // Book-arb: hedged fills are priced and recorded (hedged: true) but never alerted.
  const sent = []; const decisions = [];
  const w = createBookArbWatch({ loadData: async () => ({}), store: { decision: async (d) => decisions.push(d) }, alert: (m) => sent.push(m) });
  const fake = require('./book-arb'); const orig = fake.checkFill;
  // stub via module cache: book-arb-watch destructured checkFill at load, so re-require with a patched cache
  delete require.cache[require.resolve('./book-arb-watch')];
  fake.checkFill = () => ({ reason: 'ok', books: [], best: { arb: true, locked: 4.77, label: 'FanDuel', american: 798 } });
  const { createBookArbWatch: cbw } = require('./book-arb-watch');
  const w2 = cbw({ loadData: async () => ({}), store: { decision: async (d) => decisions.push(d) }, alert: (m) => sent.push(m) });
  await w2.check({ rfqId: 'wm', legs: [], hedges: [{ american: 798, stake: 7.21 }] }, 'recheck');
  assert.strictEqual(sent.length, 0); assert.strictEqual(decisions[0].details.hedged, true); assert.strictEqual(w2.stats().skippedHedged, 1);
  fake.checkFill = orig; void w;

  // SQL parity: caps migration uses the same formula and one change point.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '20261023f_sniper_hedges_caps.sql'), 'utf8');
  assert.match(sql, /create or replace function public\.sniper_open_rows/);
  assert.match(sql, /greatest\(0,\s*\n?\s*\(coalesce\(p_cost, 0\) \+ coalesce\(p_fee, 0\)\) - p_win/);
  assert.match(sql, /status = 'active'/);
  console.log('sniper/hedge.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
