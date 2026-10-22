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
const { createKalshiFirehose, readShardFactor, DEFAULT_LIVE_SHARD_FACTOR, summarizeThroughput } = require('../kalshi-ws');
const { normalizePem } = require('../kalshi-auth');
const { createPmLiveBook } = require('../noboost/pm-live');
const { createTdBook, isTdTicker } = require('../noboost/td-book');
const { createProphetXClient, hasProphetXCreds } = require('../noboost/prophetx-live');
const { createSeriesFeeCache, seriesOfTicker } = require('../series-fee');
const { sniperConfig, createSniperLedger, formatDecision, createTelegramNotifier } = require('../auto-sniper');
const { createLimiter, createRateBreaker } = require('./limiter');
const { createLedgerStore } = require('./ledger-store');
const { venuesFromEnv } = require('./fair');
const { decide, repriceFair, pregameCheck } = require('./engine');
const { liveGate, sniperSubaccount } = require('./gates');
const { createSniperTrader } = require('./trader');
const { createLockCoord } = require('./coord');
const { createLiveSniper } = require('./live');
const { capsFrom } = require('./ledger-store');
const { createNightlyRecap } = require('./recap');
const { createNflFrameFilter, createDeletedFilter, tooOld, createLatencyStats } = require('./intake');
const { signedNow } = require('../kalshi-auth');
const { rfqAgeMs } = require('../quote-sender');
const { createKickoffResolver, ESPN_NFL } = require('./kickoff');
const { espnKickoffs, oddsKickoffs } = require('../noboost/kickoffs');

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
  const venues = venuesFromEnv(env);
  const depth = num(env.SNIPER_FAIR_DEPTH_USD, 1000);
  const tg = createTelegramNotifier(env);
  // Every sniper Telegram message is labelled so it can never be read as a Combo Locks alert.
  const tgLabel = (m) => (/^🎯 SNIPER/.test(m) ? m : `🎯 SNIPER (not Combo Locks) — ${String(m).replace(/^\[SNIPER\]\s*/, '')}`);
  const alert = (m) => { log(m); if (tg) tg(tgLabel(m)); };
  if (!config.enabled) { log('[SNIPER] SNIPER_ENABLED is off — idling (kill switch).'); setInterval(() => {}, 1 << 30); return; }
  const gate = liveGate(env);
  config.dryRun = !gate.live;
  if (String(env.SNIPER_DRY_RUN) === '0' && !gate.live) alert(`[SNIPER] SNIPER_DRY_RUN=0 but live gate closed (${gate.why.join(', ')}) — staying DRY RUN.`);
  log(`[SNIPER] boot enabled=${config.enabled} mode=${gate.live ? 'LIVE' : 'DRY_RUN'} depth=$${depth} venues=${venues.join('+')} prophetx=${hasProphetXCreds(env) ? 'on' : 'off'}`);
  if (gate.live) alert('[SNIPER] ⚠️ LIVE MODE: all gates set — this service will send and confirm real Kalshi RFQ quotes.');

  // ── Request budgets (well under venue limits) ──
  const lim = {
    kalshi: createLimiter({ name: 'kalshi_public', ratePerSec: num(env.SNIPER_KALSHI_RPS, 2), burst: 3 }),
    relay: createLimiter({ name: 'odds_relay', ratePerSec: num(env.SNIPER_RELAY_RPS, 1), burst: 2 }),
    prophetx: createLimiter({ name: 'prophetx', ratePerSec: num(env.SNIPER_PROPHETX_RPS, 0.2), burst: 1 }),
    kalshiSeries: createLimiter({ name: 'kalshi_series', ratePerSec: 0.2, burst: 2 }),
    // signed calls on the sniper's own key (quote POST/confirm/cancel, fills reads)
    kalshiTrade: createLimiter({ name: 'kalshi_trade', ratePerSec: num(env.SNIPER_KALSHI_TRADE_RPS, 5), burst: 5 }),
    kalshiSettle: createLimiter({ name: 'kalshi_settle', ratePerSec: 0.5, burst: 2 }),
  };
  let disabled = false;
  let liveSniperRef = null; // set once the live sniper exists, so a 429 trip also halts quoting
  const breaker = createRateBreaker({
    max: num(env.SNIPER_MAX_429, 5), windowMs: num(env.SNIPER_429_WINDOW_MS, 10 * 60 * 1000),
    onTrip: (venue, n) => { disabled = true; if (typeof liveSniperRef === 'function') liveSniperRef(); alert(`[SNIPER] AUTO-DISABLED: ${n} rate-limit (429) errors in window (last: ${venue}). All polling stopped. Restart the sniper service to re-enable.`); },
  });
  const getJson = async (limiter, url) => {
    if (disabled) throw new Error('disabled');
    try {
      const r = await limiter.run(() => fetch(url, { headers: { accept: 'application/json' } }));
      return r.json();
    } catch (e) { if (e.is429) breaker.hit(limiter.stats().name); throw e; }
  };

  // ── Books (own copies, $depth) ──
  const tdVenues = venues.filter((v) => v === 'polymarket' || v === 'novig');
  const tdBook = createTdBook({ staleMs: 15000, depthUsd: depth, maxOverround: 0.15, venues: tdVenues });
  const pmLive = createPmLiveBook({ staleMs: 15000, depthUsd: depth });
  pmLive.setTdBook(tdBook);
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
  let mlTickers = []; let tdTickers = []; let listedAt = 0;
  async function refreshLists() {
    const ml = await listMarkets('KXNFLGAME'); mlTickers = ml.map((m) => String(m.ticker).toUpperCase());
    if (venues.length) {
      const td = await listMarkets('KXNFLTD'); tdBook.setNames(td);
      tdTickers = td.map((m) => String(m.ticker).toUpperCase()).filter(isTdTicker);
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
    await books(mlTickers, (o) => pmLive.ingestKalshiOrderbooks(o)); health.ml = Date.now();
    await books(tdTickers, (o) => tdBook.ingest(o, Object.fromEntries([...kick].filter(([t]) => t.startsWith('KXNFLTD'))))); health.td = Date.now();
  }
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
    health.relay = Date.now();
  }
  const px = hasProphetXCreds(env) && venues.includes('prophetx') ? createProphetXClient({ env, fetchImpl: (u, o) => lim.prophetx.run(() => fetch(u, o)).catch((e) => { if (e.is429) breaker.hit('prophetx'); throw e; }) }) : null;
  async function pollPx() { if (px) pmLive.ingestProphetX(await px.nflMoneylines()); }

  const loop = (fn, name, ms) => {
    const tick = async () => {
      if (disabled) return;
      try { await fn(); } catch (e) { if (!/disabled/.test(e.message)) log(`[SNIPER] ${name} error: ${e.message}`); }
      if (!disabled) setTimeout(tick, ms);
    };
    tick();
  };
  loop(pollKalshi, 'kalshi_books', num(env.SNIPER_KALSHI_POLL_MS, 5000));
  loop(pollRelay, 'relay', num(env.SNIPER_RELAY_POLL_MS, 3000));
  async function pollKickoffs() {
    const r = await fetch(ESPN_NFL, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`espn scoreboard ${r.status}`);
    kickoffs.setKickoffs(espnKickoffs(await r.json()));
  }
  async function pollOddsKickoffs() {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return;
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/odds_cache?sport=eq.americanfootball_nfl&select=data,fetched_at&order=fetched_at.desc&limit=1`,
      { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } });
    if (!r.ok) throw new Error(`odds_cache ${r.status}`);
    const j = await r.json();
    kickoffs.setKickoffs(oddsKickoffs(j[0] && j[0].data));
  }
  loop(pollKickoffs, 'espn_kickoffs', num(env.SNIPER_ESPN_POLL_MS, 60000));
  loop(pollOddsKickoffs, 'odds_kickoffs', num(env.SNIPER_ODDS_KICKOFF_POLL_MS, 300000));
  if (px) loop(pollPx, 'prophetx', num(env.SNIPER_PROPHETX_POLL_MS, 10000));

  // ── Ledger (persistent) ──
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const store = createLedgerStore({ supabase, log });
  const ledger = createSniperLedger({ dayRiskOnAdd: false });
  const hydrated = await store.hydrate(ledger, etDayStartIso(Date.now()), { live: gate.live });
  log(`[SNIPER] ledger hydrated (${gate.live ? 'live' : 'dry'} book): ${hydrated.length} open position(s), filled_today=$${ledger.day.risk.toFixed(2)} (${ledger.day.fills} fills) pending=$${ledger.day.pending.toFixed(2)}`);
  // Daily cap = filled cost today, from the same DB function the cap check uses.
  loop(async () => { ledger.setDayExposure(await store.dayExposure(etDayStartIso(Date.now()), { live: gate.live })); }, 'day_exposure', num(env.SNIPER_DAY_EXPOSURE_POLL_MS, 15000));
  const caps = () => capsFrom(config, etDayStartIso(Date.now()), gate.live);
  const coord = createLockCoord({ supabase, log });
  coord.start();
  const trader = createSniperTrader({
    gate, keyId: env.SNIPER_KALSHI_KEY_ID, pem: normalizePem(env.SNIPER_KALSHI_PRIVATE_KEY || ''),
    subaccount: sniperSubaccount(env), limiter: lim.kalshiTrade, log,
  });
  // Releasing in the DB also frees the in-memory reservation (cancelled/declined/failed/settled).
  const liveStore = {
    ...store,
    release: async (rfqId, phase, extra) => {
      const p = ledger.positions.get(rfqId);
      if (p) ledger.positions.delete(rfqId);
      if (phase === 'settled' && extra && Number(extra.realized_pnl) < 0) ledger.recordRealizedLoss(-Number(extra.realized_pnl));
      return store.release(rfqId, phase, extra);
    },
  };
  const liveSniper = createLiveSniper({
    config, trader, store: liveStore, coord, caps, log,
    reprice: (rfq) => repriceFair(rfq, { pmLive, tdBook, venues }),
    alert,
    // Rule 9 at commence time (no buffer here; decide() already stops new quotes 30 min early).
    kickoffOf: (t) => { const r = kickoffs.resolve(t); return r ? r.kickoffMs : null; },
    startedReason: (rfq) => pregameCheck(rfq.legKeys || [], kickoffFor, Date.now(), 0),
    onHalt: () => { /* halted flag inside liveSniper blocks new sends/confirms */ },
  });
  liveSniperRef = () => liveSniper.halt('rate_limit');
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
  // Age budget: an RFQ older than this at intake (or after the DB reserve) is skipped before any
  // pricing / reservation work. Quote-sender still hard-drops at 3s right before the POST.
  const maxAgeMs = num(env.SNIPER_MAX_RFQ_AGE_MS, 2000);
  const lat = createLatencyStats();
  async function onRfq(rfq) {
    if (liveSniper.halted()) liveSniper.resumeIfNewDay();
    if (disabled || liveSniper.halted() || !rfq || !rfq.isCombo) return;
    lat.arrive(rfqAgeMs(rfq.createdTs, signedNow()));
    const old = tooOld(rfq, signedNow(), maxAgeMs);
    if (old != null) { lat.staleIntake(); counts.skips.stale_at_intake = (counts.skips.stale_at_intake || 0) + 1; return; }
    // Combo Locks priority before anything else (read-only check of active locks).
    const blocked = coord.blockReason(rfq);
    if (blocked) { counts.skips[blocked] = (counts.skips[blocked] || 0) + 1; return; }
    counts.rfqs += 1;
    let makerRate = null;
    try { const e = await fees.prefetch(seriesOfTicker(rfq.marketTicker)); makerRate = e ? e.rate : null; } catch (_) { makerRate = null; }
    const nowMs = Date.now();
    const { decision: d } = decide(rfq, { config, ledger, pmLive, tdBook, venues, kickoffFor, makerRate, nowMs, pricesHealthy: pricesHealthy() });
    if (d.action !== 'quote') { counts.skips[d.reason] = (counts.skips[d.reason] || 0) + 1; return; }
    // Re-check age right before the DB reserve (fees prefetch can await on a cold series).
    if (tooOld(rfq, signedNow(), maxAgeMs) != null) {
      ledger.positions.delete(d.rfqId); ledger.hour.pop();
      lat.staleIntake(); counts.skips.stale_before_reserve = (counts.skips.stale_before_reserve || 0) + 1; return;
    }
    const t0 = Date.now();
    const res = await store.reserve(d, { releaseAt: d.releaseAt, dryRun: config.dryRun, caps: caps(), marketTicker: rfq.marketTicker || null });
    lat.reserve(Date.now() - t0);
    if (!res.ok) {
      // roll back the in-memory reservation; a DB problem fails closed (no quote)
      ledger.positions.delete(d.rfqId); ledger.hour.pop();
      counts.ledgerFail += 1; counts.skips[`ledger_${res.reason}`] = (counts.skips[`ledger_${res.reason}`] || 0) + 1;
      return;
    }
    counts.quotes += 1;
    log(formatDecision(d));
    if (!gate.live) {
      store.decision({ rfq_id: d.rfqId, action: 'would_quote', reason: null, details: d });
      if (config.tgAlerts && tg) tg(tgLabel(formatDecision(d)));
      return;
    }
    lat.prePost(rfqAgeMs(rfq.createdTs, signedNow()));
    if (tooOld(rfq, signedNow(), maxAgeMs) != null) {
      lat.staleReserve(); counts.skips.stale_after_reserve = (counts.skips.stale_after_reserve || 0) + 1;
      await liveStore.release(d.rfqId, 'cancelled', {});
      store.decision({ rfq_id: d.rfqId, action: 'aborted', reason: 'stale_after_reserve', details: d });
      return;
    }
    const sent = await liveSniper.send(rfq, d);
    if (!sent.sent) {
      counts.skips[`live_${sent.reason}`] = (counts.skips[`live_${sent.reason}`] || 0) + 1;
    }
    store.decision({ rfq_id: d.rfqId, action: sent.sent ? 'quoted' : 'aborted', reason: sent.reason || null, details: { ...d, quoteId: sent.quoteId || null } });
  }
  // Its OWN read-only Kalshi key (never the combo-worker key), used only for the RFQ socket.
  if (!env.SNIPER_KALSHI_KEY_ID || !env.SNIPER_KALSHI_PRIVATE_KEY) {
    alert('[SNIPER] SNIPER_KALSHI_KEY_ID / SNIPER_KALSHI_PRIVATE_KEY not set — no RFQ feed, idling.');
    return;
  }
  // One unsharded communications socket overflows Kalshi's per-subscription
  // buffer (error code 25 "Subscription buffer overflow") roughly every 30s at
  // current RFQ volume. Shard it like combo-worker (KALSHI_WS_SHARD_FACTOR, default 8).
  const ws = createKalshiFirehose({
    env,
    shardFactor: readShardFactor(env.SNIPER_WS_SHARD_FACTOR, env, DEFAULT_LIVE_SHARD_FACTOR),
    keyId: env.SNIPER_KALSHI_KEY_ID,
    pem: normalizePem(env.SNIPER_KALSHI_PRIVATE_KEY),
    // ~97% of rfq_created frames have no NFL leg: drop them before JSON.parse. rfq_deleted for
    // RFQs we hold no quote on are dropped too (we only act on closes of our own quotes).
    shouldDropCreated: String(env.SNIPER_WS_FAST_DROP) === '0' ? undefined : createNflFrameFilter(),
    shouldDropDeleted: String(env.SNIPER_WS_FAST_DROP) === '0' ? undefined : createDeletedFilter((cb) => liveSniper.forEachRfqId(cb)),
    onRfqCreated: (rfq) => { onRfq(rfq).catch((e) => log(`[SNIPER] onRfq error: ${e.message}`)); },
    onRfqDeleted: (evt) => { liveSniper.onRfqClosed(evt).catch((e) => log(`[SNIPER] rfq closed error: ${e.message}`)); },
    onQuoteAccepted: (evt) => { liveSniper.onAccepted(evt).catch((e) => log(`[SNIPER] accept error: ${e.message}`)); },
    onQuoteExecuted: (evt) => { liveSniper.onExecuted(evt).catch((e) => log(`[SNIPER] executed error: ${e.message}`)); },
    onStatus: (s, info) => log(`[SNIPER] ws ${typeof s === 'string' ? s : JSON.stringify(s)}${info ? ` ${JSON.stringify(info)}` : ''}`),
  });
  if (ws && typeof ws.start === 'function') ws.start(); else if (ws && typeof ws.connect === 'function') ws.connect();

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
    log(`[SNIPER] summary mode=${gate.live ? 'LIVE' : 'dry'}${liveSniper.halted() ? ' HALTED' : ''} live=${JSON.stringify(liveSniper.stats())} trade=${JSON.stringify(trader.stats())} locks=${JSON.stringify(coord.stats())} kickoffs=${JSON.stringify(kickoffs.stats())} rfqs=${counts.rfqs} would_quote=${counts.quotes} open=$${t.total.toFixed(2)} positions=${ledger.positions.size} filled_today=$${ledger.day.risk.toFixed(2)} (${ledger.day.fills} fills) pending=$${ledger.day.pending.toFixed(2)} breaker429=${breaker.count()} relayErr=${JSON.stringify(relayErr)} tdOff=${[...tdOff.keys()].join(',') || 'none'} ${disabled ? 'DISABLED' : ''} load: ${ls} skips: ${s || 'none'}`);
    const latency = lat.snapshot();
    const wsThroughput = () => { try { if (!ws || typeof ws.takeThroughput !== 'function') return null; const t = summarizeThroughput(ws.takeThroughput()); delete t.perShard; return t; } catch (_) { return null; } };
    log(`[SNIPER] latency ${JSON.stringify(latency)} ws=${JSON.stringify(wsThroughput())}`);
    store.decision({ rfq_id: null, action: 'summary', reason: null, details: { latency, mode: gate.live ? 'live' : 'dry', halted: liveSniper.halted(), haltReason: liveSniper.haltReason(), kickoffs: kickoffs.stats(), disabled, counts, open: t.total, load: Object.values(lim).map((l) => l.stats()) } });
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
