// Persistent odds relay for the New Odds Board.
// One process, its own sockets. It does not start Combo Locks, Unhedged,
// or the Kalshi communications channel.
//
// Polymarket US (wss://api.polymarket.us/v1/ws/markets) is the primary book
// when POLYMARKET_KEY_ID + POLYMARKET_SECRET_KEY are set. International CLOB
// fills any pair the US socket is not currently owning.
// Kalshi market-data WS opens only for ODDS_RELAY_KALSHI_KEY_ID. Combo Locks
// KALSHI_KEY_ID is ignored here so a second communications subscriber cannot
// unsubscribe the quoter.
'use strict';

const http = require('http');
const { authHeaders: polymarketAuthHeaders } = require('./polymarket-auth');
const { authHeaders: kalshiAuthHeaders, normalizePem } = require('./kalshi-auth');

const US_WS_URL = 'wss://api.polymarket.us/v1/ws/markets';
const US_WS_PATH = '/v1/ws/markets';
const US_GATEWAY = 'https://gateway.polymarket.us';
const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const POLY_GAMMA = 'https://gamma-api.polymarket.com';
const POLY_CLOB = 'https://clob.polymarket.com';
const KALSHI_REST = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_WS_URL = 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';
const KALSHI_WS_SIGN_PATH = '/trade-api/ws/v2';

const BOOK_IDS = Object.freeze({ polymarket: 193, kalshi: 194 });
const LEAGUES = ['NFL', 'NCAAF', 'MLB'];
const US_LEAGUE_PATH = Object.freeze({ NFL: 'nfl', MLB: 'mlb', NCAAF: 'cfb' });
const WINNER_TYPES = new Set([
  'football_team_full_game_winner',
  'baseball_team_full_game_winner',
  'moneyline',
]);
const POLY_SERIES = Object.freeze({ NFL: '12185', NCAAF: '12756', MLB: '3' });
const KALSHI_GAME_SERIES = Object.freeze({
  NFL: 'KXNFLGAME',
  NCAAF: 'KXNCAAFGAME',
  MLB: 'KXMLBGAME',
});
const ESPN_SCOREBOARD = Object.freeze({
  NFL: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
  NCAAF: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard',
  MLB: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
});
const US_SLUG_CAP = 100;
const US_FRESH_MS = 15_000;
const KALSHI_TWO_LETTER = new Set(['NE', 'SF', 'GB', 'KC', 'TB', 'LV', 'NO', 'AZ']);

function parseLeague(raw) {
  const league = String(raw || 'NFL').trim().toUpperCase();
  return LEAGUES.includes(league) ? league : null;
}

function asProb(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  return n;
}

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

function epochMs(raw) {
  if (typeof raw === 'string' && /[T-]/.test(raw)) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function isoFromMs(raw) {
  const ms = epochMs(raw);
  const d = new Date(ms == null ? Date.now() : ms);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function quoteUpdatedMs(quote) {
  if (!quote || quote.updated_at == null || quote.updated_at === '') return 0;
  const parsed = Date.parse(String(quote.updated_at));
  return Number.isFinite(parsed) ? parsed : 0;
}

function keepNewerQuote(prev, incoming) {
  if (!incoming) return prev || null;
  if (!prev) return incoming;
  const tNew = quoteUpdatedMs(incoming);
  const tOld = quoteUpdatedMs(prev);
  if (tOld && (!tNew || tNew <= tOld)) return prev;
  return incoming;
}

function moneyValue(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return asProb(raw.value != null ? raw.value : raw.price);
  return asProb(raw);
}

function pairKeyFromSlug(slug) {
  const m = String(slug || '').toLowerCase().match(/(?:nfl|mlb|cfb|ncaaf)-([a-z0-9]+)-([a-z0-9]+)-\d{4}/);
  if (!m) return '';
  return [m[1], m[2]].sort().join('|');
}

function teamName(side) {
  const team = side && side.team;
  if (!team) return '';
  return String(team.name || team.displayName || '').trim();
}

function noAskFromBid(bid) {
  const n = asProb(bid);
  if (n == null) return null;
  return asProb(round4(1 - n));
}

function pxQty(row) {
  if (!row || typeof row !== 'object') return { price: NaN, size: NaN };
  const px = row.px && typeof row.px === 'object' ? row.px.value : (row.px != null ? row.px : row.price);
  const qty = row.qty != null ? row.qty : (row.size != null ? row.size : row.count);
  return { price: Number(px), size: Number(qty) };
}

function bestAskFromOffers(offers) {
  let best = null;
  for (const row of offers || []) {
    const { price, size } = pxQty(row);
    if (!Number.isFinite(price) || price <= 0 || price >= 1) continue;
    if (!Number.isFinite(size) || size <= 0) continue;
    if (best == null || price < best) best = price;
  }
  return best;
}

function bestBidFromBids(bids) {
  let best = null;
  for (const row of bids || []) {
    const { price, size } = pxQty(row);
    if (!Number.isFinite(price) || price <= 0 || price >= 1) continue;
    if (!Number.isFinite(size) || size <= 0) continue;
    if (best == null || price > best) best = price;
  }
  return best;
}

function polyQuote(fields) {
  const odds = asProb(fields.odds);
  if (odds == null || !fields.side || !fields.token_id) return null;
  const quote = {
    book: 'polymarket',
    book_id: BOOK_IDS.polymarket,
    league: fields.league,
    away: fields.away || '',
    home: fields.home || '',
    side: fields.side,
    bet_type: 'moneyline',
    is_live: fields.live === true,
    odds,
    size: fields.size == null ? null : fields.size,
    updated_at: fields.updated_at,
    token_id: fields.token_id,
    feed: fields.feed,
    pair_key: fields.pair_key || '',
  };
  if (fields.start) quote.start = fields.start;
  return quote;
}

function usQuotesFromPrices(meta, bestBid, bestAsk, ts) {
  if (!meta || !meta.slug) return [];
  const updated = isoFromMs(ts);
  const yesOdds = asProb(bestAsk);
  const noOdds = noAskFromBid(bestBid);
  const out = [];
  const yes = polyQuote({
    token_id: `us:${meta.slug}:yes`,
    league: meta.league,
    away: meta.away,
    home: meta.home,
    side: meta.yesName,
    odds: yesOdds,
    live: meta.live,
    start: meta.start,
    updated_at: updated,
    feed: 'polymarket-us',
    pair_key: meta.pairKey,
    size: meta.askSize || null,
  });
  const no = polyQuote({
    token_id: `us:${meta.slug}:no`,
    league: meta.league,
    away: meta.away,
    home: meta.home,
    side: meta.noName,
    odds: noOdds,
    live: meta.live,
    start: meta.start,
    updated_at: updated,
    feed: 'polymarket-us',
    pair_key: meta.pairKey,
    size: meta.bidSize || null,
  });
  if (yes) out.push(yes);
  if (no) out.push(no);
  return out;
}

function usMetaFromMarket(market, ev, league) {
  const kind = String(market && market.sportsMarketType || '').toLowerCase();
  if (!WINNER_TYPES.has(kind)) return null;
  if (!market || market.closed === true || market.active === false) return null;
  const sides = market.marketSides || [];
  const yes = sides.find((s) => s && s.long === true);
  const no = sides.find((s) => s && s.long === false);
  const awaySide = sides.find((s) => s && s.team && String(s.team.ordering || '').toLowerCase() === 'away') || yes;
  const homeSide = sides.find((s) => s && s.team && String(s.team.ordering || '').toLowerCase() === 'home') || no;
  const slug = String(market.slug || '');
  if (!slug) return null;
  return {
    slug,
    league,
    away: teamName(awaySide),
    home: teamName(homeSide),
    yesName: teamName(yes),
    noName: teamName(no),
    start: (ev && (ev.startTime || ev.startDate)) || market.gameStartTime || null,
    live: !!(ev && ev.live === true),
    pairKey: pairKeyFromSlug((ev && ev.slug) || slug),
    updatedAt: market.updatedAt || market.updated_at || (ev && ev.updatedAt) || null,
    bestBid: moneyValue(market.bestBidQuote),
    bestAsk: moneyValue(market.bestAskQuote),
  };
}

function eventInWindow(ev, nowMs) {
  if (ev && ev.live === true) return true;
  const start = Date.parse(ev && (ev.startTime || ev.startDate || ev.gameStartTime));
  if (!Number.isFinite(start)) return false;
  const now = Number(nowMs) || Date.now();
  return start > now - 8 * 3600 * 1000 && start < now + 8 * 24 * 3600 * 1000;
}

function usMarketsFromEvents(events, league, nowMs) {
  const out = [];
  for (const ev of events || []) {
    if (!ev || ev.closed === true) continue;
    if (!eventInWindow(ev, nowMs)) continue;
    for (const market of ev.markets || []) {
      const meta = usMetaFromMarket(market, ev, league);
      if (!meta) continue;
      out.push(meta);
    }
  }
  return out;
}

function rankUsMarkets(markets) {
  return markets.slice().sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return (Date.parse(a.start || '') || 0) - (Date.parse(b.start || '') || 0);
  });
}

