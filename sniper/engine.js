// Pure decision step for the isolated sniper: rfq -> fair -> auto-sniper rules -> ledger.
'use strict';
const { evaluateSnipe, releaseAtMs } = require('../auto-sniper');
const { classifyNfl } = require('../noboost/shadow');
const { legFairDepth } = require('./fair');
const { isNcaafTicker, classifyNcaafLeg } = require('./ncaaf');
const { isLineTicker, classifyLineLeg } = require('./lines');

const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const legDate = (t) => { const m = /-(\d\d)([A-Z]{3})(\d\d)/.exec(t || ''); return m ? `20${m[1]}-${MON[m[2]]}-${m[3]}` : null; };

// kickoffFor(ticker) -> ms | null. Unknown kickoff => cannot prove pregame => skip.
// Full settle = latest leg kickoff + game length (default 4h). null if any kickoff unknown (DB treats as long).
function settleAtMs(keys, kickoffFor, gameHours = 4) {
  let last = -Infinity;
  for (const k of keys) { const ko = kickoffFor(String(k).split(':')[0]); if (!Number.isFinite(ko) || ko <= 0) return null; if (ko > last) last = ko; }
  return Number.isFinite(last) ? last + (Number.isFinite(gameHours) ? gameHours : 4) * 3600e3 : null;
}

function pregameCheck(keys, kickoffFor, nowMs, bufferMs) {
  for (const k of keys) {
    const t = String(k).split(':')[0];
    const ko = kickoffFor(t);
    if (ko == null) return 'no_kickoff';
    if (nowMs >= ko - bufferMs) return 'game_started';
  }
  return null;
}

// NFL-only RFQs go through classifyNfl exactly as before. An RFQ with any KXNCAAFGAME leg
// (config.ncaaf) is split: NCAAF legs via the crosswalk (sniper/ncaaf.js), NFL legs through
// classifyNfl together with one fixed sentinel leg from a 2020 game (classifyNfl needs 2+
// legs; the sentinel is dropped and can never match a live game). Every leg must be on a
// different game, NFL or NCAAF.
const NFL_SENTINEL = 'KXNFLGAME-20JAN01BUFKC-BUF:yes';
// Main spread / total legs (lines) go through sniper/lines.js the same way (config.lines).
function classifyLegs(rfq, { td, ncaaf, lines = false }) {
  const keys = (rfq && rfq.legKeys) || [];
  const isL = keys.map((k) => isLineTicker(String(k).split(':')[0]));
  const isN = keys.map((k, i) => isL[i] || isNcaafTicker(String(k).split(':')[0]));
  if (!isN.some(Boolean)) return classifyNfl(rfq, 'kalshi', { td });
  if (isL.some(Boolean) && !lines) return { ok: false, reason: 'lines_off' };
  if (keys.some((k, i) => !isL[i] && isNcaafTicker(String(k).split(':')[0])) && !ncaaf) return { ok: false, reason: 'ncaaf_off' };
  if (keys.some((k, i) => isL[i] && /^KXNCAAF/i.test(String(k))) && !ncaaf) return { ok: false, reason: 'ncaaf_off' };
  if (keys.length < 2) return { ok: false, reason: 'not_combo' };
  const nflKeys = keys.filter((_, i) => !isN[i]);
  let nflLegs = [];
  if (nflKeys.length) {
    const c = classifyNfl({ legKeys: [...nflKeys, NFL_SENTINEL] }, 'kalshi', { td });
    if (!c.ok) return c;
    nflLegs = c.legs.slice(0, nflKeys.length);
  }
  const legs = []; const games = new Set(); let j = 0;
  for (let i = 0; i < keys.length; i += 1) {
    const leg = isL[i] ? classifyLineLeg(keys[i]) : isN[i] ? classifyNcaafLeg(keys[i]) : nflLegs[j++];
    if (!leg || (isN[i] && !leg.kind)) return { ok: false, reason: (leg && leg.reason) || 'leg_parse' };
    if (games.has(leg.gameId)) return { ok: false, reason: 'correlated_same_game' };
    games.add(leg.gameId); legs.push(leg);
  }
  return { ok: true, legs };
}

