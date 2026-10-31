#!/usr/bin/env node
// Builds ncaab-teams.json: the ONE canonical NCAAB team table (365 D1 schools, ESPN id = key) with every
// venue's codes / names as aliases, from a live capture (scripts/ncaab-teams-capture.js) + ncaab-team-overrides.json.
//
// Matching ladder for one venue name (first unique hit wins; provenance is kept in the report):
//   1. override       ncaab-team-overrides.json aliases[source][raw] (an ESPN id, or "NON_D1")
//   2. exact          normalized ESPN location / short / display / "location mascot" or a known alias
//                     (ncaab-d1.js ALIASES + overrides.names) - Saint / State / St collapse to "st"
//   3. mascot         "<school> <mascot>" where <school> is a known key of the team with that mascot
//   4. context        game sources: the OTHER side matched, the ESPN schedule has exactly one game for it within
//                     6h of the tip, the ESPN opponent is D1 and the venue name shares a word / initials with it
//   5. non-D1         the ESPN opponent at that tip is not a D1 school -> name recorded as non-D1 (never mapped)
// Codes (Kalshi game codes, Polymarket US abbreviations, Underdog abbrs) follow their team's name. A code that two
// names use (Kalshi OAK = Oakland + Oakwood) is kept as AMBIGUOUS with both readings and resolved at runtime with
// opponent + tip context (ncaab-teams.js), never dropped and never guessed.
// Usage: node scripts/gen-ncaab-teams.js [--capture=/tmp/ncaab-capture.json] [--write-fixture]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const T = require('../ncaab-teams');
const D1 = require('../ncaab-d1');

const ROOT = path.join(__dirname, '..');
const normName = T.normName;
const tokens = (s) => normName(s).split(' ').filter((w) => w.length > 1 && !['university', 'college', 'of', 'at', 'and'].includes(w));

function makeMatcher(espnTeams, overrides) {
  const byId = new Map(espnTeams.map((t) => [t.espnId, t]));
  const keys = new Map(); const mascots = new Map();
  const add = (m, k, id) => { if (!k) return; let s = m.get(k); if (!s) { s = new Set(); m.set(k, s); } s.add(id); };
  for (const t of espnTeams) {
    for (const v of [t.location, t.short, t.display, `${t.location} ${t.mascot}`]) add(keys, normName(v), t.espnId);
    add(mascots, normName(t.mascot), t.espnId);
  }
  // ncaab-d1.js ALIASES (alias -> ESPN location) and overrides.names (alias -> espnId), both global
  for (const [k, v] of Object.entries(D1.ALIASES)) { const s = keys.get(normName(v)); if (s && s.size === 1) add(keys, normName(k), [...s][0]); }
  for (const [k, id] of Object.entries(overrides.names || {})) if (byId.has(String(id))) { keys.set(normName(k), new Set([String(id)])); }
  const ov = (source, raw) => {
    const o = overrides.aliases || {};
    for (const s of [source, '*']) { const m = o[s] || {}; if (Object.prototype.hasOwnProperty.call(m, raw)) return String(m[raw]); }
    return null;
  };
  function exact(raw) {
    const n = normName(raw); if (!n) return null;
    if (keys.has(n)) return keys.get(n);
    const toks = n.split(' ');
    for (let k = 1; k < toks.length; k += 1) {
      const head = toks.slice(0, toks.length - k).join(' '); const tail = toks.slice(toks.length - k).join(' ');
      if (!mascots.has(tail) || !keys.has(head)) continue;
      const both = [...keys.get(head)].filter((id) => mascots.get(tail).has(id));
      if (both.length) return new Set(both);
    }
    // "<school> <mascot-ish>": school is an exact unique key and the tail overlaps that team's mascot
    // ("Grand Canyon Antelopes" ~ Lopes, "Gardner-Webb Bulldogs" ~ Runnin' Bulldogs)
    for (let k = 1; k < toks.length && k <= 3; k += 1) {
      const head = toks.slice(0, toks.length - k).join(' '); const tail = toks.slice(toks.length - k).join(' ');
      const s = keys.get(head); if (!s || s.size !== 1) continue;
      const m = normName(byId.get([...s][0]).mascot);
      if (m && (m.endsWith(tail) || tail.endsWith(m) || tail.replace(/ /g, '').includes(m.replace(/ /g, '')))) return s;
    }
    return null;
  }
  function match(source, raw) {
    const o = ov(source, raw);
    if (o === 'NON_D1') return { id: null, how: 'override', nonD1: true };
    if (o && byId.has(o)) return { id: o, how: 'override' };
    const s = exact(raw);
    if (s && s.size === 1) return { id: [...s][0], how: 'exact' };
    if (s && s.size > 1) return { id: null, how: 'ambiguous', candidates: [...s] };
    return null;
  }
  // loose sanity check for context matches: shared word, initials, or abbreviation
  function plausible(raw, id) {
    const t = byId.get(id); if (!t) return false;
    const a = new Set(tokens(raw));
    const words = new Set([t.location, t.short, t.display, t.mascot].flatMap(tokens));
    if ([...a].some((w) => words.has(w))) return true;
    const compact = normName(raw).replace(/ /g, '');
    const initials = tokens(t.location).map((w) => w[0]).join('');
    return compact === t.abbr.toLowerCase() || (initials.length > 1 && compact.startsWith(initials));
  }
  return { match, plausible, byId };
}

