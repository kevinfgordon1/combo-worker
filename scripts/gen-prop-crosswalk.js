#!/usr/bin/env node
// Builds player-prop-crosswalk.json: verified Kalshi player ticker -> Polymarket US player
// market crosswalk for the ONLY two Combo Locks prop kinds: NFL anytime touchdowns
// (Kalshi KXNFLTD-…-{TEAM}{PLAYER}{#}-{N} <-> Poly astatc-nfl-…-td-{abbr}-gte{N}) and MLB
// home runs (Kalshi KXMLBHR <-> Poly astatc-mlb-…-hr-{abbr}-gte{N}).
// A Kalshi player pairs with a Poly player ONLY when ALL hold (never guessed):
//   1. same game: Kalshi event teams (split with the league's known team codes) == Poly slug
//      teams, same ET date (ticker date vs Poly slug date == ET of Poly gameStartTime), and for
//      MLB the Kalshi first-pitch clock (HHMM ET) is within 45 min of Poly gameStartTime;
//   2. the Kalshi ticker's team code is one of the game's two teams and equals the Poly
//      player's team (Poly metadata.teamId -> event.teams);
//   3. FULL player name equal after normalisation (case, accents, punctuation, spaces; the
//      Jr./Sr./II/III suffix is NOT stripped);
//   4. exactly one Poly player and one Kalshi player qualify (no duplicates either way).
// Anything else is listed under unmatchedKalshi / unmatchedPoly with the reason.
'use strict';
const fs = require('fs');
const path = require('path');
const { splitKnownCodes, normTeam } = require('../leg-identity');

