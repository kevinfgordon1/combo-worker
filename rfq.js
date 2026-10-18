// Parse Kalshi 'communications' messages + match a combo RFQ to a configured parlay.
'use strict';
const {
  identitiesFromParlay,
  parseKalshiTicker,
  identityKey,
  sameIdentitySet,
} = require('./leg-identity');

function parseEnvelope(raw) {
  let e; try { e = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return null; }
  return (e && typeof e === 'object' && typeof e.type === 'string') ? e : null;
}

// Cheap type peek so a quote-hot firehose can skip JSON.parse of unmatched
// rfq_created frames. Kalshi puts type at the top level; first match wins.
function peekEnvelopeType(raw) {
  if (raw && typeof raw === 'object' && typeof raw.type === 'string') return raw.type;
  if (typeof raw !== 'string') return null;
  const m = /"type"\s*:\s*"([a-z0-9_]+)"/i.exec(raw);
  return m ? m[1] : null;
}
const isRfqCreated = (e) => e && e.type === 'rfq_created';
// Docs broadcast rfq_deleted to all communications subscribers (expire / delete /
// replace_existing / execute). Treat nearby close types the same if they appear.
const isRfqClosed = (e) => e && (
  e.type === 'rfq_deleted' || e.type === 'rfq_expired' || e.type === 'rfq_closed'
);

function rfqIdFromMsg(m) {
  if (!m) return null;
  return m.id || m.rfq_id || null;
}

function normalizeRfqClosed(e) {
  const m = (e && e.msg) || {};
  const type = e && e.type;
  return {
    rfqId: rfqIdFromMsg(m),
    reason: type === 'rfq_expired' ? 'expired' : 'deleted',
    deletedTs: m.deleted_ts || m.expired_ts || m.closed_ts || null,
    raw: m,
  };
}

// Combo Locks + Kalshi RFQs use TICKER:yes|no. String legs that already include
// a side must not become TICKER:YES (uppercase side) — sameSet would miss.
function normalizeLegKey(key) {
  if (key == null || key === '') return null;
  if (typeof key === 'object') return normalizeLeg(key);
  const s = String(key).trim();
  if (!s) return null;
  const i = s.lastIndexOf(':');
  if (i <= 0) return `${s.toUpperCase()}:yes`;
  const maybe = s.slice(i + 1).toLowerCase();
  if (maybe === 'yes' || maybe === 'no') {
    return `${s.slice(0, i).trim().toUpperCase()}:${maybe}`;
  }
  return `${s.toUpperCase()}:yes`;
}

function normalizeLeg(leg) {
  if (leg == null) return null;
  if (typeof leg === 'string') return normalizeLegKey(leg);
  const t = leg.market_ticker || leg.marketTicker || leg.ticker
    || leg.selected_ticker || leg.selected_market
    || leg.event_ticker || leg.eventTicker || '';
  const side = (leg.side || leg.selected_side || 'yes').toString().toLowerCase();
  return t ? `${String(t).trim().toUpperCase()}:${side === 'no' ? 'no' : 'yes'}` : null;
}

function parseContracts(fp) {
  if (fp == null) return null;
  const n = typeof fp === 'string' ? parseFloat(fp) : Number(fp);
  return Number.isFinite(n) ? n : null;
}

function firstPresent(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v == null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    return v;
  }
  return null;
}

const LEG_FIELDS = [
  'mve_selected_legs', 'selected_legs', 'legs', 'mve_legs',
  'mveSelectedLegs', 'selectedLegs',
];
const COST_FIELDS = [
  'target_cost_dollars', 'rfq_target_cost_dollars', 'target_cost', 'cash_order_qty',
];

function looksLikeLeg(x) {
  if (x == null) return false;
  if (typeof x === 'string') return /KX[A-Z]+-/i.test(x) || x.includes(':');
  if (typeof x !== 'object') return false;
  return !!(
    x.market_ticker || x.marketTicker || x.ticker
    || x.selected_ticker || x.selected_market
    || x.event_ticker || x.eventTicker
  );
}

