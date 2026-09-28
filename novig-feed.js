// Novig v3 feed for the New Odds Board relay.
//
// Prices come from Novig's public v3 REST (no key, no signature, throttled
// per IP at their edge):
//   GET /v3/public/catalog/events?league=NFL
//   GET /v3/public/catalog/markets?league=NFL&marketType=MONEY,SPREAD,TOTAL
//   GET /v3/public/catalog/markets/{id}/book
//
// When NOVIG_KEY_ID + NOVIG_PRIVATE_KEY (a trading::read key, PKCS#8 PEM) are
// set, the feed also opens the signed websocket (GET /v3/ws, NOVIG-V3
// signature) and subscribes the board markets on the `book` channel. Those
// markets then update on push and REST drops to a slow safety poll. Any
// websocket failure leaves REST polling as the source.
//
// A book lists resting bids per outcome. The price to buy an outcome is
// 1 - the best bid on the other outcome. Quantities are contracts that pay
// 1 cent, so size (in dollars paid out) is qty / 100.
'use strict';

const crypto = require('crypto');

const NOVIG_BOOK_ID = 195;
const DEFAULT_BASE = 'https://api.novig.com';
const LEAGUES = ['NFL', 'MLB', 'NCAAF'];
const BOARD_TYPES = ['MONEY', 'SPREAD', 'TOTAL'];
const WINDOW_BACK_MS = 8 * 3600 * 1000;
const WINDOW_AHEAD_MS = 8 * 24 * 3600 * 1000;
const EMPTY_BODY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const WS_WEIGHT_BOOK = 16;
const WS_UPGRADE_COST = 32;
const WS_STREAM_CAPACITY = 512;
const WS_STREAM_REFILL = 4;
const WS_MAX_MARKETS = 2048;

// ---------------------------------------------------------------- config

function novigBase(env = process.env) {
  return String(env.NOVIG_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
}

function novigWsUrl(base) {
  const u = new URL(base || DEFAULT_BASE);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  u.pathname = '/v3/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
}

function normalizePem(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  if (!text.includes('\n') && text.includes('\\n')) text = text.replace(/\\n/g, '\n');
  if (!text.includes('-----BEGIN')) {
    // Bare base64 body.
    const body = text.replace(/\s+/g, '').match(/.{1,64}/g) || [];
    text = `-----BEGIN PRIVATE KEY-----\n${body.join('\n')}\n-----END PRIVATE KEY-----`;
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

function novigKey(env = process.env) {
  const id = String(env.NOVIG_KEY_ID || '').trim();
  const pem = normalizePem(env.NOVIG_PRIVATE_KEY || '');
  if (!id || !pem) return null;
  try {
    const key = crypto.createPrivateKey(pem);
    return { id, key, type: key.asymmetricKeyType };
  } catch (_) {
    return { id, key: null, type: null, error: 'bad_private_key' };
  }
}

// ---------------------------------------------------------------- signing

function encodePart(s) {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c)) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function decodePart(s) {
  try { return decodeURIComponent(s); } catch (_) { return s; }
}

function canonicalQuery(raw) {
  const q = String(raw || '').replace(/^\?/, '');
  if (!q) return '';
  const pairs = q.split('&').map((pair) => {
    const i = pair.indexOf('=');
    const name = i < 0 ? pair : pair.slice(0, i);
    const value = i < 0 ? '' : pair.slice(i + 1);
    return [encodePart(decodePart(name)), encodePart(decodePart(value))];
  });
  pairs.sort((a, b) => {
    const n = Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]));
    return n || Buffer.compare(Buffer.from(a[1]), Buffer.from(b[1]));
  });
  return pairs.map(([n, v]) => `${n}=${v}`).join('&');
}

function stringToSign({ timestamp, method, path, query, body }) {
  const hash = body && body.length
    ? crypto.createHash('sha256').update(body).digest('hex')
    : EMPTY_BODY_HASH;
  return ['NOVIG-V3', String(timestamp), String(method).toUpperCase(), path, canonicalQuery(query), hash].join('\n');
}

function signString(keyObject, text) {
  const data = Buffer.from(text, 'utf8');
  if (keyObject.asymmetricKeyType === 'ed25519') {
    return crypto.sign(null, data, keyObject).toString('base64');
  }
  return crypto.sign('sha256', data, { key: keyObject, dsaEncoding: 'der' }).toString('base64');
}

function signedHeaders(key, { method = 'GET', path, query = '', body = '', nowMs = Date.now() }) {
  const timestamp = String(Math.floor(nowMs));
  const text = stringToSign({ timestamp, method, path, query, body });
  return {
    'Novig-Key-Id': key.id,
    'Novig-Timestamp': timestamp,
    'Novig-Signature': signString(key.key, text),
  };
}

// ---------------------------------------------------------------- books

function priceNum(raw) {
  const n = Number(raw);
  return n > 0 && n < 1 ? n : null;
}

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function emptyBook() {
  return { seq: -1, orders: new Map(), changedAt: 0 };
}

