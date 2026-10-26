// Isolated Auto-Sniper service (WORKER_MODE=sniper, start-sniper.js). DRY RUN by default.
//
// Isolation: own Railway service/process; reads Kalshi RFQs from its own WebSocket
// (no REST polling of /communications), prices from Kalshi PUBLIC orderbooks
// (unauthenticated) + our odds-relay (/board, /td) + optional ProphetX, each behind its own
// rate limiter; writes ONLY sniper_ledger / sniper_decisions; reads combo_parlays /
// combo_submissions to give Combo Locks priority.
// LIVE only when sniper/gates.liveGate passes (SNIPER_ENABLED=1, SNIPER_DRY_RUN=0,
// SNIPER_LIVE_CONFIRM token, own key). Otherwise every quote/confirm/cancel is refused.
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { createIntakeWorker } = require('./intake-host');
const { maybeStartCpuProfile } = require('./cpu-prof');
const { withBreaker, getDbBreaker } = require('../db-breaker');
const { createBatchedLedgerStore, ledgerBatchEnabled } = require('./ledger-batch');
const { createReleaseBatcher, withReserveTimeout, isSkipDecision } = require('./release-batch');
const { writeBehindEnabled, createWriteBehindStore, memoryCapReason, isLongPos } = require('./write-behind');
const { createKalshiFirehose, readShardFactor, DEFAULT_LIVE_SHARD_FACTOR, summarizeThroughput } = require('../kalshi-ws');
const { normalizePem, authHeaders: kalshiAuthHeaders } = require('../kalshi-auth');
const { createKalshiBookFeed, createBookRouter } = require('./book-ws');
const WebSocket = require('ws');
const { createPmLiveBook } = require('../noboost/pm-live');
const { createTdBook, isTdTicker } = require('../noboost/td-book');
const { createProphetXClient, hasProphetXCreds, authMode } = require('../noboost/prophetx-live');
const { createSeriesFeeCache, seriesOfTicker } = require('../series-fee');
const { sniperConfig, createSniperLedger, formatDecision, createTelegramNotifier } = require('../auto-sniper');
const { createLimiter, createRateBreaker } = require('./limiter');
const { sniperKalshiTradeBudget } = require('./kalshi-budget');
const { borrowConfig, startBorrower } = require('./kalshi-lane');
const { fetchWithTimeout } = require('./fetch-timeout');
const { createStaleAlert } = require('./stale-alert');
const { createLedgerStore } = require('./ledger-store');
const { createBookArbWatch } = require('./book-arb-watch');
const { loadBookData } = require('./book-arb');
const { venuesFromEnv } = require('./fair');
const { createCloseSnapshot } = require('./close-snapshot');
const { RESERVE_TTL_MS } = require('../reserve');
const { rogueConfig, americanOf } = require('./rogue');
const { decide, repriceFair, pregameCheck } = require('./engine');
const { liveGate, sniperSubaccount } = require('./gates');
const { createSniperTrader } = require('./trader');
const { createSoonCap } = require('./soon-cap');
const { createLockCoord } = require('./coord');
const { createLiveSniper } = require('./live');
const { capsFrom } = require('./ledger-store');
const { createNightlyRecap } = require('./recap');
const { createSniperFrameFilter, needleAllDisabled, createNflFrameFilter, createDeletedFilter, createDeletedIdFilter, tooOld, createLatencyStats, createLoopLagSampler, NFL_NEEDLES, NBA_NEEDLES } = require('./intake');
const { signedNow } = require('../kalshi-auth');
const { rfqAgeMs } = require('../quote-sender');
const { createKickoffResolver, ESPN_NFL } = require('./kickoff');
const { espnKickoffs, oddsKickoffs } = require('../noboost/kickoffs');
const { createNcaafBook, espnNcaafKickoffs, oddsNcaafKickoffs, ESPN_NCAAF, isFbsGame } = require('./ncaaf');
const { createLinesBook } = require('./lines');
const { createNbaBook, espnNbaKickoffs, espnNbaUrls } = require('./nba');

const ORIGIN = 'https://api.elections.kalshi.com';
const P = '/trade-api/v2';
const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const log = (m) => console.log(m);

// Midnight ET for the ET day containing ms (DST-correct: EDT -04:00 / EST -05:00).
function etDayStartIso(ms) {
  const d = new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (const off of ['-04:00', '-05:00']) {
    const t = new Date(`${d}T00:00:00${off}`);
    const h = new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' });
    if (Number(h) === 0 && new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === d) return t.toISOString();
  }
  return new Date(`${d}T00:00:00-05:00`).toISOString();
}

