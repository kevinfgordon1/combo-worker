// VENDORED verbatim from aibetbuilder origin/main 768ea81 lib/player-td-feeds.js. Do not edit here; re-vendor instead.
'use strict';

// First-party NFL player touchdown quotes for the New Odds Board.
// Kalshi public REST, Polymarket US gateway event payloads, Underdog phone
// lines. No sportsbook. Poll with backoff, and keep a short in-process cache
// so a 45s board refresh does not re-download the multi-megabyte event bodies.

const {
  TAKER_FEE_RATE,
  parseKalshiTdTicker,
  playerNameFromKalshiTitle,
  pairKeyFromSlug,
  slugFromGameKey,
  asUnitProb,
  parseAmerican,
  boardYesAmerican,
  noAskAmericanFromYesBid,
  thresholdFromLine,
  teamDisplayName,
  boardFromQuotes,
  quoteIsOlderThan,
  ENABLED_TD_MARKETS,
  selectPlayerTdQuotes,
  impliedFromAmerican,
  nflAbbrFromName,
  gameKeyOf,
} = require('./player-td.cjs');
const { UNDERDOG_BOARD_OMIT_MS } = require('./underdog-freshness');

const KALSHI_REST = 'https://api.elections.kalshi.com/trade-api/v2';
const POLY_GATEWAY = 'https://gateway.polymarket.us';
const NOVIG_BASE = 'https://api.novig.com';
const UNDERDOG_BASE = 'https://api.underdogfantasy.com';
const UNDERDOG_CLIENT_VERSION = '20260918170103';
const UNDERDOG_PRODUCT = 'fantasy';
const UNDERDOG_STATE_CONFIG_ID = 'f8996742-f10c-4d32-955a-dcbcaa5dc5c0';
const UNDERDOG_PRODUCT_EXPERIENCE_ID = '018e1234-5678-9abc-def0-123456789009';
const UNDERDOG_TD_FILTER_ID = '8ccbe039-9d73-4513-ac40-200d2eb5f09e';

// First TD is its own series. Anytime and 2+ share KXNFLTD (ticker suffix).
const KALSHI_SERIES_BY_MARKET = Object.freeze({
  anytime: ['KXNFLTD'],
  two: ['KXNFLTD'],
  first: ['KXNFLFIRSTTD'],
});

function kalshiSeriesForMarkets(markets) {
  const out = [];
  for (const market of markets || []) {
    for (const series of KALSHI_SERIES_BY_MARKET[market] || []) {
      if (!out.includes(series)) out.push(series);
    }
  }
  return out;
}

const KALSHI_SERIES = Object.freeze(kalshiSeriesForMarkets(ENABLED_TD_MARKETS));
const BOARD_CACHE_MS = 45 * 1000;
const MAX_POLY_GAMES = 16;
const POLY_CONCURRENCY = 2;

const boardCache = { at: 0, body: null };

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function valuesOf(node) {
  if (!node) return [];
  if (Array.isArray(node)) return node;
  if (typeof node === 'object') return Object.values(node);
  return [];
}

async function readBody(res) {
  if (!res) return null;
  if (typeof res.json === 'function' && res._jsonUsed !== true) {
    try {
      const body = await res.json();
      return body;
    } catch (_) { /* text fallback */ }
  }
  const text = typeof res.text === 'function' ? await res.text() : '';
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

async function fetchJson(fetchFn, url, { headers, attempts = 4, sleepFn = sleep } = {}) {
  let wait = 400;
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    let res;
    try {
      res = await fetchFn(url, { headers: headers || { accept: 'application/json' } });
    } catch (err) {
      last = err;
      if (i === attempts - 1) break;
      await sleepFn(wait);
      wait *= 2;
      continue;
    }
    const status = res && res.status ? res.status : 0;
    if (status === 429 || status === 502 || status === 503 || status === 504) {
      last = new Error(`HTTP ${status}`);
      if (i === attempts - 1) break;
      await sleepFn(wait);
      wait *= 2;
      continue;
    }
    const body = await readBody(res);
    return { ok: status >= 200 && status < 300, status, body };
  }
  return { ok: false, status: 0, body: null, error: last };
}

// Dollar stake available at a No price made by crossing a Yes bid of
// yesBidProb with `contracts` contracts. null when size is missing or zero.
function noStakeDollars(yesBidProb, contracts) {
  const p = Number(yesBidProb);
  const qty = Number(contracts);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  if (!Number.isFinite(qty) || qty <= 0) return null;
  return Math.round(qty * (1 - p) * 100) / 100;
}

