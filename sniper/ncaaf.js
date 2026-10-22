// College football (NCAAF) moneyline legs for the Combo Sniper.
//
// Kalshi leg:   KXNCAAFGAME-<YYMONDD><AWAYHOME>-<PICK>  e.g. KXNCAAFGAME-26OCT24TXSTSDSU-TXST
// Team identity: the Kalshi code, translated ONLY through the verified ncaaf-crosswalk
// (Kalshi codes ≠ Polymarket abbreviations ≠ Novig/ESPN names). A blob that does not split
// into exactly two known codes, or a name not in the table, is UNMAPPED => no fair => skip.
// gameId = ncaaf|<ET date>|<KALSHI CODES sorted, joined by +>.
//
// Fair = the same inverse-bet method as NFL (noboost/pm-live.js): for team T vs O,
//   cost_v = fee-included VWAP to buy $depth of "T loses" on venue v
//            (Kalshi: cheaper of Yes-on-O and No-on-T; Polymarket US / Novig: O's ask ladder)
//   fair(T) = 1 − min_v cost_v, same FEES table, same 15s staleness, real depth only.
// ProphetX: the sniper has no ProphetX key (prophetx=off), so it is not wired for NCAAF.
'use strict';
const X = require('../ncaaf-crosswalk');
const XDATA = require('../ncaaf-crosswalk.json');
const { walk, american, FEES } = require('../noboost/pm-live');
const { etDate } = require('../mm-paper-odds');

const SERIES = 'KXNCAAFGAME';
const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const SETTLED_AFTER_MS = 4.5 * 3600 * 1000;
const SETTLED_PRICE = 0.015;

// Names other feeds use that differ from the crosswalk's Kalshi/Polymarket names.
// Each maps to a Kalshi code that IS in the crosswalk (checked at load; unknown codes dropped).
const NAME_ALIASES = {
  'hawaii': 'HAW', 'miami ohio': 'MOH', 'miami florida': 'MIA', 'north carolina state': 'NCST',
  'pennsylvania': 'PENN', 'southern mississippi': 'USM', 'ul monroe': 'ULM', 'new haven college': 'NHC',
  'central connecticut': 'CCSU', 'app state': 'APP', 'san jose state': 'SJSU', 'san josé state': 'SJSU',
};
const byName = new Map(); // norm(name) -> Kalshi code; a name claimed by 2 codes is dropped
(() => {
  const bad = new Set();
  const put = (n, c) => { const k = X.norm(n); if (!k) return; if (byName.has(k) && byName.get(k) !== c) bad.add(k); else byName.set(k, c); };
  for (const [code, t] of Object.entries(XDATA.teams || {})) { if (!X.teamByCode(code)) continue; put(t.name, code); put(t.pname, code); }
  for (const k of bad) byName.delete(k);
  for (const [n, c] of Object.entries(NAME_ALIASES)) if (X.teamByCode(c) && !byName.has(X.norm(n))) byName.set(X.norm(n), c);
})();
const codeForName = (name) => byName.get(X.norm(name)) || null;
const codeForPoly = (abbr) => { const t = X.teamByPoly(abbr); return t ? t.code : null; };

const isNcaafTicker = (t) => String(t || '').toUpperCase().startsWith(`${SERIES}-`);

// -> { ticker, date, codes:[a,b], selection, gameId } | null (unmapped / not NCAAF ML)
function parseNcaafMl(ticker) {
  const t = String(ticker || '').split(':')[0].toUpperCase();
  const p = t.split('-');
  if (p.length !== 3 || p[0] !== SERIES) return null;
  const m = /^(\d\d)([A-Z]{3})(\d\d)(?:\d{4})?([A-Z]+)$/.exec(p[1]);
  if (!m || !MON[m[2]]) return null;
  const sp = X.splitBlob(m[4]);
  if (!sp || !sp.codes.includes(p[2])) return null;
  const date = `20${m[1]}-${MON[m[2]]}-${m[3]}`;
  return { ticker: t, date, codes: sp.codes.slice(), selection: p[2], gameId: `ncaaf|${date}|${[...sp.codes].sort().join('+')}` };
}

// One RFQ leg key -> classified leg, or { reason } when it cannot be priced.
function classifyNcaafLeg(key) {
  const [tk, sideRaw] = String(key || '').split(':');
  const side = String(sideRaw || 'yes').toLowerCase() === 'no' ? 'no' : 'yes';
  if (!isNcaafTicker(tk)) return { reason: 'not_ncaaf' };
  const g = parseNcaafMl(tk);
  if (!g) return { reason: 'ncaaf_unmapped' };
  const other = g.codes.find((c) => c !== g.selection);
  return { kind: 'ncaaf', gameId: g.gameId, team: side === 'yes' ? g.selection : other, id: g.ticker, side };
}

const shift = (date, d) => { const t = Date.parse(`${date}T12:00:00Z`); return Number.isFinite(t) ? new Date(t + d * 86400000).toISOString().slice(0, 10) : date; };

