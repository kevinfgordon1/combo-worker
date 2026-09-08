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
  return Array.isArray(top) ? top : null;
}

function normalizeRfq(e) {
  const m = rfqMsg(e);
  const legsRaw = collectLegsRaw(m);
  const legKeys = Array.isArray(legsRaw) ? legsRaw.map(normalizeLeg).filter(Boolean).sort() : null;
  const rawCost = firstPresent(m, COST_FIELDS) ?? firstPresent(m.rfq, COST_FIELDS);
  const targetCost = rawCost != null
    ? (typeof rawCost === 'string' ? parseFloat(rawCost) : Number(rawCost))
    : null;
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
function matchParlay(rfq, parlays) {
  if (!rfq || !Array.isArray(parlays)) return null;
  const rfqKeys = (rfq.legKeys || []).map(normalizeLegKey).filter(Boolean);
  if (!rfqKeys.length) return null;

  for (const p of parlays) {
    const lk = parlayKeys(p);
    if (lk.length && sameSet(rfqKeys, lk)) return p;
  }

  const rfqIds = identitiesFromKeys(rfqKeys);
  if (rfqIds.ok) {
    const hits = [];
    for (const p of parlays) {
      const lock = identitiesFromParlay(p);
      if (lock.ok && sameIdentitySet(rfqIds.keys, lock.keys)) hits.push(p);
    }
    if (hits.length === 1) return hits[0];
  }

  const rfqCanon = rfqKeys.map(canonicalizeLegKey).filter(Boolean);
  if (rfqCanon.length === rfqKeys.length) {
    const hits = [];
    for (const p of parlays) {
      const lk = parlayKeys(p);
      if (!lk.length || lk.length !== rfqCanon.length) continue;
      const canon = lk.map(canonicalizeLegKey).filter(Boolean);
      if (canon.length === lk.length && sameSet(rfqCanon, canon)) hits.push(p);
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
  parseEnvelope, isRfqCreated, isRfqClosed, normalizeRfq, normalizeRfqClosed, matchParlay,
  normalizeLeg, normalizeLegKey, canonicalizeLegKey, parlayKeys, sameSet,
  describeLockOverlap,
};