function usSubscribeMessage(slugs, requestId) {
  return {
    subscribe: {
      requestId: requestId || `odds-${Date.now()}`,
      subscriptionType: 'SUBSCRIPTION_TYPE_MARKET_DATA_LITE',
      marketSlugs: slugs.slice(0, US_SLUG_CAP),
    },
  };
}

function findUsLite(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.marketDataLite) return msg.marketDataLite;
  if (msg.market_data_lite) return msg.market_data_lite;
  const data = msg.data;
  if (data && typeof data === 'object') {
    if (data.marketDataLite) return data.marketDataLite;
    if (data.market_data_lite) return data.market_data_lite;
  }
  if ((msg.marketSlug || msg.market_slug) && (msg.bestBid || msg.bestAsk)) return msg;
  return null;
}

function findUsBook(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const book = msg.marketData || msg.market_data
    || (msg.data && typeof msg.data === 'object' && (msg.data.marketData || msg.data.market_data));
  if (book && (book.offers || book.bids || book.asks)) return book;
  return null;
}

function usQuotesFromMessage(message, catalog, nowMs) {
  const list = Array.isArray(message) ? message : [message];
  const out = [];
  for (const msg of list) {
    if (!msg || typeof msg !== 'object') continue;
    const lite = findUsLite(msg);
    if (lite) {
      const slug = String(lite.marketSlug || lite.market_slug || '');
      const meta = catalog.get(slug);
      if (!meta) continue;
      const ts = lite.transactTime || lite.transact_time || msg.transactTime || nowMs;
      out.push(...usQuotesFromPrices(meta, moneyValue(lite.bestBid), moneyValue(lite.bestAsk), ts));
      continue;
    }
    const book = findUsBook(msg);
    if (!book) continue;
    const slug = String(book.marketSlug || book.market_slug || '');
    const meta = catalog.get(slug);
    if (!meta) continue;
    const ask = bestAskFromOffers(book.offers || book.asks);
    const bid = bestBidFromBids(book.bids);
    const ts = book.transactTime || book.transact_time || msg.transactTime || nowMs;
    out.push(...usQuotesFromPrices(meta, bid, ask, ts));
  }
  return out;
}

function relayPolyCreds(env = process.env) {
  const keyId = String(env.POLYMARKET_KEY_ID || '').trim();
  const secretKey = String(env.POLYMARKET_SECRET_KEY || '').trim();
  if (!keyId || !secretKey) return null;
  return { keyId, secretKey };
}

// Dedicated relay key only. Combo Locks' KALSHI_KEY_ID owns communications.
function relayKalshiCreds(env = process.env) {
  const keyId = String(env.ODDS_RELAY_KALSHI_KEY_ID || '').trim();
  const pemRaw = env.ODDS_RELAY_KALSHI_KEY || env.ODDS_RELAY_KALSHI_PRIVATE_KEY || '';
  if (!keyId || !String(pemRaw).trim()) return null;
  return { keyId, pem: normalizePem(String(pemRaw)) };
}

function willOpenKalshiWs(env = process.env) {
  return relayKalshiCreds(env) != null;
}

function usOwnsPair(state, pairKey, nowMs) {
  if (!pairKey || !state.usPairs.has(pairKey)) return false;
  if (state.usSocketUp) return true;
  return state.usLastFrameAt > 0 && (nowMs - state.usLastFrameAt) < US_FRESH_MS;
}

function createQuoteEmitter(book, keyOf, emit) {
  const seen = new Map();
  let snapshotted = false;
  const changedSince = (mode) => {
    const quotes = [...book.values()].filter(Boolean);
    const changed = [];
    for (const quote of quotes) {
      const key = keyOf(quote);
      if (!key || seen.get(key) === quote.odds) continue;
      seen.set(key, quote.odds);
      changed.push(quote);
    }
    if (changed.length) emit({ quotes: changed, complete: false, mode: mode || 'ws' });
  };
  return {
    push(mode) {
      const quotes = [...book.values()].filter(Boolean);
      if (!quotes.length) return;
      if (mode === 'ws' || snapshotted) {
        changedSince(mode === 'ws' ? 'ws' : (mode || 'rest'));
        return;
      }
      snapshotted = true;
      for (const quote of quotes) seen.set(keyOf(quote), quote.odds);
      emit({ quotes, complete: true, mode: 'snapshot' });
    },
    forceSnapshot() {
      const quotes = [...book.values()].filter(Boolean);
      if (!quotes.length) return;
      snapshotted = true;
      for (const quote of quotes) seen.set(keyOf(quote), quote.odds);
      emit({ quotes, complete: true, mode: 'snapshot' });
    },
  };
}

function formatQuoteSse(quotes, ingestTs, extra) {
  const payload = { source: extra && extra.source, quotes: quotes || [] };
  if (extra && extra.mode) payload.mode = extra.mode;
  if (extra && (extra.complete === true || extra.complete === false)) payload.complete = extra.complete;
  return `event: quote\ndata: ${JSON.stringify({ ingest_ts: ingestTs, payload })}\n\n`;
}

function quoteKey(quote) {
  if (!quote) return '';
  if (quote.token_id) return `t:${quote.token_id}`;
  if (quote.ticker) return `k:${quote.ticker}`;
  return '';
}

