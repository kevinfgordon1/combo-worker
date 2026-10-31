#!/usr/bin/env node
// Cron-friendly check: are there NCAAB team names / codes on any venue that the committed canonical table
// (ncaab-teams.json) cannot resolve? Uses the RUNTIME resolver (ncaab-teams.js), exactly as the relay / snipers /
// aibetbuilder do, against a fresh live capture (scripts/ncaab-teams-capture.js, no history pull).
//   exit 0 = every D1 name resolves; exit 2 = new unmatched names (listed); exit 1 = capture failed.
// Known non-D1 schools (ncaab-teams.json nonD1, or the ESPN schedule shows a non-D1 opponent) are not alerts.
// Options: --json (machine output), --capture=<file> (offline), --telegram (send the alert with
// TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from env, only when something is unmatched).
// Fix: add the name to ncaab-team-overrides.json (or just regenerate: node scripts/gen-ncaab-teams.js) and
// copy the json to aibetbuilder (npm run sync:ncaab-teams there).
'use strict';
const fs = require('fs');
const T = require('../ncaab-teams');

function checkCapture(cap, table = null) {
  if (table) T.use(table);
  T.setSchedule((cap.espn && cap.espn.games) || []);
  const D1 = new Set(T.teams().map((t) => t.espnId));
  const sched = ((cap.espn && cap.espn.games) || []).map((g) => ({ ...g, ms: Date.parse(g.date) }));
  // ESPN says this D1 team's opponent near `ms` is a NON-D1 school -> the other name is expected to be unmatched
  const oppIsNonD1 = (id, ms) => { const g = sched.filter((x) => (x.homeId === id || x.awayId === id) && Math.abs(x.ms - ms) <= 20 * 3600e3); return g.length === 1 && !D1.has(g[0].homeId === id ? g[0].awayId : g[0].homeId); };
  const out = {}; const unmatched = {};
  const bump = (src, k) => { const c = out[src] || (out[src] = { total: 0, matched: 0, nonD1: 0, unmatched: 0 }); c[k] += 1; c.total += k === 'total' ? 0 : 0; };
  const game = (src, a, h, ms, label) => {
    const c = out[src] || (out[src] = { total: 0, matched: 0, nonD1: 0, unmatched: 0 }); c.total += 1;
    const r = T.resolveGame(src, { away: a, home: h, tipMs: ms });
    if (r.awayId && r.homeId) { c.matched += 1; return; }
    const sides = [[a, r.awayId, r.homeId], [h, r.homeId, r.awayId]];
    const bad = sides.filter(([, id]) => !id);
    if (bad.every(([, , other]) => other && oppIsNonD1(other, ms)) || /non_d1/.test(r.why || '')) { c.nonD1 += 1; return; }
    c.unmatched += 1;
    for (const [s] of bad) { const k = s.name || s.code; (unmatched[src] = unmatched[src] || new Map()).set(k, { name: s.name || null, code: s.code || null, game: label }); }
  };
  const name = (src, raw, extra = {}) => {
    const c = out[src] || (out[src] = { total: 0, matched: 0, nonD1: 0, unmatched: 0 }); c.total += 1;
    const r = T.resolveTeam(src.split(':')[0], { name: raw, ...extra });
    if (r.espnId) { c.matched += 1; return; }
    if (/non_d1/.test(r.why || '')) { c.nonD1 += 1; return; }
    c.unmatched += 1; (unmatched[src] = unmatched[src] || new Map()).set(raw, { name: raw });
  };
  for (const e of (cap.kalshi && cap.kalshi.KXNCAAMBGAME) || []) {
    const mk = (e.markets || []).map((x) => ({ code: String(x.ticker).split('-').pop(), name: x.yes_sub_title }));
    const ms = Date.parse((e.markets[0] || {}).occ || '') - 3 * 3600e3;
    if (mk.length === 2) game('kalshi', mk[0], mk[1], ms, e.event_ticker);
  }
  for (const e of (cap.kalshi && cap.kalshi.KXMARMAD) || []) for (const x of e.markets || []) name('kalshiFutures', x.yes_sub_title);
  for (const g of (cap.polymarket && cap.polymarket.games) || []) {
    const s = (g.sides || []).map((x) => ({ code: x.abbreviation, name: x.safeName || x.name }));
    if (s.length === 2) game('polymarket', s[0], s[1], Date.parse(g.startTime), g.slug);
  }
  for (const m of Array.isArray(cap.polymarket && cap.polymarket.champ) ? cap.polymarket.champ : []) name('polymarketFutures', m.safeName || m.name);
  for (const e of Array.isArray(cap.novig) ? cap.novig : []) { const p = String(e.description || '').split(/\s+@\s+/); if (p.length === 2) game('novig', { name: p[0] }, { name: p[1] }, Number(e.startsTs), e.description); }
  const px = new Map(); for (const q of (cap.prophetx && cap.prophetx.quotes) || []) px.set(`${q.away}|${q.home}`, q);
  for (const q of px.values()) game('prophetx', { name: q.away }, { name: q.home }, Date.parse(q.start), `${q.away} @ ${q.home}`);
  const ud = new Map(((cap.underdog && cap.underdog.teams) || []).map((t) => [t.id, t]));
  for (const g of (cap.underdog && cap.underdog.games) || []) {
    const full = String(g.full || '').split(/\s+@\s+/);
    const a = ud.get(g.away_team_id) || {}; const h = ud.get(g.home_team_id) || {};
    game('underdog', { name: full[0] || a.locality, code: a.abbr }, { name: full[1] || h.locality, code: h.abbr }, Date.parse(g.scheduled_at), g.full);
  }
  const oa = cap.oddsapi || {};
  for (const e of Array.isArray(oa.events) ? oa.events : []) game('oddsapi', { name: e.away }, { name: e.home }, Date.parse(e.commence), `${e.away} @ ${e.home}`);
  if (oa.futures && !oa.futures.error) for (const [book, names] of Object.entries(oa.futures)) for (const raw of names) name(`books:${book}`, raw);
  for (const c of Object.values(out)) { const d = c.total - c.nonD1; c.coveragePct = d > 0 ? Math.round((1000 * c.matched) / d) / 10 : null; }
  void bump;
  return { coverage: out, unmatched: Object.fromEntries(Object.entries(unmatched).map(([k, v]) => [k, [...v.values()]])) };
}

