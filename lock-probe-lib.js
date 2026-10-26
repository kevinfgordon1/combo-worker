// COPY of aibetbuilder api/combo-probe-lib.js (pure helpers, no I/O) for the server-side
// Combo Locks auto market check (lock-auto-check.js). Keep in sync with aibetbuilder.
// Pure Combo Locks Probe helpers — quote picking + American conversion.
// Kevin sells NO as maker. Competing makers quote no_bid / yes_bid; we report
// the best (highest) NO bid and the after-maker-fee American that belongs in
// the Add Parlay fill field. Never accept / confirm.
'use strict';

const KFEE = 0.0175; // legacy default; probe now passes the combo series' real maker rate
const FALLBACK_MAKER_RATE = 0.035; // unknown series (same as combo-worker / src/buyerOdds.js)
const DEFAULT_WAIT_MS = 4000;
const MIN_WAIT_MS = 2000;
const MAX_WAIT_MS = 8000;
const PRICE_TICK = 0.01;
const OWNER_EMAIL = 'kev120909@gmail.com';
const COMBO_COLLECTION = process.env.KALSHI_COMBO_COLLECTION || 'KXMVESPORTSMULTIGAMEEXTENDED-R';
// Sports combo collections the probe may fall back to when a leg's event is not in the
// requested one (first collection that contains EVERY leg wins).
const COMBO_COLLECTION_CANDIDATES = ['KXMVESPORTSMULTIGAMEEXTENDED-R', 'KXMVECROSSCATEGORY-R'];

/** Kalshi GET /series fee terms → maker rate (mirror of src/buyerOdds.js makerRateFromSeries). */
function makerRateFromSeries(feeType, multiplier) {
  const m = Number(multiplier);
  const mult = Number.isFinite(m) && m >= 0 ? m : 1;
  switch (String(feeType || '')) {
    case 'quadratic': return 0;
    case 'quadratic_with_maker_fees': return 0.0175 * mult;
    case 'quadratic_with_combo_maker_fees': return 0.035 * mult;
    default: return FALLBACK_MAKER_RATE;
  }
}

function rateOf(k) {
  const n = Number(k);
  return Number.isFinite(n) && n >= 0 ? n : KFEE;
}
const KALSHI_API_BASE = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';

function clampWaitMs(waitMs) {
  const n = Number(waitMs);
  if (!Number.isFinite(n)) return DEFAULT_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.round(n)));
}