function buildTeams(cap, overrides = {}, opts = {}) {
  // ---- ESPN D1 list (groups=50 + reclassifying conference members seen on the D1 scoreboard)
  const espn = new Map();
  const slim = (t) => ({ espnId: String(t.espnId), abbr: t.abbr, location: t.location, short: t.short, display: t.display, mascot: t.name, conferenceId: t.conferenceId || null });
  for (const t of cap.espn.teams) espn.set(String(t.espnId), slim(t));
  for (const t of cap.espn.scoreboardTeams || []) if (t.conferenceId && !espn.has(String(t.espnId))) espn.set(String(t.espnId), slim(t));
  for (const id of overrides.extraD1 || []) { const t = (cap.espn.scoreboardTeams || []).find((x) => String(x.espnId) === String(id)); if (t && !espn.has(String(id))) espn.set(String(id), slim(t)); }
  for (const id of overrides.notD1 || []) espn.delete(String(id));
  const espnTeams = [...espn.values()].sort((a, b) => a.location.localeCompare(b.location));
  const M = makeMatcher(espnTeams, overrides);
  const schedule = (cap.espn.games || []).map((g) => ({ ...g, ms: Date.parse(g.date) }));
  const sbTeam = new Map((cap.espn.scoreboardTeams || []).map((t) => [String(t.espnId), t]));
  const gamesOf = (id, ms) => schedule.filter((g) => (g.homeId === id || g.awayId === id) && Math.abs(g.ms - ms) <= 6 * 3600e3);

  const aliases = new Map(espnTeams.map((t) => [t.espnId, {}]));
  const putAlias = (id, source, kind, v) => {
    if (v == null || v === '') return; const a = aliases.get(id); if (!a) return;
    const s = a[source] || (a[source] = {}); const l = s[kind] || (s[kind] = []);
    if (!l.includes(String(v))) l.push(String(v));
  };
  const nonD1 = {}; const unmatched = {}; const learned = []; const ambiguousNames = {};
  const noteNonD1 = (source, raw) => { (nonD1[source] = nonD1[source] || new Set()).add(raw); };
  const noteUnmatched = (source, raw, extra) => { const u = unmatched[source] || (unmatched[source] = new Map()); if (!u.has(raw)) u.set(raw, { name: raw, ...extra }); };
  const memo = new Map();
  const matchName = (source, raw) => { const k = `${source}|${raw}`; if (!memo.has(k)) memo.set(k, M.match(source, raw)); return memo.get(k); };

  // Game-level matching with schedule context. sides = [{ raw, code? }, { raw, code? }], ms = tip.
  function matchGame(source, sides, ms) {
    const r = sides.map((s) => (s.raw ? matchName(source, s.raw) : null));
    for (let i = 0; i < 2; i += 1) {
      const j = 1 - i;
      if (r[i] && r[i].id) continue;
      if (r[i] && r[i].nonD1) continue;
      if (!(r[j] && r[j].id) || !Number.isFinite(ms)) continue;
      const g = gamesOf(r[j].id, ms);
      if (g.length !== 1) continue;
      const oppId = g[0].homeId === r[j].id ? g[0].awayId : g[0].homeId;
      if (r[i] && r[i].how === 'ambiguous' && r[i].candidates.includes(oppId)) { r[i] = { id: oppId, how: 'context' }; (ambiguousNames[source] = ambiguousNames[source] || {})[sides[i].raw] = r[i].candidates; continue; }
      if (!espn.has(oppId)) {
        const opp = sbTeam.get(oppId);
        r[i] = { id: null, nonD1: true, how: 'schedule_non_d1', espnOpp: opp ? opp.display : oppId };
        noteNonD1(source, sides[i].raw);
        continue;
      }
      if (M.plausible(sides[i].raw, oppId)) {
        r[i] = { id: oppId, how: 'context' };
        learned.push({ source, name: sides[i].raw, espnId: oppId, espn: espn.get(oppId).display, via: `${espn.get(r[j].id).display} @ ${new Date(ms).toISOString()}` });
        memo.set(`${source}|${sides[i].raw}`, r[i]);
      } else {
        noteUnmatched(source, sides[i].raw, { suggestion: espn.get(oppId).display, suggestionId: oppId, why: 'context_name_not_plausible' });
      }
    }
    return r;
  }

  const cov = {};
  const mismatches = {};
  const covGame = (source, r, ms, label) => {
    const c = cov[source] || (cov[source] = { kind: 'games', total: 0, matched: 0, nonD1: 0, unmatched: 0, scheduleConfirmed: 0, scheduleMissing: 0 });
    c.total += 1;
    if (r.every((x) => x && x.id)) {
      c.matched += 1;
      // correctness check: ESPN lists this exact pairing within 30h of the venue's tip
      const ok = Number.isFinite(ms) && schedule.some((g) => Math.abs(g.ms - ms) <= 30 * 3600e3 && ((g.homeId === r[0].id && g.awayId === r[1].id) || (g.homeId === r[1].id && g.awayId === r[0].id)));
      if (ok) c.scheduleConfirmed += 1; else { c.scheduleMissing += 1; (mismatches[source] = mismatches[source] || []).push({ game: label || null, espnIds: r.map((x) => x.id), names: r.map((x) => (espn.get(x.id) || {}).display) }); }
    } else if (r.some((x) => x && x.nonD1)) c.nonD1 += 1; else c.unmatched += 1;
  };
  const covName = (source, ok, isNonD1) => {
    const c = cov[source] || (cov[source] = { kind: 'names', total: 0, matched: 0, nonD1: 0, unmatched: 0 });
    c.total += 1; if (ok) c.matched += 1; else if (isNonD1) c.nonD1 += 1; else c.unmatched += 1;
  };
  const finishSide = (source, s, x, kinds) => {
    if (x && x.id) { putAlias(x.id, source, 'names', s.raw); for (const [k, v] of Object.entries(kinds || {})) putAlias(x.id, source, k, v); } else if (x && x.nonD1) noteNonD1(source, s.raw); else if (s.raw && !(x && x.how === 'ambiguous')) noteUnmatched(source, s.raw, { why: 'no_match' });
  };

  // ---- Kalshi games (code + name per market)
  const kalshiCodeNames = new Map(); const kalshiGames = {};
  const kEvents = [...(cap.kalshi.KXNCAAMBGAME || [])];
  for (const e of kEvents) {
    const m = /^KXNCAAMBGAME-(\d\d[A-Z]{3}\d\d)([A-Z0-9]+)$/.exec(e.event_ticker || '');
    const mk = (e.markets || []).map((x) => ({ code: String(x.ticker).split('-').pop(), raw: x.yes_sub_title, teamId: x.teamId || null }));
    if (!m || mk.length !== 2) { covGame('kalshi', [null, null]); continue; }
    const date = T.kalshiDate(m[1]);
    // tip: ESPN game on that ET date for either side
    const occ = Date.parse((e.markets[0] || {}).occ || '') - 3 * 3600e3;
    let ms = Number.isFinite(occ) ? occ : Date.parse(`${date}T23:00:00Z`);
    const pre = mk.map((s) => matchName('kalshi', s.raw));
    const anchor = pre.find((x) => x && x.id);
    if (anchor) { const g = schedule.filter((x) => (x.homeId === anchor.id || x.awayId === anchor.id) && Math.abs(x.ms - ms) <= 20 * 3600e3); if (g.length === 1) ms = g[0].ms; }
    const r = matchGame('kalshi', mk, ms);
    covGame('kalshi', r, ms, e.event_ticker);
    mk.forEach((s, i) => { finishSide('kalshi', s, r[i], { codes: s.code, teamIds: s.teamId }); (kalshiCodeNames.get(s.code) || kalshiCodeNames.set(s.code, new Map()).get(s.code)).set(s.raw, r[i]); });
    kalshiGames[`${m[1]}${m[2]}`] = r.every((x) => x && x.id) ? { codes: [mk[0].code, mk[1].code].sort((a, b) => m[2].indexOf(a) - m[2].indexOf(b)), espnIds: null } : { codes: null, nonD1: r.some((x) => x && x.nonD1) };
    if (kalshiGames[`${m[1]}${m[2]}`].codes) { const cs = kalshiGames[`${m[1]}${m[2]}`].codes; kalshiGames[`${m[1]}${m[2]}`].espnIds = cs.map((c) => r[mk.findIndex((s) => s.code === c)].id); }
  }
  // last season's settled KXNCAAMBGAME events: Kalshi codes for teams with no open game yet (exact names only)
  const histCodeNames = new Map(); const histTeamIds = new Map();
  for (const e of cap.kalshi.KXNCAAMBGAME_settled || []) for (const x of e.markets || []) {
    const code = String(x.ticker).split('-').pop(); const raw = x.yes_sub_title;
    if (!/^[A-Z0-9]+$/.test(code) || !raw) continue;
    (histCodeNames.get(code) || histCodeNames.set(code, new Map()).get(code)).set(raw, matchName('kalshi', raw));
    if (x.teamId) histTeamIds.set(`${code}|${raw}`, x.teamId);
  }
  const liveCodes = new Set(kalshiCodeNames.keys());
  for (const [code, names] of histCodeNames) {
    if (liveCodes.has(code)) continue; // the open games already define this code
    const ids = [...new Set([...names.values()].filter((x) => x && x.id).map((x) => x.id))];
    if (!ids.length) continue;
    kalshiCodeNames.set(code, names); // several names -> ambiguous below
    for (const [raw, x] of names) if (x && x.id) { putAlias(x.id, 'kalshi', 'codes', code); putAlias(x.id, 'kalshi', 'names', raw); putAlias(x.id, 'kalshi', 'teamIds', histTeamIds.get(`${code}|${raw}`)); }
  }
  // spread / total events: names from the title "A vs B: ..."
  for (const s of ['KXNCAAMBSPREAD', 'KXNCAAMBTOTAL']) for (const e of cap.kalshi[s] || []) {
    const t = /^(.+?) vs (.+?):/.exec(e.title || ''); if (!t) continue;
    for (const raw of [t[1], t[2]]) { const x = matchName('kalshi', raw); if (x && x.id) putAlias(x.id, 'kalshi', 'names', raw); }
  }
  // ambiguous Kalshi codes: one code, several names (only D1 names map; non-D1 names recorded)
  const ambiguous = {};
  for (const [code, names] of kalshiCodeNames) {
    if (names.size < 2) continue;
    const ids = [...new Set([...names.values()].filter((x) => x && x.id).map((x) => x.id))];
    const non = [...names.entries()].filter(([, x]) => !(x && x.id)).map(([n]) => n);
    (ambiguous.kalshi = ambiguous.kalshi || {})[code] = { d1: ids, nonD1: non };
    // the code alone may NOT identify the D1 team: drop it from the plain code alias list (runtime uses context)
    for (const id of ids) { const a = aliases.get(id).kalshi; if (a && a.codes) a.codes = a.codes.filter((c) => c !== code); }
  }
  // Kalshi KXMARMAD (national champion): names + futures codes
  for (const e of cap.kalshi.KXMARMAD || []) for (const x of e.markets || []) {
    const raw = x.yes_sub_title; const code = String(x.ticker).split('-').pop();
    const r = matchName('kalshi', raw) || matchName('kalshiFutures', raw);
    covName('kalshiFutures', r && r.id, r && r.nonD1);
    finishSide('kalshiFutures', { raw }, r, { codes: code });
  }

  // ---- Polymarket US games (abbreviation + name) and the cbb-champ futures
  for (const g of cap.polymarket.games || []) {
    const sides = (g.sides || []).map((s) => ({ raw: s.safeName || s.name, code: s.abbreviation, alt: s.name, teamId: s.teamId }));
    if (sides.length !== 2) { covGame('polymarket', [null, null]); continue; }
    const r = matchGame('polymarket', sides, Date.parse(g.startTime));
    covGame('polymarket', r, Date.parse(g.startTime), g.slug);
    sides.forEach((s, i) => { finishSide('polymarket', s, r[i], { codes: s.code, teamIds: s.teamId }); if (r[i] && r[i].id && s.alt && s.alt !== s.raw) putAlias(r[i].id, 'polymarket', 'names', s.alt); });
  }
  for (const m of Array.isArray(cap.polymarket.champ) ? cap.polymarket.champ : []) {
    const raw = m.safeName || m.name;
    const r = matchName('polymarketFutures', raw) || matchName('polymarket', raw);
    covName('polymarketFutures', r && r.id, r && r.nonD1);
    finishSide('polymarketFutures', { raw }, r, { slugs: m.slug, codes: m.abbreviation, teamIds: m.teamId });
  }

  // ---- Novig ("Away @ Home"), ProphetX (relay quotes), Underdog, Odds API
  for (const e of Array.isArray(cap.novig) ? cap.novig : []) {
    const p = String(e.description || '').split(/\s+@\s+/); if (p.length !== 2) { covGame('novig', [null, null]); continue; }
    const sides = [{ raw: p[0] }, { raw: p[1] }];
    const r = matchGame('novig', sides, Number(e.startsTs)); covGame('novig', r, Number(e.startsTs), e.description); sides.forEach((s, i) => finishSide('novig', s, r[i]));
  }
  const px = (cap.prophetx && cap.prophetx.quotes) || [];
  const pxGames = new Map(); for (const q of px) pxGames.set(`${q.away}|${q.home}|${q.start}`, q);
  for (const q of pxGames.values()) { const sides = [{ raw: q.away }, { raw: q.home }]; const r = matchGame('prophetx', sides, Date.parse(q.start)); covGame('prophetx', r, Date.parse(q.start), `${q.away} @ ${q.home}`); sides.forEach((s, i) => finishSide('prophetx', s, r[i])); }
  if (!pxGames.size) cov.prophetx = { kind: 'games', total: 0, matched: 0, nonD1: 0, unmatched: 0, note: (cap.prophetx && (cap.prophetx.note || cap.prophetx.error)) || 'no NCAAB events on ProphetX via the relay' };
  const udTeams = new Map(((cap.underdog && cap.underdog.teams) || []).map((t) => [t.id, t]));
  for (const g of (cap.underdog && cap.underdog.games) || []) {
    const ts = [udTeams.get(g.away_team_id), udTeams.get(g.home_team_id)];
    const full = String(g.full || '').split(/\s+@\s+/);
    const sides = ts.map((t, i) => ({ raw: full[i] || (t && `${t.locality} ${t.name}`.trim()), code: t && t.abbr, alt: t && t.locality, id: t && t.id }));
    const r = matchGame('underdog', sides, Date.parse(g.scheduled_at)); covGame('underdog', r, Date.parse(g.scheduled_at), g.full);
    sides.forEach((s, i) => { finishSide('underdog', s, r[i], { codes: s.code, ids: s.id }); if (r[i] && r[i].id && s.alt) putAlias(r[i].id, 'underdog', 'names', s.alt); });
  }
  const oa = cap.oddsapi || {};
  for (const e of Array.isArray(oa.events) ? oa.events : []) {
    const sides = [{ raw: e.away }, { raw: e.home }];
    const r = matchGame('oddsapi', sides, Date.parse(e.commence)); covGame('oddsapi', r, Date.parse(e.commence), `${e.away} @ ${e.home}`); sides.forEach((s, i) => finishSide('oddsapi', s, r[i]));
  }
  for (const raw of Array.isArray(oa.participants) ? oa.participants : []) {
    const r = matchName('oddsapi', raw);
    covName('oddsapiParticipants', r && r.id, r && r.nonD1);
    if (r && r.id) putAlias(r.id, 'oddsapi', 'names', raw); else if (!(r && r.nonD1)) noteUnmatched('oddsapiParticipants', raw, { why: r && r.how === 'ambiguous' ? 'ambiguous' : 'no_match_maybe_non_d1' });
  }
  if (oa.futures && !oa.futures.error) for (const [book, names] of Object.entries(oa.futures)) for (const raw of names) {
    const r = matchName('books', raw);
    covName(`books:${book}`, r && r.id, r && r.nonD1);
    if (r && r.id) putAlias(r.id, 'books', 'names', raw); else if (!(r && r.nonD1)) noteUnmatched(`books:${book}`, raw, { why: 'no_match' });
  }

  // ---- override NON_D1 names (every source) so the runtime resolver reports them as non-D1, not unknown
  for (const [src, m] of Object.entries(overrides.aliases || {})) for (const [k, v] of Object.entries(m)) if (v === 'NON_D1') noteNonD1(src, k);

  // ---- manual / legacy aliases (overrides.names + ncaab-d1.js ALIASES) so the runtime resolver knows them too
  for (const [k, id] of Object.entries(overrides.names || {})) if (aliases.has(String(id))) putAlias(String(id), 'manual', 'names', k);
  for (const k of Object.keys(D1.ALIASES)) { const x = M.match('manual', k); if (x && x.id) putAlias(x.id, 'manual', 'names', k); }

  // ---- collisions: a code a source gives two different teams = ambiguous (kept, resolved with context)
  for (const source of ['polymarket', 'underdog', 'kalshiFutures', 'polymarketFutures']) {
    const owner = new Map();
    for (const [id, a] of aliases) for (const c of (a[source] && a[source].codes) || []) (owner.get(c) || owner.set(c, []).get(c)).push(id);
    for (const [c, ids] of owner) if (ids.length > 1) {
      (ambiguous[source] = ambiguous[source] || {})[c] = { d1: ids, nonD1: [] };
      for (const id of ids) aliases.get(id)[source].codes = aliases.get(id)[source].codes.filter((x) => x !== c);
    }
  }
  for (const [s, m] of Object.entries(ambiguousNames)) for (const [n, ids] of Object.entries(m)) (ambiguous[s] = ambiguous[s] || {})[n] = { d1: ids, nonD1: [] };

  const teams = espnTeams.map((t) => {
    const a = aliases.get(t.espnId);
    for (const s of Object.values(a)) for (const k of Object.keys(s)) s[k].sort();
    return { ...t, aliases: Object.fromEntries(Object.entries(a).sort(([x], [y]) => x.localeCompare(y))) };
  });
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const body = {
    teams,
    ambiguous: sortObj(Object.fromEntries(Object.entries(ambiguous).map(([k, v]) => [k, sortObj(v)]))),
    nonD1: sortObj(Object.fromEntries(Object.entries(nonD1).map(([k, v]) => [k, [...v].sort()]))),
    kalshiGames: sortObj(kalshiGames),
  };
  const contentHash = crypto.createHash('sha256').update(JSON.stringify(body.teams) + JSON.stringify(body.ambiguous)).digest('hex').slice(0, 16);
  const table = {
    note: 'Canonical NCAAB (men\'s college basketball) D1 team table: ESPN team id = identity; every venue code/name is an alias. Generated by combo-worker scripts/gen-ncaab-teams.js from live data + ncaab-team-overrides.json. Shared with aibetbuilder (lib/ncaab-teams.json); do not edit by hand.',
    version: 1, generatedAt: opts.generatedAt || cap.capturedAt || null, contentHash, teamCount: teams.length, ...body,
  };
  for (const c of Object.values(cov)) { const denom = c.total - c.nonD1; c.coveragePct = denom > 0 ? Math.round((1000 * c.matched) / denom) / 10 : null; }
  const report = {
    capturedAt: cap.capturedAt || null, teamCount: teams.length, coverage: sortObj(cov),
    unmatched: sortObj(Object.fromEntries(Object.entries(unmatched).map(([k, v]) => [k, [...v.values()]]))),
    scheduleMissing: mismatches,
    learnedFromContext: learned, ambiguous: table.ambiguous,
    teamsWithoutAlias: sortObj(Object.fromEntries(['kalshi', 'polymarket', 'underdog', 'oddsapi'].map((s) => [s, teams.filter((t) => !t.aliases[s]).length]))),
  };
  return { table, report };
}

