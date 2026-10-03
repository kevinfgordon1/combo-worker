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
// Two shadow quoters share one book: PRIMARY = env config (service: 10% over mid,
// lock guardrail off) and LOCKCF = same with the lock guardrail ON (counterfactual).
'use strict';
const { normalizePem, authHeaders } = require('../kalshi-auth');
const { createNflBook } = require('./book');
const { createNoBoostShadow, classifyNfl } = require('./shadow');
const { createPaperRun } = require('./paper');
const { createStore } = require('./store');
const { isNoBoostShadow, isNoBoostLive, configFromEnv } = require('./quote');
const { teamCode, etDate } = require('../mm-paper-odds');
const { gameEntries } = require('./odds-ingest');

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
  const logger = (l) => console.log(l);
  const primary = createNoBoostShadow({ book, env, log: logger, label: 'PRIMARY' });
  const lockcf = createNoBoostShadow({ book, env: { ...env, NOBOOST_GUARDRAIL: 'lock' }, log: logger, label: 'LOCKCF' });
  // PROMO variant (flag-gated, shadow-only): trusted-book consensus fair, fed by the BACKGROUND odds refresher
  const promoOn = ['1', 'true', 'on', 'yes'].includes(String(env.NOBOOST_PROMO || '').toLowerCase());
  const promo = promoOn ? createNoBoostShadow({ book, env: { ...env, NOBOOST_FAIR_METHOD: 'promo', NOBOOST_GUARDRAIL: 'off' }, log: logger, label: 'PROMO' }) : null;
  const store = createStore({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_KEY, log: logger });
  const run = createPaperRun({
    book, primary, lockcf, promo, margin: primary.cfg.margin,
    persist: store.persist, persistStats: store.persistStats,
    samplePct: Number(env.NOBOOST_SAMPLE_PCT) || 2,
  });
  const cfg = primary.cfg;
  console.log(`[NOBOOST] paper run start: margin=${cfg.margin} mode=${cfg.marginMode} fair=${cfg.fairMethod} guardrail=${cfg.guardrail} (+LOCKCF guardrail=lock)${promo ? ' (+PROMO trusted-book consensus fair)' : ''} maxLegs=${cfg.maxLegs} — GET-only, no WS, no orders`);

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
  async function refreshOdds() {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/odds_cache?sport=eq.americanfootball_nfl&select=data,fetched_at&order=fetched_at.desc&limit=1`,
      { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } });
    if (!r.ok) throw new Error(`odds_cache ${r.status}`);
    const j = await r.json();
    applyPinnacle(book, j[0] && j[0].data);
    if (promoOn) {
      const nGames = book.setBooks(gameEntries(j[0] && j[0].data), j[0] && j[0].fetched_at ? Date.parse(j[0].fetched_at) : Date.now());
      if (!refreshOdds.logged || Date.now() - refreshOdds.logged > 600000) { refreshOdds.logged = Date.now(); console.log(`[NOBOOST] promo books ingested for ${nGames} games (odds_cache fetched_at=${j[0] && j[0].fetched_at})`); }
    }
  }

  let rfqWm = Math.floor(Date.now() / 1000) - 3;
  const seen = new Set();
  async function pollRfqs() {
    const minTs = rfqWm - 1;
    let cursor = ''; let maxCr = rfqWm;
    for (let pg = 0; pg < 8; pg += 1) {
      const j = await get(`${P}/communications/rfqs?status=open&limit=1000&min_ts=${minTs}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const r of j.rfqs || []) {
        const createdMs = Date.parse(r.created_ts);
        if (Number.isFinite(createdMs)) maxCr = Math.max(maxCr, Math.floor(createdMs / 1000));
        if (!r.id || seen.has(r.id)) continue;
        seen.add(r.id);
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
    if (seen.size > 400000) seen.clear();
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
        run.onTrade({
          id: t.trade_id, ticker: t.ticker, yes: Number(t.yes_price_dollars), count: Number(t.count_fp),
          takerSide: t.taker_side, ms,
        });
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
    const res = j.market && (j.market.result === 'yes' || j.market.result === 'no') ? j.market.result : null;
    if (res) resCache.set(ticker, res);
    return res;
  }

  // restore open simulated fills so exposure survives a restart
  try {
    const rows = await store.loadOpenFills();
    let n = 0;
    for (const row of rows) {
      const cls = classifyNfl({ legKeys: row.legs }, 'kalshi');
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
  store.start();
  book.onMove(() => { try { run.sweep(); } catch (e) { console.log(`[NOBOOST] sweep error: ${e.message}`); } });
  loop(refreshMarkets, 'markets', Number(env.NOBOOST_MARKETS_POLL_MS) || 2000);
  loop(pollRfqs, 'rfqs', Number(env.NOBOOST_RFQ_POLL_MS) || 1000);
  loop(pollTrades, 'trades', Number(env.NOBOOST_TRADES_POLL_MS) || 2000);
  loop(refreshOdds, 'odds', 60000);
  loop(() => run.settle(legResult), 'settle', 300000);
  setInterval(() => { try { run.sweep(); run.expire(); } catch (e) { console.log(`[NOBOOST] sweep error: ${e.message}`); } }, 1000);
  setInterval(() => {
    const s = run.flushStats();
    console.log(`[NOBOOST] SUMMARY seen=${s.seen} oos=${s.out_of_scope} dec_ms p50<=${s.dec_ms_p50} p99<=${s.dec_ms_p99} legAge_ms p50<=${s.leg_age_ms_p50} p99<=${s.leg_age_ms_p99} detect_ms p50<=${s.detect_lag_ms_p50} p99<=${s.detect_lag_ms_p99} pending=${s.pending} openFills=${s.open_fills} primary_total_maxloss=$${Math.round(s.positions.primary.totalLoss)} lockcf=$${Math.round(s.positions.lockcf.totalLoss)}${s.positions.promo ? ` promo=$${Math.round(s.positions.promo.totalLoss)}` : ''}`);
  }, 60000);
  process.on('SIGTERM', async () => { try { run.flushStats(); await store.flush(); } finally { process.exit(0); } });
}

if (require.main === module) main();
module.exports = { main, createGetter, applyPinnacle };