// Official docs still say mve_selected_legs. If Kalshi renames the array,
// walk the payload for any 2+ item list of ticker/side objects so collection
// tickers cannot increment combos while matchParlay sees zero keys.
function harvestLegArrays(obj, out, depth) {
  if (!obj || typeof obj !== 'object' || depth > 5) return;
  if (Array.isArray(obj)) {
    if (obj.length >= 2 && obj.every(looksLikeLeg)) out.push(obj);
    else for (const x of obj) harvestLegArrays(x, out, depth + 1);
    return;
  }
  for (const v of Object.values(obj)) harvestLegArrays(v, out, depth + 1);
}

// WS rfq_created usually has fields on msg. If Kalshi nests the RFQ
// (msg.rfq / msg.data), merge so empty top-level mve_selected_legs: []
// cannot hide a populated nested legs array.
function rfqMsg(e) {
  const m = (e && e.msg && typeof e.msg === 'object') ? e.msg : (e && typeof e === 'object' ? e : {});
  const nested = [m.rfq, m.data, m.payload].find((x) => x && typeof x === 'object' && !Array.isArray(x));
  return nested ? { ...nested, ...m } : m;
}

function collectLegsRaw(m) {
  const top = firstPresent(m, LEG_FIELDS);
  if (Array.isArray(top) && top.length) return top;
  for (const nest of [m.rfq, m.data, m.payload]) {
    if (!nest || typeof nest !== 'object') continue;
    const inner = firstPresent(nest, LEG_FIELDS);
    if (Array.isArray(inner) && inner.length) return inner;
  }
  const harvested = [];
  harvestLegArrays(m, harvested, 0);
  if (harvested.length) {
    harvested.sort((a, b) => b.length - a.length);
    return harvested[0];
  }
  return Array.isArray(top) ? top : null;
}

function parseCreatorId(m) {
  const raw = firstPresent(m, ['creator_id', 'creatorId'])
    ?? firstPresent(m && m.rfq, ['creator_id', 'creatorId']);
  if (raw == null) return null;
  const s = String(raw).trim();
  return s || null;
}

function parseTargetCost(m) {
  const rawCost = firstPresent(m, COST_FIELDS) ?? firstPresent(m && m.rfq, COST_FIELDS);
  if (rawCost != null) {
    const n = typeof rawCost === 'string' ? parseFloat(rawCost) : Number(rawCost);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Create RFQ still documents deprecated target_cost_centi_cents (1e-4 USD).
  const centi = firstPresent(m, ['target_cost_centi_cents', 'targetCostCentiCents'])
    ?? firstPresent(m && m.rfq, ['target_cost_centi_cents', 'targetCostCentiCents']);
  if (centi == null) return null;
  const c = typeof centi === 'string' ? parseFloat(centi) : Number(centi);
  return Number.isFinite(c) && c > 0 ? c / 10000 : null;
}

function normalizeRfq(e) {
  const m = rfqMsg(e);
  const legsRaw = collectLegsRaw(m);
  const legKeys = Array.isArray(legsRaw) ? legsRaw.map(normalizeLeg).filter(Boolean).sort() : null;
  const targetCost = parseTargetCost(m);
  const contractsRaw = m.contracts_fp != null ? m.contracts_fp
    : (m.contracts != null ? m.contracts
      : (m.rfq && (m.rfq.contracts_fp != null ? m.rfq.contracts_fp : m.rfq.contracts)));
  return {
    rfqId: rfqIdFromMsg(m) || rfqIdFromMsg(m.rfq),
    marketTicker: m.market_ticker || m.ticker || (m.rfq && (m.rfq.market_ticker || m.rfq.ticker)) || null,
    mveCollection: m.mve_collection_ticker || m.mveCollectionTicker
      || (m.rfq && (m.rfq.mve_collection_ticker || m.rfq.mveCollectionTicker)) || null,
    legKeys,
    legs: Array.isArray(legsRaw) ? legsRaw : null,
    isCombo: !!(
      m.mve_collection_ticker || m.mveCollectionTicker
      || (m.rfq && (m.rfq.mve_collection_ticker || m.rfq.mveCollectionTicker))
      || (legKeys && legKeys.length > 1)
    ),
    contracts: parseContracts(contractsRaw),
    targetCostDollars: Number.isFinite(targetCost) && targetCost > 0 ? targetCost : null,
    creatorId: parseCreatorId(m),
    createdTs: m.created_ts || (m.rfq && m.rfq.created_ts) || null,
  };
}

function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const A = [...a].sort(), B = [...b].sort();
  return A.every((x, i) => x === B[i]);
}

