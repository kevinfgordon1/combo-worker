// Isolated Auto-Sniper service (WORKER_MODE=sniper, start-sniper.js). DRY RUN by default.
//
// Isolation: own Railway service/process; reads Kalshi RFQs from its own WebSocket
// (no REST polling of /communications), prices from Kalshi PUBLIC orderbooks
// (unauthenticated) + our odds-relay (/board, /td) + optional ProphetX, each behind its own
// rate limiter; writes ONLY sniper_ledger / sniper_decisions. No order path exists.
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { createKalshiWs } = require('../kalshi-ws');
const { normalizePem } = require('../kalshi-auth');
const { createPmLiveBook } = require('../noboost/pm-live');
const { createTdBook, isTdTicker } = require('../noboost/td-book');
const { createProphetXClient, hasProphetXCreds } = require('../noboost/prophetx-live');
const { createSeriesFeeCache, seriesOfTicker } = require('../series-fee');
const { sniperConfig, createSniperLedger, formatDecision, createTelegramNotifier } = require('../auto-sniper');
const { createLimiter, createRateBreaker } = require('./limiter');
const { createLedgerStore } = require('./ledger-store');
const { venuesFromEnv } = require('./fair');
const { decide } = require('./engine');

const ORIGIN = 'https://api.elections.kalshi.com';
const P = '/trade-api/v2';
const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const log = (m) => console.log(m);

function etDayStartIso(ms) {
  const d = new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return new Date(`${d}T00:00:00-04:00`).toISOString();
}

