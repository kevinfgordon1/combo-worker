// Price feed for the Polymarket combo sniper dry run, running inside poly-worker.
// Same books, depths and staleness as the Kalshi sniper (sniper/runner.js):
//   Kalshi PUBLIC orderbooks (unauthenticated) + our odds-relay (/board, /td) + ESPN/odds_cache kickoffs.
// No Kalshi key, no ProphetX key, no Polymarket key. ProphetX comes from the relay only.
// NBA (ML + spreads/totals) and main spreads/totals (NFL, FBS, NBA) — Kevin Oct 28, dry run — use the
// Kalshi sniper's own books (sniper/nba.js, sniper/lines.js: main line only, exact number only). Poly
// spread/total legs are mapped only with verified market metadata from the PUBLIC gateway (no key).
// Full 4-venue inverse method by default (Kevin Oct 23): best opposing price across Kalshi,
// Polymarket US, Novig and ProphetX, each with its own fee. POLY_SNIPER_FAIR_INCLUDE_POLY=0 excludes Polymarket.
'use strict';
const { createPmLiveBook } = require('../noboost/pm-live');
const { createTdBook, isTdTicker } = require('../noboost/td-book');
const { createKickoffResolver, ESPN_NFL } = require('../sniper/kickoff');
const { espnKickoffs, oddsKickoffs } = require('../noboost/kickoffs');
const { createNcaafBook, espnNcaafKickoffs, oddsNcaafKickoffs, ESPN_NCAAF, isFbsGame } = require('../sniper/ncaaf');
const { createLinesBook } = require('../sniper/lines');
const { createNbaBook, espnNbaKickoffs, espnNbaUrls } = require('../sniper/nba');
const { createNcaabBook, espnNcaabKickoffs, espnNcaabUrls, isD1Game: isNcaabD1Game, clampHours: clampNcaabHours } = require('../sniper/ncaab');
const { createLimiter } = require('../sniper/limiter');
const { ALL_VENUES } = require('../sniper/fair');
const { createKalshiIndex } = require('./map');
const { startTdCrosswalkRefresher } = require('./prop-xwalk');

const ORIGIN = 'https://api.elections.kalshi.com';
const POLY_GATEWAY = 'https://gateway.polymarket.us';
const P = '/trade-api/v2';
const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

function fairVenues(env = process.env) {
  const includePoly = String(env.POLY_SNIPER_FAIR_INCLUDE_POLY == null ? '1' : env.POLY_SNIPER_FAIR_INCLUDE_POLY).trim() !== '0';
  return ALL_VENUES.filter((v) => includePoly || v !== 'polymarket');
}

// Verified public Polymarket market metadata for spread/total legs, fetched lazily on first sight.
// get(slug): market | null (fetched, unusable) | undefined (not fetched yet). want(slug) queues a fetch.
// Read-only GET /v1/market/slug/{slug} on the public gateway; no key, own limiter, bounded queue.
function createLineMetaCache({ fetchMarket, ttlMs = 30 * 60 * 1000, missTtlMs = 10 * 60 * 1000, maxQueue = 300, maxSize = 20000, now = () => Date.now(), log = () => {} } = {}) {
  const cache = new Map(); // slug -> { market|null, at }
  const queued = new Set();
  const inflight = new Set();
  const stats = { fetched: 0, missing: 0, errors: 0, dropped: 0 };
  let running = false;
  function get(slug) {
    const e = cache.get(slug);
    if (!e) return undefined;
    if (now() - e.at > (e.market ? ttlMs : missTtlMs)) { cache.delete(slug); return undefined; }
    return e.market;
  }
  async function drain() {
    if (running) return; running = true;
    try {
      while (queued.size) {
        const slug = queued.values().next().value; queued.delete(slug); inflight.add(slug);
        try {
          const m = await fetchMarket(slug);
          if (cache.size >= maxSize) cache.delete(cache.keys().next().value);
          cache.set(slug, { market: m || null, at: now() });
          if (m) stats.fetched += 1; else stats.missing += 1;
        } catch (e) { stats.errors += 1; if (stats.errors % 50 === 1) log(`[POLY-SNIPER] line meta ${slug}: ${e.message}`); }
        inflight.delete(slug);
      }
    } finally { running = false; }
  }
  function want(slug) {
    if (!slug || get(slug) !== undefined || queued.has(slug) || inflight.has(slug)) return;
    if (queued.size >= maxQueue) { stats.dropped += 1; return; }
    queued.add(slug); drain();
  }
  return { get, want, stats: () => ({ ...stats, cached: cache.size, queued: queued.size }), _cache: cache };
}

