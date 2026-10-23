// NBA game legs for the Combo Sniper: moneylines (KXNBAGAME) here; main spreads / totals
// (KXNBASPREAD / KXNBATOTAL) go through sniper/lines.js with the same team table and gameId.
// No NBA player props.
//
// Kalshi leg:  KXNBAGAME-<YYMONDD><AWAY><HOME>-<PICK>   e.g. KXNBAGAME-26OCT23DALIND-IND
//   All 30 Kalshi NBA codes are 3 letters (GSW, NYK, NOP, SAS, PHX, UTA, WAS, BKN …).
//   Date convention (checked Oct 23 2026 against ESPN): the ticker date is the ET date of the tip
//   (a 10:30 PM ET tip keeps that day's date), and occurrence_datetime = tip + 3h. Unlike the
//   KXNCAAFGAME tickers in #241 there is no day-early offset; the kickoff resolver still accepts
//   the ticker date or the next day when exactly one game matches (same rule as college).
// gameId = nba|<ET date>|<KALSHI CODES sorted, joined by +>.
//
// Team identity: Kalshi code <-> ESPN abbreviation / Polymarket US slug abbreviation / team name
// (Novig + ProphetX send full names, Polymarket US sends nicknames). A name that matches no team
// (or two) is UNMAPPED => no price from that quote.
//
// Fair = the same inverse-bet method as NFL / college (noboost/pm-live walk + FEES, pxEffective):
//   cost_v = fee-included VWAP to buy $depth of "T loses" on venue v
//            (Kalshi: cheaper of Yes-on-O and No-on-T; Polymarket US / Novig / ProphetX: O's ladder)
//   fair(T) = 1 − min_v cost_v, 15s staleness, real depth only.
'use strict';
const { walk, american, FEES, pxEffective } = require('../noboost/pm-live');
const { etDate } = require('../mm-paper-odds');

const SERIES = 'KXNBAGAME';
const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const SETTLED_AFTER_MS = 3.5 * 3600 * 1000;
const SETTLED_PRICE = 0.015;