async function main(env = process.env) {
  const config = sniperConfig(env);
  // Resting-quote controls (Oct 25 2026). Each has its own switch; see PR.
  //  SNIPER_QUOTE_TTL_MS: unaccepted quote life (old 20000). All 35 fills in 36h came 3.1-10.1s after reserve.
  //  SNIPER_RESTING_CAP_WEIGHT: share of a resting quote's risk counted toward total/game/leg caps (1 = old).
  //  SNIPER_RESERVE_LOCK: 'combo' = per-bet lock in sniper_reserve (needs migration 20261025b), 'global' = old.
  const quoteTtlMs = Math.max(5000, num(env.SNIPER_QUOTE_TTL_MS, 12000));
  config.restingCapWeight = Math.min(1, Math.max(0, num(env.SNIPER_RESTING_CAP_WEIGHT, 0.5)));
  config.reserveLock = String(env.SNIPER_RESERVE_LOCK || 'combo') === 'global' ? 'global' : 'combo';
  const venues = venuesFromEnv(env);
  const depth = num(env.SNIPER_FAIR_DEPTH_USD, 1000); // NFL player-TD legs (Kevin: stays $1,000)
  // Game lines (NFL moneyline + college ML, later spreads/totals): Kevin Oct 23 → $2,000 per leg.
  const gameDepth = num(env.SNIPER_GAME_DEPTH_USD, 2000);
  const tg = createTelegramNotifier(env);
  // Every sniper Telegram message is labelled so it can never be read as a Combo Locks alert.
  const tgLabel = (m) => (/^🎯 SNIPER/.test(m) ? m : `🎯 SNIPER (not Combo Locks) — ${String(m).replace(/^\[SNIPER\]\s*/, '')}`);
  const alert = (m) => { log(m); if (tg) tg(tgLabel(m)); };
  if (!config.enabled) { log('[SNIPER] SNIPER_ENABLED is off — idling (kill switch).'); setInterval(() => {}, 1 << 30); return; }
  const gate = liveGate(env);
  config.dryRun = !gate.live;
  if (String(env.SNIPER_DRY_RUN) === '0' && !gate.live) alert(`[SNIPER] SNIPER_DRY_RUN=0 but live gate closed (${gate.why.join(', ')}) — staying DRY RUN.`);
  log(`[SNIPER] boot enabled=${config.enabled} mode=${gate.live ? 'LIVE' : 'DRY_RUN'} depth=game:$${gameDepth},td:$${depth} venues=${venues.join('+')} prophetx=${hasProphetXCreds(env) ? 'on' : 'off'} minEdge=ml:${(config.minRoi * 100).toFixed(1)}%,lines:${(config.minRoiLines * 100).toFixed(1)}%,td:${(config.minRoiTd * 100).toFixed(1)}% ncaaf=${config.ncaaf ? `on(min ${(config.minRoiNcaaf * 100).toFixed(1)}%)` : 'off'} lines=${String(env.SNIPER_LINES || '0') === '1' ? 'on' : 'off'} nba=${config.nba ? `on(min ${(config.minRoiNba * 100).toFixed(1)}%, ${config.nbaHours}h)` : 'off'} caps=total:$${config.totalExposureCap},long:$${config.longExposureCap}(>${config.shortSettleHours}h),game:$${config.perGameCap},leg:$${config.perLegCap},quote:$${config.maxRisk},dailyRisk:$${config.dailyRiskCap},dailyLoss:$${config.dailyLossCap}`);
  // Effective caps after env overrides, published on every summary heartbeat so the dashboard
  // header can't drift from what the sniper actually enforces (audit Oct 24).
  const effectiveCaps = { totalOpen: config.totalExposureCap, longDatedOpen: config.longExposureCap, perGame: config.perGameCap, perLeg: config.perLegCap, dailyLoss: config.dailyLossCap, dailyNewRisk: config.dailyRiskCap, perQuoteRisk: config.maxRisk, minEdge: config.minRoi, minEdgeLines: config.minRoiLines, minEdgeNcaaf: config.minRoiNcaaf, minEdgeNba: config.minRoiNba, minEdgeTd: config.minRoiTd, depthGame: gameDepth, depthTd: depth };
  if (gate.live) alert('[SNIPER] ⚠️ LIVE MODE: all gates set — this service will send and confirm real Kalshi RFQ quotes.');

  // ── Request budgets (well under venue limits) ──
  const tradeBudget = sniperKalshiTradeBudget(env);
  if (tradeBudget.clamped) log(`[SNIPER] SNIPER_KALSHI_TRADE_RPS ${tradeBudget.requested} above budget; clamped to ${tradeBudget.rps}/s (account ${tradeBudget.account}/s, Combo Locks reserved ${tradeBudget.reserved}/s)`);
  const lim = {
    kalshi: createLimiter({ name: 'kalshi_public', ratePerSec: num(env.SNIPER_KALSHI_RPS, 2), burst: 3 }),
    relay: createLimiter({ name: 'odds_relay', ratePerSec: num(env.SNIPER_RELAY_RPS, config.ncaaf ? 2 : 1), burst: 2 }), // our own relay; 2/s when NCAAF boards are polled too
    prophetx: createLimiter({ name: 'prophetx', ratePerSec: num(env.SNIPER_PROPHETX_RPS, 0.2), burst: 1 }),
    kalshiSeries: createLimiter({ name: 'kalshi_series', ratePerSec: 0.2, burst: 2 }),
    // signed calls on the sniper's own key (quote POST/confirm/cancel, fills reads)
    // Capped at Kevin's account budget minus the 9/s reserved for his Combo Locks (sniper/kalshi-budget.js).
    kalshiTrade: createLimiter({ name: 'kalshi_trade', ratePerSec: tradeBudget.rps, ratePerSecOn429: tradeBudget.on429, burst: 5, lowShareRps: Math.max(0, num(env.SNIPER_CANCEL_SHARE_RPS, 1)) }),
    // Authenticated reads (fill lookups) use Kalshi's separate Read bucket — keep them off the write lane.
    kalshiTradeRead: createLimiter({ name: 'kalshi_trade_read', ratePerSec: num(env.SNIPER_KALSHI_READ_RPS, 3), burst: 3 }),
    kalshiSettle: createLimiter({ name: 'kalshi_settle', ratePerSec: 0.5, burst: 2 }),
  };
  // Borrow Combo Locks' idle reserved slots (off unless SNIPER_KALSHI_BORROW=1). Fails safe to base.
  const borrowCfg = borrowConfig(env);
  let borrower = null;
  if (borrowCfg.enabled && env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    borrower = startBorrower({ supabase: createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }), limiter: lim.kalshiTrade, baseRps: tradeBudget.rps, reserved: tradeBudget.reserved, cfg: borrowCfg, log });
    // Any sniper 429 stops borrowing for the cooldown (watch the limiter's 429 counter).
    let seen = 0; setInterval(() => { const n = lim.kalshiTrade.stats().r429; if (n > seen) { seen = n; borrower.on429(); } }, 250).unref?.();
    log(`[SNIPER] kalshi borrow ON: base ${tradeBudget.rps}/s + up to ${Math.max(0, tradeBudget.reserved - borrowCfg.safetyRps)}/s of Combo Locks' idle ${tradeBudget.reserved}/s`);
  }
  let disabled = false;
  let liveSniperRef = null; // set once the live sniper exists, so a 429 trip also halts quoting
  const breaker = createRateBreaker({
    max: num(env.SNIPER_MAX_429, 5), windowMs: num(env.SNIPER_429_WINDOW_MS, 10 * 60 * 1000),
    onTrip: (venue, n) => { disabled = true; if (typeof liveSniperRef === 'function') liveSniperRef(); alert(`[SNIPER] AUTO-DISABLED: ${n} rate-limit (429) errors in window (last: ${venue}). All polling stopped. Restart the sniper service to re-enable.`); },
  });
  // Hard per-request deadline (incl. body). Without it a hung socket stalled kalshi_books for minutes.
  const fetchTimeoutMs = num(env.SNIPER_FETCH_TIMEOUT_MS, 8000);
  const getJson = async (limiter, url) => {
    if (disabled) throw new Error('disabled');
    try {
      const r = await limiter.run(() => fetchWithTimeout(fetch, url, { headers: { accept: 'application/json' } }, fetchTimeoutMs));
      return await r.json();
    } catch (e) { if (e.is429) breaker.hit(limiter.stats().name); throw e; }
  };

  // ── Books (own copies, $depth) ──
  const tdVenues = venues.filter((v) => v === 'polymarket' || v === 'novig' || v === 'prophetx');
  const tdBook = createTdBook({ staleMs: 15000, depthUsd: depth, maxOverround: 0.15, venues: tdVenues });
  const pmLive = createPmLiveBook({ staleMs: 15000, depthUsd: gameDepth });
  pmLive.setTdBook(tdBook);
  // College football ML book (same inverse-bet fair, own crosswalk identity). SNIPER_NCAAF=0 = off.
  const ncaafBook = config.ncaaf ? createNcaafBook({ staleMs: 15000, depthUsd: gameDepth }) : null;
  // Main spreads / totals (NFL + FBS college), same $gameDepth per leg. SNIPER_LINES=1 to enable (preview).
  const linesOn = String(env.SNIPER_LINES || '0') === '1';
  const linesBook = linesOn ? createLinesBook({ staleMs: 15000, depthUsd: gameDepth }) : null;
  // NBA moneylines (spreads / totals ride linesBook), same $gameDepth per leg. SNIPER_NBA=1 to enable.
  const nbaBook = config.nba ? createNbaBook({ staleMs: 15000, depthUsd: gameDepth }) : null;
  // Real kickoffs (ESPN > odds_cache > Kalshi occurrence−3h fallback, logged). `kick` keeps the
  // Kalshi estimate per ticker for the td-book's own staleness use.
  const kick = new Map();
  const kickoffs = createKickoffResolver({ log });
  const kickoffFor = (t) => kickoffs.kickoffFor(t);
  const health = { ml: 0, td: 0, relay: 0 };
  const relayBase = env.SNIPER_ODDS_RELAY_URL || (env.RAILWAY_SERVICE_ODDS_RELAY_URL ? `https://${env.RAILWAY_SERVICE_ODDS_RELAY_URL}` : '');

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
  let mlTickers = []; let tdTickers = []; let ncaafTickers = []; let lineTickers = []; let nbaTickers = []; let listedAt = 0;
  async function refreshLists() {
    const ml = await listMarkets('KXNFLGAME'); mlTickers = ml.map((m) => String(m.ticker).toUpperCase());
    if (venues.length) {
      const td = await listMarkets('KXNFLTD'); tdBook.setNames(td);
      tdTickers = td.map((m) => String(m.ticker).toUpperCase()).filter(isTdTicker);
    }
    // College football: only games kicking off within SNIPER_NCAAF_DAYS (default 8) to keep the
    // public-orderbook budget small (~450 open KXNCAAFGAME markets span 2+ weeks).
    if (ncaafBook) {
      const horizon = Date.now() + num(env.SNIPER_NCAAF_DAYS, 8) * 864e5;
      ncaafTickers = (await listMarkets('KXNCAAFGAME')).filter((m) => isFbsGame(m.ticker)).filter((m) => { const o = Date.parse(m.occurrence_datetime || ''); return !Number.isFinite(o) || o <= horizon; }).map((m) => String(m.ticker).toUpperCase());
    }
    if (linesBook) {
      const horizon = Date.now() + num(env.SNIPER_NCAAF_DAYS, 8) * 864e5;
      const all = [];
      for (const s of ['KXNFLSPREAD', 'KXNFLTOTAL', ...(ncaafBook ? ['KXNCAAFSPREAD', 'KXNCAAFTOTAL'] : [])]) {
        for (const m of await listMarkets(s)) { const o = Date.parse(m.occurrence_datetime || ''); if (!Number.isFinite(o) || o <= horizon) all.push(String(m.ticker).toUpperCase()); }
      }
      if (nbaBook) { // NBA: occurrence = tip + 3h; poll only games inside the quoting window (+3h slack)
        const nbaHorizon = Date.now() + (config.nbaHours + 3) * 3600e3;
        for (const s of ['KXNBASPREAD', 'KXNBATOTAL']) {
          for (const m of await listMarkets(s)) { const o = Date.parse(m.occurrence_datetime || ''); if (!Number.isFinite(o) || o <= nbaHorizon) all.push(String(m.ticker).toUpperCase()); }
        }
      }
      lineTickers = all; linesBook.addGamesFromTickers(all);
    }
    if (nbaBook) {
      const nbaHorizon = Date.now() + (config.nbaHours + 3) * 3600e3;
      nbaTickers = (await listMarkets('KXNBAGAME')).filter((m) => { const o = Date.parse(m.occurrence_datetime || ''); return !Number.isFinite(o) || o <= nbaHorizon; }).map((m) => String(m.ticker).toUpperCase());
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
  // NFL ML books (the pricesHealthy gate) poll in their own loop; the slower NCAAF / NBA / lines /
  // TD books run in pollKalshi so a slow or failing chunk there can't stall the gate.
  // Kalshi websocket order books (orderbook_snapshot/delta) on the sniper's OWN read key, sharded
  // to stay under the per-subscription buffer. REST pulls below only run for a group the ws has
  // not refreshed within SNIPER_BOOK_WS_FALLBACK_MS. SNIPER_KALSHI_BOOK_WS=0 = REST only (old path).
  const tdMeta = () => Object.fromEntries([...kick].filter(([t]) => t.startsWith('KXNFLTD')));
  const bookGroups = {
    ml: { tickers: () => mlTickers, sink: (o) => pmLive.ingestKalshiOrderbooks(o), onFresh: (t) => { health.ml = t; } },
    td: { tickers: () => tdTickers, sink: (o) => tdBook.ingest(o, tdMeta()), onFresh: (t) => { health.td = t; } },
    ...(ncaafBook ? { ncaaf: { tickers: () => ncaafTickers, sink: (o) => ncaafBook.ingestKalshiOrderbooks(o) } } : {}),
    ...(nbaBook ? { nba: { tickers: () => nbaTickers, sink: (o) => nbaBook.ingestKalshiOrderbooks(o) } } : {}),
    ...(linesBook ? { lines: { tickers: () => linesBook.mainTickers(lineTickers), sink: (o) => linesBook.ingestKalshiOrderbooks(o) } } : {}),
  };
  const bookWsOn = String(env.SNIPER_KALSHI_BOOK_WS || '1') !== '0' && !!env.SNIPER_KALSHI_KEY_ID && !!env.SNIPER_KALSHI_PRIVATE_KEY;
  const bookFeed = bookWsOn ? createKalshiBookFeed({
    WS: WebSocket, url: env.SNIPER_KALSHI_WS_URL || 'wss://external-api-ws.kalshi.com/trade-api/ws/v2',
    headers: () => kalshiAuthHeaders({ keyId: env.SNIPER_KALSHI_KEY_ID, pem: normalizePem(env.SNIPER_KALSHI_PRIVATE_KEY), method: 'GET', signPath: '/trade-api/ws/v2' }),
    perShard: num(env.SNIPER_BOOK_WS_PER_SHARD, 60), maxShards: num(env.SNIPER_BOOK_WS_MAX_SHARDS, 8),
    quietMs: num(env.SNIPER_BOOK_WS_QUIET_MS, 10000), log,
  }) : null;
  const bookRouter = createBookRouter({ feed: bookFeed, groups: bookGroups, fallbackMs: num(env.SNIPER_BOOK_WS_FALLBACK_MS, 5000) });
  const syncBookTickers = () => { if (bookFeed) bookFeed.setTickers(Object.values(bookGroups).flatMap((g) => g.tickers() || [])); };
  async function pollKalshiMl() {
    if (!listedAt || Date.now() - listedAt > 120000) { await refreshLists(); syncBookTickers(); }
    if (!bookRouter.restNeeded('ml')) return;
    await books(mlTickers, (o) => pmLive.ingestKalshiOrderbooks(o)); health.ml = Date.now();
  }
  async function pollKalshi() {
    if (!listedAt) return;
    if (ncaafBook && bookRouter.restNeeded('ncaaf')) await books(ncaafTickers, (o) => ncaafBook.ingestKalshiOrderbooks(o));
    if (nbaBook && bookRouter.restNeeded('nba')) await books(nbaTickers, (o) => nbaBook.ingestKalshiOrderbooks(o));
    if (linesBook && bookRouter.restNeeded('lines')) await books(linesBook.mainTickers(lineTickers), (o) => linesBook.ingestKalshiOrderbooks(o)); // main-line strikes only
    if (bookRouter.restNeeded('td')) { await books(tdTickers, (o) => tdBook.ingest(o, tdMeta())); health.td = Date.now(); }
  }
  if (bookFeed) { const fl = setInterval(() => { if (!disabled) { try { bookRouter.flush(); } catch (e) { log(`[SNIPER] book-ws flush error: ${e.message}`); } } }, num(env.SNIPER_BOOK_WS_FLUSH_MS, 1000)); if (fl.unref) fl.unref(); }
  const relayErr = {}; const tdOff = new Map();
  async function pollRelay() {
    if (!relayBase) return;
    const h = await getJson(lim.relay, `${relayBase}/health`);
    const st = (h && h.status) || {}; const nv = (h && h.novig) || {};
    for (const venue of ['polymarket', 'novig']) {
      if (!venues.includes(venue)) continue;
      const polledAt = Date.now();
      // Each venue/feed independently: one feed being off (e.g. relay td_off → 503) must not
      // starve the others (it used to skip Novig entirely when Polymarket TD was off).
      try {
        const j = await getJson(lim.relay, `${relayBase}/board?venue=${venue}&league=NFL`);
        const novigLive = /ws:up/.test(String(st.novig || '')) && Number(nv.lastWsMsgAt) > 0 && polledAt - Number(nv.lastWsMsgAt) < 15000;
        pmLive.ingestRelay(venue, j.quotes || [], { feedLive: venue === 'novig' ? novigLive : false, polledAt });
        if (linesBook) linesBook.ingestRelay(venue, 'nfl', j.quotes || [], { feedLive: venue === 'novig' ? novigLive : false, polledAt });
        if (ncaafBook) {
          const c = await getJson(lim.relay, `${relayBase}/board?venue=${venue}&league=NCAAF`);
          ncaafBook.ingestRelay(venue, c.quotes || [], { feedLive: venue === 'novig' ? novigLive : false, polledAt });
          if (linesBook) linesBook.ingestRelay(venue, 'ncaaf', c.quotes || [], { feedLive: venue === 'novig' ? novigLive : false, polledAt });
        }
        if (nbaBook) {
          const b = await getJson(lim.relay, `${relayBase}/board?venue=${venue}&league=NBA`);
          nbaBook.ingestRelay(venue, b.quotes || [], { feedLive: venue === 'novig' ? novigLive : false, polledAt });
          if (linesBook) linesBook.ingestRelay(venue, 'nba', b.quotes || [], { feedLive: venue === 'novig' ? novigLive : false, polledAt });
        }
      } catch (e) { if (/disabled/.test(e.message)) throw e; relayErr[`${venue}_board`] = (relayErr[`${venue}_board`] || 0) + 1; }
      if (tdOff.has(venue) && Date.now() - tdOff.get(venue) < 10 * 60 * 1000) continue; // relay says td_off: re-check every 10 min
      try {
        const t = await getJson(lim.relay, `${relayBase}/td?venue=${venue}&league=NFL`);
        tdOff.delete(venue);
        tdBook.ingestVenue(venue, t.markets || [], { polledAt });
      } catch (e) {
        if (/disabled/.test(e.message)) throw e;
        if (/HTTP 503/.test(e.message)) tdOff.set(venue, Date.now());
        relayErr[`${venue}_td`] = (relayErr[`${venue}_td`] || 0) + 1;
      }
    }
    // NBA ProphetX ML / spreads / totals from the relay's read-only ProphetX feed (no key here).
    if (nbaBook && venues.includes('prophetx')) {
      try {
        const polledAt = Date.now(); const feedLive = /ws:up/.test(String(st.prophetx || ''));
        const b = await getJson(lim.relay, `${relayBase}/board?venue=prophetx&league=NBA`);
        nbaBook.ingestRelay('prophetx', b.quotes || [], { feedLive, polledAt });
        if (linesBook) linesBook.ingestRelay('prophetx', 'nba', b.quotes || [], { feedLive, polledAt });
      } catch (e) { if (/disabled/.test(e.message)) throw e; relayErr.prophetx_nba = (relayErr.prophetx_nba || 0) + 1; }
    }
    // ProphetX player TDs come from the relay's read-only ProphetX feed (/td), not the sniper's key.
    if (venues.includes('prophetx') && !(tdOff.has('prophetx') && Date.now() - tdOff.get('prophetx') < 10 * 60 * 1000)) {
      try {
        const polledAt = Date.now();
        const t = await getJson(lim.relay, `${relayBase}/td?venue=prophetx&league=NFL`);
        tdOff.delete('prophetx');
        tdBook.ingestVenue('prophetx', t.markets || [], { polledAt });
      } catch (e) {
        if (/disabled/.test(e.message)) throw e;
        if (/HTTP 503/.test(e.message)) tdOff.set('prophetx', Date.now());
        relayErr.prophetx_td = (relayErr.prophetx_td || 0) + 1;
      }
    }
    if (linesBook && venues.includes('polymarket')) { // Polymarket US spreads/totals (relay /lines, RELAY_POLY_LINES=1)
      for (const [lg, L] of [['NFL', 'nfl'], ...(ncaafBook ? [['NCAAF', 'ncaaf']] : []), ...(nbaBook ? [['NBA', 'nba']] : [])]) {
        try { const j = await getJson(lim.relay, `${relayBase}/lines?venue=polymarket&league=${lg}`); linesBook.ingestRelay('polymarket', L, j.quotes || []); } catch (e) { if (/disabled/.test(e.message)) throw e; relayErr[`polymarket_lines_${L}`] = (relayErr[`polymarket_lines_${L}`] || 0) + 1; }
      }
    }
    health.relay = Date.now();
  }
  const px = hasProphetXCreds(env) && venues.includes('prophetx') ? createProphetXClient({ env, fetchImpl: (u, o) => lim.prophetx.run(() => fetch(u, o)).catch((e) => { if (e.is429) breaker.hit('prophetx'); throw e; }) }) : null;
  const pxRelayNcaaf = px && ncaafBook && relayBase && authMode(env) === 'relay';
  async function pollPx() {
    if (!px) return;
    pmLive.ingestProphetX(await px.nflMoneylines());
    if (pxRelayNcaaf) { // NCAAF ProphetX from the relay board (same crosswalk; unmatched teams skipped)
      const polledAt = Date.now(); const h = await getJson(lim.relay, `${relayBase}/health`);
      const feedLive = /ws:up/.test(String((h && h.status && h.status.prophetx) || ''));
      const c = await getJson(lim.relay, `${relayBase}/board?venue=prophetx&league=NCAAF`);
      ncaafBook.ingestRelay('prophetx', c.quotes || [], { feedLive, polledAt });
      if (linesBook) linesBook.ingestRelay('prophetx', 'ncaaf', c.quotes || [], { feedLive, polledAt });
    }
    if (linesBook && relayBase && authMode(env) === 'relay') { // NFL ProphetX spreads/totals from the relay (no key here)
      const polledAt = Date.now(); const h = await getJson(lim.relay, `${relayBase}/health`);
      const feedLive = /ws:up/.test(String((h && h.status && h.status.prophetx) || ''));
      const j = await getJson(lim.relay, `${relayBase}/board?venue=prophetx&league=NFL`);
      linesBook.ingestRelay('prophetx', 'nfl', j.quotes || [], { feedLive, polledAt });
    }
  }

  const loop = (fn, name, ms) => {
    const tick = async () => {
      if (disabled) return;
      try { await fn(); } catch (e) { if (!/disabled/.test(e.message)) log(`[SNIPER] ${name} error: ${e.message}`); }
      if (!disabled) setTimeout(tick, ms);
    };
    tick();
  };
  loop(pollKalshiMl, 'kalshi_ml_books', num(env.SNIPER_KALSHI_ML_POLL_MS, 3000));
  loop(pollKalshi, 'kalshi_books', num(env.SNIPER_KALSHI_POLL_MS, 5000));
  loop(pollRelay, 'relay', num(env.SNIPER_RELAY_POLL_MS, 3000));
  async function pollKickoffs() {
    const r = await fetch(ESPN_NFL, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`espn scoreboard ${r.status}`);
    kickoffs.setKickoffs(espnKickoffs(await r.json()));
    if (nbaBook) {
      for (const u of espnNbaUrls(Date.now(), 2)) { // today + tomorrow ET (36h window)
        const c = await fetch(u, { headers: { accept: 'application/json' } });
        if (!c.ok) throw new Error(`espn nba scoreboard ${c.status}`);
        kickoffs.setKickoffs(espnNbaKickoffs(await c.json()));
      }
    }
    if (ncaafBook) {
      for (const u of ESPN_NCAAF) { // FBS scoreboard (current week)
        const c = await fetch(u, { headers: { accept: 'application/json' } });
        if (!c.ok) throw new Error(`espn cfb scoreboard ${c.status}`);
        kickoffs.setKickoffs(espnNcaafKickoffs(await c.json()));
      }
    }
  }
  async function pollOddsKickoffs() {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return;
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/odds_cache?sport=eq.americanfootball_nfl&select=data,fetched_at&order=fetched_at.desc&limit=1`,
      { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } });
    if (!r.ok) throw new Error(`odds_cache ${r.status}`);
    const j = await r.json();
    kickoffs.setKickoffs(oddsKickoffs(j[0] && j[0].data));
    if (ncaafBook) {
      const c = await fetch(`${env.SUPABASE_URL}/rest/v1/odds_cache?sport=eq.americanfootball_ncaaf&select=data,fetched_at&order=fetched_at.desc&limit=1`,
        { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } });
      if (c.ok) { const cj = await c.json(); kickoffs.setKickoffs(oddsNcaafKickoffs(cj[0] && cj[0].data)); }
    }
  }
  loop(pollKickoffs, 'espn_kickoffs', num(env.SNIPER_ESPN_POLL_MS, 60000));
  loop(pollOddsKickoffs, 'odds_kickoffs', num(env.SNIPER_ODDS_KICKOFF_POLL_MS, 300000));
  if (px) loop(pollPx, 'prophetx', num(env.SNIPER_PROPHETX_POLL_MS, 10000));

  // ── Ledger (persistent) ──
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, withBreaker({ auth: { persistSession: false } }, env));
  const store = createLedgerStore({ supabase, log });
  // Decision-log writes (one insert per quote / abort / summary) on their own client so they never
  // queue ahead of reserves, lock polls and the combo_submissions check. SNIPER_DECISION_CLIENT=0 = shared.
  const decisionStoreRaw = String(env.SNIPER_DECISION_CLIENT || '1') === '0' ? store
    : createLedgerStore({ supabase: createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, withBreaker({ auth: { persistSession: false } }, env)), log });
  // SNIPER_DECISION_LOG_SKIPS=1 restores rows for un-quoted RFQs (aborted / rogue_line); default off
  // (~half of sniper_decisions). Counts still land in the per-minute summary row.
  const logSkips = String(env.SNIPER_DECISION_LOG_SKIPS || '0') === '1';
  const decisionStore = logSkips ? decisionStoreRaw
    : { ...decisionStoreRaw, decision: (rec) => (isSkipDecision(rec) ? Promise.resolve() : decisionStoreRaw.decision(rec)) };
  maybeStartCpuProfile('main', env, log);
  const ledger = createSniperLedger({ dayRiskOnAdd: false });
  ledger.shortSettleHours = config.shortSettleHours;
  ledger.restingWeight = config.restingCapWeight;
  // Write-behind (SNIPER_WRITE_BEHIND=0 = old blocking reserve). Own Supabase client so ledger
  // writes never queue behind decision logs / lock polls on the shared client.
  const writeBehind = writeBehindEnabled(env);
  let onReserveFailedRef = async () => {};
  const wbStore = writeBehind ? createWriteBehindStore(
    createLedgerStore({ supabase: createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, withBreaker({ auth: { persistSession: false } }, env)), log }),
    { concurrency: num(env.SNIPER_WB_CONCURRENCY, 8), log, alert: (m) => alert(m), onReserveFailed: (id, r) => onReserveFailedRef(id, r) },
  ) : null;
  // Reserve path on its OWN client (SNIPER_RESERVE_CLIENT=0 = shared with cancels/updates), so a
  // burst of release UPDATEs can't queue ahead of reserves (Oct 25 2026: reserve p50 15s).
  const reserveStore = String(env.SNIPER_RESERVE_CLIENT || '1') === '0' ? store
    : createLedgerStore({ supabase: createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, withBreaker({ auth: { persistSession: false } }, env)), log });
  const dbBreaker = getDbBreaker(env, log);
  // SNIPER_LEDGER_BATCH (default on; 0 = old per-RFQ sniper_reserve RPC): no DB call per RFQ. Caps are
  // in memory; one writer flushes merged ledger rows every SNIPER_LEDGER_FLUSH_MS (300).
  const batchStore = !wbStore && ledgerBatchEnabled(env) ? createBatchedLedgerStore(store, {
    supabase, flushMs: Math.min(500, Math.max(250, num(env.SNIPER_LEDGER_FLUSH_MS, 300))), maxQueue: num(env.SNIPER_LEDGER_MAX_QUEUE, 2000), log, breaker: dbBreaker,
    onRejected: (id) => { ledger.positions.delete(id); liveSniper.abortRfq(id, 'ledger_rejected').catch(() => {}); },
  }) : null;
  const hotStore = wbStore || batchStore || reserveStore;
  const reserveTimeoutMs = num(env.SNIPER_RESERVE_TIMEOUT_MS, 1500); // 0 = no timeout
  // Routine releases batched every SNIPER_RELEASE_BATCH_MS (0 = one UPDATE per release, old path).
  const releaseBatchMs = num(env.SNIPER_RELEASE_BATCH_MS, 250);
  const releaseBatcher = releaseBatchMs > 0 ? createReleaseBatcher({ supabase, flushMs: releaseBatchMs, log, fallback: (id, ph) => store.release(id, ph, {}) }) : null;
  const wbMaxBacklog = num(env.SNIPER_WB_MAX_BACKLOG, 16);
  const tradeRps = tradeBudget.rps;
  // Startup sweep (live): rows a previous process left 'reserved' / 'quoted' (its 20s quote
  // timers died with it). Cancel the Kalshi quote (404 = already gone), then release the row,
  // BEFORE hydrating so stale reservations never count as open exposure.
  if (gate.live) {
    try {
      const stale = await store.staleOpen();
      const sweepTrader = createSniperTrader({ gate, keyId: env.SNIPER_KALSHI_KEY_ID, pem: normalizePem(env.SNIPER_KALSHI_PRIVATE_KEY || ''), subaccount: sniperSubaccount(env), limiter: lim.kalshiTrade, log });
      let cancelled = 0; let failed = 0; let usd = 0;
      for (const r of stale) {
        if (r.quote_id) {
          try { await sweepTrader.cancel(r.quote_id); cancelled += 1; } catch (e) { failed += 1; log(`[SNIPER] sweep cancel ${r.quote_id} failed: ${e.message}`); continue; }
        }
        await store.release(r.rfq_id, 'cancelled', {}); usd += Number(r.risk) || 0;
      }
      log(`[SNIPER] startup sweep: ${stale.length} stale reserved/quoted row(s), released $${usd.toFixed(2)}, kalshi cancels=${cancelled} failed=${failed}`);
    } catch (e) { log(`[SNIPER] startup sweep error: ${e.message}`); }
  }
  const hydrated = await store.hydrate(ledger, etDayStartIso(Date.now()), { live: gate.live });
  log(`[SNIPER] ledger hydrated (${gate.live ? 'live' : 'dry'} book): ${hydrated.length} open position(s), filled_today=$${ledger.day.risk.toFixed(2)} (${ledger.day.fills} fills) pending=$${ledger.day.pending.toFixed(2)}`);
  // Daily cap = filled cost today, from the same DB function the cap check uses.
  loop(async () => { ledger.setDayExposure(await store.dayExposure(etDayStartIso(Date.now()), { live: gate.live })); }, 'day_exposure', num(env.SNIPER_DAY_EXPOSURE_POLL_MS, 15000));
  // Logged sportsbook hedges free in-memory room too (DB cap is authoritative; errors keep gross risk).
  loop(() => store.refreshHedges(ledger, { live: gate.live }), 'hedges', num(env.SNIPER_HEDGE_POLL_MS, 60000));
  // Closing-line snapshot per open live fill leg (EV drift tracker). SNIPER_CLOSE_SNAPSHOT=0 turns it off.
  if (String(env.SNIPER_CLOSE_SNAPSHOT || '1') !== '0') {
    const closeSnap = createCloseSnapshot({ supabase, kickoffFor, books: { pmLive, tdBook, venues, ncaafBook, linesBook, nbaBook }, live: gate.live, log });
    loop(() => closeSnap.tick(), 'close_snapshot', num(env.SNIPER_CLOSE_POLL_MS, 60000));
  }
  // d.totalCap (soon-cap tier) raises only that parlay's DB total cap; everything else unchanged.
  const caps = (d) => { const c = capsFrom(config, etDayStartIso(Date.now()), gate.live); if (d && d.totalCap > c.total) c.total = d.totalCap; return c; };
  const pendingHoldMs = num(env.SNIPER_PENDING_HOLD_MS, quoteTtlMs + 60000);
  async function onHold(d) {
    const pos = ledger.positions.get(d.rfqId); if (pos) { pos.releaseAt = d.releaseAt; pos.resting = false; }
    await hotStore.update(d.rfqId, { release_at: new Date(d.releaseAt).toISOString() });
  }
  const coord = createLockCoord({ supabase, log });
  coord.start();
  const trader = createSniperTrader({
    gate, keyId: env.SNIPER_KALSHI_KEY_ID, pem: normalizePem(env.SNIPER_KALSHI_PRIVATE_KEY || ''),
    subaccount: sniperSubaccount(env), limiter: lim.kalshiTrade, readLimiter: lim.kalshiTradeRead, log,
    maxConcurrent: num(env.SNIPER_QUOTE_CONCURRENCY, 8), maxQueued: num(env.SNIPER_QUOTE_MAX_QUEUED, 24),
  });
  // Kevin Oct 26: parlays settling within soonHours may use the sniper's live cash as total cap.
  const soonCap = createSoonCap({ totalCap: config.totalExposureCap, hours: config.soonHours, enabled: !!config.soonCap && sniperSubaccount(env) >= 1, fetchBalanceUsd: () => trader.subBalanceUsd(), log });
  soonCap.refresh().then((b) => log(`[SNIPER] soon-cap ${config.soonCap ? 'on' : 'off'} hours=${config.soonHours} balance=${b != null ? `$${b.toFixed(2)}` : 'unknown'} normalTotal=$${config.totalExposureCap}`));
  setInterval(() => { soonCap.refresh(); }, num(env.SNIPER_SOON_CAP_REFRESH_MS, 60000)).unref?.();
  // Releasing in the DB also frees the in-memory reservation (cancelled/declined/failed/settled).
  const liveStore = {
    ...hotStore,
    release: async (rfqId, phase, extra) => {
      const p = ledger.positions.get(rfqId);
      if (p) ledger.positions.delete(rfqId);
      if (phase === 'settled' && extra && Number(extra.realized_pnl) < 0) ledger.recordRealizedLoss(-Number(extra.realized_pnl));
      if (releaseBatcher && !wbStore && !batchStore && releaseBatcher.canBatch(phase, extra)) return releaseBatcher.release(rfqId, phase);
      return hotStore.release(rfqId, phase, extra);
    },
  };
  // Sportsbook arb check on fills (alert-only; reads player_prop_cache + odds_cache). SNIPER_BOOK_ARB=0 turns it off.
  const bookArb = String(env.SNIPER_BOOK_ARB) === '0' ? null : createBookArbWatch({
    loadData: () => loadBookData({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_KEY }), store, alert, log,
    kickoffOf: (t) => { const r = kickoffs.resolve(t); return r ? r.kickoffMs : null; },
    minImprove: num(env.SNIPER_BOOK_ARB_REALERT_USD, 1),
    summaryMs: num(env.SNIPER_BOOK_ARB_SUMMARY_MS, 6 * 3600e3),
  });
  if (bookArb && gate.live) loop(() => bookArb.recheckOpen(), 'book_arb', num(env.SNIPER_BOOK_ARB_POLL_MS, 300000));
  const liveSniper = createLiveSniper({
    config, trader, store: liveStore, coord, caps, log, onHold, ttlMs: quoteTtlMs,
    pullConcurrency: Math.max(1, num(env.SNIPER_PULL_CONCURRENCY, 4)), pullGuard: String(env.SNIPER_PULL_GUARD || '1') !== '0',
    reprice: (rfq) => repriceFair(rfq, { pmLive, tdBook, venues, ncaafBook, linesBook, nbaBook, ncaaf: !!ncaafBook }),
    alert,
    onFilled: (f) => (bookArb ? bookArb.check(f, 'fill') : null),
    // Rule 9 at commence time (no buffer here; decide() already stops new quotes 30 min early).
    kickoffOf: (t) => { const r = kickoffs.resolve(t); return r ? r.kickoffMs : null; },
    startedReason: (rfq) => pregameCheck(rfq.legKeys || [], kickoffFor, Date.now(), 0),
    onHalt: () => { /* halted flag inside liveSniper blocks new sends/confirms */ },
  });
  // Graceful stop (Fly sends SIGTERM on deploy/restart, kill_timeout 30s): cancel our open
  // quotes on Kalshi and release their rows so nothing is left holding exposure.
  let stoppingSig = false;
  const onStop = async (sig) => {
    if (stoppingSig) return; stoppingSig = true; disabled = true;
    const t = setTimeout(() => process.exit(0), num(env.SNIPER_SHUTDOWN_MS, 45000)); if (t.unref) t.unref(); // fly kill_timeout 60s
    try { const n = await liveSniper.shutdown(); log(`[SNIPER] ${sig}: cancelled ${n} open quote(s), exiting`); } catch (e) { log(`[SNIPER] ${sig} shutdown error: ${e.message}`); }
    if (batchStore) { try { await batchStore.flush(); await batchStore.flush(); } catch (_) { /* best effort */ } }
    process.exit(0);
  };
  process.once('SIGTERM', () => { onStop('SIGTERM'); });
  process.once('SIGINT', () => { onStop('SIGINT'); });
  liveSniperRef = () => liveSniper.halt('rate_limit');
  // Oct 26 2026 stale-quote sweep (SNIPER_STALE_SWEEP_MS, default 30000; 0 = off): live rows still
  // 'reserved'/'quoted' past release_at, with no order and no fills, that this process is no longer
  // tracking -> cancel the Kalshi quote (404 = gone) and release the row. Backstop for any leak.
  const staleSweepMs = num(env.SNIPER_STALE_SWEEP_MS, 30000);
  if (gate.live && staleSweepMs > 0 && store.stalePastHold) {
    const { sweepStaleQuotes } = require('./stale-sweep');
    loop(async () => {
      const r = await sweepStaleQuotes({ store, trader, release: (id) => liveStore.release(id, 'cancelled', {}), tracked: (id) => liveSniper.hasRfqId(id), log, graceMs: num(env.SNIPER_STALE_GRACE_MS, 15000) });
      if (r.released) log(`[SNIPER] stale sweep: released ${r.released} row(s) $${r.usd.toFixed(2)}, kalshi cancels=${r.cancelled} failed=${r.failed}`);
    }, 'stale_sweep', staleSweepMs);
  }
  async function marketResult(ticker) {
    const j = await getJson(lim.kalshiSettle, `${ORIGIN}${P}/markets/${encodeURIComponent(ticker)}`);
    const m = (j && j.market) || {};
    if (!/settled|finalized|determined/.test(String(m.status || ''))) return null;
    return String(m.result || '').toLowerCase() || null;
  }
  if (gate.live) loop(() => liveSniper.settleOnce(marketResult, etDayStartIso(Date.now())), 'settle', num(env.SNIPER_SETTLE_POLL_MS, 60000));
  const fees = createSeriesFeeCache({ fetchImpl: (u, o) => lim.kalshiSeries.run(() => fetch(u, o)), log: (m) => log(`[SNIPER] ${m}`) });

  // ── RFQ intake: own Kalshi WebSocket (push; no REST polling) ──
  const counts = { rfqs: 0, quotes: 0, skips: {}, ledgerFail: 0 };
  const pricesHealthy = () => Date.now() - health.ml < 30000;
  // >50% of RFQs skipped as prices_stale over 10 min → Telegram (existing alert path), once per episode.
  const staleAlert = createStaleAlert({ windowMs: num(env.SNIPER_STALE_ALERT_WINDOW_MS, 600000), ratio: num(env.SNIPER_STALE_ALERT_RATIO, 0.5), alert });
  setInterval(() => staleAlert.check(), 60000).unref?.();
  // Age budget: an RFQ older than this at intake (or after the DB reserve) is skipped before any
  // pricing / reservation work. Quote-sender still hard-drops at 3s right before the POST.
  const maxAgeMs = num(env.SNIPER_MAX_RFQ_AGE_MS, 2000);
  const lat = createLatencyStats();
  createLoopLagSampler((ms) => lat.loopLag(ms));
  // Recent DB-reserve time (EWMA, ms) for the expiry gate; deadline = quote-sender's rfq_age drop.
  const postDeadlineMs = num(env.SNIPER_POST_DEADLINE_MS, 3000);
  // Decays back toward the 250ms baseline (half-life 5s) when no reserves are happening, so a slow
  // burst can never block every RFQ forever (the estimate only updates on reserves that ran).
  const reserveEst = (() => { const base = 250; let v = base; let at = Date.now();
    const cur = () => base + (v - base) * Math.pow(0.5, (Date.now() - at) / 5000);
    return { add: (ms) => { if (Number.isFinite(ms)) { v = 0.8 * cur() + 0.2 * ms; at = Date.now(); } }, get: cur }; })();
  // Rogue-line guard log (sniper/rogue.js): one sniper_decisions row per leg+venue+kind per minute.
  const rogueSeen = new Map();
  const rogueCfg = rogueConfig(env);
  log(`[SNIPER] rogue-line guard mode=${rogueCfg.mode} maxDev=${(rogueCfg.maxDev * 100).toFixed(1)}pp maxLogit=${rogueCfg.maxLogit} minDev=${(rogueCfg.minDev * 100).toFixed(1)}pp dropHigh=${rogueCfg.dropHigh}`);
  function logRogue(d) {
    const t = Date.now();
    for (const e of d.rogue) {
      counts.rogue = counts.rogue || {}; counts.rogue[e.kind] = (counts.rogue[e.kind] || 0) + 1;
      const k = `${e.kind}|${e.ticker}|${e.side}|${e.venue}`;
      if (t - (rogueSeen.get(k) || 0) < 60000) continue;
      rogueSeen.set(k, t); if (rogueSeen.size > 5000) rogueSeen.delete(rogueSeen.keys().next().value);
      const am = (p) => americanOf(p);
      log(`[SNIPER] ${e.kind} ${e.ticker}:${e.side} venue=${e.venue} ${am(e.p)} vs others ${am(e.ref)} (${(e.devPp * 100).toFixed(1)}pp)${d.action === 'skip' ? ` -> ${d.reason}` : ''}`);
      decisionStore.decision({ rfq_id: d.rfqId || null, action: 'rogue_line', reason: e.kind, details: { ...e, americanVenue: am(e.p), americanOthers: am(e.ref), outcome: d.action === 'skip' ? d.reason : 'quoted_anyway', mode: rogueCfg.mode } });
    }
  }
  async function onRfq(rfq) {
    if (liveSniper.halted()) liveSniper.resumeIfNewDay();
    if (disabled || liveSniper.halted() || !rfq || !rfq.isCombo) return;
    const tH = Date.now();
    lat.arrive(rfqAgeMs(rfq.createdTs, signedNow()));
    if (rfq.recvAt) { lat.stage('recvToHandler', tH - rfq.recvAt); if (rfq.recvAge != null) lat.stage('createdToRecv', rfq.recvAge); }
    const old = tooOld(rfq, signedNow(), maxAgeMs);
    if (old != null) { lat.staleIntake(old); counts.skips.stale_at_intake = (counts.skips.stale_at_intake || 0) + 1; return; }
    // DB circuit breaker open: fail closed (no new quotes) until Supabase recovers.
    if (dbBreaker.isOpen()) { counts.skips.db_breaker = (counts.skips.db_breaker || 0) + 1; return; }
    // Combo Locks priority before anything else (read-only check of active locks).
    const blocked = coord.blockReason(rfq);
    if (blocked) { counts.skips[blocked] = (counts.skips[blocked] || 0) + 1; return; }
    counts.rfqs += 1;
    let makerRate = null;
    try { const e = await fees.prefetch(seriesOfTicker(rfq.marketTicker)); makerRate = e ? e.rate : null; } catch (_) { makerRate = null; }
    const nowMs = Date.now();
    const { decision: d } = decide(rfq, { config, ledger, pmLive, tdBook, ncaafBook, linesBook, nbaBook, venues, kickoffFor, makerRate, nowMs, pricesHealthy: pricesHealthy(), totalCapFor: soonCap.capFor });
    lat.stage('handlerToDecided', Date.now() - tH);
    staleAlert.record(d.reason === 'prices_stale');
    if (d.rogue && d.rogue.length) logRogue(d);
    if (d.action !== 'quote') { counts.skips[d.reason] = (counts.skips[d.reason] || 0) + 1; return; }
    // Re-check age right before the DB reserve (fees prefetch can await on a cold series).
    if (tooOld(rfq, signedNow(), maxAgeMs) != null) {
      ledger.positions.delete(d.rfqId); ledger.hour.pop();
      lat.staleIntake(); counts.skips.stale_before_reserve = (counts.skips.stale_before_reserve || 0) + 1; return;
    }
    // Expiry gate (before the DB lock): if this RFQ can't reach Kalshi inside the quote-sender's
    // 3s rfq_age budget given recent reserve + POST times, don't take the advisory lock for it.
    if (gate.live && !config.dryRun) {
      const age = rfqAgeMs(rfq.createdTs, signedNow());
      const ls = liveSniper.stats();
      const projected = age == null ? null : age + reserveEst.get() + Math.min(ls.postP50 || 150, 1000); // POST window is recent-only; cap so it cannot latch
      if (projected != null && projected > postDeadlineMs) {
        ledger.positions.delete(d.rfqId); ledger.hour.pop();
        counts.skips.cant_make_expiry = (counts.skips.cant_make_expiry || 0) + 1; return;
      }
    }
    // Back-pressure (v49 regression): with the reserve off the hot path nothing throttled intake, so
    // the background reserve queue and the quote-sender queue grew until every POST aged out.
    if (gate.live && !config.dryRun) {
      if (wbStore && wbStore.backlog() > wbMaxBacklog) { ledger.positions.delete(d.rfqId); ledger.hour.pop(); counts.skips.wb_backlog = (counts.skips.wb_backlog || 0) + 1; return; }
      const age = rfqAgeMs(rfq.createdTs, signedNow());
      const ts = trader.stats();
      const queueWaitMs = ((ts.queued || 0) + (ts.active || 0)) * 1000 / tradeRps;
      if (age != null && age + queueWaitMs + Math.min(liveSniper.stats().postP50 || 150, 1000) > postDeadlineMs) {
        ledger.positions.delete(d.rfqId); ledger.hour.pop(); counts.skips.cant_make_queue = (counts.skips.cant_make_queue || 0) + 1; return;
      }
    }
    const t0 = Date.now();
    const tDecided = t0;
    // Live: reserved / quoted rows only hold exposure for the quote's life (20s TTL + buffer);
    // onHold extends to d.releaseAt (games settle) once a taker accepts.
    const holdAt = gate.live && !config.dryRun ? Date.now() + pendingHoldMs : d.releaseAt;
    const pos0 = ledger.positions.get(d.rfqId); if (pos0) pos0.releaseAt = holdAt;
    // In-memory long-settle cap (all other caps already checked in memory by decide()).
    const lc = memoryCapReason(ledger, d.rfqId, { risk: d.risk, settleAt: d.settleAt, nowMs: Date.now(), longCap: config.longExposureCap, shortHours: config.shortSettleHours });
    if (lc) { ledger.positions.delete(d.rfqId); ledger.hour.pop(); counts.skips[lc] = (counts.skips[lc] || 0) + 1; return; }
    { const pm = ledger.positions.get(d.rfqId); if (pm) { pm.long = isLongPos(d.settleAt, Date.now(), config.shortSettleHours); pm.resting = !!(gate.live && !config.dryRun); } }
    let res = (gate.live && !config.dryRun ? hotStore : store).reserve(d, { releaseAt: holdAt, dryRun: config.dryRun, caps: caps(d), marketTicker: rfq.marketTicker || null });
    if (res && typeof res.then === 'function') {
      // blocking path (dry run / SNIPER_WRITE_BEHIND=0). Live: give up after reserveTimeoutMs so a slow
      // DB drops this quote fast instead of making it stale; a late 'ok' row is released.
      const rid = d.rfqId;
      res = await (gate.live && !config.dryRun ? withReserveTimeout(res, reserveTimeoutMs, () => { store.release(rid, 'failed', {}).catch(() => {}); }) : res);
    }
    lat.reserve(Date.now() - t0); reserveEst.add(Date.now() - t0); lat.stage('decidedToReserved', Date.now() - tDecided);
    const tReserved = Date.now();
    if (!res.ok) {
      // roll back the in-memory reservation; a DB problem fails closed (no quote)
      ledger.positions.delete(d.rfqId); ledger.hour.pop();
      counts.ledgerFail += 1; counts.skips[`ledger_${res.reason}`] = (counts.skips[`ledger_${res.reason}`] || 0) + 1;
      return;
    }
    counts.quotes += 1;
    log(formatDecision(d));
    if (!gate.live) {
      decisionStore.decision({ rfq_id: d.rfqId, action: 'would_quote', reason: null, details: d });
      if (config.tgAlerts && tg) tg(tgLabel(formatDecision(d)));
      return;
    }
    lat.prePost(rfqAgeMs(rfq.createdTs, signedNow()));
    if (tooOld(rfq, signedNow(), maxAgeMs) != null) {
      lat.staleReserve(); counts.skips.stale_after_reserve = (counts.skips.stale_after_reserve || 0) + 1;
      await liveStore.release(d.rfqId, 'cancelled', {});
      decisionStore.decision({ rfq_id: d.rfqId, action: 'aborted', reason: 'stale_after_reserve', details: d });
      return;
    }
    if (wsWorker) wsWorker.addOpen(d.rfqId); // keep its rfq_deleted before the 100ms open-id sync
    const sent = await liveSniper.send(rfq, d);
    if (sent.sent) { lat.stage('reservedToPosted', Date.now() - tReserved); if (rfq.recvAt) lat.stage('recvToPosted', Date.now() - rfq.recvAt); }
    if (!sent.sent) {
      counts.skips[`live_${sent.reason}`] = (counts.skips[`live_${sent.reason}`] || 0) + 1;
    }
    decisionStore.decision({ rfq_id: d.rfqId, action: sent.sent ? 'quoted' : 'aborted', reason: sent.reason || null, details: { ...d, quoteId: sent.quoteId || null } });
  }
  // Its OWN read-only Kalshi key (never the combo-worker key), used only for the RFQ socket.
  if (!env.SNIPER_KALSHI_KEY_ID || !env.SNIPER_KALSHI_PRIVATE_KEY) {
    alert('[SNIPER] SNIPER_KALSHI_KEY_ID / SNIPER_KALSHI_PRIVATE_KEY not set — no RFQ feed, idling.');
    return;
  }
  // One unsharded communications socket overflows Kalshi's per-subscription
  // buffer (error code 25 "Subscription buffer overflow") roughly every 30s at
  // current RFQ volume. Shard it like combo-worker (KALSHI_WS_SHARD_FACTOR, default 8).
  // SNIPER_INTAKE_WORKER=1 (default off): the RFQ socket, decode, needle/age/scope filters and
  // JSON.parse run in a worker thread; only candidates reach this thread.
  const intakeWorker = /^(1|true|yes|on)$/i.test(String(env.SNIPER_INTAKE_WORKER || ''));
  // SNIPER_INTAKE_EARLY_FILTER=0 = off. Leg tickers main has seen are checked against kickoffs every
  // 2s; newly started ones go to the worker, which then drops their RFQs (+ duplicate ids) itself.
  const earlyFilter = String(env.SNIPER_INTAKE_EARLY_FILTER || '1') !== '0';
  const legTickersSeen = new Set(); const startedTickers = new Set();
  const fastDrop = String(env.SNIPER_WS_FAST_DROP) !== '0';
  const wsCallbacks = {
    onRfqCreated: (rfq) => { if (rfq) { if (earlyFilter && legTickersSeen.size < 50000) for (const k of rfq.legKeys || []) legTickersSeen.add(String(k).split(':')[0].toUpperCase()); if (!rfq.recvAt) { rfq.recvAt = Date.now(); rfq.recvAge = rfqAgeMs(rfq.createdTs, signedNow()); } } onRfq(rfq).catch((e) => log(`[SNIPER] onRfq error: ${e.message}`)); },
    onRfqDeleted: (evt) => { liveSniper.onRfqClosed(evt).catch((e) => log(`[SNIPER] rfq closed error: ${e.message}`)); },
    onQuoteAccepted: (evt) => { liveSniper.onAccepted(evt).catch((e) => log(`[SNIPER] accept error: ${e.message}`)); },
    onQuoteExecuted: (evt) => { liveSniper.onExecuted(evt).catch((e) => log(`[SNIPER] executed error: ${e.message}`)); },
    onStatus: (st, info) => log(`[SNIPER] ws ${typeof st === 'string' ? st : JSON.stringify(st)}${info ? ` ${JSON.stringify(info)}` : ''}`),
  };
  let wsWorker = null; let wsThroughputLast = null;
  if (intakeWorker && earlyFilter) {
    setInterval(() => {
      if (!wsWorker) return;
      const nowMs = Date.now(); const fresh = [];
      for (const t of legTickersSeen) { const ko = kickoffFor(t); if (Number.isFinite(ko) && ko > 0 && nowMs >= ko - 30 * 60 * 1000) { legTickersSeen.delete(t); startedTickers.add(t); fresh.push(t); } }
      if (fresh.length) wsWorker.addStarted(fresh);
    }, Math.max(100, num(env.SNIPER_STARTED_SYNC_MS, 500))).unref?.();
  }
  if (intakeWorker) {
    wsWorker = createIntakeWorker({
      workerData: {
        shardFactor: readShardFactor(env.SNIPER_WS_SHARD_FACTOR, env, DEFAULT_LIVE_SHARD_FACTOR), fastDrop, nba: !!nbaBook, maxAgeMs,
        scope: { td: !!tdBook, ncaaf: config.ncaaf !== false, lines: !!linesBook, nba: !!nbaBook && !!config.nba },
        earlyFilter, maxLegDays: config.maxLegDays, maxLegs: config.maxLegs, needleAll: !needleAllDisabled(env),
      },
      startedAll: () => [...startedTickers],
      ...wsCallbacks,
      onSkips: (sk) => { for (const [k, v] of Object.entries(sk)) { counts.skips[k] = (counts.skips[k] || 0) + v; if (k === 'stale_at_intake') for (let i = 0; i < v; i += 1) lat.staleIntake(); } },
      openIds: () => { const ids = []; liveSniper.forEachRfqId((id) => ids.push(id)); return ids; },
      log,
    });
    log('[SNIPER] RFQ intake in worker thread (SNIPER_INTAKE_WORKER=1)');
  }
  const ws = wsWorker ? { start: () => wsWorker.start(), takeThroughput: () => wsThroughputLast } : createKalshiFirehose({
    env,
    shardFactor: readShardFactor(env.SNIPER_WS_SHARD_FACTOR, env, DEFAULT_LIVE_SHARD_FACTOR),
    keyId: env.SNIPER_KALSHI_KEY_ID,
    pem: normalizePem(env.SNIPER_KALSHI_PRIVATE_KEY),
    // ~97% of rfq_created frames have no NFL leg: drop them before JSON.parse. rfq_deleted for
    // RFQs we hold no quote on are dropped too (we only act on closes of our own quotes).
    shouldDropCreated: String(env.SNIPER_WS_FAST_DROP) === '0' ? undefined : createSniperFrameFilter({ ncaaf: !!ncaafBook, nba: !!nbaBook && !!config.nba, all: !needleAllDisabled(env) }),
    shouldDropDeleted: String(env.SNIPER_WS_FAST_DROP) === '0' ? undefined : createDeletedIdFilter((id) => liveSniper.hasRfqId(id)),
    // Stamp receive time in the ws message tick (before any await) for stage timing.
    ...wsCallbacks,
  });
  // Background reserve failed (DB cap reason or repeated db_error): free memory + pull the quote.
  onReserveFailedRef = async (rfqId, reason) => { ledger.positions.delete(rfqId); counts.skips[`wb_${reason}`] = (counts.skips[`wb_${reason}`] || 0) + 1; await liveSniper.abortRfq(rfqId, `reserve_${reason}`); };
  if (ws && typeof ws.start === 'function') ws.start(); else if (ws && typeof ws.connect === 'function') ws.connect();

  // Leak sweep: 'accepted' rows with no fill after SNIPER_STALE_ACCEPTED_MIN (default 60, 0 = off) still
  // count at full risk forever (one $74 row from Oct 24 was holding cap). Release them.
  const staleAcceptedMin = num(env.SNIPER_STALE_ACCEPTED_MIN, 60);
  if (gate.live && staleAcceptedMin > 0) {
    const sweepAccepted = async () => {
      const rows = await store.staleAccepted(staleAcceptedMin);
      for (const r of rows) {
        if (liveSniper.hasRfqId(r.rfq_id)) continue;
        await liveStore.release(r.rfq_id, 'declined', {});
        log(`[SNIPER] released stale accepted rfq=${r.rfq_id} risk=$${Number(r.risk).toFixed(2)} (no fill after ${staleAcceptedMin}m)`);
      }
    };
    setInterval(() => { sweepAccepted().catch((e) => log(`[SNIPER] stale accepted sweep error: ${e.message}`)); }, 300000).unref?.();
    sweepAccepted().catch(() => {});
  }
  setInterval(() => { liveSniper.pullStarted().catch((e) => log(`[SNIPER] pullStarted error: ${e.message}`)); }, 5000);

  // ── Nightly Telegram recap (~11:59 PM ET), sent even on days with no fills ──
  const recap = createNightlyRecap({
    store, send: (m) => { log(m); if (tg) tg(m); }, dayStartIso: etDayStartIso,
    live: gate.live, openRisk: () => ledger.totals().total, log,
  });
  setInterval(() => { recap.tick().catch((e) => log(`[SNIPER] recap error: ${e.message}`)); }, 30000);

  // ── Summary + watchdog ──
  let lastBeat = Date.now();
  setInterval(() => {
    const t = ledger.totals();
    const s = Object.entries(counts.skips).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(' ');
    const ls = Object.values(lim).map((l) => { const x = l.stats(); return `${x.name}:${x.requests}req/${x.r429}x429`; }).join(' ');
    log(`[SNIPER] summary mode=${gate.live ? 'LIVE' : 'dry'}${liveSniper.halted() ? ' HALTED' : ''} live=${JSON.stringify(liveSniper.stats())} trade=${JSON.stringify(trader.stats())} locks=${JSON.stringify(coord.stats())} kickoffs=${JSON.stringify(kickoffs.stats())} rfqs=${counts.rfqs} would_quote=${counts.quotes} open=$${t.total.toFixed(2)} positions=${ledger.positions.size} filled_today=$${ledger.day.risk.toFixed(2)} (${ledger.day.fills} fills) pending=$${ledger.day.pending.toFixed(2)} breaker429=${breaker.count()} relayErr=${JSON.stringify(relayErr)} tdOff=${[...tdOff.keys()].join(',') || 'none'} ${disabled ? 'DISABLED' : ''} books=${JSON.stringify({ ...bookRouter.stats(), ws: bookFeed ? bookFeed.stats() : 'off' })} load: ${ls} skips: ${s || 'none'}`);
    const latency = lat.snapshot();
    if (wsWorker) wsWorker.takeThroughputAsync().then((v) => { wsThroughputLast = v ? { ...v, worker: wsWorker.stats() } : null; }).catch(() => {});
    const wsThroughput = () => { if (wsWorker) return wsThroughputLast; try { if (!ws || typeof ws.takeThroughput !== 'function') return null; const t = summarizeThroughput(ws.takeThroughput()); delete t.perShard; return t; } catch (_) { return null; } };
    log(`[SNIPER] latency ${JSON.stringify(latency)} wb=${wbStore ? JSON.stringify(wbStore.wbStats()) : "off"} batch=${batchStore ? JSON.stringify(batchStore.batchStats()) : "off"} dbb=${JSON.stringify(dbBreaker.stats())} ws=${JSON.stringify(wsThroughput())}`);
    decisionStore.decision({ rfq_id: null, action: 'summary', reason: null, details: { latency, mode: gate.live ? 'live' : 'dry', halted: liveSniper.halted(), haltReason: liveSniper.haltReason(), kickoffs: kickoffs.stats(), disabled, counts: JSON.parse(JSON.stringify(counts)), live: liveSniper.stats(), reserveEstMs: Math.round(reserveEst.get()), caps: effectiveCaps, open: t.total, load: Object.values(lim).map((l) => l.stats()) } });
    counts.rfqs = 0; counts.quotes = 0; counts.skips = {};
  }, 60000);
  setInterval(() => {
    const now = Date.now();
    if (now - lastBeat > 30000) { console.error('[SNIPER] watchdog: event loop stalled >30s — exiting for restart'); process.exit(1); }
    lastBeat = now;
    if (!disabled && now - health.ml > 120000 && health.ml > 0) log('[SNIPER] watchdog: Kalshi books stale >2m — quoting paused until fresh');
  }, 10000);
}

module.exports = { main, etDayStartIso };
