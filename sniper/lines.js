// Main spreads and main totals (NFL + FBS college) as Combo Sniper legs. PREVIEW (Kevin, Oct 23).
//
// Kalshi tickers (one market per strike; strikes are always x.5, so no pushes):
//   KXNFLSPREAD-26OCT29CARGB-GB8   Yes = "Green Bay wins by over 7.5"  => GB −7.5  | No => CAR +7.5
//   KXNFLTOTAL-26OCT29CARGB-69     Yes = "Over 68.5"                   => Over 68.5 | No => Under 68.5
//   KXNCAAFSPREAD-… / KXNCAAFTOTAL-…  same shape; team codes via the NCAAF crosswalk, FBS only.
// Outcome keys:  spread:<team>:<signed line>   total:over:<line> / total:under:<line>
//
// MAIN LINE ONLY: a leg is priced only when its exact line (same point number, same favourite)
// is the non-alt (main) line on Novig or ProphetX (odds-relay /board). Anything else => skip.
// EXACT LINE MATCH: a venue counts only if it quotes that exact line; a venue on a different
// number is ignored (never interpolated).
// Fair = the same inverse-bet method as moneylines: fair(outcome) = 1 − min_v cost_v, where
//   cost_v = fee-included VWAP to buy $depth of the OPPOSITE outcome at the same line on venue v
//   (Kalshi: the other side of the same market; Novig / ProphetX: the other side's ask ladder).
// Same FEES table (noboost/pm-live), ProphetX commission via pxEffective, 15s staleness, real depth
// only. Polymarket US: from the relay's /lines feed (public gateway books, read-only); exact number
// only, Polymarket fee from the same FEES table; never used to decide which line is main.
'use strict';
const { parseKalshiUnhedgedTicker } = require('../unhedged-rfq');
const { normTeam } = require('../leg-identity');
const { teamCode, etDate } = require('../mm-paper-odds');
const { walk, american, FEES, pxEffective } = require('../noboost/pm-live');
const X = require('../ncaaf-crosswalk');
const N = require('./ncaaf');
const B = require('./nba'); // NBA: same team table + gameId as KXNBAGAME legs

const SERIES = { KXNFLSPREAD: ['nfl', 'spread'], KXNFLTOTAL: ['nfl', 'total'], KXNCAAFSPREAD: ['ncaaf', 'spread'], KXNCAAFTOTAL: ['ncaaf', 'total'], KXNBASPREAD: ['nba', 'spread'], KXNBATOTAL: ['nba', 'total'] };
const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const SETTLED_AFTER_MS = 4.5 * 3600 * 1000;
const isLineTicker = (t) => { const s = String(t || '').split(':')[0].toUpperCase().split('-')[0]; return !!SERIES[s]; };
const fmt = (x) => { const v = Math.round(Number(x) * 10) / 10; return v > 0 ? `+${v}` : `${v}`; };
const nflCode = (name) => { const c = teamCode('nfl', name); return c ? normTeam('nfl', c) : null; };

// Teams of a Kalshi game blob (e.g. 26OCT29CARGB) -> { date, teams:[a,b] (league codes), gameId } | null
function gameOfBlob(league, blob) {
  const m = /^(\d\d)([A-Z]{3})(\d\d)(?:\d{4})?([A-Z]+)$/.exec(blob);
  if (!m || !MON[m[2]]) return null;
  const date = `20${m[1]}-${MON[m[2]]}-${m[3]}`;
  if (league === 'nba') { const g = B.gameOfBlob(blob); return g ? { ...g, fbs: true } : null; }
  if (league === 'ncaaf') {
    const sp = X.splitBlob(m[4]); if (!sp) return null;
    const codes = sp.codes.slice();
    return { date, teams: codes, gameId: `ncaaf|${date}|${[...codes].sort().join('+')}`, fbs: codes.every(N.isFbs) };
  }
  // NFL: reuse the moneyline parser (same gameId as KXNFLGAME legs => same-game rule holds).
  for (let k = 2; k <= 3; k += 1) {
    const p = parseKalshiUnhedgedTicker(`KXNFLGAME-${blob}-${m[4].slice(-k)}`, 'yes');
    if (p && !p.skip && p.gameId && p.teams) return { date: p.date, teams: p.teams.map((x) => normTeam('nfl', x)), gameId: p.gameId, fbs: true };
  }
  return null;
}

