// No-boost RFQ PAPER run — separate Railway service. READ-ONLY toward Kalshi
// (HTTP GETs only), writes ONLY to our own Supabase paper tables.
//   * NO WebSocket (Kalshi allows one communications WS per key; that is combo-worker's).
//   * NO quote create/confirm/cancel. NOBOOST_LIVE set => refuses to start.
//   * Never fetches sportsbook data on the RFQ path: Pinnacle no-vig refs are pushed
//     into the in-memory book by a background refresher (odds_cache, every 60s).
//
// Loops (all background; the RFQ decision itself is in-memory lookup + multiply):
//   markets  GET /markets?series_ticker=KXNFLGAME          every NOBOOST_MARKETS_POLL_MS (2000)
//   rfqs     GET /communications/rfqs?status=open&min_ts=…           every NOBOOST_RFQ_POLL_MS     (1000)
//   trades   GET /markets/trades?min_ts=…&mve_filter=only  every NOBOOST_TRADES_POLL_MS  (2000)
//   settle   GET /markets/{leg}  (result)                  every 300s
//   odds     Supabase odds_cache (Pinnacle ref + PROMO trusted books) every 60s
//   kickoff  ESPN NFL scoreboard (date + pre/in/post)       every 60s  (+ odds_cache commence_time)
// Two shadow quoters share one book: PRIMARY = env config (service: 10% over mid,
// lock guardrail off) and LOCKCF = same with the lock guardrail ON (counterfactual).
//
// RUN TAG: every row / stats payload carries run_id (NOBOOST_RUN_ID, default DEFAULT_RUN_ID).
// A new run_id starts with EMPTY paper risk books (only that run's open fills are restored).
'use strict';
const { normalizePem, authHeaders } = require('../kalshi-auth');
const { createNflBook } = require('./book');
const { createNoBoostShadow, classifyNfl } = require('./shadow');
const { createPaperRun } = require('./paper');
const { createStore } = require('./store');
const { isNoBoostShadow, isNoBoostLive, configFromEnv } = require('./quote');
const { teamCode, etDate } = require('../mm-paper-odds');
const { gameEntries } = require('./odds-ingest');
const { createTtlSet } = require('./ttl-set');
const { createTdBook, isTdTicker } = require('./td-book');
const { espnKickoffs, oddsKickoffs } = require('./kickoffs');
const { createPmLiveBook } = require('./pm-live');
const { createProphetXClient, hasProphetXCreds } = require('./prophetx-live');
const { priceCombo } = require('./quote');
const { pmFields } = require('./paper');
const { createPolyRfqTracker, normalizePolyRfq, normalizePolyTrade } = require('./poly-rfq');

// v2 = matching-window / TTL seen-set / eviction / real-kickoff fixes (2026-10-07). Bump for a clean run.
const DEFAULT_RUN_ID = 'v2-20261007';
const ESPN_NFL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

const ORIGIN = 'https://api.elections.kalshi.com';
const P = '/trade-api/v2';

function createGetter(env = process.env, fetchImpl = fetch) {
  const keyId = env.KALSHI_KEY_ID;
  const pem = normalizePem(env.Kalshi_combo_key || env.KALSHI_PRIVATE_KEY || '');
  return async function get(path) {
    for (let i = 0; i < 3; i += 1) {
      const h = authHeaders({ keyId, pem, method: 'GET', signPath: path.split('?')[0] });
      const r = await fetchImpl(ORIGIN + path, { headers: h });
      if (r.status === 429) { await new Promise((res) => setTimeout(res, 400 * (i + 1))); continue; }
      if (!r.ok) throw new Error(`GET ${path.split('?')[0]} -> ${r.status}`);
      return r.json();
    }
    throw new Error(`GET ${path.split('?')[0]} -> 429`);
  };
}