function kalshiQuoteFromMarket(market, nowMs) {
  if (!market) return null;
  const parsed = parseKalshiTdTicker(market.ticker || market.event_ticker);
  if (!parsed || parsed.market === 'three') return null;
  const yesAsk = asUnitProb(market.yes_ask_dollars != null ? market.yes_ask_dollars : market.yes_ask);
  const yesBid = asUnitProb(market.yes_bid_dollars != null ? market.yes_bid_dollars : market.yes_bid);
  const player = playerNameFromKalshiTitle(market.title, market.yes_sub_title);
  if (!player || yesAsk == null) return null;
  const fee = TAKER_FEE_RATE.kalshi;
  const noAmerican = yesBid == null ? null : noAskAmericanFromYesBid(yesBid, fee);
  // Top-of-book No size from the list payload (yes_bid_size_fp contracts).
  // The props cron replaces this with the full orderbook ladder.
  const top = noAmerican == null ? null : noLevel(yesBid, market.yes_bid_size_fp != null ? market.yes_bid_size_fp : market.yes_bid_size, fee);
  const noSize = top ? top.size : null;
  return {
    book: 'kalshi',
    market: parsed.market,
    player,
    team: '',
    away: parsed.away,
    home: parsed.home,
    gameKey: parsed.gameKey,
    commence: market.occurrence_datetime || null,
    yesAmerican: boardYesAmerican(yesAsk, fee),
    noAmerican,
    noSize,
    noLevels: noSize != null ? [{ american: noAmerican, size: noSize }] : null,
    updatedAt: market.updated_time || new Date(nowMs || Date.now()).toISOString(),
    ticker: market.ticker,
  };
}

function quotesFromKalshiMarkets(body) {
  const markets = body && Array.isArray(body.markets) ? body.markets : [];
  const out = [];
  for (const market of markets) {
    const quote = kalshiQuoteFromMarket(market);
    if (quote && quote.yesAmerican != null) out.push(quote);
  }
  return out;
}

