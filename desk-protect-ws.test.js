'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  evaluateBookProtect,
  evaluateTradeProtect,
} = require('./desk-protect-ws-decide');
const {
  parseMarketFrame,
  executionsFromFrame,
  ordersFromPayload,
  createMarketFeed,
} = require('./desk-protect-ws-feed');
const {
  resolveWsProtectEnabled,
  createDeskProtectWs,
  createMemoryAudit,
  createSupabaseSide,
  ARMED_COLUMNS,
  ARMED_STATUSES,
  ARM_MS,
  POLL_OFF_MS,
  DEFAULT_SILENT_MS,
} = require('./desk-protect-ws');

const SECRET = 'desk-protect-test-secret';
const SWEEP = 'https://aibetbuilder.example/api/desk-protect-sweep';
const SLUG = 'aec-nfl-chi-det-2026-11-09';

function envOn(extra) {
  return {
    DESK_PROTECT_WS: '1',
    DESK_PROTECT_SWEEP_URL: SWEEP,
    DESK_PROTECT_SWEEP_SECRET: SECRET,
    ...extra,
  };
}

function level(px, qty) {
  return { px: { value: String(px), currency: 'USD' }, qty: String(qty) };
}

function armed(overrides) {
  return {
    order_id: 'ord-bears',
    owner_email: 'kev120909@gmail.com',
    market_slug: SLUG,
    outcome: 'long',
    action: 'buy',
    yes_price: '0.7775',
    outcome_micro: 777500,
    contracts: 100,
    x_cents: 2,
    y_cents: 0.5,
    lineage_id: 'ord-bears',
    protect_count: 0,
    status: 'armed',
    title: 'Bears',
    outcome_name: 'Bears',
    ...overrides,
  };
}

function memoryStore(seed) {
  const map = new Map();
  for (const row of seed) map.set(row.order_id, { ...row });
  return {
    map,
    async listArmed() { return [...map.values()]; },
    async claim(id, token, { fromStatus } = {}) {
      const row = map.get(id);
      if (!row || row.status !== fromStatus) return null;
      row.status = 'sweeping';
      row.sweep_token = token;
      row.hold_from = fromStatus;
      return { ...row };
    },
    async update(id, patch, { token } = {}) {
      const row = map.get(id);
      if (!row) return null;
      if (token && row.sweep_token !== token) return null;
      Object.assign(row, patch);
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'sweep_token')) row.sweep_token = patch.sweep_token;
      return { ...row };
    },
  };
}

function openOrder(id, yes, leaves, intent = 'ORDER_INTENT_BUY_LONG') {
  return {
    id,
    marketSlug: SLUG,
    intent,
    price: { value: String(yes), currency: 'USD' },
    quantity: leaves,
    leavesQuantity: leaves,
    state: 'ORDER_STATE_NEW',
  };
}

function fakeFeed() {
  return {
    open: false,
    everOpened: false,
    lastPongAt: 0,
    lastMessageAt: 0,
    slugCount: 0,
    setSlugs(list) {
      this.everOpened = true;
      this.open = true;
      this.slugCount = (list || []).length;
    },
    stop() { this.open = false; },
    stats() {
      return {
        open: this.open,
        everOpened: this.everOpened,
        lastPongAt: this.lastPongAt,
        lastMessageAt: this.lastMessageAt,
        slugs: this.slugCount,
        privateOpen: false,
      };
    },
  };
}

