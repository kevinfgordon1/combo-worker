'use strict';
// Poly sniper max quote life (Kevin Oct 30: "no quote alive more than 20 seconds"): 15s TTL sweeper,
// parallel delete lane with strict priority over posts, DELETE 400 handling, closed RFQs, post edge
// cushion (last look stays at the plain min), and the decline pause rebuilt from the ledger on restart.
const assert = require('assert');
const { createPolySniperLive, liveConfig } = require('./live');
const { polySniperConfig, decidePoly } = require('./engine');
const { createKalshiIndex } = require('./map');
const { fairVenues } = require('./feed');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const BASE = Date.parse('2026-10-24T16:00:00Z');
const KICK = Date.parse('2026-10-25T17:00:00Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkClock() { const start = Date.now(); const c = { off: 0, now: () => BASE + (Date.now() - start) + c.off }; return c; }
function fakeFeed(state = {}) {
  const s = { cost: 0.45, healthy: true, kickoffMs: KICK, ...state };
  const index = createKalshiIndex();
  index.ingestMarkets(['PHIWAS-PHI', 'PHIWAS-WAS', 'NYGDEN-NYG', 'NYGDEN-DEN', 'BUFNYJ-BUF', 'BUFNYJ-NYJ'].map((x) => ({ ticker: `KXNFLGAME-26OCT25${x}` })));
  return {
    s, index, venues: fairVenues({ POLY_SNIPER_FAIR_INCLUDE_POLY: '0' }), pricesHealthy: () => s.healthy, tdBook: null, ncaafBook: null,
    kickoffs: { kickoffFor: () => s.kickoffMs },
    pmLive: { legFair: () => ({ sources: [{ venue: 'novig', used: true, reason: 'ok', cost: s.cost, availUsd: 5000 }] }) },
  };
}
function fakeHttp() {
  let seq = 0;
  const h = {
    calls: { create: [], confirm: [], del: [], list: [] }, cash: 20000, delDelayMs: 0, delImpl: null, quoteStatus: {},
    inflight: 0, maxInflight: 0,
    async createQuote(b) { h.calls.create.push(b); return { quoteId: `q${++seq}` }; },
    async confirmQuote(r, q) { h.calls.confirm.push([r, q]); return {}; },
    async deleteQuote(r, q) {
      h.calls.del.push([r, q]); h.inflight += 1; h.maxInflight = Math.max(h.maxInflight, h.inflight);
      try { if (h.delDelayMs) await sleep(h.delDelayMs); if (h.delImpl) return await h.delImpl(r, q); return { statusCode: 200 }; } finally { h.inflight -= 1; }
    },
    async listQuotes(q) { h.calls.list.push(q); const st = h.quoteStatus[q.quoteId]; return { quotes: st ? [{ id: q.quoteId, rfqId: q.rfqId, status: st }] : [] }; },
    async listRfqs() { return { rfqs: [] }; },
    async request(m, p) { return p === '/v1/account/balances' ? { statusCode: 200, json: { balances: [{ currency: 'USD', currentBalance: h.cash, buyingPower: h.cash }] } } : { statusCode: 404 }; },
  };
  return h;
}
function fakeStore({ live = true, rows = [], outcomes = [], outcomesFail = false } = {}) {
  const st = {
    ctl: { live }, rows, inserts: [], patches: [], outcomes, outcomesFail,
    async readControl() { return { live: st.ctl.live }; },
    async hydrateOpen() { return st.rows; },
    async recentOutcomes() { if (st.outcomesFail) throw new Error('db down'); return st.outcomes; },
    insertQuote(r) { st.inserts.push(r); return Promise.resolve(true); },
    patch(id, p) { st.patches.push([id, p]); return Promise.resolve(true); },
    async dayTotals() { return { realized: 0, filledRisk: 0 }; },
    async flush() {},
  };
  return st;
}
let rseq = 0;
const ML2 = [{ symbol: 'aec-nfl-phi-was-2026-10-25', side: 'SIDE_BUY' }, { symbol: 'aec-nfl-nyg-den-2026-10-25', side: 'SIDE_SELL' }];
const rfq = (qty = '100') => ({ rfqId: `rfq_${++rseq}`, symbol: `crossd-${rseq}`, qtyDecimal: qty, tickSize: 0.001, createdTime: new Date(BASE).toISOString(), comboLegs: ML2 });

async function setup({ env = {}, live = true, rows = [], outcomes = [], outcomesFail = false } = {}) {
  const clock = mkClock(); const feed = fakeFeed(); const http = fakeHttp(); const store = fakeStore({ live, rows, outcomes, outcomesFail });
  const logs = []; const alerts = [];
  const engineConfig = polySniperConfig(env);
  const L = createPolySniperLive({ env, engineConfig, feed, store, log: (m) => logs.push(m), alert: (m) => alerts.push(m), now: clock.now, timers: false });
  await L.attach({ http, comboConfirming: () => 0 });
  const decide = (r, cushion = 0) => decidePoly(r, { feed, config: engineConfig, ledger: null, nowMs: clock.now(), skipLedger: true, edgeCushion: cushion });
  const post = async (r = rfq()) => { const d = decide(r); assert.strictEqual(d.action, 'quote', d.reason); return L.onDecision(r, d, { ageMs: 50 }); };
  const reason = (id) => { const p = store.patches.filter(([q, x]) => q === id && x.cancel_reason).pop(); return p && p[1].cancel_reason; };
  const settle = async (ms = 30) => { await sleep(ms); };
  return { L, I: L._internal, clock, feed, http, store, logs, alerts, post, decide, reason, settle };
}

t('config: max life 20s, TTL 15s and clamped to max life - 5s, faster sweep, wider delete lane, +0.5% post cushion', () => {
  const c = liveConfig({});
  assert.deepStrictEqual([c.maxQuoteLifeMs, c.quoteTtlMs, c.sweepMs, c.cancelRps, c.cancelConcurrency, c.cancelBacklogMax, c.cancelBacklogMs, c.postEdgeCushion], [20000, 15000, 1000, 50, 10, 20, 2000, 0.005]);
  assert.strictEqual(liveConfig({ POLY_SNIPER_QUOTE_TTL_MS: '60000' }).quoteTtlMs, 15000, 'an old 60s TTL env can never exceed max life - 5s');
  assert.strictEqual(liveConfig({ POLY_SNIPER_MAX_QUOTE_LIFE_MS: '30000', POLY_SNIPER_QUOTE_TTL_MS: '60000' }).quoteTtlMs, 25000);
  assert.strictEqual(liveConfig({ POLY_SNIPER_QUOTE_TTL_MS: '8000' }).quoteTtlMs, 8000);
  assert.strictEqual(liveConfig({ POLY_SNIPER_POST_EDGE_CUSHION: '0' }).postEdgeCushion, 0);
});

t('sweeper deletes every quote at 15s (before: 60s)', async () => {
  const S = await setup();
  const a = await S.post(); assert.ok(a.posted);
  S.clock.off += 14000; S.I.sweep(); await S.settle();
  assert.strictEqual(S.http.calls.del.length, 0, 'not yet at 14s');
  S.clock.off += 1000; S.I.sweep(); await S.settle();
  assert.deepStrictEqual(S.http.calls.del.map((x) => x[1]), [a.quoteId]);
  assert.strictEqual(S.reason(a.quoteId), 'ttl');
  assert.strictEqual(S.I.quotes.has(a.quoteId), false);
});

t('delete lane runs in parallel: 40 deletes at 100ms each finish in well under a second (old lane: 4s+)', async () => {
  const S = await setup();
  const ids = [];
  for (let i = 0; i < 40; i += 1) { const r = await S.post(); if (r.posted) ids.push(r.quoteId); else { S.clock.off += 1000; i -= 1; } }
  S.http.delDelayMs = 100;
  const t0 = Date.now();
  S.I.quotes.forEach((rec) => { rec.postedAt -= 16000; });
  S.I.sweep();
  while (S.I.cancelBacklog().pending) await sleep(10);
  const ms = Date.now() - t0;
  assert.strictEqual(S.http.calls.del.length, 40);
  assert.ok(S.http.maxInflight > 1 && S.http.maxInflight <= 10, `in flight ${S.http.maxInflight}`);
  assert.ok(ms < 900, `took ${ms}ms`);
});

t('deletes have strict priority: no posts while the delete lane is backed up, lagging, or a quote nears 20s', async () => {
  let r;
  // Lag: one pending delete waiting > 2s blocks posts even with a short queue.
  const S2 = await setup();
  const q = await S2.post(); assert.ok(q.posted);
  S2.I.cancelQueue.push({ quoteId: 'x', rfqId: 'y', reason: 't', tries: 0, rejects: 0, queuedAt: S2.clock.now() - 2500 });
  r = await S2.post(); assert.strictEqual(r.reason, 'cancel_lag');
  S2.I.cancelQueue.length = 0;
  // Age guard: an open quote at 18s+ (still not deleted) holds posting.
  S2.I.quotes.get(q.quoteId).postedAt = S2.clock.now() - 18500; S2.I.quotes.get(q.quoteId).cancelQueued = true;
  S2.clock.off += 1000;
  r = await S2.post(); assert.strictEqual(r.reason, 'quote_age_guard');
  // Once it is deleted, posting resumes.
  S2.I.quotes.get(q.quoteId).cancelQueued = false; S2.I.sweep(); await S2.settle();
  r = await S2.post(); assert.strictEqual(r.posted, true, r.reason);
});

t('backlog > 20 pending blocks posting', async () => {
  const S = await setup();
  for (let i = 0; i < 21; i += 1) S.I.cancelQueue.push({ quoteId: `z${i}`, rfqId: 'r', reason: 't', tries: 0, rejects: 0, queuedAt: S.clock.now() });
  const r = await S.post(); assert.strictEqual(r.reason, 'cancel_backlog');
});

t('DELETE 400: verified gone -> recorded already_gone, never retried', async () => {
  const S = await setup();
  const a = await S.post();
  S.http.delImpl = () => { const e = new Error('400 unable to process'); e.statusCode = 400; throw e; };
  S.http.quoteStatus[a.quoteId] = 'QUOTE_STATUS_DELETED';
  S.clock.off += 15000; S.I.sweep(); await S.settle(50);
  assert.strictEqual(S.http.calls.del.length, 1);
  assert.strictEqual(S.http.calls.list.length, 1);
  assert.strictEqual(S.reason(a.quoteId), 'ttl:already_gone_deleted');
  assert.strictEqual(S.L.stats().cancelRejected, 1);
  assert.ok(S.logs.some((m) => /cancel rejected 400/.test(m)));
});

t('DELETE 400 while still live: re-deleted up to 3 more times, then alert (never forever)', async () => {
  const S = await setup({ env: { POLY_SNIPER_DELETE_VERIFY_GAP_MS: '0' } });
  const a = await S.post();
  S.http.delImpl = () => { const e = new Error('400 unable to process'); e.statusCode = 400; throw e; };
  S.http.quoteStatus[a.quoteId] = 'QUOTE_STATUS_ACTIVE';
  S.clock.off += 15000; S.I.sweep(); await S.settle(150);
  assert.strictEqual(S.http.calls.del.length, 4);
  assert.strictEqual(S.reason(a.quoteId), 'ttl:delete_rejected_still_live');
  assert.ok(S.alerts.some((m) => /still QUOTE_STATUS_ACTIVE/.test(m)));
});

t('DELETE 400 with no verify budget left -> delete_rejected_400 (one GetQuotes per 3s max)', async () => {
  const S = await setup();
  const a = await S.post(); const b = await S.post();
  S.http.delImpl = () => { const e = new Error('400 unable to process'); e.statusCode = 400; throw e; };
  S.clock.off += 15000; S.I.sweep(); await S.settle(50);
  assert.strictEqual(S.http.calls.list.length, 1, 'only one verify read');
  const rs = [S.reason(a.quoteId), S.reason(b.quoteId)].sort();
  assert.deepStrictEqual(rs, ['ttl:delete_rejected_400', 'ttl:delete_rejected_400']); // verify found nothing -> unverified
});

t('404 = already gone; 5xx retried fast then succeeds', async () => {
  const S = await setup();
  const a = await S.post(); const b = await S.post();
  let n = 0;
  S.http.delImpl = (r, q) => {
    if (q === a.quoteId) return { statusCode: 404 };
    n += 1; if (n < 3) { const e = new Error('503'); e.statusCode = 503; throw e; }
    return { statusCode: 200 };
  };
  S.clock.off += 15000; S.I.sweep(); await S.settle(1000);
  assert.strictEqual(S.reason(a.quoteId), 'ttl:already_gone');
  assert.strictEqual(S.reason(b.quoteId), 'ttl');
  assert.strictEqual(n, 3);
});

t('closed RFQ: no DELETE (it can no longer be accepted), excluded from the age guard, dropped after grace', async () => {
  const S = await setup();
  const a = await S.post(); const rec = S.I.quotes.get(a.quoteId);
  S.L.onWsEvent({ type: 'rfqClosed', rfq: { id: rec.rfqId } });
  S.clock.off += 19000; S.I.sweep(); await S.settle();
  assert.strictEqual(S.http.calls.del.length, 0);
  assert.strictEqual(S.I.postGate(), null);
  S.clock.off += 30000; S.I.sweep(); await S.settle();
  assert.strictEqual(S.I.quotes.has(a.quoteId), false);
  assert.strictEqual(S.http.calls.del.length, 0);
});

t('max life exceeded -> logged + alert once, posting held', async () => {
  const S = await setup();
  const a = await S.post();
  S.http.delImpl = () => new Promise(() => {}); // DELETE hangs
  S.clock.off += 15000; S.I.sweep(); await S.settle();
  S.clock.off += 6000; S.I.sweep(); S.I.sweep();
  assert.strictEqual(S.alerts.filter((m) => /open 21/.test(m)).length, 1, S.alerts.join('\n'));
  assert.ok(S.logs.some((m) => /MAX QUOTE LIFE EXCEEDED/.test(m)));
  const r = await S.post(); assert.ok(['quote_age_guard', 'cancel_lag'].includes(r.reason), r.reason);
  assert.ok(S.L.stats().maxQuoteAgeMs >= 21000);
  void a;
});

t('post cushion: live posts price at min + 0.5%, last look still accepts down to the plain min', async () => {
  const S = await setup();
  const r = rfq('100');
  const plain = S.decide(r); const cushioned = S.decide(r, 0.005);
  assert.strictEqual(cushioned.minRoi, plain.minRoi, 'reported min edge is the plain minimum');
  assert.ok(cushioned.roi >= plain.minRoi + 0.005 - 1e-9, `${cushioned.roi}`);
  assert.ok(cushioned.buyPrice > plain.buyPrice);
  const p = await S.L.onDecision(r, cushioned, { ageMs: 50 }); assert.ok(p.posted);
  // Fair ticks against us by less than the cushion: last look (plain min) still confirms.
  S.feed.s.cost = 0.4515;
  const rec = S.I.quotes.get(p.quoteId);
  S.L.onWsEvent({ type: 'quoteAccepted', quote: { id: p.quoteId, rfqId: rec.rfqId, acceptedSide: 'SIDE_BUY', buyQtyDecimal: '100', confirmationDeadline: new Date(S.clock.now() + 3000).toISOString() } });
  await S.L.confirmIdle();
  assert.strictEqual(S.http.calls.confirm.length, 1, S.logs.filter((m) => /DECLINED/.test(m)).join('\n'));
});

t('decline pause survives restart: last hour accepts/declines loaded from the ledger', async () => {
  const at = (minAgo) => new Date(BASE - minAgo * 60000).toISOString();
  const outcomes = [];
  for (let i = 0; i < 8; i += 1) outcomes.push({ quote_id: `a${i}`, phase: 'filled', accepted_at: at(10 + i) });
  outcomes.push({ quote_id: 'd1', phase: 'declined', accepted_at: at(5) });
  outcomes.push({ quote_id: 'd2', phase: 'declined', accepted_at: at(6) });
  outcomes.push({ quote_id: 'old', phase: 'declined', accepted_at: at(90) }); // outside the hour
  const S = await setup({ outcomes });
  assert.strictEqual(S.L.state(), 'paused:decline_rate');
  assert.strictEqual(S.L.stats().declines, 2); assert.strictEqual(S.L.stats().accepts, 10);
  const r = await S.post(); assert.strictEqual(r.posted, false);
  // under 10%: no pause
  const S2 = await setup({ outcomes: outcomes.filter((o) => o.quote_id !== 'd2').concat(Array.from({ length: 5 }, (_, i) => ({ quote_id: `b${i}`, phase: 'filled', accepted_at: at(20) }))) });
  assert.strictEqual(S2.L.state(), 'live');
});

t('decline history unreadable -> paused (fail closed) until it loads', async () => {
  const S = await setup({ outcomesFail: true });
  assert.strictEqual(S.L.state(), 'paused:decline_history_unknown');
  assert.strictEqual((await S.post()).posted, false);
  S.store.outcomesFail = false;
  await S.I.loadDeclineHistory();
  assert.strictEqual(S.L.state(), 'live');
  assert.strictEqual((await S.post()).posted, true);
});

(async () => {
  let n = 0;
  for (const [name, fn] of tests) {
    try { await fn(); n += 1; console.log(`ok ${name}`); } catch (e) { console.error(`FAIL ${name}\n`, e); process.exit(1); }
  }
  console.log(`poly-sniper quote life: ${n} tests passed`);
  process.exit(0);
})();