async function main(env = process.env) {
  const config = sniperConfig(env);
  const venues = venuesFromEnv(env);
  const depth = num(env.SNIPER_FAIR_DEPTH_USD, 1000);
  const tg = createTelegramNotifier(env);
  const alert = (m) => { log(m); if (tg) tg(m); };
  log(`[SNIPER] boot enabled=${config.enabled} dryRun=${config.dryRun} depth=$${depth} venues=${venues.join('+')} prophetx=${hasProphetXCreds(env) ? 'on' : 'off'}`);
  if (!config.enabled) { log('[SNIPER] SNIPER_ENABLED is off — idling (kill switch).'); setInterval(() => {}, 1 << 30); return; }
  if (!config.dryRun) { alert('[SNIPER] SNIPER_DRY_RUN=0 requested but this service has no order path — staying dry run.'); config.dryRun = true; }

  // ── Request budgets (well under venue limits) ──
  const lim = {
    kalshi: createLimiter({ name: 'kalshi_public', ratePerSec: num(env.SNIPER_KALSHI_RPS, 2), burst: 3 }),
    relay: createLimiter({ name: 'odds_relay', ratePerSec: num(env.SNIPER_RELAY_RPS, 1), burst: 2 }),
    prophetx: createLimiter({ name: 'prophetx', ratePerSec: num(env.SNIPER_PROPHETX_RPS, 0.2), burst: 1 }),
    kalshiSeries: createLimiter({ name: 'kalshi_series', ratePerSec: 0.2, burst: 2 }),
  };
  let disabled = false;
  const breaker = createRateBreaker({
    max: num(env.SNIPER_MAX_429, 5), windowMs: num(env.SNIPER_429_WINDOW_MS, 10 * 60 * 1000),
    onTrip: (venue, n) => { disabled = true; alert(`[SNIPER] AUTO-DISABLED: ${n} rate-limit (429) errors in window (last: ${venue}). All polling stopped. Restart the sniper service to re-enable.`); },
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
  const kick = new Map(); // ticker -> estimated kickoff ms (Kalshi occurrence_datetime − 3h)
  const kickoffFor = (t) => (kick.has(String(t).toUpperCase()) ? kick.get(String(t).toUpperCase()) : null);
  const health = { ml: 0, td: 0, relay: 0 };
  const relayBase = env.SNIPER_ODDS_RELAY_URL || (env.RAILWAY_SERVICE_ODDS_RELAY_URL ? `https://${env.RAILWAY_SERVICE_ODDS_RELAY_URL}` : '');

  async function listMarkets(series) {
    const out = []; let cursor = '';
    for (let i = 0; i < 5; i += 1) {
      const j = await getJson(lim.kalshi, `${ORIGIN}${P}/markets?series_ticker=${series}&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const m of j.markets || []) {
        const t = String(m.ticker || '').toUpperCase();
        const occ = Date.parse(m.occurrence_datetime || '');
        if (t && Number.isFinite(occ)) kick.set(t, occ - 3 * 3600 * 1000);
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
  async function pollRelay() {
    if (!relayBase) return;
    const h = await getJson(lim.relay, `${relayBase}/health`);
    const st = (h && h.status) || {}; const nv = (h && h.novig) || {};
    for (const venue of ['polymarket', 'novig']) {
      if (!venues.includes(venue)) continue;
      const polledAt = Date.now();
      const j = await getJson(lim.relay, `${relayBase}/board?venue=${venue}&league=NFL`);
      const novigLive = /ws:up/.test(String(st.novig || '')) && Number(nv.lastWsMsgAt) > 0 && polledAt - Number(nv.lastWsMsgAt) < 15000;
      pmLive.ingestRelay(venue, j.quotes || [], { feedLive: venue === 'novig' ? novigLive : false, polledAt });
      const t = await getJson(lim.relay, `${relayBase}/td?venue=${venue}&league=NFL`);
      tdBook.ingestVenue(venue, t.markets || [], { polledAt });
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
  if (px) loop(pollPx, 'prophetx', num(env.SNIPER_PROPHETX_POLL_MS, 10000));

  // ── Ledger (persistent) ──
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const store = createLedgerStore({ supabase, log });
  const ledger = createSniperLedger();
  const n = await store.hydrate(ledger, etDayStartIso(Date.now()));
  log(`[SNIPER] ledger hydrated: ${n} open position(s), dayRisk=$${ledger.day.risk.toFixed(2)}`);
  const fees = createSeriesFeeCache({ fetchImpl: (u, o) => lim.kalshiSeries.run(() => fetch(u, o)), log: (m) => log(`[SNIPER] ${m}`) });

  // ── RFQ intake: own Kalshi WebSocket (push; no REST polling) ──
  const counts = { rfqs: 0, quotes: 0, skips: {}, ledgerFail: 0 };
  const pricesHealthy = () => Date.now() - health.ml < 30000;
  async function onRfq(rfq) {
    if (disabled || !rfq || !rfq.isCombo) return;
    counts.rfqs += 1;
    let makerRate = null;
    try { const e = await fees.prefetch(seriesOfTicker(rfq.marketTicker)); makerRate = e ? e.rate : null; } catch (_) { makerRate = null; }
    const nowMs = Date.now();
    const { decision: d } = decide(rfq, { config, ledger, pmLive, tdBook, venues, kickoffFor, makerRate, nowMs, pricesHealthy: pricesHealthy() });
    if (d.action !== 'quote') { counts.skips[d.reason] = (counts.skips[d.reason] || 0) + 1; return; }
    const res = await store.reserve(d, { releaseAt: d.releaseAt, dryRun: config.dryRun });
    if (!res.ok) {
      // roll back the in-memory reservation; a DB problem fails closed (no quote)
      ledger.positions.delete(d.rfqId); ledger.day.risk -= d.risk; ledger.hour.pop();
      counts.ledgerFail += 1; counts.skips[`ledger_${res.reason}`] = (counts.skips[`ledger_${res.reason}`] || 0) + 1;
      return;
    }
    counts.quotes += 1;
    log(formatDecision(d));
    store.decision({ rfq_id: d.rfqId, action: 'would_quote', reason: null, details: d });
    if (config.tgAlerts && tg) tg(formatDecision(d));
  }
  // Its OWN read-only Kalshi key (never the combo-worker key), used only for the RFQ socket.
  if (!env.SNIPER_KALSHI_KEY_ID || !env.SNIPER_KALSHI_PRIVATE_KEY) {
    alert('[SNIPER] SNIPER_KALSHI_KEY_ID / SNIPER_KALSHI_PRIVATE_KEY not set — no RFQ feed, idling.');
    return;
  }
  const ws = createKalshiWs({
    keyId: env.SNIPER_KALSHI_KEY_ID,
    pem: normalizePem(env.SNIPER_KALSHI_PRIVATE_KEY),
    onRfqCreated: (rfq) => { onRfq(rfq).catch((e) => log(`[SNIPER] onRfq error: ${e.message}`)); },
    onStatus: (s) => log(`[SNIPER] ws ${typeof s === 'string' ? s : JSON.stringify(s)}`),
  });
  if (ws && typeof ws.start === 'function') ws.start(); else if (ws && typeof ws.connect === 'function') ws.connect();

  // ── Summary + watchdog ──
  let lastBeat = Date.now();
  setInterval(() => {
    const t = ledger.totals();
    const s = Object.entries(counts.skips).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(' ');
    const ls = Object.values(lim).map((l) => { const x = l.stats(); return `${x.name}:${x.requests}req/${x.r429}x429`; }).join(' ');
    log(`[SNIPER] summary rfqs=${counts.rfqs} would_quote=${counts.quotes} open=$${t.total.toFixed(2)} positions=${ledger.positions.size} dayRisk=$${ledger.day.risk.toFixed(2)} breaker429=${breaker.count()} ${disabled ? 'DISABLED' : ''} load: ${ls} skips: ${s || 'none'}`);
    store.decision({ rfq_id: null, action: 'summary', reason: null, details: { counts, open: t.total, load: Object.values(lim).map((l) => l.stats()) } });
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