// REST: { seq, orders: { outcomeId: [{ orderId, price, qty }] } }
// WS snapshot: { seq, orders: { outcomeId: [{ order, price, qty }] } }
function bookFromSnapshot(raw, at) {
  const book = emptyBook();
  if (!raw || typeof raw !== 'object') return book;
  book.seq = Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : -1;
  const orders = raw.orders || {};
  for (const outcome of Object.keys(orders)) {
    (orders[outcome] || []).forEach((row, i) => {
      if (!row) return;
      const price = priceNum(row.price);
      const qty = Number(row.qty);
      if (price == null || !(qty > 0)) return;
      const id = String(row.orderId || row.order || `${outcome}:${row.price}:${i}`);
      book.orders.set(id, { outcome, price, qty });
    });
  }
  book.changedAt = at || Date.now();
  return book;
}

function applyBookDeltas(book, deltas) {
  for (const d of deltas || []) {
    if (!d) continue;
    const id = String(d.order || d.orderId || '');
    if (!id) continue;
    if (d.kind === 'add') {
      const price = priceNum(d.price);
      const qty = Number(d.qty);
      if (price == null || !(qty > 0)) continue;
      book.orders.set(id, { outcome: String(d.outcome || ''), price, qty });
    } else if (d.kind === 'remove') {
      book.orders.delete(id);
    }
  }
  return book;
}

function bestBid(book, outcomeId) {
  if (!book) return null;
  let price = null;
  let qty = 0;
  for (const o of book.orders.values()) {
    if (o.outcome !== outcomeId) continue;
    if (price == null || o.price > price + 1e-9) {
      price = o.price;
      qty = o.qty;
    } else if (Math.abs(o.price - price) < 1e-9) {
      qty += o.qty;
    }
  }
  return price == null ? null : { price, qty };
}

// Ask ladder to buy `outcomeId`, best first: 1 - each bid on the other side.
function askLevels(book, market, outcomeId, depth = 5) {
  const other = market.outcomes.find((o) => o.id !== outcomeId);
  if (!book || !other) return [];
  const byPrice = new Map();
  for (const o of book.orders.values()) {
    if (o.outcome !== other.id) continue;
    const key = round3(o.price);
    byPrice.set(key, (byPrice.get(key) || 0) + o.qty);
  }
  return [...byPrice.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, depth)
    .map(([bid, qty]) => ({ odds: round3(1 - bid), size: Math.round(qty) / 100 }));
}

function askFor(book, market, outcomeId) {
  const other = market.outcomes.find((o) => o.id !== outcomeId);
  if (!other) return null;
  const bid = bestBid(book, other.id);
  if (!bid) return null;
  const odds = round3(1 - bid.price);
  if (!(odds > 0 && odds < 1)) return null;
  return { odds, size: Math.round(bid.qty) / 100 };
}

// Fair probability of outcome 0 from both best bids (mid of the two sides).
function fairProb0(book, market) {
  const [a, b] = market.outcomes;
  const bidA = bestBid(book, a.id);
  const bidB = bestBid(book, b.id);
  if (bidA && bidB) return (bidA.price + (1 - bidB.price)) / 2;
  if (bidA) return bidA.price;
  if (bidB) return 1 - bidB.price;
  return null;
}

function twoSided(book, market) {
  return market.outcomes.every((o) => askFor(book, market, o.id));
}

// ---------------------------------------------------------------- catalog

function americanFromProb(p) {
  const n = Number(p);
  if (!(n > 0 && n < 1)) return null;
  return n >= 0.5 ? Math.round(-100 * n / (1 - n)) : Math.round(100 * (1 - n) / n);
}

function splitMatchup(description) {
  const text = String(description || '');
  const at = text.split(' @ ');
  if (at.length === 2) return { away: at[0].trim(), home: at[1].trim() };
  const vs = text.split(/\s+vs\.?\s+/i);
  if (vs.length === 2) return { away: vs[0].trim(), home: vs[1].trim() };
  return null;
}