function createPolySniperFeed({ env = process.env, log = console.log, fetchImpl = fetch } = {}) {
  const venues = fairVenues(env);
  const tdDepth = num(env.POLY_SNIPER_TD_DEPTH_USD, 1000);
  const gameDepth = num(env.POLY_SNIPER_GAME_DEPTH_USD, 2000);
  const staleMs = num(env.POLY_SNIPER_STALE_MS, 15000);
  const ncaafOn = String(env.POLY_SNIPER_NCAAF == null ? '1' : env.POLY_SNIPER_NCAAF) !== '0';
  const linesOn = String(env.POLY_SNIPER_LINES == null ? '1' : env.POLY_SNIPER_LINES) !== '0';
  const nbaOn = String(env.POLY_SNIPER_NBA == null ? '1' : env.POLY_SNIPER_NBA) !== '0';
  const nbaHours = num(env.POLY_SNIPER_NBA_HOURS, 36);
  // Men's college basketball MONEYLINES (Kevin Oct 30: built with the switch OFF). POLY_SNIPER_NCAAB=1 to enable.
  const ncaabOn = String(env.POLY_SNIPER_NCAAB || '0') === '1';
  const ncaabHours = clampNcaabHours(num(env.POLY_SNIPER_NCAAB_HOURS, 24));
  const lim = {
    kalshi: createLimiter({ name: 'poly_sniper_kalshi_public', ratePerSec: num(env.POLY_SNIPER_KALSHI_RPS, 2), burst: 3 }),
    relay: createLimiter({ name: 'poly_sniper_relay', ratePerSec: num(env.POLY_SNIPER_RELAY_RPS, 2), burst: 2 }),
    gateway: createLimiter({ name: 'poly_sniper_gateway', ratePerSec: num(env.POLY_SNIPER_GATEWAY_RPS, 2), burst: 2 }),
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
  const linesBook = linesOn ? createLinesBook({ staleMs, depthUsd: gameDepth }) : null;
  const nbaBook = nbaOn ? createNbaBook({ staleMs, depthUsd: gameDepth }) : null;
  const ncaabBook = ncaabOn ? createNcaabBook({ staleMs, depthUsd: gameDepth }) : null;
  const lineMeta = linesOn ? createLineMetaCache({
    log,
    fetchMarket: async (slug) => {
      const r = await lim.gateway.run(() => fetchImpl(`${POLY_GATEWAY}/v1/market/slug/${encodeURIComponent(slug)}`, { headers: { accept: 'application/json' } }));
      if (r.status === 404) return null;
      if (r.ok === false) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const m = j && (j.market || j);
      return m && m.slug === slug ? m : null; // the venue's own record for exactly this slug, or nothing
    },
  }) : null;
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
  let mlT = []; let tdT = []; let cfbT = []; let nbaT = []; let ncaabT = []; let lineT = []; let listedAt = 0;
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
    const within = (ms) => (m) => { const o = Date.parse(m.occurrence_datetime || ''); return !Number.isFinite(o) || o <= ms; };
    if (nbaBook) { // NBA: occurrence = tip + 3h; only games inside the quoting window (+3h slack)
      const n = (await listMarkets('KXNBAGAME')).filter(within(Date.now() + (nbaHours + 3) * 3600e3));
      index.ingestMarkets(n); nbaT = n.map((m) => String(m.ticker).toUpperCase());
    }
    if (ncaabBook) { // NCAAB: D1 vs D1 only (crosswalk), tip + 3h = occurrence; soonest first, capped
      const occ = (m) => { const o = Date.parse(m.occurrence_datetime || ''); return Number.isFinite(o) ? o : Infinity; };
      const c = (await listMarkets('KXNCAAMBGAME')).filter((m) => isNcaabD1Game(m.ticker)).filter((m) => occ(m) <= Date.now() + (ncaabHours + 3) * 3600e3)
        .sort((a, b) => occ(a) - occ(b)).slice(0, num(env.POLY_SNIPER_NCAAB_MAX_TICKERS, 200));
      index.ingestMarkets(c); ncaabT = c.map((m) => String(m.ticker).toUpperCase());
    }
    if (linesBook) {
      const horizon = Date.now() + num(env.POLY_SNIPER_NCAAF_DAYS, 8) * 864e5;
      const series = [['KXNFLSPREAD', horizon], ['KXNFLTOTAL', horizon]];
      if (ncaafBook) series.push(['KXNCAAFSPREAD', horizon], ['KXNCAAFTOTAL', horizon]);
      if (nbaBook) { const h = Date.now() + (nbaHours + 3) * 3600e3; series.push(['KXNBASPREAD', h], ['KXNBATOTAL', h]); }
      const all = [];
      for (const [s, h] of series) { const ms = (await listMarkets(s)).filter(within(h)); index.ingestMarkets(ms); for (const m of ms) all.push(String(m.ticker).toUpperCase()); }
      lineT = all; linesBook.addGamesFromTickers(all);
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
      if (nbaBook) await books(nbaT, (o) => nbaBook.ingestKalshiOrderbooks(o));
      if (ncaabBook) await books(ncaabT, (o) => ncaabBook.ingestKalshiOrderbooks(o));
      if (linesBook) await books(linesBook.mainTickers(lineT), (o) => linesBook.ingestKalshiOrderbooks(o)); // main-line strikes only
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
        if (linesBook) linesBook.ingestRelay(venue, 'nfl', j.quotes || [], { feedLive, polledAt });
        if (ncaafBook) {
          const c = await getJson(lim.relay, `${relayBase}/board?venue=${venue}&league=NCAAF`);
          ncaafBook.ingestRelay(venue, c.quotes || [], { feedLive, polledAt });
          if (linesBook) linesBook.ingestRelay(venue, 'ncaaf', c.quotes || [], { feedLive, polledAt });
        }
        if (nbaBook) {
          const b = await getJson(lim.relay, `${relayBase}/board?venue=${venue}&league=NBA`);
          nbaBook.ingestRelay(venue, b.quotes || [], { feedLive, polledAt });
          if (linesBook) linesBook.ingestRelay(venue, 'nba', b.quotes || [], { feedLive, polledAt });
        }
        if (ncaabBook && venue !== 'prophetx') { // moneylines only; the relay has no ProphetX college basketball
          const cb = await getJson(lim.relay, `${relayBase}/board?venue=${venue}&league=NCAAB`);
          ncaabBook.ingestRelay(venue, cb.quotes || [], { feedLive, polledAt });
        }
      } catch (e) { log(`[POLY-SNIPER] relay ${venue} board: ${e.message}`); }
      if (tdOff.has(venue) && Date.now() - tdOff.get(venue) < 10 * 60 * 1000) continue;
      try {
        const t = await getJson(lim.relay, `${relayBase}/td?venue=${venue}&league=NFL`);
        tdOff.delete(venue); tdBook.ingestVenue(venue, t.markets || [], { polledAt });
      } catch (e) { if (/HTTP 503/.test(e.message)) tdOff.set(venue, Date.now()); }
    }
    if (linesBook && venues.includes('polymarket')) { // Polymarket US spreads/totals (relay /lines, public gateway books)
      for (const [lg, L] of [['NFL', 'nfl'], ...(ncaafBook ? [['NCAAF', 'ncaaf']] : []), ...(nbaBook ? [['NBA', 'nba']] : [])]) {
        try { const j = await getJson(lim.relay, `${relayBase}/lines?venue=polymarket&league=${lg}`); linesBook.ingestRelay('polymarket', L, j.quotes || []); } catch (e) { log(`[POLY-SNIPER] relay polymarket lines ${L}: ${e.message}`); }
      }
    }
    health.relay = Date.now();
  }
  // Live NFL TD player crosswalk (public GETs, own slow limiter so it never starves the books).
  const xwLim = createLimiter({ name: 'poly_sniper_xwalk', ratePerSec: num(env.POLY_SNIPER_XWALK_RPS, 1), burst: 1 });
  const xwalk = { players: 0, at: 0 };
  function onCrosswalk(r) {
    index.setPropIdx(r.idx);
    xwalk.players = r.players.length; xwalk.at = Date.now();
    const s = index.tdStats();
    log(`[POLY-SNIPER] td crosswalk players=${r.players.length} td_indexed=${s.indexed}/${s.seen}`);
  }
  async function pollKickoffs() {
    const r = await fetchImpl(ESPN_NFL, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`espn ${r.status}`);
    kickoffs.setKickoffs(espnKickoffs(await r.json()));
    if (nbaBook) for (const u of espnNbaUrls(Date.now(), 2)) { const c = await fetchImpl(u, { headers: { accept: 'application/json' } }); if (c.ok) kickoffs.setKickoffs(espnNbaKickoffs(await c.json())); }
    if (ncaabBook) for (const u of espnNcaabUrls(Date.now(), 2)) { const c = await fetchImpl(u, { headers: { accept: 'application/json' } }); if (c.ok) kickoffs.setKickoffs(espnNcaabKickoffs(await c.json())); }
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
    startTdCrosswalkRefresher({ getJson: (u) => getJson(xwLim, u), everyMs: num(env.POLY_SNIPER_XWALK_MS, 15 * 60 * 1000), log }).onUpdate(onCrosswalk);
  }
  // Same rule as the sniper: Kalshi books (if used) and relay must be < 30s old.
  function pricesHealthy(nowMs = Date.now()) {
    const fresh = (t) => t > 0 && nowMs - t < 30000;
    return (!venues.includes('kalshi') || fresh(health.ml)) && (!relayBase || fresh(health.relay));
  }
  return { start, stop: () => { stopped = true; timers.forEach(clearTimeout); }, pmLive, tdBook, ncaafBook, linesBook, nbaBook, ncaabBook, lineMeta, kickoffs, index, venues, pricesHealthy, health, xwalk, depths: { game: gameDepth, td: tdDepth } };
}
module.exports = { createPolySniperFeed, fairVenues, createLineMetaCache };
