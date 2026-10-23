// Manual sportsbook hedges ("arb-outs") of sniper fills (table sniper_hedges, logged from My Fills).
// We hold NO on the Kalshi parlay (R = filled cost + fee, n contracts). A hedge is a bet ON the
// parlay at a book: stake S at decimal D pays S·D if the parlay hits.
//   hit  (every leg wins): −R + Σ S·(D−1)
//   miss (any leg loses) : (n − R) − Σ S
// Net worst-case loss = max(0, −min(hit, miss)). This is the ONLY number caps use for a hedged fill,
// so the cap reduction can never exceed the hedge's real worst case (an over-sized hedge can even
// raise it above R). Same formula as migrations/20261023f_sniper_hedges_caps.sql (sniper_hedged_risk).
'use strict';

function decimalOf(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || (a > -100 && a < 100)) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
}
const activeHedges = (hedges) => (hedges || []).filter((h) => h && (h.status == null || h.status === 'active') && Number(h.stake) > 0 && decimalOf(h.american) != null);

// fill: { n, cost, fee } (cost/fee = Kalshi filled cost/fee). -> { hit, miss, worst, best, netRisk, locked, stake, payout, hedges }
function hedgeOutcome(fill, hedges) {
  const n = Number(fill.n) || 0; const R = (Number(fill.cost) || 0) + (Number(fill.fee) || 0);
  const hs = activeHedges(hedges);
  const stake = hs.reduce((s, h) => s + Number(h.stake), 0);
  const payout = hs.reduce((s, h) => s + Number(h.stake) * decimalOf(h.american), 0); // returned incl. stake if parlay hits
  const hit = -R + (payout - stake); const miss = (n - R) - stake;
  const worst = Math.min(hit, miss); const best = Math.max(hit, miss);
  return { hit, miss, worst, best, netRisk: Math.max(0, -worst), locked: hs.length > 0 && Math.abs(hit - miss) < 0.05, stake, payout, hedges: hs.length };
}

// Cap risk for one open ledger row: unchanged unless it is a real fill with ≥1 active hedge.
function netRiskOf(row, hedges) {
  const gross = Number(row.risk) || 0;
  const n = Number(row.filled_contracts) || 0;
  if (!(n > 0) || row.phase !== 'filled' || !activeHedges(hedges).length) return gross;
  return hedgeOutcome({ n, cost: row.filled_cost, fee: row.filled_fee }, hedges).netRisk;
}

// P&L of a fill's hedges once the Kalshi parlay settled ('yes' = parlay hit = hedge wins).
function hedgePnl(marketResult, hedges) {
  const hs = activeHedges(hedges);
  if (marketResult === 'yes') return hs.reduce((s, h) => s + Number(h.stake) * (decimalOf(h.american) - 1), 0);
  if (marketResult === 'no') return -hs.reduce((s, h) => s + Number(h.stake), 0);
  return 0; // void / unknown: treat book bet as refunded
}

module.exports = { decimalOf, activeHedges, hedgeOutcome, netRiskOf, hedgePnl };