// -> { decision, row } ; decision.action 'quote' | 'skip'
function decide(rfq, { config, ledger, pmLive, tdBook, ncaafBook = null, linesBook = null, venues, kickoffFor, makerRate, nowMs, bufferMs = 30 * 60 * 1000, pricesHealthy = true }) {
  const skip = (reason) => ({ decision: { action: 'skip', reason } });
  if (!config.enabled) return skip('kill_switch');
  if (!rfq || !rfq.rfqId || !Array.isArray(rfq.legKeys)) return skip('bad_rfq');
  if (!pricesHealthy) return skip('prices_stale');
  const cls = classifyLegs(rfq, { td: !!tdBook, ncaaf: config.ncaaf !== false, lines: !!linesBook });
  if (!cls.ok) return skip(`scope_${cls.reason}`);
  const keys = rfq.legKeys;
  if (keys.length !== cls.legs.length) return skip('leg_mismatch');
  const pg = pregameCheck(keys, kickoffFor, nowMs, bufferMs);
  if (pg) return skip(pg);
  const rogue = []; // rogue-line guard events (sniper/rogue.js), logged by the runner
  const legs = keys.map((k, i) => {
    const [ticker, side] = String(k).split(':');
    const f = legFairDepth(cls.legs[i], { pmLive, tdBook, venues, ncaafBook, linesBook });
    if (f.rogue && f.rogue.length) rogue.push(...f.rogue.map((e) => ({ ...e, ticker, side: side || 'yes' })));
    return { ticker, side: side || 'yes', fair_yes: f.p, fair_best: f.best || null, venue: f.venue || null, depth_usd: f.depthUsd != null ? Math.round(f.depthUsd) : null, name: (tdBook && tdBook.names && tdBook.names.get && tdBook.names.get(String(ticker).toUpperCase())) || null, date: legDate(ticker) };
  });
  if (rogue.some((e) => e.kind === 'rogue_low') && legs.some((l) => l.fair_yes == null)) {
    return { decision: { action: 'skip', reason: 'rogue_fair_low', rfqId: rfq.rfqId, rogue } };
  }
  const row = {
    rfq_id: rfq.rfqId, venue: 'kalshi', status: 'seen', legs,
    contracts: Number(rfq.contracts) > 0 ? Number(rfq.contracts) : null,
    cash_size: Number(rfq.targetCostDollars) > 0 ? Number(rfq.targetCostDollars) : null,
  };
  // Player-TD combos need a higher edge (SNIPER_MIN_ROI_TD, default 4%); any college-football
  // leg needs SNIPER_MIN_ROI_NCAAF (default 5%). The highest applicable minimum wins.
  const hasTd = cls.legs.some((l) => l && l.kind === 'td');
  const hasNcaaf = cls.legs.some((l) => l && (l.kind === 'ncaaf' || (l.kind === 'line' && l.league === 'ncaaf')));
  // Main spread / total legs (NFL) need the 4% "other NFL" minimum (SNIPER_MIN_ROI_LINES); college
  // lines are also hasNcaaf, so they get 5%. 3% only when every leg is an NFL moneyline.
  const hasLine = cls.legs.some((l) => l && l.kind === 'line');
  let minRoi = config.minRoi;
  if (hasLine) minRoi = Math.max(minRoi, config.minRoiLines != null ? config.minRoiLines : 0.04);
  if (hasTd) minRoi = Math.max(minRoi, config.minRoiTd != null ? config.minRoiTd : 0.04);
  if (hasNcaaf) minRoi = Math.max(minRoi, config.minRoiNcaaf != null ? config.minRoiNcaaf : 0.05);
  const d = evaluateSnipe(row, { config: { ...config, minRoi }, ledger, nowMs, makerRate });
  if (d.action === 'skip' && d.reason === 'roi_below_min' && hasNcaaf) d.reason = 'roi_below_min_ncaaf';
  else if (d.action === 'skip' && d.reason === 'roi_below_min' && hasTd) d.reason = 'roi_below_min_td';
  else if (d.action === 'skip' && d.reason === 'roi_below_min' && hasLine) d.reason = 'roi_below_min_lines';
  if (rogue.length) d.rogue = rogue;
  if (d.action === 'quote') {
    d.releaseAt = releaseAtMs(legs, nowMs);
    d.settleAt = settleAtMs(keys, kickoffFor, config.gameHours);
    d.minRoi = minRoi; d.hasTd = hasTd; d.hasLine = hasLine; d.hasNcaaf = hasNcaaf;
    // Per-leg detail for the fill alert + audit (sniper_decisions.details.legDetail).
    d.legDetail = legs.map((l) => ({ ticker: l.ticker, side: l.side, fair: l.fair_yes, venue: l.venue, depthUsd: l.depth_usd, name: l.name }));
  }
  return { decision: d, row };
}

// Fresh combo fair (product of per-leg best-of-venues $depth fairs) for send/confirm-time re-pricing.
function repriceFair(rfq, { pmLive, tdBook, venues, ncaafBook = null, linesBook = null, ncaaf = true }) {
  const cls = classifyLegs(rfq, { td: !!tdBook, ncaaf, lines: !!linesBook });
  if (!cls.ok || cls.legs.length !== (rfq.legKeys || []).length) return null;
  let fair = 1;
  for (const leg of cls.legs) {
    const f = legFairDepth(leg, { pmLive, tdBook, venues, ncaafBook, linesBook });
    if (!(f.p > 0 && f.p < 1)) return null;
    fair *= f.p;
  }
  return fair;
}

module.exports = { decide, settleAtMs, pregameCheck, legDate, repriceFair, classifyLegs };
