// Paper market-making loop. Started only from start-mm-paper.js when
// MM_PAPER=1. Combo Locks quoting and the desk protect sweep are not loaded.
// Every HTTP call is a GET. No order is placed.
'use strict';

const { createClient } = require('@supabase/supabase-js');
const { readConfig, flagOn } = require('./mm-paper-config');
const { createPaperSession } = require('./mm-paper-engine');
const { createPaperLog } = require('./mm-paper-log');
const { groupKalshiMarkets, attachOdds } = require('./mm-paper-games');
const { sportsForLeagues } = require('./mm-paper-odds');
const { invertBook } = require('./mm-paper-books');
const { roundCent } = require('./mm-paper-math');
const { identityFromMarket, normTeam } = require('./leg-identity');
const {
  createKalshiReader,
  listKalshiMarkets,
  kalshiBook,
  kalshiTrades,
  createPolyReader,
  createPolyMarketsWs,
  resolvePolyBooks,
} = require('./mm-paper-feed');

function polySides(game, slug, market, book) {
  const got = identityFromMarket(market, 'yes');
  const longTeam = got && got.identity
    ? normTeam(game.league, got.identity.selection)
    : null;
  if (!longTeam || !(game.teams || []).includes(longTeam)) return null;
  const shortTeam = game.teams.find((t) => t !== longTeam);
  if (!shortTeam) return null;
  const sides = {};
  sides[longTeam] = { slug, inverted: false, book };
  sides[shortTeam] = { slug, inverted: true, book: invertBook(book) };
  return sides;
}

