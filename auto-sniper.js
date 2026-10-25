// Auto-Sniper — automatic Kalshi combo RFQ quoter (Combo Sniper → quoting).
//
// DRY RUN BY DEFAULT. SNIPER_DRY_RUN defaults to 1: every decision is logged
// ("[SNIPER] WOULD_QUOTE ..." / "[SNIPER] SKIP ...") and no order is sent.
// Live posting additionally needs SNIPER_ENABLED=1, SNIPER_DRY_RUN=0 AND an
// injected postQuote() — this PR does not wire one, so live is impossible
// until a follow-up PR is reviewed.
//
// Fair = product of per-leg inverse-bet ourTrue (fair_yes from unhedged-quote
// annotateLegOdds). This module never changes the inverse bet method, nor the
// Combo Locks $500-depth / 15% / 15-second rules — it only reads fair_yes.
//
// Economics (we are the maker; taker buys YES at q, we hold NO at 1-q):
//   fee   = ceil_cent(makerRate * q * (1-q) * n)   (Kalshi maker fee, rounded up)
//   risk  = n * (1-q) + fee                         (our worst-case loss)
//   EV    = n * (q - fair) - fee
//   ROI   = EV / risk                               (after fee)
// We quote the LOWEST cent price q whose ROI >= SNIPER_MIN_ROI (most
// competitive price that still clears the bar). Payout = n contracts × $1.
// Kalshi RFQ quotes must cover the full size, so RFQs whose payout exceeds
// SNIPER_MAX_PAYOUT are skipped (never partially quoted).
'use strict';
const { productFair, validProb } = require('./unhedged-quote');
const { americanFromProb } = require('./engine');
const { seriesOfTicker } = require('./series-fee');

