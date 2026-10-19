// VENDORED verbatim from aibetbuilder origin/main 768ea81 lib/book-depth.js. Do not edit here; re-vendor instead.
'use strict';

// On-demand prediction-market depth for Promo true-odds lines.
// The Odds API includeBetLimits is top-of-book only (one bet_limit / outcome) —
// there is no depth parameter. Cron must not deep-fetch every game.
//
// Real books today:
//   kalshi     — public GET /markets/{ticker}/orderbook?depth=N (keyless)
//   polymarket — public CLOB GET /book?token_id= (keyless)
//   prophetx   — affiliate get_markets (needs PROPHETX_API_KEY or access/secret)
//   novig      — public v3 GET /v3/public/catalog/markets/{id}/book (keyless)
//
// Display only. No orders.
// Promo blend (src/blendAskLadder.js): 1-leg and multi-leg walk to $500 profit
// (win excluding stake). Size on levels is dollar stake.

// Same taker-fee / commission math as lib/odds-shared.js (kept local so this
// module does not pull the Supabase client into the on-demand depth path).
const KALSHI_FEE_COEFF = 0.07;
const POLYMARKET_FEE_COEFF = require('./polymarket-us-fee.json').takerFeeCoefficient;
const PROPHETX_COMMISSION_RATE = 0.02;

function applyTakerFee(rawAmericanOdds, theta) {
  if (rawAmericanOdds === null || rawAmericanOdds === undefined) return rawAmericanOdds;
  let p;
  if (rawAmericanOdds > 0) p = 100 / (rawAmericanOdds + 100);
  else p = Math.abs(rawAmericanOdds) / (Math.abs(rawAmericanOdds) + 100);
  if (p <= 0 || p >= 1) return rawAmericanOdds;
  const effPrice = p * (1 + theta * (1 - p));
  const decimalOdds = 1 / effPrice;
  if (decimalOdds <= 1) return rawAmericanOdds;
  if (decimalOdds >= 2) return Math.round((decimalOdds - 1) * 100);
  return -Math.round(100 / (decimalOdds - 1));
}

function applyKalshiFee(raw) { return applyTakerFee(raw, KALSHI_FEE_COEFF); }
function applyPolymarketFee(raw) { return applyTakerFee(raw, POLYMARKET_FEE_COEFF); }
function applyProphetXCommission(rawAmericanOdds) {
  if (rawAmericanOdds === null || rawAmericanOdds === undefined) return rawAmericanOdds;
  const rawDecimal = rawAmericanOdds > 0 ? 1 + rawAmericanOdds / 100 : 1 + 100 / Math.abs(rawAmericanOdds);
  const effectiveDecimal = 1 + (rawDecimal - 1) * (1 - PROPHETX_COMMISSION_RATE);
  if (effectiveDecimal <= 1) return rawAmericanOdds;
  if (effectiveDecimal >= 2) return Math.round((effectiveDecimal - 1) * 100);
  return -Math.round(100 / (effectiveDecimal - 1));
}

const playerTd = require('./player-td.cjs');
const { noLevelsFromPolymarketBook } = require('./player-td-feeds');
const POLY_US_GATEWAY = 'https://gateway.polymarket.us';
const DEPTH_VENUES = new Set(['kalshi', 'polymarket', 'prophetx', 'novig']);
const MAX_LEGS = 8;
const FETCH_MS = 10000;
const CATALOG_TTL_MS = 60 * 1000;
const KALSHI_BASE = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
const POLY_GAMMA = 'https://gamma-api.polymarket.com';
const POLY_CLOB = 'https://clob.polymarket.com';
const PROPHETX_BASE = process.env.PROPHETX_API_BASE || 'https://cash.api.prophetx.co/partner';
const NOVIG_BASE = (process.env.NOVIG_API_BASE || 'https://api.novig.com').replace(/\/+$/, '');

const KALSHI_SERIES = {
  baseball_mlb: { ML: 'KXMLBGAME', SPR: 'KXMLBSPREAD', TOT: 'KXMLBTOTAL' },
  americanfootball_nfl: { ML: 'KXNFLGAME', SPR: 'KXNFLSPREAD', TOT: 'KXNFLTOTAL' },
  americanfootball_ncaaf: { ML: 'KXNCAAFGAME', SPR: 'KXNCAAFSPREAD', TOT: 'KXNCAAFTOTAL' },
  soccer_epl: { ML: 'KXEPLGAME' },
  soccer_usa_mls: { ML: 'KXMLSGAME' },
  mma_mixed_martial_arts: { ML: 'KXUFCFIGHT' },
};

const STOP = new Set([
  'the', 'and', 'vs', 'versus', 'at', 'over', 'under', 'total', 'points', 'scored',
  'game', 'wins', 'win', 'will', 'winner', 'by', 'st', 'state', 'university', 'univ',
]);

// Shared across soccer clubs — must not identify a team by themselves.
// Kept out of STOP so they can still break ties (United vs City).
const GENERIC_TEAM_TOKENS = new Set([
  'united', 'city', 'fc', 'cf', 'sc', 'club', 'athletic', 'sporting',
  'real', 'hotspur', 'hotspurs', 'town', 'county', 'rovers', 'wanderers',
  'albion', 'afc', 'cfc',
]);

// City/region words shared by several franchises (New York Giants/Jets,
// New Orleans, LA Rams/Chargers, San Francisco/San Diego, Tampa Bay/Green Bay).
// A partial match on these alone is not a team identity: "New Orleans
// Saints" must never match "New York Giants" on the word "new".
const SHARED_PLACE_TOKENS = new Set([
  'new', 'york', 'ny', 'los', 'angeles', 'la', 'san', 'santa', 'saint', 'las',
  'bay', 'north', 'south', 'east', 'west', 'northern', 'southern', 'eastern',
  'western', 'central',
]);
const MAX_EVENT_START_GAP_MS = 36 * 60 * 60 * 1000;

const catalogCache = new Map();

