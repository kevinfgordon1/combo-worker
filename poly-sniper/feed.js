// Price feed for the Polymarket combo sniper dry run, running inside poly-worker.
// Same books, depths and staleness as the Kalshi sniper (sniper/runner.js):
//   Kalshi PUBLIC orderbooks (unauthenticated) + our odds-relay (/board, /td) + ESPN/odds_cache kickoffs.
// No Kalshi key, no ProphetX key, no Polymarket key. ProphetX comes from the relay only.
// Polymarket's own book is EXCLUDED by default (POLY_SNIPER_FAIR_INCLUDE_POLY=1 to include):
// we are quoting into Polymarket, so its book should not set our fair for that RFQ.
'use strict';
const { createPmLiveBook } = require('../noboost/pm-live');
const { createTdBook, isTdTicker } = require('../noboost/td-book');
const { createKickoffResolver, ESPN_NFL } = require('../sniper/kickoff');
const { espnKickoffs, oddsKickoffs } = require('../noboost/kickoffs');
const { createNcaafBook, espnNcaafKickoffs, oddsNcaafKickoffs, ESPN_NCAAF, isFbsGame } = require('../sniper/ncaaf');
const { createLimiter } = require('../sniper/limiter');
const { ALL_VENUES } = require('../sniper/fair');
const { createKalshiIndex } = require('./map');
const { fetchLiveTdCrosswalk } = require('./prop-xwalk');

const ORIGIN = 'https://api.elections.kalshi.com';
const P = '/trade-api/v2';
const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

function fairVenues(env = process.env) {
  const includePoly = String(env.POLY_SNIPER_FAIR_INCLUDE_POLY || '') === '1';
  return ALL_VENUES.filter((v) => includePoly || v !== 'polymarket');
}

