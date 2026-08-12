// Parse Kalshi 'communications' messages + match a combo RFQ to a configured parlay.
'use strict';

function parseEnvelope(raw) {
  let e; try { e = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return null; }
  return (e && typeof e === 'object' && typeof e.type === 'string') ? e : null;
}
const isRfqCreated = (e) => e && e.type === 'rfq_created';

function normalizeLeg(leg) {
  if (leg == null) return null;
  if (typeof leg === 'string') return leg.trim().toUpperCase();
  const t = leg.market_ticker || leg.ticker || leg.event_ticker || leg.selected_market || '';
  const side = (leg.side || leg.selected_side || 'yes').toString().toLowerCase();
  return t ? `${t.trim().toUpperCase()}:${side}` : null;
}
function parseContracts(fp) {
  if (fp == null) return null;
  const n = typeof fp === 'string' ? parseFloat(fp) : Number(fp);
  return Number.isFinite(n) ? n : null;
}
function normalizeRfq(e) {
  const m = (e && e.msg) || {};
  const legsRaw = m.mve_selected_legs || m.selected_legs || null;
  const legKeys = Array.isArray(legsRaw) ? legsRaw.map(normalizeLeg).filter(Boolean).sort() : null;
  const targetCost = m.target_cost_dollars != null
    ? (typeof m.target_cost_dollars === 'string' ? parseFloat(m.target_cost_dollars) : Number(m.target_cost_dollars))
    : null;
  return {
    rfqId: m.id || m.rfq_id || null,
    marketTicker: m.market_ticker || m.ticker || null,
    mveCollection: m.mve_collection_ticker || null,
    legKeys,
    isCombo: !!(m.mve_collection_ticker || (legKeys && legKeys.length > 1)),
    contracts: parseContracts(m.contracts_fp != null ? m.contracts_fp : m.contracts),
    targetCostDollars: Number.isFinite(targetCost) && targetCost > 0 ? targetCost : null,
    createdTs: m.created_ts || null,
  };
}
function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const A = [...a].sort(), B = [...b].sort();
  return A.every((x, i) => x === B[i]);
}
// Match on the LEG SET only. The exact set of market tickers + sides uniquely identifies the
// combo; Kalshi files the same combo under different mve_collection tickers
// (KXMVESPORTSMULTIGAMEEXTENDED-R vs KXMVECROSSCATEGORY-R, etc.), so the collection must NOT gate
// the match — doing so previously rejected every RFQ even when all legs were identical.
function matchParlay(rfq, parlays) {
  if (!rfq || !rfq.legKeys || !rfq.legKeys.length || !Array.isArray(parlays)) return null;
  for (const p of parlays) {
    const lk = p.leg_keys || p.legKeys;
    if (!Array.isArray(lk) || !lk.length) continue;
    if (sameSet(rfq.legKeys, lk)) return p;
  }
  return null;
}
module.exports = { parseEnvelope, isRfqCreated, normalizeRfq, matchParlay };
