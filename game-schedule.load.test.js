'use strict';
// Load + safety tests for the canonical schedule on the sniper hot path (fix for the #298 OOM / event-loop stall).
//  * Same answers as the #298 resolver for 1,676 tickers over 666 games (golden made from the old code).
//  * 20,000 RFQ legs (≈ a minute at live rate) through the kickoff resolver: low per-call time, flat heap.
//  * Memo is capped (LRU) and dropped on schedule refresh; lookups fail open (null => old kickoff chain);
//    event-loop lag guard switches lookups off.
const assert = require('assert');
const G = require('./game-schedule');
const { createScheduleSync } = require('./schedule-sync');
const { createKickoffResolver } = require('./sniper/kickoff');
const B = require('./scripts/bench-game-schedule');
const GOLD = require('./fixtures-schedule-golden-2026-10-27.json');

// 1. Equivalence with the #298 resolver.
const games = B.buildGames(); const tickers = B.tickersFor(games);
assert.ok(games.length >= 650);
let diff = 0;
for (const t of tickers) { const r = G.resolveStart(t, games); const v = r.verified ? r.iso : r.source; if (v !== GOLD[t]) { diff += 1; if (diff < 5) console.error('diff', t, v, GOLD[t]); } }
assert.strictEqual(diff, 0, `${diff} tickers resolve differently from #298`);
assert.strictEqual(Object.keys(GOLD).length, tickers.length);

// 2. Load: plain resolver (index + per-event memo) and the sync's hot-path resolve (plus ticker LRU).
const plain = B.run({ legs: 20000 });
console.log('load plain   ', JSON.stringify(plain));
assert.ok(plain.perCallUs < 150, `per call ${plain.perCallUs} µs`);
assert.ok(plain.heapGrowthMB < 20, `heap growth ${plain.heapGrowthMB} MB`);
assert.ok(plain.canonicalHits > 17000);

// 3. Memo cap + refresh: LRU never exceeds its cap; a new games array gets a fresh index.
const lru = G.makeLru(3); ['a', 'b', 'c', 'd'].forEach((k, i) => lru.set(k, i)); assert.strictEqual(lru.size, 3); assert.strictEqual(lru.has('a'), false);
lru.get('b'); lru.set('e', 5); assert.strictEqual(lru.has('b'), true); assert.strictEqual(lru.has('c'), false);
const idx = G.indexGames(games);
for (let i = 0; i < G.MATCH_CACHE_MAX + 500; i += 1) G.matchEvent(`KXNBAGAME-26OCT27Z${i}Q-Q`, games);
assert.ok(idx.memo.size <= G.MATCH_CACHE_MAX);
const moved = games.map((g) => (g.home.abbr === 'BOS' && g.league === 'NBA' && g.espn_id.indexOf('d') < 0 ? { ...g, start_ms: g.start_ms + 3600000 } : g));
assert.strictEqual(G.resolveStart('KXNBAGAME-26OCT27BKNBOS-BOS', games).iso, '2026-10-27T23:30:00.000Z');
assert.strictEqual(G.resolveStart('KXNBAGAME-26OCT27BKNBOS-BOS', moved).iso, '2026-10-28T00:30:00.000Z'); // refresh => new answer
const grow = games.slice(0, 10); G.resolveStart('KXNBAGAME-26OCT27BKNBOS-BOS', grow); grow.push(...games.slice(10));
assert.strictEqual(G.resolveStart('KXNBAGAME-26OCT27BKNBOS-BOS', grow).verified, true); // pushed-into array re-indexes

(async () => {
  // 4. Sync hot path: fails open, caches, clears on refresh, lag guard.
  const FX = require('./fixtures-espn-schedule-2026-10-27.json');
  const NOW = Date.parse('2026-10-27T19:00:00Z');
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
  const fetchFn = async (url) => {
    if (url.includes('espn.com')) { const lg = url.includes('/nba/') ? 'NBA' : url.includes('/nhl/') ? 'NHL' : url.includes('college-football') ? 'NCAAF' : url.includes('/nfl/') ? 'NFL' : 'X'; const d = /dates=(\d+)/.exec(url)[1]; return ok(FX[`${lg}|${d}`] || { events: [] }); }
    return ok([]);
  };
  const logs = [];
  const s = createScheduleSync({ env: {}, fetchFn, log: (m) => logs.push(m), now: () => NOW });
  assert.strictEqual(s.resolve('KXNBAGAME-26OCT27BKNBOS-BOS'), null); // no schedule yet => null (old chain)
  const K = createKickoffResolver(); K.setKalshiOccurrence('KXNBAGAME-26OCT27BKNBOS-BOS', Date.parse('2026-10-28T02:30:00Z'));
  K.setCanonical((t) => s.resolve(t));
  assert.strictEqual(K.resolve('KXNBAGAME-26OCT27BKNBOS-BOS').source, 'kalshi_occ_minus_3h');
  await s.tick();
  assert.strictEqual(K.resolve('KXNBAGAME-26OCT27BKNBOS-BOS').source, 'canonical');
  for (let i = 0; i < 1000; i += 1) s.resolve('KXNBAGAME-26OCT27BKNBOS-BOS');
  assert.ok(s.stats().lookups <= 2, `ticker cache: ${s.stats().lookups} uncached lookups`);
  await s.tick(); assert.strictEqual(s.stats().resolveCache, 0); // refresh drops the cache
  assert.ok(logs.some((m) => /\[SCHEDULE\] pass 2 quick/.test(m)));
  s._setLookupsOff(true); assert.strictEqual(K.resolve('KXNBAGAME-26OCT27BKNBOS-BOS').source, 'kalshi_occ_minus_3h'); s._setLookupsOff(false);

  // Sync-path load (ticker LRU on top of the memo), through the kickoff resolver.
  const sync = B.run({ legs: 20000, resolver: (list) => { s._load(list); return (t) => s.resolve(t); } });
  console.log('load sync    ', JSON.stringify(sync));
  assert.ok(sync.perCallUs < 150); assert.ok(sync.heapGrowthMB < 20); assert.strictEqual(sync.canonicalHits, plain.canonicalHits);

  // Lag guard: two checks over the limit => lookups off, logged, alert raised once.
  const raised = [];
  const g2 = createScheduleSync({ env: { SCHEDULE_START_DELAY_MS: '600000', SCHEDULE_LAG_MS: '100', SCHEDULE_LAG_CHECK_MS: '50', SCHEDULE_LAG_OFF_MS: '600000' }, fetchFn, log: (m) => logs.push(m), alerts: { raise: async (a) => raised.push(a) }, now: () => NOW });
  await g2.tick(); g2.start();
  const busy = (ms) => { const e = Date.now() + ms; while (Date.now() < e) { /* block the loop */ } };
  for (let i = 0; i < 8 && !g2.stats().lookupsOff; i += 1) { busy(250); await new Promise((r) => setTimeout(r, 1)); }
  g2.stop();
  assert.strictEqual(g2.stats().lookupsOff, true); assert.strictEqual(g2.resolve('KXNBAGAME-26OCT27BKNBOS-BOS'), null);
  assert.strictEqual(raised.length, 1); assert.ok(logs.some((m) => /lookups OFF/.test(m)));
  console.log('game-schedule load tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