function createRunner(env = process.env, deps = {}) {
  const cfg = readConfig(env);
  const session = deps.session || createPaperSession(cfg);
  const log = deps.log || createPaperLog({ filePath: cfg.logPath });
  // Public REST only. Do not pass the Combo Locks API key into this reader.
  const kalshi = deps.kalshi !== undefined ? deps.kalshi : createKalshiReader();
  const poly = deps.poly !== undefined ? deps.poly : createPolyReader({
    keyId: env.POLYMARKET_KEY_ID,
    secretKey: env.POLYMARKET_SECRET_KEY,
  });
  const supabase = deps.supabase !== undefined ? deps.supabase : (
    cfg.supabase
      ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
      : null
  );
  const nowFn = deps.now || (() => Date.now());
  const tradeSince = new Map();
  const polyQueue = [];
  let markets = [];
  let polyByGame = new Map();
  let ws = null;
  let lastOddsAt = 0;
  let busy = false;

  if (cfg.polyWs && env.POLYMARKET_KEY_ID && env.POLYMARKET_SECRET_KEY && deps.polyWs !== false) {
    ws = createPolyMarketsWs({
      keyId: env.POLYMARKET_KEY_ID,
      secretKey: env.POLYMARKET_SECRET_KEY,
      onBook: (book) => polyQueue.push({ type: 'book', book }),
      onTrade: (trade) => polyQueue.push({ type: 'trade', trade }),
      onStatus: (s) => console.log(`[MM-PAPER] poly markets ws ${s}`),
    });
  }

  async function loadOdds(now) {
    if (!supabase) return [];
    const sports = sportsForLeagues(cfg.leagues);
    if (!sports.length) return [];
    const { data, error } = await supabase
      .from('odds_cache')
      .select('sport,data,fetched_at')
      .in('sport', sports);
    if (error) {
      console.warn(`[MM-PAPER] odds_cache read failed: ${error.message || error}`);
      return [];
    }
    return attachOdds(markets, data || [], {
      now,
      maxAgeMs: cfg.oddsMaxAgeMs,
      pinnacleMaxDev: cfg.pinnacleMaxDev,
    });
  }

  async function refreshMarkets() {
    if (busy) return markets.length;
    busy = true;
    try {
      return await refreshMarketsBody();
    } finally {
      busy = false;
    }
  }

  async function refreshMarketsBody() {
    const rows = kalshi ? await listKalshiMarkets(kalshi, cfg.leagues) : [];
    let games = groupKalshiMarkets(rows, cfg.leagues);
    games.sort((a, b) => String(a.date).localeCompare(String(b.date))
      || ((a.startMinutes || 0) - (b.startMinutes || 0)));
    if (games.length > cfg.maxGames) games = games.slice(0, cfg.maxGames);
    markets = games;
    for (const g of games) session.upsertGame(g);
    if (poly) {
      const next = new Map();
      for (const g of games) {
        try {
          const resolved = await resolvePolyBooks(poly, g);
          if (!resolved) continue;
          const sides = polySides(g, resolved.slug, resolved.market, resolved.book);
          if (!sides) continue;
          next.set(g.gameId, { slug: resolved.slug, sides });
          session.setPolyMarket(g.gameId, Object.fromEntries(
            Object.entries(sides).map(([team, side]) => [team, { slug: side.slug, inverted: side.inverted }])
          ));
          for (const [team, side] of Object.entries(sides)) {
            session.setBook(g.gameId, 'polymarket', team, side.book);
          }
        } catch (err) {
          console.warn(`[MM-PAPER] poly market ${g.gameId}: ${err && err.message ? err.message : err}`);
        }
      }
      polyByGame = next;
      if (ws) ws.update([...next.values()].map((row) => row.slug));
    }
    return games.length;
  }

  function applyPolyQueue(now) {
    const events = [];
    while (polyQueue.length) {
      const item = polyQueue.shift();
      if (!item) continue;
      for (const [gameId, row] of polyByGame) {
        if (item.type === 'book' && item.book) {
          const slug = item.book.slug;
          if (!slug || row.slug !== slug) continue;
          for (const [team, side] of Object.entries(row.sides)) {
            const book = side.inverted ? invertBook(item.book) : item.book;
            session.setBook(gameId, 'polymarket', team, book);
          }
        }
        if (item.type === 'trade' && item.trade && item.trade.slug === row.slug) {
          for (const [team, side] of Object.entries(row.sides)) {
            const price = side.inverted ? roundCent(1 - item.trade.price) : item.trade.price;
            const id = side.inverted ? `${item.trade.id || 't'}:no` : item.trade.id;
            events.push(...session.applyTrade(gameId, 'polymarket', team, {
              ...item.trade,
              id,
              price,
            }, now));
          }
        }
      }
    }
    return events;
  }

  async function pollBooksAndTrades(now) {
    const events = [];
    for (const inst of session.instruments()) {
      if (inst.venue === 'kalshi' && kalshi) {
        try {
          const book = await kalshiBook(kalshi, inst.id);
          if (book) session.setBook(inst.gameId, 'kalshi', inst.team, book);
          const since = tradeSince.get(inst.id) || (now - 60_000);
          const trades = await kalshiTrades(kalshi, inst.id, since);
          tradeSince.set(inst.id, now - 2000);
          for (const trade of trades) {
            events.push(...session.applyTrade(inst.gameId, 'kalshi', inst.team, trade, now));
          }
        } catch (err) {
          console.warn(`[MM-PAPER] kalshi ${inst.id}: ${err && err.message ? err.message : err}`);
        }
      }
      if (inst.venue === 'polymarket' && poly && !inst.inverted) {
        try {
          const book = await poly.book(inst.id);
          if (!book) continue;
          const row = polyByGame.get(inst.gameId);
          if (!row) {
            session.setBook(inst.gameId, 'polymarket', inst.team, book);
            continue;
          }
          for (const [team, side] of Object.entries(row.sides)) {
            session.setBook(inst.gameId, 'polymarket', team, side.inverted ? invertBook(book) : book);
            if (book.lastTrade && book.lastTrade.qty && book.lastTrade.ts) {
              const price = side.inverted ? roundCent(1 - book.lastTrade.price) : book.lastTrade.price;
              const id = `last:${inst.id}:${book.lastTrade.ts || ''}:${book.lastTrade.price}:${book.lastTrade.qty}${side.inverted ? ':no' : ''}`;
              events.push(...session.applyTrade(inst.gameId, 'polymarket', team, {
                id,
                price,
                qty: book.lastTrade.qty,
                ts: book.lastTrade.ts,
              }, now));
            }
          }
        } catch (err) {
          console.warn(`[MM-PAPER] poly book ${inst.id}: ${err && err.message ? err.message : err}`);
        }
      }
    }
    return events;
  }

  async function once(now = nowFn()) {
    if (busy) return [];
    busy = true;
    try {
      const events = [];
      events.push(...applyPolyQueue(now));
      if (!lastOddsAt || (now - lastOddsAt) >= cfg.oddsPollMs) {
        lastOddsAt = now;
        const attached = await loadOdds(now);
        if (attached.length) session.replaceOdds(attached);
      }
      events.push(...await pollBooksAndTrades(now));
      events.push(...session.tick(now));
      for (const ev of events) await log.write(ev);
      return events;
    } finally {
      busy = false;
    }
  }

  return {
    cfg,
    session,
    log,
    refreshMarkets,
    once,
    startWs() { if (ws) ws.start(); },
    stop() {
      if (ws) ws.stop();
      if (kalshi && kalshi.close) kalshi.close();
      if (poly && poly.close) poly.close();
    },
  };
}