function parsePrice(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Dollars in (0,1), or integer cents 1–99 (older Kalshi quote fields). */
function parseBidPrice(v) {
  const n = parsePrice(v);
  if (n == null) return null;
  if (n > 0 && n < 1) return n;
  if (Number.isInteger(n) && n >= 1 && n <= 99) return n / 100;
  return n;
}

function quotesListPath(rfqId) {
  const id = encodeURIComponent(String(rfqId || ''));
  // Kalshi requires a user-id filter on GET /communications/quotes.
  // rfq_id alone is not enough — the RFQ creator must pass rfq_user_filter=self
  // or the list comes back empty / is rejected. See Kalshi Get Quotes + SDK:
  // "quotes responding to RFQs created by the authenticated user".
  return `/communications/quotes?rfq_id=${id}&rfq_user_filter=self`;
}

function impliedProb(a) {
  const n = Number(a);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
}

function americanFromProb(p) {
  const n = Number(p);
  if (!(n > 0 && n < 1)) return null;
  return n < 0.5 ? Math.round((100 * (1 - n)) / n) : -Math.round((100 * n) / (1 - n));
}

function impliedYesFromNo(noBid) {
  const n = parsePrice(noBid);
  if (n == null) return null;
  return Math.round((1 - n) * 100) / 100;
}

function americanFromNoBid(noBid) {
  return americanFromProb(impliedYesFromNo(noBid));
}

function fillProbFromNoBid(noBid, makerRate) {
  const KFEE_ = rateOf(makerRate);
  const no = parsePrice(noBid);
  if (no == null) return null;
  const sNom = 1 - no;
  if (!(sNom > 0 && sNom < 1)) return null;
  return KFEE_ * sNom * sNom + (1 - KFEE_) * sNom;
}

function fillAmericanFromNoBid(noBid, makerRate) {
  return americanFromProb(fillProbFromNoBid(noBid, makerRate));
}

function noBidFromFillAmerican(fillAmerican, makerRate) {
  const sEff = impliedProb(fillAmerican);
  if (!(sEff > 0 && sEff < 1)) return null;
  const k = rateOf(makerRate);
  const b = 1 - k;
  const sNom = k === 0 ? sEff : (-b + Math.sqrt(b * b + 4 * k * sEff)) / (2 * k);
  if (!(sNom > 0 && sNom < 1)) return null;
  return Math.floor((1 - sNom) * 100 + 1e-9) / 100;
}

function quoteNoBid(q) {
  if (!q || typeof q !== 'object') return null;
  const raw = q.no_bid_dollars != null && q.no_bid_dollars !== '' ? q.no_bid_dollars : q.no_bid;
  return parseBidPrice(raw);
}

function quoteYesBid(q) {
  if (!q || typeof q !== 'object') return null;
  const raw = q.yes_bid_dollars != null && q.yes_bid_dollars !== '' ? q.yes_bid_dollars : q.yes_bid;
  return parseBidPrice(raw);
}

function isOpenishQuote(q) {
  const st = String((q && q.status) || 'open').toLowerCase();
  return st === 'open' || st === '' || st === 'quoted';
}

function tickBetterNoBid(noBid) {
  const n = parsePrice(noBid);
  if (n == null) return null;
  return Math.min(0.99, Math.round((n + PRICE_TICK) * 100) / 100);
}

/** Highest competing maker NO bid. 0 / missing = declined that side. */
function pickBestQuote(quotes, makerRate) {
  const list = Array.isArray(quotes) ? quotes : [];
  let best = null;
  let bestNo = null;
  let usableQuoteCount = 0;
  for (const q of list) {
    if (!isOpenishQuote(q)) continue;
    const no = quoteNoBid(q);
    if (!(no > 0) || no >= 1) continue;
    usableQuoteCount += 1;
    if (bestNo == null || no > bestNo) {
      bestNo = no;
      best = q;
    }
  }
  if (!best) {
    return {
      bestNoBid: null,
      bestYesBid: null,
      bestAmerican: null,
      suggestFillAmerican: null,
      quoteCount: list.length,
      usableQuoteCount: 0,
      quoteId: null,
    };
  }
  const suggestNo = tickBetterNoBid(bestNo);
  return {
    bestNoBid: bestNo,
    bestYesBid: quoteYesBid(best),
    bestAmerican: fillAmericanFromNoBid(bestNo, makerRate),
    suggestFillAmerican: fillAmericanFromNoBid(suggestNo, makerRate),
    quoteCount: list.length,
    usableQuoteCount,
    quoteId: best.id || null,
  };
}

function fillBeatsMarket(fillAmerican, bestAmerican) {
  if (fillAmerican == null || bestAmerican == null) return null;
  const fill = Number(fillAmerican);
  const best = Number(bestAmerican);
  if (!Number.isFinite(fill) || !Number.isFinite(best)) return null;
  return fill > best;
}

// Kalshi event = SERIES-EVENT (two segments); the market adds 1+ more. Player props have two
// extra (KXNFLTD-26OCT11INDPIT-INDDJONES17-1), so "drop the last segment" was wrong for them.
// Prefer resolveEventTicker against the collection's event list (handles 3-part events like
// KXNFLTEAMFIRSTTD-26OCT11PHIJAC-JAC); this is the fallback.
function eventTickerFromMarket(ticker) {
  const s = String(ticker || '').trim();
  const parts = s.split('-');
  if (parts.length >= 3) return parts.slice(0, 2).join('-');
  const i = s.lastIndexOf('-');
  return i > 0 ? s.slice(0, i) : s;
}

/** Longest proper dash-prefix of the market ticker that is an event in this collection. */
function resolveEventTicker(ticker, eventTickers) {
  if (!eventTickers) return null;
  const parts = String(ticker || '').trim().toUpperCase().split('-');
  for (let n = parts.length - 1; n >= 1; n--) {
    const cand = parts.slice(0, n).join('-');
    if (eventTickers.has(cand)) return cand;
  }
  return null;
}

/** Legs with event_ticker resolved against the collection, or null if any leg is missing. */
function legsInCollection(legs, eventTickers) {
  if (!eventTickers) return null;
  const out = [];
  for (const l of legs || []) {
    const ev = resolveEventTicker(l.ticker, eventTickers);
    if (!ev) return null;
    out.push({ ...l, event_ticker: ev });
  }
  return out;
}

function noCollectionError(badLegs, tried) {
  const names = badLegs.map((l) => (l.label ? `${l.label} (${l.ticker})` : l.ticker)).join(', ');
  return `Kalshi doesn't offer this combo: ${names} ${badLegs.length === 1 ? "isn't" : "aren't"} in any Kalshi combo collection we checked (${tried.join(', ')}). `
    + 'Try swapping that leg for the same game\'s moneyline, spread or total, a different player on a game Kalshi lists for combos, or remove it and Probe again.';
}

function normalizeSide(side) {
  const s = String(side || '').trim().toLowerCase();
  if (s === 'no') return 'no';
  if (s === 'yes') return 'yes';
  return null;
}

function normalizeLegs(legs) {
  if (!Array.isArray(legs)) return { ok: false, error: 'legs must be an array of { ticker, side }' };
  const out = [];
  const seen = new Set();
  for (const leg of legs) {
    if (!leg || typeof leg !== 'object') continue;
    const ticker = String(leg.ticker || leg.market_ticker || '').trim();
    const side = normalizeSide(leg.side);
    if (!ticker || !side) continue;
    const eventTicker = String(leg.event_ticker || leg.eventTicker || eventTickerFromMarket(ticker)).trim();
    const key = `${ticker.toUpperCase()}:${side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = leg.label != null ? String(leg.label).trim().slice(0, 80) : '';
    out.push(label ? { ticker, side, event_ticker: eventTicker, label } : { ticker, side, event_ticker: eventTicker });
  }
  if (out.length < 2) return { ok: false, error: 'Need at least 2 mapped legs (ticker + side)' };
  if (out.length > 12) return { ok: false, error: 'Too many legs (max 12)' };
  return { ok: true, legs: out };
}

function parseContracts(n) {
  const i = Math.round(Number(n));
  if (!Number.isFinite(i) || i < 1 || i > 1000000) return null;
  return i;
}

// Combo Locks is private. Who may see it is HARDCODED here (no env allowlist):
// Kevin's two accounts plus one approved tester. Each entry pins the auth email
// AND the auth uid, so a look-alike account or a stale env var cannot match.
// Mirror of COMBO_LOCKS_ACCOUNTS in src/comboAccess.js; keep both in sync.
const COMBO_LOCKS_ACCOUNTS = Object.freeze([
  Object.freeze({ email: 'kev120909@gmail.com', id: '79ae1610-097e-4b46-a622-1e952f18e936' }),
  Object.freeze({ email: 'kevin.f.gordon1@gmail.com', id: '968efed8-54db-48a6-808b-194a7a03a4cb' }),
  Object.freeze({ email: 'gmoneyvikes@gmail.com', id: 'dd23a3a8-cb45-4866-be11-df72b4767c26' }),
  Object.freeze({ email: 'c.w.higgins1@gmail.com', id: '721c1166-be0b-4856-8a88-6de3a8b047b9' }),
  Object.freeze({ email: 'kmguido97@gmail.com', id: '42b5ee16-68d5-4b3b-a931-40aa17cd1a47' }),
  Object.freeze({ email: 'ryandiroma@gmail.com', id: '24aa1d23-ec38-47fb-af30-db8757a65e70' }),
  Object.freeze({ email: 'jwacheson@gmail.com', id: 'ccc49569-c96c-4d8b-98b1-1a8ad48b6db0' }),
  Object.freeze({ email: 'cloudmassager@gmail.com', id: '8770ab01-362f-4ce2-9430-5181064c1ccf' }),
  Object.freeze({ email: 'visionb4masses@gmail.com', id: 'a2c7089e-55fc-4c1f-907d-88d977d1dd98' }),
]);

// Kept for callers that list who is allowed; env is ignored on purpose.
function comboLocksAllowlist(_env) {
  const items = new Set();
  for (const a of COMBO_LOCKS_ACCOUNTS) { items.add(a.email); items.add(a.id); }
  return items;
}

// Kevin's auth.users id (kev120909@gmail.com). Anything that spends or reads
// Kevin's own exchange keys is owner-only, NOT the Combo Locks allowlist.
const OWNER_USER_ID = '79ae1610-097e-4b46-a622-1e952f18e936';

// Owner = Kevin's email, and (when the session carries an id, which every real
// Supabase getUser does) Kevin's user id too.
function isComboOwner(user) {
  if (!user || !user.email) return false;
  if (String(user.email).trim().toLowerCase() !== OWNER_EMAIL.toLowerCase()) return false;
  if (user.id != null && String(user.id).trim().toLowerCase() !== OWNER_USER_ID) return false;
  return true;
}

function canSeeComboLocks(user, _env) {
  if (!user || !user.email || !user.id) return false;
  const email = String(user.email).trim().toLowerCase();
  const id = String(user.id).trim().toLowerCase();
  return COMBO_LOCKS_ACCOUNTS.some((a) => a.email === email && a.id === id);
}

function selectedMarkets(legs) {
  return (legs || []).map((l) => ({
    market_ticker: l.ticker,
    event_ticker: l.event_ticker,
    side: l.side,
  }));
}

function readBearer(req) {
  const headers = (req && req.headers) || {};
  const raw = headers.authorization || headers.Authorization || '';
  const m = /^Bearer\s+(\S+)/i.exec(String(raw));
  return m ? m[1] : '';
}

function parseBody(req) {
  const raw = req && req.body;
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  try {
    return JSON.parse(String(raw));
  } catch (_) {
    return {};
  }
}

// Kalshi errors look like { error: { code, message, details? } }. Show the real
// upstream text: message plus details (and the code when it adds information),
// not just the generic "invalid parameters".
function kalshiErrorText(body, fallback) {
  if (body && typeof body === 'object') {
    const err = body.error && typeof body.error === 'object' ? body.error : null;
    const message = (err && err.message) || body.message || (typeof body.error === 'string' ? body.error : '') || '';
    const code = (err && err.code) || body.code || '';
    const details = (err && err.details) || body.details || '';
    const parts = [];
    if (message) parts.push(String(message));
    else if (code) parts.push(String(code));
    if (details && String(details) !== String(message)) parts.push(String(details));
    if (parts.length) {
      let text = parts.join(': ');
      const norm = (v) => String(v).toLowerCase().replace(/[\s_]+/g, ' ').trim();
      if (code && message && norm(code) !== norm(message)) text += ` (${code})`;
      return text.slice(0, 400);
    }
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 400);
  return fallback || 'Kalshi request failed';
}

function kalshiErrorCode(body) {
  if (!body || typeof body !== 'object') return '';
  return String((body.error && typeof body.error === 'object' && body.error.code) || body.code || '');
}

/** Event tickers a multivariate collection accepts (GET /multivariate_event_collections/{t}). */
function collectionEventTickers(data) {
  const c = data && (data.multivariate_contract || data.collection || data);
  if (!c || typeof c !== 'object') return null;
  const set = new Set();
  (Array.isArray(c.associated_event_tickers) ? c.associated_event_tickers : []).forEach((t) => t && set.add(String(t).toUpperCase()));
  (Array.isArray(c.associated_events) ? c.associated_events : []).forEach((e) => {
    const t = e && (e.ticker || e.event_ticker);
    if (t) set.add(String(t).toUpperCase());
  });
  return set.size ? set : null;
}

/** Legs whose event is not part of the combo collection (Kalshi rejects those). */
function legsOutsideCollection(legs, eventTickers) {
  if (!eventTickers) return [];
  return (legs || []).filter((l) => !eventTickers.has(String(l.event_ticker || '').toUpperCase())
    && !resolveEventTicker(l.ticker, eventTickers));
}

function outsideCollectionError(badLegs, collection, upstream) {
  const names = badLegs.map((l) => (l.label ? `${l.label} (${l.ticker})` : l.ticker)).join(', ');
  const one = badLegs.length === 1;
  return `Kalshi rejected this combo${upstream ? ` — "${upstream}"` : ''}. ${names} ${one ? 'is' : 'are'} not in Kalshi's combo collection ${collection}, `
    + `so Kalshi doesn't offer combos on ${one ? 'that game' : 'those games'} right now. Remove or swap ${one ? 'that leg' : 'those legs'} and Probe again.`;
}

function marketTickerFromCreate(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.market_ticker) return String(data.market_ticker);
  if (data.market && data.market.ticker) return String(data.market.ticker);
  return null;
}

function quotesFromList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.quotes)) return data.quotes;
  return [];
}

