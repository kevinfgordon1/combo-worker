// "PM live inverse" fair for NFL moneyline legs (Combo Sniper fair option, PAPER only).
//
// Same inverse-bet method as aibetbuilder Promo / boost (lib/promo-ev.js), but ONLY from the
// four free, live prediction-market / exchange feeds, never the 5-minute odds_cache:
//   kalshi     public GET /markets/orderbooks (unauthenticated, does NOT use the shared key)
//   polymarket Polymarket US quotes from our odds-relay (/board, fed by the relay's US WebSocket)
//   novig      Novig quotes + 5-level ask depth from our odds-relay (/board, relay's Novig stream)
//   prophetx   ProphetX partner API (plug-in; off until PROPHETX_API_KEY or ACCESS/SECRET is set)
//
// Per leg (team T, opponent O):
//   cost_v  = fee-included VWAP to buy $DEPTH (500) of "T loses" on venue v
//             (Kalshi: cheaper of Yes-on-O and No-on-T; others: O's ask ladder)
//   fair(T) = 1 − min_v cost_v           (best opposite-side price, sign-flipped)
// Fees: Kalshi 0.07·p·(1−p), Polymarket US 0.0695·p·(1−p), Novig none, ProphetX 2% of net winnings.
// A venue older than staleMs (15s) or without $DEPTH of depth is dropped for that leg (reason kept);
// at least one venue must survive. Every venue's price is returned for the audit trail.
'use strict';
const { parseKalshiUnhedgedTicker } = require('../unhedged-rfq');
const { normTeam } = require('../leg-identity');
const { teamCode, etDate } = require('../mm-paper-odds');

const DEPTH_USD = 500;
const FEES = {
  kalshi: (p) => 0.07 * p * (1 - p),
  polymarket: (p) => 0.0695 * p * (1 - p),
  novig: () => 0,
  prophetx: () => 0, // commission already folded into the level price (pxEffective)
};
const PX_COMMISSION = 0.02;
const pxEffective = (p) => 1 / (1 + (1 / p - 1) * (1 - PX_COMMISSION));
const ALIAS = {}; // mm-paper-odds code -> Kalshi ticker code (none needed today: Kalshi uses LAR/LAC)
const code = (name) => { const c = teamCode('nfl', name); return c ? normTeam('nfl', ALIAS[c] || c) : null; };

function american(p) {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
}

// levels [[price, contracts]] cheapest first. Fee-included VWAP to spend $usd, or a failure.
function walk(levels, venue, usd = DEPTH_USD) {
  const fee = FEES[venue];
  let spent = 0; let got = 0;
  const lv = (levels || []).filter(([p, q]) => p > 0 && p < 1 && q > 0).sort((a, b) => a[0] - b[0]);
  if (!lv.length) return { fail: 'no_ask' };
  const top = lv[0][0] + fee(lv[0][0]);
  for (const [p, q] of lv) {
    const c = p + fee(p);
    const take = Math.min(q, (usd - spent) / c);
    spent += take * c; got += take;
    if (spent >= usd - 1e-9) return { vwap: spent / got, top, depthUsd: usd };
  }
  return { fail: 'depth', top, depthUsd: spent };
}

