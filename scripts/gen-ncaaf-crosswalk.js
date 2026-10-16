#!/usr/bin/env node
// Builds ncaaf-crosswalk.json: a VERIFIED Kalshi-code -> Polymarket-abbreviation
// team crosswalk from REAL data (never guessed).
//   Kalshi: public GET /trade-api/v2/events?series_ticker=KXNCAAFGAME (nested markets)
//   Poly:   public GET gateway.polymarket.us/v2/leagues/cfb/events (ML market + team metadata)
// A Kalshi game is paired with a Poly game ONLY when
//   (1) the ET game date is identical (Kalshi ticker date vs Poly slug date, and the
//       slug date must equal the ET date of the Poly gameStartTime),
//   (2) BOTH Kalshi team names equal the two Poly team names exactly after
//       normalisation (St. = State, & = and, punctuation) - Poly team.name, or the
//       Poly event-title part at the same away/home position when Poly shortens a
//       name (NM State) - and the two Kalshi teams land on the two DISTINCT Poly
//       sides,
//   (3) exactly ONE Poly game qualifies,
//   (4) Kalshi's expected-expiration clock is within a sane window of Poly's kickoff
//       (Kalshi NCAAF tickers carry no kickoff clock; this only rejects nonsense).
// Per-team: a Kalshi code that maps to two different Poly abbreviations, a Poly
// abbreviation claimed by two Kalshi codes, or a code whose Kalshi name differs
// between events is DROPPED (conflict) and the team stays unmapped. Every Kalshi blob
// must then split into its two codes in exactly one way.
'use strict';
const fs = require('fs');
const path = require('path');

const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const nn = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\bst\.(?=\s|$)/g, 'state')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const etDate = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));
const EXP_WINDOW_H = 12;

// slim shapes:
//  kalshi: [{ event_ticker, title, markets: [{ ticker, yes_sub_title, expected_expiration_time }] }]
//  poly:   [{ slug, title, startTime, ml: { slug, gameStartTime, sides: [{ long, name, abbreviation, league, ordering }] } }]
function buildCrosswalk(kalshiEvents, polyEvents, opts = {}) {
  const poly = polyEvents.map((e) => {
    const mm = e.slug.match(/^cfb-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d\d-\d\d)$/);
    if (!mm) throw new Error(`poly slug shape ${e.slug}`);
    const L = e.ml.sides.find((s) => s.long === true);
    const S = e.ml.sides.find((s) => s.long === false);
    const ok = L && S && e.ml.sides.length === 2 && L.abbreviation === mm[1] && S.abbreviation === mm[2]
      && L.league === 'cfb' && S.league === 'cfb' && e.ml.slug === `aec-${e.slug}`
      && etDate(Date.parse(e.ml.gameStartTime)) === mm[3];
    if (!ok) throw new Error(`poly sanity ${e.slug}`);
    return { slug: e.slug, title: e.title, tp: String(e.title).split(' vs. '), date: mm[3], gst: e.ml.gameStartTime, sides: e.ml.sides };
  });
  const sideTitle = (p, s) => p.tp[s.ordering === 'away' ? 0 : 1];
  const games = []; const unmatched = []; const used = new Set();
  for (const e of kalshiEvents) {
    const m = e.event_ticker.match(/^KXNCAAFGAME-(\d\d)([A-Z]{3})(\d\d)([A-Z0-9]+)$/);
    if (!m) { unmatched.push({ kalshi: e.event_ticker, title: e.title, why: 'ticker_shape' }); continue; }
    const date = `20${m[1]}-${String(MON[m[2]]).padStart(2, '0')}-${m[3]}`;
    const kt = e.markets.map((x) => ({ code: x.ticker.split('-').pop(), name: x.yes_sub_title, exp: x.expected_expiration_time }));
    const nameHit = (p, k) => p.sides.filter((s) => nn(s.name) === nn(k.name)
      || (p.tp.length === 2 && nn(sideTitle(p, s)) === nn(k.name)));
    const cand = poly.filter((p) => p.date === date && kt.length === 2
      && kt.every((k) => nameHit(p, k).length === 1));
    if (cand.length !== 1) {
      unmatched.push({ kalshi: e.event_ticker, title: e.title, why: cand.length ? 'ambiguous_poly_games' : 'no_poly_game_with_both_team_names_on_same_et_date' });
      continue;
    }
    const p = cand[0];
    const teams = kt.map((k) => { const s = nameHit(p, k)[0]; return { k: k.code, kname: k.name, p: s.abbreviation, pname: s.name }; });
    if (new Set(teams.map((t) => t.p)).size !== 2) { unmatched.push({ kalshi: e.event_ticker, title: e.title, why: 'both_kalshi_teams_on_one_poly_side' }); continue; }
    const dh = (Date.parse(kt[0].exp) - Date.parse(p.gst)) / 36e5;
    if (!Number.isFinite(dh) || Math.abs(dh) > EXP_WINDOW_H) { unmatched.push({ kalshi: e.event_ticker, title: e.title, why: 'kalshi_clock_far_from_poly_kickoff' }); continue; }
    games.push({ blob: e.event_ticker.split('-')[1].slice(7), date, poly: p.slug, kickoff: p.gst, teams });
    used.add(p.slug);
  }
  const byK = {}; const byP = {};
  for (const g of games) for (const t of g.teams) {
    (byK[t.k] = byK[t.k] || new Set()).add(JSON.stringify([t.p, t.kname, t.pname]));
    (byP[t.p] = byP[t.p] || new Set()).add(t.k);
  }
  const conflicts = []; const teams = {};
  for (const k of Object.keys(byK).sort()) {
    const v = [...byK[k]];
    if (v.length > 1) { conflicts.push({ k, why: 'code_maps_to_several_poly_teams', v }); continue; }
    const [p, name, pname] = JSON.parse(v[0]);
    if (byP[p].size > 1) { conflicts.push({ k, p, why: 'poly_abbr_claimed_by_several_kalshi_codes', codes: [...byP[p]] }); continue; }
    teams[k] = { p, name, pname };
  }
  // Poly abbreviation must denote ONE team name across every Poly game.
  const polyNames = {};
  for (const pg of poly) for (const s of pg.sides) (polyNames[s.abbreviation] = polyNames[s.abbreviation] || new Set()).add(s.name);
  for (const a of Object.keys(polyNames)) {
    if (polyNames[a].size > 1) {
      conflicts.push({ polyAbbr: a, why: 'poly_abbr_several_names', names: [...polyNames[a]] });
      for (const k of Object.keys(teams)) if (teams[k].p === a) delete teams[k];
    }
  }
  // A Kalshi code must carry one name across ALL Kalshi game events (matched or not).
  const kNames = {};
  for (const e of kalshiEvents) for (const x of e.markets) {
    const c = x.ticker.split('-').pop();
    (kNames[c] = kNames[c] || new Set()).add(x.yes_sub_title);
  }
  for (const c of Object.keys(teams)) {
    if (kNames[c] && [...kNames[c]].some((n) => n !== teams[c].name)) {
      conflicts.push({ k: c, why: 'kalshi_code_several_names', names: [...kNames[c]] });
      delete teams[c];
    }
  }
  // Every matched blob must split into its two codes in EXACTLY one way.
  const codes = Object.keys(teams);
  const splitsOf = (b) => {
    const out = [];
    for (const a of codes) if (b.startsWith(a)) { const r = b.slice(a.length); if (r !== a && teams[r]) out.push([a, r]); }
    return out;
  };
  const kept = [];
  for (const g of games) {
    const sp = splitsOf(g.blob);
    const want = g.teams.map((t) => t.k).sort().join();
    if (sp.length === 1 && sp[0].slice().sort().join() === want && g.teams.every((t) => teams[t.k])) kept.push(g);
    else unmatched.push({ kalshi: `KXNCAAFGAME-${g.date}-${g.blob}`, title: g.teams.map((t) => t.kname).join(' vs '), why: 'blob_split_not_unique_or_team_dropped' });
  }
  const polyUnmatched = poly.filter((p) => !used.has(p.slug))
    .map((p) => ({ slug: p.slug, title: p.title, kickoff: p.gst, why: 'no_kalshi_game_with_both_team_names_on_same_et_date' }));
  return {
    note: 'Verified Kalshi KXNCAAF* team code -> Polymarket US cfb abbreviation. Generated by scripts/gen-ncaaf-crosswalk.js from real data; anything not listed is UNMAPPED.',
    generatedAt: opts.generatedAt || null,
    teams, games: kept, unmatchedKalshi: unmatched, unmatchedPoly: polyUnmatched, conflicts,
  };
}

