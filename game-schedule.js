// Canonical game schedule (Kevin, Oct 27 2026: "fix start times permanently").
// One place that answers "when does this Kalshi game start?" for the sniper, Combo Locks, the needle and Promo.
//   * Official source: ESPN public scoreboard (NFL, NCAAF FBS+FCS, NBA, WNBA, NHL, MLB, MLS, EPL, NCAAB).
//   * Cross-checks: Kalshi occurrence/expected_expiration (−3h), Polymarket / Novig / Underdog / odds_cache times.
//     A venue time more than 15 min off the official time is flagged (disagreement), never silently used.
//   * Resolver order: canonical (ESPN, verified) → venue time (unverified) → lock starts_at → ticker date only.
//     Anything below "canonical" is returned with verified:false so callers can warn instead of dropping the leg.
// Pure parsing + matching here; network only in fetchEspnDay (injectable fetch).
'use strict';

const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const DISAGREE_MS = 15 * 60000;

// Kalshi series prefix → league. Any KX<LEAGUE>(GAME|SPREAD|TOTAL|TD|…) event maps by its league stem.
const LEAGUES = {
  NFL: { espn: 'football/nfl' },
  NCAAF: { espn: 'football/college-football', groups: ['80', '81'], dateShift: [0, 1] }, // ML tickers often dated a day early
  NBA: { espn: 'basketball/nba', dateShift: [0, 1] },
  WNBA: { espn: 'basketball/wnba' },
  NHL: { espn: 'hockey/nhl', dateShift: [0, 1] },
  MLB: { espn: 'baseball/mlb', dateShift: [0, 1] },
  MLS: { espn: 'soccer/usa.1' },
  EPL: { espn: 'soccer/eng.1' },
  NCAAMB: { espn: 'basketball/mens-college-basketball', groups: ['50'], dateShift: [0, 1] },
  NCAAB: { espn: 'basketball/mens-college-basketball', groups: ['50'], dateShift: [0, 1] },
};
// Equivalent team codes (Kalshi and ESPN spell some differently). Every code in a group means the same team.
const SAME = {
  NBA: [['NY', 'NYK'], ['SA', 'SAS'], ['GS', 'GSW'], ['NO', 'NOP'], ['UTAH', 'UTA'], ['WSH', 'WAS'], ['BKN', 'BRK']],
  WNBA: [['NY', 'NYL'], ['LV', 'LVA'], ['WSH', 'WAS'], ['GS', 'GSV']],
  NHL: [['NJ', 'NJD'], ['LA', 'LAK'], ['SJ', 'SJS'], ['TB', 'TBL'], ['UTAH', 'UTA'], ['MON', 'MTL']],
  MLB: [['CHW', 'CWS'], ['AZ', 'ARI'], ['ATH', 'OAK'], ['WSH', 'WAS'], ['KC', 'KCR'], ['SD', 'SDP'], ['SF', 'SFG'], ['TB', 'TBR']],
  NFL: [['WSH', 'WAS'], ['JAX', 'JAC'], ['LA', 'LAR']],
  EPL: [['LIV', 'LFC'], ['MNC', 'MCI'], ['BHA', 'BRI'], ['NFO', 'NOT'], ['WHU', 'WHM']],
  MLS: [],
};
const ALIAS = {};
for (const [lg, groups] of Object.entries(SAME)) { ALIAS[lg] = {}; for (const g of groups) for (const c of g) ALIAS[lg][c] = g[0]; }
const canon = (lg, c) => { const u = String(c || '').toUpperCase(); return (ALIAS[lg] && ALIAS[lg][u]) || u; };

/** "KXNBAGAME-26OCT27BKNBOS-BOS" → { league, event, date:'2026-10-27', teams:'BKNBOS' } | null */
function parseEvent(ticker) {
  const parts = String(ticker || '').toUpperCase().split(':')[0].split('-');
  if (parts.length < 2) return null;
  const sm = /^KX([A-Z]+?)(GAME|SPREAD|TOTAL|TD|TEAMTOTAL|1H|2H|BTTS|ANYTD|PLAYER\w*)?$/.exec(parts[0]);
  if (!sm) return null;
  const league = Object.keys(LEAGUES).find((l) => sm[1] === l || sm[1].startsWith(l));
  const m = /^(\d\d)([A-Z]{3})(\d\d)(\d{4})?([A-Z0-9]+)$/.exec(parts[1]);
  if (!league || !m || !MON[m[2]]) return null;
  const date = `20${m[1]}-${MON[m[2]]}-${m[3]}`;
  return { league, event: `${parts[0]}-${parts[1]}`, gameKey: `${league}|${parts[1]}`, date, hhmm: m[4] || null, teams: m[5] };
}

