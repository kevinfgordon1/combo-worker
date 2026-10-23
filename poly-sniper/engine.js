// Pure decision step for the Polymarket combo sniper (dry run):
//   Poly RFQ -> mapped Kalshi-equivalent legs -> sniper fair (all venues, own fees, depth,
//   15s, 115% vig) -> min edge -> Polymarket maker economics -> per-venue caps.
// Polymarket combo maker fee = 0 and no maker rebate (docs.polymarket.us/fees).
// We SELL the parlay: quote buyPrice (requester buys the combo) and sellPrice "0".
'use strict';
const { classifyLegs, pregameCheck, legDate } = require('../sniper/engine');
const { legFairDepth } = require('../sniper/fair');
const { minQuotePrice, comboKey, gameKey, legKey, releaseAtMs } = require('../auto-sniper');
const { mapPolyLegs } = require('./map');

const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const POLY_COMBO_MAKER_RATE = 0;

function polySniperConfig(env = process.env) {
  return {
    minRoiNflMl: num(env.POLY_SNIPER_MIN_ROI_NFL_ML, 0.03), // all legs NFL moneyline
    minRoiNfl: num(env.POLY_SNIPER_MIN_ROI_NFL, 0.04),      // any other NFL (spreads/totals)
    minRoiTd: num(env.POLY_SNIPER_MIN_ROI_TD, 0.06),        // any NFL player-TD leg (Kevin Oct 23: 6%)
    minRoiNcaaf: num(env.POLY_SNIPER_MIN_ROI_NCAAF, 0.05),  // any college (FBS only) leg
    maxRoi: num(env.POLY_SNIPER_MAX_ROI, 0.5),
    minLegFair: num(env.POLY_SNIPER_MIN_LEG_FAIR, 0.05),
    maxLegFair: num(env.POLY_SNIPER_MAX_LEG_FAIR, 0.95),
    minComboFair: num(env.POLY_SNIPER_MIN_COMBO_FAIR, 0.02),
    maxLegs: num(env.POLY_SNIPER_MAX_LEGS, 10),
    bufferMs: num(env.POLY_SNIPER_KICKOFF_BUFFER_MS, 30 * 60 * 1000), // same as sniper: stop 30 min pre-kick
    // Caps are PER VENUE (Polymarket has its own; Kalshi sniper caps untouched). Kevin: Polymarket doubles capacity.
    maxRisk: num(env.POLY_SNIPER_MAX_RISK, 200),
    perGameCap: num(env.POLY_SNIPER_PER_GAME_CAP, 1500),
    perLegCap: num(env.POLY_SNIPER_PER_LEG_CAP, 750),
    totalExposureCap: num(env.POLY_SNIPER_TOTAL_EXPOSURE_CAP, 10000),
    dailyRiskCap: num(env.POLY_SNIPER_DAILY_RISK_CAP, 5000),
    latencyTargetMs: num(env.POLY_SNIPER_LATENCY_TARGET_MS, 200),
    ncaaf: String(env.POLY_SNIPER_NCAAF == null ? '1' : env.POLY_SNIPER_NCAAF) !== '0',
  };
}

// Minimum edge: the highest applicable rule wins — all-NFL-ML 3%, other NFL (spreads/totals) 4%,
// college 5%, NFL player TD 6%.
function polyMinRoi(legs, config) {
  let m = config.minRoiNflMl;
  for (const l of legs || []) {
    const college = l.kind === 'ncaaf' || (l.kind === 'line' && l.league === 'ncaaf');
    if (college) m = Math.max(m, config.minRoiNcaaf);
    else if (l.kind === 'td') m = Math.max(m, config.minRoiTd != null ? config.minRoiTd : config.minRoiNfl);
    else if (l.kind !== 'ml') m = Math.max(m, config.minRoiNfl);
  }
  return m;
}

// Hypothetical per-venue ledger (dry run: positions are what we WOULD have quoted).
function createVenueLedger(venue = 'polymarket') {
  const positions = new Map();
  const day = { key: null, risk: 0 };
  const etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  function prune(nowMs) {
    for (const [id, p] of positions) if (p.releaseAt <= nowMs) positions.delete(id);
    const k = etDay(nowMs); if (day.key !== k) { day.key = k; day.risk = 0; }
  }
  function totals() {
    let total = 0; const games = new Map(); const legs = new Map(); const combos = new Set();
    for (const p of positions.values()) {
      total += p.risk; combos.add(p.combo);
      for (const g of p.games) games.set(g, (games.get(g) || 0) + p.risk);
      for (const l of p.legs) legs.set(l, (legs.get(l) || 0) + p.risk);
    }
    return { total, games, legs, combos };
  }
  return { venue, positions, day, prune, totals, add(id, pos) { positions.set(id, pos); day.risk += pos.risk; } };
}

function sizeOf(rfq) {
  const q = Number(rfq.qtyDecimal); const c = Number(rfq.cashOrderQty);
  return { contracts: q > 0 ? q : null, cash: c > 0 ? c : null };
}
function tickOf(rfq) { const t = Number(rfq.tickSize); return t > 0 && t < 0.1 ? t : 0.001; }
const roundTick = (x, tick) => Math.round(Math.round(x / tick) * tick * 1e6) / 1e6;

