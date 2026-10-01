'use strict';
const assert = require('assert');
const {
  createPolyIntakeStats,
  createWsSeenSet,
  formatPolyHeartbeat,
  crawlOpenRfqs,
  prioritizeRfqs,
} = require('./poly-intake');
const {
  startPolymarketRfqLoop,
  logActiveLockIdentityFails,
  logUnpriceablePolyLocks,
  resetLockDiagLogs,
  LOCK_DIAG_LOG_MS,
} = require('./polymarket-rfq');

const SEED_B64 = Buffer.alloc(32, 7).toString('base64');
const noSleep = async () => {};

function pagedHttp(pages, { failAt = null, status = 403 } = {}) {
  const calls = [];
  return {
    calls,
    async listRfqs(q) {
      calls.push({ ...q });
      const i = q.cursor ? Number(q.cursor.replace('c', '')) : 0;
      if (failAt != null && i === failAt) {
        const e = new Error(`GET /v1/rfqs ${status}`);
        e.statusCode = status;
        throw e;
      }
      const rfqs = pages[i] || [];
      return { rfqs, cursor: i + 1 < pages.length ? `c${i + 1}` : '' };
    },
  };
}
const mk = (id) => ({ id, status: 'RFQ_STATUS_OPEN', qtyDecimal: '10', comboLegs: [] });