// Pinnacle h2h no-vig prob per team from odds_cache -> book.setReference (diagnostic only)
function applyPinnacle(book, games) {
  let n = 0;
  for (const g of games || []) {
    const pin = (g.bookmakers || []).find((b) => String(b.key).toLowerCase() === 'pinnacle');
    const h2h = pin && (pin.markets || []).find((m) => m.key === 'h2h');
    if (!h2h || h2h.outcomes.length !== 2) continue;
    const imp = (a) => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
    const ps = h2h.outcomes.map((o) => imp(Number(o.price)));
    const tot = ps[0] + ps[1];
    const codes = h2h.outcomes.map((o) => teamCode('nfl', o.name));
    const date = etDate(g.commence_time);
    if (!date || codes.some((c) => !c)) continue;
    const gameId = `nfl|${date}|${[...codes].sort().join('+')}`;
    h2h.outcomes.forEach((o, i) => { book.setReference(gameId, codes[i], ps[i] / tot); n += 1; });
  }
  return n;
}

async function main(env = process.env) {
  if (isNoBoostLive(env)) { console.error('[NOBOOST] NOBOOST_LIVE set — paper-only service refuses to start'); process.exit(1); }
  if (!isNoBoostShadow(env)) {
    console.log('[NOBOOST] NOBOOST_SHADOW is off (default) — idle.');
    setInterval(() => {}, 1 << 30);
    return;
  }
  const get = createGetter(env);
  const book = createNflBook({ staleMs: Number(env.NOBOOST_STALE_MS) || 15000 });
  // NFL anytime-TD legs (flag NOBOOST_TD=1). Books come from Kalshi PUBLIC orderbooks
  // (unauthenticated GETs, separate from the shared key's budget), $500 depth gate per side.
  const tdOn = ['1', 'true', 'on', 'yes'].includes(String(env.NOBOOST_TD || '').toLowerCase());
  // Extra TD venues for the Combo Sniper inverse (pm_inverse only), from the odds relay's /td.
  // NOBOOST_TD_VENUES=polymarket,novig. Unset = Kalshi only, exactly as before.
  const tdVenues = String(env.NOBOOST_TD_VENUES || '').toLowerCase().split(',').map((x) => x.trim()).filter((x) => x === 'polymarket' || x === 'novig');
  const tdBook = tdOn ? createTdBook({
    staleMs: Number(env.NOBOOST_TD_STALE_MS) || 15000,
    depthUsd: Number(env.NOBOOST_TD_DEPTH_USD) || 500,
    maxOverround: Number(env.NOBOOST_TD_MAX_OVERROUND) || 0.15,
    venues: tdVenues,
  }) : null;
  if (tdBook) book.setTdBook(tdBook);
  const logger = (l) => console.log(l);
  const primary = createNoBoostShadow({ book, env, log: logger, label: 'PRIMARY' });
  const lockcf = createNoBoostShadow({ book, env: { ...env, NOBOOST_GUARDRAIL: 'lock' }, log: logger, label: 'LOCKCF' });
  // PROMO variant (flag-gated, shadow-only): trusted-book consensus fair, fed by the BACKGROUND odds refresher
  const promoOn = ['1', 'true', 'on', 'yes'].includes(String(env.NOBOOST_PROMO || '').toLowerCase());
  const promo = promoOn ? createNoBoostShadow({ book, env: { ...env, NOBOOST_FAIR_METHOD: 'promo', NOBOOST_GUARDRAIL: 'off' }, log: logger, label: 'PROMO' }) : null;
  const runId = String(env.NOBOOST_RUN_ID || DEFAULT_RUN_ID).trim() || DEFAULT_RUN_ID;
  const store = createStore({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_KEY, log: logger, runId });
  // PM live inverse fair (Combo Sniper): Kalshi public orderbooks + odds-relay Polymarket US / Novig + ProphetX.
  const pmOn = !['0', 'false', 'off', 'no'].includes(String(env.NOBOOST_PM_LIVE || '1').toLowerCase());
  const pmLive = pmOn ? createPmLiveBook({ staleMs: Number(env.NOBOOST_PM_STALE_MS) || 15000 }) : null;
  if (pmLive && tdBook) pmLive.setTdBook(tdBook);
  const relayBase = env.NOBOOST_ODDS_RELAY_URL || (env.RAILWAY_SERVICE_ODDS_RELAY_URL ? `https://${env.RAILWAY_SERVICE_ODDS_RELAY_URL}` : '');
  const run = createPaperRun({
    book, primary, lockcf, promo, pmLive, margin: primary.cfg.margin, runId,
    persist: store.persist, persistStats: store.persistStats,
    samplePct: Number(env.NOBOOST_SAMPLE_PCT) || 2,
    graceMs: env.NOBOOST_MATCH_GRACE_MS != null && env.NOBOOST_MATCH_GRACE_MS !== '' ? Number(env.NOBOOST_MATCH_GRACE_MS) : 2000,
    tradeLagMs: Number(env.NOBOOST_TRADE_LAG_MS) || 15000,
  });
  const cfg = primary.cfg;
  const commit = String(env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'local';
  console.log(`[NOBOOST] paper run start: run_id=${runId} commit=${commit} margin=${cfg.margin} mode=${cfg.marginMode} fair=${cfg.fairMethod} guardrail=${cfg.guardrail} (+LOCKCF guardrail=lock)${promo ? ' (+PROMO trusted-book consensus fair)' : ''} maxLegs=${cfg.maxLegs} minQuoteYes=${cfg.minQuoteYes} quoteTtlMs=${run.ttlMs} maxOpenQuotes=${primary.risk.cfg.maxOpenQuotes} — GET-only, no WS, no orders`);

  const guard = (fn, name) => async () => { try { await fn(); } catch (e) { console.log(`[NOBOOST] ${name} error: ${e.message}`); } };
  let busy = {};
  const loop = (fn, name, ms) => {
    const g = guard(fn, name);
    setInterval(async () => { if (busy[name]) return; busy[name] = true; try { await g(); } finally { busy[name] = false; } }, ms);
  };

  async function refreshMarkets() {
    let cursor = '';
    for (let i = 0; i < 4; i += 1) {
      const j = await get(`${P}/markets?series_ticker=KXNFLGAME&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      book.ingestKalshiMarkets(j.markets || []);
      cursor = j.cursor || '';
      if (!cursor) break;
    }
  }
  // TD market list (every 60s) + their orderbooks (every NOBOOST_TD_POLL_MS, 100 tickers/GET).
  const pubGet = async (path) => {
    const r = await fetch(ORIGIN + path, { headers: { accept: 'application/json' } });
    if (r.status === 429) throw new Error(`public GET ${path.split('?')[0]} -> 429`);
    if (!r.ok) throw new Error(`public GET ${path.split('?')[0]} -> ${r.status}`);
    return r.json();
  };
  let tdTickers = [];
  const tdKick = {};
  async function refreshTdMarkets() {
    const out = []; let cursor = '';
    for (let i = 0; i < 5; i += 1) {
      const j = await pubGet(`${P}/markets?series_ticker=KXNFLTD&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      tdBook.setNames(j.markets || []); // player names for cross-venue matching
      for (const m of j.markets || []) {
        const t = String(m.ticker || '').toUpperCase();
        if (!isTdTicker(t)) continue;
        out.push(t);
        const occ = Date.parse(m.occurrence_datetime || '');
        if (Number.isFinite(occ)) tdKick[t] = occ;
      }
      cursor = j.cursor || '';
      if (!cursor) break;
    }
    tdTickers = out;
  }
  async function refreshTdBooks() {
    for (let i = 0; i < tdTickers.length; i += 100) {
      const chunk = tdTickers.slice(i, i + 100);
      const j = await pubGet(`${P}/markets/orderbooks?${chunk.map((t) => `tickers=${encodeURIComponent(t)}`).join('&')}`);
      tdBook.ingest(j.orderbooks || [], tdKick);
      if (i + 100 < tdTickers.length) await new Promise((res) => setTimeout(res, 150));
    }
  }

  async function refreshOdds() {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/odds_cache?sport=eq.americanfootball_nfl&select=data,fetched_at&order=fetched_at.desc&limit=1`,
      { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } });
    if (!r.ok) throw new Error(`odds_cache ${r.status}`);
    const j = await r.json();
    applyPinnacle(book, j[0] && j[0].data);
    book.setKickoffs(oddsKickoffs(j[0] && j[0].data)); // real commence_time (ESPN overrides when it has the game)
    if (promoOn) {
      const nGames = book.setBooks(gameEntries(j[0] && j[0].data), j[0] && j[0].fetched_at ? Date.parse(j[0].fetched_at) : Date.now());
      if (!refreshOdds.logged || Date.now() - refreshOdds.logged > 600000) { refreshOdds.logged = Date.now(); console.log(`[NOBOOST] promo books ingested for ${nGames} games (odds_cache fetched_at=${j[0] && j[0].fetched_at})`); }
    }
  }

  async function refreshKickoffs() {
    const r = await fetch(ESPN_NFL, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`espn scoreboard ${r.status}`);
    const n = book.setKickoffs(espnKickoffs(await r.json()));
    if (!refreshKickoffs.logged || Date.now() - refreshKickoffs.logged > 3600000) { refreshKickoffs.logged = Date.now(); console.log(`[NOBOOST] ESPN kickoffs ingested for ${n} games`); }
  }

  // Seen-set with TIME expiry (no more clear-at-400k => no reprocessing / orphaned RFQs).
  // An id is remembered >= SEEN_TTL; RFQs created more than MAX_RFQ_AGE ago (< SEEN_TTL) are never
  // treated as new, so an RFQ can be processed at most once no matter how long it stays open.
  const SEEN_TTL_MS = 180000; const MAX_RFQ_AGE_MS = 120000;
  let rfqWm = Math.floor(Date.now() / 1000) - 3;
  const seen = createTtlSet({ ttlMs: SEEN_TTL_MS, maxPerGen: 2000000 });
  const rfqStats = { stale_skipped: 0 };
  async function pollRfqs() {
    const minTs = rfqWm - 1;
    let cursor = ''; let maxCr = rfqWm;
    for (let pg = 0; pg < 8; pg += 1) {
      const j = await get(`${P}/communications/rfqs?status=open&limit=1000&min_ts=${minTs}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const nowMs = Date.now();
      for (const r of j.rfqs || []) {
        const createdMs = Date.parse(r.created_ts);
        if (Number.isFinite(createdMs)) maxCr = Math.max(maxCr, Math.floor(createdMs / 1000));
        if (!r.id || !seen.addIfNew(r.id)) continue;
        if (Number.isFinite(createdMs) && nowMs - createdMs > MAX_RFQ_AGE_MS) { rfqStats.stale_skipped += 1; continue; }
        const legs = r.mve_selected_legs || [];
        if (!legs.length) continue;
        const keys = legs.map((l) => `${String(l.market_ticker).toUpperCase()}:${l.side || 'yes'}`);
        run.onRfq({
          rfqId: r.id, marketTicker: r.market_ticker, legKeys: keys, createdMs,
          contracts: r.contracts_fp != null ? Number(r.contracts_fp) : 0,
          targetCostDollars: r.target_cost_dollars != null ? Number(r.target_cost_dollars) : 0,
        });
      }
      cursor = j.cursor || '';
      if (!cursor) break;
    }
    rfqWm = maxCr;
  }

  let tradeWm = Math.floor(Date.now() / 1000) - 3;
  async function pollTrades() {
    const minTs = tradeWm - 1;
    let cursor = ''; let maxT = tradeWm;
    for (let pg = 0; pg < 10; pg += 1) {
      const j = await get(`${P}/markets/trades?limit=1000&mve_filter=only&min_ts=${minTs}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const t of j.trades || []) {
        const ms = Date.parse(t.created_time);
        if (Number.isFinite(ms)) maxT = Math.max(maxT, Math.floor(ms / 1000));
        if (t.is_block_trade) continue;
        const rec = run.onTrade({
          id: t.trade_id, ticker: t.ticker, yes: Number(t.yes_price_dollars), count: Number(t.count_fp),
          takerSide: t.taker_outcome_side || t.taker_side, ms, // taker_side is deprecated upstream
        });
        const filled = rec ? Object.keys(run.variants).filter((n) => rec[n] && rec[n].fill) : [];
        if (filled.length) {
          console.log(`[NOBOOST] PAPER_FILL run_id=${runId} rfq=${rec.rfq_id} variants=${filled.join(',')} trade_after_seen_ms=${rec.traded_ms - rec.seen_ms} quote_ttl_ms=${run.ttlMs} traded_yes=${rec.traded_yes} contracts=${rec.traded_contracts} size_ratio=${rec.size_ratio} candidates=${rec.match_candidates}${rec.match_ambiguous ? ' AMBIGUOUS' : ''}`);
        }
      }
      cursor = j.cursor || '';
      if (!cursor) break;
    }
    tradeWm = maxT;
  }

  const resCache = new Map();
  async function legResult(ticker) {
    if (resCache.has(ticker)) return resCache.get(ticker);
    const j = await get(`${P}/markets/${ticker}`);
    const m = j.market || {};
    const result = String(m.result || '').toLowerCase(); const status = String(m.status || '').toLowerCase();
    let res = null;
    if (result === 'yes' || result === 'no') res = result;
    else if (/void|cancel/.test(result) || /void|cancel/.test(status)) res = 'void'; // push / voided leg
    if (res) resCache.set(ticker, res);
    return res;
  }

  // restore open simulated fills so exposure survives a restart
  try {
    const rows = await store.loadOpenFills();
    let n = 0;
    for (const row of rows) {
      const cls = classifyNfl({ legKeys: row.legs }, 'kalshi', { td: book.hasTd() });
      if (!cls.ok) continue;
      if (row.primary_fill && run.restoreFill('primary', row, cls.legs)) n += 1;
      if (row.lock_fill && run.restoreFill('lockcf', row, cls.legs)) n += 1;
      if (promo && row.promo_fill && run.restoreFill('promo', row, cls.legs)) n += 1;
      run.openFills.push({ rfq_id: row.rfq_id, legs: row.legs, primary: { fill: !!row.primary_fill }, lockcf: { fill: !!row.lock_fill }, ...(promo ? { promo: { fill: !!row.promo_fill } } : {}) });
    }
    console.log(`[NOBOOST] restored ${n} open paper fills`);
  } catch (e) { console.log(`[NOBOOST] restore error: ${e.message}`); }

  await guard(refreshMarkets, 'markets')();
  await guard(refreshOdds, 'odds')();
  await guard(refreshKickoffs, 'kickoffs')();
  store.start();
  book.onMove(() => { try { run.sweep(); } catch (e) { console.log(`[NOBOOST] sweep error: ${e.message}`); } });
  if (tdBook) {
    await guard(refreshTdMarkets, 'td_markets')();
    await guard(refreshTdBooks, 'td_books')();
    loop(refreshTdMarkets, 'td_markets', 60000);
    loop(refreshTdBooks, 'td_books', Number(env.NOBOOST_TD_POLL_MS) || 5000);
    setInterval(() => { console.log(`[NOBOOST] TD book: markets=${tdTickers.length} books=${tdBook.size()} leg_fails=${JSON.stringify(tdBook.takeFails())}`); }, 300000);
    if (tdVenues.length && relayBase) {
      // Relay /td per venue. A failed fetch just leaves that venue's books to go stale (>15s),
      // and the leg falls back to Kalshi alone.
      const tdRelay = async () => {
        for (const venue of tdVenues) {
          const polledAt = Date.now();
          try {
            const r = await fetch(`${relayBase}/td?venue=${venue}&league=NFL`);
            if (!r.ok) continue;
            const j = await r.json();
            tdBook.ingestVenue(venue, j.markets || [], { polledAt });
          } catch (_) { /* relay down: Kalshi-only fallback */ }
        }
      };
      await guard(tdRelay, 'td_relay')();
      loop(tdRelay, 'td_relay', Number(env.NOBOOST_TD_RELAY_POLL_MS) || 2000);
      setInterval(() => { console.log(`[NOBOOST] TD venues: ${tdVenues.map((v) => `${v}=${tdBook.venueSize(v)}`).join(' ')} match=${JSON.stringify(tdBook.takeMatchStats())}`); }, 300000);
    }
    console.log(`[NOBOOST] TD legs ON: venues=kalshi${tdVenues.map((v) => `+${v}`).join('')} (relay=${relayBase || 'none'}), ${tdTickers.length} anytime-TD markets, $${Number(env.NOBOOST_TD_DEPTH_USD) || 500} depth gate, public orderbooks every ${Number(env.NOBOOST_TD_POLL_MS) || 5000}ms`);
  }
  if (pmLive) {
    let kTickers = [];
    const pmKalshi = async () => {
      if (!kTickers.length || !pmKalshi.at || Date.now() - pmKalshi.at > 60000) {
        const j = await pubGet(`${P}/markets?series_ticker=KXNFLGAME&status=open&limit=1000`);
        kTickers = (j.markets || []).map((m) => String(m.ticker || '').toUpperCase()).filter(Boolean); pmKalshi.at = Date.now();
      }
      for (let i = 0; i < kTickers.length; i += 100) {
        const chunk = kTickers.slice(i, i + 100);
        const j = await pubGet(`${P}/markets/orderbooks?${chunk.map((t) => `tickers=${encodeURIComponent(t)}`).join('&')}`);
        pmLive.ingestKalshiOrderbooks(j.orderbooks || []);
      }
    };
    const pmRelay = async () => {
      if (!relayBase) return;
      const h = await (await fetch(`${relayBase}/health`)).json();
      const st = (h && h.status) || {};
      for (const venue of ['polymarket', 'novig']) {
        const polledAt = Date.now();
        const r = await fetch(`${relayBase}/board?venue=${venue}&league=NFL`);
        if (!r.ok) throw new Error(`relay ${venue} ${r.status}`);
        const j = await r.json();
        // Novig: socket must have actually spoken in the last 15s, not just be "up".
        const nv = (h && h.novig) || {};
        const novigLive = /ws:up/.test(String(st.novig || '')) && Number(nv.lastWsMsgAt) > 0 && polledAt - Number(nv.lastWsMsgAt) < 15000;
        const feedLive = venue === 'polymarket' ? false : novigLive;
        pmLive.ingestRelay(venue, j.quotes || [], { feedLive, polledAt });
      }
    };
    await guard(pmKalshi, 'pm_kalshi')(); await guard(pmRelay, 'pm_relay')();
    loop(pmKalshi, 'pm_kalshi', Number(env.NOBOOST_PM_KALSHI_POLL_MS) || 3000);
    loop(pmRelay, 'pm_relay', Number(env.NOBOOST_PM_RELAY_POLL_MS) || 2000);
    if (hasProphetXCreds(env)) {
      const px = createProphetXClient({ env });
      const pmPx = async () => { pmLive.ingestProphetX(await px.nflMoneylines()); };
      await guard(pmPx, 'pm_prophetx')();
      loop(pmPx, 'pm_prophetx', Number(env.NOBOOST_PM_PX_POLL_MS) || 5000);
    }
    console.log(`[NOBOOST] PM live inverse fair ON: kalshi public orderbooks, relay=${relayBase || 'none'} (polymarket-us, novig), prophetx=${hasProphetXCreds(env) ? 'on' : 'off (no PROPHETX key)'}; games=${pmLive.gameCount()}`);
  }
  // Polymarket US parlay RFQs (Combo Sniper, PAPER ONLY — never quotes). Read-only private WS
  // (SUBSCRIPTION_TYPE_RFQ: rfqCreated / rfqClosed / anonymous rfqTrade prints) + GET /v1/rfqs/trades
  // backfill (1 req/s documented limit; we make ~1 request per NOBOOST_POLY_BACKFILL_MS, skipped while
  // the client's Cloudflare-429 backoff is active). Never calls GET /v1/rfqs (combo-worker's budget).
  const polyOn = !['0', 'false', 'off', 'no'].includes(String(env.NOBOOST_POLY_RFQ || '1').toLowerCase())
    && !!env.POLYMARKET_KEY_ID && !!env.POLYMARKET_SECRET_KEY;
  if (polyOn) {
    const { createPolymarketHttp, createPolymarketRfqWs } = require('../polymarket-client');
    const http = createPolymarketHttp({ keyId: env.POLYMARKET_KEY_ID, secretKey: env.POLYMARKET_SECRET_KEY });
    const promoCfg = promo ? promo.cfg : null;
    const priceFairs = (legs) => {
      const out = {};
      try {
        const pr = priceCombo(legs.map((l) => ({ ...l })), book.source, { cfg: primary.cfg, venue: 'polymarket' });
        if (pr && pr.ok) {
          for (const k of ['fair_mid_american', 'fair_inverse_american', 'lock_american']) out[k] = pr[k] != null ? Math.round(pr[k]) : null;
          out.fair_ref_american = pr.ref_american != null ? Math.round(pr.ref_american) : null;
          out.max_leg_age_ms = Math.round(pr.maxLegAgeMs || 0);
        }
        if (promoCfg) {
          const pp = priceCombo(legs.map((l) => ({ ...l })), book.source, { cfg: promoCfg, venue: 'polymarket' });
          if (pp && pp.ok) {
            out.fair_promo_american = pp.fair_promo_american != null ? Math.round(pp.fair_promo_american) : null;
            out.fair_promo_best_american = pp.fair_promo_best_american != null ? Math.round(pp.fair_promo_best_american) : null;
            out.promo_n_books = pp.promoBooks || null; out.promo_max_age_ms = Math.round(pp.promoAgeMs || 0);
          }
        }
      } catch (e) { out.pm_inverse_reason = 'error'; }
      return { ...out, ...pmFields(pmLive, { ok: true, legs }) };
    };
    const poly = createPolyRfqTracker({ book, priceFairs, persistRow: store.persistRow, runId, samplePct: Number(env.NOBOOST_SAMPLE_PCT) || 2 });
    const comboCache = new Map(); let lastHydrate = 0;
    async function hydrate(rfq) {
      if (Array.isArray(rfq.comboLegs) && rfq.comboLegs.length) return rfq;
      if (!rfq.symbol) return rfq;
      if (comboCache.has(rfq.symbol)) return { ...rfq, comboLegs: comboCache.get(rfq.symbol) };
      if (Date.now() - lastHydrate < 500 || http.isBackedOff('/v1/combos')) return rfq; // <=2 req/s, respect 429 backoff
      lastHydrate = Date.now();
      try {
        const j = await http.getCombo(rfq.symbol);
        const c = (j && j.combo) || (j && j.combos && j.combos[0]) || null;
        if (c && Array.isArray(c.legs) && c.legs.length) { comboCache.set(rfq.symbol, c.legs); if (comboCache.size > 20000) comboCache.clear(); return { ...rfq, comboLegs: c.legs }; }
      } catch (e) { /* counted as no_legs */ }
      return rfq;
    }
    const ws = createPolymarketRfqWs({
      keyId: env.POLYMARKET_KEY_ID, secretKey: env.POLYMARKET_SECRET_KEY, subscribeOrders: false,
      onStatus: (s, i) => { console.log(`[NOBOOST][POLY] ws ${s}${i && i.message ? ` ${i.message}` : ''}`); },
      onEvent: (ev) => {
        try {
          if (ev.type === 'rfqCreated') {
            const r = normalizePolyRfq(ev.rfq, Date.now());
            if (r) hydrate(r).then((h) => poly.onRfq(h)).catch(() => {});
          } else if (ev.type === 'rfqClosed') poly.onClosed(ev.rfq);
          else if (ev.type === 'other') {
            const t = ev.raw && ev.raw.rfqEvent && ev.raw.rfqEvent.rfqTrade;
            if (t) poly.onTrade(normalizePolyTrade(t.trade || t));
          }
        } catch (e) { console.log(`[NOBOOST][POLY] event error: ${e.message}`); }
      },
    });
    ws.start();
    // Overlapping-window backfill: last NOBOOST_POLY_BACKFILL_WINDOW_MS (default 5 min) every 90s, deduped by tradeId.
    async function polyBackfill() {
      if (http.isBackedOff('/v1/rfqs/trades')) return;
      const startTime = new Date(Date.now() - (Number(env.NOBOOST_POLY_BACKFILL_WINDOW_MS) || 300000)).toISOString();
      let cursor = '';
      for (let pg = 0; pg < 10; pg += 1) {
        const res = await http.request('GET', '/v1/rfqs/trades', { query: { limit: 100, startTime, ...(cursor ? { cursor } : {}) } });
        if (res.statusCode === 429) return; // client backoff now active
        if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`GET /v1/rfqs/trades -> ${res.statusCode}`);
        const j = res.json;
        for (const t of (j && j.trades) || []) poly.onTrade(normalizePolyTrade(t));
        cursor = (j && j.cursor) || '';
        if (!cursor) break;
        await new Promise((res) => setTimeout(res, 1100)); // documented 1 req/s on this endpoint
      }
    }
    loop(polyBackfill, 'poly_backfill', Number(env.NOBOOST_POLY_BACKFILL_MS) || 90000);
    setInterval(() => { try { poly.sweep(); } catch (e) { console.log(`[NOBOOST][POLY] sweep error: ${e.message}`); } }, 2000);
    setInterval(() => { console.log(`[NOBOOST][POLY] SUMMARY run_id=${runId} ${JSON.stringify(poly.takeStats())}`); }, 60000);
    console.log('[NOBOOST] Polymarket US RFQ logger ON (paper only, never quotes): private WS rfqCreated/rfqClosed/rfqTrade + /v1/rfqs/trades backfill');
  } else {
    console.log('[NOBOOST] Polymarket US RFQ logger off (NOBOOST_POLY_RFQ=0 or no POLYMARKET_KEY_ID/POLYMARKET_SECRET_KEY)');
  }
  loop(refreshMarkets, 'markets', Number(env.NOBOOST_MARKETS_POLL_MS) || 2000);
  loop(pollRfqs, 'rfqs', Number(env.NOBOOST_RFQ_POLL_MS) || 1000);
  loop(pollTrades, 'trades', Number(env.NOBOOST_TRADES_POLL_MS) || 2000);
  loop(refreshOdds, 'odds', 60000);
  loop(refreshKickoffs, 'kickoffs', 60000);
  loop(() => run.settle(legResult), 'settle', 300000);
  setInterval(() => { try { run.sweep(); run.expire(); } catch (e) { console.log(`[NOBOOST] sweep error: ${e.message}`); } }, 1000);
  setInterval(() => {
    const s = run.flushStats();
    const tr = s.trades || {};
    const wq = Object.values(s.by_legs || {}).reduce((a, b) => ({ p: a.p + (b.primary_wq || 0), l: a.l + (b.lockcf_wq || 0), m: a.m + (b.promo_wq || 0), f: a.f + (b.primary_fill || 0) + (b.lockcf_fill || 0) + (b.promo_fill || 0), t: a.t + (b.traded || 0) }), { p: 0, l: 0, m: 0, f: 0, t: 0 });
    const ev = Object.fromEntries(Object.entries(s.positions).map(([k, v]) => [k, v.evictions || 0]));
    console.log(`[NOBOOST] SUMMARY run_id=${runId} seen=${s.seen} oos=${s.out_of_scope} wq(primary/lock/promo)=${wq.p}/${wq.l}/${wq.m} traded=${wq.t} fills=${wq.f} trades: seen=${tr.trades_seen || 0} matched=${tr.matched || 0} ambiguous=${tr.ambiguous || 0} size_mismatch=${tr.size_mismatch || 0} no_candidate=${tr.no_candidate || 0} min_price=${tr.min_price_print || 0} stale_rfq=${rfqStats.stale_skipped} evicted=${JSON.stringify(ev)} mem: recs=${s.in_memory} seenRfq=${seen.size()} seenTrades=${s.seen_trades} rssMB=${Math.round(process.memoryUsage().rss / 1048576)}`);
    rfqStats.stale_skipped = 0;
    console.log(`[NOBOOST] SUMMARY-LAT dec_ms p50<=${s.dec_ms_p50} p99<=${s.dec_ms_p99} legAge_ms p50<=${s.leg_age_ms_p50} p99<=${s.leg_age_ms_p99} detect_ms p50<=${s.detect_lag_ms_p50} p99<=${s.detect_lag_ms_p99} pending=${s.pending} openFills=${s.open_fills} primary_total_maxloss=$${Math.round(s.positions.primary.totalLoss)} lockcf=$${Math.round(s.positions.lockcf.totalLoss)}${s.positions.promo ? ` promo=$${Math.round(s.positions.promo.totalLoss)}` : ''}`);
  }, 60000);
  process.on('SIGTERM', async () => { try { run.flushStats(); await store.flush(); } finally { process.exit(0); } });
}

if (require.main === module) main();
module.exports = { main, createGetter, applyPinnacle, DEFAULT_RUN_ID };
