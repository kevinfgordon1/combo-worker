'use strict';
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const vectors = require('./novig-signing-vectors.json');
const {
  canonicalQuery,
  stringToSign,
  signString,
  signedHeaders,
  novigKey,
  novigWsUrl,
  bookFromSnapshot,
  applyBookDeltas,
  askFor,
  askLevels,
  fairProb0,
  americanFromProb,
  buildCatalog,
  quotesForMarket,
  pickMain,
  startNovigWs,
} = require('./odds-relay').novigFeed;
const { createState, publishNovig, startOddsRelay } = require('./odds-relay');

// NOVIG-V3 string-to-sign and Ed25519 signatures match Novig's vectors.
for (const v of vectors.vectors) {
  const text = stringToSign({
    timestamp: v.input.timestamp,
    method: v.input.method,
    path: v.input.path,
    query: v.input.query,
    body: v.input.body ? Buffer.from(v.input.body, 'utf8') : '',
  });
  assert.strictEqual(text, v.string_to_sign, v.id);
  const pair = vectors.keypairs[v.keypair_id];
  const priv = crypto.createPrivateKey(pair.private_key_pkcs8_pem);
  const sig = signString(priv, text);
  if (v.algorithm === 'ed25519') assert.strictEqual(sig, v.signature, v.id);
  const pub = crypto.createPublicKey(pair.public_key_spki_pem);
  const ok = v.algorithm === 'ed25519'
    ? crypto.verify(null, Buffer.from(text), pub, Buffer.from(sig, 'base64'))
    : crypto.verify('sha256', Buffer.from(text), { key: pub, dsaEncoding: 'der' }, Buffer.from(sig, 'base64'));
  assert.ok(ok, `${v.id} verifies`);
}
assert.strictEqual(canonicalQuery('?b=2&a=1&a=0'), 'a=0&a=1&b=2');
assert.strictEqual(novigWsUrl('https://api.novig.com'), 'wss://api.novig.com/v3/ws');

// Key loading: escaped newlines, missing values, junk.
{
  const pem = vectors.keypairs['ed25519-test-1'].private_key_pkcs8_pem;
  const k = novigKey({ NOVIG_KEY_ID: 'kid', NOVIG_PRIVATE_KEY: pem.replace(/\n/g, '\\n') });
  assert.strictEqual(k.id, 'kid');
  assert.strictEqual(k.type, 'ed25519');
  assert.strictEqual(novigKey({ NOVIG_KEY_ID: 'kid' }), null);
  assert.strictEqual(novigKey({}), null);
  assert.strictEqual(novigKey({ NOVIG_KEY_ID: 'kid', NOVIG_PRIVATE_KEY: 'nope' }).error, 'bad_private_key');
  const h = signedHeaders(k, { method: 'GET', path: '/v3/ws', nowMs: 1755000000000 });
  assert.strictEqual(h['Novig-Key-Id'], 'kid');
  assert.strictEqual(h['Novig-Timestamp'], '1755000000000');
  assert.ok(h['Novig-Signature'].length > 40);
}

// Books: bids per outcome; the ask to buy one side is 1 - the other's best bid.
const eventsBody = {
  items: [{ eventId: 'ev1', description: 'Arizona Cardinals @ New York Giants', league: 'NFL', status: 'OPEN_PREGAME', startsTs: Date.now() + 3600e3 }],
};
const marketsBody = {
  items: [
    { marketId: 'ml', eventId: 'ev1', marketType: 'MONEY', strike: '0', status: 'OPEN', description: 'NYG', outcomes: [{ outcomeId: 'nyg', name: 'NYG' }, { outcomeId: 'ari', name: 'ARI' }] },
    { marketId: 's1', eventId: 'ev1', marketType: 'SPREAD', strike: '-1.5', status: 'OPEN', description: 'NYG -1.5', outcomes: [{ outcomeId: 's1h', name: 'NYG -1.5' }, { outcomeId: 's1a', name: 'ARI +1.5' }] },
    { marketId: 's2', eventId: 'ev1', marketType: 'SPREAD', strike: '3.5', status: 'OPEN', description: 'NYG +3.5', outcomes: [{ outcomeId: 's2h', name: 'NYG +3.5' }, { outcomeId: 's2a', name: 'ARI -3.5' }] },
    { marketId: 't1', eventId: 'ev1', marketType: 'TOTAL', strike: '43.5', status: 'OPEN', description: 'ARI @ NYG t43.5', outcomes: [{ outcomeId: 'o', name: 'Over 43.5' }, { outcomeId: 'u', name: 'Under 43.5' }] },
    { marketId: 'pp', eventId: 'ev1', marketType: 'PASSING_YARDS', strike: '219.5', status: 'OPEN', description: 'x', outcomes: [{ outcomeId: 'a', name: 'Over' }, { outcomeId: 'b', name: 'Under' }] },
  ],
};
const cat = buildCatalog('NFL', eventsBody, marketsBody, Date.now());
assert.strictEqual(cat.events.get('ev1').codes.NYG, 'New York Giants');
assert.strictEqual(cat.events.get('ev1').codes.ARI, 'Arizona Cardinals');
assert.strictEqual(cat.groups.size, 3);
assert.deepStrictEqual(cat.groups.get('ev1|SPREAD').map((m) => m.id), ['s1', 's2']);

