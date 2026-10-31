#!/usr/bin/env node
// Builds ncaab-crosswalk.json (+ ncaab-d1-teams.json): a VERIFIED, D1-ONLY team crosswalk for men's
// college basketball (Kevin Oct 30 2026: D1-vs-D1 games only), from REAL data, never guessed.
//   ESPN:   teams?groups=50 (D1) + groups=50 scoreboard competitors that carry a conferenceId
//           (reclassifying D1 members such as Queens / Lindenwood). Every other school is NOT D1.
//   Kalshi: public GET /trade-api/v2/events?series_ticker=KXNCAAMBGAME (nested markets)
//   Poly:   public GET gateway.polymarket.us/v2/leagues/cbb/events (ML market + team metadata)
// Canonical NCAAB team identity = the ESPN team id. A venue team is mapped ONLY when its own name
// resolves (ncaab-d1.js, exact normalized name or a listed alias) to exactly one D1 team:
//   Kalshi code -> espnId  (the code must carry ONE name across every Kalshi event, and an espnId
//                           claimed by two codes drops both)
//   Poly abbr   -> espnId  (the abbreviation must carry ONE name across every Poly game)
// Non-D1 names (Fisk, Bethesda, Willamette ...) never enter the table, so their games never split.
// Every D1-vs-D1 Kalshi blob must then split into its two codes in exactly one way.
// Usage: node scripts/gen-ncaab-crosswalk.js [--days=21] [--write-captures]
'use strict';
const fs = require('fs');
const path = require('path');
const D1 = require('../ncaab-d1');

const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball';
const etDate = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