function num(v, dflt) {
  if (v == null || String(v).trim() === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function flag(v, dflt) {
  if (v == null || String(v).trim() === '') return dflt;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return dflt;
}

function sniperConfig(env = process.env) {
  return {
    enabled: flag(env.SNIPER_ENABLED, false),          // kill switch: off = evaluate nothing
    dryRun: flag(env.SNIPER_DRY_RUN, true),            // default dry run
    minRoi: num(env.SNIPER_MIN_ROI, 0.04),             // 4% after maker fee
    minRoiTd: num(env.SNIPER_MIN_ROI_TD, 0.07),        // 7% after maker fee when any leg is a player TD
    minRoiNcaaf: num(env.SNIPER_MIN_ROI_NCAAF, 0.06),
    minRoiLines: num(env.SNIPER_MIN_ROI_LINES, 0.05), // 5%: main spreads / totals (NFL); college 6%
    ncaaf: String(env.SNIPER_NCAAF == null ? '1' : env.SNIPER_NCAAF) !== '0', // SNIPER_NCAAF=0 turns college football off
    nba: String(env.SNIPER_NBA || '0') === '1',                  // NBA ML / spreads / totals (Kevin Oct 23); off unless 1
    minRoiNba: num(env.SNIPER_MIN_ROI_NBA, 0.06),               // any NBA leg: 6% (highest rule wins)
    nbaHours: num(env.SNIPER_NBA_HOURS, 36),                    // NBA legs must tip within this many hours
    nbaGameHours: num(env.SNIPER_NBA_GAME_HOURS, 3),            // NBA settle = last tip + this
    maxPayout: num(env.SNIPER_MAX_PAYOUT, 100),        // $ per quote (contracts × $1)
    maxRisk: num(env.SNIPER_MAX_RISK, 100),            // $ worst-case loss per quote (NO cost + maker fee)
    totalExposureCap: num(env.SNIPER_TOTAL_EXPOSURE_CAP, 10000), // $ open worst-case risk
    longExposureCap: num(env.SNIPER_LONG_EXPOSURE_CAP, 5000),    // $ open risk on parlays settling > shortSettleHours after quote
    shortSettleHours: num(env.SNIPER_SHORT_SETTLE_HOURS, 32),
    gameHours: num(env.SNIPER_GAME_HOURS, 4),                    // settle = last kickoff + this
    perGameCap: num(env.SNIPER_PER_GAME_CAP, 1000),    // $ open risk touching one game
    perLegCap: num(env.SNIPER_PER_LEG_CAP, 750),       // $ open risk on one leg (ticker+side)
    dailyRiskCap: num(env.SNIPER_DAILY_RISK_CAP, 5000),// $ new risk opened per ET day
    dailyLossCap: num(env.SNIPER_DAILY_LOSS_CAP, 1500),// $ realized loss per ET day → halt
    maxQuotesPerHour: num(env.SNIPER_MAX_QUOTES_PER_HOUR, 120),
    minLegFair: num(env.SNIPER_MIN_LEG_FAIR, 0.05),    // skip near-certain/longshot legs
    maxLegFair: num(env.SNIPER_MAX_LEG_FAIR, 0.95),
    minComboFair: num(env.SNIPER_MIN_COMBO_FAIR, 0.02),// skip >+4900 combos (fair unreliable)
    maxRoi: num(env.SNIPER_MAX_ROI, 0.5),              // ROI this high = probably bad fair; skip
    requireBothVenues: flag(env.SNIPER_REQUIRE_BOTH_VENUES, false),
    skipLockOverlap: flag(env.SNIPER_SKIP_LOCK_OVERLAP, true),
    tgAlerts: flag(env.SNIPER_TG_ALERTS, false),
    // Kalshi combo maker fee = round_up_centicent(rate·C·P·(1−P)), rate read per
    // RFQ series from GET /series fee_type × fee_multiplier (series-fee.js):
    //   KXMVECROSSCATEGORY  quadratic_with_combo_maker_fees → 0.035
    //   KXMVECROSSCATEGORY0 quadratic (uncorrelated NFL)     → 0
    // Verified on our own maker fills. Unknown series → 0.035 (conservative).
    // SNIPER_KALSHI_MAKER_RATE forces a rate (testing only).
    makerRateOverride: num(env.SNIPER_KALSHI_MAKER_RATE, null),
    maxLegs: num(env.SNIPER_MAX_LEGS, 10),
    fairDepthUsd: num(env.SNIPER_FAIR_DEPTH_USD, 1000),
    venues: String(env.SNIPER_VENUES || 'kalshi').toLowerCase().split(',').map((v) => v.trim()).filter(Boolean),
    tick: num(env.SNIPER_TICK, 0.001), // KALSHI_SUBCENT confirmed on in prod
  };
}

function ceilCentiCent(x) { return Math.max(0, Math.ceil(x * 1e4 - 1e-7) / 1e4); }

function snipeEconomics({ fair, q, n, makerRate }) {
  const fee = ceilCentiCent(makerRate * q * (1 - q) * n);
  const risk = n * (1 - q) + fee;
  const ev = n * (q - fair) - fee;
  return { fee, risk, ev, roi: risk > 0 ? ev / risk : -Infinity };
}

// Lowest cent price q that clears minRoi. Contracts depend on q when the RFQ
// is cash-sized (taker spends cash at q → n = cash / q).
function minQuotePrice({ fair, contracts, cash, makerRate, minRoi, tick = 0.01 }) {
  const start = Math.max(tick, Math.ceil((fair + 1e-9) / tick) * tick);
  for (let q = start; q <= 0.99 + 1e-9; q = Math.round((q + tick) * 1e6) / 1e6) {
    const n = contracts != null ? contracts : Math.floor(cash / q);
    if (!(n > 0)) return null;
    const e = snipeEconomics({ fair, q, n, makerRate });
    if (e.roi >= minRoi) return { q: Math.round(q * 1e4) / 1e4, n, ...e };
  }
  return null;
}

function legKey(leg) {
  return `${String(leg.ticker || leg.symbol || '').toUpperCase()}:${String(leg.side || 'yes').toLowerCase()}`;
}
// Game = date+teams blob shared by every market on that game:
// KXNFLGAME-26OCT25BUFNYJ-BUF and KXNFLTD-26OCT25BUFNYJ-BUFJCOOK4-1 → 26OCT25BUFNYJ
function gameKey(leg) {
  const t = String(leg.ticker || leg.symbol || '').toUpperCase();
  const parts = t.split('-');
  return parts.length >= 3 ? parts[1] : t;
}
function independentGames(legs) {
  const g = legs.map(gameKey);
  return new Set(g).size === g.length;
}
function comboKey(legs) { return legs.map(legKey).sort().join('|'); }

// Cached per UTC minute: toLocaleDateString was ~5% of main-thread CPU (called per RFQ via prune).
const etDayCache = { min: NaN, v: null };
function etDay(ms) {
  const m = Math.floor(ms / 60000);
  if (m === etDayCache.min) return etDayCache.v;
  const v = new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  etDayCache.min = m; etDayCache.v = v; return v;
}
// Release open risk the day after the latest leg date (conservative).
function releaseAtMs(legs, nowMs) {
  let latest = null;
  for (const l of legs) if (l.date && (!latest || l.date > latest)) latest = l.date;
  const base = latest ? Date.parse(`${latest}T12:00:00-04:00`) : nowMs;
  return (Number.isFinite(base) ? base : nowMs) + 36 * 3600 * 1000;
}

function createSniperLedger({ dayRiskOnAdd = true } = {}) {
  const positions = new Map(); // rfqId → { combo, games, legs, risk, releaseAt }
  const seenRfqs = new Set();
  // dayRiskOnAdd=false: day.risk is set from the DB (filled cost today) by the caller.
  const day = { key: null, risk: 0, loss: 0, pending: 0, fills: 0 };
  const hour = [];
  function prune(nowMs) {
    for (const [id, p] of positions) if (p.releaseAt <= nowMs) positions.delete(id);
    const k = etDay(nowMs);
    if (day.key !== k) { day.key = k; day.risk = 0; day.loss = 0; day.pending = 0; day.fills = 0; }
    while (hour.length && hour[0] < nowMs - 3600e3) hour.shift();
  }
  function totals() {
    let total = 0; const games = new Map(); const legs = new Map(); const combos = new Set();
    // Resting (posted, not accepted) quotes count at restingWeight (SNIPER_RESTING_CAP_WEIGHT, default 1).
    const w = Number.isFinite(api.restingWeight) ? Math.min(1, Math.max(0, api.restingWeight)) : 1;
    let committed = 0; let resting = 0;
    for (const p of positions.values()) {
      const r = p.resting ? p.risk * w : p.risk;
      if (p.resting) resting += p.risk; else committed += p.risk;
      total += r; combos.add(p.combo);
      for (const g of p.games) games.set(g, (games.get(g) || 0) + r);
      for (const l of p.legs) legs.set(l, (legs.get(l) || 0) + r);
    }
    return { total, games, legs, combos, committed, resting };
  }
  const api = {
    prune, totals, seenRfqs, day, hour, positions, dayRiskOnAdd,
    // Day totals from the DB (same query as the cap). Marks the ET day so prune() won't zero it.
    setDayExposure({ filled, pending, fills }, nowMs = Date.now()) {
      prune(nowMs); day.risk = Number(filled) || 0; day.pending = Number(pending) || 0; day.fills = Number(fills) || 0;
    },
    add(rfqId, pos, nowMs) {
      positions.set(rfqId, pos); if (dayRiskOnAdd) day.risk += pos.risk; hour.push(nowMs);
    },
    recordRealizedLoss(amount, nowMs = Date.now()) { prune(nowMs); if (amount > 0) day.loss += amount; },
  };
  api.restingWeight = 1;
  return api;
}

function skip(reason, extra) { return { action: 'skip', reason, ...(extra || {}) }; }

// row: unhedged_rfqs row (legs w/ fair_yes, contracts, cash_size, rfq_id, venue)
function evaluateSnipe(row, { config, ledger, nowMs = Date.now(), lockOverlap = 0, makerRate: seriesRate = null } = {}) {
  const c = config;
  if (!c.enabled) return skip('kill_switch');
  // Ledger is venue-agnostic (shared $ cap + no-double-dip); Kalshi only today.
  if (!row || !c.venues.includes(row.venue)) return skip('venue_off');
  if (row.venue !== 'kalshi') return skip('venue_not_wired');
  const rfqId = String(row.rfq_id || '');
  if (!rfqId) return skip('no_rfq_id');
  ledger.prune(nowMs);
  if (ledger.seenRfqs.has(rfqId)) return skip('dup_rfq');
  ledger.seenRfqs.add(rfqId);
  if (ledger.seenRfqs.size > 50000) ledger.seenRfqs.clear(); // bounded; positions still dedupe combos
  if (row.status && row.status !== 'seen') return skip(`status_${row.status}`);
  const legs = Array.isArray(row.legs) ? row.legs : [];
  if (legs.length < 2) return skip('not_combo');
  if (legs.length > c.maxLegs) return skip('too_many_legs');
  if (!independentGames(legs)) return skip('same_game');
  if (c.skipLockOverlap && lockOverlap > 0) return skip('overlaps_combo_lock');

  const probs = [];
  for (const l of legs) {
    const p = validProb(Number(l.fair_yes));
    if (p == null) return skip('leg_no_fair');
    if (p < c.minLegFair || p > c.maxLegFair) return skip('leg_fair_out_of_range');
    if (c.requireBothVenues && (l.kalshi_opponent_american == null || l.poly_opponent_american == null)) {
      return skip('leg_single_venue');
    }
    probs.push(p);
  }
  const fair = productFair(probs);
  if (fair == null || fair < c.minComboFair) return skip('combo_fair_too_low');

  const contracts = row.contracts != null && Number(row.contracts) > 0 ? Number(row.contracts) : null;
  const cash = row.cash_size != null && Number(row.cash_size) > 0 ? Number(row.cash_size) : null;
  if (contracts == null && cash == null) return skip('no_size');
  const makerRate = c.makerRateOverride != null ? c.makerRateOverride
    : (seriesRate != null ? seriesRate : 0.035);
  const px = minQuotePrice({ fair, contracts, cash, makerRate, minRoi: c.minRoi, tick: c.tick });
  if (!px) return skip('roi_below_min');
  if (px.n > c.maxPayout + 1e-9) return skip('payout_over_cap', { payout: px.n });
  if (c.maxRisk != null && px.risk > c.maxRisk + 1e-9) return skip('risk_over_cap', { risk: px.risk });
  if (px.roi > c.maxRoi) return skip('roi_suspicious');

  const combo = comboKey(legs);
  const games = [...new Set(legs.map(gameKey))];
  const lkeys = legs.map(legKey);
  const t = ledger.totals();
  if (t.combos.has(combo)) return skip('already_hold_combo');
  if (t.total + px.risk > c.totalExposureCap) return skip('total_cap', { open: t.total });
  for (const g of games) if ((t.games.get(g) || 0) + px.risk > c.perGameCap) return skip('game_cap', { game: g });
  for (const l of lkeys) if ((t.legs.get(l) || 0) + px.risk > c.perLegCap) return skip('leg_cap', { leg: l });
  if (ledger.day.risk + px.risk > c.dailyRiskCap) return skip('daily_risk_cap');
  if (ledger.day.loss >= c.dailyLossCap) return skip('daily_loss_halt');
  if (ledger.hour.length >= c.maxQuotesPerHour) return skip('hourly_rate_cap');

  const decision = {
    action: 'quote',
    dryRun: c.dryRun,
    rfqId,
    combo,
    games,
    legs: lkeys,
    fairYes: fair,
    fairAmerican: americanFromProb(fair),
    quoteYes: px.q,
    quoteNoBid: Math.round((1 - px.q) * 100) / 100,
    quoteAmerican: americanFromProb(px.q),
    contracts: px.n,
    payout: px.n,
    fee: px.fee,
    makerRate,
    risk: Math.round(px.risk * 100) / 100,
    ev: Math.round(px.ev * 100) / 100,
    roi: px.roi,
  };
  // Reserve exposure in dry run too, so caps bind exactly as they would live.
  ledger.add(rfqId, { combo, games, legs: lkeys, risk: px.risk, releaseAt: releaseAtMs(legs, nowMs) }, nowMs);
  return decision;
}

function fmtAm(a) { return a == null ? '?' : (a > 0 ? `+${a}` : `${a}`); }
function formatDecision(d) {
  return `[SNIPER] ${d.dryRun ? 'WOULD_QUOTE' : 'QUOTE'} rfq=${d.rfqId} legs=${d.legs.length} ` +
    `fair=${fmtAm(d.fairAmerican)} quote=${fmtAm(d.quoteAmerican)} n=${d.contracts} ` +
    `fee=$${d.fee.toFixed(4)}@${d.makerRate} risk=$${d.risk.toFixed(2)} ev=$${d.ev.toFixed(2)} roi=${(d.roi * 100).toFixed(1)}%`;
}

function createTelegramNotifier(env = process.env, fetchImpl = globalThis.fetch) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chat || typeof fetchImpl !== 'function') return null;
  return (text) => fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  }).catch(() => {});
}

