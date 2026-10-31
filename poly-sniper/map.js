// Polymarket combo leg -> equivalent Kalshi leg key, so the sniper's own fair model
// (sniper/engine classifyLegs + sniper/fair legFairDepth) prices it unchanged.
// Index: every listed Kalshi NFL ML / NCAAF ML / NBA ML / NCAAB ML (D1) / NFL TD ticker -> leg-identity key,
// plus every Kalshi NFL / NCAAF / NBA spread and total strike (both Yes and No) -> key.
// Poly leg identity (leg-identity.js, the same parser Combo Locks uses) -> key -> ticker.
//
// Spreads / totals (Kevin Oct 28, dry run): EXACT line only, both ways verified:
//   Kalshi: ticker strike N must equal the market's own floor_strike + 0.5 with strike_type
//           'greater' (the venue's metadata proves "N means N−0.5"), else the strike is not indexed.
//   Poly:   the leg maps ONLY with verified public market metadata (sportsMarketType, line, teams,
//           long side, game date: identityFromPolymarketLine). No metadata yet => skip
//           'line_meta_pending' (feed fetches it from the public gateway; later RFQs map).
'use strict';
const L = require('../leg-identity');

const LINE_TICKER_RE = /^KX(NFL|NCAAF|NBA)(SPREAD|TOTAL)-/;
const isKalshiLineTicker = (t) => LINE_TICKER_RE.test(String(t || '').toUpperCase());

// opts.idx = live player crosswalk index (prop-xwalk.js). Without it the TD parser only sees the
// checked-in snapshot, which has none of this week's players.
function kalshiIdentity(ticker, label, opts = {}) {
  const t = String(ticker || '').toUpperCase();
  if (/^KXNFLGAME-/.test(t)) return L.parseKalshiTicker(`${t}:yes`);
  if (/^KXNBAGAME-/.test(t)) return L.parseKalshiTicker(`${t}:yes`);
  if (/^KXNCAAFGAME-/.test(t)) return L.parseKalshiNcaafMlTicker(t, 'yes', label, {});
  if (/^KXNCAAMBGAME-/.test(t)) return L.parseKalshiNcaabMlTicker(t, 'yes', label); // D1 college basketball ML only
  if (/^KXNFLTD-/.test(t)) return L.parseKalshiPropTicker(t, 'yes', label, { idx: opts.idx || undefined });
  return null;
}

// Kalshi spread/total market -> [{ key, ticker, side }] for Yes and No, or [] when the market's own
// strike metadata does not prove the ticker's line (fail closed).
function kalshiLineEntries(m) {
  const t = String((m && m.ticker) || '').toUpperCase();
  if (!isKalshiLineTicker(t)) return [];
  const strike = Number(m.floor_strike);
  if (!Number.isFinite(strike) || String(m.strike_type || '').toLowerCase() !== 'greater') return [];
  const n = /-(?:[A-Z]+)?(\d{1,3})$/.exec(t);
  if (!n || Number(n[1]) - 0.5 !== strike) return [];
  const out = [];
  for (const side of ['yes', 'no']) {
    let id = null;
    try { id = L.parseKalshiLineTicker(t, side, null, {}); } catch (_) { id = null; }
    if (!id || !Number.isFinite(Number(id.line)) || Math.abs(Number(id.line)) !== strike) return [];
    const key = L.identityKey(id);
    if (!key) return [];
    out.push({ key, ticker: t, side });
  }
  return out;
}