function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = FETCH_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, {
    method,
    headers: { accept: 'application/json', 'user-agent': 'aibetbuilder/1.0 (+https://aibetbuilder.io)', ...headers },
    body,
    signal: ctrl.signal,
  }).then(async (r) => {
    const text = await r.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch (_) { json = null; }
    }
    return { ok: r.ok, status: r.status, json, text };
  }).catch((e) => ({ ok: false, status: 0, json: null, text: String(e && e.message || e) }))
    .finally(() => clearTimeout(t));
}

// One in-flight load per key: 8 legs on the same league share a catalog
// read instead of each paging Novig/Kalshi (that burst drew 429s).
const catalogInflight = new Map();
function cached(key, loader) {
  const hit = catalogCache.get(key);
  if (hit && (Date.now() - hit.at) < CATALOG_TTL_MS) return Promise.resolve(hit.data);
  if (catalogInflight.has(key)) return catalogInflight.get(key);
  const p = Promise.resolve().then(loader).then((data) => {
    catalogCache.set(key, { at: Date.now(), data });
    return data;
  }).finally(() => catalogInflight.delete(key));
  catalogInflight.set(key, p);
  return p;
}

function nameTokens(s) {
  const raw = String(s || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // "D.C. United" → dc + united (single letters after punctuation strip).
  const merged = [];
  let buf = '';
  for (const w of raw) {
    if (w.length === 1) {
      buf += w;
      continue;
    }
    if (buf.length >= 2) merged.push(buf);
    buf = '';
    merged.push(w);
  }
  if (buf.length >= 2) merged.push(buf);
  return merged.filter((w) => w.length >= 2 && !STOP.has(w));
}

function teamsFromGame(game) {
  const parts = String(game || '').split(/\s+@\s+|\s+vs\.?\s+/i);
  if (parts.length >= 2) return { away: parts[0].trim(), home: parts[1].trim() };
  return { away: '', home: '' };
}

function distinctiveTokens(tokens) {
  return (tokens || []).filter((t) => !GENERIC_TEAM_TOKENS.has(t));
}

function countTokenHits(hayTokens, needleTokens) {
  let n = 0;
  const used = new Set();
  for (const needle of needleTokens || []) {
    const i = (hayTokens || []).findIndex((h, idx) => !used.has(idx) && h === needle);
    if (i >= 0) {
      used.add(i);
      n += 1;
    }
  }
  return n;
}

// Distinctive overlap is required when the needle has any. Generic tokens
// (united/city/fc/…) only add tie-break weight — never a first-hit identity.
function scoreTokenSets(hayTokens, needleTokens) {
  if (!needleTokens || !needleTokens.length) return 0;
  const hayD = distinctiveTokens(hayTokens);
  const needleD = distinctiveTokens(needleTokens);
  const hayG = (hayTokens || []).filter((t) => GENERIC_TEAM_TOKENS.has(t));
  const needleG = needleTokens.filter((t) => GENERIC_TEAM_TOKENS.has(t));
  const dHits = countTokenHits(hayD, needleD);
  const gHits = countTokenHits(hayG, needleG);
  if (needleD.length) {
    if (dHits === 0) return 0;
    // Partial match must hit a team-specific word, not only a shared
    // city/region word ("new", "los", "san"…). Full matches always count.
    if (dHits < needleD.length) {
      const own = needleD.filter((t) => !SHARED_PLACE_TOKENS.has(t));
      if (!own.length || countTokenHits(hayD, own) === 0) return 0;
    }
    return (dHits === needleD.length ? 1000 : 0) + dHits * 100 + gHits;
  }
  return gHits;
}

function tokensHit(hayTokens, needleTokens) {
  return scoreTokenSets(hayTokens, needleTokens) > 0;
}

function teamMatchScore(label, wantName) {
  return scoreTokenSets(nameTokens(label), nameTokens(wantName));
}

function pickBestTeamMatch(wantName, items, labelOf) {
  if (!items || !items.length) return null;
  const getLabel = typeof labelOf === 'function' ? labelOf : (x) => x;
  let bestScore = 0;
  const best = [];
  for (const item of items) {
    const score = teamMatchScore(getLabel(item), wantName);
    if (score > bestScore) {
      bestScore = score;
      best.length = 0;
      best.push(item);
    } else if (score > 0 && score === bestScore) {
      best.push(item);
    }
  }
  return best.length === 1 ? best[0] : null;
}

function isDrawLabel(lab) {
  return /\b(draw|tie)\b/i.test(String(lab || ''));
}

function eventMatchesTeams(title, away, home) {
  const t = nameTokens(title);
  return tokensHit(t, nameTokens(away)) && tokensHit(t, nameTokens(home));
}

// Several events can name the same team (NYG @ HOU next week, NO @ NYG this
// week). Pick the one whose start is closest to the leg's commence_time and
// within MAX_EVENT_START_GAP_MS. No commence_time → only a unique match.
function pickEventByStart(events, commenceTime, startOf) {
  const list = events || [];
  if (!list.length) return null;
  const want = commenceTime ? Date.parse(commenceTime) : NaN;
  if (!isFinite(want)) return list.length === 1 ? list[0] : null;
  let best = null;
  let bestGap = Infinity;
  for (const e of list) {
    const raw = startOf(e);
    const t = typeof raw === 'number' ? raw : Date.parse(raw);
    if (!isFinite(t)) continue;
    const gap = Math.abs(t - want);
    if (gap < bestGap) { bestGap = gap; best = e; }
  }
  return best && bestGap <= MAX_EVENT_START_GAP_MS ? best : null;
}

function lineEqual(a, b) {
  if (a == null || b == null || !isFinite(Number(a)) || !isFinite(Number(b))) return false;
  return Math.abs(Number(a) - Number(b)) < 1e-9;
}

function probToAmerican(p) {
  if (p == null || !isFinite(p) || p <= 0 || p >= 1) return null;
  if (p >= 0.5) return -Math.round((100 * p) / (1 - p));
  return Math.round((100 * (1 - p)) / p);
}

function decimalToAmerican(d) {
  if (d == null || !isFinite(d) || d <= 1) return null;
  if (d >= 2) return Math.round((d - 1) * 100);
  return -Math.round(100 / (d - 1));
}

function applyVenueFee(venue, american) {
  if (american == null) return null;
  if (venue === 'kalshi') return applyKalshiFee(american);
  if (venue === 'prophetx') return applyProphetXCommission(american);
  if (venue === 'polymarket') return applyPolymarketFee(american);
  return american;
}

function parseOppSelection(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const venue = String(leg.bestOppBook || leg.venue || '').toLowerCase();
  if (!DEPTH_VENUES.has(venue)) return null;
  const market = String(leg.market || '').toUpperCase();
  const label = String(leg.bestOppName || '');
  const game = String(leg.game || '');
  const { away, home } = teamsFromGame(game);
  const sport = String(leg.sport || '');
  const base = { venue, market, sport, game, away, home, commence_time: leg.commence_time || null };

  // Player props (NFL TD, MLB HR, NHL goal): Polymarket US only. The props
  // cron fetches only a few Polymarket books per run (rate limit), so most
  // cards had no ladder and showed LOW LIQUIDITY with no size.
  if ((market === 'GOAL' || market === 'HR' || market === 'TD') && venue === 'polymarket') {
    const m = /^(.*?)\s+No\s+(.+)$/i.exec(label);
    if (!m) return null;
    const threshold = /^2\+/.test(m[2].trim()) ? 2 : (/^1\+/.test(m[2].trim()) ? 1 : null);
    if (threshold == null) return null;
    return { ...base, side: 'player', player: m[1].trim(), threshold, buySide: 'no' };
  }
  if (market === 'TOT' || market === 'TT') {
    const m = /(?:^|[\s/])([ou])\s*([+-]?\d+(?:\.\d+)?)\s*$/i.exec(label)
      || /\b([ou])(\d+(?:\.\d+)?)\b/i.exec(label);
    const ou = m ? m[1].toLowerCase() : null;
    const line = m ? parseFloat(m[2]) : NaN;
    let team = null;
    if (market === 'TT') {
      team = label.replace(/\s*TT\s*[ou].*$/i, '').replace(/\s*[ou]\s*[\d.]+.*$/i, '').trim();
    }
    if (!ou || !isFinite(line)) return null;
    return { ...base, side: ou === 'o' ? 'over' : 'under', line, team };
  }
  if (market === 'ML') {
    let buySide = 'yes';
    let team = label.replace(/\s*ML\s*$/i, '').trim();
    if (/\bno\s*$/i.test(team)) {
      buySide = 'no';
      team = team.replace(/\bno\s*$/i, '').replace(/\s*ML\s*$/i, '').trim();
    }
    if (/\bdraw\s*$/i.test(team) || /^draw$/i.test(team)) team = 'Draw';
    if (!team) return null;
    return { ...base, side: 'ml', line: null, team, buySide };
  }
  if (market === 'SPR') {
    const m = /([+-]?\d+(?:\.\d+)?)\s*$/.exec(label);
    const line = m ? parseFloat(m[1]) : NaN;
    const team = label.replace(/\s*[+-]?\d+(?:\.\d+)?\s*$/, '').trim();
    if (!team || !isFinite(line)) return null;
    return { ...base, side: 'spread', line, team };
  }
  return null;
}

function sortAsksBestFirst(levels, venue) {
  const byPrice = new Map();
  for (const raw of levels || []) {
    const american = applyVenueFee(venue, raw.american);
    const size = raw.size;
    if (american == null || !isFinite(size) || size <= 0) continue;
    const prev = byPrice.get(american);
    byPrice.set(american, (prev || 0) + size);
  }
  return [...byPrice.entries()]
    .map(([american, size]) => ({ american, size }))
    .sort((a, b) => b.american - a.american);
}

// Kalshi: bids only. Buying YES takes NO bids as YES asks (ask = 1 − no_bid).
// Buying NO takes YES bids as NO asks (ask = 1 − yes_bid).
function kalshiAsksFromOrderbook(orderbookFp, buySide) {
  const fp = orderbookFp || {};
  const bids = buySide === 'yes' ? (fp.no_dollars || []) : (fp.yes_dollars || []);
  const out = [];
  for (const row of bids) {
    const bidPx = parseFloat(Array.isArray(row) ? row[0] : row && row.price);
    const qty = parseFloat(Array.isArray(row) ? row[1] : row && (row.size || row.count));
    if (!isFinite(bidPx) || bidPx <= 0 || bidPx >= 1 || !isFinite(qty) || qty <= 0) continue;
    const askPx = 1 - bidPx;
    const american = probToAmerican(askPx);
    if (american == null) continue;
    // size = dollar STAKE (price × contracts). Blend profit = size × (1 − askPx) / askPx.
    out.push({ american, size: askPx * qty });
  }
  return out;
}

async function fetchKalshiSeriesEvents(seriesTicker) {
  return cached(`kalshi:${seriesTicker}`, async () => {
    const events = [];
    let cursor = '';
    for (let page = 0; page < 6; page++) {
      const url = `${KALSHI_BASE}/events?series_ticker=${encodeURIComponent(seriesTicker)}`
        + `&status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await fetchJson(url);
      const batch = res.ok && res.json && res.json.events;
      if (Array.isArray(batch)) batch.forEach((e) => events.push(e));
      cursor = (res.json && res.json.cursor) || '';
      if (!cursor) break;
    }
    return events;
  });
}

// Fighters rematch, so a UFC Kalshi event must also be on the fight's date
// (ticker KXUFCFIGHT-26OCT17...; within 1 day of commence_time for UTC/ET skew).
const KALSHI_MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function kalshiEventDateOk(ev, sel) {
  if (!sel || sel.sport !== 'mma_mixed_martial_arts' || !sel.commence_time) return true;
  const m = /-(\d{2})([A-Z]{3})(\d{2})/.exec(String(ev.event_ticker || ''));
  if (!m || KALSHI_MONTHS[m[2]] == null) return false;
  const evMs = Date.UTC(2000 + Number(m[1]), KALSHI_MONTHS[m[2]], Number(m[3]));
  const startMs = Date.parse(sel.commence_time);
  if (!isFinite(startMs)) return false;
  return Math.abs(evMs - startMs) <= 1.5 * 24 * 60 * 60 * 1000;
}

function matchKalshiMarket(sel, events) {
  const titleHit = (ev) => eventMatchesTeams(`${ev.title || ''} ${ev.sub_title || ''} ${ev.event_ticker || ''}`, sel.away, sel.home)
    && kalshiEventDateOk(ev, sel);
  const ev = (events || []).find(titleHit);
  if (!ev) return null;
  const markets = ev.markets || [];
  if (sel.market === 'TOT') {
    for (const m of markets) {
      const lab = m.yes_sub_title || m.subtitle || m.title || '';
      const parsed = /over\s+([\d.]+)/i.exec(lab);
      if (!parsed || !lineEqual(parseFloat(parsed[1]), sel.line)) continue;
      return { ticker: m.ticker, buySide: sel.side === 'over' ? 'yes' : 'no' };
    }
    return null;
  }
  if (sel.market === 'ML') {
    const buySide = sel.buySide === 'no' ? 'no' : 'yes';
    const marketLabel = (m) => m.yes_sub_title || m.subtitle || m.title || '';
    if (/^draw$/i.test(sel.team)) {
      const drawM = markets.find((m) => isDrawLabel(marketLabel(m)));
      return drawM ? { ticker: drawM.ticker, buySide, market: drawM } : null;
    }
    const picked = pickBestTeamMatch(sel.team, markets, marketLabel);
    return picked ? { ticker: picked.ticker, buySide, market: picked } : null;
  }
  if (sel.market === 'SPR') {
    const wantTeam = nameTokens(sel.team);
    for (const m of markets) {
      const lab = m.yes_sub_title || m.subtitle || m.title || '';
      const parsed = /^(.*?)\s+wins by over\s+([\d.]+)/i.exec(lab);
      if (!parsed) continue;
      const favLine = -parseFloat(parsed[2]);
      const dogLine = parseFloat(parsed[2]);
      const favTokens = nameTokens(parsed[1]);
      if (tokensHit(favTokens, wantTeam) && lineEqual(sel.line, favLine)) {
        return { ticker: m.ticker, buySide: 'yes' };
      }
      if (!tokensHit(favTokens, wantTeam) && lineEqual(sel.line, dogLine)) {
        return { ticker: m.ticker, buySide: 'no' };
      }
    }
    return null;
  }
  return null;
}

function parseKalshiProb(dollarStr, centsInt) {
  if (dollarStr != null && dollarStr !== '') {
    const d = parseFloat(dollarStr);
    if (isFinite(d) && d > 0 && d < 1) return d;
  }
  if (centsInt != null && isFinite(Number(centsInt))) {
    const n = Number(centsInt);
    const d = n > 1 ? n / 100 : n;
    if (d > 0 && d < 1) return d;
  }
  return null;
}

// Nested Kalshi markets expose no_ask / yes_ask (top-of-book). Buying No matches
// Yes bids, so no size falls back to yes_bid_size_fp — same as fetch-futures.
function kalshiCatalogTop(market, buySide) {
  if (!market) return null;
  const p = buySide === 'no'
    ? parseKalshiProb(market.no_ask_dollars, market.no_ask)
    : parseKalshiProb(market.yes_ask_dollars, market.yes_ask);
  const american = applyVenueFee('kalshi', probToAmerican(p));
  if (american == null) return null;
  const sizeRaw = buySide === 'no'
    ? parseFloat(market.no_ask_size_fp != null ? market.no_ask_size_fp : market.yes_bid_size_fp)
    : parseFloat(market.yes_ask_size_fp);
  return { american, size: isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : null };
}

async function fetchKalshiDepth(sel) {
  const series = (KALSHI_SERIES[sel.sport] || {})[sel.market];
  if (!series) return { levels: [], reason: 'kalshi_series_unknown' };
  const events = await fetchKalshiSeriesEvents(series);
  const hit = matchKalshiMarket(sel, events);
  if (!hit) return { levels: [], reason: 'kalshi_unmatched' };
  const res = await fetchJson(`${KALSHI_BASE}/markets/${encodeURIComponent(hit.ticker)}/orderbook?depth=8`);
  const fp = res.ok && res.json && res.json.orderbook_fp;
  if (!fp) return { levels: [], reason: 'kalshi_orderbook_empty' };
  return { levels: sortAsksBestFirst(kalshiAsksFromOrderbook(fp, hit.buySide), 'kalshi'), reason: 'ok' };
}

function parseJsonField(v, fallback) {
  if (Array.isArray(v) || (v && typeof v === 'object')) return v;
  if (typeof v !== 'string') return fallback;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}

function polyMlYesLabel(market) {
  const git = String(market.groupItemTitle || '').trim();
  if (git) return git;
  const q = `${market.question || ''} ${market.title || ''}`;
  const will = /will\s+(.+?)\s+win/i.exec(q);
  if (will) return will[1].trim();
  return '';
}

function polyMarketMatches(sel, market) {
  const q = `${market.question || ''} ${market.groupItemTitle || ''} ${market.title || ''}`;
  const ql = q.toLowerCase();
  if (/1h|2h|1st half|2nd half|touchdown|quarter|half/.test(ql)) return false;
  if (sel.market === 'TT') {
    if (!/team total/.test(ql)) return false;
    if (sel.team && !tokensHit(nameTokens(q), nameTokens(sel.team))) return false;
    const m = /o\/u\s*([\d.]+)/i.exec(q);
    return m ? lineEqual(parseFloat(m[1]), sel.line) : false;
  }
  if (sel.market === 'TOT') {
    if (/team total/.test(ql)) return false;
    const m = /o\/u\s*([\d.]+)/i.exec(q);
    return m ? lineEqual(parseFloat(m[1]), sel.line) : false;
  }
  if (sel.market === 'SPR') {
    if (!/spread/i.test(ql)) return false;
    const named = /spread:\s*(.+?)\s*\(([+-]?\d+(?:\.\d+)?)\)/i.exec(q);
    if (!named) return false;
    const namedLine = parseFloat(named[2]);
    if (tokensHit(nameTokens(named[1]), nameTokens(sel.team)) && lineEqual(namedLine, sel.line)) return { tokenSide: 'yes' };
    if (!tokensHit(nameTokens(named[1]), nameTokens(sel.team)) && lineEqual(-namedLine, sel.line)) return { tokenSide: 'no' };
    return false;
  }
  if (sel.market === 'ML') {
    if (/spread|o\/u|total/.test(ql)) return false;
    const outcomes = parseJsonField(market.outcomes, []);
    const names = (outcomes || []).map((o) => String(o));
    const lower = names.map((n) => n.toLowerCase());
    const isBinaryYesNo = lower.includes('yes') && lower.includes('no');
    if (/^draw$/i.test(sel.team) && isDrawLabel(q)) {
      return isBinaryYesNo
        ? { tokenSide: sel.buySide === 'no' ? 'no' : 'yes', label: 'Draw' }
        : { outcomeName: names.find((n) => isDrawLabel(n)) || 'Draw' };
    }
    const yesLabel = polyMlYesLabel(market);
    if (isBinaryYesNo) {
      const label = yesLabel || names.find((n) => !/^(yes|no)$/i.test(n)) || '';
      if (!label || !teamMatchScore(label, sel.team)) return false;
      return { tokenSide: sel.buySide === 'no' ? 'no' : 'yes', label };
    }
    const picked = pickBestTeamMatch(sel.team, names, (n) => n);
    if (picked) return { outcomeName: picked, label: picked };
    return false;
  }
  return false;
}

function polyTokenFor(sel, market, match) {
  const outcomes = parseJsonField(market.outcomes, []);
  const tokens = parseJsonField(market.clobTokenIds, []);
  if (!Array.isArray(outcomes) || !Array.isArray(tokens)) return null;
  if (sel.market === 'TOT' || sel.market === 'TT') {
    const want = sel.side === 'over' ? 'over' : 'under';
    const i = outcomes.findIndex((o) => String(o).toLowerCase() === want);
    return i >= 0 ? tokens[i] : null;
  }
  if (match && match.tokenSide === 'yes') {
    const i = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
    return i >= 0 ? tokens[i] : tokens[0];
  }
  if (match && match.tokenSide === 'no') {
    const i = outcomes.findIndex((o) => String(o).toLowerCase() === 'no');
    return i >= 0 ? tokens[i] : tokens[1];
  }
  if (match && match.outcomeName) {
    const picked = pickBestTeamMatch(match.outcomeName, outcomes, (o) => o)
      || outcomes.find((o) => tokensHit(nameTokens(o), nameTokens(match.outcomeName)));
    const i = picked != null ? outcomes.indexOf(picked) : -1;
    return i >= 0 ? tokens[i] : null;
  }
  return null;
}

function polymarketAsksFromBook(book) {
  const out = [];
  for (const a of (book && book.asks) || []) {
    const p = parseFloat(a.price);
    const s = parseFloat(a.size);
    if (!isFinite(p) || p <= 0 || p >= 1 || !isFinite(s) || s <= 0) continue;
    const american = probToAmerican(p);
    if (american == null) continue;
    // size = dollar STAKE (price × shares). Blend profit = size × (1 − p) / p.
    out.push({ american, size: p * s });
  }
  return out;
}

function teamSearchPhrases(away, home) {
  const a = nameTokens(away);
  const h = nameTokens(home);
  const compact = (t) => (t.length >= 3 ? t.slice(0, 2) : t).join(' ');
  const first = (t) => t[0] || '';
  return [...new Set([
    `${compact(a)} ${compact(h)}`.trim(),
    `${first(a)} ${compact(h)}`.trim(),
    `${first(a)} ${first(h)}`.trim(),
    `${away} ${home}`.trim(),
  ])].filter(Boolean);
}

async function fetchPolymarketDepth(sel) {
  const phrases = teamSearchPhrases(sel.away, sel.home);
  if (!phrases.length && sel.game) phrases.push(sel.game);
  if (!phrases.length) return { levels: [], reason: 'polymarket_no_query' };
  let ev = null;
  for (const phrase of phrases) {
    const search = await fetchJson(`${POLY_GAMMA}/public-search?q=${encodeURIComponent(phrase)}`);
    const events = (search.ok && search.json && (search.json.events || search.json.data)) || [];
    ev = events.find((e) => eventMatchesTeams(`${e.title || ''} ${e.slug || ''}`, sel.away, sel.home));
    if (ev) break;
  }
  if (!ev) return { levels: [], reason: 'polymarket_unmatched_event' };
  let markets = ev.markets || [];
  if (!markets.length && ev.slug) {
    const full = await fetchJson(`${POLY_GAMMA}/events?slug=${encodeURIComponent(ev.slug)}`);
    const first = Array.isArray(full.json) ? full.json[0] : full.json;
    markets = (first && first.markets) || [];
  }
  let token = null;
  if (sel.market === 'ML' && !/^draw$/i.test(sel.team)) {
    const candidates = [];
    for (const m of markets) {
      const match = polyMarketMatches(sel, m);
      if (!match) continue;
      candidates.push({
        market: m,
        match,
        label: match.label || match.outcomeName || polyMlYesLabel(m),
      });
    }
    const picked = pickBestTeamMatch(sel.team, candidates, (c) => c.label);
    if (picked) token = polyTokenFor(sel, picked.market, picked.match);
  } else {
    for (const m of markets) {
      const match = polyMarketMatches(sel, m);
      if (!match && match !== true) continue;
      token = polyTokenFor(sel, m, match === true ? {} : match);
      if (token) break;
    }
  }
  if (!token) return { levels: [], reason: 'polymarket_unmatched_market' };
  const book = await fetchJson(`${POLY_CLOB}/book?token_id=${encodeURIComponent(token)}`);
  if (!book.ok || !book.json) return { levels: [], reason: 'polymarket_book_empty' };
  return { levels: sortAsksBestFirst(polymarketAsksFromBook(book.json), 'polymarket'), reason: 'ok' };
}

function flattenProphetXSelections(selections) {
  if (!Array.isArray(selections)) return [];
  const groups = [];
  const looksGrouped = selections.some((x) => Array.isArray(x));
  if (looksGrouped) {
    for (const g of selections) {
      if (Array.isArray(g)) groups.push(g);
      else groups.push([g]);
    }
  } else {
    const bySide = new Map();
    for (const s of selections) {
      const key = `${s && s.name}|${s && s.line}`;
      if (!bySide.has(key)) bySide.set(key, []);
      bySide.get(key).push(s);
    }
    bySide.forEach((g) => groups.push(g));
  }
  return groups;
}

function prophetXGroupMatches(sel, group) {
  const sample = (group || []).find((s) => s && s.name);
  if (!sample) return false;
  const name = String(sample.name || '');
  const line = sample.line;
  if (sel.market === 'TOT' || sel.market === 'TT') {
    const want = sel.side === 'over' ? /over/i : /under/i;
    if (!want.test(name)) return false;
    if (sel.market === 'TT' && sel.team && !tokensHit(nameTokens(name), nameTokens(sel.team))) return false;
    return lineEqual(line, sel.line);
  }
  if (sel.market === 'ML') {
    if (/^draw$/i.test(sel.team)) return isDrawLabel(name);
    return teamMatchScore(name, sel.team) > 0;
  }
  if (sel.market === 'SPR') {
    return tokensHit(nameTokens(name), nameTokens(sel.team)) && lineEqual(line, sel.line);
  }
  return false;
}

function prophetXAsksFromGroup(group) {
  const out = [];
  for (const s of group || []) {
    const american = decimalToAmerican(parseFloat(s && s.price));
    const size = parseFloat(s && s.quantity);
    if (american == null || !isFinite(size) || size <= 0) continue;
    // quantity is already treated as dollar stake in the Promo "$ available" line.
    out.push({ american, size });
  }
  return out;
}

async function prophetXAuthHeader() {
  const key = process.env.PROPHETX_API_KEY;
  if (key) return key;
  const access = process.env.PROPHETX_ACCESS_KEY;
  const secret = process.env.PROPHETX_SECRET_KEY;
  if (!access || !secret) return null;
  return cached('prophetx:token', async () => {
    const res = await fetchJson(`${PROPHETX_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_key: access, secret_key: secret }),
    });
    return (res.ok && res.json && res.json.data && res.json.data.access_token) || null;
  });
}