// slim shapes:
//  kalshi: [{ event_ticker, title, markets: [{ ticker, yes_sub_title }] }]
//  poly:   [{ slug, title, startTime, ml: { slug, gameStartTime, sides: [{ long, name, abbreviation, ordering }] } }]
//  d1:     [{ espnId, abbr, location, short, display, name }]
function buildCrosswalk(kalshiEvents, polyEvents, d1Teams, opts = {}) {
  if (d1Teams) D1.useTeams(d1Teams);
  const conflicts = [];
  const nonD1 = new Set();
  // ---- Kalshi codes
  const kNames = {}; // code -> Set(name)
  for (const e of kalshiEvents) for (const x of e.markets || []) {
    const c = String(x.ticker || '').split('-').pop();
    if (!/^[A-Z0-9]+$/.test(c)) continue;
    (kNames[c] = kNames[c] || new Set()).add(x.yes_sub_title);
  }
  const teams = {};
  const byEspn = {};
  for (const c of Object.keys(kNames).sort()) {
    const names = [...kNames[c]];
    if (names.length > 1) { conflicts.push({ k: c, why: 'kalshi_code_several_names', names }); continue; }
    const t = D1.d1Team(names[0]);
    if (!t) { nonD1.add(names[0]); continue; }
    (byEspn[t.espnId] = byEspn[t.espnId] || []).push(c);
    teams[c] = { espnId: t.espnId, name: names[0], espn: t.display, p: null, pname: null };
  }
  for (const [id, codes] of Object.entries(byEspn)) {
    if (codes.length > 1) { conflicts.push({ espnId: id, why: 'espn_team_claimed_by_several_kalshi_codes', codes }); for (const c of codes) delete teams[c]; }
  }
  // ---- Polymarket US abbreviations
  const pNames = {};
  for (const pg of polyEvents) for (const s of (pg.ml && pg.ml.sides) || []) (pNames[s.abbreviation] = pNames[s.abbreviation] || new Set()).add(s.name);
  const codeByEspn = {};
  for (const [c, t] of Object.entries(teams)) codeByEspn[t.espnId] = c;
  const polyToEspn = {};
  const unmatchedPoly = [];
  for (const a of Object.keys(pNames).sort()) {
    const names = [...pNames[a]];
    if (names.length > 1) { conflicts.push({ polyAbbr: a, why: 'poly_abbr_several_names', names }); continue; }
    const t = D1.d1Team(names[0]);
    if (!t) { nonD1.add(names[0]); unmatchedPoly.push({ p: a, name: names[0], why: 'not_d1_or_unknown_name' }); continue; }
    if (Object.values(polyToEspn).includes(t.espnId)) {
      conflicts.push({ polyAbbr: a, espnId: t.espnId, why: 'espn_team_claimed_by_several_poly_abbrs' });
      for (const [k, v] of Object.entries(polyToEspn)) if (v === t.espnId) delete polyToEspn[k];
      continue;
    }
    polyToEspn[a] = t.espnId;
  }
  for (const [a, id] of Object.entries(polyToEspn)) {
    const c = codeByEspn[id];
    if (!c) { unmatchedPoly.push({ p: a, name: [...pNames[a]][0], why: 'no_kalshi_code_for_team' }); continue; }
    teams[c].p = a; teams[c].pname = [...pNames[a]][0];
  }
  // ---- Kalshi games: D1-vs-D1 only, blob must split uniquely
  const codes = Object.keys(teams);
  const splitsOf = (b) => {
    const out = [];
    for (const a of codes) if (b.startsWith(a)) { const r = b.slice(a.length); if (r !== a && teams[r]) out.push([a, r]); }
    return out;
  };
  const games = []; const unmatchedKalshi = [];
  for (const e of kalshiEvents) {
    const m = String(e.event_ticker || '').match(/^KXNCAAMBGAME-(\d\d)([A-Z]{3})(\d\d)([A-Z0-9]+)$/);
    if (!m) { unmatchedKalshi.push({ kalshi: e.event_ticker, title: e.title, why: 'ticker_shape' }); continue; }
    const date = `20${m[1]}-${String(MON[m[2]]).padStart(2, '0')}-${m[3]}`;
    const mk = (e.markets || []).map((x) => String(x.ticker).split('-').pop());
    if (mk.length !== 2 || !mk.every((c) => teams[c])) {
      unmatchedKalshi.push({ kalshi: e.event_ticker, title: e.title, why: mk.some((c) => kNames[c] && !D1.d1Team([...kNames[c]][0])) ? 'not_d1_vs_d1' : 'team_unmapped' });
      continue;
    }
    const sp = splitsOf(m[4]);
    if (sp.length !== 1 || sp[0].slice().sort().join() !== mk.slice().sort().join()) {
      unmatchedKalshi.push({ kalshi: e.event_ticker, title: e.title, why: 'blob_split_not_unique' });
      continue;
    }
    // Cross-venue check (informational): same ET date + same two ESPN teams on Polymarket US.
    const want = mk.map((c) => teams[c].espnId).sort().join('+');
    const poly = polyEvents.find((p) => {
      const ids = ((p.ml && p.ml.sides) || []).map((s) => polyToEspn[s.abbreviation]).filter(Boolean).sort().join('+');
      return ids === want && p.ml && etDate(Date.parse(p.ml.gameStartTime || p.startTime)) === date;
    });
    games.push({ blob: m[4], date, codes: sp[0], poly: poly ? poly.slug : null });
  }
  return {
    note: 'Verified D1-only NCAAB team crosswalk: Kalshi KXNCAAMB* code -> ESPN team id (+ Polymarket US cbb abbreviation). Generated by scripts/gen-ncaab-crosswalk.js from real data; anything not listed is UNMAPPED and never quoted.',
    generatedAt: opts.generatedAt || null,
    teams, games, unmatchedKalshi, unmatchedPoly, conflicts, nonD1: [...nonD1].sort(),
  };
}

function slimKalshi(events) {
  return events.map((e) => ({
    event_ticker: e.event_ticker, title: e.title,
    markets: (e.markets || []).map((m) => ({ ticker: m.ticker, yes_sub_title: m.yes_sub_title })),
  }));
}
function slimPoly(events) {
  return events.map((e) => {
    const m = (e.markets || []).find((x) => x.sportsMarketType === 'basketball_team_full_game_winner');
    return {
      slug: e.slug, title: e.title, startTime: e.startTime,
      ml: m && {
        slug: m.slug, gameStartTime: m.gameStartTime || e.startTime,
        sides: (m.marketSides || []).map((s) => ({ long: s.long, name: s.team && s.team.name, abbreviation: s.team && s.team.abbreviation, ordering: s.team && s.team.ordering })),
      },
    };
  }).filter((e) => e.ml);
}