function createPmLiveBook({ now = () => Date.now(), staleMs = 15000, depthUsd = DEPTH_USD } = {}) {
  // `${gameId}:${team}` -> { [venue]: { levels:[[p,q]], at, changedAt, depthKnown, key } }
  // levels are ASKS to buy "team wins" on that venue.
  const asks = new Map();
  const kalshiNo = new Map(); // `${gameId}:${team}` -> No-ask ladder on team's own Kalshi ticker
  const games = new Map(); // gameId -> { teams:[a,b], date }
  const set = (m, gid, team, venue, v) => { const k = `${gid}:${team}`; const s = m.get(k) || {}; s[venue] = v; m.set(k, s); };

  function addGame(gameId, teams, date) { if (!games.has(gameId)) games.set(gameId, { teams: [...teams].sort(), date }); }
  function findGame(date, a, b) {
    const want = [a, b].sort().join('+');
    for (const d of [date, shift(date, -1), shift(date, 1)]) {
      const id = `nfl|${d}|${want}`;
      if (games.has(id)) return id;
    }
    return null;
  }

  // Kalshi public orderbooks (orderbook_fp yes_dollars/no_dollars are BIDS).
  function ingestKalshiOrderbooks(obs) {
    let n = 0;
    for (const ob of obs || []) {
      const t = String((ob && (ob.ticker || ob.market_ticker)) || '').toUpperCase();
      if (!t.startsWith('KXNFLGAME-')) continue;
      const p = parseKalshiUnhedgedTicker(t, 'yes');
      if (!p || p.skip) continue;
      const team = normTeam('nfl', p.selection);
      addGame(p.gameId, p.teams.map((x) => normTeam('nfl', x)), p.date);
      const b = (ob.orderbook_fp || ob.orderbook) || {};
      const rows = (a) => (Array.isArray(a) ? a.map((r) => [Number(r[0]), Number(r[1])]) : []);
      const yesAsks = rows(b.no_dollars).map(([px, q]) => [Math.round((1 - px) * 1e4) / 1e4, q]);
      const noAsks = rows(b.yes_dollars).map(([px, q]) => [Math.round((1 - px) * 1e4) / 1e4, q]);
      const at = now();
      set(asks, p.gameId, team, 'kalshi', { levels: yesAsks, at, changedAt: at, depthKnown: true, key: t });
      set(kalshiNo, p.gameId, team, 'kalshi', { levels: noAsks, at, changedAt: at, depthKnown: true, key: `${t}:no` });
      n += 1;
    }
    return n;
  }

  // odds-relay /board quotes. feedLive = relay reports that venue's push feed up, so a quiet
  // (unchanged) book is current as of the poll; otherwise freshness falls back to updated_at.
  function ingestRelay(venue, quotes, { feedLive = false, polledAt = now() } = {}) {
    let n = 0;
    for (const q of quotes || []) {
      if (!q || q.bet_type !== 'moneyline' || q.is_alt) continue;
      if (venue === 'polymarket' && q.feed !== 'polymarket-us') continue; // Polymarket US only
      const a = code(q.away); const h = code(q.home); const side = code(q.side);
      const date = etDate(q.start);
      if (!a || !h || !side || !date) continue;
      const gid = findGame(date, a, h);
      if (!gid) continue;
      const changedAt = Date.parse(q.updated_at || '') || 0;
      const at = feedLive ? polledAt : changedAt;
      let levels; let depthKnown;
      if (Array.isArray(q.depth) && q.depth.length) { levels = q.depth.map((d) => [Number(d.odds), Number(d.size)]); depthKnown = true; } else if (q.size > 0) { levels = [[Number(q.odds), Number(q.size)]]; depthKnown = true; } else { levels = [[Number(q.odds), Infinity]]; depthKnown = false; } // relay gives top-of-book only
      set(asks, gid, side, venue, { levels, at, changedAt, depthKnown, key: q.token_id || null });
      n += 1;
    }
    return n;
  }

  // ProphetX: entries [{ away, home, start, side, levels:[{american, size(stake $)}] }]
  function ingestProphetX(entries, at = now()) {
    let n = 0;
    for (const e of entries || []) {
      const a = code(e.away); const h = code(e.home); const side = code(e.side); const date = etDate(e.start);
      const gid = a && h && side && date ? findGame(date, a, h) : null;
      if (!gid) continue;
      const levels = (e.levels || []).map((l) => {
        const am = Number(l.american); const raw = am > 0 ? 100 / (am + 100) : -am / (-am + 100);
        const p = pxEffective(raw);
        return [p, Number(l.size) / raw]; // contracts = stake / raw price
      });
      set(asks, gid, side, 'prophetx', { levels, at, changedAt: at, depthKnown: true, key: e.key || null });
      n += 1;
    }
    return n;
  }

  function evalVenue(v, src) {
    if (!src) return null;
    const age = now() - src.at;
    const w = walk(src.levels, v, depthUsd);
    const out = { venue: v, key: src.key, ageMs: Math.round(age), changeAgeMs: src.changedAt ? Math.round(now() - src.changedAt) : null, topAmerican: w.top != null ? american(w.top) : null, depthKnown: src.depthKnown };
    if (age > staleMs) return { ...out, used: false, reason: 'stale' };
    if (w.fail) return { ...out, used: false, reason: w.fail };
    return { ...out, used: true, cost: w.vwap, costAmerican: american(w.vwap), reason: src.depthKnown ? 'ok' : 'top_only' };
  }

  // Per-leg fair: { p, american, best, sources:[...] } or null (no fresh venue).
  function legFair(gameId, team) {
    const g = games.get(gameId);
    if (!g) return null;
    const opp = g.teams.find((t) => t !== team);
    if (!opp) return null;
    const o = asks.get(`${gameId}:${opp}`) || {};
    const sources = [];
    for (const v of ['kalshi', 'polymarket', 'novig', 'prophetx']) {
      const r = evalVenue(v, o[v]);
      if (r) sources.push(v === 'kalshi' ? { ...r, via: 'yes_opp' } : r);
    }
    const kn = (kalshiNo.get(`${gameId}:${team}`) || {}).kalshi;
    const rn = evalVenue('kalshi', kn);
    if (rn) sources.push({ ...rn, via: 'no_own' });
    const used = sources.filter((s) => s.used);
    if (!used.length) return { p: null, american: null, sources };
    const best = used.reduce((a, b) => (b.cost < a.cost ? b : a));
    const p = 1 - best.cost;
    return { p, american: american(p), best: `${best.venue}${best.via ? ':' + best.via : ''}`, sources };
  }

  // Combo fair (moneyline legs, different games): Π leg fair. Any non-ML or unpriced leg => p null.
  function comboFair(legs) {
    const out = [];
    let p = 1;
    for (const l of legs || []) {
      if (!l || l.kind === 'td') return { p: null, american: null, reason: 'td_leg', legs: out };
      const f = legFair(l.gameId, l.team);
      out.push({ gameId: l.gameId, team: l.team, fairAmerican: f ? f.american : null, best: f ? f.best : null, sources: f ? f.sources.map(({ venue, via, used, reason, costAmerican, topAmerican, ageMs, changeAgeMs }) => ({ venue, via, used, reason, costAmerican, topAmerican, ageMs, changeAgeMs })) : [] });
      if (!f || f.p == null) return { p: null, american: null, reason: f ? 'no_fresh_source' : 'no_game', legs: out };
      p *= f.p;
    }
    return { p, american: american(p), reason: 'ok', legs: out };
  }

  return { ingestKalshiOrderbooks, ingestRelay, ingestProphetX, legFair, comboFair, gameCount: () => games.size, _asks: asks };
}

function shift(date, d) {
  const t = Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(t) ? new Date(t + d * 86400000).toISOString().slice(0, 10) : date;
}

module.exports = { createPmLiveBook, walk, american, pxEffective, FEES, DEPTH_USD };