function slimKalshi(events) {
  return events.map((e) => ({
    event_ticker: e.event_ticker, title: e.title,
    markets: e.markets.map((m) => ({ ticker: m.ticker, yes_sub_title: m.yes_sub_title, expected_expiration_time: m.expected_expiration_time })),
  }));
}
function slimPoly(events) {
  return events.map((e) => {
    const m = e.markets.find((x) => x.sportsMarketType === 'football_team_full_game_winner');
    return {
      slug: e.slug, title: e.title, startTime: e.startTime,
      ml: m && {
        slug: m.slug, gameStartTime: m.gameStartTime,
        sides: m.marketSides.map((s) => ({ long: s.long, name: s.team.name, abbreviation: s.team.abbreviation, league: s.team.league, ordering: s.team.ordering })),
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

async function fetchLive() {
  const kal = []; let cursor = '';
  for (let p = 0; p < 20; p += 1) {
    const j = await getJson(`https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXNCAAFGAME&status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${cursor}` : ''}`);
    kal.push(...(j.events || [])); cursor = j.cursor; if (!cursor) break;
    await new Promise((ok) => setTimeout(ok, 700));
  }
  const pol = new Map();
  for (let off = 0; off < 800; off += 80) {
    const j = await getJson(`https://gateway.polymarket.us/v2/leagues/cfb/events?limit=80&offset=${off}&active=true&closed=false`);
    const evs = j.events || [];
    for (const e of evs) pol.set(e.slug, e);
    if (evs.length < 80) break;
    await new Promise((ok) => setTimeout(ok, 700));
  }
  return { kalshi: slimKalshi(kal), poly: slimPoly([...pol.values()]) };
}

module.exports = { buildCrosswalk, slimKalshi, slimPoly, nn };

if (require.main === module) {
  (async () => {
    const cap = await fetchLive();
    const out = buildCrosswalk(cap.kalshi, cap.poly, { generatedAt: new Date().toISOString() });
    const dir = path.join(__dirname, '..');
    fs.writeFileSync(path.join(dir, 'ncaaf-crosswalk.json'), `${JSON.stringify(out, null, 1)}\n`);
    if (process.argv.includes('--write-captures')) {
      fs.writeFileSync(path.join(dir, 'fixtures-ncaaf-captures.json'), `${JSON.stringify({ capturedAt: out.generatedAt, kalshi: cap.kalshi, poly: cap.poly })}\n`);
    }
    console.log(`teams=${Object.keys(out.teams).length} games=${out.games.length} unmatchedKalshi=${out.unmatchedKalshi.length} unmatchedPoly=${out.unmatchedPoly.length} conflicts=${out.conflicts.length}`);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