function mergeQuoteSnapshot(prev, incoming) {
  if (!incoming || typeof incoming !== 'object') return prev || { quotes: [], complete: true, mode: 'snapshot' };
  if (incoming.complete === true) return { ...incoming, quotes: (incoming.quotes || []).slice() };
  const map = new Map();
  for (const quote of (prev && prev.quotes) || []) {
    const key = quoteKey(quote);
    if (key) map.set(key, quote);
  }
  for (const quote of incoming.quotes || []) {
    const key = quoteKey(quote);
    if (key) map.set(key, quote);
  }
  return { ...incoming, quotes: [...map.values()], complete: false };
}

function replaySnapshot(last) {
  if (!last) return null;
  return { ...last, quotes: (last.quotes || []).slice(), complete: true, mode: 'snapshot' };
}

function createChannel() {
  const listeners = new Set();
  let last = null;
  return {
    push(packet) {
      last = mergeQuoteSnapshot(last, packet);
      for (const fn of listeners) {
        try { fn(packet); } catch (_) { /* listener closed */ }
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      if (last && last.quotes && last.quotes.length) {
        try { fn(replaySnapshot(last)); } catch (_) { /* ignore */ }
      }
      return () => listeners.delete(fn);
    },
  };
}

function createState() {
  const books = { polymarket: {}, kalshi: {} };
  const channels = { polymarket: {}, kalshi: {} };
  const emitters = { polymarket: {}, kalshi: {} };
  for (const league of LEAGUES) {
    books.polymarket[league] = new Map();
    books.kalshi[league] = new Map();
    channels.polymarket[league] = createChannel();
    channels.kalshi[league] = createChannel();
    emitters.polymarket[league] = createQuoteEmitter(
      books.polymarket[league],
      (q) => q.token_id,
      (packet) => channels.polymarket[league].push(packet),
    );
    emitters.kalshi[league] = createQuoteEmitter(
      books.kalshi[league],
      (q) => q.ticker,
      (packet) => channels.kalshi[league].push(packet),
    );
  }
  return {
    books,
    channels,
    emitters,
    usPairs: new Set(),
    usSocketUp: false,
    usLastFrameAt: 0,
    kalshiWsUp: false,
    status: { us: 'starting', clob: 'starting', kalshi: 'starting' },
  };
}

function groupByLeague(quotes) {
  const groups = new Map();
  for (const quote of quotes || []) {
    if (!quote || !quote.league) continue;
    if (!groups.has(quote.league)) groups.set(quote.league, []);
    groups.get(quote.league).push(quote);
  }
  return groups;
}

function publish(state, venue, league, quotes, mode, feed) {
  const book = state.books[venue] && state.books[venue][league];
  const emitter = state.emitters[venue] && state.emitters[venue][league];
  if (!book || !emitter) return;
  const now = Date.now();
  let incoming = quotes || [];
  if (feed === 'clob') {
    incoming = incoming.filter((quote) => quote && !usOwnsPair(state, quote.pair_key, now));
    if (!incoming.length) return;
    const stalePairs = new Set(incoming.map((quote) => quote.pair_key).filter(Boolean));
    for (const [key, prev] of book) {
      if (prev && prev.feed === 'polymarket-us' && stalePairs.has(prev.pair_key) && !usOwnsPair(state, prev.pair_key, now)) {
        book.delete(key);
        state.usPairs.delete(prev.pair_key);
      }
    }
  }
  let replaced = false;
  if (feed === 'polymarket-us') {
    const frameFresh = state.usLastFrameAt > 0 && (now - state.usLastFrameAt) < US_FRESH_MS;
    const socketLive = state.usSocketUp || frameFresh;
    if (mode === 'ws') state.usLastFrameAt = now;
    // A gateway seed must not kick the international book while the US
    // socket is down. The socket (or a tick from the last 15s) is what
    // makes US the primary source.
    if (mode !== 'ws' && !socketLive) {
      incoming = incoming.filter((quote) => {
        const pair = quote && quote.pair_key;
        if (!pair) return true;
        for (const prev of book.values()) {
          if (prev && prev.pair_key === pair) return false;
        }
        return true;
      });
    }
    const pairs = new Set(incoming.map((quote) => quote.pair_key).filter(Boolean));
    for (const pair of pairs) state.usPairs.add(pair);
    if (socketLive || mode === 'ws') {
      for (const [key, prev] of book) {
        if (prev && prev.feed !== 'polymarket-us' && pairs.has(prev.pair_key)) {
          book.delete(key);
          replaced = true;
        }
      }
    }
  }
  const keyOf = venue === 'kalshi' ? ((q) => q.ticker) : ((q) => q.token_id);
  for (const quote of incoming) {
    const key = keyOf(quote);
    if (!key) continue;
    const prev = book.get(key);
    if (feed === 'kalshi-rest' && state.kalshiWsUp && prev) {
      book.set(key, {
        ...quote,
        odds: prev.odds,
        updated_at: prev.updated_at,
        size: prev.size,
      });
      continue;
    }
    const next = keepNewerQuote(prev, quote);
    if (next) book.set(key, next);
  }
  if (replaced) emitter.forceSnapshot();
  else emitter.push(mode);
}

function levelPriceSize(row) {
  if (Array.isArray(row)) return { price: Number(row[0]), size: Number(row[1]) };
  if (row && typeof row === 'object') {
    return { price: Number(row.price), size: Number(row.size != null ? row.size : row.count) };
  }
  return { price: NaN, size: NaN };
}

function bestPricedLevel(levels, wantMax) {
  let best = null;
  for (const row of levels || []) {
    const { price, size } = levelPriceSize(row);
    if (!Number.isFinite(price) || price <= 0 || price >= 1) continue;
    if (!Number.isFinite(size) || size <= 0) continue;
    if (best == null || (wantMax ? price > best : price < best)) best = price;
  }
  return best;
}

function bestAskFromLevels(levels) {
  return bestPricedLevel(levels, false);
}

function kalshiYesAskFromNoBids(noBids) {
  const bestNo = bestPricedLevel(noBids, true);
  if (bestNo == null) return null;
  return round4(1 - bestNo);
}

function emptyPolymarketBook() {
  return { bids: new Map(), asks: new Map(), seeded: false, ts: 0 };
}

function setPolymarketLevel(map, price, size) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return;
  const key = n.toFixed(4);
  const sz = Number(size);
  if (!Number.isFinite(sz) || sz <= 0) map.delete(key);
  else map.set(key, sz);
}

function applyPolymarketBookSnapshot(state, snapshot) {
  state.bids.clear();
  state.asks.clear();
  for (const row of (snapshot && snapshot.bids) || []) {
    const { price, size } = levelPriceSize(row);
    setPolymarketLevel(state.bids, price, size);
  }
  for (const row of (snapshot && snapshot.asks) || []) {
    const { price, size } = levelPriceSize(row);
    setPolymarketLevel(state.asks, price, size);
  }
  state.seeded = true;
  return bestPricedLevel([...state.asks.entries()].map(([price, size]) => [price, size]), false);
}

function applyPolymarketPriceLevel(state, change) {
  const side = String(change && change.side || '').toUpperCase();
  const map = side === 'SELL' ? state.asks : side === 'BUY' ? state.bids : null;
  if (!map || !state.seeded) return bestPricedLevel([...state.asks.entries()].map(([p, s]) => [p, s]), false);
  setPolymarketLevel(map, change.price, change.size);
  return bestPricedLevel([...state.asks.entries()].map(([p, s]) => [p, s]), false);
}