const ml = cat.groups.get('ev1|MONEY')[0];
const mlBook = bookFromSnapshot({
  seq: 10,
  orders: {
    nyg: [{ orderId: 'a', price: '0.485', qty: 544300 }, { orderId: 'b', price: '0.480', qty: 100 }],
    ari: [{ orderId: 'c', price: '0.510', qty: 700000 }, { orderId: 'd', price: '0.510', qty: 103300 }],
  },
}, 1000);
assert.deepStrictEqual(askFor(mlBook, ml, 'nyg'), { odds: 0.49, size: 8033 });
assert.deepStrictEqual(askFor(mlBook, ml, 'ari'), { odds: 0.515, size: 5443 });
assert.strictEqual(americanFromProb(0.49), 104);
assert.strictEqual(americanFromProb(0.515), -106);
assert.strictEqual(askLevels(mlBook, ml, 'ari').length, 2);
assert.ok(Math.abs(fairProb0(mlBook, ml) - 0.4875) < 1e-9);

const quotes = quotesForMarket(cat.events.get('ev1'), ml, mlBook, 'NFL');
assert.strictEqual(quotes.length, 2);
assert.strictEqual(quotes[0].side, 'New York Giants');
assert.strictEqual(quotes[0].book_id, 195);
assert.strictEqual(quotes[0].bet_type, 'moneyline');
assert.strictEqual(quotes[0].american, 104);

// Live taker fee: quotes stay pre-fee asks; the market's fee.coefficient rides
// along (consumers add c·P·(1−P) only when is_live). Absent fee → undefined.
{
  const feeCat = buildCatalog('NFL', {
    items: [{ eventId: 'fe', description: 'Pittsburgh Steelers @ Cleveland Browns', league: 'NFL', status: 'OPEN_INGAME', startsTs: Date.now() - 600e3 }],
  }, {
    items: [
      { marketId: 'fm', eventId: 'fe', marketType: 'MONEY', status: 'OPEN', strike: '0', fee: { coefficient: '0.03', makerCredit: '0.5', charged: 'WHEN_LIVE' }, outcomes: [{ outcomeId: 'cle', name: 'CLE' }, { outcomeId: 'pit', name: 'PIT' }] },
      { marketId: 'nf', eventId: 'fe', marketType: 'TOTAL', status: 'OPEN', strike: '41.5', outcomes: [{ outcomeId: 'o', name: 'Over 41.5' }, { outcomeId: 'u', name: 'Under 41.5' }] },
    ],
  });
  const feeBook = bookFromSnapshot({ seq: 1, orders: { cle: [{ orderId: '1', price: '0.705', qty: 100 }], pit: [{ orderId: '2', price: '0.705', qty: 100 }] } });
  const fq = quotesForMarket(feeCat.events.get('fe'), feeCat.groups.get('fe|MONEY')[0], feeBook, 'NFL');
  assert.ok(fq.every((q) => q.is_live === true && q.fee_coefficient === 0.03 && q.odds === 0.295 && q.american === 239));
  const tb2 = bookFromSnapshot({ seq: 1, orders: { o: [{ orderId: '5', price: '0.460', qty: 100 }], u: [{ orderId: '6', price: '0.500', qty: 100 }] } });
  const nfq = quotesForMarket(feeCat.events.get('fe'), feeCat.groups.get('fe|TOTAL')[0], tb2, 'NFL');
  assert.ok(nfq.every((q) => q.fee_coefficient === undefined));
}

// Deltas: add joins, remove leaves.
applyBookDeltas(mlBook, [
  { kind: 'add', order: 'e', outcome: 'ari', price: '0.520', qty: 5000 },
  { kind: 'remove', order: 'a', reason: 'fill' },
]);
assert.deepStrictEqual(askFor(mlBook, ml, 'nyg'), { odds: 0.48, size: 50 });
assert.deepStrictEqual(askFor(mlBook, ml, 'ari'), { odds: 0.52, size: 1 });

