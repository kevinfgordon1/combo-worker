// NFL moneyline price book for the no-boost shadow quoter. In-memory, sync reads.
// Kalshi: GET /markets?series_ticker=KXNFLGAME (yes_ask/yes_bid + occurrence_datetime).
// Polymarket: getMarketBySlug(aec-nfl-…) per-team YES ask/bid (pmTeamYesProbs).
// Kickoff = Kalshi occurrence_datetime − 3h (verified vs Poly gameStartTime on
// 2026-10-01: PIT@CLE occ 03:15Z, Poly start 00:15Z; TEN@BAL occ 20:00Z, start 17:00Z).
// Never invents a price: a missing ask/bid is null and the leg is unpriceable.
'use strict';
const { parseKalshiUnhedgedTicker, parsePmUnhedgedSlug } = require('./unhedged-rfq');
const { pmTeamYesProbs, asProb, gameKeyFromParsed, pmMlSlugsFromKalshiLeg } = require('./unhedged-price-cache');
const { normTeam } = require('./leg-identity');
const { takerThetaForVenue } = require('./unhedged-quote');

const KICKOFF_OFFSET_MS = 3 * 3600 * 1000;
const DEFAULT_STALE_MS = 15000;

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function validAsk(v) {
  const p = num(v);
  return p != null && p > 0 && p < 1 ? p : null;
}

function createNflBook({ now = () => Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  // key `${gameId}:${team}` -> { kalshi:{ask,bid,at,ticker}, polymarket:{ask,bid,at,key} }
  const teams = new Map();
  const games = new Map(); // gameId -> { kickoffMs, teams:[a,b], date }

  function slot(gameId, team) {
    const k = `${gameId}:${team}`;
    let s = teams.get(k);
    if (!s) { s = {}; teams.set(k, s); }
    return s;
  }

  function ingestKalshiMarkets(markets) {
    let n = 0;
    for (const m of markets || []) {
      const ticker = String((m && (m.ticker || m.market_ticker)) || '').toUpperCase();
      if (!ticker.startsWith('KXNFLGAME-')) continue;
      const parsed = parseKalshiUnhedgedTicker(ticker, 'yes');
      if (!parsed || parsed.skip) continue;
      const gameId = parsed.gameId;
      const team = normTeam('nfl', parsed.selection);
      const sizeOk = m.yes_ask_size_fp == null || num(m.yes_ask_size_fp) > 0;
      const ask = sizeOk ? validAsk(m.yes_ask_dollars != null ? m.yes_ask_dollars : m.yes_ask) : null;
      const bid = validAsk(m.yes_bid_dollars != null ? m.yes_bid_dollars : m.yes_bid);
      slot(gameId, team).kalshi = { ask, bid, at: now(), ticker };
      const occ = Date.parse(m.occurrence_datetime || m.expected_expiration_time || '');
      const g = games.get(gameId) || { teams: parsed.teams.map((t) => normTeam('nfl', t)).sort(), date: parsed.date };
      if (Number.isFinite(occ)) g.kickoffMs = occ - KICKOFF_OFFSET_MS;
      games.set(gameId, g);
      n += 1;
    }
    return n;
  }

  function ingestPolyMarket(slug, market) {
    const rows = pmTeamYesProbs(market, slug);
    if (!rows || rows.length < 2) return 0;
    const raw = (market && market.market) || market || {};
    const start = Date.parse(raw.gameStartTime || raw.game_start_time || '');
    let n = 0;
    for (const r of rows) {
      const parsed = parsePmUnhedgedSlug(String(slug).toLowerCase(), 'yes');
      const league = r.league || (parsed && parsed.league);
      const date = r.date || (parsed && parsed.date);
      const gameId = gameKeyFromParsed({ league, date, teams: r.teams });
      if (!gameId || league !== 'nfl') continue;
      const team = normTeam('nfl', r.team);
      slot(gameId, team).polymarket = { ask: asProb(r.yesProb), bid: null, at: now(), key: `${String(slug).toLowerCase()}-${r.team}` };
      if (Number.isFinite(start)) {
        const g = games.get(gameId) || { teams: [...new Set(r.teams.map((t) => normTeam('nfl', t)))].sort(), date };
        g.kickoffMs = Math.min(g.kickoffMs == null ? Infinity : g.kickoffMs, start);
        games.set(gameId, g);
      }
      n += 1;
    }
    return n;
  }

  function fresh(q) { return q && (now() - q.at) <= staleMs; }

  function opponentOf(gameId, team) {
    const g = games.get(gameId);
    if (!g) return null;
    const others = g.teams.filter((t) => t !== team);
    return others.length === 1 ? others[0] : null;
  }

  // Quotes in the shape unhedged-quote.ourTrueFromOpponents expects: opponent YES ASK per venue.
  function opponentQuotes(leg) {
    const opp = opponentOf(leg.gameId, leg.team);
    if (!opp) return [];
    const s = teams.get(`${leg.gameId}:${opp}`);
    if (!s) return [];
    const out = [];
    if (s.kalshi && fresh(s.kalshi) && s.kalshi.ask != null) out.push({ venue: 'kalshi', yesProb: s.kalshi.ask, bid: s.kalshi.bid, key: s.kalshi.ticker });
    if (s.polymarket && fresh(s.polymarket) && s.polymarket.ask != null) {
      out.push({ venue: 'polymarket', yesProb: s.polymarket.ask, key: s.polymarket.key });
    }
    return out;
  }

  function ownQuotes(leg) {
    const s = teams.get(`${leg.gameId}:${leg.team}`);
    if (!s) return [];
    const out = [];
    if (s.kalshi && fresh(s.kalshi) && s.kalshi.ask != null) out.push({ venue: 'kalshi', yesProb: s.kalshi.ask, bid: s.kalshi.bid, key: s.kalshi.ticker });
    if (s.polymarket && fresh(s.polymarket) && s.polymarket.ask != null) {
      out.push({ venue: 'polymarket', yesProb: s.polymarket.ask, key: s.polymarket.key });
    }
    return out;
  }

  // optional sportsbook reference: setReference(gameId, team, noVigProb)
  const refs = new Map();
  function setReference(gameId, team, p) { refs.set(`${gameId}:${team}`, { p, at: now() }); }
  function reference(leg) {
    const r = refs.get(`${leg.gameId}:${leg.team}`);
    return r && (now() - r.at) < 10 * 60 * 1000 ? r.p : null;
  }

  function kickoffMs(gameId) {
    const g = games.get(gameId);
    return g && Number.isFinite(g.kickoffMs) ? g.kickoffMs : null;
  }

  // The price source handed to noboost-quote.priceCombo
  const source = { opponentQuotes, ownQuotes, reference };

  return {
    ingestKalshiMarkets, ingestPolyMarket, opponentQuotes, ownQuotes, kickoffMs,
    setReference, source, takerThetaForVenue, pmMlSlugsFromKalshiLeg,
    games: () => [...games.entries()],
    _teams: teams, _games: games,
  };
}

module.exports = { createNflBook, KICKOFF_OFFSET_MS, DEFAULT_STALE_MS };