// Smaller committed fixture: one settled Kalshi market per (code, name), no spread/total markets.
function slimCapture(cap) {
  const c = JSON.parse(JSON.stringify(cap)); const seen = new Map();
  for (const e of c.kalshi.KXNCAAMBGAME_settled || []) for (const m of e.markets || []) {
    const k = `${String(m.ticker).split('-').pop()}|${m.yes_sub_title}`;
    if (!seen.has(k)) seen.set(k, { event_ticker: e.event_ticker, markets: [m] });
  }
  if (c.kalshi.KXNCAAMBGAME_settled) c.kalshi.KXNCAAMBGAME_settled = [...seen.values()];
  for (const s of ['KXNCAAMBSPREAD', 'KXNCAAMBTOTAL']) c.kalshi[s] = (c.kalshi[s] || []).map((e) => ({ event_ticker: e.event_ticker, title: e.title, markets: [] }));
  for (const e of c.kalshi.KXNCAAMBGAME || []) for (const m of e.markets || []) delete m.no_sub_title;
  return c;
}

module.exports = { buildTeams, makeMatcher, slimCapture };

if (require.main === module) {
  (async () => {
    const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
    let cap;
    if (arg('capture')) cap = JSON.parse(fs.readFileSync(arg('capture'), 'utf8'));
    else cap = await require('./ncaab-teams-capture').captureAll({ log: (m) => console.error(m) });
    const overrides = JSON.parse(fs.readFileSync(path.join(ROOT, 'ncaab-team-overrides.json'), 'utf8'));
    const { table, report } = buildTeams(cap, overrides);
    fs.writeFileSync(path.join(ROOT, 'ncaab-teams.json'), `${JSON.stringify(table, null, 1)}\n`);
    fs.writeFileSync(path.join(ROOT, 'ncaab-teams-report.json'), `${JSON.stringify(report, null, 1)}\n`);
    if (process.argv.includes('--write-fixture')) fs.writeFileSync(path.join(ROOT, 'fixtures-ncaab-teams-capture.json'), `${JSON.stringify(slimCapture(cap))}\n`);
    console.log(`teams=${table.teamCount} hash=${table.contentHash}`);
    for (const [s, c] of Object.entries(report.coverage)) console.log(`${s.padEnd(22)} ${String(c.coveragePct).padStart(5)}%  matched=${c.matched} total=${c.total} nonD1=${c.nonD1} unmatched=${c.unmatched}${c.note ? ` (${c.note})` : ''}`);
    for (const [s, l] of Object.entries(report.unmatched)) console.log(`UNMATCHED ${s}: ${l.map((x) => x.name + (x.suggestion ? ` (~${x.suggestion})` : '')).join('; ')}`);
  })().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
