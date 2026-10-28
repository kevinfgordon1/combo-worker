'use strict';
// Send-queue deadline (Oct 27 2026): per-RFQ 3s window, arrival/dequeue/token drops, EV priority,
// bounded queue, re-admission as the queue drains, busy low-value skip, same-price re-quote memo.
const assert = require('node:assert');
const { createQuoteSender, isStaleDrop } = require('../quote-sender');
const { createLimiter } = require('./limiter');
const { createSniperTrader } = require('./trader');
const { postFailKey, createLiveSniper } = require('./live');
const { sendWindowConfig, createPostEstimator, lowValueWhenBusy, createRequoteMemo } = require('./send-window');

// Throwaway RSA key generated per run (signing only; never a real credential).
const TEST_PEM = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // ── config defaults ──
  const c0 = sendWindowConfig({});
  assert.strictEqual(c0.enabled, true); assert.strictEqual(c0.windowMs, 3000); assert.strictEqual(c0.safetyMs, 250);
  assert.strictEqual(sendWindowConfig({ SNIPER_POST_DEADLINE_MS: '2500' }).windowMs, 2500);
  assert.strictEqual(sendWindowConfig({ SNIPER_QUOTE_WINDOW_MS: '4000', SNIPER_POST_DEADLINE_MS: '2500' }).windowMs, 4000);
  assert.strictEqual(sendWindowConfig({ SNIPER_SEND_DEADLINE: '0' }).enabled, false);

  // ── arrival admission from queue position at rps ──
  // window 3000, safety 0, rps 10/s, post 100ms. Kalshi clock fixed; RFQ created at t=0, now=1000.
  let server = 1000;
  const mk = (over = {}) => createQuoteSender({
    maxConcurrent: 1, maxQueueMs: 1e9, serverNow: () => server,
    deadline: { windowMs: 3000, safetyMs: 0, rps: 10, postEstMs: 100, ...over },
  });
  {
    const s = mk(); let rel; const done = [];
    const hold = s.send('a', 0, () => new Promise((r) => { rel = r; }), { priority: 5 }); // active=1
    await tick();
    // ahead = queue pos + active. Projected = 1000 + ahead*100 + 100. Window 3000 → ahead ≤ 19.
    const ps = [];
    for (let i = 0; i < 25; i += 1) ps.push(s.send(`r${i}`, 0, async () => { done.push(i); return i; }, { priority: 1 }).catch((e) => e));
    // queue capacity = floor(10 * (3000-0-100)/1000) = 29, so the drops here are "expired" at arrival.
    const st = s.stats();
    assert.strictEqual(st.expiredAtArrival, 6, `arrival drops ${JSON.stringify(st)}`); // ahead 19..24 late (r19..r24)
    assert.strictEqual(st.queued, 19);
    // ── per RFQ, not a lockout: drain the queue, then a fresh RFQ is admitted again ──
    rel(); await hold; const out = await Promise.all(ps);
    assert.strictEqual(out.filter((x) => x instanceof Error).length, 6);
    assert.ok(out.filter((x) => x instanceof Error).every((e) => isStaleDrop(e) && /STALE_DROP expired/.test(e.message)));
    assert.strictEqual(postFailKey(out[24]), 'stale_drop:expired');
    const fresh = await s.send('fresh', 0, async () => 'ok', { priority: 1 });
    assert.strictEqual(fresh, 'ok');
  }

  // ── higher EV jumps ahead and is admitted even when a low-EV one at the back would not be ──
  {
    const s = mk(); let rel;
    const hold = s.send('a', 0, () => new Promise((r) => { rel = r; }), { priority: 9 }); await tick();
    const lows = []; for (let i = 0; i < 19; i += 1) lows.push(s.send(`l${i}`, 0, async () => i, { priority: 1 }).catch((e) => e));
    const lateLow = await s.send('late-low', 0, async () => 'x', { priority: 1 }).catch((e) => e);
    assert.ok(lateLow instanceof Error && /expired/.test(lateLow.message));
    const order = []; const hi = s.send('hi', 0, async () => { order.push('hi'); return 'hi'; }, { priority: 50 });
    assert.strictEqual(s.admission(0, 50).position, 1); // behind "hi" (ties FIFO)
    rel(); await hold; assert.strictEqual(await hi, 'hi'); assert.strictEqual(order[0], 'hi');
    await Promise.all(lows);
  }

  // ── bounded queue = what rps can clear in the window; lowest EV is dropped as low_priority ──
  {
    server = 0; // fresh RFQs: age 0
    const s = mk({ rps: 2 }); // capacity = floor(2 * 2900/1000) = 5
    assert.strictEqual(s.capacity(), 5);
    let rel; const hold = s.send('a', 0, () => new Promise((r) => { rel = r; }), { priority: 9 }); await tick();
    const ps = [];
    // projected for ahead n = n*500+100 → ahead ≤ 5 ok. Send 5 at prio 1 (ahead 1..5), then a prio-8
    // that goes to the front: queue 6 > cap 5 → the newest prio-1 is dropped as low_priority.
    for (let i = 0; i < 5; i += 1) ps.push(s.send(`p${i}`, 0, async () => i, { priority: 1 }).catch((e) => e));
    const top = s.send('top', 0, async () => 'top', { priority: 8 });
    assert.strictEqual(s.stats().lowPriority, 1);
    rel(); await hold; assert.strictEqual(await top, 'top');
    const out = await Promise.all(ps);
    assert.ok(out[4] instanceof Error && /low_priority/.test(out[4].message));
    assert.strictEqual(postFailKey(out[4]), 'stale_drop:low_priority');
  }

  // ── dequeue re-check: an RFQ that aged out while queued is dropped, never sent ──
  {
    server = 0; const s = mk(); let rel; let sent = false;
    const hold = s.send('a', 0, () => new Promise((r) => { rel = r; }), { priority: 9 }); await tick();
    const p = s.send('b', 0, async () => { sent = true; }, { priority: 1 }).catch((e) => e);
    server = 2950; rel(); await hold; const e = await p;
    assert.ok(e instanceof Error && /expired/.test(e.message)); assert.strictEqual(sent, false);
    assert.strictEqual(s.stats().expiredAtDequeue, 1);
  }

  // ── fn gets abortIf, true once the POST can no longer land in the window ──
  {
    server = 0; const s = mk(); let ab = null;
    await s.send('c', 0, async (ctx) => { ab = ctx.abortIf; });
    assert.strictEqual(ab(), false); server = 2950; assert.strictEqual(ab(), true);
    // no deadline (combo-worker): no abortIf, old reasons unchanged
    const legacy = createQuoteSender({ maxConcurrent: 1 }); let ctx0;
    await legacy.send('d', null, async (ctx) => { ctx0 = ctx; });
    assert.strictEqual(ctx0.abortIf, null);
  }

  // ── trader: token wait aborts past the window → STALE_DROP expired, nothing on the wire ──
  {
    const T0 = 1.8e12; let t = T0; let wire = 0;
    const L = createLimiter({ name: 'kt', ratePerSec: 1, burst: 1, now: () => t, sleep: async (ms) => { t += ms; } });
    await L.run(async () => ({ ok: true })); // spend the only token → next waits 1000ms
    const tr = createSniperTrader({
      gate: { live: true }, keyId: 'test-key', pem: TEST_PEM, subaccount: 1, limiter: L, log: () => {},
      sendWindow: { enabled: true, windowMs: 3000, safetyMs: 250, postEstMinMs: 60, postEstMaxMs: 1000 },
      now: () => t, serverNow: () => t,
      request: async () => { wire += 1; return { statusCode: 201, headers: {}, text: '{"id":"q1"}' }; },
    });
    // RFQ created at -1800 (age 1800 now): admitted (ahead 0 → 1800+150 < 2750) but the token wait
    // pushes it past the window → abort at the token, no POST.
    const err = await tr.postQuote({ rfqId: 'r1', createdTs: T0 - 1800, contracts: 10 }, 0.3, 0.01).catch((e) => e);
    assert.ok(err instanceof Error, 'expected a drop');
    assert.strictEqual(postFailKey(err), 'stale_drop:expired');
    assert.strictEqual(wire, 0);
    assert.strictEqual(tr.stats().expiredAtToken, 1);
    // A fresh one goes through and feeds the POST estimate.
    const ok = await tr.postQuote({ rfqId: 'r2', createdTs: t, contracts: 10 }, 0.3, 0.01);
    assert.strictEqual(ok.quoteId, 'q1'); assert.strictEqual(wire, 1);
    assert.ok(tr.admission({ createdTs: t }, 1).ok);
    assert.ok(!tr.admission({ createdTs: t - 2900 }, 1).ok);
  }

  // ── post estimator clamps ──
  { const e = createPostEstimator({ minMs: 60, maxMs: 1000, initMs: 150 }); for (let i = 0; i < 50; i += 1) e.add(10000); assert.strictEqual(e.get(), 1000); for (let i = 0; i < 200; i += 1) e.add(1); assert.strictEqual(e.get(), 60); }

  // ── busy-queue low-value skip ──
  {
    const cfg = sendWindowConfig({});
    const big = { legs: [1, 2, 3, 4, 5, 6], ev: 0.2 }; const good = { legs: [1, 2, 3, 4, 5, 6], ev: 2 }; const two = { legs: [1, 2], ev: 0.05 };
    assert.strictEqual(lowValueWhenBusy(big, { queued: 30, capacity: 46 }, cfg), true);
    assert.strictEqual(lowValueWhenBusy(big, { queued: 10, capacity: 46 }, cfg), false); // not busy
    assert.strictEqual(lowValueWhenBusy(good, { queued: 46, capacity: 46 }, cfg), false); // worth it
    assert.strictEqual(lowValueWhenBusy(two, { queued: 46, capacity: 46 }, cfg), false); // few legs
    assert.strictEqual(lowValueWhenBusy(big, { queued: 46, capacity: 46 }, { ...cfg, busyMaxLegs: 0 }), false);
  }

  // ── re-quote memo: same combo+size at the same NO bid is skipped; a price move is not ──
  {
    let t = 0; const m = createRequoteMemo({ windowMs: 15000, now: () => t });
    const d = { combo: 'A:yes|B:yes', contracts: 10 };
    assert.strictEqual(m.isRepeat(d, '0.67'), false);
    m.note(d, '0.67');
    assert.strictEqual(m.isRepeat(d, '0.67'), true);
    assert.strictEqual(m.isRepeat(d, '0.68'), false); // price moved
    assert.strictEqual(m.isRepeat({ ...d, contracts: 20 }, '0.67'), false); // different size
    t = 16000; assert.strictEqual(m.isRepeat(d, '0.67'), false); // window passed
    const off = createRequoteMemo({ windowMs: 0 }); off.note(d, '0.67'); assert.strictEqual(off.isRepeat(d, '0.67'), false);
  }

  // ── live sniper: counts dropped_expired / dropped_low_priority, send latency, notes re-quotes ──
  {
    let t = 10000; let mode = 'expired';
    const memo = createRequoteMemo({ windowMs: 15000, now: () => t });
    const logs = [];
    const trader = {
      live: true,
      postQuote: async () => {
        if (mode === 'expired') { const e = new Error('STALE_DROP expired projected=3100ms'); e.staleDrop = true; throw e; }
        if (mode === 'low') { const e = new Error('STALE_DROP low_priority queued=47 cap=46'); e.staleDrop = true; throw e; }
        t += 40; return { quoteId: `q${t}`, noBid: '0.67', yesBid: '0' };
      },
      cancel: async () => ({}),
    };
    const store = { release: async () => {}, update: async () => {} };
    const L = createLiveSniper({
      config: { minRoi: 0.01, tick: 0.01, maxPayout: 1e9 }, trader, store,
      coord: { blockReason: () => null, comboWorkerQuoting: async () => null }, caps: () => ({}), reprice: () => 0.25,
      log: (m) => logs.push(m), now: () => t, requoteMemo: memo, ttlMs: 1e9,
    });
    const d = { rfqId: 'x1', combo: 'A:yes|B:yes', contracts: 10, quoteYes: 0.33, makerRate: 0, legs: ['A:yes', 'B:yes'] };
    const rfq = { rfqId: 'x1', recvAt: t, recvAge: 30 };
    assert.strictEqual((await L.send(rfq, d)).reason, 'post_stale_drop');
    mode = 'low'; assert.strictEqual((await L.send({ ...rfq, rfqId: 'x2' }, { ...d, rfqId: 'x2' })).reason, 'post_stale_drop');
    mode = 'ok'; const r = await L.send({ rfqId: 'x3', recvAt: t, recvAge: 30 }, { ...d, rfqId: 'x3' });
    assert.strictEqual(r.sent, true);
    const st = L.stats();
    assert.strictEqual(st.droppedExpired, 1); assert.strictEqual(st.droppedLowPriority, 1);
    assert.strictEqual(st.sendP50, 70); assert.strictEqual(st.sendP90, 70);
    assert.strictEqual(memo.isRepeat(d, '0.67'), true);
    // routine deadline drops are counted, not logged one by one
    assert.ok(!logs.some((m) => /quote POST failed/.test(m)), logs.join('\n'));
  }
  console.log('send-window tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