function applyPolymarketStreamMessage(store, message) {
  const list = Array.isArray(message) ? message : [message];
  const out = [];
  for (const msg of list) {
    if (!msg || typeof msg !== 'object') continue;
    const type = String(msg.event_type || msg.type || '');
    if (type === 'book') {
      const id = String(msg.asset_id || '');
      if (!id) continue;
      const book = store.get(id) || emptyPolymarketBook();
      const ts = epochMs(msg.timestamp) || 0;
      if (book.seeded && book.ts && ts && ts < book.ts) continue;
      const ask = applyPolymarketBookSnapshot(book, msg);
      book.ts = ts || book.ts;
      store.set(id, book);
      if (ask != null) out.push({ assetId: id, bestAsk: ask, ts: msg.timestamp || book.ts });
      continue;
    }
    if (type !== 'price_change') continue;
    for (const change of msg.price_changes || msg.changes || []) {
      const id = String(change && change.asset_id || '');
      if (!id) continue;
      const book = store.get(id) || emptyPolymarketBook();
      if (!book.seeded) continue;
      const ts = epochMs(msg.timestamp) || 0;
      if (book.ts && ts && ts < book.ts) continue;
      const ask = applyPolymarketPriceLevel(book, change);
      if (ts) book.ts = ts;
      store.set(id, book);
      if (ask != null) out.push({ assetId: id, bestAsk: ask, ts: msg.timestamp || book.ts });
    }
  }
  return out;
}

function splitVersus(title) {
  const parts = String(title || '').split(/\s+vs\.?\s+/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return { away: '', home: '' };
  return { away: parts[0], home: parts[1] };
}

function parseJsonList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function clobEntriesFromEvent(ev, league) {
  if (!ev || ev.closed === true) return [];
  const ordering = String(ev.ordering || 'away').toLowerCase();
  const titleSides = splitVersus(ev.title || ev.name || '');
  let away = titleSides.away;
  let home = titleSides.home;
  if (ordering === 'home') {
    away = titleSides.home;
    home = titleSides.away;
  }
  const out = [];
  for (const market of ev.markets || []) {
    if (!market || market.closed === true) continue;
    if (String(market.sportsMarketType || '').toLowerCase() !== 'moneyline') continue;
    const outcomes = parseJsonList(market.outcomes).map((s) => String(s));
    const tokens = parseJsonList(market.clobTokenIds).map((s) => String(s));
    const lower = outcomes.map((s) => s.toLowerCase());
    if (lower.includes('yes') && lower.includes('no')) continue;
    const start = ev.startTime || ev.startDate || ev.gameStartTime || null;
    outcomes.forEach((side, i) => {
      const tokenId = tokens[i];
      if (!tokenId || !side) return;
      out.push({
        tokenId,
        league,
        away,
        home,
        side,
        live: ev.live === true,
        start,
        slug: ev.slug || '',
        pairKey: pairKeyFromSlug(ev.slug || ''),
      });
    });
  }
  return out;
}

function clobQuoteFromAsk(entry, ask, ts) {
  return polyQuote({
    token_id: entry.tokenId,
    league: entry.league,
    away: entry.away,
    home: entry.home,
    side: entry.side,
    odds: ask,
    live: entry.live,
    start: entry.start,
    updated_at: isoFromMs(ts),
    feed: 'clob',
    pair_key: entry.pairKey,
  });
}

function splitTeamCode(code) {
  const s = String(code || '').toUpperCase();
  if (s.length === 6) return [s.slice(0, 3), s.slice(3)];
  if (s.length === 4) return [s.slice(0, 2), s.slice(2)];
  if (s.length === 5) {
    if (KALSHI_TWO_LETTER.has(s.slice(0, 2))) return [s.slice(0, 2), s.slice(2)];
    if (KALSHI_TWO_LETTER.has(s.slice(-2))) return [s.slice(0, 3), s.slice(-2)];
  }
  return [];
}

function pairFromTicker(ticker) {
  const parts = String(ticker || '').split('-');
  if (parts.length < 3) return [];
  const side = String(parts[parts.length - 1] || '').toUpperCase();
  const slug = parts[parts.length - 2] || '';
  const teams = slug.replace(/^\d{2}[A-Z]{3}\d{2}(?:\d{4})?/, '').toUpperCase();
  if (!teams) return [];
  if (side && teams.startsWith(side) && teams.length > side.length) return [side, teams.slice(side.length)];
  if (side && teams.endsWith(side) && teams.length > side.length) return [teams.slice(0, -side.length), side];
  return splitTeamCode(teams);
}

function scheduleFromEspn(body) {
  const out = [];
  for (const ev of (body && body.events) || []) {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const abbrs = [];
    let away = '';
    let home = '';
    for (const side of comp.competitors || []) {
      const abbr = side && side.team && side.team.abbreviation;
      if (abbr) abbrs.push(String(abbr).toUpperCase());
      const name = side && side.team && (side.team.displayName || side.team.shortDisplayName || '');
      if (side && side.homeAway === 'home') home = name;
      if (side && side.homeAway === 'away') away = name;
    }
    const gameState = comp.status && comp.status.type && comp.status.type.state;
    out.push({ abbrs, away, home, start: ev.date || null, live: gameState === 'in' });
  }
  return out;
}

function applyKalshiSchedule(quotes, schedule, nowMs) {
  const now = Number(nowMs) || Date.now();
  for (const quote of quotes || []) {
    if (!quote) continue;
    const codes = pairFromTicker(quote.ticker);
    const hit = codes.length === 2
      ? (schedule || []).find((game) => game && codes.every((code) => (game.abbrs || []).includes(code)))
      : null;
    if (hit && hit.start) quote.start = hit.start;
    if (hit && hit.away) quote.away = hit.away;
    if (hit && hit.home) quote.home = hit.home;
    if (hit) {
      quote.is_live = hit.live === true;
      continue;
    }
    const startMs = Date.parse(quote.start || '');
    if (Number.isFinite(startMs) && startMs <= now && now - startMs < 6 * 3600 * 1000) quote.is_live = true;
  }
  return quotes;
}

function quotesFromKalshiMarket(market, league, teams, nowMs) {
  if (!market || !market.ticker) return null;
  const odds = asProb(market.yes_ask_dollars != null ? market.yes_ask_dollars : market.yes_ask);
  if (odds == null) return null;
  const side = market.yes_sub_title || market.subtitle || '';
  if (!side) return null;
  const size = Number(market.yes_ask_size_fp != null ? market.yes_ask_size_fp : market.yes_ask_size);
  const quote = {
    book: 'kalshi',
    book_id: BOOK_IDS.kalshi,
    league,
    away: teams.away || '',
    home: teams.home || '',
    side,
    bet_type: 'moneyline',
    is_live: false,
    odds,
    size: Number.isFinite(size) && size > 0 ? size : null,
    updated_at: new Date(nowMs || Date.now()).toISOString(),
    ticker: market.ticker,
  };
  const start = (teams && teams.start) || market.occurrence_datetime || null;
  if (start) quote.start = start;
  return quote;
}

function quotesFromKalshiEvents(events, league, nowMs) {
  const out = [];
  for (const ev of events || []) {
    const teams = splitVersus(ev.title || ev.sub_title || '');
    teams.start = ev.start_time || ev.startTime || ev.open_time || ev.strike_date || null;
    for (const market of ev.markets || []) {
      const ticker = String(market.ticker || '');
      if (!ticker.startsWith(`${KALSHI_GAME_SERIES[league]}-`)) continue;
      const quote = quotesFromKalshiMarket(market, league, teams, nowMs);
      if (quote) out.push(quote);
    }
  }
  return out;
}

function kalshiAskProb(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const dollars = msg.yes_ask_dollars != null ? msg.yes_ask_dollars : msg.yes_ask_dollar;
  const fromDollars = asProb(dollars);
  if (fromDollars != null) return fromDollars;
  const raw = Number(msg.yes_ask);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  if (raw < 1) return raw;
  if (raw < 100) return raw / 100;
  return null;
}

function kalshiLevelPrice(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.price_dollars != null) {
    const n = Number(msg.price_dollars);
    if (n > 0 && n < 1) return n;
  }
  const raw = Number(msg.price);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  if (raw < 1) return raw;
  if (raw < 100) return raw / 100;
  return null;
}

