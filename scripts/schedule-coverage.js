// Coverage check: does the canonical resolver find an official (ESPN) start for every given Kalshi event?
// usage: node scripts/schedule-coverage.js <file with "label EV EV ..." lines>
'use strict';
const fs = require('fs');
const G = require('../game-schedule');
(async () => {
  const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/));
  const all = lines.flatMap(([lab, ...evs]) => evs.map((e) => [lab, e]));
  const need = new Set();
  for (const [, e] of all) { const p = G.parseEvent(e); if (!p) continue; for (const s of [-1, 0, 1]) need.add(`${p.league}|${G.addDays(p.date, s)}`); }
  const games = []; const fails = [];
  for (const k of need) { const [lg, d] = k.split('|'); try { games.push(...await G.fetchEspnDay(lg, d)); } catch (e) { fails.push(`${k}: ${e.message}`); } }
  const { rows, misses } = G.buildRows(all.map((x) => x[1]), games);
  const byEv = new Map(rows.map((r) => [r.kalshi_event, r]));
  const et = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const out = {};
  for (const [lab, e] of all) { const r = byEv.get(e); (out[lab] = out[lab] || { ok: 0, miss: [] }); if (r && r.time_valid) out[lab].ok += 1; else out[lab].miss.push(`${e} (${r ? 'time TBD' : (misses.find((m) => m.event === e) || {}).why})`); }
  if (process.env.SHOW) for (const r of rows) console.log(r.kalshi_event.padEnd(30), et(r.start_time_utc), r.away_name, '@', r.home_name);
  console.log(JSON.stringify({ out, fails }, null, 1));
})();
