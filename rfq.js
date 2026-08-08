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
  return {
    rfqId: m.id || m.rfq_id || null,
    mveCollection: m.mve_collection_ticker || null,
    legKeys,
    isCombo: !!(m.mve_collection_ticker || (legKeys && legKeys.length > 1)),
    contracts: parseContracts(m.contracts_fp),
    createdTs: m.created_ts || null,
  };
}
function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const A = [...a].sort(), B = [...b].sort();
  return A.every((x, i) => x === B[i]);
}
// parlays: rows from combo_parlays (leg_keys text[], mve_collection).
function matchParlay(rfq, parlays) {
  if (!rfq || !rfq.legKeys || !rfq.legKeys.length || !Array.isArray(parlays)) return null;
  for (const p of parlays) {
    const lk = p.leg_keys || p.legKeys;
    if (!Array.isArray(lk) || !lk.length) continue;
    if (p.mve_collection && rfq.mveCollection && p.mve_collection !== rfq.mveCollection) continue;
    if (sameSet(rfq.legKeys, lk)) return p;
  }
  return null;
}
module.exports = { parseEnvelope, isRfqCreated, normalizeRfq, matchParlay };
