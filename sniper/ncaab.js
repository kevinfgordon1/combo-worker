// Men's college basketball (NCAAB) MONEYLINE legs for the Combo Sniper (Kevin Oct 30 2026).
// Moneylines ONLY: KXNCAAMBSPREAD / KXNCAAMBTOTAL legs are never priced (classifyLegs rejects them).
// Behind SNIPER_NCAAB=1 (default OFF), its own minimum edge (SNIPER_MIN_ROI_NCAAB, default 7%) and a
// tip horizon (SNIPER_NCAAB_HOURS, default 24h, never more than 36h). Caps are the sniper's normal caps.
//
// Kalshi leg:  KXNCAAMBGAME-<YYMONDD><CODES>-<PICK>   e.g. KXNCAAMBGAME-26NOV01NDVILL-VILL
//   Codes are 2-5 letters, so a blob is split ONLY through the verified ncaab-crosswalk (exactly one
//   reading with two known codes). Kalshi also lists D1 vs non-D1 games (Fisk, Bethesda ...): non-D1
//   schools are not in the crosswalk, so those tickers never parse => never quoted (D1-vs-D1 only).
//   occurrence_datetime = tip + 3h (checked Oct 30 2026: ND-VILL 17:30Z vs ESPN tip 14:30Z).
// gameId = ncaab|<ticker date>|<KALSHI CODES sorted, joined by +>.
//
// Fair = the same inverse-bet method as NFL / NCAAF / NBA (noboost/pm-live walk + FEES, pxEffective):
//   cost_v = fee-included VWAP to buy $depth of "T loses" on venue v
//            (Kalshi: cheaper of Yes-on-O and No-on-T; Polymarket US / Novig / ProphetX: O's ladder)
//   fair(T) = 1 − min_v cost_v, 15s staleness, real depth only.
'use strict';
const X = require('../ncaab-crosswalk');
const CANON = require('../ncaab-teams'); // ESPN schedule -> opponent/tip context for ambiguous Kalshi codes
const { walk, american, FEES, pxEffective } = require('../noboost/pm-live');
const { etDate } = require('../mm-paper-odds');

const SERIES = 'KXNCAAMBGAME';
const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const SETTLED_AFTER_MS = 3.5 * 3600 * 1000;
const SETTLED_PRICE = 0.015;
const MAX_HOURS = 36; // Kevin: NCAAB legs tip within 24-36h; config may not widen past this

const isNcaabTicker = (t) => String(t || '').split(':')[0].toUpperCase().startsWith(`${SERIES}-`);
// Any men's college basketball Kalshi leg (KXNCAAMBGAME / SPREAD / TOTAL / anything KXNCAAMB*).
const isNcaabAny = (t) => /^KXNCAAMB/.test(String(t || '').split(':')[0].toUpperCase());

// 26NOV01NDVILL -> { date, teams:[a, b] (blob order), gameId } | null
function gameOfBlob(blob) {
  const m = /^(\d\d)([A-Z]{3})(\d\d)(?:\d{4})?([A-Z]+)$/.exec(String(blob || '').toUpperCase());
  if (!m || !MON[m[2]]) return null;
  const date = `20${m[1]}-${MON[m[2]]}-${m[3]}`;
  const sp = X.splitBlob(m[4], { date, dateBlob: `${m[1]}${m[2]}${m[3]}` }); if (!sp) return null;
  return { date, teams: sp.codes.slice(), gameId: `ncaab|${date}|${[...sp.codes].sort().join('+')}` };
}

// -> { ticker, date, codes:[a, b], selection, gameId } | null (unmapped / non-D1 / not NCAAB ML)
function parseNcaabMl(ticker) {
  const t = String(ticker || '').split(':')[0].toUpperCase();
  const p = t.split('-');
  if (p.length !== 3 || p[0] !== SERIES) return null;
  const g = gameOfBlob(p[1]); if (!g || !g.teams.includes(p[2])) return null;
  return { ticker: t, date: g.date, codes: g.teams.slice(), selection: p[2], gameId: g.gameId };
}
// Both teams D1 and in the crosswalk (used to keep non-D1 games out of polling).
const isD1Game = (ticker) => !!parseNcaabMl(ticker);

function classifyNcaabLeg(key) {
  const [tk, sideRaw] = String(key || '').split(':');
  const side = String(sideRaw || 'yes').toLowerCase() === 'no' ? 'no' : 'yes';
  if (!isNcaabTicker(tk)) return { reason: isNcaabAny(tk) ? 'ncaab_lines_off' : 'not_ncaab' };
  const g = parseNcaabMl(tk);
  if (!g) return { reason: 'ncaab_unmapped' };
  const other = g.codes.find((c) => c !== g.selection);
  return { kind: 'ncaab', gameId: g.gameId, team: side === 'yes' ? g.selection : other, id: g.ticker, side };
}

const shift = (date, d) => { const t = Date.parse(`${date}T12:00:00Z`); return Number.isFinite(t) ? new Date(t + d * 86400000).toISOString().slice(0, 10) : date; };