// rfq = normalizePolymarketRfq output. -> { action:'quote'|'skip', reason, ... }
function decidePoly(rfq, { feed, config, ledger, nowMs = Date.now() }) {
  const base = { rfqId: rfq && rfq.rfqId, symbol: rfq && rfq.symbol };
  const skip = (reason, extra) => ({ ...base, action: 'skip', reason, ...(extra || {}) });
  if (!rfq || !rfq.rfqId) return skip('bad_rfq');
  const comboLegs = rfq.comboLegs || rfq.legs;
  if (!Array.isArray(comboLegs) || comboLegs.length < 2) return skip('not_combo');
  if (comboLegs.length > config.maxLegs) return skip('too_many_legs');
  if (!feed.pricesHealthy(nowMs)) return skip('prices_stale');
  const m = mapPolyLegs(comboLegs, feed.index);
  if (!m.ok) return skip(m.reason, { unmapped: m.unmapped || null, matched: m.matched || null });
  const kRfq = { rfqId: rfq.rfqId, legKeys: m.legKeys };
  const cls = classifyLegs(kRfq, { td: !!feed.tdBook, ncaaf: config.ncaaf && !!feed.ncaafBook });
  if (!cls.ok) return skip(`scope_${cls.reason}`);
  const pg = pregameCheck(m.legKeys, (t) => feed.kickoffs.kickoffFor(t), nowMs, config.bufferMs);
  if (pg) return skip(pg);
  const legs = []; let fair = 1;
  for (let i = 0; i < m.legKeys.length; i += 1) {
    const [ticker, side] = m.legKeys[i].split(':');
    const f = legFairDepth(cls.legs[i], { pmLive: feed.pmLive, tdBook: feed.tdBook, ncaafBook: feed.ncaafBook, venues: feed.venues });
    const leg = { polySymbol: comboLegs[i].symbol, polySide: comboLegs[i].side, ticker, side, kind: cls.legs[i].kind || 'ml', league: cls.legs[i].league || null, fair: f.p, venue: f.venue || null, best: f.best || null, depthUsd: f.depthUsd != null ? Math.round(f.depthUsd) : null, reason: f.reason || null, date: legDate(ticker) };
    legs.push(leg);
    if (!(f.p > 0 && f.p < 1)) return skip(f.reason || 'leg_no_fair', { legs });
    if (f.p < config.minLegFair || f.p > config.maxLegFair) return skip('leg_fair_out_of_range', { legs });
    fair *= f.p;
  }
  if (fair < config.minComboFair) return skip('combo_fair_too_low', { legs, fair });
  const hasTd = legs.some((l) => l.kind === 'td');
  const hasNcaaf = legs.some((l) => l.kind === 'ncaaf');
  const minRoi = polyMinRoi(legs, config);
  const { contracts, cash } = sizeOf(rfq);
  if (contracts == null && cash == null) return skip('no_size', { legs, fair });
  const tick = tickOf(rfq);
  const px = minQuotePrice({ fair, contracts, cash, makerRate: POLY_COMBO_MAKER_RATE, minRoi, tick });
  if (!px) return skip('roi_below_min', { legs, fair, minRoi });
  if (px.roi > config.maxRoi) return skip('roi_suspicious', { legs, fair, minRoi });
  const buyPrice = roundTick(px.q, tick);
  const ll = legs.map((l) => ({ ticker: l.ticker, side: l.side }));
  const combo = comboKey(ll); const games = [...new Set(ll.map(gameKey))]; const lkeys = ll.map(legKey);
  const econ = { fair, buyPrice, sellPrice: '0', contracts: px.n, risk: px.risk, ev: px.ev, roi: px.roi, fee: px.fee, minRoi, tick };
  if (px.risk > config.maxRisk + 1e-9) return skip('risk_over_cap', { legs, ...econ });
  ledger.prune(nowMs);
  const t = ledger.totals();
  if (t.combos.has(combo)) return skip('already_hold_combo', { legs, ...econ });
  if (t.total + px.risk > config.totalExposureCap) return skip('total_cap', { legs, ...econ });
  for (const g of games) if ((t.games.get(g) || 0) + px.risk > config.perGameCap) return skip('game_cap', { legs, ...econ, game: g });
  for (const l of lkeys) if ((t.legs.get(l) || 0) + px.risk > config.perLegCap) return skip('leg_cap', { legs, ...econ, leg: l });
  if (ledger.day.risk + px.risk > config.dailyRiskCap) return skip('daily_risk_cap', { legs, ...econ });
  ledger.add(rfq.rfqId, { combo, games, legs: lkeys, risk: px.risk, releaseAt: releaseAtMs(legs, nowMs) });
  return { ...base, action: 'quote', legs, combo, games, ...econ };
}

module.exports = { decidePoly, polySniperConfig, polyMinRoi, createVenueLedger, POLY_COMBO_MAKER_RATE };
