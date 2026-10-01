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

function legKeysOfParlay(p) {
  const out = [];
  const keys = p && (p.leg_keys || p.legKeys);
  if (Array.isArray(keys)) {
    for (const key of keys) if (key) out.push(key);
  }
  if (Array.isArray(p && p.legs)) {
    for (const leg of p.legs) {
      const t = leg && (leg.market_ticker || leg.marketTicker || leg.ticker);
      if (t) out.push(t);
    }
  }
  return out;
}

// Legs that are not NFL/NBA-style team-pair tickers still need a substring
// that survives a Kalshi HHMM insert. Prefer that token over the full ticker
// (the full date-only string is absent from the timed RFQ).
function fallbackNeedle(ticker) {
  const core = tickerCore(ticker);
  const parts = core.split('-');
  let best = '';
  for (let i = 1; i < parts.length; i++) {
    const stripped = parts[i].replace(
      /^\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}\d{0,4}/i,
      ''
    );
    if (stripped.length >= 4 && /[A-Z]/i.test(stripped) && stripped.length > best.length) {
      best = stripped.toUpperCase();
    }
  }
  if (best) return best;
  if (core.length >= 8) return core;
  return null;
}

function needlesForLeg(ticker) {
  const pairs = needlesFromTicker(ticker);
  if (pairs.length) return pairs;
  const one = fallbackNeedle(ticker);
  return one ? [one] : [];
}

// enabled=false when any matchable lock has no needle — dropping those RFQs
// would miss quotes. Zero locks is enabled with an empty needle list (drop
// every rfq_created; nothing can match).
function lockNeedlePlan(parlays) {
  const needles = new Set();
  let uncovered = 0;
  for (const p of parlays || []) {
    const keys = legKeysOfParlay(p);
    if (!keys.length) continue;
    const found = [];
    for (const key of keys) {
      for (const n of needlesForLeg(key)) found.push(n);
    }
    if (!found.length) {
      uncovered += 1;
      continue;
    }
    for (const n of found) needles.add(n);
  }
  return {
    needles: [...needles],
    uncovered,
    enabled: uncovered === 0,
  };
}

function lockNeedlesFromParlays(parlays) {
  return lockNeedlePlan(parlays).needles;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileNeedleMatcher(needles) {
  const list = [];
  const bufs = [];
  for (const n of needles || []) {
    if (!n) continue;
    const s = String(n);
    list.push(s);
    bufs.push(Buffer.from(s));
  }
  if (!list.length) return null;
  const re = new RegExp(list.map(escapeRe).join('|'));
  return function matches(raw) {
    if (raw == null) return false;
    if (typeof raw === 'string') return re.test(raw);
    if (Buffer.isBuffer(raw)) {
      for (let i = 0; i < bufs.length; i++) {
        if (raw.indexOf(bufs[i]) !== -1) return true;
      }
      return false;
    }
    return re.test(String(raw));
  };
}

function fastDropDisabled(env = process.env) {
  const raw = env && env.KALSHI_WS_FAST_DROP;
  if (raw == null || raw === '') return false;
  return /^(0|false|off|no)$/i.test(String(raw).trim());
}

// KALSHI_WS_DROP_DELETED=0 turns the rfq_deleted fast-drop off (parse every close frame again).
function dropDeletedDisabled(env = process.env) {
  const raw = env && env.KALSHI_WS_DROP_DELETED;
  if (raw == null || raw === '') return false;
  return /^(0|false|off|no)$/i.test(String(raw).trim());
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

// KALSHI_WS_DROP_DELETED=0 turns the rfq_deleted fast-drop off (parse every close frame again).
function dropDeletedDisabled(env = process.env) {
  const raw = env && env.KALSHI_WS_DROP_DELETED;
  if (raw == null || raw === '') return false;
  return /^(0|false|off|no)$/i.test(String(raw).trim());
}

// rfq_deleted frames are one per closed RFQ (~half the communications firehose). The runner
// only needs one when it holds a reserve / pending quote for that rfq_id. `forEachRfqId(cb)`
// walks the (small) set of rfq ids currently pending; a frame is dropped unless its raw text
// mentions one. Exact-substring test — never drops a frame for an RFQ we are tracking.
function createDeletedFilter(forEachRfqId) {
  return function shouldDropDeleted(raw) {
    const s = typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
    let keep = false;
    forEachRfqId((id) => {
      if (!keep && id && s.includes(id)) keep = true;
    });
    return !keep;
  };
}

function createQuoteHot() {
  let n = 0;
  let needles = [];
  let dropEnabled = false;
  let uncovered = 0;
  let matcher = null;

  function setPlan(plan) {
    const next = plan || {};
    needles = Array.isArray(next.needles) ? next.needles.filter(Boolean) : [];
    uncovered = Number(next.uncovered) || 0;
    dropEnabled = !!next.enabled && uncovered === 0;
    matcher = compileNeedleMatcher(needles);
  }

  function matches(raw) {
    if (!matcher) return false;
    return matcher(raw);
  }

  return {
    begin() { n += 1; },
    end() { n = n > 0 ? n - 1 : 0; },
    get inFlight() { return n; },
    setNeedles(next) {
      const list = Array.isArray(next) ? next.filter(Boolean) : [];
      setPlan({ needles: list, uncovered: 0, enabled: list.length > 0 });
    },
    setPlan,
    getNeedles() { return needles; },
    uncovered() { return uncovered; },
    fastDropEnabled() { return dropEnabled; },
    // Empty needles → cannot tell a lock from the book; do not defer
    // (would hide the matching RFQ behind a setImmediate pile-up).
    shouldDeferCreated(raw) {
      if (n <= 0) return false;
      if (!needles.length) return false;
      return !matches(raw);
    },
    // True → rfq_created is not a configured lock. Caller must not use this
    // for quote_* or rfq close frames.
    shouldDropCreated(raw) {
      if (!dropEnabled) return false;
      if (!needles.length) return true;
      return !matches(raw);
    },
  };
}

module.exports = {
  teamPairFromTicker,
  aliasTeamPairs,
  needlesFromTicker,
  lockNeedlesFromParlays,
  lockNeedlePlan,
  fallbackNeedle,
  rawLooksLikeLock,
  fastDropDisabled,
  dropDeletedDisabled,
  createDeletedFilter,
  createQuoteHot,
};