function harness(overrides = {}) {
  const cancels = [];
  const posts = [];
  const store = overrides.store || memoryStore([armed()]);
  const audits = createMemoryAudit();
  const feed = overrides.feed || fakeFeed();
  let clock = overrides.clock == null ? 1_700_000_000_000 : overrides.clock;
  const client = overrides.client || {
    async listOpenOrders() {
      return { orders: [openOrder('ord-bears', 0.7775, 100)] };
    },
    async cancelOrder(id, slug) {
      clock += overrides.cancelLag == null ? 17 : overrides.cancelLag;
      cancels.push({ id, slug, at: clock });
      return { statusCode: 200 };
    },
  };
  const engine = createDeskProtectWs({
    env: overrides.env || envOn(),
    control: overrides.control == null ? { present: false } : overrides.control,
    store,
    audits,
    client,
    feed,
    fetchImpl: overrides.fetchImpl || (async (_url, opts) => {
      posts.push(JSON.parse(opts.body));
      return {
        status: 200,
        async json() { return overrides.handoff || { ok: true, actions: [{ result: 'rereset', newOrderId: 'ord-next' }] }; },
        async text() { return ''; },
      };
    }),
    now: () => clock,
    timers: false,
    silentMs: overrides.silentMs || DEFAULT_SILENT_MS,
    log: () => {},
    logError: () => {},
  });
  return {
    engine,
    store,
    audits,
    feed,
    cancels,
    posts,
    now: () => clock,
    setClock(n) { clock = n; },
    addClock(n) { clock += n; },
  };
}

function book(bids, offers, extra) {
  return {
    slug: SLUG,
    bids,
    offers: offers || [level(0.79, 400)],
    transactTime: new Date(1_700_000_000_000).toISOString(),
    stats: extra && extra.stats,
  };
}