function createPolySniperFeed({ env = process.env, log = console.log, fetchImpl = fetch } = {}) {
  const venues = fairVenues(env);
  const tdDepth = num(env.POLY_SNIPER_TD_DEPTH_USD, 1000);
  const gameDepth = num(env.POLY_SNIPER_GAME_DEPTH_USD, 2000);
  const staleMs = num(env.POLY_SNIPER_STALE_MS, 15000);
  const ncaafOn = String(env.POLY_SNIPER_NCAAF == null ? '1' : env.POLY_SNIPER_NCAAF) !== '0';
  const lim = {
    kalshi: createLimiter({ name: 'poly_sniper_kalshi_public', ratePerSec: num(env.POLY_SNIPER_KALSHI_RPS, 2), burst: 3 }),
    relay: createLimiter({ name: 'poly_sniper_relay', ratePerSec: num(env.POLY_SNIPER_RELAY_RPS, 2), burst: 2 }),
  };
  const getJson = async (limiter, url) => {
    const r = await limiter.run(() => fetchImpl(url, { headers: { accept: 'application/json' } }));
    if (r.ok === false) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const tdBook = createTdBook({ staleMs, depthUsd: tdDepth, maxOverround: 0.15, venues: venues.filter((v) => v !== 'kalshi') });
  const pmLive = createPmLiveBook({ staleMs, depthUsd: gameDepth });
  pmLive.setTdBook(tdBook);
  const ncaafBook = ncaafOn ? createNcaafBook({ staleMs, depthUsd: gameDepth }) : null;
  const kickoffs = createKickoffResolver({ log });
  const index = createKalshiIndex();
  const kick = new Map();
  const health = { ml: 0, td: 0, relay: 0 };
  const relayBase = env.POLY_SNIPER_ODDS_RELAY_URL || env.SNIPER_ODDS_RELAY_URL || (env.RAILWAY_SERVICE_ODDS_RELAY_URL ? `https://${env.RAILWAY_SERVICE_ODDS_RELAY_URL}` : '');

  async function listMarkets(series) {
    const out = []; let cursor = '';
    for (let i = 0; i < 5; i += 1) {
      const j = await getJson(lim.kalshi, `${ORIGIN}${P}/markets?series_ticker=${series}&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const m of j.markets || []) {
        const t = String(m.ticker || '').toUpperCase();
        const occ = Date.parse(m.occurrence_datetime || '');
        if (t && Number.isFinite(occ)) { kick.set(t, occ - 3 * 3600 * 1000); kickoffs.setKalshiOccurrence(t, occ); }
        out.push(m);
      }
      cursor = j.cursor || ''; if (!cursor) break;
    }
    return out;
  }
  let mlT = []; let tdT = []; let cfbT = []; let listedAt = 0;
  async function refreshLists() {
    const ml = await listMarkets('KXNFLGAME'); mlT = ml.map((m) => String(m.ticker).toUpperCase()); index.ingestMarkets(ml);
    const td = await listMarkets('KXNFLTD'); tdBook.setNames(td); index.ingestMarkets(td);
    tdT = td.map((m) => String(m.ticker).toUpperCase()).filter(isTdTicker);
    if (ncaafBook) {
      const horizon = Date.now() + num(env.POLY_SNIPER_NCAAF_DAYS, 8) * 864e5;
      const c = (await listMarkets('KXNCAAFGAME')).filter((m) => isFbsGame(m.ticker)) // FBS only
        .filter((m) => { const o = Date.parse(m.occurrence_datetime || ''); return !Number.isFinite(o) || o <= horizon; });
      index.ingestMarkets(c); cfbT = c.map((m) => String(m.ticker).toUpperCase());
    }
    listedAt = Date.now();
  }
  async function books(tickers, sink) {
    for (let i = 0; i < tickers.length; i += 100) {
      const chunk = tickers.slice(i, i + 100);
      const j = await getJson(lim.kalshi, `${ORIGIN}${P}/markets/orderbooks?${chunk.map((t) => `tickers=${encodeURIComponent(t)}`).join('&')}`);
      sink(j.orderbooks || []);
    }
  }
  async function pollKalshi() {
    if (!listedAt || Date.now() - listedAt > 120000) await refreshLists();
    if (venues.includes('kalshi')) {
      await books(mlT, (o) => pmLive.ingestKalshiOrderbooks(o)); health.ml = Date.now();
      if (ncaafBook) await books(cfbT, (o) => ncaafBook.ingestKalshiOrderbooks(o));
      await books(tdT, (o) => tdBook.ingest(o, Object.fromEntries([...kick].filter(([t]) => t.startsWith('KXNFLTD'))))); health.td = Date.now();
    }
  }
  const tdOff = new Map();
  async function pollRelay() {
    if (!relayBase) return;
    const h = await getJson(lim.relay, `${relayBase}/health`);
    const st = (h && h.status) || {}; const nv = (h && h.novig) || {};
    for (const venue of ['polymarket', 'novig', 'prophetx']) {
      if (!venues.includes(venue)) continue;
      const polledAt = Date.now();
      try {
        const novigLive = /ws:up/.test(String(st.novig || '')) && Number(nv.lastWsMsgAt) > 0 && polledAt - Number(nv.lastWsMsgAt) < staleMs;
        const pxLive = /ws:up/.test(String(st.prophetx || ''));
        const feedLive = venue === 'novig' ? novigLive : venue === 'prophetx' ? pxLive : false;
        const j = await getJson(lim.relay, `${relayBase}/board?venue=${venue}&league=NFL`);
        pmLive.ingestRelay(venue, j.quotes || [], { feedLive, polledAt });
        if (ncaafBook) {
          const c = await getJson(lim.relay, `${relayBase}/board?venue=${venue}&league=NCAAF`);
          ncaafBook.ingestRelay(venue, c.quotes || [], { feedLive, polledAt });
        }
      } catch (e) { log(`[POLY-SNIPER] relay ${venue} board: ${e.message}`); }
      if (tdOff.has(venue) && Date.now() - tdOff.get(venue) < 10 * 60 * 1000) continue;
      try {
        const t = await getJson(lim.relay, `${relayBase}/td?venue=${venue}&league=NFL`);
        tdOff.delete(venue); tdBook.ingestVenue(venue, t.markets || [], { polledAt });
      } catch (e) { if (/HTTP 503/.test(e.message)) tdOff.set(venue, Date.now()); }
    }
    health.relay = Date.now();
  }
  // Live NFL TD player crosswalk (public GETs, own slow limiter so it never starves the books).
  const xwLim = createLimiter({ name: 'poly_sniper_xwalk', ratePerSec: num(env.POLY_SNIPER_XWALK_RPS, 1), burst: 1 });
  const xwalk = { players: 0, at: 0 };
  async function pollCrosswalk() {
    const r = await fetchLiveTdCrosswalk((u) => getJson(xwLim, u));
    if (!r.players.length && xwalk.players) { log('[POLY-SNIPER] td crosswalk refresh returned 0 players; keeping previous'); return; }
    index.setPropIdx(r.idx);
    xwalk.players = r.players.length; xwalk.at = Date.now();
    const s = index.tdStats();
    log(`[POLY-SNIPER] td crosswalk players=${r.players.length} kalshi_events=${r.kalshiEvents} poly_events=${r.polyEvents} td_indexed=${s.indexed}/${s.seen}`);
  }
  async function pollKickoffs() {
    const r = await fetchImpl(ESPN_NFL, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`espn ${r.status}`);
    kickoffs.setKickoffs(espnKickoffs(await r.json()));
    if (ncaafBook) for (const u of ESPN_NCAAF) { const c = await fetchImpl(u, { headers: { accept: 'application/json' } }); if (c.ok) kickoffs.setKickoffs(espnNcaafKickoffs(await c.json())); }
  }
  async function pollOddsKickoffs() {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return;
    const hdr = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
    for (const [sport, fn] of [['americanfootball_nfl', oddsKickoffs], ['americanfootball_ncaaf', oddsNcaafKickoffs]]) {
      if (sport.endsWith('ncaaf') && !ncaafBook) continue;
      const r = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/odds_cache?sport=eq.${sport}&select=data,fetched_at&order=fetched_at.desc&limit=1`, { headers: hdr });
      if (r.ok) { const j = await r.json(); kickoffs.setKickoffs(fn(j[0] && j[0].data)); }
    }
  }
  const timers = [];
  let stopped = false;
  function loop(fn, name, ms) {
    const tick = async () => {
      if (stopped) return;
      try { await fn(); } catch (e) { log(`[POLY-SNIPER] ${name} error: ${e.message}`); }
      if (!stopped) { const t = setTimeout(tick, ms); if (t.unref) t.unref(); timers.push(t); }
    };
    tick();
  }
  function start() {
    loop(pollKalshi, 'kalshi_books', num(env.POLY_SNIPER_KALSHI_POLL_MS, 5000));
    loop(pollRelay, 'relay', num(env.POLY_SNIPER_RELAY_POLL_MS, 3000));
    loop(pollKickoffs, 'espn_kickoffs', 60000);
    loop(pollOddsKickoffs, 'odds_kickoffs', 300000);
    loop(pollCrosswalk, 'td_crosswalk', num(env.POLY_SNIPER_XWALK_MS, 15 * 60 * 1000));
  }
  // Same rule as the sniper: Kalshi books (if used) and relay must be < 30s old.
  function pricesHealthy(nowMs = Date.now()) {
    const fresh = (t) => t > 0 && nowMs - t < 30000;
    return (!venues.includes('kalshi') || fresh(health.ml)) && (!relayBase || fresh(health.relay));
  }
  return { start, stop: () => { stopped = true; timers.forEach(clearTimeout); }, pmLive, tdBook, ncaafBook, kickoffs, index, venues, pricesHealthy, health, xwalk, depths: { game: gameDepth, td: tdDepth } };
}
module.exports = { createPolySniperFeed, fairVenues };