async function getJson(url) {
  for (let i = 0; i < 8; i += 1) {
    const r = await fetch(url);
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }
  throw new Error(`429 ${url}`);
}

const slimEspn = (t) => ({
  espnId: String(t.id), abbr: String(t.abbreviation || '').toUpperCase(), location: t.location || '',
  short: t.shortDisplayName || '', display: t.displayName || '', name: t.name || '',
});

async function fetchD1(days) {
  const byId = new Map();
  const list = await getJson(`${ESPN}/teams?groups=50&limit=500`);
  for (const { team } of list.sports[0].leagues[0].teams) byId.set(String(team.id), slimEspn(team));
  const fromList = byId.size;
  for (let d = 0; d < days; d += 1) {
    const ymd = etDate(Date.now() + d * 864e5).replace(/-/g, '');
    const body = await getJson(`${ESPN}/scoreboard?groups=50&limit=500&dates=${ymd}`);
    for (const e of body.events || []) {
      for (const c of (e.competitions && e.competitions[0] && e.competitions[0].competitors) || []) {
        const t = c.team || {};
        if (t.id && t.conferenceId && !byId.has(String(t.id))) byId.set(String(t.id), slimEspn(t));
      }
    }
  }
  return { fromList, teams: [...byId.values()].sort((a, b) => a.location.localeCompare(b.location)) };
}

async function fetchLive() {
  const kal = []; let cursor = '';
  for (let p = 0; p < 20; p += 1) {
    const j = await getJson(`https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXNCAAMBGAME&status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${cursor}` : ''}`);
    kal.push(...(j.events || [])); cursor = j.cursor; if (!cursor) break;
    await new Promise((ok) => setTimeout(ok, 700));
  }
  const pol = new Map();
  for (let off = 0; off < 2000; off += 80) {
    const j = await getJson(`https://gateway.polymarket.us/v2/leagues/cbb/events?limit=80&offset=${off}&active=true&closed=false`);
    const evs = (j.events || []).filter((e) => /^cbb-[a-z0-9]+-[a-z0-9]+-\d{4}-\d\d-\d\d$/.test(String(e.slug || '')));
    for (const e of evs) pol.set(e.slug, e);
    if ((j.events || []).length < 80) break;
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  return { kalshi: slimKalshi(kal), poly: slimPoly([...pol.values()]) };
}

module.exports = { buildCrosswalk, slimKalshi, slimPoly };

if (require.main === module) {
  (async () => {
    const days = Number((process.argv.find((a) => a.startsWith('--days=')) || '').split('=')[1]) || 21;
    const dir = path.join(__dirname, '..');
    const d1 = await fetchD1(days);
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'ncaab-d1-teams.json'), `${JSON.stringify({
      note: `NCAA D1 men's basketball teams from ESPN (teams?groups=50 = ${d1.fromList}, plus conference members seen on the groups=50 scoreboard). Generated by scripts/gen-ncaab-crosswalk.js. A team not listed is treated as non-D1 (dropped).`,
      generatedAt: at, teams: d1.teams,
    }, null, 1)}\n`);
    const cap = await fetchLive();
    const out = buildCrosswalk(cap.kalshi, cap.poly, d1.teams, { generatedAt: at });
    fs.writeFileSync(path.join(dir, 'ncaab-crosswalk.json'), `${JSON.stringify(out, null, 1)}\n`);
    if (process.argv.includes('--write-captures')) {
      fs.writeFileSync(path.join(dir, 'fixtures-ncaab-captures.json'), `${JSON.stringify({ capturedAt: at, kalshi: cap.kalshi, poly: cap.poly })}\n`);
    }
    console.log(`d1=${d1.teams.length} teams=${Object.keys(out.teams).length} games=${out.games.length} withPoly=${out.games.filter((g) => g.poly).length} unmatchedKalshi=${out.unmatchedKalshi.length} unmatchedPoly=${out.unmatchedPoly.length} conflicts=${out.conflicts.length} nonD1=${out.nonD1.length}`);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