function kalshiNoRows(msg) {
  if (!msg || typeof msg !== 'object') return [];
  if (Array.isArray(msg.no_dollars_fp)) return msg.no_dollars_fp;
  if (Array.isArray(msg.no_dollars)) return msg.no_dollars;
  if (Array.isArray(msg.no)) return msg.no;
  return [];
}

function loadKalshiNoLevels(rows) {
  const no = new Map();
  for (const row of rows || []) {
    const price = Array.isArray(row) ? Number(row[0]) : kalshiLevelPrice(row);
    const size = Array.isArray(row) ? Number(row[1]) : Number(row && (row.size || row.count));
    const px = price > 1 && price < 100 ? price / 100 : price;
    if (!Number.isFinite(px) || px <= 0 || px >= 1) continue;
    if (Number.isFinite(size) && size > 0) no.set(px.toFixed(4), size);
  }
  return no;
}

function createKalshiOrderbook() {
  return {
    levels: new Map(),
    built: new Set(),
    sourced: new Set(),
    seqBySid: new Map(),
    tickersBySid: new Map(),
  };
}

function classifyKalshiSeq(state, sid, seq) {
  if (sid == null || sid === '' || !Number.isFinite(Number(seq))) return 'unsequenced';
  const key = Number(sid);
  const n = Number(seq);
  if (!state.seqBySid.has(key) || state.seqBySid.get(key) == null) return 'baseline';
  const last = state.seqBySid.get(key);
  if (n === last + 1) return 'next';
  if (n <= last) return 'dup';
  return 'gap';
}

function rememberKalshiTicker(state, sid, ticker) {
  if (sid == null || !Number.isFinite(Number(sid)) || !ticker) return;
  const key = Number(sid);
  let set = state.tickersBySid.get(key);
  if (!set) {
    set = new Set();
    state.tickersBySid.set(key, set);
  }
  set.add(ticker);
}

function invalidateKalshiSid(state, sid, ticker) {
  const key = Number(sid);
  const tickers = [...(state.tickersBySid.get(key) || [])];
  if (ticker && !tickers.includes(ticker)) tickers.push(ticker);
  for (const item of tickers) {
    state.built.delete(item);
    state.levels.delete(item);
  }
  state.seqBySid.set(key, null);
  return tickers;
}

function applyKalshiOrderbookFrame(state, message, metaByTicker) {
  const empty = { quotes: [], resnapshot: null };
  const msg = message && message.msg && typeof message.msg === 'object' ? message.msg : message;
  const type = String((message && message.type) || '');
  if (type !== 'orderbook_snapshot' && type !== 'orderbook_delta') return empty;
  const ticker = msg && (msg.market_ticker || msg.ticker);
  const meta = metaByTicker && metaByTicker.get(ticker);
  if (!meta || !ticker || !state) return empty;
  const sid = message && message.sid != null && message.sid !== '' ? Number(message.sid) : null;
  const seq = message && message.seq != null && message.seq !== '' ? Number(message.seq) : null;
  const kind = classifyKalshiSeq(state, sid, seq);
  const ts = (msg && (msg.ts_ms || msg.ts)) || (message && message.ts);
  if (kind === 'dup') return empty;
  if (type === 'orderbook_snapshot') {
    const levels = loadKalshiNoLevels(kalshiNoRows(msg));
    state.levels.set(ticker, levels);
    state.built.add(ticker);
    state.sourced.add(ticker);
    rememberKalshiTicker(state, sid, ticker);
    if (kind !== 'unsequenced') state.seqBySid.set(sid, seq);
    const ask = asProb(kalshiYesAskFromNoBids([...levels.entries()].map(([price, size]) => [price, size])));
    if (ask == null) return { quotes: [], resnapshot: null };
    return { quotes: [{ ...meta, odds: ask, updated_at: isoFromMs(ts), ticker }], resnapshot: null };
  }
  if (kind === 'gap') {
    const tickers = invalidateKalshiSid(state, sid, ticker);
    return { quotes: [], resnapshot: { sid, market_tickers: tickers } };
  }
  if (kind === 'baseline') {
    rememberKalshiTicker(state, sid, ticker);
    return { quotes: [], resnapshot: { sid, market_tickers: [ticker] } };
  }
  if (kind === 'next') state.seqBySid.set(sid, seq);
  if (!state.built.has(ticker)) {
    rememberKalshiTicker(state, sid, ticker);
    if (sid != null && Number.isFinite(sid)) return { quotes: [], resnapshot: { sid, market_tickers: [ticker] } };
    return empty;
  }
  const side = String(msg.side || '').toLowerCase();
  if (side === 'no') {
    const no = state.levels.get(ticker);
    const px = kalshiLevelPrice(msg);
    const delta = msg.delta_fp != null && msg.delta_fp !== '' ? Number(msg.delta_fp) : Number(msg.delta);
    if (no && px != null && Number.isFinite(delta)) {
      const key = px.toFixed(4);
      const next = (no.get(key) || 0) + delta;
      if (next <= 0) no.delete(key);
      else no.set(key, next);
    }
  } else if (side !== 'yes') {
    return empty;
  }
  const levels = state.levels.get(ticker) || new Map();
  const ask = asProb(kalshiYesAskFromNoBids([...levels.entries()].map(([price, size]) => [price, size])));
  if (ask == null) return empty;
  return { quotes: [{ ...meta, odds: ask, updated_at: isoFromMs(ts), ticker }], resnapshot: null };
}

const kalshiBookStates = new WeakMap();

function kalshiBookState(books) {
  if (books && books.levels && books.seqBySid) return books;
  if (!(books instanceof Map)) return createKalshiOrderbook();
  let state = kalshiBookStates.get(books);
  if (!state) {
    state = createKalshiOrderbook();
    kalshiBookStates.set(books, state);
  }
  return state;
}

function quotesFromKalshiOrderbook(message, books, metaByTicker) {
  return applyKalshiOrderbookFrame(kalshiBookState(books), message, metaByTicker).quotes;
}

function kalshiSnapshotRequest(sid, tickers, id) {
  return {
    id,
    cmd: 'update_subscription',
    params: {
      sids: [Number(sid)],
      market_tickers: tickers,
      action: 'get_snapshot',
    },
  };
}