function addDays(date, n) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const norm = (s) => String(s || '').toUpperCase().replace(/&/g, 'AND').replace(/[^A-Z0-9]/g, '');

let NCAAF_XW = null;
function ncaafNames() {
  if (NCAAF_XW) return NCAAF_XW;
  NCAAF_XW = {};
  try { const j = require('./ncaaf-crosswalk.json'); for (const [k, v] of Object.entries(j.teams || {})) NCAAF_XW[k] = [v.name, v.pname].filter(Boolean).map(norm); } catch (_) { /* optional */ }
  return NCAAF_XW;
}

/** Does Kalshi code `code` name ESPN team `t` ({abbr, location, name, display, short})? */
function codeMatches(league, code, t) { return sideMatches(league, code, sideKeys(league, t)); }

// Precomputed per-side match keys (canonical abbr + normalized names for college). Built once per game object.
const NCAA = new Set(['NCAAF', 'NCAAMB', 'NCAAB']);
function sideKeys(league, t) {
  const abbr = canon(league, String((t && t.abbr) || ''));
  const names = NCAA.has(league) ? new Set([t.location, t.display, t.short, t.name].map(norm).filter(Boolean)) : null;
  return { abbr, names };
}
function sideMatches(league, code, k) {
  const c = String(code).toUpperCase();
  if (canon(league, c) === k.abbr) return true;
  if (k.names) { const names = ncaafNames()[c]; if (names) for (const n of names) if (k.names.has(n)) return true; }
  return false;
}

/** Parse one ESPN scoreboard JSON → schedule rows (no Kalshi keys yet). */
function espnRows(league, j) {
  const out = [];
  for (const e of (j && j.events) || []) {
    const comp = (e.competitions || [])[0] || {};
    const cs = comp.competitors || [];
    const side = (h) => { const x = cs.find((c) => c.homeAway === h); if (!x || !x.team) return null; const t = x.team; return { abbr: t.abbreviation, location: t.location, name: t.name, display: t.displayName, short: t.shortDisplayName }; };
    const home = side('home'), away = side('away');
    const iso = comp.date || e.date; const ms = Date.parse(iso || '');
    if (!home || !away || !Number.isFinite(ms)) continue;
    const st = (e.status && e.status.type) || {};
    // ESPN marks TBD kickoffs with timeValid:false — treat as date-only, not verified.
    const timeValid = comp.timeValid !== false && !/TBD/i.test(st.shortDetail || '');
    out.push({ league, espn_id: String(e.id), home, away, start_ms: ms, time_valid: timeValid, state: st.state || null, status: st.name || null });
  }
  return out;
}

