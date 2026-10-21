// Auto-Sniper inside the noboost paper job (DRY RUN; this module never sends orders).
//
// Fair per leg = Kevin's inverse bet at SNIPER_FAIR_DEPTH_USD (default $1,000), BEST opposing
// price across Kalshi, Polymarket US, Novig and ProphetX (SNIPER_FAIR_VENUES), each venue with
// its own fee (pm-live / td-book FEES: Kalshi 0.07·p(1−p) × series multiplier, Polymarket US
// 0.0695·p(1−p), Novig 0 pregame, ProphetX 2% commission). Uses its OWN $1,000-depth copies of
// the pm-live (moneyline) and td-book (anytime TD) books, fed by the same polls as the $500
// books, so Combo Sniper's stored $500 fair and Combo Locks are untouched.
//   moneyline leg: opposite = opponent's Yes ask ladder (Kalshi also No-on-own-team)
//   TD Yes leg: walk that player's No side to $1,000; TD No leg: walk Yes
// A venue counts only with REAL depth ≥ $1,000 (top-of-book-only relay quotes are ignored)
// and fresh (15s); no qualifying venue => leg has no fair => RFQ skipped.
// Same-game combos are already rejected by classifyNfl (TD + ML in one game = correlated).
'use strict';
const { createAutoSniper } = require('../auto-sniper');
const { createSeriesFeeCache } = require('../series-fee');

const ALL_VENUES = ['kalshi', 'polymarket', 'novig', 'prophetx'];

function venuesFromEnv(env) {
  const v = String(env.SNIPER_FAIR_VENUES || ALL_VENUES.join(',')).toLowerCase().split(',').map((x) => x.trim()).filter((x) => ALL_VENUES.includes(x));
  return v.length ? v : ALL_VENUES;
}

function bestCost(sources, venues) {
  let best = null;
  for (const s of sources || []) {
    if (!s || !s.used || s.reason !== 'ok' || !venues.includes(s.venue)) continue;
    if (!(s.cost > 0 && s.cost < 1)) continue;
    if (!best || s.cost < best.cost) best = s;
  }
  return best;
}

// -> { p, best, venuesOk } for one classifyNfl leg, or { p:null, reason }
function legFairDepth(leg, { pmLive, tdBook, venues }) {
  if (leg.kind === 'td') {
    if (!tdBook || typeof tdBook.legMulti !== 'function') return { p: null, reason: 'td_no_book' };
    const m = tdBook.legMulti({ id: leg.id, side: leg.side });
    const b = bestCost(m && m.sources, venues);
    if (!b) return { p: null, reason: 'td_no_venue_depth', sources: m && m.sources };
    return { p: 1 - b.cost, best: b.venue, sources: m.sources };
  }
  if (!pmLive) return { p: null, reason: 'no_ml_book' };
  const f = pmLive.legFair(leg.gameId, leg.team);
  if (!f) return { p: null, reason: 'no_game' };
  const b = bestCost(f.sources, venues);
  if (!b) return { p: null, reason: 'no_venue_depth', sources: f.sources };
  return { p: 1 - b.cost, best: `${b.venue}${b.via ? ':' + b.via : ''}`, sources: f.sources };
}

function createNoboostSniper({ env = process.env, pmLive, tdBook, log = console.log, feeCache, sniper } = {}) {
  const venues = venuesFromEnv(env);
  const s = sniper || createAutoSniper({ env, log, feeCache: feeCache || createSeriesFeeCache({ log: (m) => log(`[SNIPER] ${m}`) }) });
  // Fail closed if Kalshi ever changes the KXNFLTD fee from what td-book applies (0.07 × 1).
  let tdFeeOk = true;
  const fc = feeCache || null;
  async function checkTdFee(fetchImpl = (typeof fetch === 'function' ? fetch : null)) {
    if (!fetchImpl) return tdFeeOk;
    try {
      const r = await fetchImpl('https://api.elections.kalshi.com/trade-api/v2/series/KXNFLTD');
      const j = r && r.ok ? await r.json() : null;
      const sr = j && j.series;
      tdFeeOk = !!sr && Number(sr.fee_multiplier) === 1;
      log(`[SNIPER] KXNFLTD fee ${sr ? `${sr.fee_type}×${sr.fee_multiplier}` : 'unknown'} → TD legs ${tdFeeOk ? 'on' : 'OFF (fee mismatch)'}`);
    } catch (e) { tdFeeOk = false; log('[SNIPER] KXNFLTD fee lookup failed → TD legs off'); }
    return tdFeeOk;
  }

  // rfq: { rfqId, marketTicker, legKeys, contracts, targetCostDollars }; cls: classifyNfl(); d1: primary decision
  function onRfq(rfq, cls, d1) {
    if (!s.config.enabled) return null;
    if (!rfq || !cls || !cls.ok) return null;
    if (d1 && d1.reason === 'game_started') return null;
    if (d1 && d1.reason === 'no_kickoff') return null; // can't prove pregame
    const keys = rfq.legKeys || [];
    if (keys.length !== cls.legs.length) return null;
    const legs = [];
    for (let i = 0; i < keys.length; i += 1) {
      const [ticker, side] = String(keys[i]).split(':');
      const l = cls.legs[i];
      if (l.kind === 'td' && !tdFeeOk) return null;
      const f = legFairDepth(l, { pmLive, tdBook, venues });
      const m = /-(\d\d)([A-Z]{3})(\d\d)/.exec(ticker || '');
      const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
      legs.push({ ticker, side: side || 'yes', kind: l.kind || 'ml', fair_yes: f.p, fair_best: f.best || null, date: m ? `20${m[1]}-${MON[m[2]]}-${m[3]}` : null });
    }
    const row = {
      rfq_id: rfq.rfqId, venue: 'kalshi', status: 'seen', legs,
      contracts: Number(rfq.contracts) > 0 ? Number(rfq.contracts) : null,
      cash_size: Number(rfq.targetCostDollars) > 0 ? Number(rfq.targetCostDollars) : null,
    };
    return s.consider(row, { marketTicker: rfq.marketTicker || null }).catch((e) => log(`[SNIPER] consider failed ${e && e.message}`));
  }
  return { onRfq, checkTdFee, sniper: s, venues, _fc: fc };
}

// Fan out ingest calls to a second (sniper-depth) book; reads stay on the primary.
function teeIngest(primary, shadow, methods) {
  if (!primary || !shadow) return primary;
  const out = Object.create(primary);
  for (const m of methods) {
    if (typeof primary[m] !== 'function') continue;
    out[m] = (...args) => {
      try { shadow[m](...args); } catch (_) { /* sniper copy must never break the paper run */ }
      return primary[m](...args);
    };
  }
  return out;
}

module.exports = { createNoboostSniper, legFairDepth, bestCost, teeIngest, venuesFromEnv, ALL_VENUES };