function quotesFromKalshiTicker(message, metaByTicker) {
  const msg = message && message.msg && typeof message.msg === 'object' ? message.msg : message;
  const type = String((message && (message.type || message.event_type)) || '');
  if (type && type !== 'ticker') return [];
  const ticker = msg && (msg.market_ticker || msg.ticker);
  const meta = metaByTicker && metaByTicker.get(ticker);
  if (!meta) return [];
  const odds = kalshiAskProb(msg);
  if (odds == null) return [];
  return [{ ...meta, odds, updated_at: isoFromMs(msg.ts || message.ts), ticker }];
}

function kalshiSubscribeMessage(tickers, id = 1) {
  return {
    id,
    cmd: 'subscribe',
    params: { channels: ['ticker', 'orderbook_delta'], market_tickers: tickers },
  };
}

async function fetchJson(fetchFn, url, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 8000;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const headers = { accept: 'application/json', 'user-agent': 'combo-worker-odds-relay' };
    if (opts && opts.body) headers['content-type'] = 'application/json';
    const res = await fetchFn(url, {
      method: (opts && opts.method) || 'GET',
      headers,
      body: opts && opts.body,
      signal: ctrl ? ctrl.signal : undefined,
    });
    const text = res && typeof res.text === 'function' ? await res.text() : '';
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch (_) { body = null; }
    }
    return { ok: !!(res && res.ok), status: res && res.status, body };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms, isStopped) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof isStopped === 'function') {
      const poll = setInterval(() => {
        if (isStopped()) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 50);
      setTimeout(() => clearInterval(poll), ms + 20);
    }
  });
}

function loadWebSocket(deps) {
  if (deps && deps.WebSocket) return deps.WebSocket;
  return require('ws');
}

function startPolymarketUs(state, deps) {
  const env = (deps && deps.env) || process.env;
  const creds = relayPolyCreds(env);
  if (!creds) {
    state.status.us = 'no-key';
    return () => {};
  }
  const fetchFn = (deps && deps.fetchFn) || fetch;
  const WS = loadWebSocket(deps);
  const catalog = new Map();
  let stopped = false;
  let ws = null;
  let retry = null;
  let discoverTimer = null;
  let ping = null;
  let backoff = 1000;
  let subscribedKey = '';
  let slugs = [];

  const seed = (markets, mode) => {
    const ranked = rankUsMarkets(markets);
    const capped = ranked.slice(0, US_SLUG_CAP);
    catalog.clear();
    for (const meta of capped) catalog.set(meta.slug, meta);
    slugs = capped.map((meta) => meta.slug);
    const quotes = [];
    for (const meta of capped) {
      const ts = meta.updatedAt || Date.now();
      quotes.push(...usQuotesFromPrices(meta, meta.bestBid, meta.bestAsk, ts));
    }
    for (const [league, group] of groupByLeague(quotes)) {
      publish(state, 'polymarket', league, group, mode, 'polymarket-us');
    }
  };

  const sendSub = () => {
    if (!ws || ws.readyState !== 1 || !slugs.length) return;
    const key = slugs.slice().sort().join(',');
    if (key === subscribedKey) return;
    ws.send(JSON.stringify(usSubscribeMessage(slugs, `odds-${Date.now()}`)));
    subscribedKey = key;
  };

  const discover = async () => {
    const markets = [];
    for (const league of LEAGUES) {
      const path = US_LEAGUE_PATH[league];
      const url = `${US_GATEWAY}/v2/leagues/${path}/events?limit=80&active=true&closed=false`;
      const res = await fetchJson(fetchFn, url, { timeoutMs: 8000 });
      const events = (res.body && res.body.events) || [];
      markets.push(...usMarketsFromEvents(events, league, Date.now()));
    }
    seed(markets, 'rest');
    sendSub();
  };

  const connect = () => {
    if (stopped) return;
    const headers = polymarketAuthHeaders({
      keyId: creds.keyId,
      secretKey: creds.secretKey,
      method: 'GET',
      path: US_WS_PATH,
    });
    try {
      ws = new WS(US_WS_URL, { headers });
    } catch (err) {
      state.status.us = 'down';
      schedule();
      return;
    }
    ws.on('open', () => {
      if (stopped) return;
      backoff = 1000;
      state.usSocketUp = true;
      state.status.us = 'up';
      subscribedKey = '';
      sendSub();
      const seeded = [];
      for (const meta of catalog.values()) {
        seeded.push(...usQuotesFromPrices(meta, meta.bestBid, meta.bestAsk, meta.updatedAt || Date.now()));
      }
      for (const [league, group] of groupByLeague(seeded)) {
        publish(state, 'polymarket', league, group, 'snapshot', 'polymarket-us');
      }
      if (ping) clearInterval(ping);
      ping = setInterval(() => {
        try { if (ws && ws.ping) ws.ping(); } catch (_) { /* closing */ }
      }, 15000);
    });
    ws.on('message', (data) => {
      let parsed;
      try { parsed = JSON.parse(String(data)); } catch (_) { return; }
      const quotes = usQuotesFromMessage(parsed, catalog, Date.now());
      if (!quotes.length) return;
      state.usLastFrameAt = Date.now();
      for (const [league, group] of groupByLeague(quotes)) {
        publish(state, 'polymarket', league, group, 'ws', 'polymarket-us');
      }
    });
    const reopen = () => {
      state.usSocketUp = false;
      state.status.us = 'down';
      if (ping) clearInterval(ping);
      ping = null;
      subscribedKey = '';
      schedule();
    };
    ws.on('close', reopen);
    ws.on('error', () => { try { if (ws && ws.close) ws.close(); } catch (_) { /* ignore */ } });
  };

  const schedule = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = null;
      if (!stopped) connect();
    }, backoff);
    backoff = Math.min(backoff * 2, 15000);
  };

  const loop = async () => {
    while (!stopped) {
      try { await discover(); } catch (err) {
        state.status.us = state.usSocketUp ? 'up' : 'down';
        console.error('[odds-relay] polymarket us discover failed');
      }
      if (stopped) break;
      if (!ws || ws.readyState === 2 || ws.readyState === 3) connect();
      await sleep(30000, () => stopped);
    }
  };
  loop();
  discoverTimer = null;
  return () => {
    stopped = true;
    state.usSocketUp = false;
    if (retry) clearTimeout(retry);
    if (discoverTimer) clearTimeout(discoverTimer);
    if (ping) clearInterval(ping);
    try { if (ws && ws.close) ws.close(); } catch (_) { /* ignore */ }
  };
}