(async () => {
  // ── crawl: reads ALL pages, dedupes, passes cursor, polite delay ─────────
  {
    const pages = [[mk('a'), mk('b')], [mk('c'), mk('a')], [mk('d')]];
    const http = pagedHttp(pages);
    const sleeps = [];
    const res = await crawlOpenRfqs(http, { pageDelayMs: 250, sleep: async (ms) => sleeps.push(ms) });
    assert.deepStrictEqual(res.rows.map((r) => r.id), ['a', 'b', 'c', 'd']);
    assert.strictEqual(res.pages, 3);
    assert.strictEqual(res.truncated, false);
    assert.strictEqual(http.calls[0].cursor, undefined);
    assert.strictEqual(http.calls[1].cursor, 'c1');
    assert.strictEqual(http.calls[0].limit, 100);
    assert.strictEqual(http.calls[0].status, 'RFQ_STATUS_OPEN');
    assert.deepStrictEqual(sleeps, [250, 250], 'inter-page delay between pages (rate limit)');
  }
  // ── crawl: mid-crawl 403 keeps collected rows, marks truncated, no retry ─
  {
    const http = pagedHttp([[mk('a')], [mk('b')], [mk('c')]], { failAt: 2 });
    const res = await crawlOpenRfqs(http, { pageDelayMs: 0, sleep: noSleep });
    assert.deepStrictEqual(res.rows.map((r) => r.id), ['a', 'b']);
    assert.strictEqual(res.truncated, true);
    assert.strictEqual(res.error.forbidden, true);
    assert.strictEqual(http.calls.length, 3, 'a failing cursor is not retried');
  }
  // ── crawl: page-1 failure is thrown (auth logging path) ──────────────────
  {
    const http = pagedHttp([[mk('a')]], { failAt: 0, status: 401 });
    await assert.rejects(() => crawlOpenRfqs(http, { pageDelayMs: 0, sleep: noSleep }), /401/);
  }
  // ── crawl: page cap ──────────────────────────────────────────────────────
  {
    const http = pagedHttp([[mk('a')], [mk('b')], [mk('c')], [mk('d')]]);
    const res = await crawlOpenRfqs(http, { maxPages: 2, pageDelayMs: 0, sleep: noSleep });
    assert.strictEqual(res.pages, 2);
    assert.strictEqual(res.truncated, true);
  }
  // ── crawl: reuses a prefetched first page ────────────────────────────────
  {
    const http = pagedHttp([[mk('a')], [mk('b')]]);
    const first = await http.listRfqs({ limit: 100 });
    http.calls.length = 0;
    const res = await crawlOpenRfqs(http, { firstPage: first, pageDelayMs: 0, sleep: noSleep });
    assert.strictEqual(res.rows.length, 2);
    assert.strictEqual(http.calls.length, 1);
  }

  // ── prioritize ───────────────────────────────────────────────────────────
  {
    let yields = 0;
    const { exact, near, noise } = await prioritizeRfqs(
      [1, 2, 3, 4, 5, 6], (n) => (n === 6 ? 2 : n % 2 === 0 ? 1 : 0), { batch: 2, yieldFn: async () => { yields += 1; } }
    );
    assert.deepStrictEqual(exact, [6]);
    assert.deepStrictEqual(near, [2, 4]);
    assert.deepStrictEqual(noise, [1, 3, 5]);
    assert.strictEqual(yields, 3, 'yields to the event loop between batches');
  }

  // ── ws-seen set is bounded ───────────────────────────────────────────────
  {
    const s = createWsSeenSet(3);
    ['a', 'b', 'c', 'd'].forEach((x) => s.add(x));
    assert.strictEqual(s.size, 3);
    assert.ok(!s.has('a') && s.has('d'));
  }

  // ── stats: seen / sources / reasons / matched / quoted, interval roll ────
  {
    let t = 1000;
    const st = createPolyIntakeStats({ now: () => t });
    st.recordOutcome({ action: 'skip', reason: 'no_lock_overlap', overlap: { code: 'no_shared_game' } }, 'ws');
    st.recordOutcome({ action: 'skip', reason: 'no_lock_overlap', overlap: { code: 'leg_count' } }, 'ws');
    st.recordOutcome({ action: 'skip', reason: 'seen' }, 'rest');
    st.recordOutcome({ action: 'skip', reason: 'unmatched', parlay: null }, 'rest');
    st.recordOutcome({ action: 'skip', reason: 'rfq_too_large', parlay: { id: 'p' } }, 'ws');
    st.recordOutcome({ action: 'quoteable', post: false, reason: 'live_off', parlay: { id: 'p' } }, 'ws');
    st.recordOutcome({ action: 'quoteable', post: true, parlay: { id: 'p' } }, 'ws');
    st.noteBulkNoOverlap(10);
    st.recordCrawl({ rows: new Array(7), pages: 2, truncated: true }, 400);
    t = 61000;
    const snap = st.rollInterval();
    assert.strictEqual(snap.interval_s, 60);
    assert.strictEqual(snap.seen, 7 + 10);
    assert.strictEqual(snap.ws, 5);
    assert.strictEqual(snap.rest, 2 + 10);
    assert.strictEqual(snap.rest_only, 10);
    assert.strictEqual(snap.matched, 3);
    assert.strictEqual(snap.quoted, 1);
    assert.strictEqual(snap.would_quote, 1);
    assert.strictEqual(snap.declined, 2);
    assert.strictEqual(snap.crawl_pages, 2);
    assert.strictEqual(snap.crawl_truncated, 1);
    assert.strictEqual(snap.open_max, 7);
    assert.strictEqual(snap.reasons.no_lock_overlap, 12);
    assert.strictEqual(snap.reasons['overlap:no_shared_game'], 11);
    assert.strictEqual(snap.reasons.rfq_too_large, 1);
    assert.strictEqual(snap.reasons.quoted, 1);
    const line = formatPolyHeartbeat(snap);
    assert.ok(line.startsWith('[POLY] heartbeat interval=60s seen=17 ws=5 rest=12 rest_only=10'));
    assert.ok(/matched=3 quoted=1 would_quote=1 declined=2/.test(line));
    assert.ok(line.includes('reasons=no_lock_overlap=12'));
    const next = st.rollInterval();
    assert.strictEqual(next.seen, 0, 'counters reset each interval');
    assert.strictEqual(st.totals().seen, 17);
  }

  // ── loop: crawl evaluates lock candidates first, bulk-counts the rest ────
  {
    const lock = {
      id: 'tex-laa-lock', user_id: 'u1', label: 'Texas Rangers ML + Angels ML',
      parlay_stake: 100, parlay_american: 400, fill_american: 350, hedge_mode: '1x',
      max_contracts: 116,
      leg_keys: ['KXMLBGAME-26SEP031840TBTEX-TEX:yes', 'KXMLBGAME-26SEP031840LAAPIT-LAA:yes'],
      legs: [],
    };
    const match = {
      id: 'rfq_match', status: 'RFQ_STATUS_OPEN', qtyDecimal: '10',
      comboLegs: [
        { symbol: 'aec-mlb-tb-tex-2026-09-03-tex', side: 'SIDE_BUY' },
        { symbol: 'aec-mlb-laa-pit-2026-09-03-laa', side: 'SIDE_BUY' },
      ],
    };
    const noise = (i) => ({
      id: `rfq_noise_${i}`, status: 'RFQ_STATUS_OPEN', cashOrderQty: '10',
      comboLegs: [
        { symbol: 'aec-nfl-kc-buf-2026-10-04-kc', side: 'SIDE_BUY' },
        { symbol: 'aec-nfl-sf-lar-2026-10-04-sf', side: 'SIDE_BUY' },
      ],
    });
    const wsDup = { ...noise(99), id: 'rfq_ws_dup' };
    const pages = [
      [noise(1), noise(2), noise(3)],
      [wsDup, noise(4)],
      [match, noise(5)], // the only relevant RFQ is on the LAST page (invisible to a 100-row read)
    ];
    const http = {
      ...pagedHttp(pages),
      async getUserId() { return { rfqUserId: 'u' }; },
      async createQuote() { throw new Error('must not post in a live=false test'); },
      close() {},
    };
    http.listRfqs = pagedHttp(pages).listRfqs;
    const hb = [];
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    const loop = startPolymarketRfqLoop({
      env: { POLYMARKET_KEY_ID: 'k', POLYMARKET_SECRET_KEY: SEED_B64, POLYMARKET_RFQ_LIVE: 'false' },
      http,
      startWs: false,
      getParlays: () => [lock],
      fetchMarket: async () => null,
      startedFor: () => ({ started: false }),
      filledSoFarFor: () => 0,
      getOutstanding: () => 0,
      pendingQuotes: new Map(),
      reconcileMs: 60 * 60 * 1000,
      crawlPageDelayMs: 0,
      polyHeartbeatMs: 0,
      onPolyHeartbeat: (s) => hb.push(s),
    });
    try {
      // WS delivered one of the noise RFQs already.
      loop.onWsEvent({ type: 'rfqCreated', rfq: wsDup });
      await new Promise((r) => setTimeout(r, 20));
      const before = loop.intake.peek().seen;
      const out = await loop.crawlAllOpenRfqs();
      assert.strictEqual(out.open, 7);
      assert.strictEqual(out.exact, 1, 'last-page lock RFQ is found and prioritised');
      const snap = loop.emitPolyHeartbeat();
      assert.strictEqual(hb.length, 1);
      assert.ok(snap.crawl_pages >= 3);
      assert.ok(snap.seen >= before + 5, 'crawl RFQs are counted as seen');
      assert.ok(snap.candidates >= 1 && snap.matched >= 1, 'lock RFQ reached evaluation');
      assert.ok(snap.reasons['overlap:no_shared_game'] >= 5);
      assert.ok(snap.rest_only >= 5);
      assert.ok(logs.some((l) => /^\[POLY\] crawl open=7 pages=3 .*ws_dup=1 fresh=6 lock_exact=1/.test(l)), logs.filter((l) => l.includes('crawl')).join('\n'));
      assert.ok(logs.some((l) => l.startsWith('[POLY] heartbeat interval=')));
      // second crawl: nothing from the WS set is re-evaluated twice
    } finally {
      console.log = origLog;
      loop.stop();
    }
  }

  // ── cleanup 1: lock diag logs once per LOCK per interval ─────────────────
  {
    const mkLock = (id, label) => ({
      id, label,
      leg_keys: ['KXNFLSPREAD-26OCT04JAXSEA-SEA7:no'],
    });
    const a = mkLock('a', 'Jaguars/Seahawks spread');
    const b = mkLock('b', 'Texans spread');
    const realNow = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      resetLockDiagLogs();
      const out = [];
      assert.strictEqual(logUnpriceablePolyLocks([a, b], (m) => out.push(m)), 2);
      assert.strictEqual(out.length, 2, 'each failing lock logs once');
      assert.ok(out[0].includes('Jaguars/Seahawks') && out[1].includes('Texans'));
      for (let i = 0; i < 500; i += 1) {
        t += 3000;
        if (t - 1_000_000 >= LOCK_DIAG_LOG_MS) break;
        logUnpriceablePolyLocks([a, b], (m) => out.push(m));
      }
      assert.strictEqual(out.length, 2, 'no repeat inside the interval (was every 10s)');
      t = 1_000_000 + LOCK_DIAG_LOG_MS + 1;
      logUnpriceablePolyLocks([a, b], (m) => out.push(m));
      assert.strictEqual(out.length, 4, 'logs again after the interval');
      // a newly added lock logs immediately without re-logging the old ones
      const c = mkLock('c', 'Broncos spread');
      logUnpriceablePolyLocks([a, b, c], (m) => out.push(m));
      assert.strictEqual(out.length, 5);
      assert.ok(out[4].includes('Broncos'));
    } finally {
      Date.now = realNow;
      resetLockDiagLogs();
    }
  }

  console.log('poly-intake.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