module.exports = { checkCapture };

if (require.main === module) {
  (async () => {
    const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
    const cap = arg('capture') ? JSON.parse(fs.readFileSync(arg('capture'), 'utf8')) : await require('./ncaab-teams-capture').captureAll({ noHistory: true });
    const res = checkCapture(cap);
    const n = Object.values(res.unmatched).reduce((s, l) => s + l.length, 0);
    if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: n === 0, tableHash: T.contentHash, ...res }, null, 1));
    else {
      console.log(`ncaab-teams ${T.contentHash} (${T.teamCount} teams, generated ${T.generatedAt})`);
      for (const [s, c] of Object.entries(res.coverage)) console.log(`${s.padEnd(20)} ${String(c.coveragePct).padStart(5)}%  matched=${c.matched}/${c.total} nonD1=${c.nonD1} unmatched=${c.unmatched}`);
      for (const [s, l] of Object.entries(res.unmatched)) console.log(`NEW UNMATCHED ${s}: ${l.map((x) => `${x.name || ''}${x.code ? ` [${x.code}]` : ''}`).join('; ')}`);
      if (!n) console.log('OK: every D1 name resolves');
    }
    if (n && process.argv.includes('--telegram') && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      const lines = Object.entries(res.unmatched).map(([s, l]) => `${s}: ${l.map((x) => x.name || x.code).join(', ')}`);
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: `NCAAB team names: ${n} new unmatched\n${lines.join('\n')}`.slice(0, 3900) }),
      }).catch(() => {});
    }
    process.exit(n ? 2 : 0);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