function createNcaabBook({ now = () => Date.now(), staleMs = 15000, depthUsd = 1000 } = {}) {
  const asks = new Map(); const kalshiNo = new Map(); const games = new Map();
  const set = (m, gid, team, venue, v) => { const k = `${gid}:${team}`; const s = m.get(k) || {}; s[venue] = v; m.set(k, s); };
  function findGame(date, a, b) {
    const want = [a, b].sort().join('+');
    for (const d of [date, shift(date, -1), shift(date, 1)]) { const id = `ncaab|${d}|${want}`; if (games.has(id)) return id; }
    return null;
  }
  function ingestKalshiOrderbooks(obs) {
    let n = 0;
    for (const ob of obs || []) {
      const t = String((ob && (ob.ticker || ob.market_ticker)) || '').toUpperCase();
      const g = parseNcaabMl(t); if (!g) continue;
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
  // odds-relay /board?league=NCAAB moneyline quotes (same freshness rules as NFL / college football / NBA).
  function ingestRelay(venue, quotes, { feedLive = false, polledAt = now() } = {}) {
    let n = 0;
    for (const q of quotes || []) {
      if (!q || q.bet_type !== 'moneyline' || q.is_alt) continue;
      if (venue === 'polymarket' && q.feed !== 'polymarket-us') continue;
      let a; let h; let side;
      const pm = venue === 'polymarket' ? /aec-cbb-([a-z0-9]+)-([a-z0-9]+)-\d{4}-\d\d-\d\d:(yes|no)$/.exec(String(q.token_id || '')) : null;
      if (pm) {
        // Polymarket US: identity from the slug abbreviations (crosswalk), never from names alone.
        const c1 = X.codeForPoly(pm[1]); const c2 = X.codeForPoly(pm[2]);
        if (!c1 || !c2 || c1 === c2) continue;
        a = c1; h = c2; side = pm[3] === 'yes' ? c1 : c2;
        if (X.codeForName(q.side) && X.codeForName(q.side) !== side) continue; // name disagrees: distrust
      } else if (venue === 'polymarket') {
        continue;
      } else {
        a = X.codeForName(q.away); h = X.codeForName(q.home); side = X.codeForName(q.side);
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
    const own = []; { const m0 = asks.get(`${gameId}:${team}`) || {}; for (const v of ['kalshi', 'polymarket', 'novig', 'prophetx']) { const r = evalVenue(v, m0[v]); if (r && r.reason !== 'stale' && r.topAmerican != null) own.push({ venue: v, topAmerican: r.topAmerican }); } }
    if (!used.length) return { p: null, american: null, sources, own };
    const best = used.reduce((x, y) => (y.cost < x.cost ? y : x));
    return { p: 1 - best.cost, american: american(1 - best.cost), best: `${best.venue}${best.via ? ':' + best.via : ''}`, sources, own };
  }
  return { ingestKalshiOrderbooks, ingestRelay, legFair, gameCount: () => games.size, _asks: asks };
}

// ESPN men's college basketball scoreboard (D1, groups=50) -> tip entries keyed by our NCAAB gameId.
// Teams are matched by ESPN id (exact), so a non-D1 or unmapped team simply yields no entry.
function espnNcaabKickoffs(j) {
  const out = [];
  try { CANON.addSchedule(j); } catch (_) { /* schedule context is best effort */ }
  for (const e of (j && j.events) || []) {
    const c = e.competitions && e.competitions[0];
    const codes = ((c && c.competitors) || []).map((x) => X.codeForEspnId(x && (x.id || (x.team && x.team.id))));
    const iso = (c && c.date) || e.date; const ms = Date.parse(iso || ''); const date = etDate(iso);
    if (codes.length !== 2 || codes.some((x) => !x) || codes[0] === codes[1] || !date || !Number.isFinite(ms)) continue;
    const st = e.status && e.status.type;
    out.push({ gameId: `ncaab|${date}|${[...codes].sort().join('+')}`, kickoffMs: ms, state: st && ['pre', 'in', 'post'].includes(st.state) ? st.state : null, source: 'espn' });
  }
  return out;
}
// ESPN lists one day per call: today + tomorrow (ET) cover the <=36h quoting window.
function espnNcaabUrls(nowMs = Date.now(), days = 2) {
  const out = [];
  for (let i = 0; i < days; i += 1) { const d = etDate(new Date(nowMs + i * 864e5).toISOString()); if (d) out.push(`https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?groups=50&limit=500&dates=${d.replace(/-/g, '')}`); }
  return out;
}
const clampHours = (h) => { const n = Number(h); return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_HOURS) : 24; };
const teamName = (code) => { const t = X.teamByCode(code); return t ? t.name : code; };

module.exports = { SERIES, MAX_HOURS, clampHours, isNcaabTicker, isNcaabAny, isD1Game, gameOfBlob, parseNcaabMl, classifyNcaabLeg, createNcaabBook, espnNcaabKickoffs, espnNcaabUrls, codeForName: X.codeForName, codeForPoly: X.codeForPoly, teamName };
