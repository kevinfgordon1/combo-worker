'use strict';

// Live lane: moneylines before in-game spreads/totals, and decided games slow down.
const assert = require('assert');
const nf = require('./odds-relay').novigFeed;

(async () => {
  // 1. limiter: live (moneyline) -> liveSide -> the rest, others still not starved.
  const lim = nf.createLimiter({ rps: 1000, concurrency: 1 });
  const order = [];
  const jobs = [];
  let release;
  jobs.push(lim.run(() => new Promise((r) => { release = r; }), 'high'));
  for (let i = 0; i < 6; i += 1) jobs.push(lim.run(() => order.push('l'), 'low'));
  for (let i = 0; i < 6; i += 1) jobs.push(lim.run(() => order.push('S'), 'liveSide'));
  for (let i = 0; i < 6; i += 1) jobs.push(lim.run(() => order.push('M'), 'live'));
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all(jobs);
  const s = order.join('');
  assert.ok(s.startsWith('MMMM'), `moneylines first: ${s}`);
  assert.ok(s.indexOf('M') < s.indexOf('S') && s.indexOf('S') < s.search(/l/) + 8, `side markets before background: ${s}`);
  assert.ok(s.search(/l/) <= 5, `background not starved: ${s}`);
  assert.ok('liveSide' in lim.stats().queued);
  // nothing else waiting: side markets take every slot
  const lim2 = nf.createLimiter({ rps: 1000, concurrency: 1 });
  const o2 = [];
  await Promise.all([1, 2, 3, 4, 5, 6].map(() => lim2.run(() => o2.push('S'), 'liveSide')));
  assert.strictEqual(o2.join(''), 'SSSSSS');

  // 2. feed: a decided in-game moneyline polls at decidedMs, a live one at hotMs.
  const T = Date.now();
  const startMs = T - 3600_000;
  const eventsBody = { items: [
    { eventId: 'evA', description: 'Pittsburgh Panthers @ Virginia Tech Hokies', league: 'NCAAF', status: 'OPEN_INGAME', startsTs: startMs },
    { eventId: 'evB', description: 'Montana State Bobcats @ Idaho Vandals', league: 'NCAAF', status: 'OPEN_INGAME', startsTs: startMs },
  ] };
  const mkt = (id, ev, a, b) => ({
    marketId: id, description: 'ML', eventId: ev, marketType: 'MONEY', strike: '0', status: 'OPEN', startsTs: startMs,
    fee: { coefficient: '0.03', makerCredit: '0.5', charged: 'WHEN_LIVE' },
    outcomes: [{ outcomeId: a, name: a.toUpperCase(), status: 'TBD' }, { outcomeId: b, name: b.toUpperCase(), status: 'TBD' }],
  });
  const marketsBody = { items: [mkt('mA', 'evA', 'vt', 'pit'), mkt('mB', 'evB', 'ida', 'mst')] };
  const oid = (ms, n) => {
    const hex = ms.toString(16).padStart(12, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${String(n).padStart(12, '0')}`;
  };
  const counts = { mA: 0, mB: 0 };
  const fetchFn = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const json = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (path.startsWith('/v3/public/catalog/events')) return json(eventsBody);
    if (path.startsWith('/v3/public/catalog/markets?')) return json(marketsBody);
    const m = /markets\/(mA|mB)\/book/.exec(path);
    if (m) {
      counts[m[1]] += 1;
      const now = Date.now();
      const seq = 1000 + counts[m[1]];
      if (m[1] === 'mA') {
        // decided: VT 0.99 bid, PIT 0.01 bid
        return json({ marketId: 'mA', seq, orders: { vt: [{ orderId: oid(now - 9000, 1), price: '0.98', qty: 1000 }], pit: [{ orderId: oid(now - 9000, 2), price: '0.01', qty: 1000 }] } });
      }
      return json({ marketId: 'mB', seq, orders: { ida: [{ orderId: oid(now - 9000, 3), price: '0.55', qty: 1000 }], mst: [{ orderId: oid(now - 9000, 4), price: '0.43', qty: 1000 }] } });
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  };
  const feed = nf.createNovigFeed({
    env: {}, fetchFn, leagues: ['NCAAF'], key: null, ws: false, log: () => {},
    hotMs: 40, hotSideMs: 40, nearMs: 40, decidedMs: 100000, rps: 1000, concurrency: 2,
    onQuotes: () => {},
  });
  await feed.ready;
  await new Promise((r) => setTimeout(r, 1700));
  feed.stop();
  assert.ok(counts.mB >= 6, `live game polled fast: ${counts.mB}`);
  assert.ok(counts.mA <= 2, `decided game polled slowly: ${counts.mA}`);
  console.log('novig-live-lane.test.js ok');
})().catch((err) => { console.error(err); process.exit(1); });