async function fetchProphetXDepth(sel) {
  const auth = await prophetXAuthHeader();
  if (!auth) return { levels: [], reason: 'prophetx_needs_credentials' };
  const events = await cached('prophetx:events', async () => {
    const res = await fetchJson(`${PROPHETX_BASE}/affiliate/get_sport_events`, {
      headers: { authorization: auth },
    });
    const data = res.ok && res.json && (res.json.data || res.json);
    return (data && (data.sport_events || data.events)) || [];
  });
  const ev = (events || []).find((e) => {
    const away = e.away_team || '';
    const home = e.home_team || '';
    const name = e.name || '';
    return eventMatchesTeams(`${away} ${home} ${name}`, sel.away, sel.home);
  });
  if (!ev || ev.event_id == null) return { levels: [], reason: 'prophetx_unmatched_event' };
  const type = sel.market === 'ML' ? 'moneyline' : sel.market === 'SPR' ? 'spread' : 'total';
  const res = await fetchJson(
    `${PROPHETX_BASE}/v3/affiliate/get_markets?event_id=${encodeURIComponent(ev.event_id)}&market_types=${type}`,
    { headers: { authorization: auth } },
  );
  const markets = (res.ok && res.json && (Array.isArray(res.json.data) ? res.json.data : (res.json.data && res.json.data[ev.event_id]))) || [];
  if (sel.market === 'ML' && !/^draw$/i.test(sel.team)) {
    const candidates = [];
    for (const m of markets) {
      for (const group of flattenProphetXSelections(m.selections)) {
        const sample = (group || []).find((s) => s && s.name);
        if (!sample) continue;
        candidates.push({ group, label: String(sample.name || '') });
      }
    }
    const picked = pickBestTeamMatch(sel.team, candidates, (c) => c.label);
    if (picked) {
      const levels = sortAsksBestFirst(prophetXAsksFromGroup(picked.group), 'prophetx');
      if (levels.length) return { levels, reason: 'ok' };
    }
    return { levels: [], reason: 'prophetx_unmatched_market' };
  }
  for (const m of markets) {
    for (const group of flattenProphetXSelections(m.selections)) {
      if (!prophetXGroupMatches(sel, group)) continue;
      const levels = sortAsksBestFirst(prophetXAsksFromGroup(group), 'prophetx');
      if (levels.length) return { levels, reason: 'ok' };
    }
  }
  return { levels: [], reason: 'prophetx_unmatched_market' };
}