function createAutoSniper({ env = process.env, log = console.log, notify, postQuote, fairProvider, feeCache, now = () => Date.now() } = {}) {
  const config = sniperConfig(env);
  const ledger = createSniperLedger();
  const notifier = notify !== undefined ? notify : (config.tgAlerts ? createTelegramNotifier(env) : null);
  const skips = new Map();
  let lastSummary = now();
  function maybeSummary() {
    const t = now();
    if (t - lastSummary < 60_000) return;
    lastSummary = t;
    const bits = [...skips.entries()].map(([k, v]) => `${k}=${v}`).join(' ');
    const tot = ledger.totals();
    log(`[SNIPER] summary open=$${tot.total.toFixed(2)} positions=${ledger.positions.size} dayRisk=$${ledger.day.risk.toFixed(2)} skips: ${bits || 'none'}`);
    skips.clear();
  }
  async function consider(row, opts = {}) {
    if (!config.enabled) return skip('kill_switch');
    // Cheap pre-checks before any orderbook fetch.
    if (row && Number(row.contracts) > config.maxPayout) { skips.set('payout_over_cap', (skips.get('payout_over_cap') || 0) + 1); return skip('payout_over_cap'); }
    if (row && ledger.seenRfqs.has(String(row.rfq_id))) return skip('dup_rfq');
    if (fairProvider && row && row.venue === 'kalshi' && Array.isArray(row.legs)) {
      try { row = { ...row, legs: await fairProvider.apply(row.legs) }; } catch (e) {
        skips.set('fair_error', (skips.get('fair_error') || 0) + 1); return skip('fair_error');
      }
    }
    let makerRate = null;
    if (feeCache && opts.marketTicker) {
      try { const e = await feeCache.prefetch(seriesOfTicker(opts.marketTicker)); makerRate = e ? e.rate : null; } catch (_) { makerRate = null; }
    }
    const d = evaluateSnipe(row, { config, ledger, nowMs: now(), lockOverlap: opts.lockOverlap || 0, makerRate });
    if (d.action !== 'quote') {
      skips.set(d.reason, (skips.get(d.reason) || 0) + 1);
      maybeSummary();
      return d;
    }
    log(formatDecision(d));
    if (notifier) { try { notifier(formatDecision(d)); } catch (_) {} }
    if (!config.dryRun) {
      if (typeof postQuote !== 'function') {
        log('[SNIPER] live requested but no postQuote wired — not sending');
        d.sent = false;
      } else {
        try { d.result = await postQuote(d); d.sent = true; } catch (e) {
          d.sent = false; d.error = e && e.message;
          log(`[SNIPER] post failed rfq=${d.rfqId} ${d.error}`);
        }
      }
    }
    maybeSummary();
    return d;
  }
  return { config, ledger, consider };
}

module.exports = { etDay,
  sniperConfig, snipeEconomics, minQuotePrice, evaluateSnipe, createSniperLedger,
  createAutoSniper, createTelegramNotifier, formatDecision, comboKey, gameKey, legKey, releaseAtMs,
};