function startClob(state, deps) {
  const fetchFn = (deps && deps.fetchFn) || fetch;
  const WS = loadWebSocket(deps);
  let stopped = false;
  let ws = null;
  let ping = null;
  let retry = null;
  let backoff = 1000;
  const catalog = new Map();
  const levelBooks = new Map();
  let entries = [];

  const put = (quotes, mode) => {
    for (const [league, group] of groupByLeague(quotes)) {
      publish(state, 'polymarket', league, group, mode, 'clob');
    }
  };

  const discover = async () => {
    const next = [];
    const now = Date.now();
    for (const league of LEAGUES) {
      const url = `${POLY_GAMMA}/events?series_id=${POLY_SERIES[league]}&active=true&closed=false&limit=50&order=startTime&ascending=true`;
      const listed = await fetchJson(fetchFn, url, { timeoutMs: 8000 });
      const events = Array.isArray(listed.body) ? listed.body : [];
      for (const ev of events) {
        if (!eventInWindow(ev, now)) continue;
        next.push(...clobEntriesFromEvent(ev, league));
      }
    }
    entries = next.slice(0, 400);
    catalog.clear();
    for (const entry of entries) catalog.set(entry.tokenId, entry);
  };

  const priceRest = async () => {
    if (!entries.length) return;
    const fetchedAt = Date.now();
    const res = await fetchJson(fetchFn, `${POLY_CLOB}/books`, {
      method: 'POST',
      timeoutMs: 8000,
      body: JSON.stringify(entries.map((entry) => ({ token_id: entry.tokenId }))),
    });
    const body = res && res.body;
    const books = Array.isArray(body) ? body : (body && body.books) || [];
    const quotes = [];
    for (const book of books) {
      const id = String(book && (book.asset_id || book.token_id) || '');
      const entry = catalog.get(id);
      if (!entry) continue;
      const stateBook = levelBooks.get(id) || emptyPolymarketBook();
      const ask = applyPolymarketBookSnapshot(stateBook, book);
      stateBook.ts = epochMs(book.timestamp) || fetchedAt;
      levelBooks.set(id, stateBook);
      const quote = clobQuoteFromAsk(entry, ask, book.timestamp || fetchedAt);
      if (quote) quotes.push(quote);
    }
    put(quotes, 'rest');
  };

  const openWs = () => {
    if (stopped || !entries.length) return;
    try { if (ws && ws.close) ws.close(); } catch (_) { /* ignore */ }
    ws = new WS(CLOB_WS_URL);
    ws.on('open', () => {
      if (stopped) return;
      backoff = 1000;
      state.status.clob = 'up';
      try {
        ws.send(JSON.stringify({
          assets_ids: entries.map((entry) => entry.tokenId),
          type: 'market',
          custom_feature_enabled: true,
        }));
      } catch (_) { /* closing */ }
      if (ping) clearInterval(ping);
      ping = setInterval(() => {
        try { ws.send('PING'); } catch (_) { /* closing */ }
      }, 10000);
    });
    ws.on('message', (data) => {
      const text = String(data);
      if (!text || text === 'PONG') return;
      let parsed;
      try { parsed = JSON.parse(text); } catch (_) { return; }
      const applied = applyPolymarketStreamMessage(levelBooks, parsed);
      if (!applied.length) return;
      const quotes = [];
      for (const row of applied) {
        const entry = catalog.get(row.assetId);
        const quote = entry && clobQuoteFromAsk(entry, row.bestAsk, row.ts);
        if (quote) quotes.push(quote);
      }
      if (quotes.length) put(quotes, 'ws');
    });
    const reopen = () => {
      state.status.clob = 'down';
      if (ping) clearInterval(ping);
      ping = null;
      if (stopped || retry) return;
      retry = setTimeout(() => {
        retry = null;
        if (!stopped) openWs();
      }, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.on('close', reopen);
    ws.on('error', reopen);
  };

  const loop = async () => {
    while (!stopped) {
      try {
        await discover();
        if (!ws || ws.readyState === 2 || ws.readyState === 3) openWs();
        await priceRest();
      } catch (_) {
        state.status.clob = state.status.clob === 'up' ? 'up' : 'down';
      }
      if (stopped) break;
      await sleep(10000, () => stopped);
    }
  };
  loop();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    if (ping) clearInterval(ping);
    try { if (ws && ws.close) ws.close(); } catch (_) { /* ignore */ }
  };
}

const espnCache = new Map();

async function espnSchedule(league, fetchFn) {
  const boardUrl = ESPN_SCOREBOARD[league];
  if (!boardUrl) return [];
  const hit = espnCache.get(league);
  const now = Date.now();
  if (hit && now - hit.at < 15000) return hit.games;
  try {
    const sched = await fetchJson(fetchFn, boardUrl, { timeoutMs: 2500 });
    const games = scheduleFromEspn(sched && sched.body);
    espnCache.set(league, { at: now, games });
    return games;
  } catch (_) {
    return hit ? hit.games : [];
  }
}

function startKalshi(state, deps) {
  const env = (deps && deps.env) || process.env;
  const fetchFn = (deps && deps.fetchFn) || fetch;
  const creds = relayKalshiCreds(env);
  const base = (deps && deps.kalshiBase) || process.env.KALSHI_API_BASE || KALSHI_REST;
  const WS = loadWebSocket(deps);
  let stopped = false;
  let ws = null;
  let retry = null;
  let ping = null;
  let backoff = 1000;
  const metaByTicker = new Map();
  const ob = createKalshiOrderbook();
  let cmdId = 1000;
  const pendingSnap = new Set();
  state.status.kalshi = creds ? 'connecting' : 'rest';
  if (!creds) {
    console.log('[odds-relay] kalshi market-data websocket off (no ODDS_RELAY_KALSHI_KEY_ID). Public REST only. Combo Locks KALSHI_KEY_ID is not read.');
  } else {
    console.log('[odds-relay] kalshi market-data websocket uses ODDS_RELAY_KALSHI_KEY_ID. That key must not be the Combo Locks communications key.');
  }

  const publishLeague = (league, quotes, mode) => {
    for (const quote of quotes) metaByTicker.set(quote.ticker, quote);
    publish(state, 'kalshi', league, quotes, mode, mode === 'ws' ? 'kalshi-ws' : 'kalshi-rest');
  };

  const loadLeague = async (league) => {
    const fetchedAt = Date.now();
    const scheduleP = espnSchedule(league, fetchFn);
    const events = [];
    let cursor = '';
    for (let page = 0; page < 3; page += 1) {
      const url = `${base}/events?series_ticker=${encodeURIComponent(KALSHI_GAME_SERIES[league])}&status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await fetchJson(fetchFn, url, { timeoutMs: 8000 });
      events.push(...((res.body && res.body.events) || []));
      cursor = (res.body && res.body.cursor) || '';
      if (!cursor) break;
    }
    const quotes = quotesFromKalshiEvents(events, league, fetchedAt);
    try {
      applyKalshiSchedule(quotes, await scheduleP, fetchedAt);
    } catch (_) { /* identity stays on the market title */ }
    if (!state.kalshiWsUp) {
      const live = quotes.filter((quote) => {
        const start = Date.parse(quote.start || '');
        return Number.isFinite(start) && start >= fetchedAt - 12 * 3600 * 1000 && start <= fetchedAt + 12 * 3600 * 1000;
      });
      await Promise.all(live.map(async (quote) => {
        try {
          const url = `${base}/markets/${encodeURIComponent(quote.ticker)}/orderbook`;
          const res = await fetchJson(fetchFn, url, { timeoutMs: 4000 });
          const noBids = res && res.body && res.body.orderbook_fp && res.body.orderbook_fp.no_dollars;
          const ask = asProb(kalshiYesAskFromNoBids(noBids));
          if (ask == null) return;
          quote.odds = ask;
          quote.updated_at = new Date(fetchedAt).toISOString();
        } catch (_) { /* keep yes_ask */ }
      }));
    }
    publishLeague(league, quotes, 'rest');
  };

  const openWs = () => {
    if (stopped || !creds) return;
    const headers = kalshiAuthHeaders({
      keyId: creds.keyId,
      pem: creds.pem,
      method: 'GET',
      signPath: KALSHI_WS_SIGN_PATH,
    });
    ws = new WS(KALSHI_WS_URL, { headers });
    ws.on('open', () => {
      if (stopped) return;
      backoff = 1000;
      state.kalshiWsUp = true;
      state.status.kalshi = 'ws';
      ob.seqBySid.clear();
      ob.built.clear();
      ob.levels.clear();
      ob.tickersBySid.clear();
      pendingSnap.clear();
      const tickers = [...metaByTicker.keys()];
      if (tickers.length) ws.send(JSON.stringify(kalshiSubscribeMessage(tickers)));
      if (ping) clearInterval(ping);
      ping = setInterval(() => {
        try { if (ws.ping) ws.ping(); } catch (_) { /* closing */ }
      }, 10000);
    });
    ws.on('message', (data) => {
      let parsed;
      try { parsed = JSON.parse(String(data)); } catch (_) { return; }
      const type = String(parsed && parsed.type || '');
      let quotes = [];
      if (type === 'orderbook_snapshot' || type === 'orderbook_delta') {
        const applied = applyKalshiOrderbookFrame(ob, parsed, metaByTicker);
        if (type === 'orderbook_snapshot' && parsed.sid != null) pendingSnap.delete(Number(parsed.sid));
        if (applied.resnapshot && applied.resnapshot.sid != null && !pendingSnap.has(Number(applied.resnapshot.sid))) {
          const sid = Number(applied.resnapshot.sid);
          const tickers = [...new Set((applied.resnapshot.market_tickers || []).filter(Boolean))];
          if (tickers.length) {
            pendingSnap.add(sid);
            try {
              ws.send(JSON.stringify(kalshiSnapshotRequest(sid, tickers, cmdId)));
              cmdId += 1;
            } catch (_) { pendingSnap.delete(sid); }
          }
        }
        quotes = applied.quotes;
      } else if (type === 'ticker') {
        quotes = quotesFromKalshiTicker(parsed, metaByTicker)
          .filter((quote) => quote && !ob.sourced.has(quote.ticker));
      }
      if (!quotes.length) return;
      for (const [league, group] of groupByLeague(quotes)) {
        publish(state, 'kalshi', league, group, 'ws', 'kalshi-ws');
      }
    });
    const reopen = () => {
      state.kalshiWsUp = false;
      state.status.kalshi = 'rest';
      if (ping) clearInterval(ping);
      ping = null;
      if (stopped || retry) return;
      retry = setTimeout(() => {
        retry = null;
        if (!stopped) openWs();
      }, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.on('close', reopen);
    ws.on('error', reopen);
    ws.on('unexpected-response', (_req, res) => {
      try { res.resume(); } catch (_) { /* ignore */ }
      reopen();
    });
  };

  const loop = async () => {
    while (!stopped) {
      try {
        for (const league of LEAGUES) {
          if (stopped) break;
          await loadLeague(league);
        }
        if (creds && (!ws || ws.readyState === 2 || ws.readyState === 3)) openWs();
        else if (creds && ws && ws.readyState === 1) {
          const tickers = [...metaByTicker.keys()];
          if (tickers.length) {
            try { ws.send(JSON.stringify(kalshiSubscribeMessage(tickers, Date.now()))); } catch (_) { /* closing */ }
          }
        }
      } catch (_) {
        if (!state.kalshiWsUp) state.status.kalshi = creds ? 'down' : 'rest';
      }
      if (stopped) break;
      await sleep(state.kalshiWsUp ? 15000 : 1000, () => stopped);
    }
  };
  loop();
  return () => {
    stopped = true;
    state.kalshiWsUp = false;
    if (retry) clearTimeout(retry);
    if (ping) clearInterval(ping);
    try { if (ws && ws.close) ws.close(); } catch (_) { /* ignore */ }
  };
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, Cache-Control');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function boardQuotes(state, venue, league) {
  const book = state.books[venue] && state.books[venue][league];
  return book ? [...book.values()] : [];
}

function handleRequest(req, res, state) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('method');
    return;
  }
  if (url.pathname === '/health') {
    const counts = {};
    for (const venue of ['polymarket', 'kalshi']) {
      counts[venue] = {};
      for (const league of LEAGUES) counts[venue][league] = state.books[venue][league].size;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, status: state.status, counts }));
    return;
  }
  if (url.pathname !== '/stream' && url.pathname !== '/board') {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const venue = String(url.searchParams.get('venue') || '');
  const league = parseLeague(url.searchParams.get('league') || 'NFL');
  if ((venue !== 'polymarket' && venue !== 'kalshi') || !league) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'venue and league required' }));
    return;
  }
  if (url.pathname === '/board') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, league, venue, quotes: boardQuotes(state, venue, league) }));
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const writePacket = (packet) => {
    if (!packet) return;
    res.write(formatQuoteSse(packet.quotes, new Date().toISOString(), {
      source: venue,
      complete: packet.complete,
      mode: packet.mode,
    }));
  };
  const unsub = state.channels[venue][league].subscribe(writePacket);
  const beat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { /* closed */ }
  }, 15000);
  const close = () => {
    clearInterval(beat);
    unsub();
  };
  req.on('close', close);
  res.on('error', close);
}

function startOddsRelay(opts = {}) {
  const state = createState();
  const stops = [];
  if (opts.upstream !== false) {
    const env = opts.env || process.env;
    if (!relayPolyCreds(env)) {
      console.log('[odds-relay] polymarket us off (no POLYMARKET_KEY_ID). International CLOB is the book.');
    }
    stops.push(startPolymarketUs(state, opts));
    stops.push(startClob(state, opts));
    stops.push(startKalshi(state, opts));
  } else {
    state.status = { us: 'off', clob: 'off', kalshi: 'off' };
  }
  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res, state);
    } catch (_) {
      try {
        res.writeHead(500);
        res.end('error');
      } catch (__) { /* closed */ }
    }
  });
  return {
    state,
    server,
    publish(venue, league, quotes, mode, feed) {
      publish(state, venue, league, quotes, mode, feed);
    },
    listen(port, host) {
      const listenPort = port == null ? (Number(process.env.PORT) || 8787) : port;
      const listenHost = host || '0.0.0.0';
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, listenHost, () => {
          server.removeListener('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      for (const stop of stops) {
        try { stop(); } catch (_) { /* ignore */ }
      }
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = {
  US_SLUG_CAP,
  US_FRESH_MS,
  pairKeyFromSlug,
  noAskFromBid,
  bestAskFromOffers,
  bestBidFromBids,
  usMarketsFromEvents,
  usQuotesFromPrices,
  usQuotesFromMessage,
  usSubscribeMessage,
  rankUsMarkets,
  relayPolyCreds,
  relayKalshiCreds,
  willOpenKalshiWs,
  usOwnsPair,
  createQuoteEmitter,
  formatQuoteSse,
  mergeQuoteSnapshot,
  replaySnapshot,
  createState,
  publish,
  applyPolymarketStreamMessage,
  bestAskFromLevels,
  kalshiYesAskFromNoBids,
  pairFromTicker,
  quotesFromKalshiOrderbook,
  createKalshiOrderbook,
  applyKalshiOrderbookFrame,
  kalshiSnapshotRequest,
  startOddsRelay,
};