async function fetchEspnDay(league, ymd, fetchFn = globalThis.fetch) {
  const L = LEAGUES[league]; if (!L) return [];
  const groups = L.groups || [null]; const rows = [];
  for (const g of groups) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${L.espn}/scoreboard?dates=${ymd.replace(/-/g, '')}&limit=400${g ? `&groups=${g}` : ''}`;
    const r = await fetchFn(url, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`ESPN ${league} ${ymd} HTTP ${r.status}`);
    rows.push(...espnRows(league, await r.json()));
  }
  return rows;
}

// One formatter for the process: building an Intl.DateTimeFormat per call cost ~20 µs and was done ~650× per leg
// in #298 (14 ms per sniper leg → event-loop stall + OOM on kaygo-sniper, Oct 27 2026).
const ET_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const etDate = (ms) => ET_FMT.format(new Date(ms));

/** Small LRU (Map insertion order). */
function makeLru(cap) {
  const m = new Map();
  return {
    get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; },
    has: (k) => m.has(k),
    set(k, v) { if (m.has(k)) m.delete(k); m.set(k, v); if (m.size > cap) m.delete(m.keys().next().value); },
    get size() { return m.size; },
  };
}
const MATCH_CACHE_MAX = 5000;

// Index of a games array: games by league|ET date with precomputed side keys, plus a per-event match memo (LRU).
// Keyed by the array itself (WeakMap), so a schedule refresh (new array) drops the old index and memo automatically.
// Rebuilt if the array length changes (callers that push into an array they already resolved against).
const INDEX = new WeakMap();
function indexGames(games) {
  const arr = games || [];
  let idx = INDEX.get(arr);
  if (idx && idx.n === arr.length) return idx;
  const byDay = new Map();
  for (const g of arr) {
    if (!g || !LEAGUES[g.league] || !Number.isFinite(g.start_ms)) continue;
    const e = { g, day: etDate(g.start_ms), home: sideKeys(g.league, g.home || {}), away: sideKeys(g.league, g.away || {}) };
    const k = `${g.league}|${e.day}`; const list = byDay.get(k); if (list) list.push(e); else byDay.set(k, [e]);
  }
  idx = { n: arr.length, byDay, memo: makeLru(MATCH_CACHE_MAX) };
  if (arr.length) INDEX.set(arr, idx); // (a fresh [] literal per call is never cached)
  return idx;
}

/** Match a Kalshi event to exactly one ESPN game (away+home codes, either order, on ticker date or allowed shift).
 *  Uses the games index (only that league's games on the allowed dates) and memoizes per event. */
function matchEvent(ev, games) {
  const p = typeof ev === 'string' ? parseEvent(ev) : ev; if (!p) return null;
  const idx = indexGames(games);
  const key = `${p.league}|${p.event}`;
  if (idx.memo.has(key)) return idx.memo.get(key);
  const res = matchUncached(p, idx);
  if (idx.n) idx.memo.set(key, res);
  return res;
}
function matchUncached(p, idx) {
  const shifts = LEAGUES[p.league].dateShift || [0];
  const hits = [];
  for (const s of shifts) {
    const list = idx.byDay.get(`${p.league}|${addDays(p.date, s)}`); if (!list) continue;
    for (const e of list) {
      for (let i = 1; i < p.teams.length; i += 1) {
        const a = p.teams.slice(0, i), b = p.teams.slice(i);
        if ((sideMatches(p.league, a, e.away) && sideMatches(p.league, b, e.home)) || (sideMatches(p.league, a, e.home) && sideMatches(p.league, b, e.away))) { hits.push(e); break; }
      }
    }
  }
  // Prefer an exact-date hit when the shifted day has a different meeting of the same teams.
  const exact = hits.filter((e) => e.day === p.date);
  const pick = hits.length === 1 ? hits[0].g : (exact.length === 1 ? exact[0].g : null);
  return pick ? { ...pick, ambiguous: false } : (hits.length > 1 ? { ambiguous: true, candidates: hits.length } : null);
}

/** Kalshi occurrence / expected_expiration → estimated start (−3h; −5h for UFC). Date-only placeholders return null. */
function kalshiStartGuess(t, league) {
  if (!t || /T0[34]:00:00(\.000)?Z$/.test(String(t))) return null;
  const ms = Date.parse(t); if (!Number.isFinite(ms)) return null;
  return ms - (league === 'UFC' ? 5 : 3) * 3600000;
}

/** game_schedule DB row ⇄ in-memory game used by matchEvent. */
function gameToRow(g, now = Date.now(), prev = null) {
  const iso = new Date(g.start_ms).toISOString();
  return {
    league: g.league, espn_id: g.espn_id, sport: LEAGUES[g.league].espn.split('/')[0], start_time_utc: iso, time_valid: g.time_valid !== false,
    et_date: etDate(g.start_ms), home_abbr: String(g.home.abbr || ''), away_abbr: String(g.away.abbr || ''), home_name: g.home.display || null, away_name: g.away.display || null,
    home_location: g.home.location || null, away_location: g.away.location || null, state: g.state || null, status: g.status || null,
    sources: g.sources || ['espn'], confidence: g.time_valid === false ? 'date_only' : (g.disagreement_min > DISAGREE_MS / 60000 ? 'official_disputed' : 'official'),
    disagreement_min: g.disagreement_min == null ? null : g.disagreement_min,
    previous_start_utc: prev && prev.start_time_utc && Date.parse(prev.start_time_utc) !== g.start_ms ? prev.start_time_utc : (prev ? prev.previous_start_utc || null : null),
    last_verified: new Date(now).toISOString(),
  };
}
function rowToGame(r) {
  return {
    league: r.league, espn_id: r.espn_id, start_ms: Date.parse(r.start_time_utc), time_valid: r.time_valid !== false, state: r.state, status: r.status, confidence: r.confidence,
    disagreement_min: r.disagreement_min, last_verified: r.last_verified,
    home: { abbr: r.home_abbr, display: r.home_name, location: r.home_location }, away: { abbr: r.away_abbr, display: r.away_name, location: r.away_location },
  };
}

/**
 * Shared resolver. games: in-memory games (rowToGame of game_schedule rows, or fresh ESPN games).
 * extras: { venue: {event: iso}, lockStart: iso|null }.
 * Order: canonical official time → venue time → lock/leg starts_at → ticker date. Never returns "nothing" for a parseable
 * ticker: callers always get a day to count the leg on, and verified:false + warn tells them to alert instead of drop.
 * → { startMs, iso, verified, source, confidence, state, warn }
 */
function resolveStart(ticker, games, extras = {}) {
  const p = parseEvent(ticker);
  const ev = p ? p.event : String(ticker || '').toUpperCase().split('-').slice(0, 2).join('-');
  const g = p ? matchEvent(p, games || []) : null;
  if (g && !g.ambiguous && g.time_valid !== false && Number.isFinite(g.start_ms)) {
    const off = g.disagreement_min > DISAGREE_MS / 60000;
    return { startMs: g.start_ms, iso: new Date(g.start_ms).toISOString(), verified: true, source: 'canonical', confidence: g.confidence || 'official', state: g.state || null, status: g.status || null, warn: off ? `venue time off by ${g.disagreement_min} min for ${ev}` : null };
  }
  const v = extras.venue && extras.venue[ev];
  if (v && Number.isFinite(Date.parse(v))) return { startMs: Date.parse(v), iso: new Date(Date.parse(v)).toISOString(), verified: false, source: 'venue', confidence: 'venue', state: null, warn: `no official time for ${ev}; using venue time` };
  if (extras.lockStart && Number.isFinite(Date.parse(extras.lockStart))) return { startMs: Date.parse(extras.lockStart), iso: new Date(Date.parse(extras.lockStart)).toISOString(), verified: false, source: 'lock', confidence: 'lock', state: null, warn: `no official time for ${ev}; using lock start` };
  if (p) {
    // Ticker date only (date-only placeholder): noon ET of the latest allowed day, so the leg is still counted on its day.
    const ms = Date.parse(`${p.date}T16:00:00Z`);
    return { startMs: ms, iso: null, date: p.date, verified: false, source: 'ticker_date', confidence: 'date_only', state: null, warn: `no start time for ${ev}${g && g.ambiguous ? ' (ambiguous match)' : ''}; date from ticker only` };
  }
  return { startMs: null, iso: null, verified: false, source: 'none', confidence: 'none', state: null, warn: `no start time at all for ${ticker}` };
}

/** Build game_schedule rows for a set of Kalshi events from ESPN games + cross-check times. */
function buildRows(events, games, checks = {}, now = Date.now()) {
  const rows = []; const misses = [];
  for (const e of events) {
    const p = parseEvent(e); if (!p) { misses.push({ event: e, why: 'unparsed' }); continue; }
    const g = matchEvent(p, games);
    if (!g || g.ambiguous) { misses.push({ event: p.event, why: g ? 'ambiguous' : 'no_official_match' }); continue; }
    const sources = ['espn']; let worst = 0;
    for (const [src, iso] of Object.entries(checks[p.event] || {})) {
      const ms = src === 'kalshi' ? kalshiStartGuess(iso, p.league) : Date.parse(iso);
      if (!Number.isFinite(ms)) continue; sources.push(src);
      worst = Math.max(worst, Math.abs(ms - g.start_ms));
    }
    rows.push({
      game_key: p.gameKey, kalshi_event: p.event, league: p.league, sport: LEAGUES[p.league].espn.split('/')[0],
      home_code: norm(g.home.abbr), away_code: norm(g.away.abbr), home_name: g.home.display || null, away_name: g.away.display || null,
      start_time_utc: new Date(g.start_ms).toISOString(), time_valid: g.time_valid, state: g.state, status: g.status, espn_id: g.espn_id,
      sources, confidence: g.time_valid ? (worst > DISAGREE_MS ? 'official_disputed' : 'official') : 'date_only',
      disagreement: worst > DISAGREE_MS, disagreement_min: Math.round(worst / 60000), last_verified: new Date(now).toISOString(),
    });
  }
  return { rows, misses };
}

module.exports = { indexGames, makeLru, MATCH_CACHE_MAX, gameToRow, rowToGame, parseEvent, espnRows, fetchEspnDay, matchEvent, resolveStart, buildRows, kalshiStartGuess, codeMatches, LEAGUES, ALIAS, DISAGREE_MS, etDate, addDays };
