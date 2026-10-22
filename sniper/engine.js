// Pure decision step for the isolated sniper: rfq -> fair -> auto-sniper rules -> ledger.
'use strict';
const { evaluateSnipe, releaseAtMs } = require('../auto-sniper');
const { classifyNfl } = require('../noboost/shadow');
const { legFairDepth } = require('./fair');

const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const legDate = (t) => { const m = /-(\d\d)([A-Z]{3})(\d\d)/.exec(t || ''); return m ? `20${m[1]}-${MON[m[2]]}-${m[3]}` : null; };

// kickoffFor(ticker) -> ms | null. Unknown kickoff => cannot prove pregame => skip.
function pregameCheck(keys, kickoffFor, nowMs, bufferMs) {
  for (const k of keys) {
    const t = String(k).split(':')[0];
    const ko = kickoffFor(t);
    if (ko == null) return 'no_kickoff';
    if (nowMs >= ko - bufferMs) return 'game_started';
  }
  return null;
}

// -> { decision, row } ; decision.action 'quote' | 'skip'
function decide(rfq, { config, ledger, pmLive, tdBook, venues, kickoffFor, makerRate, nowMs, bufferMs = 30 * 60 * 1000, pricesHealthy = true }) {
  const skip = (reason) => ({ decision: { action: 'skip', reason } });
  if (!config.enabled) return skip('kill_switch');
  if (!rfq || !rfq.rfqId || !Array.isArray(rfq.legKeys)) return skip('bad_rfq');
  if (!pricesHealthy) return skip('prices_stale');
  const cls = classifyNfl(rfq, 'kalshi', { td: !!tdBook });
  if (!cls.ok) return skip(`scope_${cls.reason}`);
  const keys = rfq.legKeys;
  if (keys.length !== cls.legs.length) return skip('leg_mismatch');
  const pg = pregameCheck(keys, kickoffFor, nowMs, bufferMs);
  if (pg) return skip(pg);
  const legs = keys.map((k, i) => {
    const [ticker, side] = String(k).split(':');
    const f = legFairDepth(cls.legs[i], { pmLive, tdBook, venues });
    return { ticker, side: side || 'yes', fair_yes: f.p, fair_best: f.best || null, venue: f.venue || null, depth_usd: f.depthUsd != null ? Math.round(f.depthUsd) : null, name: (tdBook && tdBook.names && tdBook.names.get && tdBook.names.get(String(ticker).toUpperCase())) || null, date: legDate(ticker) };
  });
  const row = {
    rfq_id: rfq.rfqId, venue: 'kalshi', status: 'seen', legs,
    contracts: Number(rfq.contracts) > 0 ? Number(rfq.contracts) : null,
    cash_size: Number(rfq.targetCostDollars) > 0 ? Number(rfq.targetCostDollars) : null,
  };
  const d = evaluateSnipe(row, { config, ledger, nowMs, makerRate });
  if (d.action === 'quote') {
    d.releaseAt = releaseAtMs(legs, nowMs);
    // Per-leg detail for the fill alert + audit (sniper_decisions.details.legDetail).
    d.legDetail = legs.map((l) => ({ ticker: l.ticker, side: l.side, fair: l.fair_yes, venue: l.venue, depthUsd: l.depth_usd, name: l.name }));
  }
  return { decision: d, row };
}

// Fresh combo fair (product of per-leg best-of-venues $depth fairs) for send/confirm-time re-pricing.
function repriceFair(rfq, { pmLive, tdBook, venues }) {
  const cls = classifyNfl(rfq, 'kalshi', { td: !!tdBook });
  if (!cls.ok || cls.legs.length !== (rfq.legKeys || []).length) return null;
  let fair = 1;
  for (const leg of cls.legs) {
    const f = legFairDepth(leg, { pmLive, tdBook, venues });
    if (!(f.p > 0 && f.p < 1)) return null;
    fair *= f.p;
  }
  return fair;
}

module.exports = { decide, pregameCheck, legDate, repriceFair };