// Novig public v3 (no key). Books list bids per outcome; the ask to buy one
// outcome is 1 - each bid on the other. A contract pays 1 cent, so a level's
// stake is ask * qty / 100 dollars.
const NOVIG_LEAGUES = {
  americanfootball_nfl: 'NFL',
  americanfootball_ncaaf: 'NCAAF',
  baseball_mlb: 'MLB',
  basketball_nba: 'NBA',
  basketball_ncaab: 'NCAAB',
  basketball_wnba: 'WNBA',
  icehockey_nhl: 'NHL',
  soccer_epl: 'EPL',
  soccer_usa_mls: 'MLS',
  soccer_germany_bundesliga: 'Bundesliga',
  soccer_italy_serie_a: 'Serie A',
  soccer_spain_la_liga: 'La Liga',
  soccer_france_ligue_one: 'Ligue 1',
  soccer_uefa_champs_league: 'Champions League',
};
const NOVIG_TYPES = { ML: 'MONEY', SPR: 'SPREAD', TOT: 'TOTAL' };

function novigSpreadName(name) {
  const m = String(name || '').trim().match(/^(.*?)\s*([+-]\d+(?:\.\d+)?)$/);
  return m ? { code: m[1].trim(), line: Number(m[2]) } : null;
}

// Moneyline outcome 0 is the home team; spread outcome names carry the code.
function novigPickOutcome(sel, market, codes) {
  const outcomes = market.outcomes || [];
  if (outcomes.length !== 2) return null;
  const teamFor = (code) => codes[String(code || '').toUpperCase()] || code;
  if (sel.market === 'TOT') {
    if (!lineEqual(Number(market.strike), sel.line)) return null;
    const want = sel.side === 'over' ? /^over/i : /^under/i;
    return outcomes.find((o) => want.test(o.name || '')) || null;
  }
  if (sel.market === 'ML') {
    return pickBestTeamMatch(sel.team, outcomes, (o) => teamFor(o.name)) || null;
  }
  if (sel.market === 'SPR') {
    const named = outcomes.map((o) => ({ o, s: novigSpreadName(o.name) })).filter((x) => x.s);
    const picked = pickBestTeamMatch(sel.team, named, (x) => teamFor(x.s.code));
    return picked && lineEqual(picked.s.line, sel.line) ? picked.o : null;
  }
  return null;
}

