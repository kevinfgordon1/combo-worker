// Polymarket combo leg -> equivalent Kalshi leg key, so the sniper's own fair model
// (sniper/engine classifyLegs + sniper/fair legFairDepth) prices it unchanged.
// Index: every listed Kalshi NFL ML / NCAAF ML / NFL TD ticker -> leg-identity key.
// Poly leg identity (leg-identity.js, the same parser Combo Locks uses) -> key -> ticker.
'use strict';
const L = require('../leg-identity');

// opts.idx = live player crosswalk index (prop-xwalk.js). Without it the TD parser only sees the
// checked-in snapshot, which has none of this week's players.
function kalshiIdentity(ticker, label, opts = {}) {
  const t = String(ticker || '').toUpperCase();
  if (/^KXNFLGAME-/.test(t)) return L.parseKalshiTicker(`${t}:yes`);
  if (/^KXNCAAFGAME-/.test(t)) return L.parseKalshiNcaafMlTicker(t, 'yes', label, {});
  if (/^KXNFLTD-/.test(t)) return L.parseKalshiPropTicker(t, 'yes', label, { idx: opts.idx || undefined });
  return null;
}

function createKalshiIndex() {
  const byKey = new Map();
  let propIdx = null;
  const td = { seen: 0, indexed: 0 };
  const tdMarkets = new Map(); // ticker -> market (kept so a crosswalk refresh can re-index)
  function ingestMarkets(markets) {
    let n = 0;
    for (const m of markets || []) {
      const t = String((m && m.ticker) || '').toUpperCase();
      if (!t) continue;
      const isTd = /^KXNFLTD-/.test(t);
      if (isTd) tdMarkets.set(t, m);
      let id = null;
      try { id = kalshiIdentity(t, m.yes_sub_title || m.subtitle || m.title || null, { idx: propIdx }); } catch (_) { id = null; }
      const k = id && L.identityKey(id);
      if (k) { byKey.set(k, t); n += 1; }
    }
    if (tdMarkets.size) recountTd();
    return n;
  }
  function recountTd() {
    td.seen = tdMarkets.size;
    td.indexed = [...byKey.values()].filter((t) => /^KXNFLTD-/.test(t)).length;
  }
  // Swap in a fresh live crosswalk; drop old TD keys and re-index every TD market we've listed.
  function setPropIdx(idx) {
    propIdx = idx || null;
    for (const [k, t] of byKey) if (/^KXNFLTD-/.test(t)) byKey.delete(k);
    const ms = [...tdMarkets.values()]; tdMarkets.clear();
    ingestMarkets(ms); recountTd();
  }
  return { ingestMarkets, setPropIdx, propIdx: () => propIdx, lookup: (k) => byKey.get(k) || null, size: () => byKey.size, tdStats: () => ({ ...td }) };
}

function polyIdentity(leg, propIdx) {
  const symbol = (leg && (leg.symbol || leg.slug || leg.market_slug)) || '';
  const yesNo = L.polymarketYesNo((leg && leg.side) || 'SIDE_BUY');
  if (!symbol || !yesNo) return { id: null, kind: null };
  if (L.isPolyLineSlug(symbol)) return { id: null, kind: 'line' }; // spreads/totals: not in sniper scope yet (#221)
  if (L.isPolyPropSlug(symbol)) return { id: L.identityFromPolymarketProp(symbol, yesNo, null, { idx: propIdx || undefined }).identity, kind: 'prop' };
  return { id: L.identityFromPolymarketSlug(symbol, yesNo), kind: 'ml' };
}

// -> { ok, legKeys:['KXNFLGAME-..-PHI:yes', ...], reason, unmapped:[symbol], matched:[{polySymbol,polySide,ticker,side}] }
// The live player crosswalk is read from index.propIdx() (feed refreshes it); TD Yes and No both map.
function mapPolyLegs(comboLegs, index) {
  if (!Array.isArray(comboLegs) || comboLegs.length < 2) return { ok: false, reason: 'not_combo', legKeys: [] };
  const propIdx = typeof index.propIdx === 'function' ? index.propIdx() : null;
  const legKeys = []; const unmapped = []; const matched = [];
  for (const leg of comboLegs) {
    const { id, kind } = polyIdentity(leg, propIdx);
    if (kind === 'line') return { ok: false, reason: 'scope_spread_total', legKeys: [] };
    if (!id) { unmapped.push(leg && leg.symbol); continue; }
    if (id.league !== 'nfl' && id.league !== 'ncaaf') return { ok: false, reason: `scope_${id.league}`, legKeys: [] };
    // TD / prop: Kalshi index is keyed on the :yes form; a No leg is the same market's :no.
    const yesForm = id.side === 'no' ? { ...id, side: 'yes' } : id;
    const t = index.lookup(L.identityKey(yesForm));
    if (!t) { unmapped.push(leg && leg.symbol); continue; }
    const side = id.side === 'no' ? 'no' : 'yes';
    legKeys.push(`${t}:${side}`);
    matched.push({ polySymbol: leg.symbol, polySide: leg.side, ticker: t, side });
  }
  if (unmapped.length) return { ok: false, reason: 'unmapped_leg', legKeys, unmapped, matched };
  return { ok: true, legKeys, matched };
}

module.exports = { createKalshiIndex, mapPolyLegs, polyIdentity, kalshiIdentity };