async function main(env = process.env) {
  const cfg = readConfig(env);
  if (!cfg.enabled) {
    console.log('[MM-PAPER] disabled. Set MM_PAPER=1. No orders.');
    return;
  }
  if (flagOn(env.MM_KALSHI_WS)) {
    console.warn('[MM-PAPER] MM_KALSHI_WS is ignored. Paper mode does not open a Kalshi websocket. Market data is public GET /markets orderbooks and trades.');
  }
  const log = createPaperLog({
    filePath: cfg.logPath,
    insertFn: cfg.supabase ? async (row) => {
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
      return supabase.from('mm_paper_events').insert({
        kind: row.kind,
        game_id: row.gameId || null,
        venue: row.venue || null,
        team: row.team || null,
        payload: row,
      });
    } : null,
  });
  const runner = createRunner(env, { log });
  const leagues = [...cfg.leagues].join(',');
  console.log(
    `[MM-PAPER] paper only — no orders. leagues=${leagues} `
    + `kalshiMaker=${cfg.kalshiMakerCoeff} polyRebate=${cfg.polyMakerRebate} `
    + `polyTaker=${cfg.polyTakerFee} adverse=${cfg.adverseCents}c `
    + `cap=${cfg.positionCap} size=${cfg.orderSize} `
    + `oddsMaxAgeMs=${cfg.oddsMaxAgeMs} log=${cfg.logPath} `
    + `supabase=${cfg.supabase ? 'on' : 'off'}`
  );
  runner.startWs();
  let marketTimer = null;
  let pollTimer = null;
  const stop = () => {
    clearInterval(marketTimer);
    clearInterval(pollTimer);
    runner.stop();
  };
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  try {
    const n = await runner.refreshMarkets();
    console.log(`[MM-PAPER] watching ${n} games`);
  } catch (err) {
    console.warn(`[MM-PAPER] market refresh failed: ${err && err.message ? err.message : err}`);
  }
  const beat = async () => {
    try { await runner.once(); } catch (err) {
      console.warn(`[MM-PAPER] tick failed: ${err && err.message ? err.message : err}`);
    }
  };
  await beat();
  marketTimer = setInterval(() => {
    runner.refreshMarkets().catch((err) => {
      console.warn(`[MM-PAPER] market refresh failed: ${err && err.message ? err.message : err}`);
    });
  }, cfg.marketRefreshMs);
  pollTimer = setInterval(beat, cfg.pollMs);
  return { runner, stop };
}

module.exports = { createRunner, main, polySides };
