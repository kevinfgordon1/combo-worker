// Load benchmark: replays synthetic Kalshi rfq_created frames at a fixed rate
// against ~90 locks. Mode inline = today (parse+normalize+match on the main
// thread). Mode pool = COMBO_MATCH_THREADS matcher threads.
// Usage: node bench/match-bench.js <inline|pool> <rfqPerSec> [threads] [seconds] [locks]
'use strict';
const { monitorEventLoopDelay, performance } = require('perf_hooks');
const RFQ = process.env.BENCH_RFQ ? require(require('path').resolve(process.env.BENCH_RFQ)) : require('../rfq');
const { parseEnvelope, normalizeRfq, matchParlay } = RFQ;
const { createMatchPool } = require('../match-pool');

const [mode = 'inline', rateArg = '3500', thrArg = '3', secArg = '10', locksArg = '90'] = process.argv.slice(2);
const RATE = +rateArg, THREADS = +thrArg, SECS = +secArg, NLOCKS = +locksArg;

// Deterministic RNG
let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const TEAMS = ['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAC','KC','LV','LAC','LA','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SF','SEA','TB','TEN','WAS'];
const markets = [];
for (let g = 0; g < 16; g++) {
  const a = TEAMS[2 * g], h = TEAMS[2 * g + 1], ev = `26OCT18${a}${h}`;
  markets.push(`KXNFLGAME-${ev}-${a}`, `KXNFLGAME-${ev}-${h}`);
  for (const s of [3, 6, 9]) markets.push(`KXNFLSPREAD-${ev}-${a}${s}`, `KXNFLSPREAD-${ev}-${h}${s}`);
  for (const t of [38, 41, 44, 47]) markets.push(`KXNFLTOTAL-${ev}-${t}`);
  for (let p = 0; p < 40; p++) markets.push(`KXNFLANYTD-${ev}-P${p}`); // player props: the long tail
}
const pick = (n) => { const s = new Set(); while (s.size < n) s.add(markets[(rnd() * markets.length) | 0] + (rnd() < 0.5 ? ':yes' : ':no')); return [...s]; };
const locks = Array.from({ length: NLOCKS }, (_, i) => ({ id: `lock-${i}`, label: `L${i}`, leg_keys: pick(2 + ((rnd() * 3) | 0)) }));
const frame = (i, keys) => JSON.stringify({ type: 'rfq_created', sid: 1, msg: {
  id: `rfq-${i}`, contracts_fp: '100.00', mve_collection_ticker: 'KXMVECROSSCATEGORY-R', created_ts: new Date().toISOString(),
  market_ticker: `KXMVECROSSCATEGORY-S2026${i}`, creator_id: 'abc',
  mve_selected_legs: keys.map((k) => { const j = k.lastIndexOf(':'); return { market_ticker: k.slice(0, j), side: k.slice(j + 1), event_ticker: k.slice(0, k.lastIndexOf('-')) }; }) } });
// 1 in 1000 frames hits a lock exactly; the rest are random 2-10 leg combos
// that usually share some legs with locks (worst case for the prefilter).
const POOL = 20000;
const frames = Array.from({ length: POOL }, (_, i) => i % 1000 === 7 ? frame(i, locks[i % NLOCKS].leg_keys) : frame(i, pick(2 + ((rnd() * 9) | 0))));

let matched = 0, sent = 0;
let pool = null;
if (mode === 'pool') {
  pool = createMatchPool({ threads: THREADS, onMatch: (m) => { const p = locks.find((l) => l.id === m.parlayId); if (p) matched++; } });
  pool.setLocks(locks);
}
function handle(raw) {
  if (pool) { pool.submit(raw, Date.now()); return; }
  const rfq = normalizeRfq(parseEnvelope(raw));
  if (matchParlay(rfq, locks)) matched++;
}

(async () => {
  if (pool) await new Promise((r) => setTimeout(r, 300)); // threads warm
  // warmup
  for (let i = 0; i < 2000; i++) { const rfq = normalizeRfq(parseEnvelope(frames[i])); matchParlay(rfq, locks); }
  const h = monitorEventLoopDelay({ resolution: 1 }); h.enable();
  const elu0 = performance.eventLoopUtilization();
  const t0 = performance.now(); let i = 0;
  await new Promise((done) => {
    const tick = () => {
      const el = performance.now() - t0;
      const due = Math.floor((el / 1000) * RATE);
      while (sent < due) { handle(frames[i++ % POOL]); sent++; }
      if (el >= SECS * 1000) return done();
      setImmediate(tick);
    };
    tick();
  });
  const elapsed = (performance.now() - t0) / 1000;
  const elu = performance.eventLoopUtilization(elu0);
  h.disable();
  const matchedRun = matched;
  let st = null; if (pool) { await new Promise((r) => setTimeout(r, 200)); st = await pool.stats(); }
  // Main-thread busy time per RFQ (excludes the bench's own idle spinning: setImmediate loop counts as active, so
  // measure handle() cost directly too).
  const tH = performance.now(); for (let k = 0; k < 20000; k++) handle(frames[k % POOL]); const perRfqUs = ((performance.now() - tH) * 1000) / 20000;
  console.log(JSON.stringify({ mode, threads: pool ? THREADS : 0, targetRate: RATE, achievedRate: Math.round(sent / elapsed), locks: NLOCKS,
    mainUsPerRfq: +perRfqUs.toFixed(1), mainBusyPct: +(perRfqUs * RATE / 1e4).toFixed(1),
    loopLagP50ms: +(h.percentile(50) / 1e6).toFixed(2), loopLagP99ms: +(h.percentile(99) / 1e6).toFixed(2), loopLagMaxMs: +(h.max / 1e6).toFixed(2),
    matched: matchedRun, workerMatched: st ? st.matched : undefined }));
  if (pool) await pool.stop();
  process.exit(0);
})();
