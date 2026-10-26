'use strict';
const test = require('node:test');
const assert = require('node:assert');
const m = require('./lock-auto-check');

test('rule: first at 10 missed, then every 20', () => {
  assert.equal(m.autoCheckDue({ missed: 9 }), false);
  assert.equal(m.autoCheckDue({ missed: 10 }), true);
  assert.equal(m.autoCheckDue({ missed: 29, lastMissed: 10 }), false);
  assert.equal(m.autoCheckDue({ missed: 30, lastMissed: 10 }), true);
  assert.equal(m.autoCheckDue({ missed: 50, lastMissed: 30 }), true);
  assert.equal(m.autoCheckDue({ missed: 12, lastMissed: 40 }), false); // counts shrank → re-baseline, wait 20 more
});

test('flags default off', () => {
  assert.equal(m.autoCheckEnabled({}), false);
  assert.equal(m.autoCheckTgEnabled({}), false);
  assert.equal(m.autoCheckEnabled({ COMBO_AUTO_CHECK: '1' }), true);
  assert.equal(m.waitMsFrom({}), 5000);
  assert.equal(m.waitMsFrom({ COMBO_AUTO_CHECK_WAIT_MS: '10000' }), 10000);
  assert.equal(m.waitMsFrom({ COMBO_AUTO_CHECK_WAIT_MS: '60000' }), 5000);
});

test('verdict on seller-side American', () => {
  assert.equal(m.verdict(1600, 1718), 'lose');
  assert.equal(m.verdict(1600, 1600), 'tie');
  assert.equal(m.verdict(1001, 900), 'win');
  assert.equal(m.verdict(1001, null), 'none');
});

test('eligible skips paused, poly-only, no size', () => {
  const legs = [{ ticker: 'KXNBAGAME-X-HOU' }];
  assert.equal(m.eligible({ legs, max_contracts: 10 }), true);
  assert.equal(m.eligible({ legs, max_contracts: 10, paused: true }), false);
  assert.equal(m.eligible({ legs: [{ ticker: 'caoc-1' }], max_contracts: 10 }), false);
  assert.equal(m.eligible({ legs, max_contracts: 0 }), false);
});

function fakeSupabase(state) {
  const q = (table) => {
    const ctx = { table, filters: [], patch: null, head: false };
    const api = {
      select(_c, o) { ctx.head = !!(o && o.head); return api; },
      update(p) { ctx.patch = p; return api; },
      eq(k, v) { ctx.filters.push([k, v]); return api; },
      not() { return api; },
      then(res, rej) {
        let out;
        if (ctx.patch) { state.updates.push({ table, patch: ctx.patch, filters: ctx.filters }); out = { error: null }; }
        else if (ctx.head) out = { count: state.missed, error: null };
        else out = { data: [], error: null };
        return Promise.resolve(out).then(res, rej);
      },
    };
    return api;
  };
  return { from: q };
}

test('tick: pauses only that lock, probes, deletes RFQ, saves result, alerts only with TG flag', async () => {
  for (const tgOn of [false, true]) {
    const state = { missed: 10, updates: [] };
    const calls = []; const alerts = []; let t = 0;
    const kalshi = async (method, p, body) => {
      calls.push(`${method} ${p.split('?')[0]}`);
      if (/multivariate_event_collections/.test(p) && method === 'GET') return { status: 200, data: { multivariate_contract: { associated_events: [{ ticker: 'KXNBAGAME-X' }, { ticker: 'KXNBAGAME-Y' }] } } };
      if (/multivariate_event_collections/.test(p)) return { status: 200, data: { market_ticker: 'KXMVE-ABC' } };
      if (/\/series\//.test(p)) return { status: 200, data: { series: { fee_type: 'quadratic_with_combo_maker_fees', fee_multiplier: 1 } } };
      if (/communications\/id/.test(p)) return { status: 200, data: { communications_id: 'me' } };
      if (method === 'POST' && /rfqs/.test(p)) return { status: 201, data: { id: 'rfq1' } };
      if (/quotes/.test(p)) return { status: 200, data: { quotes: [{ id: 'q1', creator_id: 'other', status: 'open', no_bid_dollars: '0.9450', yes_bid_dollars: '0' }, { id: 'q2', creator_id: 'me', status: 'open', no_bid_dollars: '0.99' }] } };
      return { status: 204, data: null };
    };
    const ac = m.createLockAutoCheck({
      supabase: fakeSupabase(state), kalshi, env: { COMBO_AUTO_CHECK: '1', COMBO_AUTO_CHECK_TG: tgOn ? '1' : '' },
      getParlays: () => [{ id: 'L1', label: 'Rutgers + Clemson', legs: [{ ticker: 'KXNBAGAME-X-HOU', side: 'yes' }, { ticker: 'KXNBAGAME-Y-IND', side: 'yes' }], max_contracts: 25, fill_american: 1600 }],
      sendAlert: async (x) => alerts.push(x), log: () => {}, now: () => (t += 600), sleep: async () => {},
    });
    const r = await ac.tick();
    assert.ok(r, 'ran');
    assert.ok(calls.includes('DELETE /trade-api/v2/communications/rfqs/rfq1'), 'RFQ deleted');
    assert.ok(!calls.some((c) => /accept|confirm/.test(c)), 'never accepts');
    const pauses = state.updates.filter((u) => 'probe_paused_at' in u.patch);
    assert.equal(pauses.length, 2); // set + clear
    assert.ok(pauses.every((u) => u.filters.some(([k, v]) => k === 'id' && v === 'L1')), 'only this lock');
    const saved = state.updates.find((u) => 'auto_check_at' in u.patch).patch;
    assert.equal(saved.auto_check_missed, 10);
    assert.equal(saved.auto_check_competitors, 1, 'own quote excluded');
    assert.ok(['win', 'lose', 'tie'].includes(saved.auto_check_result));
    if (saved.auto_check_result === 'lose') assert.equal(alerts.length, tgOn ? 1 : 0);
    else assert.equal(alerts.length, 0);
  }
});

test('flag off: tick does nothing', async () => {
  const ac = m.createLockAutoCheck({ supabase: {}, kalshi: async () => { throw new Error('no'); }, env: {}, getParlays: () => [{}], log: () => {} });
  assert.equal(await ac.tick(), null);
});