// code: [city, nickname, ESPN abbr, Polymarket US abbr]
const TEAMS = {
  ATL: ['Atlanta', 'Hawks', 'ATL', 'atl'], BKN: ['Brooklyn', 'Nets', 'BKN', 'bkn'], BOS: ['Boston', 'Celtics', 'BOS', 'bos'],
  CHA: ['Charlotte', 'Hornets', 'CHA', 'cha'], CHI: ['Chicago', 'Bulls', 'CHI', 'chi'], CLE: ['Cleveland', 'Cavaliers', 'CLE', 'cle'],
  DAL: ['Dallas', 'Mavericks', 'DAL', 'dal'], DEN: ['Denver', 'Nuggets', 'DEN', 'den'], DET: ['Detroit', 'Pistons', 'DET', 'det'],
  GSW: ['Golden State', 'Warriors', 'GS', 'gs'], HOU: ['Houston', 'Rockets', 'HOU', 'hou'], IND: ['Indiana', 'Pacers', 'IND', 'ind'],
  LAC: ['Los Angeles', 'Clippers', 'LAC', 'lac'], LAL: ['Los Angeles', 'Lakers', 'LAL', 'lal'], MEM: ['Memphis', 'Grizzlies', 'MEM', 'mem'],
  MIA: ['Miami', 'Heat', 'MIA', 'mia'], MIL: ['Milwaukee', 'Bucks', 'MIL', 'mil'], MIN: ['Minnesota', 'Timberwolves', 'MIN', 'min'],
  NOP: ['New Orleans', 'Pelicans', 'NO', 'no'], NYK: ['New York', 'Knicks', 'NY', 'ny'], OKC: ['Oklahoma City', 'Thunder', 'OKC', 'okc'],
  ORL: ['Orlando', 'Magic', 'ORL', 'orl'], PHI: ['Philadelphia', '76ers', 'PHI', 'phi'], PHX: ['Phoenix', 'Suns', 'PHX', 'pho'],
  POR: ['Portland', 'Trail Blazers', 'POR', 'por'], SAC: ['Sacramento', 'Kings', 'SAC', 'sac'], SAS: ['San Antonio', 'Spurs', 'SA', 'sa'],
  TOR: ['Toronto', 'Raptors', 'TOR', 'tor'], UTA: ['Utah', 'Jazz', 'UTAH', 'uta'], WAS: ['Washington', 'Wizards', 'WSH', 'was'],
};
const isNbaCode = (c) => Object.prototype.hasOwnProperty.call(TEAMS, String(c || '').toUpperCase());
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const NICK_ALIASES = { sixers: 'PHI', blazers: 'POR', cavs: 'CLE', wolves: 'MIN', mavs: 'DAL' };
const byEspn = new Map(); const byPoly = new Map(); const byNick = new Map();
for (const [code, [, nick, espn, poly]] of Object.entries(TEAMS)) { byEspn.set(espn, code); byEspn.set(code, code); byPoly.set(poly, code); byNick.set(norm(nick), code); }
for (const [n, c] of Object.entries(NICK_ALIASES)) byNick.set(n, c);
// Full name ("Golden State Warriors", "LA Clippers"), nickname ("Warriors") or "Portland Trail Blazers".
// City alone is NOT enough (two Los Angeles teams) => null.
function codeForName(name) {
  const n = norm(name); if (!n) return null;
  if (byNick.has(n)) return byNick.get(n);
  const hits = new Set();
  for (const [nick, code] of byNick) if (n.endsWith(` ${nick}`)) hits.add(code);
  return hits.size === 1 ? [...hits][0] : null;
}
const codeForPoly = (abbr) => byPoly.get(String(abbr || '').toLowerCase()) || null;
const codeForEspn = (abbr) => byEspn.get(String(abbr || '').toUpperCase()) || null;
const teamName = (code) => { const t = TEAMS[String(code || '').toUpperCase()]; return t ? `${t[0] === 'Los Angeles' ? 'LA' : t[0]} ${t[1]}` : code; };
const nickName = (code) => { const t = TEAMS[String(code || '').toUpperCase()]; return t ? t[1] : code; };

// 26OCT23DALIND -> { date, teams:[DAL, IND] (away, home), gameId } | null
function gameOfBlob(blob) {
  const m = /^(\d\d)([A-Z]{3})(\d\d)(?:\d{4})?([A-Z]{6})$/.exec(String(blob || '').toUpperCase());
  if (!m || !MON[m[2]]) return null;
  const a = m[4].slice(0, 3); const h = m[4].slice(3);
  if (!isNbaCode(a) || !isNbaCode(h) || a === h) return null;
  const date = `20${m[1]}-${MON[m[2]]}-${m[3]}`;
  return { date, teams: [a, h], gameId: `nba|${date}|${[a, h].sort().join('+')}` };
}
const isNbaTicker = (t) => String(t || '').toUpperCase().startsWith(`${SERIES}-`);
const isNbaAny = (t) => /^KXNBA(GAME|SPREAD|TOTAL)-/.test(String(t || '').toUpperCase());

// -> { ticker, date, codes:[away, home], selection, gameId } | null
function parseNbaMl(ticker) {
  const t = String(ticker || '').split(':')[0].toUpperCase();
  const p = t.split('-');
  if (p.length !== 3 || p[0] !== SERIES) return null;
  const g = gameOfBlob(p[1]); if (!g || !g.teams.includes(p[2])) return null;
  return { ticker: t, date: g.date, codes: g.teams.slice(), selection: p[2], gameId: g.gameId };
}

function classifyNbaLeg(key) {
  const [tk, sideRaw] = String(key || '').split(':');
  const side = String(sideRaw || 'yes').toLowerCase() === 'no' ? 'no' : 'yes';
  if (!isNbaTicker(tk)) return { reason: 'not_nba' };
  const g = parseNbaMl(tk);
  if (!g) return { reason: 'nba_unmapped' };
  const other = g.codes.find((c) => c !== g.selection);
  return { kind: 'nba', gameId: g.gameId, team: side === 'yes' ? g.selection : other, id: g.ticker, side };
}