// Live wire shape: delta adds carry outcomeId and orderId (not outcome/order).
{
  const live = bookFromSnapshot({ seq: 10, orders: { nyg: [{ orderId: 'x1', price: '0.020', qty: 100 }], ari: [{ orderId: 'x2', price: '0.020', qty: 100 }] } });
  applyBookDeltas(live, [
    { kind: 'add', orderId: 'x3', outcomeId: 'nyg', price: '0.455', qty: 61400 },
    { kind: 'add', orderId: 'x4', outcomeId: 'ari', price: '0.530', qty: 150000 },
    { kind: 'add', orderId: 'x5', price: '0.990', qty: 1 },
  ]);
  assert.deepStrictEqual(askFor(live, ml, 'ari'), { odds: 0.545, size: 614 });
  assert.deepStrictEqual(askFor(live, ml, 'nyg'), { odds: 0.47, size: 1500 });
  assert.ok(![...live.orders.values()].some((o) => !o.outcome), 'an add with no outcome is skipped');
}

// Main spread: most balanced two-sided line wins.
{
  const books = new Map();
  books.set('s1', bookFromSnapshot({ seq: 1, orders: { s1h: [{ orderId: '1', price: '0.450', qty: 100 }], s1a: [{ orderId: '2', price: '0.520', qty: 100 }] } }));
  books.set('s2', bookFromSnapshot({ seq: 1, orders: { s2h: [{ orderId: '3', price: '0.700', qty: 100 }], s2a: [{ orderId: '4', price: '0.250', qty: 100 }] } }));
  const main = pickMain(cat.groups.get('ev1|SPREAD'), books);
  assert.strictEqual(main.id, 's1');
  const sq = quotesForMarket(cat.events.get('ev1'), main, books.get('s1'), 'NFL');
  assert.deepStrictEqual(sq.map((q) => [q.side, q.line, q.odds]), [['New York Giants', -1.5, 0.48], ['Arizona Cardinals', 1.5, 0.55]]);
  const t = cat.groups.get('ev1|TOTAL')[0];
  const tb = bookFromSnapshot({ seq: 1, orders: { o: [{ orderId: '5', price: '0.460', qty: 100 }], u: [{ orderId: '6', price: '0.500', qty: 100 }] } });
  const tq = quotesForMarket(cat.events.get('ev1'), t, tb, 'NFL');
  assert.deepStrictEqual(tq.map((q) => [q.side, q.side_type, q.line, q.odds]), [['Over', 'Over', 43.5, 0.5], ['Under', 'Under', 43.5, 0.54]]);
}

// Limiter: weighted round robin keeps searches moving under hot load.
(async () => {
  const { createLimiter } = require('./odds-relay').novigFeed;
  const lim = createLimiter({ rps: 1000, concurrency: 1 });
  const order = [];
  const jobs = [];
  for (let i = 0; i < 4; i += 1) jobs.push(lim.run(() => order.push('h'), 'high'));
  for (let i = 0; i < 4; i += 1) jobs.push(lim.run(() => order.push('m'), 'mid'));
  for (let i = 0; i < 2; i += 1) jobs.push(lim.run(() => order.push('l'), 'low'));
  await Promise.all(jobs);
  assert.ok(order.slice(0, 5).includes('m') && order.slice(0, 5).includes('l'), order.join(''));
})().catch((err) => { console.error(err); process.exit(1); });

// Relay: first publish is a complete snapshot; a moved line re-snapshots.
{
  const state = createState();
  const got = [];
  state.channels.novig.NFL.subscribe((p) => got.push(p));
  const q1 = { token_id: 'a', odds: 0.5, league: 'NFL' };
  const q2 = { token_id: 'b', odds: 0.52, league: 'NFL' };
  publishNovig(state, 'NFL', [q1, q2], 'rest');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].complete, true);
  publishNovig(state, 'NFL', [q1, q2], 'rest');
  assert.strictEqual(got.length, 1, 'no change, no packet');
  publishNovig(state, 'NFL', [{ ...q1, odds: 0.51 }, q2], 'ws');
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[1].complete, false);
  assert.deepStrictEqual(got[1].quotes.map((q) => q.token_id), ['a']);
  publishNovig(state, 'NFL', [{ ...q1, odds: 0.51 }], 'rest');
  assert.strictEqual(got[2].complete, true);
  assert.strictEqual(state.books.novig.NFL.size, 1);
}

