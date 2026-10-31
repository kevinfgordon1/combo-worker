// Real kickoff times for the sniper (rule 9). Priority per game:
//   0. Canonical game schedule (game-schedule.js / public.game_schedule: official ESPN time, all leagues) when wired
//   1. ESPN scoreboard (date + live state pre/in/post; 'in'/'post' => started regardless of clock)
//   2. odds_cache commence_time (Supabase, Odds-API shape)
//   3. LAST RESORT: Kalshi occurrence_datetime − 3h (logged once per game when used)
// Same parsers/gameIds as the no-boost book (noboost/kickoffs.js).
'use strict';
const { parseKalshiUnhedgedTicker } = require('../unhedged-rfq');
const { parseTdTicker } = require('../noboost/td-book');
const { isNcaafTicker, parseNcaafMl } = require('./ncaaf');
const { isLineTicker, parseLineTicker } = require('./lines');
const { isNbaTicker, parseNbaMl } = require('./nba');
const { isNcaabTicker, parseNcaabMl } = require('./ncaab');

const ESPN_NFL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const KALSHI_OFFSET_MS = 3 * 3600 * 1000;

function gameIdOfTicker(ticker) {
  const t = String(ticker || '').split(':')[0].toUpperCase();
  if (/^KXNFLTD-/.test(t)) { const p = parseTdTicker(t); return p ? p.gameId : null; }
  if (isLineTicker(t)) { const g = parseLineTicker(t); return g ? g.gameId : null; } // spreads / totals: same gameId as the ML
  if (isNcaafTicker(t)) { const g = parseNcaafMl(t); return g ? g.gameId : null; } // ncaaf|date|KALSHI+CODES
  if (isNbaTicker(t)) { const g = parseNbaMl(t); return g ? g.gameId : null; } // nba|date|KALSHI+CODES
  if (isNcaabTicker(t)) { const g = parseNcaabMl(t); return g ? g.gameId : null; } // ncaab|date|KALSHI+CODES (D1 only)
  const p = parseKalshiUnhedgedTicker(t, 'yes');
  return p && !p.skip && p.gameId ? p.gameId : null;
}

// Kalshi KXNCAAFGAME (moneyline) tickers often carry the date one day BEFORE the game
// (e.g. 26OCT23 for a Sat Oct 24 kickoff); NCAAF spread/total tickers are dated correctly.
// For ncaaf gameIds, match the team pair on the ticker date OR the next day, accepting
// only when exactly one of those games is known (ambiguous => no match).
function nextDay(date) {
  const d = new Date(`${date}T12:00:00Z`); if (!Number.isFinite(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10);
}
function ncaafCandidates(gid) {
  // NBA tickers are dated on the ET tip date (checked Oct 23 2026); same safety net as college.
  const m = /^(ncaaf|nba|ncaab)\|(\d{4}-\d\d-\d\d)\|(.+)$/.exec(gid || ''); if (!m) return [gid];
  const n = nextDay(m[2]); return n ? [gid, `${m[1]}|${n}|${m[3]}`] : [gid];
}
function lookup(map, gid) {
  const hits = ncaafCandidates(gid).filter((g) => map.has(g));
  return hits.length === 1 ? { gid: hits[0], k: map.get(hits[0]) } : null;
}

function createKickoffResolver({ log = () => {} } = {}) {
  const real = { espn: new Map(), odds_cache: new Map() }; // gameId -> { kickoffMs, state }
  const kalshi = new Map(); // ticker -> occurrence_datetime ms
  const warned = new Set();
  let canonical = null; // (ticker) => resolveStart result
  function setCanonical(fn) { canonical = typeof fn === 'function' ? fn : null; }
  function setKickoffs(entries) {
    let n = 0;
    for (const e of entries || []) {
      const m = real[e && e.source]; if (!m || !e.gameId || !Number.isFinite(e.kickoffMs)) continue;
      m.set(e.gameId, { kickoffMs: e.kickoffMs, state: e.state || null }); n += 1;
    }
    return n;
  }
  function setKalshiOccurrence(ticker, occMs) { if (Number.isFinite(occMs)) kalshi.set(String(ticker).toUpperCase(), occMs); }
  // -> { kickoffMs, source, state } | null
  function resolve(ticker) {
    const t = String(ticker || '').split(':')[0].toUpperCase();
    const gid = gameIdOfTicker(t);
    if (canonical) {
      let c = null; try { c = canonical(t); } catch (_) { c = null; }
      if (c && c.verified && Number.isFinite(c.startMs)) return { kickoffMs: c.startMs, source: 'canonical', state: c.state || null, gameId: gid };
    }
    if (gid) {
      for (const src of ['espn', 'odds_cache']) {
        const hit = lookup(real[src], gid);
        if (hit) return { kickoffMs: hit.k.kickoffMs, source: src, state: hit.k.state, gameId: hit.gid };
      }
    }
    if (kalshi.has(t)) {
      const key = gid || t;
      if (!warned.has(key)) { warned.add(key); log(`[SNIPER] kickoff FALLBACK (Kalshi occurrence − 3h) for ${key} — no ESPN/odds_cache time`); }
      return { kickoffMs: kalshi.get(t) - KALSHI_OFFSET_MS, source: 'kalshi_occ_minus_3h', state: null, gameId: gid };
    }
    return null;
  }
  // For pregameCheck: started (ESPN in/post) => 0 so any clock is past kickoff.
  function kickoffFor(ticker) {
    const r = resolve(ticker); if (!r) return null;
    return r.state === 'in' || r.state === 'post' ? 0 : r.kickoffMs;
  }
  return { setCanonical, setKickoffs, setKalshiOccurrence, resolve, kickoffFor, stats: () => ({ espn: real.espn.size, odds: real.odds_cache.size, kalshi: kalshi.size, fallbacks: warned.size }) };
}

module.exports = { createKickoffResolver, gameIdOfTicker, ESPN_NFL, ncaafCandidates };