async function loadKalshiTdQuotes(deps) {
  const fetchFn = (deps && deps.fetchFn) || fetch;
  const base = (deps && deps.kalshiBase) || KALSHI_REST;
  const sleepFn = (deps && deps.sleepFn) || sleep;
  const out = [];
  for (const series of KALSHI_SERIES) {
    let cursor = '';
    for (let page = 0; page < 6; page += 1) {
      const url = `${base}/markets?series_ticker=${encodeURIComponent(series)}&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await fetchJson(fetchFn, url, { sleepFn, attempts: deps && deps.attempts ? deps.attempts : 4 });
      if (!res.ok || !res.body) break;
      out.push(...quotesFromKalshiMarkets(res.body));
      cursor = String(res.body.cursor || '');
      if (!cursor) break;
    }
  }
  return out;
}

function polyProb(quote) {
  if (!quote) return null;
  if (typeof quote === 'number' || typeof quote === 'string') return asUnitProb(quote);
  return asUnitProb(quote.value != null ? quote.value : quote.price);
}

function quotesFromPolymarketEvent(body) {
  const event = body && body.event ? body.event : body;
  if (!event) return [];
  const slug = pairKeyFromSlug(event.slug || event.ticker);
  if (!slug) return [];
  const teamById = new Map();
  let awayName = teamDisplayName(slug.away);
  let homeName = teamDisplayName(slug.home);
  for (const team of event.teams || []) {
    if (!team) continue;
    const abbr = String(team.displayAbbreviation || team.abbreviation || '').toUpperCase();
    if (team.id != null) teamById.set(String(team.id), abbr);
    const name = team.name || '';
    if (abbr && abbr.toUpperCase() === slug.away && name) awayName = name;
    if (abbr && abbr.toUpperCase() === slug.home && name) homeName = name;
  }
  const out = [];
  const fee = TAKER_FEE_RATE.polymarket;
  for (const market of event.markets || []) {
    const kind = market && (market.sportsMarketType || market.marketType);
    let tdMarket = null;
    if (kind === 'football_player_touchdowns') {
      const meta = market.metadata || {};
      tdMarket = thresholdFromLine(market.line, meta.lineLabel);
    } else if (kind === 'football_player_first_touchdown') {
      tdMarket = 'first';
    } else {
      continue;
    }
    if (!tdMarket || tdMarket === 'three') continue;
    const meta = market.metadata || {};
    const player = meta.playerName || '';
    if (!player) continue;
    const yesAsk = polyProb(market.bestAskQuote);
    const yesBid = polyProb(market.bestBidQuote);
    if (yesAsk == null) continue;
    const team = teamById.get(String(meta.teamId == null ? '' : meta.teamId)) || '';
    out.push({
      book: 'polymarket',
      market: tdMarket,
      player,
      team,
      away: slug.away,
      home: slug.home,
      awayName,
      homeName,
      gameKey: slug.gameKey,
      commence: event.startTime || event.startDate || market.gameStartTime || null,
      yesAmerican: boardYesAmerican(yesAsk, fee),
      noAmerican: yesBid == null ? null : noAskAmericanFromYesBid(yesBid, fee),
      updatedAt: market.updatedAt || event.updatedAt || null,
      slug: market.slug || null,
      closed: market.closed === true,
    });
  }
  return out;
}

// No-side ask ladders for the Promo $500 depth blend.
// Buying No crosses the Yes bids: a Yes bid at p with q contracts is a No ask
// at (1 - p) for q contracts. Levels carry the fee-adjusted American price
// (same TAKER_FEE_RATE as the board) and the dollar stake at that price.
const NO_LADDER_LEVELS = 10;

function noLevel(yesBidProb, contracts, fee) {
  const p = Number(yesBidProb);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  const american = noAskAmericanFromYesBid(p, fee);
  if (american == null) return null;
  const implied = impliedFromAmerican(american);
  const qty = Number(contracts);
  if (implied == null || !Number.isFinite(qty) || qty <= 0) return null;
  return { p, american, size: Math.round(qty * implied * 100) / 100 };
}

function finishNoLevels(levels, maxLevels) {
  // Yes bids best-first = highest p first = best (cheapest) No first.
  levels.sort((a, b) => b.p - a.p);
  const merged = [];
  for (const lvl of levels) {
    const prev = merged[merged.length - 1];
    if (prev && prev.american === lvl.american) prev.size = Math.round((prev.size + lvl.size) * 100) / 100;
    else merged.push({ p: lvl.p, american: lvl.american, size: lvl.size });
    if (merged.length >= maxLevels) break;
  }
  return merged.map(({ american, size }) => ({ american, size }));
}

// Kalshi orderbook_fp.yes_dollars: [["0.0300","171.00"], ...] (price, contracts).
function noLevelsFromKalshiOrderbook(body, { maxLevels = NO_LADDER_LEVELS } = {}) {
  const book = body && (body.orderbook_fp || body.orderbook || body);
  const yes = book && Array.isArray(book.yes_dollars) ? book.yes_dollars : [];
  const fee = TAKER_FEE_RATE.kalshi;
  const levels = [];
  for (const row of yes) {
    if (!Array.isArray(row)) continue;
    const lvl = noLevel(asUnitProb(row[0]), row[1], fee);
    if (lvl) levels.push(lvl);
  }
  return finishNoLevels(levels, maxLevels);
}

// Polymarket US public book (gateway, keyless). Bids are Yes bids.
function noLevelsFromPolymarketBook(body, { maxLevels = NO_LADDER_LEVELS } = {}) {
  const data = body && (body.marketData || body);
  const bids = data && Array.isArray(data.bids) ? data.bids : [];
  const fee = TAKER_FEE_RATE.polymarket;
  const levels = [];
  for (const bid of bids) {
    const lvl = noLevel(polyProb(bid && bid.px), bid && bid.qty, fee);
    if (lvl) levels.push(lvl);
  }
  return finishNoLevels(levels, maxLevels);
}

// Rate-limit budget for the 5-minute props cron (Vercel maxDuration 60s).
const KALSHI_BOOK_BATCH = 100;      // /markets/orderbooks accepts 1-100 tickers
const KALSHI_BATCH_GAP_MS = 250;
const KALSHI_SINGLE_CAP = 120;      // per-ticker fallback when batch is refused
const KALSHI_SINGLE_CONCURRENCY = 3;
// Polymarket US /book is documented at 20 req/s per IP, but in practice the
// gateway allows ~6 book calls then a ~10s Retry-After lockout (measured
// 2026-09-26). So this is best-effort: a few books per run, where Polymarket
// is the best No, paced, and it stops at the first 429.
const POLY_BOOK_CONCURRENCY = 1;
const POLY_BOOK_GAP_MS = 800;
const POLY_BOOK_BUDGET_MS = 12000;
const MAX_POLY_BOOKS = 12;
const POLY_MAX_THROTTLES = 1;

async function loadKalshiNoLadders(tickers, deps) {
  const fetchFn = (deps && deps.fetchFn) || fetch;
  const base = (deps && deps.kalshiBase) || KALSHI_REST;
  const sleepFn = (deps && deps.sleepFn) || sleep;
  const list = [...new Set((tickers || []).filter(Boolean))];
  const out = new Map();
  let batchRefused = false;
  for (let i = 0; i < list.length && !batchRefused; i += KALSHI_BOOK_BATCH) {
    const chunk = list.slice(i, i + KALSHI_BOOK_BATCH);
    const qs = chunk.map((t) => `tickers=${encodeURIComponent(t)}`).join('&');
    const res = await fetchJson(fetchFn, `${base}/markets/orderbooks?${qs}`, { sleepFn, attempts: 3 });
    if (!res.ok || !res.body || !Array.isArray(res.body.orderbooks)) {
      if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) batchRefused = true;
      continue;
    }
    for (const row of res.body.orderbooks) {
      const ticker = row && (row.ticker || row.market_ticker);
      if (!ticker) continue;
      out.set(ticker, noLevelsFromKalshiOrderbook(row));
    }
    if (i + KALSHI_BOOK_BATCH < list.length) await sleepFn(KALSHI_BATCH_GAP_MS);
  }
  if (batchRefused) {
    const rest = list.filter((t) => !out.has(t)).slice(0, KALSHI_SINGLE_CAP);
    await mapPool(rest, KALSHI_SINGLE_CONCURRENCY, async (ticker) => {
      const res = await fetchJson(fetchFn, `${base}/markets/${encodeURIComponent(ticker)}/orderbook?depth=${NO_LADDER_LEVELS * 2}`, { sleepFn, attempts: 2 });
      if (res.ok && res.body) out.set(ticker, noLevelsFromKalshiOrderbook(res.body));
    });
  }
  return out;
}

// Shared pacing state for Polymarket US /book calls. The NFL TD and MLB HR
// jobs run in the same cron invocation (same IP), so they pass one limiter
// and draw from one budget: one gap, one book cap, one time budget, and a
// 429 on either stops both. Without a shared limiter each call makes its own.
function createPolyBookLimiter(opts) {
  const o = opts || {};
  return {
    nowFn: o.nowFn || Date.now,
    gapMs: o.gapMs != null ? o.gapMs : POLY_BOOK_GAP_MS,
    budgetMs: o.budgetMs != null ? o.budgetMs : POLY_BOOK_BUDGET_MS,
    maxBooks: o.maxBooks != null ? o.maxBooks : MAX_POLY_BOOKS,
    maxThrottles: o.maxThrottles != null ? o.maxThrottles : POLY_MAX_THROTTLES,
    started: null,
    nextStart: null,
    used: 0,
    throttled: 0,
  };
}

function polyLimiterStopped(gate) {
  if (gate.throttled >= gate.maxThrottles) return true;
  if (gate.used >= gate.maxBooks) return true;
  if (gate.started != null && gate.nowFn() - gate.started > gate.budgetMs) return true;
  return false;
}

// Paced Polymarket US book fetch (see POLY_BOOK_* above). Honors Retry-After,
// stops at the first 429 and at the time budget.
async function loadPolymarketNoLadders(slugs, deps) {
  const fetchFn = (deps && deps.fetchFn) || fetch;
  const base = (deps && deps.polymarketBase) || POLY_GATEWAY;
  const sleepFn = (deps && deps.sleepFn) || sleep;
  const gate = (deps && deps.polyLimiter) || createPolyBookLimiter({
    nowFn: deps && deps.nowFn,
    gapMs: deps && deps.polyGapMs,
    budgetMs: deps && deps.polyBudgetMs,
    maxBooks: deps && deps.maxPolyBooks,
  });
  const nowFn = gate.nowFn;
  const list = [...new Set((slugs || []).filter(Boolean))];
  const out = new Map();
  if (gate.started == null) gate.started = nowFn();
  if (gate.nextStart == null) gate.nextStart = gate.started;
  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      if (polyLimiterStopped(gate)) return;
      const slug = list[cursor];
      cursor += 1;
      gate.used += 1;
      const wait = gate.nextStart - nowFn();
      gate.nextStart = Math.max(nowFn(), gate.nextStart) + gate.gapMs;
      if (wait > 0) await sleepFn(wait);
      if (gate.throttled >= gate.maxThrottles) return; // the other job hit a 429 while we waited
      let res;
      try {
        res = await fetchFn(`${base}/v1/markets/${encodeURIComponent(slug)}/book`, { headers: { accept: 'application/json' } });
      } catch (_) {
        continue;
      }
      const status = res && res.status ? res.status : 0;
      if (status === 429) {
        gate.throttled += 1;
        const retry = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : NaN);
        const pause = Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 5000) : 1000;
        gate.nextStart = Math.max(gate.nextStart, nowFn() + pause);
        if (gate.throttled >= gate.maxThrottles) { cursor = list.length; return; } // do not hammer a throttled IP
        continue;
      }
      if (status < 200 || status >= 300) continue;
      const body = await readBody(res);
      if (body) out.set(slug, noLevelsFromPolymarketBook(body));
    }
  }
  await Promise.all(Array.from({ length: Math.min(POLY_BOOK_CONCURRENCY, list.length) }, () => worker()));
  return out;
}

// Attach noLevels (full No ask ladder) and noSize (top level) to the given
// Kalshi / Polymarket quotes, in place. Callers pass only the quotes Promo
// can use (players with a sportsbook offer in a game inside the window).
// Underdog stays top-of-book. Best-effort: a failed venue keeps whatever
// top-of-book size the quote already had.
async function attachNoLadders(quotes, deps) {
  const list = (quotes || []).filter((q) => q && q.noAmerican != null);
  const kalshi = list.filter((q) => q.book === 'kalshi' && q.ticker);
  // Polymarket books are rate-limited: skip closed markets and fetch the
  // ones whose top No is closest to the best No for that player first.
  const bestNo = new Map();
  for (const q of list) {
    const key = `${q.gameKey}|${q.market}|${String(q.player || '').toLowerCase()}`;
    if (!bestNo.has(key) || q.noAmerican > bestNo.get(key)) bestNo.set(key, q.noAmerican);
  }
  const gap = (q) => {
    const best = bestNo.get(`${q.gameKey}|${q.market}|${String(q.player || '').toLowerCase()}`);
    const a = impliedFromAmerican(q.noAmerican);
    const b = impliedFromAmerican(best);
    return a == null || b == null ? 1 : Math.abs(a - b);
  };
  const poly = list
    .filter((q) => q.book === 'polymarket' && q.slug && !q.closed)
    .sort((a, b) => gap(a) - gap(b));
  const [kBooks, pBooks] = await Promise.all([
    kalshi.length ? loadKalshiNoLadders(kalshi.map((q) => q.ticker), deps).catch(() => new Map()) : new Map(),
    poly.length ? loadPolymarketNoLadders(poly.map((q) => q.slug), deps).catch(() => new Map()) : new Map(),
  ]);
  let attached = 0;
  let emptied = 0;
  for (const q of kalshi) {
    const levels = kBooks.get(q.ticker);
    if (levels && levels.length) { q.noLevels = levels; q.noSize = levels[0].size; attached += 1; }
    else if (levels && deps && deps.dropEmptyKalshi) {
      // Orderbook fetched and there are no Yes bids: no No to buy. MLB HR
      // uses this for scratched players whose book was pulled.
      q.noAmerican = null; q.noLevels = null; q.noSize = null; emptied += 1;
    }
  }
  for (const q of poly) {
    const levels = pBooks.get(q.slug);
    if (levels && levels.length) { q.noLevels = levels; q.noSize = levels[0].size; attached += 1; }
  }
  const stats = { kalshi: kalshi.length, polymarket: poly.length, kalshiBooks: kBooks.size, polymarketBooks: pBooks.size, attached };
  if (deps && deps.dropEmptyKalshi) stats.kalshiEmpty = emptied;
  return stats;
}

function underdogConfig(env) {
  const e = env || {};
  return {
    base: String(e.UNDERDOG_API_BASE || UNDERDOG_BASE).replace(/\/$/, ''),
    clientVersion: String(e.UNDERDOG_CLIENT_VERSION || UNDERDOG_CLIENT_VERSION).trim() || UNDERDOG_CLIENT_VERSION,
    product: String(e.UNDERDOG_PRODUCT || UNDERDOG_PRODUCT).trim() || UNDERDOG_PRODUCT,
    stateConfigId: String(e.UNDERDOG_STATE_CONFIG_ID || UNDERDOG_STATE_CONFIG_ID).trim() || UNDERDOG_STATE_CONFIG_ID,
    productExperienceId: String(e.UNDERDOG_PRODUCT_EXPERIENCE_ID || UNDERDOG_PRODUCT_EXPERIENCE_ID).trim() || UNDERDOG_PRODUCT_EXPERIENCE_ID,
    filterId: String(e.UNDERDOG_TD_FILTER_ID || UNDERDOG_TD_FILTER_ID).trim() || UNDERDOG_TD_FILTER_ID,
  };
}

function underdogLinesUrl(cfg) {
  const params = new URLSearchParams({
    filter_id: cfg.filterId,
    filter_type: 'PickemStat',
    include_live: 'true',
    product: cfg.product,
    product_experience_id: cfg.productExperienceId,
    show_mass_option_markets: 'false',
    sport_id: 'NFL',
    state_config_id: cfg.stateConfigId,
  });
  return `${cfg.base}/v1/lobbies/content/lines?${params}`;
}

function indexById(node) {
  const map = new Map();
  for (const item of valuesOf(node)) {
    if (item && item.id != null) map.set(String(item.id), item);
  }
  return map;
}

function quotesFromUnderdogTd(body, { now = Date.now(), omitAfterMs = UNDERDOG_BOARD_OMIT_MS } = {}) {
  if (!body) return [];
  const games = indexById(body.games);
  const appearances = indexById(body.appearances);
  const teams = indexById(body.teams);
  const out = [];
  for (const line of valuesOf(body.over_under_lines)) {
    const overUnder = line && line.over_under;
    const stat = overUnder && overUnder.appearance_stat;
    const display = `${(stat && stat.display_stat) || ''} ${(stat && stat.stat) || ''}`.toLowerCase();
    // Underdog has no separate anytime market. Rush + Rec TDs 0.5 is that price.
    if (!/rush\s*\+\s*rec/.test(display) && String(stat && stat.stat || '') !== 'rush_rec_tds') continue;
    const tdMarket = thresholdFromLine(line.stat_value, '');
    if (!tdMarket || tdMarket === 'three') continue;
    const appearance = appearances.get(String(stat && stat.appearance_id || ''));
    const game = games.get(String(appearance && appearance.match_id || ''));
    let higher = null;
    let lower = null;
    let player = '';
    let eventTicker = '';
    let updatedAt = line.updated_at || null;
    for (const opt of (line && line.options) || []) {
      if (!opt) continue;
      const choice = String(opt.choice || '').toLowerCase();
      const american = parseAmerican(opt.odds && opt.odds.prediction && opt.odds.prediction.american);
      if (!player) player = opt.selection_header || '';
      if (opt.event_ticker) eventTicker = opt.event_ticker;
      if (choice === 'higher' || choice === 'over' || choice === 'yes') {
        higher = { american, updatedAt: opt.updated_at || updatedAt };
      } else if (choice === 'lower' || choice === 'under' || choice === 'no') {
        lower = { american, updatedAt: opt.updated_at || updatedAt };
      }
    }
    if (!player || !higher || higher.american == null) continue;
    if (omitAfterMs != null && quoteIsOlderThan(higher.updatedAt, now, omitAfterMs)) continue;
    // event_ticker is the game (KXNFLTD-26SEP27NYJDET). A synthetic -1
    // suffix lets the game-token parser read the clubs and the date.
    const teamsParsed = eventTicker ? parseKalshiTdTicker(`${eventTicker}-PLAYER-1`) : null;
    if (!teamsParsed) continue;
    const title = game && (game.full_team_names_title || game.title || '');
    const split = String(title || '').split(/\s+@\s+/);
    const teamRow = teams.get(String(appearance && appearance.team_id || ''));
    const teamAbbr = teamRow && (teamRow.abbr || teamRow.abbreviation || '');
    out.push({
      book: 'underdog_predict',
      market: tdMarket,
      player,
      team: teamAbbr,
      away: teamsParsed.away,
      home: teamsParsed.home,
      awayName: split.length === 2 ? split[0].trim() : teamDisplayName(teamsParsed.away),
      homeName: split.length === 2 ? split[1].trim() : teamDisplayName(teamsParsed.home),
      gameKey: teamsParsed.gameKey,
      commence: (game && game.scheduled_at) || null,
      yesAmerican: higher.american,
      noAmerican: lower && lower.american != null && !(omitAfterMs != null && quoteIsOlderThan(lower.updatedAt, now, omitAfterMs))
        ? lower.american
        : null,
      updatedAt: higher.updatedAt,
    });
  }
  return out;
}

async function loadUnderdogTdQuotes(deps) {
  const fetchFn = (deps && deps.fetchFn) || fetch;
  const cfg = underdogConfig(deps && deps.env);
  const sleepFn = (deps && deps.sleepFn) || sleep;
  const res = await fetchJson(fetchFn, underdogLinesUrl(cfg), {
    sleepFn,
    attempts: 3,
    headers: {
      accept: 'application/json',
      'client-type': 'web',
      'client-version': cfg.clientVersion,
      'user-agent': 'aibetbuilder',
    },
  });
  if (!res.ok) return [];
  return quotesFromUnderdogTd(res.body, {
    now: (deps && deps.now) || Date.now(),
    omitAfterMs: deps && deps.omitAfterMs != null ? deps.omitAfterMs : UNDERDOG_BOARD_OMIT_MS,
  });
}

async function mapPool(items, limit, fn) {
  const list = items || [];
  const out = new Array(list.length);
  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(list[index], index);
    }
  }
  const workers = [];
  const n = Math.max(1, Math.min(limit, list.length));
  for (let i = 0; i < n; i += 1) workers.push(worker());
  await Promise.all(workers);
  return out;
}

async function loadPolymarketTdQuotes(gameKeys, deps) {
  const fetchFn = (deps && deps.fetchFn) || fetch;
  const base = (deps && deps.polymarketBase) || POLY_GATEWAY;
  const sleepFn = (deps && deps.sleepFn) || sleep;
  const maxGames = deps && deps.maxGames != null ? deps.maxGames : MAX_POLY_GAMES;
  const slugs = [];
  const seen = new Set();
  for (const key of gameKeys || []) {
    const slug = slugFromGameKey(key);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
    if (slugs.length >= maxGames) break;
  }
  const batches = await mapPool(slugs, POLY_CONCURRENCY, async (slug) => {
    const url = `${base}/v1/events/slug/${encodeURIComponent(slug)}`;
    const res = await fetchJson(fetchFn, url, { sleepFn, attempts: 2 });
    if (!res.ok || !res.body) return [];
    return quotesFromPolymarketEvent(res.body);
  });
  return batches.flat();
}

// ---- Novig ----------------------------------------------------------------
// Novig was never a source here (and the Odds API skips it), so Novig player
// TDs were invisible. Its public catalog quirks:
//  - /markets ignores eventId; filter by league + marketType instead.
//  - Pages are 5000 rows newest first with a `next` cursor. Follow it.
//  - Anytime / 2+ TD = TOUCHDOWNS strike 0.5 / 1.5 (Over = Yes, Under = No).
//    First TD = FIRST_TOUCHDOWN_SCORER (Yes / No).
//  - Player name is the description minus " <strike> TOUCHDOWNS"
//    (keeps suffixes like "Jr."; samePlayerInGame handles the matching).
//  - Book: resting bids per outcomeId. Buy Yes = 1 - best No bid, buy No =
//    1 - best Yes bid. qty pays 1 cent, so $1 contracts = qty / 100.
//  - Book reads are rate limited (429) per IP: 2 at a time, retry with backoff.
//  - Fee is charged only once the game is live (fee.charged WHEN_LIVE).
const NOVIG_TD_TYPES = ['TOUCHDOWNS', 'FIRST_TOUCHDOWN_SCORER'];
const NOVIG_MAX_PAGES = 8;
const NOVIG_CONCURRENCY = 2;
// Book reads stop after this budget so a full Sunday slate cannot eat the
// 60s function. Anytime first, then 1st TD, then 2+, nearest kickoff first.
const NOVIG_BUDGET_MS = 25 * 1000;
const NOVIG_MARKET_ORDER = { anytime: 0, first: 1, two: 2 };

async function novigPaged(fetchFn, base, path, sleepFn) {
  const items = [];
  let after = '';
  for (let page = 0; page < NOVIG_MAX_PAGES; page += 1) {
    const res = await fetchJson(fetchFn, `${base}${path}${after}`, { sleepFn, attempts: 3 });
    if (!res.ok || !res.body) break;
    for (const it of res.body.items || []) items.push(it);
    if (!res.body.next) break;
    after = `&after=${encodeURIComponent(res.body.next)}`;
  }
  return items;
}

function easternDateOf(ms) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch (_) {
    return '';
  }
}

function novigGameFromEvent(ev) {
  const parts = String((ev && ev.description) || '').split(/\s+@\s+/);
  if (parts.length !== 2) return null;
  const away = nflAbbrFromName(parts[0]);
  const home = nflAbbrFromName(parts[1]);
  const startsTs = Number(ev.startsTs);
  if (!away || !home || !Number.isFinite(startsTs)) return null;
  return { away, home, awayName: parts[0].trim(), homeName: parts[1].trim(), startsTs, gameKey: gameKeyOf(away, home, easternDateOf(startsTs)) };
}

// One catalog row -> { market, player, yesOutcomeId, noOutcomeId } or null.
function novigTdMarketInfo(m) {
  if (!m || String(m.status || 'OPEN').toUpperCase() !== 'OPEN') return null;
  const type = String(m.marketType || '').toUpperCase();
  const outs = m.outcomes || [];
  const find = (re) => (outs.find((o) => o && re.test(String(o.name || ''))) || {}).outcomeId;
  if (type === 'TOUCHDOWNS') {
    const market = Number(m.strike) === 0.5 ? 'anytime' : Number(m.strike) === 1.5 ? 'two' : null;
    if (!market) return null;
    const player = String(m.description || '').replace(/\s+[\d.]+\s+TOUCHDOWNS\s*$/i, '').trim();
    const yes = find(/^over/i);
    const no = find(/^under/i);
    return player && yes && no ? { market, player, yesOutcomeId: yes, noOutcomeId: no } : null;
  }
  if (type === 'FIRST_TOUCHDOWN_SCORER') {
    const player = String(m.description || '').replace(/\s+FIRST_TOUCHDOWN_SCORER\s*$/i, '').trim();
    const yes = find(/^yes$/i);
    const no = find(/^no$/i);
    return player && yes && no ? { market: 'first', player, yesOutcomeId: yes, noOutcomeId: no } : null;
  }
  return null;
}

function novigBestBid(book, outcomeId) {
  let best = null;
  for (const o of (book && book.orders && book.orders[outcomeId]) || []) {
    const p = Number(o && o.price);
    const q = Number(o && o.qty);
    if (!(p > 0 && p < 1) || !(q > 0)) continue;
    if (!best || p > best.p) best = { p, qty: q };
    else if (p === best.p) best.qty += q;
  }
  return best;
}

function novigNoLevels(book, outcomeId, fee, maxLevels = NO_LADDER_LEVELS) {
  const levels = [];
  for (const o of (book && book.orders && book.orders[outcomeId]) || []) {
    const lvl = noLevel(Number(o && o.price), Number(o && o.qty) / 100, fee);
    if (lvl) levels.push(lvl);
  }
  return finishNoLevels(levels, maxLevels);
}

function novigQuoteFromBook(info, game, market, book, nowMs) {
  const live = nowMs >= game.startsTs;
  const coef = Number(market && market.fee && market.fee.coefficient);
  const fee = live && Number.isFinite(coef) ? coef : 0;
  const yesBid = novigBestBid(book, info.yesOutcomeId);
  const noBid = novigBestBid(book, info.noOutcomeId);
  if (!noBid) return null; // no one selling Yes
  const noLevels = yesBid ? novigNoLevels(book, info.yesOutcomeId, fee) : [];
  return {
    book: 'novig',
    market: info.market,
    player: info.player,
    team: '',
    away: game.away,
    home: game.home,
    awayName: game.awayName,
    homeName: game.homeName,
    gameKey: game.gameKey,
    commence: new Date(game.startsTs).toISOString(),
    yesAmerican: boardYesAmerican(1 - noBid.p, fee),
    noAmerican: noLevels.length ? noLevels[0].american : null,
    noSize: noLevels.length ? noLevels[0].size : null,
    noLevels: noLevels.length ? noLevels : null,
    updatedAt: new Date(nowMs).toISOString(),
    marketId: market.marketId,
  };
}

// gameKeys: only price games in this set (null = every NFL game on Novig).
async function loadNovigTdQuotes(gameKeys, deps) {
  const fetchFn = (deps && deps.fetchFn) || fetch;
  const base = (deps && deps.novigBase) || NOVIG_BASE;
  const sleepFn = (deps && deps.sleepFn) || sleep;
  const now = (deps && deps.now) || Date.now();
  const wanted = gameKeys ? new Set(gameKeys) : null;
  const [events, markets] = await Promise.all([
    novigPaged(fetchFn, base, '/v3/public/catalog/events?league=NFL&limit=100', sleepFn),
    novigPaged(fetchFn, base, `/v3/public/catalog/markets?league=NFL&marketType=${NOVIG_TD_TYPES.join(',')}&limit=5000`, sleepFn),
  ]);
  const games = new Map();
  for (const ev of events) {
    const game = novigGameFromEvent(ev);
    if (game && (!wanted || wanted.has(game.gameKey))) games.set(String(ev.eventId), game);
  }
  const jobs = [];
  for (const m of markets) {
    const game = games.get(String(m && m.eventId));
    const info = game && novigTdMarketInfo(m);
    if (info) jobs.push({ m, game, info });
  }
  jobs.sort((a, b) => (NOVIG_MARKET_ORDER[a.info.market] - NOVIG_MARKET_ORDER[b.info.market]) || (a.game.startsTs - b.game.startsTs));
  const budget = deps && deps.novigBudgetMs != null ? deps.novigBudgetMs : NOVIG_BUDGET_MS;
  const deadline = Date.now() + budget;
  const out = await mapPool(jobs, NOVIG_CONCURRENCY, async ({ m, game, info }) => {
    if (Date.now() > deadline) return null;
    const res = await fetchJson(fetchFn, `${base}/v3/public/catalog/markets/${encodeURIComponent(m.marketId)}/book`, { sleepFn, attempts: 6 });
    if (!res.ok || !res.body) return null;
    return novigQuoteFromBook(info, game, m, res.body, now);
  });
  return out.filter(Boolean);
}

async function loadExchangeTdQuotes(deps) {
  const now = (deps && deps.now) || Date.now();
  const [kalshi, underdog] = await Promise.all([
    loadKalshiTdQuotes(deps).catch(() => []),
    loadUnderdogTdQuotes({ ...deps, now }).catch(() => []),
  ]);
  const near = selectPlayerTdQuotes([...kalshi, ...underdog], now);
  const keys = new Set();
  for (const quote of near) {
    if (quote && quote.gameKey) keys.add(quote.gameKey);
  }
  const [polymarket, novig] = await Promise.all([
    loadPolymarketTdQuotes([...keys], deps).catch(() => []),
    loadNovigTdQuotes([...keys], deps).catch(() => []),
  ]);
  const selected = selectPlayerTdQuotes(
    [...near, ...polymarket, ...novig].filter((quote) => quote && quote.yesAmerican != null),
    now,
  );
  return selected;
}

async function loadPlayerTdBoard(deps) {
  const now = (deps && deps.now) || Date.now();
  const ttl = deps && deps.cacheMs != null ? deps.cacheMs : BOARD_CACHE_MS;
  const cache = (deps && deps.cache) || boardCache;
  if (cache.body && ttl > 0 && now - cache.at < ttl) {
    return { ...cache.body, cached: true };
  }
  const quotes = await loadExchangeTdQuotes({ ...deps, now });
  const body = {
    ok: true,
    league: 'NFL',
    fetchedAt: new Date(now).toISOString(),
    games: boardFromQuotes(quotes),
    quotes,
  };
  cache.at = now;
  cache.body = body;
  return { ...body, cached: false };
}

function resetPlayerTdBoardCache() {
  boardCache.at = 0;
  boardCache.body = null;
}

module.exports = {
  KALSHI_REST,
  POLY_GATEWAY,
  UNDERDOG_CLIENT_VERSION,
  fetchJson,
  readBody,
  sleep,
  valuesOf,
  indexById,
  mapPool,
  polyProb,
  noLevel,
  createPolyBookLimiter,
  KALSHI_SERIES,
  kalshiSeriesForMarkets,
  UNDERDOG_TD_FILTER_ID,
  BOARD_CACHE_MS,
  underdogLinesUrl,
  underdogConfig,
  quotesFromKalshiMarkets,
  quotesFromPolymarketEvent,
  quotesFromUnderdogTd,
  noStakeDollars,
  noLevelsFromKalshiOrderbook,
  noLevelsFromPolymarketBook,
  loadKalshiNoLadders,
  loadPolymarketNoLadders,
  attachNoLadders,
  loadKalshiTdQuotes,
  loadUnderdogTdQuotes,
  loadPolymarketTdQuotes,
  loadNovigTdQuotes,
  novigTdMarketInfo,
  novigQuoteFromBook,
  loadExchangeTdQuotes,
  loadPlayerTdBoard,
  resetPlayerTdBoardCache,
};