// -> { league, market, gameId, teams, yesKey, noKey, line, ticker } | null
function parseLineTicker(ticker) {
  const t = String(ticker || '').split(':')[0].toUpperCase();
  const p = t.split('-'); if (p.length !== 3 || !SERIES[p[0]]) return null;
  const [league, market] = SERIES[p[0]];
  const g = gameOfBlob(league, p[1]); if (!g) return null;
  if (market === 'total') {
    if (!/^\d+$/.test(p[2])) return null;
    const line = Number(p[2]) - 0.5;
    return { league, market, ...g, line, ticker: t, yesKey: `total:over:${line}`, noKey: `total:under:${line}` };
  }
  const m = /^([A-Z]+?)(\d+)$/.exec(p[2]); if (!m) return null;
  const sel = league === 'nfl' ? normTeam('nfl', m[1]) : m[1];
  if (!g.teams.includes(sel)) return null;
  const opp = g.teams.find((x) => x !== sel); const line = Number(m[2]) - 0.5;
  return { league, market, ...g, line, ticker: t, sel, yesKey: `spread:${sel}:${fmt(-line)}`, noKey: `spread:${opp}:${fmt(line)}` };
}

// RFQ leg key -> classified leg or { reason }
function classifyLineLeg(key) {
  const [tk, sideRaw] = String(key || '').split(':');
  const side = String(sideRaw || 'yes').toLowerCase() === 'no' ? 'no' : 'yes';
  const g = parseLineTicker(tk);
  if (!g) return { reason: 'line_unmapped' };
  if (!g.fbs) return { reason: 'ncaaf_fcs' };
  return { kind: 'line', league: g.league, market: g.market, gameId: g.gameId, id: g.ticker, side, outcome: side === 'yes' ? g.yesKey : g.noKey, opposite: side === 'yes' ? g.noKey : g.yesKey };
}