const shift = (date, d) => { const t = Date.parse(`${date}T12:00:00Z`); return Number.isFinite(t) ? new Date(t + d * 86400000).toISOString().slice(0, 10) : date; };

function createNbaBook({ now = () => Date.now(), staleMs = 15000, depthUsd = 2000 } = {}) {
  const asks = new Map(); const kalshiNo = new Map(); const games = new Map();
  const set = (m, gid, team, venue, v) => { const k = `${gid}:${team}`; const s = m.get(k) || {}; s[venue] = v; m.set(k, s); };
  function findGame(date, a, b) {
    const want = [a, b].sort().join('+');
    for (const d of [date, shift(date, -1), shift(date, 1)]) { const id = `nba|${d}|${want}`; if (games.has(id)) return id; }
    return null;
  }
  function ingestKalshiOrderbooks(obs) {
    let n = 0;
    for (const ob of obs || []) {
      const t = String((ob && (ob.ticker || ob.market_ticker)) || '').toUpperCase();
      const g = parseNbaMl(t); if (!g) continue;
      if (!games.has(g.gameId)) games.set(g.gameId, { teams: [...g.codes].sort(), date: g.date });
      const b = (ob.orderbook_fp || ob.orderbook) || {};
      const rows = (a) => (Array.isArray(a) ? a.map((r) => [Number(r[0]), Number(r[1])]) : []);
      const yesAsks = rows(b.no_dollars).map(([px, q]) => [Math.round((1 - px) * 1e4) / 1e4, q]);
      const noAsks = rows(b.yes_dollars).map(([px, q]) => [Math.round((1 - px) * 1e4) / 1e4, q]);
      const at = now();
      set(asks, g.gameId, g.selection, 'kalshi', { levels: yesAsks, at, changedAt: at, depthKnown: true, key: t });
      set(kalshiNo, g.gameId, g.selection, 'kalshi', { levels: noAsks, at, changedAt: at, depthKnown: true, key: `${t}:no` });
      n += 1;
    }
    return n;
  }
  // odds-relay /board?league=NBA moneyline quotes (same freshness rules as NFL / college).
  function ingestRelay(venue, quotes, { feedLive = false, polledAt = now() } = {}) {
    let n = 0;
    for (const q of quotes || []) {
      if (!q || q.bet_type !== 'moneyline' || q.is_alt) continue;
      if (venue === 'polymarket' && q.feed !== 'polymarket-us') continue;
      let a; let h; let side;
      const pm = venue === 'polymarket' ? /aec-nba-([a-z0-9]+)-([a-z0-9]+)-\d{4}-\d\d-\d\d:(yes|no)$/.exec(String(q.token_id || '')) : null;
      if (pm) {
        const c1 = codeForPoly(pm[1]); const c2 = codeForPoly(pm[2]);
        if (!c1 || !c2 || c1 === c2) continue;
        a = c1; h = c2; side = pm[3] === 'yes' ? c1 : c2;
        if (codeForName(q.side) && codeForName(q.side) !== side) continue; // name disagrees: distrust
      } else if (venue === 'polymarket') {
        continue;
      } else {
        a = codeForName(q.away); h = codeForName(q.home); side = codeForName(q.side);
      }
      const date = etDate(q.start);
      if (!a || !h || !side || a === h || (side !== a && side !== h) || !date) continue;
      const gid = findGame(date, a, h); if (!gid) continue;
      const changedAt = Date.parse(q.updated_at || '') || 0;
      const startMs = Date.parse(q.start || '') || 0; const odds = Number(q.odds);
      if ((startMs && !q.is_live && now() - startMs > SETTLED_AFTER_MS) || (Number.isFinite(odds) && !(odds > SETTLED_PRICE && odds < 1 - SETTLED_PRICE))) continue;
      const confirmedAt = Date.parse(q.confirmed_at || '') || 0;
      const at = venue === 'polymarket' ? Math.max(confirmedAt, changedAt) : (feedLive ? polledAt : changedAt);
      let levels; let depthKnown;
      if (venue === 'prophetx') { const lv = (Array.isArray(q.depth) && q.depth.length ? q.depth : [{ odds: q.odds, size: q.size }]).map((d) => [Number(d.odds), Number(d.size)]).filter(([o, z]) => o > 0 && o < 1 && z > 0); if (!lv.length) continue; levels = lv.map(([o, z]) => [pxEffective(o), z / o]); depthKnown = true; } else if (Array.isArray(q.depth) && q.depth.length) { levels = q.depth.map((d) => [Number(d.odds), Number(d.size)]); depthKnown = true; } else if (q.size > 0) { levels = [[Number(q.odds), Number(q.size)]]; depthKnown = true; } else { levels = [[Number(q.odds), Infinity]]; depthKnown = false; }
      set(asks, gid, side, venue, { levels, at, changedAt, depthKnown, key: q.token_id || null });
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
    return { ...out, used: true, cost: w.vwap, availUsd: w.availUsd, costAmerican: american(w.vwap), reason: src.depthKnown ? 'ok' : 'top_only' };
  }
  function legFair(gameId, team) {
    const g = games.get(gameId); if (!g) return null;
    const opp = g.teams.find((t) => t !== team); if (!opp || !g.teams.includes(team)) return null;
    const o = asks.get(`${gameId}:${opp}`) || {};
    const sources = [];
    for (const v of ['kalshi', 'polymarket', 'novig', 'prophetx']) { const r = evalVenue(v, o[v]); if (r) sources.push(v === 'kalshi' ? { ...r, via: 'yes_opp' } : r); }
    const rn = evalVenue('kalshi', (kalshiNo.get(`${gameId}:${team}`) || {}).kalshi);
    if (rn) sources.push({ ...rn, via: 'no_own' });
    const used = sources.filter((s) => s.used);
    if (!used.length) return { p: null, american: null, sources };
    const best = used.reduce((x, y) => (y.cost < x.cost ? y : x));
    return { p: 1 - best.cost, american: american(1 - best.cost), best: `${best.venue}${best.via ? ':' + best.via : ''}`, sources };
  }
  return { ingestKalshiOrderbooks, ingestRelay, legFair, gameCount: () => games.size, _asks: asks };
}

// ESPN NBA scoreboard -> kickoff (tip) entries keyed by our NBA gameId.
function espnNbaKickoffs(j) {
  const out = [];
  for (const e of (j && j.events) || []) {
    const c = e.competitions && e.competitions[0];
    const codes = ((c && c.competitors) || []).map((x) => { const t = x.team || {}; return codeForEspn(t.abbreviation) || codeForName(t.displayName); });
    const iso = (c && c.date) || e.date; const ms = Date.parse(iso || ''); const date = etDate(iso);
    if (codes.length !== 2 || codes.some((x) => !x) || codes[0] === codes[1] || !date || !Number.isFinite(ms)) continue;
    const st = e.status && e.status.type;
    out.push({ gameId: `nba|${date}|${[...codes].sort().join('+')}`, kickoffMs: ms, state: st && ['pre', 'in', 'post'].includes(st.state) ? st.state : null, source: 'espn' });
  }
  return out;
}
// ESPN only lists one day per call: today + tomorrow (ET) cover the 36h quoting window.
function espnNbaUrls(nowMs = Date.now(), days = 2) {
  const out = [];
  for (let i = 0; i < days; i += 1) { const d = etDate(new Date(nowMs + i * 864e5).toISOString()); if (d) out.push(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${d.replace(/-/g, '')}`); }
  return out;
}

module.exports = { SERIES, TEAMS, isNbaCode, isNbaTicker, isNbaAny, gameOfBlob, parseNbaMl, classifyNbaLeg, createNbaBook, espnNbaKickoffs, espnNbaUrls, codeForName, codeForPoly, codeForEspn, teamName, nickName };
