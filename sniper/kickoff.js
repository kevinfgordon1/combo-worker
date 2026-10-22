// Real kickoff times for the sniper (rule 9). Priority per game:
//   1. ESPN scoreboard (date + live state pre/in/post; 'in'/'post' => started regardless of clock)
//   2. odds_cache commence_time (Supabase, Odds-API shape)
//   3. LAST RESORT: Kalshi occurrence_datetime − 3h (logged once per game when used)
// Same parsers/gameIds as the no-boost book (noboost/kickoffs.js).
'use strict';
const { parseKalshiUnhedgedTicker } = require('../unhedged-rfq');
const { parseTdTicker } = require('../noboost/td-book');

const ESPN_NFL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const KALSHI_OFFSET_MS = 3 * 3600 * 1000;

function gameIdOfTicker(ticker) {
  const t = String(ticker || '').split(':')[0].toUpperCase();
  if (/^KXNFLTD-/.test(t)) { const p = parseTdTicker(t); return p ? p.gameId : null; }
  const p = parseKalshiUnhedgedTicker(t, 'yes');
  return p && !p.skip && p.gameId ? p.gameId : null;
}

function createKickoffResolver({ log = () => {} } = {}) {
  const real = { espn: new Map(), odds_cache: new Map() }; // gameId -> { kickoffMs, state }
  const kalshi = new Map(); // ticker -> occurrence_datetime ms
  const warned = new Set();
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
    if (gid) {
      for (const src of ['espn', 'odds_cache']) {
        const k = real[src].get(gid);
        if (k) return { kickoffMs: k.kickoffMs, source: src, state: k.state, gameId: gid };
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
  return { setKickoffs, setKalshiOccurrence, resolve, kickoffFor, stats: () => ({ espn: real.espn.size, odds: real.odds_cache.size, kalshi: kalshi.size, fallbacks: warned.size }) };
}

module.exports = { createKickoffResolver, gameIdOfTicker, ESPN_NFL };