function parlayKeys(p) {
  if (!p) return [];
  const raw = p.leg_keys || p.legKeys;
  if (Array.isArray(raw) && raw.length) {
    return raw.map(normalizeLegKey).filter(Boolean);
  }
  if (Array.isArray(p.legs) && p.legs.length) {
    return p.legs.map(normalizeLeg).filter(Boolean);
  }
  return [];
}

// Production NFL Combo Locks are date-only (KXNFLGAME-26SEP13ARILAC-ARI).
// Live Kalshi market tickers for the same game often include kickoff HHMM
// (KXNFLGAME-26SEP131330ARILAC-ARI). Strip a valid HHMM after YYMONDD so
// spread/total legs (not in GAME identity SERIES) still match.
const YYMONDD_HHMM = /^(\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2})(\d{4})(?!\d)/i;

function stripKalshiHhmm(ticker) {
  const raw = String(ticker || '');
  const dash = raw.indexOf('-');
  if (dash <= 0) return raw;
  const series = raw.slice(0, dash);
  const rest = raw.slice(dash + 1);
  const m = YYMONDD_HHMM.exec(rest);
  if (!m) return raw;
  const hh = parseInt(m[2].slice(0, 2), 10);
  const mm = parseInt(m[2].slice(2, 4), 10);
  if (hh > 23 || mm > 59) return raw;
  return `${series}-${m[1]}${rest.slice(m[0].length)}`;
}

function canonicalizeLegKey(key) {
  const norm = normalizeLegKey(key);
  if (!norm) return null;
  const i = norm.lastIndexOf(':');
  return `${stripKalshiHhmm(norm.slice(0, i))}:${norm.slice(i + 1)}`;
}

function identitiesFromKeys(keys) {
  if (!Array.isArray(keys) || !keys.length) return { ok: false, keys: [] };
  return identitiesFromParlay({ leg_keys: keys });
}

// Match on the LEG SET only. The exact set of market tickers + sides uniquely identifies the
// combo; Kalshi files the same combo under different mve_collection tickers
// (KXMVESPORTSMULTIGAMEEXTENDED-R vs KXMVECROSSCATEGORY-R, etc.), so the collection must NOT gate
// the match — doing so previously rejected every RFQ even when all legs were identical.
//
// After exact (case-normalized) compare, fall back to:
//   1. Combo Locks sports identity (Poly already does this) — NFL date-only
//      lock keys vs timed Kalshi RFQ tickers, JAC/JAX aliases.
//   2. HHMM-stripped ticker set — mixed SPREAD/TOTAL locks that identity
//      cannot parse.
// Oct 18 hotfix (Sunday flood): ~99.9% of RFQs miss every lock, and each miss
// recomputed every lock's keys / identities / canonical keys (~1ms per RFQ at
// ~90 locks, more CPU than one thread has at ~3.5k RFQs/s).
//   1. Per-lock derived data is memoized per lock object (WeakMap). The runner
//      replaces lock objects on every refresh, so the cache resets with them.
//   2. A per-array index (WeakMap keyed by the parlays array) holds the union of
//      every lock's normalized keys, identity keys and canonical keys. Every
//      pass below is a multiset equality, so a lock can only match if EVERY RFQ
//      leg appears in that lock. If some RFQ leg is in none of the three unions
//      (normalized / canonical / identity), no pass can match: return null.
//      Results are identical to the unindexed code (see match-diff test).
const lockDerivedMemo = new WeakMap();
function lockDerived(p) {
  if (!p || typeof p !== 'object') {
    const keys = parlayKeys(p);
    const canon = keys.map(canonicalizeLegKey).filter(Boolean);
    return { keys, ids: identitiesFromParlay(p), canon, canonOk: canon.length === keys.length };
  }
  let d = lockDerivedMemo.get(p);
  if (!d) {
    const keys = parlayKeys(p);
    const canon = keys.map(canonicalizeLegKey).filter(Boolean);
    d = { keys, ids: identitiesFromParlay(p), canon, canonOk: canon.length === keys.length };
    lockDerivedMemo.set(p, d);
  }
  return d;
}