// Novig live taker fee: c × P × (1−P) per contract on top of the ask, only
// while the event is OPEN_INGAME (pregame takes are fee-free). c is the
// market's own fee.coefficient; 0.03 (0.06 NCAAF spreads/totals) if missing.
const NOVIG_LIVE_FEE_DEFAULT = 0.03;
const NOVIG_LIVE_FEE_NCAAF_LINES = 0.06;

function novigLiveFeeRate(event, market, sel) {
  if (!event || String(event.status || '').toUpperCase() !== 'OPEN_INGAME') return 0;
  const c = Number(market && market.fee && market.fee.coefficient);
  if (market && market.fee && market.fee.coefficient != null && isFinite(c)) return c > 0 ? c : 0;
  const ncaafLine = sel && /ncaaf/i.test(String(sel.sport || '')) && (sel.market === 'SPR' || sel.market === 'TOT');
  return ncaafLine ? NOVIG_LIVE_FEE_NCAAF_LINES : NOVIG_LIVE_FEE_DEFAULT;
}

function novigAsksFromBook(book, market, outcomeId, feeRate) {
  const other = (market.outcomes || []).find((o) => String(o.outcomeId) !== String(outcomeId));
  if (!other || !book || !book.orders) return [];
  const out = [];
  for (const o of book.orders[other.outcomeId] || []) {
    const bid = parseFloat(o.price);
    const qty = Number(o.qty);
    if (!isFinite(bid) || bid <= 0 || bid >= 1 || !(qty > 0)) continue;
    const ask = Math.round((1 - bid) * 1000) / 1000;
    const rate = Number(feeRate) > 0 ? Number(feeRate) : 0;
    const american = probToAmerican(rate ? ask + rate * ask * (1 - ask) : ask);
    if (american == null) continue;
    out.push({ american, size: (ask * qty) / 100 });
  }
  return out;
}