function createNcaafBook({ now = () => Date.now(), staleMs = 15000, depthUsd = 1000 } = {}) {
  const asks = new Map(); const kalshiNo = new Map(); const games = new Map();
  const set = (m, gid, team, venue, v) => { const k = `${gid}:${team}`; const s = m.get(k) || {}; s[venue] = v; m.set(k, s); };
  function findGame(date, a, b) {
    const want = [a, b].sort().join('+');
    for (const d of [date, shift(date, -1), shift(date, 1)]) { const id = `ncaaf|${d}|${want}`; if (games.has(id)) return id; }
    return null;
  }
  function ingestKalshiOrderbooks(obs) {
    let n = 0;
    for (const ob of obs || []) {
      const t = String((ob && (ob.ticker || ob.market_ticker)) || '').toUpperCase();
      const g = parseNcaafMl(t); if (!g) continue;
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
  // odds-relay /board?league=NCAAF quotes (same freshness rules as NFL pm-live.ingestRelay).
  function ingestRelay(venue, quotes, { feedLive = false, polledAt = now() } = {}) {
    let n = 0;
    for (const q of quotes || []) {
      if (!q || q.bet_type !== 'moneyline' || q.is_alt) continue;
      if (venue === 'polymarket' && q.feed !== 'polymarket-us') continue;
      let a; let h; let side;
      const pm = venue === 'polymarket' ? /aec-cfb-([a-z0-9]+)-([a-z0-9]+)-\d{4}-\d\d-\d\d:(yes|no)$/.exec(String(q.token_id || '')) : null;
      if (pm) {
        // Polymarket US: identity from the slug abbreviations (crosswalk), never from names.
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
      if (Array.isArray(q.depth) && q.depth.length) { levels = q.depth.map((d) => [Number(d.odds), Number(d.size)]); depthKnown = true; } else if (q.size > 0) { levels = [[Number(q.odds), Number(q.size)]]; depthKnown = true; } else { levels = [[Number(q.odds), Infinity]]; depthKnown = false; }
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
    for (const v of ['kalshi', 'polymarket', 'novig']) { const r = evalVenue(v, o[v]); if (r) sources.push(v === 'kalshi' ? { ...r, via: 'yes_opp' } : r); }
    const rn = evalVenue('kalshi', (kalshiNo.get(`${gameId}:${team}`) || {}).kalshi);
    if (rn) sources.push({ ...rn, via: 'no_own' });
    const used = sources.filter((s) => s.used);
    if (!used.length) return { p: null, american: null, sources };
    const best = used.reduce((x, y) => (y.cost < x.cost ? y : x));
    return { p: 1 - best.cost, american: american(1 - best.cost), best: `${best.venue}${best.via ? ':' + best.via : ''}`, sources };
  }
  return { ingestKalshiOrderbooks, ingestRelay, legFair, gameCount: () => games.size, _asks: asks };
}

// ESPN college-football scoreboard -> kickoff entries keyed by our NCAAF gameId.
function espnNcaafKickoffs(j) {
  const out = [];
  for (const e of (j && j.events) || []) {
    const c = e.competitions && e.competitions[0];
    const codes = ((c && c.competitors) || []).map((x) => { const t = x.team || {}; return codeForName(t.location) || codeForName(t.shortDisplayName) || codeForName(t.displayName); });
    const iso = (c && c.date) || e.date; const ms = Date.parse(iso || ''); const date = etDate(iso);
    if (codes.length !== 2 || codes.some((x) => !x) || codes[0] === codes[1] || !date || !Number.isFinite(ms)) continue;
    const st = e.status && e.status.type;
    out.push({ gameId: `ncaaf|${date}|${[...codes].sort().join('+')}`, kickoffMs: ms, state: st && ['pre', 'in', 'post'].includes(st.state) ? st.state : null, source: 'espn' });
  }
  return out;
}
// odds_cache (americanfootball_ncaaf, Odds-API shape) -> kickoff entries.
function oddsNcaafKickoffs(gamesArr) {
  const out = [];
  for (const g of gamesArr || []) {
    const ms = Date.parse(g.commence_time || ''); const date = etDate(g.commence_time);
    const codes = [g.home_team, g.away_team].map(codeForName);
    if (codes.some((x) => !x) || codes[0] === codes[1] || !date || !Number.isFinite(ms)) continue;
    out.push({ gameId: `ncaaf|${date}|${[...codes].sort().join('+')}`, kickoffMs: ms, source: 'odds_cache' });
  }
  return out;
}

const ESPN_NCAAF = [80, 81].map((g) => `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=${g}&limit=500`); // FBS + FCS
const teamName = (code) => { const t = X.teamByCode(code); return t ? t.name : code; };

module.exports = { SERIES, isNcaafTicker, parseNcaafMl, classifyNcaafLeg, createNcaafBook, espnNcaafKickoffs, oddsNcaafKickoffs, codeForName, codeForPoly, teamName, ESPN_NCAAF };