function rfqIdFromCreate(data) {
  if (!data || typeof data !== 'object') return null;
  return data.id || data.rfq_id || (data.rfq && (data.rfq.id || data.rfq.rfq_id)) || null;
}

function missingKalshiKeysError(missing) {
  const names = (missing && missing.length ? missing : ['KALSHI_KEY_ID', 'Kalshi_combo_key']).join(' and ');
  return {
    ok: false,
    error: `Kalshi API keys are not configured on this server. Add ${names} (or KALSHI_PRIVATE_KEY instead of Kalshi_combo_key) to Vercel — same names as the Railway combo-worker.`,
    missingEnv: missing && missing.length ? missing : ['KALSHI_KEY_ID', 'Kalshi_combo_key'],
  };
}


// Probe rate limit: one successful auth'd attempt per user per cooldown.
const PROBE_COOLDOWN_MS = 30_000;
function createProbeRateLimiter(cooldownMs = PROBE_COOLDOWN_MS) {
  const lastByUser = new Map();
  return {
    cooldownMs,
    check(userId, now = Date.now()) {
      const id = String(userId || '').trim();
      if (!id) return { ok: true }; // no identity to key on (tests / edge); handler already authed
      const last = lastByUser.get(id) || 0;
      const wait = cooldownMs - (Number(now) - last);
      if (wait > 0) {
        const sec = Math.max(1, Math.ceil(wait / 1000));
        return {
          ok: false,
          status: 429,
          retryAfterMs: wait,
          error: `Slow down — try Check market price again in ${sec} second${sec === 1 ? '' : 's'}.`,
        };
      }
      return { ok: true };
    },
    mark(userId, now = Date.now()) {
      const id = String(userId || '');
      if (id) lastByUser.set(id, Number(now) || Date.now());
    },
    _reset() { lastByUser.clear(); },
    _last(userId) { return lastByUser.get(String(userId || '')) || 0; },
  };
}