// Novig's public catalog pages at 100 events with a `next` cursor (`after=`).
// A Saturday NCAAF week is ~130 events, so page 1 alone missed games like
// Wisconsin @ UCLA and Ohio State @ Indiana (Oct 17 2026): their legs got
// "novig_unmatched_event", no ladder, and Hide low liquidity hid them.
const NOVIG_CATALOG_MAX_PAGES = 6;
async function fetchNovigCatalogEvents(league) {
  const out = [];
  let after = '';
  for (let page = 0; page < NOVIG_CATALOG_MAX_PAGES; page++) {
    const res = await fetchJson(`${NOVIG_BASE}/v3/public/catalog/events?league=${encodeURIComponent(league)}&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    const items = (res.ok && res.json && Array.isArray(res.json.items)) ? res.json.items : null;
    if (!items) {
      // First page failed: unknown, not empty — do not cache it.
      if (!out.length) { const e = new Error('novig_catalog_unavailable'); e.novigCatalog = true; throw e; }
      break;
    }
    out.push(...items);
    const next = res.json.next;
    if (!next || !items.length || next === after) break;
    after = next;
  }
  return out;
}

async function fetchNovigDepth(sel) {
  const league = NOVIG_LEAGUES[sel.sport];
  const type = NOVIG_TYPES[sel.market];
  if (!league || !type) return { levels: [], reason: 'novig_unsupported_market' };
  const events = await cached(`novig:events:${league}`, () => fetchNovigCatalogEvents(league));
  const live = (e) => e.status === 'OPEN_PREGAME' || e.status === 'OPEN_INGAME';
  const ev = pickEventByStart(
    events.filter((e) => live(e) && eventMatchesTeams(e.description || '', sel.away, sel.home)),
    sel.commence_time,
    (e) => Number(e.startsTs),
  );
  if (!ev) return { levels: [], reason: 'novig_unmatched_event' };
  const markets = await cached(`novig:markets:${ev.eventId}`, async () => {
    const res = await fetchJson(`${NOVIG_BASE}/v3/public/catalog/markets?event=${encodeURIComponent(ev.eventId)}&marketType=MONEY,SPREAD,TOTAL&limit=500`);
    return (res.ok && res.json && Array.isArray(res.json.items)) ? res.json.items : [];
  });
  const [away, home] = String(ev.description || '').split(' @ ');
  const codes = {};
  const money = markets.find((m) => m.marketType === 'MONEY');
  if (money && money.outcomes && money.outcomes.length === 2) {
    codes[String(money.outcomes[0].name).toUpperCase()] = (home || '').trim();
    codes[String(money.outcomes[1].name).toUpperCase()] = (away || '').trim();
  }
  for (const m of markets) {
    if (m.marketType !== type || m.status !== 'OPEN') continue;
    const outcome = novigPickOutcome(sel, m, codes);
    if (!outcome) continue;
    const res = await fetchJson(`${NOVIG_BASE}/v3/public/catalog/markets/${encodeURIComponent(m.marketId)}/book`);
    if (!res.ok || !res.json) return { levels: [], reason: `novig_book_${res.status}` };
    const levels = sortAsksBestFirst(novigAsksFromBook(res.json, m, outcome.outcomeId, novigLiveFeeRate(ev, m, sel)), 'novig');
    return { levels, reason: levels.length ? 'ok' : 'novig_empty_book' };
  }
  return { levels: [], reason: 'novig_unmatched_market' };
}

const PLAYER_PROP_PM = {
  GOAL: { kind: 'hockey_player_goals', slug: (a, h, d) => playerTd.nhlSlugFromTeams(playerTd.nhlAbbrFromName(a), playerTd.nhlAbbrFromName(h), d) },
  HR: { kind: 'baseball_player_home_runs', slug: (a, h, d) => playerTd.mlbSlugFromTeams(playerTd.mlbAbbrFromName(a), playerTd.mlbAbbrFromName(h), d) },
  TD: { kind: 'football_player_touchdowns', slug: (a, h, d) => playerTd.slugFromTeams(playerTd.nflAbbrFromName(a), playerTd.nflAbbrFromName(h), d) },
};

function lineThreshold(line) {
  const n = Number(line);
  if (n === 1 || n === 0.5) return 1;
  if (n === 2 || n === 1.5) return 2;
  return null;
}

// Polymarket US gateway (keyless): event by slug, then that player's /book.
// No asks come from the Yes bids, fee-adjusted like the props cron.
async function fetchPolymarketPlayerDepth(sel) {
  const spec = PLAYER_PROP_PM[sel.market];
  const date = sel.commence_time ? playerTd.easternDate(sel.commence_time) : '';
  const slug = spec && sel.away && sel.home && date ? spec.slug(sel.away, sel.home, date) : '';
  if (!slug) return { levels: [], reason: 'polymarket_no_slug' };
  const ev = await cached(`pmus-ev:${slug}`, () => fetchJson(`${POLY_US_GATEWAY}/v1/events/slug/${encodeURIComponent(slug)}`));
  const event = ev && ev.ok && ev.json ? (ev.json.event || ev.json) : null;
  if (!event) return { levels: [], reason: 'polymarket_unmatched_event' };
  const want = nameTokens(sel.player);
  const market = (event.markets || []).find((mk) => {
    if (!mk || (mk.sportsMarketType || mk.marketType) !== spec.kind) return false;
    if (mk.closed === true || mk.active === false) return false;
    if (lineThreshold(mk.line) !== sel.threshold) return false;
    const name = (mk.metadata && mk.metadata.playerName) || '';
    return want.length > 0 && want.every((t) => nameTokens(name).includes(t));
  });
  if (!market || !market.slug) return { levels: [], reason: 'polymarket_unmatched_market' };
  const book = await fetchJson(`${POLY_US_GATEWAY}/v1/markets/${encodeURIComponent(market.slug)}/book`);
  if (!book.ok || !book.json) return { levels: [], reason: 'polymarket_book_empty' };
  return { levels: noLevelsFromPolymarketBook(book.json), reason: 'ok' };
}

async function fetchVenueDepth(sel) {
  if (!sel) return { levels: [], reason: 'unparsed' };
  try {
    if (sel.side === 'player' && sel.venue === 'polymarket') return await fetchPolymarketPlayerDepth(sel);
    if (sel.venue === 'kalshi') return await fetchKalshiDepth(sel);
    if (sel.venue === 'polymarket') return await fetchPolymarketDepth(sel);
    if (sel.venue === 'prophetx') return await fetchProphetXDepth(sel);
    if (sel.venue === 'novig') return await fetchNovigDepth(sel);
    return { levels: [], reason: 'venue_unsupported' };
  } catch (e) {
    return { levels: [], reason: `error:${e && e.message || e}` };
  }
}

function depthKey(leg) {
  return [leg.bestOppBook || leg.venue, leg.sport, leg.game, leg.bestOppName || leg.name, leg.market].join('|');
}

async function resolveLegsDepth(legs) {
  const list = Array.isArray(legs) ? legs.slice(0, MAX_LEGS) : [];
  const results = [];
  await Promise.all(list.map(async (leg, i) => {
    const sel = parseOppSelection(leg);
    const fetched = await fetchVenueDepth(sel);
    results[i] = {
      key: depthKey(leg),
      venue: (sel && sel.venue) || String(leg.bestOppBook || ''),
      levels: fetched.levels || [],
      reason: fetched.reason || 'ok',
    };
  }));
  return results;
}

module.exports = {
  DEPTH_VENUES,
  MAX_LEGS,
  KALSHI_SERIES,
  parseOppSelection,
  eventMatchesTeams,
  pickEventByStart,
  scoreTokenSets,
  lineEqual,
  nameTokens,
  tokensHit,
  teamMatchScore,
  pickBestTeamMatch,
  GENERIC_TEAM_TOKENS,
  teamsFromGame,
  probToAmerican,
  decimalToAmerican,
  kalshiAsksFromOrderbook,
  polymarketAsksFromBook,
  flattenProphetXSelections,
  prophetXGroupMatches,
  prophetXAsksFromGroup,
  novigAsksFromBook,
  novigPickOutcome,
  matchKalshiMarket,
  parseKalshiProb,
  kalshiCatalogTop,
  fetchKalshiSeriesEvents,
  polyMarketMatches,
  sortAsksBestFirst,
  applyVenueFee,
  novigLiveFeeRate,
  resolveLegsDepth,
  fetchVenueDepth,
  depthKey,
  teamSearchPhrases,
  _resetCatalogCache() { catalogCache.clear(); },
};