function createKalshiIndex() {
  const byKey = new Map();
  const lineByKey = new Map(); // identity key -> 'TICKER:side' (null = two tickers claim it: ambiguous)
  let propIdx = null;
  const td = { seen: 0, indexed: 0 };
  const lines = { seen: 0, indexed: 0, rejected: 0 };
  const tdMarkets = new Map(); // ticker -> market (kept so a crosswalk refresh can re-index)
  function ingestMarkets(markets) {
    let n = 0;
    for (const m of markets || []) {
      const t = String((m && m.ticker) || '').toUpperCase();
      if (!t) continue;
      if (isKalshiLineTicker(t)) {
        lines.seen += 1;
        const es = kalshiLineEntries(m);
        if (!es.length) { lines.rejected += 1; continue; }
        for (const e of es) {
          const v = `${e.ticker}:${e.side}`;
          if (lineByKey.has(e.key) && lineByKey.get(e.key) !== v) lineByKey.set(e.key, null);
          else lineByKey.set(e.key, v);
        }
        lines.indexed += 1; n += 1;
        continue;
      }
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
  function lookupLine(k) {
    const v = lineByKey.get(k);
    if (!v) return null;
    const i = v.lastIndexOf(':');
    return { ticker: v.slice(0, i), side: v.slice(i + 1) };
  }
  return {
    ingestMarkets, setPropIdx, propIdx: () => propIdx, lookup: (k) => byKey.get(k) || null, lookupLine,
    size: () => byKey.size + lineByKey.size, tdStats: () => ({ ...td }), lineStats: () => ({ ...lines, keys: lineByKey.size }),
  };
}

// lineMeta (optional): { get(slug) -> market | null | undefined, want(slug) } — verified public
// Polymarket market metadata. undefined = not fetched yet; null = fetched, unusable.
function polyIdentity(leg, propIdx, lineMeta) {
  const symbol = (leg && (leg.symbol || leg.slug || leg.market_slug)) || '';
  const yesNo = L.polymarketYesNo((leg && leg.side) || 'SIDE_BUY');
  if (!symbol || !yesNo) return { id: null, kind: null };
  if (L.isPolyLineSlug(symbol)) {
    if (!lineMeta || typeof lineMeta.get !== 'function') return { id: null, kind: 'line', reason: 'scope_spread_total' };
    const meta = lineMeta.get(symbol);
    if (meta === undefined) { if (typeof lineMeta.want === 'function') lineMeta.want(symbol); return { id: null, kind: 'line', reason: 'line_meta_pending' }; }
    if (!meta) return { id: null, kind: 'line', reason: 'line_meta_missing' };
    const r = L.identityFromPolymarketLine(symbol, yesNo, meta);
    if (!r.identity || !r.verified) return { id: null, kind: 'line', reason: `line_${r.reason || 'unverified'}` };
    return { id: r.identity, kind: 'line' };
  }
  if (L.isPolyPropSlug(symbol)) return { id: L.identityFromPolymarketProp(symbol, yesNo, null, { idx: propIdx || undefined }).identity, kind: 'prop' };
  return { id: L.identityFromPolymarketSlug(symbol, yesNo), kind: 'ml' };
}

// -> { ok, legKeys:['KXNFLGAME-..-PHI:yes', ...], reason, unmapped:[symbol], matched:[{polySymbol,polySide,ticker,side}] }
// The live player crosswalk is read from index.propIdx() (feed refreshes it); TD Yes and No both map.
// opts.leagues: leagues in scope (default nfl + ncaaf). opts.lineMeta: see polyIdentity (lines off without it).
function mapPolyLegs(comboLegs, index, opts = {}) {
  if (!Array.isArray(comboLegs) || comboLegs.length < 2) return { ok: false, reason: 'not_combo', legKeys: [] };
  const leagues = opts.leagues || ['nfl', 'ncaaf'];
  const propIdx = typeof index.propIdx === 'function' ? index.propIdx() : null;
  const legKeys = []; const unmapped = []; const matched = [];
  for (const leg of comboLegs) {
    const { id, kind, reason } = polyIdentity(leg, propIdx, opts.lineMeta);
    if (kind === 'line' && !id) return { ok: false, reason: reason || 'scope_spread_total', legKeys: [] };
    if (!id) { unmapped.push(leg && leg.symbol); continue; }
    if (!leagues.includes(id.league)) return { ok: false, reason: `scope_${id.league}`, legKeys: [] };
    let t; let side;
    if (kind === 'line') {
      // Exact identity (team, signed line, over/under) -> the one Kalshi strike + side that means it.
      const hit = typeof index.lookupLine === 'function' ? index.lookupLine(L.identityKey(id)) : null;
      if (!hit) { unmapped.push(leg && leg.symbol); continue; }
      t = hit.ticker; side = hit.side;
    } else {
      // TD / prop: Kalshi index is keyed on the :yes form; a No leg is the same market's :no.
      const yesForm = id.side === 'no' ? { ...id, side: 'yes' } : id;
      t = index.lookup(L.identityKey(yesForm));
      side = id.side === 'no' ? 'no' : 'yes';
    }
    if (!t) { unmapped.push(leg && leg.symbol); continue; }
    legKeys.push(`${t}:${side}`);
    matched.push({ polySymbol: leg.symbol, polySide: leg.side, ticker: t, side });
  }
  if (unmapped.length) return { ok: false, reason: 'unmapped_leg', legKeys, unmapped, matched };
  return { ok: true, legKeys, matched };
}

module.exports = { createKalshiIndex, mapPolyLegs, polyIdentity, kalshiIdentity, kalshiLineEntries, isKalshiLineTicker };