const SERIES = {
  KXNFLTD: { league: 'nfl', poly: 'football_player_touchdowns', kind: 'td', stat: 'td' },
  KXMLBHR: { league: 'mlb', poly: 'baseball_player_home_runs', kind: 'hr', stat: 'hr' },
};
const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const nname = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[.'’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const etDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const etHm = (ms) => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms)); return p.replace(':', ''); };
const SLACK_MS = 45 * 60 * 1000;

function parseKalshiEvent(eventTicker) {
  const m = /^(KX[A-Z]+)-(\d\d)([A-Z]{3})(\d\d)(\d{4})?([A-Z]+)$/.exec(eventTicker);
  if (!m || !SERIES[m[1]] || !MON[m[3]]) return null;
  const date = `20${m[2]}-${String(MON[m[3]]).padStart(2, '0')}-${m[4]}`;
  return { series: m[1], date, hhmm: m[5] || null, blob: m[6] };
}

// kalshi: [{ event_ticker, markets:[{ticker, yes_sub_title, expected_expiration_time}] }] per series
// poly:   { slug: { slug, startTime, teams:[{id,abbreviation}], markets:[{slug, sportsMarketType, line, gameStartTime, metadata, marketSides}] } }
function buildPropCrosswalk(kalshiBySeries, polyEvents, opts = {}) {
  const players = []; const unmatchedKalshi = []; const polyUsed = new Set(); const kalshiSeen = new Set();
  const polyGames = Object.values(polyEvents);
  for (const [series, events] of Object.entries(kalshiBySeries)) {
    const spec = SERIES[series];
    for (const ev of events) {
      const pe = parseKalshiEvent(ev.event_ticker);
      const why = (w, extra) => unmatchedKalshi.push({ kalshiEvent: ev.event_ticker, why: w, players: new Set(ev.markets.map((m) => m.ticker.replace(/-\d$/, ''))).size, ...extra });
      if (!pe || pe.series !== series) { why('event_ticker_shape'); continue; }
      const kp = splitKnownCodes(pe.blob.toLowerCase(), spec.league);
      if (!kp) { why('kalshi_teams_unknown'); continue; }
      const kTeams = kp.map((t) => normTeam(spec.league, t));
      let clockMiss = 0;
      const games = polyGames.filter((g) => {
        const sm = new RegExp(`^${spec.league}-([a-z0-9]+)-([a-z0-9]+)-(\\d{4}-\\d\\d-\\d\\d)$`).exec(g.slug);
        if (!sm || sm[3] !== pe.date) return false;
        const pt = [normTeam(spec.league, sm[1]), normTeam(spec.league, sm[2])];
        if (pt.slice().sort().join() !== kTeams.slice().sort().join()) return false;
        if (spec.league === 'mlb') {
          const first = Date.parse(g.startTime);
          if (!pe.hhmm || !Number.isFinite(first)) { clockMiss += 1; return false; }
          const k = Date.parse(`${pe.date}T${pe.hhmm.slice(0, 2)}:${pe.hhmm.slice(2)}:00-04:00`);
          if (Math.abs(first - k) > SLACK_MS) { clockMiss += 1; return false; }
        }
        return true;
      });
      if (games.length !== 1) { why(games.length ? 'ambiguous_poly_games' : (clockMiss ? 'poly_first_pitch_clock_disagrees_with_kalshi' : 'no_poly_game_same_teams_date')); continue; }
      const g = games[0];
      if (etDate(Date.parse(g.startTime)) !== pe.date) { why('poly_game_et_date_differs'); continue; }
      const teamAbbr = new Map((g.teams || []).map((t) => [String(t.id), normTeam(spec.league, String(t.abbreviation).toLowerCase())]));
      const polyPlayers = new Map(); // `${teamId}|${nname}` -> [{abbr,playerId,name,teamId,markets:{N:slug}}]
      for (const m of g.markets) {
        if (m.sportsMarketType !== spec.poly || !m.metadata || !m.metadata.playerName) continue;
        const sm = /-(td|hr)-([a-z0-9]+)-gte(\d)$/.exec(m.slug);
        if (!sm || sm[1] !== spec.kind || sm[2] !== m.metadata.playerAbbreviation || Number(sm[3]) !== Number(m.line)) continue;
        const key = `${m.metadata.teamId}|${nname(m.metadata.playerName)}`;
        const arr = polyPlayers.get(key) || [];
        let rec = arr.find((r) => r.playerId === m.metadata.playerId);
        if (!rec) { rec = { abbr: m.metadata.playerAbbreviation, playerId: m.metadata.playerId, name: m.metadata.playerName, teamId: m.metadata.teamId, thresholds: [] }; arr.push(rec); }
        rec.thresholds.push(Number(sm[3]));
        polyPlayers.set(key, arr);
      }
      // group Kalshi markets by player (ticker minus the trailing -N)
      const byBase = new Map();
      for (const mk of ev.markets) {
        const t = /^(.+)-(\d)$/.exec(mk.ticker);
        if (!t || !t[1].startsWith(`${ev.event_ticker}-`)) { why('market_ticker_shape', { ticker: mk.ticker }); continue; }
        const base = t[1];
        const name = String(mk.yes_sub_title || '').replace(/:\s*\d+\+\s*$/, '');
        const rec = byBase.get(base) || { base, name, ths: [], tail: base.slice(ev.event_ticker.length + 1), titles: new Set() };
        rec.ths.push(Number(t[2])); rec.titles.add(name); byBase.set(base, rec);
      }
      for (const rec of byBase.values()) {
        const bad = (w) => unmatchedKalshi.push({ kalshi: rec.base, name: rec.name, why: w });
        if (rec.titles.size !== 1) { bad('kalshi_player_several_names'); continue; }
        if (/D\/ST/i.test(rec.name)) { bad('team_defense_not_a_poly_player_market'); continue; }
        // team code = the one game team that prefixes the tail (exactly one)
        const pref = kp.filter((t) => rec.tail.toLowerCase().startsWith(t));
        if (pref.length !== 1) { bad('team_code_not_unique_prefix'); continue; }
        const polyTeamId = [...teamAbbr.entries()].filter(([, a]) => a === normTeam(spec.league, pref[0])).map(([id]) => id);
        if (polyTeamId.length !== 1) { bad('poly_team_id_unresolved'); continue; }
        const hits = polyPlayers.get(`${polyTeamId[0]}|${nname(rec.name)}`) || [];
        if (hits.length !== 1) { bad(hits.length ? 'ambiguous_poly_players' : 'no_poly_player_same_full_name_and_team'); continue; }
        const pp = hits[0];
        const dupe = players.find((p) => p.poly.stem === g.slug && p.poly.abbr === pp.abbr);
        if (dupe) { bad('poly_player_claimed_twice'); unmatchedKalshi.push({ kalshi: dupe.k, name: dupe.name, why: 'poly_player_claimed_twice' }); players.splice(players.indexOf(dupe), 1); continue; }
        players.push({
          k: rec.base, league: spec.league, kind: spec.kind, name: rec.name, kTeam: pref[0],
          poly: { stem: g.slug, abbr: pp.abbr, playerId: pp.playerId, teamId: pp.teamId, name: pp.name, kickoff: g.startTime },
          kalshiThresholds: rec.ths.sort(), polyThresholds: pp.thresholds.sort(),
        });
        polyUsed.add(`${g.slug}|${pp.abbr}`);
        kalshiSeen.add(rec.base);
      }
    }
  }
  const unmatchedPoly = [];
  for (const g of polyGames) {
    for (const m of g.markets) {
      if (!m.metadata || !/^(football_player_touchdowns|baseball_player_home_runs)$/.test(m.sportsMarketType)) continue;
      const abbr = m.metadata.playerAbbreviation;
      const k = `${g.slug}|${abbr}`;
      if (polyUsed.has(k) || unmatchedPoly.some((u) => u.k === k)) continue;
      unmatchedPoly.push({ k, name: m.metadata.playerName, game: g.slug, why: 'no_kalshi_player_same_full_name_team_game' });
    }
  }
  // duplicates guard: every Kalshi base once, every Poly (stem,abbr) once
  const seenK = new Set(); const seenP = new Set(); const out = [];
  for (const p of players) {
    const pk = `${p.poly.stem}|${p.poly.abbr}`;
    if (seenK.has(p.k) || seenP.has(pk)) { unmatchedKalshi.push({ kalshi: p.k, name: p.name, why: 'duplicate_pairing' }); continue; }
    seenK.add(p.k); seenP.add(pk); out.push(p);
  }
  return {
    note: 'Verified Kalshi KXNFLTD/KXMLBHR player ticker -> Polymarket US astatc player market. Generated by scripts/gen-prop-crosswalk.js from real data; anything not listed is UNMAPPED.',
    generatedAt: opts.generatedAt || null, players: out, unmatchedKalshi, unmatchedPoly,
  };
}

// ── CLI: fetch real data (public endpoints) and write the crosswalk ─────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(u) {
  for (let i = 0; i < 8; i += 1) {
    const r = await fetch(u);
    if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
    if (!r.ok) return null;
    return r.json();
  }
  return null;
}
async function fetchAll() {
  const kalshi = {};
  for (const s of Object.keys(SERIES)) {
    let cursor = ''; const evs = [];
    for (let p = 0; p < 10; p += 1) {
      const j = await get(`https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=${s}&status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${cursor}` : ''}`);
      if (!j) break;
      evs.push(...(j.events || [])); cursor = j.cursor; if (!cursor) break; await sleep(700);
    }
    kalshi[s] = evs.map((e) => ({ event_ticker: e.event_ticker, markets: e.markets.map((m) => ({ ticker: m.ticker, yes_sub_title: m.yes_sub_title })) }));
    await sleep(700);
  }
  const poly = {};
  for (const lg of ['nfl', 'mlb']) {
    const l = await get(`https://gateway.polymarket.us/v2/leagues/${lg}/events?limit=80&active=true&closed=false`);
    for (const ev of (l && l.events) || []) {
      const d = await get(`https://gateway.polymarket.us/v1/events/slug/${ev.slug}`);
      if (!d) continue;
      const e = d.event || d;
      poly[ev.slug] = {
        slug: e.slug, startTime: e.startTime,
        teams: (e.teams || []).map((t) => ({ id: t.id, abbreviation: t.abbreviation })),
        markets: (e.markets || []).filter((m) => /^(football_player_touchdowns|baseball_player_home_runs)$/.test(m.sportsMarketType))
          .map((m) => ({ slug: m.slug, sportsMarketType: m.sportsMarketType, line: m.line, gameStartTime: m.gameStartTime, metadata: m.metadata })),
      };
      await sleep(900);
    }
  }
  return { kalshi, poly };
}
if (require.main === module) {
  (async () => {
    const out = path.join(__dirname, '..', 'player-prop-crosswalk.json');
    const cap = path.join(__dirname, '..', 'fixtures-props-captures.json');
    const data = process.argv.includes('--from-captures') ? JSON.parse(fs.readFileSync(cap, 'utf8')) : await fetchAll();
    if (process.argv.includes('--write-captures')) fs.writeFileSync(cap, JSON.stringify({ ...data, capturedAt: new Date().toISOString() }));
    const xw = buildPropCrosswalk(data.kalshi, data.poly, { generatedAt: data.capturedAt || new Date().toISOString() });
    fs.writeFileSync(out, JSON.stringify(xw));
    const by = {};
    for (const p of xw.players) by[p.league] = (by[p.league] || 0) + 1;
    console.log('mapped', JSON.stringify(by), 'unmatchedKalshi', xw.unmatchedKalshi.length, 'unmatchedPoly', xw.unmatchedPoly.length);
  })();
}
module.exports = { buildPropCrosswalk, nname, SERIES };
