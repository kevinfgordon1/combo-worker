'use strict';
// Load benchmark for the canonical schedule resolver at (above) live sniper rate.
// Simulates N RFQ legs against 650+ games through the sniper's kickoff resolver (canonical first) and reports
// per-call time and heap growth. Usage: node --expose-gc scripts/bench-game-schedule.js [legs]
const G = require('../game-schedule');
const { createKickoffResolver } = require('../sniper/kickoff');
const FX = require('../fixtures-espn-schedule-2026-10-27.json');

function buildGames(minGames = 650) {
  const base = Object.entries(FX).flatMap(([k, j]) => G.espnRows(k.split('|')[0], j));
  const out = [...base]; let shift = 1;
  while (out.length < minGames) { // same slate on later days with new ids (a full -1..+7 day schedule)
    for (const g of base) out.push({ ...g, espn_id: `${g.espn_id}d${shift}`, start_ms: g.start_ms + shift * 86400000 });
    shift += 1;
  }
  return out;
}
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function tickersFor(games) {
  const kind = { NBA: ['GAME', 'SPREAD', 'TOTAL'], NHL: ['GAME', 'TOTAL'], NFL: ['GAME', 'SPREAD', 'TD'], NCAAF: ['GAME', 'SPREAD'] };
  const out = [];
  for (const g of games) {
    const d = new Date(g.start_ms - 5 * 3600000); // ET-ish date
    const dt = `${String(d.getUTCFullYear()).slice(2)}${MON[d.getUTCMonth()]}${String(d.getUTCDate()).padStart(2, '0')}`;
    for (const k of kind[g.league] || ['GAME']) out.push(`KX${g.league}${k}-${dt}${g.away.abbr}${g.home.abbr}-${g.home.abbr}`);
  }
  for (let i = 0; i < 200; i += 1) out.push(`KXNBAGAME-26OCT${20 + (i % 9)}ZZ${i}QQ-QQ`); // misses (no official game)
  return out;
}
function run({ legs = 20000, resolver = null } = {}) {
  const games = buildGames(); const tickers = tickersFor(games);
  const K = createKickoffResolver();
  K.setCanonical(resolver ? resolver(games) : (t) => G.resolveStart(t, games));
  for (let i = 0; i < 500; i += 1) K.resolve(tickers[i % tickers.length]); // warm-up
  if (global.gc) global.gc();
  const heap0 = process.memoryUsage().heapUsed; let canonical = 0; const t0 = process.hrtime.bigint(); let worst = 0;
  for (let i = 0; i < legs; i += 1) {
    const a = process.hrtime.bigint();
    const r = K.resolve(tickers[(i * 7919) % tickers.length]); if (r && r.source === 'canonical') canonical += 1;
    const us = Number(process.hrtime.bigint() - a) / 1000; if (us > worst) worst = us;
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const heapPeak = process.memoryUsage().heapUsed; if (global.gc) global.gc();
  const heap1 = process.memoryUsage().heapUsed;
  return { games: games.length, distinctTickers: tickers.length, legs, totalMs: +totalMs.toFixed(1), perCallUs: +((totalMs * 1000) / legs).toFixed(2), worstUs: +worst.toFixed(0),
    canonicalHits: canonical, heapGrowthMB: +((heap1 - heap0) / 1048576).toFixed(2), heapPeakDeltaMB: +((heapPeak - heap0) / 1048576).toFixed(2) };
}
module.exports = { run, buildGames, tickersFor };
if (require.main === module) console.log(JSON.stringify(run({ legs: Number(process.argv[2] || 20000) })));
