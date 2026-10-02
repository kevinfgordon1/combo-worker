'use strict';
// Novig relay freshness: replica-aware book acceptance, reserved live lane.
const assert = require('assert');
const nf = require('./odds-relay').novigFeed;

const { replicaFromEtag, uuidV7Ms, acceptRestBook, bookFromSnapshot, createLimiter } = nf;

// etag is "<replica uuid>-<seq>"
assert.strictEqual(replicaFromEtag('"01a0fadc-dc47-7f73-adb2-aba5f68529cc-110"'), '01a0fadc-dc47-7f73-adb2-aba5f68529cc');
assert.strictEqual(replicaFromEtag('W/"01a0faef-bf17-72d0-9968-89f2a7f6811c-48"'), '01a0faef-bf17-72d0-9968-89f2a7f6811c');
assert.strictEqual(replicaFromEtag(null), null);
assert.strictEqual(replicaFromEtag('"abc"'), null);

// order ids are uuidv7: first 48 bits are ms
assert.strictEqual(uuidV7Ms('01a0fa95-2ed0-7bb1-9f47-f3d46bff23db'), parseInt('01a0fa952ed0', 16));
assert.ok(uuidV7Ms('01a0fa95-2ed0-7bb1-9f47-f3d46bff23db') > 1.7e12);
assert.strictEqual(uuidV7Ms('1'), 0);
assert.strictEqual(uuidV7Ms('o1'), 0);

const T = 1_790_000_000_000;
const oid = (ms, tail = 1) => `${Math.floor(ms).toString(16).padStart(12, '0').replace(/^(.{8})(.{4})$/, '$1-$2')}-7000-8000-${String(tail).padStart(12, '0')}`;
function rest(replica, seq, orders, at = T) {
  const raw = { seq, orders: {} };
  for (const [outcome, id, price, qty] of orders) {
    (raw.orders[outcome] = raw.orders[outcome] || []).push({ orderId: id, price: String(price), qty });
  }
  return bookFromSnapshot(raw, at, replica);
}
const cle = (id, p) => ['cle', id, p, 100];

// 1. first book is taken; same replica obeys seq
{
  const seqs = new Map();
  const a1 = rest('A', 100, [cle(oid(T - 5000), 0.8)]);
  assert.strictEqual(acceptRestBook(null, a1, seqs, { now: T }), true);
  a1.acceptedAt = T;
  const a0 = rest('A', 99, [cle(oid(T - 5000), 0.7)]);
  assert.strictEqual(acceptRestBook(a1, a0, seqs, { now: T + 10 }), false, 'same replica never goes back');
  const aSame = rest('A', 100, [cle(oid(T - 5000), 0.7)]);
  assert.strictEqual(acceptRestBook(a1, aSame, seqs, { now: T + 10 }), false, 'equal seq = no change');
  const a2 = rest('A', 101, [cle(oid(T - 5000), 0.81)]);
  assert.strictEqual(acceptRestBook(a1, a2, seqs, { now: T + 20 }), true);
}

// 2. the bug: replicas count events independently. A lower seq from a
// different replica that holds a newer order is the fresh book.
{
  const seqs = new Map();
  const held = rest('A', 88000, [cle(oid(T - 9000), 0.80)]);
  held.acceptedAt = T;
  seqs.set('A', 88000);
  const fresh = rest('B', 11000, [cle(oid(T - 9000), 0.80), cle(oid(T - 1000, 2), 0.82)]);
  assert.strictEqual(fresh.seq < held.seq, true);
  assert.strictEqual(acceptRestBook(held, fresh, seqs, { now: T + 500 }), true, 'newer order beats a higher foreign seq');
}

// 3. lagging replica missing the newest order cannot flip a fresh price back,
// but a real cancel still lands once the held book is old enough.
{
  const seqs = new Map();
  const held = rest('A', 120, [cle(oid(T - 9000), 0.80), cle(oid(T - 1000, 2), 0.82)]);
  held.acceptedAt = T;
  seqs.set('A', 120);
  const lag = rest('B', 119, [cle(oid(T - 9000), 0.80)]);
  assert.strictEqual(acceptRestBook(held, lag, seqs, { now: T + 1000, skewMs: 3000 }), false, 'stale replica rejected inside skew');
  const lag2 = rest('B', 120, [cle(oid(T - 9000), 0.80)]);
  assert.strictEqual(acceptRestBook(held, lag2, seqs, { now: T + 3500, skewMs: 3000 }), true, 'cancel lands after skew');
}

// 4. identical orders from another replica are not a change
{
  const seqs = new Map();
  const held = rest('A', 10, [cle(oid(T - 3000), 0.8)]);
  const other = rest('B', 999, [cle(oid(T - 3000), 0.8)]);
  assert.strictEqual(acceptRestBook(held, other, seqs, { now: T + 9000 }), false);
}

// 5. a live websocket book is not replaced by REST
{
  const held = rest('A', 5, [cle(oid(T - 3000), 0.8)]);
  held.source = 'ws';
  const next = rest('B', 6, [cle(oid(T - 1000, 3), 0.9)]);
  assert.strictEqual(acceptRestBook(held, next, new Map(), { now: T, wsFresh: true }), false);
  assert.strictEqual(acceptRestBook(held, next, new Map(), { now: T, wsFresh: false }), true, 'ws silent: REST may take over');
}

