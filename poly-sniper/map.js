// Polymarket combo leg -> equivalent Kalshi leg key, so the sniper's own fair model
// (sniper/engine classifyLegs + sniper/fair legFairDepth) prices it unchanged.
// Index: every listed Kalshi NFL ML / NCAAF ML / NFL TD ticker -> leg-identity key.
// Poly leg identity (leg-identity.js, the same parser Combo Locks uses) -> key -> ticker.
'use strict';
const L = require('../leg-identity');

function kalshiIdentity(ticker, label) {
  const t = String(ticker || '').toUpperCase();
  if (/^KXNFLGAME-/.test(t)) return L.parseKalshiTicker(`${t}:yes`);
  if (/^KXNCAAFGAME-/.test(t)) return L.parseKalshiNcaafMlTicker(t, 'yes', label, {});
  if (/^KXNFLTD-/.test(t)) return L.parseKalshiPropTicker(t, 'yes', label, {});
  return null;
}

function createKalshiIndex() {
  const byKey = new Map();
  function ingestMarkets(markets) {
    let n = 0;
    for (const m of markets || []) {
      const t = String((m && m.ticker) || '').toUpperCase();
      if (!t) continue;
      let id = null;
      try { id = kalshiIdentity(t, m.yes_sub_title || m.subtitle || m.title || null); } catch (_) { id = null; }
      const k = id && L.identityKey(id);
      if (k) { byKey.set(k, t); n += 1; }
    }
    return n;
  }
  return { ingestMarkets, lookup: (k) => byKey.get(k) || null, size: () => byKey.size };
}

function polyIdentity(leg) {
  const symbol = (leg && (leg.symbol || leg.slug || leg.market_slug)) || '';
  const yesNo = L.polymarketYesNo((leg && leg.side) || 'SIDE_BUY');
  if (!symbol || !yesNo) return { id: null, kind: null };
  if (L.isPolyLineSlug(symbol)) return { id: null, kind: 'line' }; // spreads/totals: not in sniper scope yet (#221)
  if (L.isPolyPropSlug(symbol)) return { id: L.identityFromPolymarketProp(symbol, yesNo, null).identity, kind: 'prop' };
  return { id: L.identityFromPolymarketSlug(symbol, yesNo), kind: 'ml' };
}

// -> { ok, legKeys:['KXNFLGAME-..-PHI:yes', ...], reason, unmapped:[symbol] }
function mapPolyLegs(comboLegs, index) {
  if (!Array.isArray(comboLegs) || comboLegs.length < 2) return { ok: false, reason: 'not_combo', legKeys: [] };
  const legKeys = []; const unmapped = [];
  for (const leg of comboLegs) {
    const { id, kind } = polyIdentity(leg);
    if (kind === 'line') return { ok: false, reason: 'scope_spread_total', legKeys: [] };
    if (!id) { unmapped.push(leg && leg.symbol); continue; }
    if (id.league !== 'nfl' && id.league !== 'ncaaf') return { ok: false, reason: `scope_${id.league}`, legKeys: [] };
    // TD / prop: Kalshi index is keyed on the :yes form; a No leg is the same market's :no.
    const yesForm = id.side === 'no' ? { ...id, side: 'yes' } : id;
    const t = index.lookup(L.identityKey(yesForm));
    if (!t) { unmapped.push(leg && leg.symbol); continue; }
    legKeys.push(`${t}:${id.side === 'no' ? 'no' : 'yes'}`);
  }
  if (unmapped.length) return { ok: false, reason: 'unmapped_leg', legKeys, unmapped };
  return { ok: true, legKeys };
}

module.exports = { createKalshiIndex, mapPolyLegs, polyIdentity, kalshiIdentity };