const matchIndexMemo = new WeakMap();
function matchIndex(parlays) {
  let idx = matchIndexMemo.get(parlays);
  if (idx) return idx;
  const norm = new Set();
  const ids = new Set();
  const canon = new Set();
  for (const p of parlays) {
    const d = lockDerived(p);
    for (const k of d.keys) norm.add(k);
    if (d.ids && d.ids.ok) for (const k of d.ids.keys) ids.add(k);
    for (const k of d.canon) canon.add(k);
  }
  idx = { norm, ids, canon };
  matchIndexMemo.set(parlays, idx);
  return idx;
}

// Pure per-leg facts, cached by normalized leg key (legs repeat heavily).
const LEG_FACTS_MAX = 200000;
let legFacts = new Map();
function legFactsFor(k) {
  let f = legFacts.get(k);
  if (f) return f;
  const r = identitiesFromParlay({ leg_keys: [k] });
  f = { canon: canonicalizeLegKey(k), id: r && r.ok && r.keys.length === 1 ? r.keys[0] : null };
  if (legFacts.size >= LEG_FACTS_MAX) legFacts = new Map();
  legFacts.set(k, f);
  return f;
}

function couldMatchAny(rfqKeys, idx) {
  for (const k of rfqKeys) {
    if (idx.norm.has(k)) continue;
    const f = legFactsFor(k);
    if (f.canon && idx.canon.has(f.canon)) continue;
    if (f.id && idx.ids.has(f.id)) continue;
    return false;
  }
  return true;
}

function matchParlay(rfq, parlays) {
  if (!rfq || !Array.isArray(parlays)) return null;
  const rfqKeys = (rfq.legKeys || []).map(normalizeLegKey).filter(Boolean);
  if (!rfqKeys.length) return null;
  if (!couldMatchAny(rfqKeys, matchIndex(parlays))) return null;
  return matchParlayFull(rfqKeys, parlays);
}

function matchParlayFull(rfqKeys, parlays) {
  for (const p of parlays) {
    const lk = lockDerived(p).keys;
    if (lk.length && sameSet(rfqKeys, lk)) return p;
  }

  const rfqIds = identitiesFromKeys(rfqKeys);
  if (rfqIds.ok) {
    const hits = [];
    for (const p of parlays) {
      const lock = lockDerived(p).ids;
      if (lock.ok && sameIdentitySet(rfqIds.keys, lock.keys)) hits.push(p);
    }
    if (hits.length === 1) return hits[0];
  }

  const rfqCanon = rfqKeys.map(canonicalizeLegKey).filter(Boolean);
  if (rfqCanon.length === rfqKeys.length) {
    const hits = [];
    for (const p of parlays) {
      const d = lockDerived(p);
      const lk = d.keys;
      if (!lk.length || lk.length !== rfqCanon.length) continue;
      if (d.canonOk && sameSet(rfqCanon, d.canon)) hits.push(p);
    }
    if (hits.length === 1) return hits[0];
  }

  return null;
}

// For LOCK-MISS logs: how many canonical tickers overlap a staged lock.
function describeLockOverlap(rfq, parlays) {
  const rfqCanon = new Set((rfq && rfq.legKeys || []).map(canonicalizeLegKey).filter(Boolean));
  if (!rfqCanon.size || !Array.isArray(parlays)) return '';
  const bits = [];
  for (const p of parlays) {
    const lk = parlayKeys(p);
    let n = 0;
    for (const k of lk) {
      if (rfqCanon.has(canonicalizeLegKey(k))) n += 1;
    }
    if (n) bits.push(`${p.label || p.id}:${n}/${lk.length}`);
  }
  return bits.join(',');
}

module.exports = {
  parseEnvelope, peekEnvelopeType, isRfqCreated, isRfqClosed, normalizeRfq, normalizeRfqClosed, matchParlay,
  normalizeLeg, normalizeLegKey, canonicalizeLegKey, parlayKeys, sameSet,
  describeLockOverlap,
};