// Websocket: subscribe on open, snapshot then deltas, gap asks for a snapshot.
{
  const sent = [];
  class FakeWs {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.readyState = 0;
      this.handlers = {};
      FakeWs.last = this;
    }
    on(name, fn) { this.handlers[name] = fn; }
    send(text) { sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.handlers.open(); }
    msg(obj) { this.handlers.message(Buffer.from(JSON.stringify(obj))); }
  }
  const key = novigKey({ NOVIG_KEY_ID: 'kid', NOVIG_PRIVATE_KEY: vectors.keypairs['ed25519-test-1'].private_key_pkcs8_pem });
  const seen = [];
  let owned = [];
  const status = {};
  const conn = startNovigWs({
    key,
    base: 'https://api.novig.com',
    WebSocket: FakeWs,
    status,
    log: () => {},
    desired: () => ['m1', 'm2'],
    onBook: (id, book) => seen.push([id, book.seq]),
    onOwned: (ids) => { owned = ids; },
    onLifecycle: () => {},
  });
  const sock = FakeWs.last;
  assert.strictEqual(sock.url, 'wss://api.novig.com/v3/ws');
  assert.strictEqual(sock.opts.headers['Novig-Key-Id'], 'kid');
  sock.open();
  assert.strictEqual(status.ws, 'up');
  assert.deepStrictEqual(sent[0].subscribe.markets, { m1: 'book', m2: 'book' });
  assert.strictEqual(sent[0].nonce, 1);
  sock.msg({ nonce: 1, snapshot: { m1: { book: { seq: 5, orders: { x: [{ order: 'o1', price: '0.4', qty: 10 }] } } } } });
  assert.deepStrictEqual(owned, ['m1']);
  sock.msg({ delta: { m1: { book: { seq: 6, deltas: [{ kind: 'add', order: 'o2', outcome: 'x', price: '0.45', qty: 5 }] } } } });
  assert.deepStrictEqual(seen, [['m1', 5], ['m1', 6]]);
  assert.strictEqual(conn._state.books.get('m1').orders.size, 2);
  sock.msg({ delta: { m1: { book: { seq: 6, deltas: [] } } } });
  assert.strictEqual(seen.length, 2, 'stale seq ignored');
  sock.msg({ delta: { m1: { book: { seq: 9, deltas: [] } } } });
  assert.ok(conn._state.gapped.has('m1') || sent.some((m) => m.snapshot), 'gap triggers a snapshot');
  conn.stop();
}

// A refused upgrade (429) reconnects once, after Retry-After. ws does not
// close or error on its own when an unexpected-response listener is set.
{
  const made = [];
  class RefusedWs {
    constructor(url, opts) { this.handlers = {}; this.readyState = 0; made.push(this); }
    on(name, fn) { this.handlers[name] = fn; }
    send() {}
    close() { this.readyState = 3; }
  }
  const key = novigKey({ NOVIG_KEY_ID: 'kid', NOVIG_PRIVATE_KEY: vectors.keypairs['ed25519-test-1'].private_key_pkcs8_pem });
  const status = {};
  const logs = [];
  const conn = startNovigWs({
    key, base: 'https://api.novig.com', WebSocket: RefusedWs, status, log: (...a) => logs.push(a.join(' ')),
    desired: () => [], onBook: () => {}, onOwned: () => {}, onLifecycle: () => {},
  });
  let destroyed = false;
  made[0].handlers['unexpected-response']({ destroy() { destroyed = true; } }, { statusCode: 429, headers: { 'retry-after': '1' }, resume() {} });
  // A late close from the refused socket must not schedule a second reconnect.
  if (made[0].handlers.close) made[0].handlers.close(1006, '');
  assert.strictEqual(status.ws, 'error:http_429');
  assert.ok(destroyed, 'refused request is destroyed');
  assert.ok(logs.some((l) => /refused 429 retry-after 1s/.test(l)));
  setTimeout(() => {
    assert.strictEqual(made.length, 2, 'exactly one reconnect after a refused upgrade');
    conn.stop();
    console.log('novig ws refused-upgrade reconnect ok');
  }, 2300);
}

// /stream?venue=novig is accepted and replays the last snapshot.
(async () => {
  const relay = startOddsRelay({ upstream: false });
  const addr = await relay.listen(0, '127.0.0.1');
  publishNovig(relay.state, 'NFL', [{ token_id: 'a', odds: 0.5, league: 'NFL', book: 'novig' }], 'rest');
  const body = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${addr.port}/stream?venue=novig&league=NFL`, (res) => {
      assert.strictEqual(res.statusCode, 200);
      res.once('data', (chunk) => { resolve(String(chunk)); req.destroy(); });
    });
    req.on('error', reject);
  });
  assert.match(body, /"source":"novig"/);
  assert.match(body, /"complete":true/);
  const board = await fetch(`http://127.0.0.1:${addr.port}/board?venue=novig&league=NFL`).then((r) => r.json());
  assert.strictEqual(board.quotes.length, 1);
  const health = await fetch(`http://127.0.0.1:${addr.port}/health`).then((r) => r.json());
  assert.strictEqual(health.counts.novig.NFL, 1);
  await relay.close();
  console.log('novig-feed.test.js ok');
})().catch((err) => { console.error(err); process.exit(1); });