function parseSpreadName(name) {
  const m = String(name || '').trim().match(/^(.*?)\s*([+-]\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { code: m[1].trim(), line: Number(m[2]) };
}

function totalSideOf(name) {
  const t = String(name || '').trim().toLowerCase();
  if (t.startsWith('over')) return 'Over';
  if (t.startsWith('under')) return 'Under';
  return null;
}

function eventInWindow(ev, at) {
  if (!ev) return false;
  const status = String(ev.status || '').toUpperCase();
  if (status === 'OPEN_INGAME') return true;
  if (status !== 'OPEN_PREGAME') return false;
  const start = Number(ev.startsTs);
  if (!Number.isFinite(start)) return false;
  return start > at - WINDOW_BACK_MS && start < at + WINDOW_AHEAD_MS;
}

function normMarket(m) {
  if (!m || !m.marketId) return null;
  const type = String(m.marketType || '').toUpperCase();
  if (!BOARD_TYPES.includes(type)) return null;
  if (String(m.status || '').toUpperCase() !== 'OPEN') return null;
  const outcomes = (m.outcomes || []).map((o) => ({ id: String(o.outcomeId || ''), name: String(o.name || '') }));
  if (outcomes.length !== 2 || !outcomes.every((o) => o.id)) return null;
  const strike = Number(m.strike);
  let x = null;
  if (type === 'SPREAD') {
    const s0 = parseSpreadName(outcomes[0].name);
    if (!s0) return null;
    x = s0.line;
  } else if (type === 'TOTAL') {
    if (!Number.isFinite(strike)) return null;
    const side0 = totalSideOf(outcomes[0].name);
    if (!side0) return null;
    // Sort so P(outcome 0) rises with x.
    x = side0 === 'Over' ? -strike : strike;
  }
  return {
    id: String(m.marketId),
    eventId: String(m.eventId || ''),
    type,
    strike: Number.isFinite(strike) ? strike : null,
    description: String(m.description || ''),
    outcomes,
    x,
  };
}

// Build { events: Map, groups: Map<eventId|type, market[]> } for one league.
function buildCatalog(league, eventsBody, marketsBody, at = Date.now()) {
  const events = new Map();
  for (const ev of (eventsBody && eventsBody.items) || []) {
    if (!ev || !ev.eventId) continue;
    if (String(ev.league || '').toUpperCase() !== league) continue;
    if (!eventInWindow(ev, at)) continue;
    const teams = splitMatchup(ev.description);
    if (!teams) continue;
    events.set(String(ev.eventId), {
      id: String(ev.eventId),
      league,
      away: teams.away,
      home: teams.home,
      status: String(ev.status || '').toUpperCase(),
      startsTs: Number(ev.startsTs) || null,
      codes: {},
    });
  }
  const groups = new Map();
  for (const raw of (marketsBody && marketsBody.items) || []) {
    const m = normMarket(raw);
    if (!m) continue;
    const ev = events.get(m.eventId);
    if (!ev) continue;
    if (m.type === 'MONEY') {
      // Outcome 0 is the home team on Novig game moneylines.
      ev.codes[m.outcomes[0].name.toUpperCase()] = ev.home;
      ev.codes[m.outcomes[1].name.toUpperCase()] = ev.away;
    } else if (m.type === 'TOTAL') {
      const mt = String(m.description).match(/^(\S+)\s+@\s+(\S+)\s+t/i);
      if (mt) {
        if (!ev.codes[mt[1].toUpperCase()]) ev.codes[mt[1].toUpperCase()] = ev.away;
        if (!ev.codes[mt[2].toUpperCase()]) ev.codes[mt[2].toUpperCase()] = ev.home;
      }
    }
    const key = `${m.eventId}|${m.type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  for (const list of groups.values()) list.sort((a, b) => (a.x || 0) - (b.x || 0));
  return { league, events, groups, at };
}

function sideFor(ev, market, outcome) {
  if (market.type === 'TOTAL') return totalSideOf(outcome.name);
  const code = market.type === 'SPREAD'
    ? (parseSpreadName(outcome.name) || {}).code
    : outcome.name;
  if (!code) return null;
  return ev.codes[String(code).toUpperCase()] || code;
}

function lineFor(market, outcome) {
  if (market.type === 'SPREAD') {
    const s = parseSpreadName(outcome.name);
    return s ? s.line : null;
  }
  if (market.type === 'TOTAL') return market.strike;
  return null;
}

function betTypeOf(type) {
  if (type === 'MONEY') return 'moneyline';
  if (type === 'SPREAD') return 'spread';
  if (type === 'TOTAL') return 'total';
  return '';
}

function quotesForMarket(ev, market, book, league) {
  const out = [];
  if (!ev || !market || !book) return out;
  const betType = betTypeOf(market.type);
  for (const outcome of market.outcomes) {
    const ask = askFor(book, market, outcome.id);
    const side = sideFor(ev, market, outcome);
    if (!ask || !side) continue;
    const quote = {
      book: 'novig',
      book_id: NOVIG_BOOK_ID,
      league,
      away: ev.away,
      home: ev.home,
      side,
      bet_type: betType,
      odds: ask.odds,
      american: americanFromProb(ask.odds),
      size: ask.size,
      depth: askLevels(book, market, outcome.id, 5),
      is_alt: false,
      is_live: ev.status === 'OPEN_INGAME',
      token_id: outcome.id,
      market_id: market.id,
      seq: book.seq,
      start: ev.startsTs ? new Date(ev.startsTs).toISOString() : null,
      updated_at: new Date(book.changedAt || Date.now()).toISOString(),
    };
    const line = lineFor(market, outcome);
    if (market.type !== 'MONEY') {
      if (line == null) continue;
      quote.line = line;
      if (market.type === 'TOTAL') quote.side_type = side;
    }
    out.push(quote);
  }
  return out;
}

// Pick the most balanced two-sided market among probed candidates.
function pickMain(markets, books) {
  let best = null;
  let bestScore = Infinity;
  for (const m of markets || []) {
    const book = books.get(m.id);
    if (!book || book.seq < 0) continue;
    if (m.type !== 'MONEY' && !twoSided(book, m)) continue;
    const p = fairProb0(book, m);
    if (p == null) continue;
    const score = Math.abs(p - 0.5);
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

// ---------------------------------------------------------------- limiter

function createLimiter({ rps = 1.8, concurrency = 2, now = () => Date.now() } = {}) {
  let tokens = Math.max(1, rps);
  let last = now();
  let active = 0;
  let pausedUntil = 0;
  let rate = rps;
  let slowUntil = 0;
  const queues = { high: [], low: [] };
  let timer = null;
  let served = 0;
  const refill = () => {
    const t = now();
    const r = t < slowUntil ? rate * 0.75 : rate;
    tokens = Math.min(Math.max(1, r), tokens + ((t - last) / 1000) * r);
    last = t;
  };
  const pump = () => {
    timer = null;
    refill();
    const t = now();
    while ((queues.high.length || queues.low.length) && active < concurrency && tokens >= 1 && t >= pausedUntil) {
      // Hot polls get most slots, but main-line searches still move.
      let q = queues.high.length ? queues.high : queues.low;
      if (queues.high.length && queues.low.length) {
        served += 1;
        q = served % 4 === 0 ? queues.low : queues.high;
      }
      const next = q.shift();
      tokens -= 1;
      active += 1;
      next();
    }
    if ((queues.high.length || queues.low.length) && !timer) {
      const wait = t < pausedUntil ? pausedUntil - t : 50;
      timer = setTimeout(pump, wait);
      if (timer.unref) timer.unref();
    }
  };
  return {
    run(fn, priority = 'low') {
      return new Promise((resolve, reject) => {
        (priority === 'high' ? queues.high : queues.low).push(() => {
          Promise.resolve().then(fn).then(resolve, reject).finally(() => {
            active -= 1;
            pump();
          });
        });
        pump();
      });
    },
    backoff(ms) {
      const t = now();
      pausedUntil = Math.max(pausedUntil, t + ms);
      slowUntil = t + 120_000;
    },
    stats() {
      return { rps: rate, queued: queues.high.length + queues.low.length, active, pausedUntil };
    },
    clear() {
      queues.high.length = 0;
      queues.low.length = 0;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// ---------------------------------------------------------------- feed

function pollMsFor(ev, at, opts) {
  if (!ev) return opts.coldMs;
  if (ev.status === 'OPEN_INGAME') return opts.hotMs;
  const start = ev.startsTs || 0;
  if (start && start - at < 6 * 3600 * 1000) return opts.hotMs;
  if (start && start - at < 48 * 3600 * 1000) return opts.warmMs;
  return opts.coldMs;
}

function createNovigFeed(opts = {}) {
  const env = opts.env || process.env;
  const fetchFn = opts.fetchFn || ((...args) => fetch(...args));
  const base = opts.base || novigBase(env);
  const leagues = opts.leagues || LEAGUES;
  const onQuotes = opts.onQuotes || (() => {});
  const log = opts.log || ((...a) => console.log('[novig]', ...a));
  const cfg = {
    hotMs: Number(env.NOVIG_HOT_POLL_MS) || opts.hotMs || 2000,
    warmMs: Number(env.NOVIG_WARM_POLL_MS) || opts.warmMs || 20000,
    coldMs: Number(env.NOVIG_COLD_POLL_MS) || opts.coldMs || 600000,
    wsOwnedMs: opts.wsOwnedMs || 60000,
    catalogMs: opts.catalogMs || 120000,
    walkMs: opts.walkMs || 90000,
  };
  const limiter = opts.limiter || createLimiter({
    // Novig's public edge allows about 2 requests/s per IP (measured: 2/s
    // clean, 3/s already draws 429s with Retry-After: 1).
    rps: Number(env.NOVIG_PUBLIC_RPS) || opts.rps || 1.8,
    concurrency: opts.concurrency || 2,
  });
  const books = new Map(); // marketId -> book
  const catalogs = new Map(); // league -> catalog
  const mains = new Map(); // `${eventId}|${type}` -> marketId
  const due = new Map(); // marketId -> next poll ms
  const inflight = new Set();
  const wsOwned = new Set();
  const lastWalk = new Map();
  const searching = new Set();
  const publishTimers = new Map();
  const status = {
    rest: 'starting',
    ws: 'off',
    lastRestOkAt: 0,
    lastWsMsgAt: 0,
    restErrors: 0,
    restCalls: 0,
    restChanged: 0,
    wsMarkets: 0,
  };
  let stopped = false;
  let ws = null;

  const marketIndex = new Map(); // marketId -> { cat, m }
  const marketById = (id) => marketIndex.get(id) || null;
  const reindex = () => {
    marketIndex.clear();
    for (const cat of catalogs.values()) {
      for (const list of cat.groups.values()) for (const m of list) marketIndex.set(m.id, { cat, m });
    }
  };

  async function getJson(path, headers = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetchFn(`${base}${path}`, {
        headers: { accept: 'application/json', 'user-agent': 'aibetbuilder-odds-relay', ...headers },
        signal: ctrl.signal,
      });
      status.restCalls += 1;
      if (res.status === 429 || res.status === 403) {
        const after = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        limiter.backoff(Number.isFinite(after) && after > 0 ? after * 1000 : 10_000);
        status.restErrors += 1;
        return { ok: false, status: res.status, body: null };
      }
      if (res.status === 304) return { ok: true, status: 304, body: null };
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
      if (!res.ok) status.restErrors += 1;
      return { ok: res.ok, status: res.status, body };
    } catch (err) {
      status.restErrors += 1;
      return { ok: false, status: 0, body: null, error: err && err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  function schedulePublish(league) {
    if (publishTimers.has(league)) return;
    const t = setTimeout(() => {
      publishTimers.delete(league);
      if (!stopped) onQuotes(league, quotesForLeague(league), ws && status.ws === 'up' ? 'ws' : 'rest');
    }, 60);
    if (t.unref) t.unref();
    publishTimers.set(league, t);
  }

  function quotesForLeague(league) {
    const cat = catalogs.get(league);
    if (!cat) return [];
    const out = [];
    for (const [key, list] of cat.groups) {
      const id = mains.get(key);
      const market = id && list.find((m) => m.id === id);
      if (!market) continue;
      out.push(...quotesForMarket(cat.events.get(market.eventId), market, books.get(market.id), league));
    }
    return out;
  }

  // Keep a book only if it is not older than the one held. Replicas can lag.
  function storeBook(marketId, next) {
    const prev = books.get(marketId);
    if (prev && prev.seq > next.seq) return false;
    if (prev && prev.seq === next.seq) return false;
    books.set(marketId, next);
    return true;
  }

  async function fetchBook(market, priority) {
    if (inflight.has(market.id)) return books.get(market.id) || null;
    inflight.add(market.id);
    try {
      const res = await limiter.run(
        () => getJson(`/v3/public/catalog/markets/${encodeURIComponent(market.id)}/book`),
        priority,
      );
      if (res.ok && res.body) {
        status.lastRestOkAt = Date.now();
        status.rest = 'up';
        if (storeBook(market.id, bookFromSnapshot(res.body, Date.now()))) status.restChanged += 1;
      } else if (res.status === 404) {
        books.delete(market.id);
      }
      return books.get(market.id) || null;
    } finally {
      inflight.delete(market.id);
    }
  }

  // Binary search the line ladder for the most balanced two-sided market.
  async function findMain(cat, key, list) {
    if (searching.has(key)) return;
    searching.add(key);
    try {
      const probed = new Set();
      const probe = async (i) => {
        const m = list[i];
        if (!m) return null;
        probed.add(i);
        const book = await fetchBook(m, 'low');
        return book ? fairProb0(book, m) : null;
      };
      let lo = 0;
      let hi = list.length - 1;
      let guard = 0;
      while (lo <= hi && guard < 12 && !stopped) {
        guard += 1;
        const mid = (lo + hi) >> 1;
        const p = await probe(mid);
        if (p == null) {
          if (mid - lo < hi - mid) lo = mid + 1;
          else hi = mid - 1;
          continue;
        }
        if (p < 0.5) lo = mid + 1;
        else hi = mid - 1;
      }
      // Neighbours of the crossing point.
      for (const i of [lo - 2, lo - 1, lo, lo + 1]) {
        if (i >= 0 && i < list.length && !probed.has(i) && !stopped) await probe(i);
      }
      const main = pickMain(list, books);
      if (main) setMain(cat, key, main.id);
      lastWalk.set(key, Date.now());
    } finally {
      searching.delete(key);
    }
  }

  // Main-line searches run two at a time, soonest game first, so a slow
  // public budget finishes tonight's lines before next week's.
  const searchQueue = [];
  let searchWorkers = 0;
  function enqueueSearch(job) {
    if (searching.has(job.key) || searchQueue.some((j) => j.key === job.key)) return;
    searchQueue.push(job);
    searchQueue.sort((a, b) => a.startsAt - b.startsAt);
    while (searchWorkers < 2 && searchQueue.length) {
      searchWorkers += 1;
      (async () => {
        while (searchQueue.length && !stopped) {
          const next = searchQueue.shift();
          const list = (catalogs.get(next.cat.league) || next.cat).groups.get(next.key) || next.list;
          try { await findMain(catalogs.get(next.cat.league) || next.cat, next.key, list); } catch (_) { /* next */ }
        }
      })().finally(() => { searchWorkers -= 1; });
    }
  }

  async function walkMain(cat, key, list) {
    if (searching.has(key)) return;
    searching.add(key);
    try {
      const id = mains.get(key);
      const i = list.findIndex((m) => m.id === id);
      if (i < 0) return;
      for (const j of [i - 1, i + 1]) {
        if (j >= 0 && j < list.length && !stopped) await fetchBook(list[j], 'low');
      }
      const main = pickMain(list.slice(Math.max(0, i - 1), i + 2), books);
      if (main && main.id !== id) setMain(cat, key, main.id);
      lastWalk.set(key, Date.now());
    } finally {
      searching.delete(key);
    }
  }

  function setMain(cat, key, marketId) {
    const prev = mains.get(key);
    if (prev === marketId) return;
    mains.set(key, marketId);
    due.set(marketId, 0);
    if (prev) due.delete(prev);
    if (ws) ws.retarget();
    schedulePublish(cat.league);
  }

  async function refreshCatalog(league) {
    const [evRes, mkRes] = await Promise.all([
      limiter.run(() => getJson(`/v3/public/catalog/events?league=${encodeURIComponent(league)}&limit=100`), 'high'),
      limiter.run(() => getJson(`/v3/public/catalog/markets?league=${encodeURIComponent(league)}&marketType=${BOARD_TYPES.join(',')}&limit=5000`), 'high'),
    ]);
    if (!evRes.ok || !mkRes.ok || !evRes.body || !mkRes.body) return false;
    // Events page is capped at 100; follow the cursor for big slates.
    let evBody = evRes.body;
    let cursor = evBody.next;
    let pages = 0;
    while (cursor && pages < 5 && !stopped) {
      pages += 1;
      const more = await limiter.run(() => getJson(`/v3/public/catalog/events?league=${encodeURIComponent(league)}&limit=100&after=${encodeURIComponent(cursor)}`), 'high');
      if (!more.ok || !more.body) break;
      evBody = { items: [...evBody.items, ...(more.body.items || [])] };
      cursor = more.body.next;
    }
    const cat = buildCatalog(league, evBody, mkRes.body, Date.now());
    const prev = catalogs.get(league);
    catalogs.set(league, cat);
    reindex();
    // Drop mains of this league whose event or market went away.
    if (prev) {
      for (const [key, id] of [...mains]) {
        if (!prev.groups.has(key)) continue;
        const list = cat.groups.get(key);
        if (!list || !list.some((m) => m.id === id)) {
          mains.delete(key);
          due.delete(id);
          books.delete(id);
        }
      }
    }
    const startOf = (key) => {
      const ev = cat.events.get(key.split('|')[0]);
      return (ev && ev.status === 'OPEN_INGAME') ? 0 : ((ev && ev.startsTs) || Infinity);
    };
    for (const [key, list] of [...cat.groups].sort((a, b) => startOf(a[0]) - startOf(b[0]))) {
      if (list[0].type === 'MONEY') {
        if (!mains.has(key)) setMain(cat, key, list[0].id);
        continue;
      }
      if (!mains.has(key)) enqueueSearch({ cat, key, list, startsAt: startOf(key) });
    }
    schedulePublish(league);
    return true;
  }

  function hotMarkets() {
    const out = [];
    const at = Date.now();
    for (const cat of catalogs.values()) {
      for (const [key, id] of mains) {
        const list = cat.groups.get(key);
        if (!list) continue;
        const m = list.find((row) => row.id === id);
        if (!m) continue;
        const ev = cat.events.get(m.eventId);
        out.push({ cat, key, m, ev, pollMs: pollMsFor(ev, at, cfg) });
      }
    }
    return out;
  }

  function tick() {
    if (stopped) return;
    const at = Date.now();
    for (const row of hotMarkets()) {
      const { cat, key, m } = row;
      const every = wsOwned.has(m.id) ? cfg.wsOwnedMs : row.pollMs;
      const next = due.get(m.id) || 0;
      if (at >= next && !inflight.has(m.id)) {
        due.set(m.id, at + every);
        const before = books.get(m.id);
        const beforeSeq = before ? before.seq : -2;
        fetchBook(m, row.pollMs <= cfg.hotMs ? 'high' : 'low').then((book) => {
          if (book && book.seq !== beforeSeq) schedulePublish(cat.league);
        }).catch(() => {});
      }
      if (m.type !== 'MONEY' && row.pollMs < cfg.coldMs) {
        const walkEvery = row.pollMs <= cfg.hotMs ? cfg.walkMs : cfg.walkMs * 4;
        if (at - (lastWalk.get(key) || 0) > walkEvery) {
          lastWalk.set(key, at);
          walkMain(cat, key, cat.groups.get(key)).then(() => schedulePublish(cat.league)).catch(() => {});
        }
      }
    }
  }

  function onWsBook(marketId, book, at) {
    const found = marketById(marketId);
    if (!found) return;
    books.set(marketId, book);
    book.changedAt = at;
    status.lastWsMsgAt = at;
    schedulePublish(found.cat.league);
  }

  let tickTimer = null;
  let catalogTimer = null;
  async function start() {
    for (const league of leagues) {
      if (stopped) return;
      try { await refreshCatalog(league); } catch (err) { log('catalog', league, err && err.message); }
    }
    catalogTimer = setInterval(() => {
      for (const league of leagues) refreshCatalog(league).catch(() => {});
    }, cfg.catalogMs);
    tickTimer = setInterval(tick, 200);
    if (catalogTimer.unref) catalogTimer.unref();
    const key = opts.key !== undefined ? opts.key : novigKey(env);
    if (key && key.key && opts.ws !== false) {
      ws = startNovigWs({
        key,
        base,
        WebSocket: opts.WebSocket,
        status,
        log,
        desired: () => hotMarkets()
          .sort((a, b) => a.pollMs - b.pollMs)
          .slice(0, WS_MAX_MARKETS)
          .map((row) => row.m.id),
        onBook: onWsBook,
        onOwned: (ids) => {
          wsOwned.clear();
          for (const id of ids) wsOwned.add(id);
          status.wsMarkets = wsOwned.size;
        },
        onLifecycle: (marketId, deltas) => {
          if ((deltas || []).includes('CLOSE')) {
            books.delete(marketId);
            const found = marketById(marketId);
            if (found) schedulePublish(found.cat.league);
          }
        },
      });
    } else if (key && key.error) {
      status.ws = `error:${key.error}`;
      log('websocket off:', key.error);
    }
  }

  const ready = start().catch((err) => log('start failed', err && err.message));

  return {
    ready,
    status,
    books,
    mains,
    catalogs,
    quotesForLeague,
    depthFor(marketId, outcomeId) {
      const found = marketById(marketId);
      if (!found) return [];
      return askLevels(books.get(marketId), found.m, outcomeId, 20);
    },
    health() {
      const counts = {};
      for (const league of leagues) counts[league] = quotesForLeague(league).length;
      return { ...status, limiter: limiter.stats(), counts, mains: mains.size };
    },
    stop() {
      stopped = true;
      if (tickTimer) clearInterval(tickTimer);
      if (catalogTimer) clearInterval(catalogTimer);
      for (const t of publishTimers.values()) clearTimeout(t);
      limiter.clear();
      if (ws) ws.stop();
    },
  };
}

// ---------------------------------------------------------------- websocket

function startNovigWs({ key, base, WebSocket, status, log, desired, onBook, onOwned, onLifecycle }) {
  const WS = WebSocket || require('ws');
  const url = novigWsUrl(base);
  let socket = null;
  let stopped = false;
  let nonce = 0;
  let tokens = 0;
  let lastRefill = Date.now();
  let attempt = 0;
  let retargetTimer = null;
  const subscribed = new Set();
  const pending = new Set();
  const books = new Map();
  const gapped = new Set();

  const refill = () => {
    const t = Date.now();
    tokens = Math.min(WS_STREAM_CAPACITY, tokens + ((t - lastRefill) / 1000) * WS_STREAM_REFILL);
    lastRefill = t;
  };
  const send = (obj) => {
    if (!socket || socket.readyState !== 1) return false;
    nonce += 1;
    try { socket.send(JSON.stringify({ nonce, ...obj })); } catch (_) { return false; }
    return true;
  };

  function syncSubscriptions() {
    retargetTimer = null;
    if (!socket || socket.readyState !== 1) return;
    const want = new Set(desired());
    const drop = [...subscribed].filter((id) => !want.has(id));
    if (drop.length) {
      refill();
      if (tokens >= drop.length) {
        tokens -= drop.length;
        send({ unsubscribe: drop.map((id) => `market:${id}`) });
        for (const id of drop) {
          subscribed.delete(id);
          books.delete(id);
        }
        onOwned([...subscribed].filter((id) => books.has(id)));
      }
    }
    const add = [...want].filter((id) => !subscribed.has(id) && !pending.has(id));
    if (add.length) {
      refill();
      const room = Math.floor(tokens / WS_WEIGHT_BOOK);
      const batch = add.slice(0, Math.max(0, room));
      if (batch.length) {
        tokens -= batch.length * WS_WEIGHT_BOOK;
        const markets = {};
        for (const id of batch) {
          markets[id] = 'book';
          pending.add(id);
        }
        send({ subscribe: { markets } });
      }
    }
    // Resync gapped markets.
    if (gapped.size) {
      refill();
      const ids = [...gapped].slice(0, Math.floor(tokens / WS_WEIGHT_BOOK));
      if (ids.length) {
        tokens -= ids.length * WS_WEIGHT_BOOK;
        const markets = {};
        for (const id of ids) {
          markets[id] = 'book';
          gapped.delete(id);
        }
        send({ snapshot: { markets } });
      }
    }
    const more = [...want].some((id) => !subscribed.has(id) && !pending.has(id)) || gapped.size;
    if (more) schedule(1000);
  }

  function schedule(ms) {
    if (retargetTimer || stopped) return;
    retargetTimer = setTimeout(syncSubscriptions, ms);
    if (retargetTimer.unref) retargetTimer.unref();
  }

  function applySnapshot(snapshot, at) {
    for (const [id, row] of Object.entries(snapshot || {})) {
      pending.delete(id);
      if (!row || !row.book) continue;
      subscribed.add(id);
      const book = bookFromSnapshot(row.book, at);
      books.set(id, book);
      onBook(id, book, at);
    }
    onOwned([...subscribed].filter((id) => books.has(id)));
  }

  function applyDelta(delta, at) {
    for (const [id, row] of Object.entries(delta || {})) {
      if (!row) continue;
      if (row.lifecycle && Array.isArray(row.lifecycle.deltas)) onLifecycle(id, row.lifecycle.deltas);
      if (!row.book) continue;
      const book = books.get(id);
      const seq = Number(row.book.seq);
      if (!book) {
        // Market that opened under a subscription starts at seq 0.
        if (seq === 1) {
          const fresh = emptyBook();
          fresh.seq = 0;
          books.set(id, fresh);
          subscribed.add(id);
        } else continue;
      }
      const cur = books.get(id);
      if (seq <= cur.seq) continue;
      if (seq !== cur.seq + 1) {
        gapped.add(id);
        schedule(0);
        continue;
      }
      applyBookDeltas(cur, row.book.deltas);
      cur.seq = seq;
      cur.changedAt = at;
      onBook(id, cur, at);
    }
  }

  function onMessage(raw) {
    const text = String(raw == null ? '' : raw);
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }
    const at = Date.now();
    status.lastWsMsgAt = at;
    if (msg.code && !msg.snapshot && !msg.delta) {
      log('ws error', msg.code, msg.message || '');
      if (msg.code === 'SUBSCRIPTION_LIMIT_EXCEEDED' || msg.code === 'RATE_LIMIT_EXCEEDED') {
        pending.clear();
        schedule(5000);
      }
      return;
    }
    if (msg.snapshot) applySnapshot(msg.snapshot, at);
    if (msg.delta) applyDelta(msg.delta, at);
  }

  function connect() {
    if (stopped) return;
    status.ws = 'connecting';
    const u = new URL(url);
    let headers;
    try {
      headers = signedHeaders(key, { method: 'GET', path: u.pathname, query: u.search });
    } catch (err) {
      status.ws = 'error:sign';
      log('ws sign failed', err && err.message);
      return;
    }
    try {
      socket = new WS(url, { headers, handshakeTimeout: 10_000 });
    } catch (err) {
      status.ws = 'error:open';
      reconnect();
      return;
    }
    socket.on('open', () => {
      attempt = 0;
      status.ws = 'up';
      tokens = Math.max(0, WS_STREAM_CAPACITY - WS_UPGRADE_COST);
      lastRefill = Date.now();
      subscribed.clear();
      pending.clear();
      books.clear();
      nonce = 0;
      log('websocket up');
      syncSubscriptions();
    });
    socket.on('message', (data) => onMessage(data));
    socket.on('unexpected-response', (_req, res) => {
      status.ws = `error:http_${res && res.statusCode}`;
      log('websocket refused', res && res.statusCode);
    });
    socket.on('error', (err) => {
      if (!String(status.ws).startsWith('error:')) status.ws = 'error';
      log('websocket error', err && err.message);
    });
    socket.on('close', (code, reason) => {
      if (status.ws === 'up') status.ws = `closed:${code}`;
      log('websocket closed', code, String(reason || ''));
      subscribed.clear();
      pending.clear();
      books.clear();
      onOwned([]);
      socket = null;
      reconnect();
    });
  }

  function reconnect() {
    if (stopped) return;
    attempt += 1;
    const wait = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
    const t = setTimeout(connect, wait);
    if (t.unref) t.unref();
  }

  connect();
  return {
    retarget() { schedule(250); },
    stop() {
      stopped = true;
      if (retargetTimer) clearTimeout(retargetTimer);
      try { if (socket) socket.close(); } catch (_) { /* closed */ }
    },
    _state: { subscribed, pending, books, gapped },
    _onMessage: onMessage,
  };
}

module.exports = {
  NOVIG_BOOK_ID,
  LEAGUES,
  novigBase,
  novigWsUrl,
  novigKey,
  normalizePem,
  canonicalQuery,
  stringToSign,
  signString,
  signedHeaders,
  bookFromSnapshot,
  applyBookDeltas,
  bestBid,
  askFor,
  askLevels,
  fairProb0,
  americanFromProb,
  splitMatchup,
  parseSpreadName,
  normMarket,
  buildCatalog,
  quotesForMarket,
  pickMain,
  createLimiter,
  createNovigFeed,
  startNovigWs,
};