const CONNECT_KALSHI_ERROR = 'Connect Kalshi to check price';

module.exports = {
  KFEE,
  FALLBACK_MAKER_RATE,
  COMBO_COLLECTION_CANDIDATES,
  makerRateFromSeries,
  resolveEventTicker,
  legsInCollection,
  noCollectionError,
  DEFAULT_WAIT_MS,
  MIN_WAIT_MS,
  MAX_WAIT_MS,
  PRICE_TICK,
  OWNER_EMAIL,
  OWNER_USER_ID,
  isComboOwner,
  COMBO_COLLECTION,
  KALSHI_API_BASE,
  clampWaitMs,
  parsePrice,
  parseBidPrice,
  quotesListPath,
  impliedProb,
  americanFromProb,
  impliedYesFromNo,
  americanFromNoBid,
  fillProbFromNoBid,
  fillAmericanFromNoBid,
  noBidFromFillAmerican,
  quoteNoBid,
  quoteYesBid,
  tickBetterNoBid,
  pickBestQuote,
  fillBeatsMarket,
  eventTickerFromMarket,
  normalizeLegs,
  parseContracts,
  COMBO_LOCKS_ACCOUNTS,
  comboLocksAllowlist,
  canSeeComboLocks,
  selectedMarkets,
  readBearer,
  parseBody,
  kalshiErrorText,
  kalshiErrorCode,
  collectionEventTickers,
  legsOutsideCollection,
  outsideCollectionError,
  marketTickerFromCreate,
  quotesFromList,
  rfqIdFromCreate,
  missingKalshiKeysError,
  PROBE_COOLDOWN_MS,
  createProbeRateLimiter,
  CONNECT_KALSHI_ERROR,
};
