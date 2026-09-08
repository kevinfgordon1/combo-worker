// Quote-hot path: keep the Node event loop free while a Kalshi quote
// POST/confirm is in flight, and keep lock-ticker needles for a raw-string
// firehose filter (no JSON.parse of unmatched RFQs during that window).
//
// Date-only Combo Lock tickers (KXNFLGAME-26SEP13NESEA-SEA) do not appear
// verbatim on timed Kalshi RFQs (…26SEP131330NESEA-SEA). Team-pair blobs
// (NESEA, WASPHI) do. Do not use 2–3 letter team codes as needles — they
// false-positive on JSON keys ("no", "sf") and would process the whole book.
'use strict';

const MONTH = 'JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC';
const DATE_TEAMS = new RegExp(
  `^(?:\\d{2}(?:${MONTH})\\d{2})(?:\\d{4})?([A-Z]{4,})$`,
  'i'
);

function tickerCore(key) {
  const raw = String(key || '').trim();
  if (!raw) return '';
  const side = raw.lastIndexOf(':');
  return (side === -1 ? raw : raw.slice(0, side)).toUpperCase();
}

function teamPairFromTicker(ticker) {
  const core = tickerCore(ticker);
  if (!core) return null;
  const parts = core.split('-');
  if (parts.length < 2) return null;
  const blob = parts[1];
  const m = DATE_TEAMS.exec(blob);
  if (!m) return null;
  return m[1].toUpperCase();
}

function aliasTeamPairs(pair) {
  const p = String(pair || '').toUpperCase();
  if (!p) return [];
  const out = new Set([p]);
  const swaps = [
    ['JAC', 'JAX'],
    ['JAX', 'JAC'],
    ['GNB', 'GB'],
    ['GB', 'GNB'],
    ['WSH', 'WAS'],
    ['WAS', 'WSH'],
  ];
  for (const [a, b] of swaps) {
    if (p.includes(a)) out.add(p.split(a).join(b));
  }
  return [...out].filter((x) => x.length >= 4);
}

function needlesFromTicker(ticker) {
  const pair = teamPairFromTicker(ticker);
  if (!pair) return [];
  const out = new Set();
  for (const aliased of aliasTeamPairs(pair)) {
    if (aliased.length >= 4) out.add(aliased);
  }
  return [...out];
}

function lockNeedlesFromParlays(parlays) {
  const out = new Set();
  for (const p of parlays || []) {
    const keys = (p && (p.leg_keys || p.legKeys)) || [];
    if (Array.isArray(keys)) {
      for (const key of keys) {
        for (const n of needlesFromTicker(key)) out.add(n);
      }
    }
    if (Array.isArray(p && p.legs)) {
      for (const leg of p.legs) {
        const t = (leg && (leg.market_ticker || leg.marketTicker || leg.ticker)) || '';
        for (const n of needlesFromTicker(t)) out.add(n);
      }
    }
  }
  return [...out];
}

function rawLooksLikeLock(raw, needles) {
  if (!needles || !needles.length) return false;
  const s = typeof raw === 'string' ? raw : '';
  if (!s) return false;
  for (let i = 0; i < needles.length; i++) {
    const n = needles[i];
    if (n && s.includes(n)) return true;
  }
  return false;
}

function createQuoteHot() {
  let n = 0;
  let needles = [];
  return {
    begin() { n += 1; },
    end() { n = n > 0 ? n - 1 : 0; },
    get inFlight() { return n; },
    setNeedles(next) { needles = Array.isArray(next) ? next.filter(Boolean) : []; },
    getNeedles() { return needles; },
    // Empty needles → cannot tell a lock from the book; do not defer
    // (would hide the matching RFQ behind a setImmediate pile-up).
    shouldDeferCreated(raw) {
      if (n <= 0) return false;
      if (!needles.length) return false;
      return !rawLooksLikeLock(raw, needles);
    },
  };
}

module.exports = {
  teamPairFromTicker,
  aliasTeamPairs,
  needlesFromTicker,
  lockNeedlesFromParlays,
  rawLooksLikeLock,
  createQuoteHot,
};