function createLinesBook({ now = () => Date.now(), staleMs = 15000, depthUsd = 2000 } = {}) {
  const asks = new Map(); // `${gameId}|${outcome}` -> { [venue]: src }
  const main = new Map(); // `${gameId}|${outcome}` -> Set(venue) where this outcome is the main (non-alt) line
  const games = new Map(); // gameId -> { league, teams, date }
  const set = (gid, oc, venue, v) => { const k = `${gid}|${oc}`; const s = asks.get(k) || {}; s[venue] = v; asks.set(k, s); };
  function findGame(league, date, a, b) {
    const want = [a, b].sort().join('+');
    const t = Date.parse(`${date}T12:00:00Z`);
    for (const dd of [0, -1, 1]) { const d = new Date(t + dd * 864e5).toISOString().slice(0, 10); const id = `${league}|${d}|${want}`; if (games.has(id)) return id; }
    return null;
  }
  function ingestKalshiOrderbooks(obs) {
    let n = 0;
    for (const ob of obs || []) {
      const g = parseLineTicker((ob && (ob.ticker || ob.market_ticker)) || ''); if (!g || !g.fbs) continue;
      if (!games.has(g.gameId)) games.set(g.gameId, { league: g.league, teams: [...g.teams].sort(), date: g.date });
      const b = (ob.orderbook_fp || ob.orderbook) || {};
      const rows = (a) => (Array.isArray(a) ? a.map((r) => [Number(r[0]), Number(r[1])]) : []);
      const yesAsks = rows(b.no_dollars).map(([px, q]) => [Math.round((1 - px) * 1e4) / 1e4, q]);
      const noAsks = rows(b.yes_dollars).map(([px, q]) => [Math.round((1 - px) * 1e4) / 1e4, q]);
      const at = now();
      set(g.gameId, g.yesKey, 'kalshi', { levels: yesAsks, at, depthKnown: true, key: g.ticker });
      set(g.gameId, g.noKey, 'kalshi', { levels: noAsks, at, depthKnown: true, key: `${g.ticker}:no` });
      n += 1;
    }
    return n;
  }
  // odds-relay /board?league=NFL|NCAAF quotes (Novig / ProphetX). Polymarket US has no lines => ignored.
  function ingestRelay(venue, league, quotes, { feedLive = false, polledAt = now() } = {}) {
    if (venue !== 'novig' && venue !== 'prophetx' && venue !== 'polymarket') return 0;
    const poly = venue === 'polymarket';
    // Polymarket identity: NFL full team names; college via the crosswalk's Polymarket abbreviations.
    const code = league === 'nba' ? (poly ? ((n, ab) => (ab ? B.codeForPoly(ab) : B.codeForName(n))) : B.codeForName)
      : poly ? (league === 'nfl' ? nflCode : ((n, ab) => (ab ? N.codeForPoly(ab) : null))) : (league === 'nfl' ? nflCode : N.codeForName);
    let n = 0;
    for (const q of quotes || []) {
      if (!q || (q.bet_type !== 'spread' && q.bet_type !== 'total')) continue;
      if (poly && q.feed !== 'polymarket-us-lines') continue;
      const line = Number(q.line); if (!Number.isFinite(line) || Math.abs(line * 2 % 2) !== 1) continue; // x.5 only (Kalshi strikes)
      const a = code(q.away, q.away_abbr); const h = code(q.home, q.home_abbr); const date = etDate(q.start);
      if (!a || !h || a === h || !date) continue;
      const gid = findGame(league, date, a, h); if (!gid) continue;
      let oc;
      if (q.bet_type === 'total') { const s = String(q.side_type || q.side || '').toLowerCase(); if (s !== 'over' && s !== 'under') continue; oc = `total:${s}:${line}`; } else { const s = code(q.side, q.side_abbr); if (s !== a && s !== h) continue;
        if (poly && league === 'ncaaf' && N.codeForName(q.side) && N.codeForName(q.side) !== s) continue; // name disagrees: distrust
        if (poly && league === 'nba' && B.codeForName(q.side) && B.codeForName(q.side) !== s) continue;
        oc = `spread:${s}:${fmt(line)}`;
      }
      const startMs = Date.parse(q.start || '') || 0;
      if (startMs && !q.is_live && now() - startMs > SETTLED_AFTER_MS) continue;
      const changedAt = Date.parse(q.updated_at || '') || 0;
      // Polymarket: relay confirmed_at = now while its market-data socket is alive + subscribed (quiet book is current).
      const at = poly ? Math.max(Date.parse(q.confirmed_at || '') || 0, changedAt) : (feedLive ? polledAt : changedAt);
      let levels;
      const raw = (Array.isArray(q.depth) && q.depth.length ? q.depth : [{ odds: q.odds, size: q.size }]).map((d) => [Number(d.odds), Number(d.size)]).filter(([o, z]) => o > 0 && o < 1 && z > 0);
      if (!raw.length) continue;
      levels = venue === 'prophetx' ? raw.map(([o, z]) => [pxEffective(o), z / o]) : raw;
      set(gid, oc, venue, { levels, at, depthKnown: true, key: q.token_id || null });
      if (!q.is_alt && !poly) { const k = `${gid}|${oc}`; const s = main.get(k) || new Set(); s.add(venue); main.set(k, s); }
      n += 1;
    }
    return n;
  }
  function evalVenue(v, src) {
    if (!src || !FEES[v]) return null;
    const age = now() - src.at; const w = walk(src.levels, v, depthUsd);
    const out = { venue: v, key: src.key, ageMs: Math.round(age), topAmerican: w.top != null ? american(w.top) : null, depthKnown: src.depthKnown };
    if (age > staleMs) return { ...out, used: false, reason: 'stale' };
    if (w.fail) return { ...out, used: false, reason: w.fail };
    return { ...out, used: true, cost: w.vwap, availUsd: w.availUsd, costAmerican: american(w.vwap), reason: 'ok' };
  }
  const isMain = (gid, oc) => !!(main.get(`${gid}|${oc}`) || {}).size;
  // leg = classifyLineLeg(...) -> { p, american, best, sources } | { p:null, reason }
  function legFair(leg) {
    if (!games.has(leg.gameId)) return { p: null, reason: 'no_game', sources: [] };
    if (!isMain(leg.gameId, leg.outcome) && !isMain(leg.gameId, leg.opposite)) return { p: null, reason: 'not_main_line', sources: [] };
    const o = asks.get(`${leg.gameId}|${leg.opposite}`) || {};
    const sources = [];
    for (const v of ['kalshi', 'polymarket', 'novig', 'prophetx']) { const r = evalVenue(v, o[v]); if (r) sources.push(r); }
    const used = sources.filter((s) => s.used);
    const own = []; { const m0 = asks.get(`${leg.gameId}|${leg.outcome}`) || {}; for (const v of ['kalshi', 'polymarket', 'novig', 'prophetx']) { const r = evalVenue(v, m0[v]); if (r && r.reason !== 'stale' && r.topAmerican != null) own.push({ venue: v, topAmerican: r.topAmerican }); } }
    if (!used.length) return { p: null, reason: 'no_venue_depth', sources, own };
    const best = used.reduce((x, y) => (y.cost < x.cost ? y : x));
    return { p: 1 - best.cost, american: american(1 - best.cost), best: best.venue, sources, own };
  }
  // Kalshi tickers worth polling: only strikes that equal a current main line (keeps the budget small).
  function mainTickers(allTickers) {
    return (allTickers || []).filter((t) => { const g = parseLineTicker(t); return g && g.fbs && (isMain(g.gameId, g.yesKey) || isMain(g.gameId, g.noKey)); });
  }
  function addGamesFromTickers(tickers) {
    for (const t of tickers || []) { const g = parseLineTicker(t); if (g && g.fbs && !games.has(g.gameId)) games.set(g.gameId, { league: g.league, teams: [...g.teams].sort(), date: g.date }); }
  }
  return { ingestKalshiOrderbooks, ingestRelay, legFair, isMain, mainTickers, addGamesFromTickers, gameCount: () => games.size };
}

module.exports = { SERIES, isLineTicker, parseLineTicker, classifyLineLeg, createLinesBook };