// 6. no replica info (older fake or missing etag): plain seq compare as before
{
  const held = rest(null, 5, [['x', 'o1', 0.4, 10]]);
  assert.strictEqual(acceptRestBook(held, rest(null, 4, [['x', 'o1', 0.5, 10]]), new Map(), { now: T }), false);
  assert.strictEqual(acceptRestBook(held, rest(null, 6, [['x', 'o1', 0.5, 10]]), new Map(), { now: T }), true);
}

// 7. limiter: reserved live lane goes first but cannot starve the rest
(async () => {
  const lim = createLimiter({ rps: 1000, concurrency: 1 });
  const order = [];
  const jobs = [];
  let release;
  jobs.push(lim.run(() => new Promise((r) => { release = r; }), 'high')); // hold the one slot while the rest queue
  for (let i = 0; i < 8; i += 1) jobs.push(lim.run(() => order.push('l'), 'low'));
  for (let i = 0; i < 2; i += 1) jobs.push(lim.run(() => order.push('h'), 'high'));
  for (let i = 0; i < 8; i += 1) jobs.push(lim.run(() => order.push('L'), 'live'));
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all(jobs);
  const s = order.join('');
  assert.ok(s.indexOf('L') < s.indexOf('l'), `live first: ${s}`);
  // the first non-live slot comes after at most 3 live grants
  const firstOther = s.search(/[lh]/);
  assert.ok(firstOther <= 4, `others not starved: ${s}`);
  // with nothing else waiting, live takes every slot
  const lim2 = createLimiter({ rps: 1000, concurrency: 1 });
  const o2 = [];
  await Promise.all([1, 2, 3, 4, 5].map(() => lim2.run(() => o2.push('L'), 'live')));
  assert.strictEqual(o2.join(''), 'LLLLL');
  assert.ok('live' in lim.stats().queued);
})().catch((err) => { console.error(err); process.exit(1); });

// 8. feed: a live market served by two replicas with unrelated seq numbers
// follows the fresher replica (old code froze on the higher seq).
(async () => {
  const startMs = T - 3600_000;
  const eventsBody = { items: [{ eventId: 'ev1', description: 'Pittsburgh Steelers @ Cleveland Browns', sport: 'FOOTBALL', league: 'NFL', status: 'OPEN_INGAME', startsTs: startMs }] };
  const marketsBody = { items: [{
    marketId: 'm1', description: 'CLE', eventId: 'ev1', marketType: 'MONEY', strike: '0', status: 'OPEN', startsTs: startMs,
    fee: { coefficient: '0.03', makerCredit: '0.5', charged: 'WHEN_LIVE' },
    outcomes: [{ outcomeId: 'cle', name: 'CLE', status: 'TBD' }, { outcomeId: 'pit', name: 'PIT', status: 'TBD' }],
  }] };
  let n = 0;
  const bookFor = () => {
    n += 1;
    const now = Date.now();
    // replica H: high seq, stuck on the old price. replica L: low seq, fresher book.
    if (n % 2 === 1) {
      return { etag: '"HHHHHHHH-0000-7000-8000-000000000001-88000"', body: { marketId: 'm1', seq: 88000, orders: { cle: [{ orderId: oid(now - 30000, 1), price: '0.80', qty: 1000 }], pit: [{ orderId: oid(now - 30000, 2), price: '0.18', qty: 1000 }] } } };
    }
    return { etag: '"LLLLLLLL-0000-7000-8000-000000000002-11000"', body: { marketId: 'm1', seq: 11000, orders: { cle: [{ orderId: oid(now - 30000, 1), price: '0.80', qty: 1000 }], pit: [{ orderId: oid(now - 500, 3), price: '0.16', qty: 1000 }] } } };
  };
  const calls = [];
  const fetchFn = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    calls.push(path);
    const json = (body, etag) => ({ ok: true, status: 200, headers: { get: (h) => (String(h).toLowerCase() === 'etag' ? etag || null : null) }, text: async () => JSON.stringify(body) });
    if (path.startsWith('/v3/public/catalog/events')) return json(eventsBody);
    if (path.startsWith('/v3/public/catalog/markets?')) return json(marketsBody);
    if (path.includes('/book')) { const b = bookFor(); return json(b.body, b.etag); }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  };
  const published = [];
  const feed = nf.createNovigFeed({
    env: {}, fetchFn, leagues: ['NFL'], key: null, ws: false, log: () => {},
    hotMs: 30, hotSideMs: 30, nearMs: 30, rps: 1000, concurrency: 2, replicaSkewMs: 100000,
    onQuotes: (lg, quotes) => published.push(quotes),
  });
  await feed.ready;
  await new Promise((r) => setTimeout(r, 1200));
  const last = published[published.length - 1].filter((q) => /Cleveland/i.test(q.side));
  feed.stop();
  assert.ok(last.length, 'cle quote published');
  assert.ok(last.every((q) => q.odds >= 0.83), `follows the fresher low-seq replica: ${JSON.stringify(last.map((q) => q.odds))}`);
  assert.ok(feed.status.restChanged >= 1);
})().catch((err) => { console.error(err); process.exit(1); });

console.log('novig-fresh.test.js ok');