(async () => {
  assert.deepStrictEqual(resolveWsProtectEnabled({ env: {}, control: { present: false } }), { enabled: false, reason: 'default-off' });
  assert.equal(resolveWsProtectEnabled({ env: { DESK_PROTECT_WS: '1' }, control: { present: true, enabled: false } }).enabled, true);
  assert.equal(resolveWsProtectEnabled({ env: { DESK_PROTECT_WS: '0' }, control: { present: true, enabled: true } }).reason, 'env-off');
  assert.equal(resolveWsProtectEnabled({ env: {}, control: { present: true, enabled: true } }).reason, 'control');
  assert.equal(resolveWsProtectEnabled({ env: {}, control: { present: false, error: 'down' } }).reason, 'control-unread');

  const src = fs.readFileSync(path.join(__dirname, 'desk-protect-ws.js'), 'utf8');
  assert.ok(!src.includes('createOrder'), 'worker must not place the replacement');
  assert.ok(src.includes('ws-replace'));
  assert.ok(src.includes('pending_lineage'));
  assert.ok(src.includes('pending_book'));
  assert.ok(fs.readFileSync(path.join(__dirname, 'polymarket-client.js'), 'utf8').includes("getJson('/v1/orders/open'"));
  const toml = fs.readFileSync(path.join(__dirname, 'fly/poly-worker.toml'), 'utf8');
  assert.ok(!/DESK_PROTECT_WS\s*=\s*"1"/.test(toml), 'deploy toml must not turn the flag on');

  // Local decision on a pick. 77.75c buy, our size is the whole touch, next bid 75c.
  const t0 = process.hrtime.bigint();
  let hit = null;
  for (let i = 0; i < 1000; i += 1) {
    hit = evaluateBookProtect({
      outcome: 'long',
      action: 'buy',
      yesPrice: 0.7775,
      bids: [level(0.7775, 100), level(0.75, 500)],
      offers: [level(0.79, 400)],
      ownBids: [{ yesPrice: 0.7775, leaves: 100 }],
      ownOffers: [],
      xCents: 2,
      receivedAgeMs: 0,
      feedAgeMs: 40,
    });
  }
  const decisionUs = Number(process.hrtime.bigint() - t0) / 1000 / 1000;
  assert.equal(hit.fire, true);
  assert.equal(hit.reason, 'through');
  assert.ok(decisionUs < 50, `1000 book decisions took ${decisionUs}ms`);
  console.log(`desk-protect-ws decision 1000x ${decisionUs.toFixed(2)}ms (${(decisionUs / 1000).toFixed(3)}ms each)`);

  // Exactly the cushion does not fire. One tenth past it does.
  assert.equal(evaluateBookProtect({
    outcome: 'long', action: 'buy', yesPrice: 0.7775,
    bids: [level(0.7775, 100), level(0.7575, 10)],
    offers: [level(0.79, 10)],
    ownBids: [{ yesPrice: 0.7775, leaves: 100 }], ownOffers: [],
    xCents: 2, receivedAgeMs: 0,
  }).fire, false);
  assert.equal(evaluateTradeProtect({
    outcome: 'long', action: 'buy', yesPrice: 0.7775,
    tradeYes: 0.7775, tradeAtMs: 1000, nowMs: 1100, xCents: 2,
    ownYesPrices: [0.7775],
  }).reason, 'own-fill');
  const traded = evaluateTradeProtect({
    outcome: 'long', action: 'buy', yesPrice: 0.7775,
    tradeYes: 0.75, tradeAtMs: 1000, nowMs: 1100, xCents: 2,
    ownYesPrices: [0.7775],
  });
  assert.equal(traded.fire, true);
  assert.equal(traded.reason, 'trade-through');

  {
    const h = harness();
    await h.engine.refreshArmed();
    const eventAt = h.now();
    await h.engine.onBook(book([level(0.7775, 100), level(0.75, 500)]), eventAt);
    assert.equal(h.cancels.length, 1);
    assert.equal(h.cancels[0].id, 'ord-bears');
    assert.equal(h.cancels[0].at - eventAt, 17);
    const saved = h.audits.rows.find((row) => row.action === 'cancelled');
    assert.equal(saved.trigger, 'ws-through');
    assert.equal(saved.latencyMs, 17);
    assert.equal(saved.cancelResult, 'ok');
    assert.equal(h.store.map.get('ord-bears').status, 'pending_lineage');
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].op, 'ws-replace');
    assert.equal(h.posts[0].trigger, 'ws-through');
    assert.equal(h.posts[0].canceled, true);
    assert.equal(h.posts[0].mode, 'adverse-only');
    assert.ok(!JSON.stringify(h.posts[0]).includes(SECRET));
  }

  {
    const h = harness();
    await h.engine.refreshArmed();
    await h.engine.onBook(book([level(0.7775, 180), level(0.75, 500)]), h.now());
    assert.equal(h.cancels.length, 0, 'other size still at our price');
    assert.equal(h.posts.length, 0);
  }

  {
    const h = harness({
      client: {
        async listOpenOrders() {
          return { orders: [openOrder('ord-bears', 0.7775, 100), openOrder('ord-other', 0.7775, 40)] };
        },
        async cancelOrder() { throw new Error('should not cancel'); },
      },
    });
    await h.engine.refreshArmed();
    await h.engine.onBook(book([level(0.7775, 200), level(0.75, 500)]), h.now());
    assert.equal(h.cancels.length, 0, 'size we do not own is still resting at our price');
  }

  {
    const h = harness();
    await h.engine.refreshArmed();
    await h.engine.onTrade({ slug: SLUG, price: 0.75, ts: h.now() - 20, id: 't-through', orderId: '' }, h.now());
    assert.equal(h.cancels.length, 1);
    assert.equal(h.audits.rows.find((row) => row.action === 'cancelled').trigger, 'ws-trade');
    assert.equal(h.posts[0].trigger, 'ws-trade');
    assert.equal(h.posts[0].tradeYes, 0.75);
  }

  {
    const h = harness();
    await h.engine.refreshArmed();
    await h.engine.onTrade({ slug: SLUG, price: 0.7775, ts: h.now() - 20, id: 't-own', orderId: 'ord-bears' }, h.now());
    assert.equal(h.cancels.length, 0, 'our own fill is not a pick');
  }

  {
    const h = harness();
    await h.engine.refreshArmed();
    h.feed.lastPongAt = h.now();
    h.feed.lastMessageAt = h.now();
    await h.engine.onBook(book([level(0.7775, 100), level(0.77, 10)]), h.now());
    assert.equal(h.cancels.length, 0, 'inside the cushion');
    h.addClock(DEFAULT_SILENT_MS + 50);
    h.feed.lastPongAt = h.now();
    await h.engine.checkSilence();
    assert.equal(h.cancels.length, 0, 'fresh pong and a live book is a quiet market');
  }

  {
    const h = harness();
    await h.engine.refreshArmed();
    h.feed.lastPongAt = h.now() - 10000;
    h.feed.lastMessageAt = h.now() - 10000;
    await h.engine.checkSilence();
    assert.equal(h.cancels.length, 1);
    assert.equal(h.audits.rows.find((row) => row.action === 'cancelled').trigger, 'ws-disconnect');
    assert.equal(h.store.map.get('ord-bears').status, 'pending_book');
    assert.equal(h.posts.length, 0, 'do not re-rest while the socket is blind');
  }

  {
    const h = harness();
    await h.engine.refreshArmed();
    h.addClock(DEFAULT_SILENT_MS + 10);
    h.feed.lastPongAt = h.now();
    await h.engine.checkSilence();
    assert.equal(h.cancels.length, 1, 'subscribed market with no book is a fail-safe cancel');
    assert.equal(h.store.map.get('ord-bears').status, 'pending_book');
  }

  {
    const h = harness();
    await h.engine.refreshArmed();
    h.feed.open = false;
    await h.engine.checkSilence();
    assert.equal(h.cancels.length, 1);
    assert.equal(h.posts.length, 0);
  }

  {
    let claims = 0;
    const store = memoryStore([armed()]);
    const orig = store.claim.bind(store);
    store.claim = async (...args) => {
      claims += 1;
      if (claims > 1) return null;
      return orig(...args);
    };
    const h = harness({ store });
    await h.engine.refreshArmed();
    const snap = book([level(0.7775, 100), level(0.75, 500)]);
    await Promise.all([h.engine.onBook(snap, h.now()), h.engine.onBook(snap, h.now())]);
    assert.equal(h.cancels.length, 1, 'websocket and a second tick cannot double-cancel');
    assert.equal(h.posts.length, 1);
  }

  {
    const store = memoryStore([armed()]);
    store.claim = async () => null;
    const h = harness({ store });
    await h.engine.refreshArmed();
    await h.engine.onBook(book([level(0.7775, 100), level(0.75, 500)]), h.now());
    assert.equal(h.cancels.length, 0, 'REST sweep already claimed the row');
    assert.equal(h.posts.length, 0);
  }

  {
    const h = harness({
      handoff: { ok: true, actions: [{ result: 'cancelled', reason: 'chain-cap' }] },
    });
    await h.engine.refreshArmed();
    await h.engine.onBook(book([level(0.7775, 100), level(0.75, 500)]), h.now());
    assert.equal(h.cancels.length, 1);
    assert.equal(h.posts.length, 1);
    assert.equal(h.store.map.get('ord-bears').status, 'pending_lineage');
    const again = book([level(0.7775, 100), level(0.75, 500)]);
    await h.engine.onBook(again, h.now());
    assert.equal(h.cancels.length, 1, 'chain-cap handoff does not cancel or place again');
  }

  {
    const h = harness({ env: { DESK_PROTECT_SWEEP_URL: SWEEP, DESK_PROTECT_SWEEP_SECRET: SECRET } });
    await h.engine.refreshArmed();
    await h.engine.onBook(book([level(0.7775, 100), level(0.75, 500)]), h.now());
    assert.equal(h.cancels.length, 0, 'flag default off');
    assert.equal(h.engine.flag().reason, 'default-off');
  }

  {
    const orders = ordersFromPayload({
      orders: [openOrder('ord-bears', 0.7775, 100)],
    });
    assert.equal(orders[0].bookSide, 'buy');
    assert.equal(orders[0].leaves, 100);
    const frame = parseMarketFrame(JSON.stringify({
      marketData: {
        marketSlug: SLUG,
        bids: [level(0.7775, 100), level(0.75, 20)],
        offers: [level(0.79, 10)],
        transactTime: '2026-11-09T00:00:00.000Z',
        stats: { lastTradePx: { value: '0.75' }, lastTradeSetTime: '2026-11-09T00:00:00.000Z' },
      },
    }));
    assert.equal(frame.book.slug, SLUG);
    assert.equal(frame.book.bids.length, 2);
    const trade = parseMarketFrame(JSON.stringify({
      trade: { marketSlug: SLUG, price: { value: '0.75' }, quantity: '12', tradeId: 'tr-1', tradeTime: '2026-11-09T00:00:01.000Z' },
    }));
    assert.equal(trade.trade.price, 0.75);
    assert.equal(trade.trade.id, 'tr-1');
    const execs = executionsFromFrame({
      orderSubscriptionUpdate: { execution: { type: 2, lastShares: '4', order: { id: 'ord-bears' } } },
    });
    assert.equal(execs.length, 1);
    assert.equal(execs[0].order.id, 'ord-bears');
  }

  {
    const seen = [];
    class FakeWs {
      constructor(url) { this.url = url; this.handlers = {}; FakeWs.sockets.push(this); }
      on(ev, fn) { this.handlers[ev] = fn; }
      send(body) { this.sent = this.sent || []; this.sent.push(JSON.parse(body)); }
      ping() {}
      close() { if (this.handlers.close) this.handlers.close(); }
    }
    FakeWs.sockets = [];
    const feed = createMarketFeed({
      keyId: 'test-key',
      secretKey: 'ignored',
      headersFor: () => ({ 'X-Test': '1' }),
      WebSocketImpl: FakeWs,
      connectPrivate: false,
      onBook: (bookMsg) => seen.push(bookMsg.slug),
    });
    feed.setSlugs([SLUG]);
    const sock = FakeWs.sockets[0];
    sock.handlers.open();
    const types = sock.sent.map((body) => body.subscribe.subscriptionType);
    assert.deepStrictEqual(types, ['SUBSCRIPTION_TYPE_MARKET_DATA', 'SUBSCRIPTION_TYPE_TRADE']);
    sock.handlers.message(JSON.stringify({
      marketData: { marketSlug: SLUG, bids: [level(0.5, 1)], offers: [level(0.52, 1)] },
    }));
    assert.deepStrictEqual(seen, [SLUG]);
    assert.equal(feed.stats().open, true);
    feed.stop();
    assert.equal(feed.stats().open, false);
  }

  {
    const calls = [];
    const store = memoryStore([]);
    const orig = store.listArmed.bind(store);
    store.listArmed = async () => {
      calls.push('list');
      return orig();
    };
    const feed = fakeFeed();
    const logs = [];
    const engine = createDeskProtectWs({
      env: envOn(),
      control: { present: true, enabled: true },
      store,
      audits: createMemoryAudit(),
      client: { async listOpenOrders() { return { orders: [] }; } },
      feed,
      fetchImpl: async () => ({ status: 200, async json() { return { ok: true, actions: [] }; }, async text() { return ''; } }),
      now: () => 1_700_000_000_000,
      timers: false,
      log: (m) => logs.push(m),
      logError: () => {},
    });
    const idle = await engine.refreshArmed();
    assert.equal(idle.armed, 0);
    assert.equal(feed.open, false, 'idle with nothing armed does not open a socket');
    assert.equal(engine.nextPollMs(), ARM_MS);
    engine.heartbeat();
    assert.match(logs.join('\n'), /flag=on/);
    assert.match(logs.join('\n'), /armed=0/);
    assert.match(logs.join('\n'), /ws=closed/);
    assert.match(logs.join('\n'), /lastMsgAgeMs=-/);
    store.map.set('ord-bears', armed());
    await engine.refreshArmed();
    assert.equal(feed.open, true, 'arming a rest opens the socket');
    assert.equal(feed.slugCount, 1);
    store.map.clear();
    await engine.refreshArmed();
    assert.equal(feed.open, false, 'disarming the last rest closes the socket');
    assert.ok(calls.length >= 3, 'armed set is polled while the flag is on');
  }

  {
    const calls = [];
    const control = { present: true, enabled: false };
    const store = memoryStore([armed()]);
    const orig = store.listArmed.bind(store);
    store.listArmed = async () => {
      calls.push('list');
      return orig();
    };
    const feed = fakeFeed();
    const engine = createDeskProtectWs({
      env: { DESK_PROTECT_SWEEP_URL: SWEEP, DESK_PROTECT_SWEEP_SECRET: SECRET },
      control,
      store,
      audits: createMemoryAudit(),
      client: { async listOpenOrders() { return { orders: [] }; }, async cancelOrder() { throw new Error('off'); } },
      feed,
      fetchImpl: async () => { throw new Error('no handoff'); },
      now: () => 1_700_000_000_000,
      timers: false,
      log: () => {},
      logError: () => {},
    });
    await engine.refreshArmed();
    assert.equal(engine.flag().enabled, false);
    assert.equal(engine.nextPollMs(), POLL_OFF_MS);
    assert.equal(feed.open, false);
    assert.equal(calls.length, 0, 'flag off reads the control row only');
    control.enabled = true;
    await engine.refreshArmed();
    assert.equal(engine.flag().enabled, true);
    assert.equal(engine.flag().reason, 'control');
    assert.equal(feed.open, true, 'flag off to on opens the socket without a new process');
    assert.equal(engine.nextPollMs(), ARM_MS);
    assert.equal(calls.length, 1);
  }

  {
    const feed = fakeFeed();
    const engine = createDeskProtectWs({
      env: envOn(),
      control: { present: true, enabled: true },
      store: memoryStore([]),
      audits: createMemoryAudit(),
      client: { async listOpenOrders() { return { orders: [] }; } },
      feed,
      fetchImpl: async () => ({ status: 200, async json() { return { ok: true }; }, async text() { return ''; } }),
      now: () => 1_700_000_000_000,
      armMs: 60000,
      heartbeatMs: 60000,
      silenceCheckMs: 60000,
      log: () => {},
      logError: () => {},
    });
    try {
      engine.start();
      assert.equal(engine.holdsProcess(), true, 'idle poll keeps the process alive');
      assert.equal(feed.open, false);
    } finally {
      engine.stop();
    }
    assert.equal(engine.holdsProcess(), false);
  }

  {
    const queries = [];
    function builder(table) {
      const q = { table };
      const api = {
        select(cols) { q.cols = cols; return api; },
        eq(col, val) { q.eq = [col, val]; return api; },
        in(col, vals) { q.in = [col, vals]; return api; },
        maybeSingle() { queries.push(q); return Promise.resolve({ data: { enabled: false }, error: null }); },
        then(resolve, reject) {
          queries.push(q);
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return api;
    }
    const side = createSupabaseSide({ client: { from: builder } });
    await side.readControl();
    const rows = await side.listArmed();
    assert.deepStrictEqual(rows, []);
    const control = queries.find((q) => q.table === 'desk_protect_ws_control');
    const armedQuery = queries.find((q) => q.table === 'desk_protect_rests');
    assert.deepStrictEqual(control.eq, ['id', 1]);
    assert.equal(armedQuery.cols, ARMED_COLUMNS);
    assert.ok(!armedQuery.cols.includes('*'));
    assert.deepStrictEqual(armedQuery.in, ['status', ARMED_STATUSES]);
  }

  console.log('desk-protect-ws.test.js ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
