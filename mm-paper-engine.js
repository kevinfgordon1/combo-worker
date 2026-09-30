// Paper session: decide quotes, simulate fills, complete pairs.
// Never calls a venue. The runner feeds books, trades, and odds in.
'use strict';

const {
  capBid,
  netPerContract,
  lockPriceFromOpponent,
  preferVenue,
  restingBid,
  stepTowardMid,
  enforcePair,
  adverseMove,
  simulateFill,
  completePair,
  priceView,
  pairNetsOk,
  takerProceedsPerContract,
} = require('./mm-paper-math');
const { bookTop, sizeAtBid } = require('./mm-paper-books');
const { chooseKickoff, formatKickoffEt } = require('./mm-paper-games');
const {
  metaFromGameId,
  orderPaperEvents,
  restoreIdentity,
  applyFill,
  applyPair,
  applyExit,
  applySettle,
} = require('./mm-paper-state');

function bufferMs(cfg) {
  const sec = cfg && Number.isFinite(Number(cfg.kickoffBufferSec)) ? Number(cfg.kickoffBufferSec) : 60;
  return sec * 1000;
}

function formatCutoffLine({ gameId, kickoffEt, bufferSec, pulled }) {
  const n = Number.isFinite(Number(bufferSec)) ? String(Number(bufferSec)) : '60';
  return `[MM-PAPER] cutoff ${gameId} kickoff=${kickoffEt} buffer=${n}s — pulled ${pulled} bids, no more quotes`;
}

function formatNoKickoffLine(gameId) {
  return `[MM-PAPER] no kickoff ${gameId} — not quoting`;
}

function formatKickoffLine({ gameId, source, kickoffEt, note }) {
  const extra = note ? ` (${note})` : '';
  return `[MM-PAPER] kickoff ${gameId} source=${source} kickoff=${kickoffEt}${extra}`;
}

function normalizePrintTs(ts, fallback) {
  if (ts == null || ts === '') return fallback;
  if (typeof ts === 'number') {
    if (!Number.isFinite(ts)) return fallback;
    return ts > 0 && ts < 1e12 ? ts * 1000 : ts;
  }
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function etDay(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (type) => {
    const hit = parts.find((p) => p.type === type);
    return hit ? hit.value : '';
  };
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function otherTeam(game, team) {
  return (game.teams || []).find((t) => t !== team) || null;
}

function createPaperSession(cfg) {
  const games = new Map();
  const seenTrades = new Set();
  const restoredKeys = new Set();
  let eventSeq = 0;
  let halted = false;
  let dailyDay = null;
  let dailyLocked = 0;
  const recentHedge = new Map();
  const pendingMarkouts = [];
  const capLogged = new Map();

  function rollDay(now) {
    const day = etDay(now);
    if (dailyDay !== day) {
      dailyDay = day;
      dailyLocked = 0;
      halted = false;
    }
    return day;
  }

  function ensure(meta) {
    let g = games.get(meta.gameId);
    if (!g) {
      g = {
        gameId: meta.gameId,
        league: meta.league,
        date: meta.date,
        teams: meta.teams.slice(),
        labels: { ...(meta.labels || {}) },
        books: { kalshi: {}, polymarket: {} },
        odds: {},
        quotes: {},
        lots: [],
        lockedPnl: 0,
        legacyLockedPnl: 0,
        pairedQty: 0,
        legacyPairedQty: 0,
        exitPnl: 0,
        legacyExitPnl: 0,
        exits: 0,
        cooldownUntil: 0,
        lastExitTryAt: 0,
        settled: false,
        settlement: null,
        kickoffMs: null,
        kickoffSource: null,
        kickoffNote: null,
        kickoffSources: {},
        kickoffLoggedKey: null,
        closed: false,
        noKickoffLogged: false,
      };
      games.set(meta.gameId, g);
    }
    return g;
  }

  function upsertGame(meta) {
    const g = ensure(meta);
    g.league = meta.league;
    g.date = meta.date;
    g.teams = meta.teams.slice();
    g.labels = { ...g.labels, ...(meta.labels || {}) };
    g.kalshiTickers = meta.kalshi || g.kalshiTickers || {};
    if (meta.kickoffMs != null) setKickoff(g.gameId, { kalshiTicker: meta.kickoffMs });
    if (meta.commenceMs != null) setKickoff(g.gameId, { odds: meta.commenceMs });
    return g;
  }

  function cutoffMsOf(g) {
    if (!g || g.kickoffMs == null || !Number.isFinite(g.kickoffMs)) return null;
    return g.kickoffMs - bufferMs(cfg);
  }

  function phaseAt(g, ts) {
    const cut = cutoffMsOf(g);
    if (cut == null || ts == null || !Number.isFinite(Number(ts))) return 'unknown';
    return Number(ts) >= cut ? 'ingame' : 'pregame';
  }

  function setKickoff(gameId, partial) {
    const g = games.get(gameId);
    if (!g || !partial) return null;
    g.kickoffSources = { ...(g.kickoffSources || {}) };
    for (const [key, value] of Object.entries(partial)) {
      if (value == null || value === '') continue;
      const ms = typeof value === 'number' ? value : Date.parse(value);
      if (!Number.isFinite(ms)) continue;
      g.kickoffSources[key] = ms;
    }
    const chosen = chooseKickoff(g.kickoffSources);
    if (!chosen) return null;
    g.kickoffMs = chosen.kickoffMs;
    g.kickoffSource = chosen.source;
    g.kickoffNote = chosen.note || null;
    if (!g.closed) {
      const logKey = `${chosen.source}|${chosen.kickoffMs}|${chosen.note || ''}`;
      if (g.kickoffLoggedKey !== logKey) {
        g.kickoffLoggedKey = logKey;
        console.log(formatKickoffLine({
          gameId: g.gameId,
          source: g.kickoffSource,
          kickoffEt: formatKickoffEt(g.kickoffMs),
          note: g.kickoffNote,
        }));
      }
    }
    return chosen;
  }

  function rememberKickoff(g, ev) {
    if (!g || !ev || ev.kickoffMs == null) return;
    const source = ev.kickoffSource;
    if (source === 'polymarket') setKickoff(g.gameId, { polymarket: ev.kickoffMs });
    else if (source === 'odds') setKickoff(g.gameId, { odds: ev.kickoffMs });
    else if (source === 'kalshi_ticker' || source === 'kalshiTicker') {
      setKickoff(g.gameId, { kalshiTicker: ev.kickoffMs });
    } else if (g.kickoffMs == null) {
      setKickoff(g.gameId, { restored: ev.kickoffMs });
    }
  }

  function ensureFromEvent(ev) {
    const meta = metaFromGameId(ev && ev.gameId, ev && ev.league);
    if (!meta) return null;
    return upsertGame({
      gameId: meta.gameId,
      league: meta.league,
      date: meta.date,
      teams: meta.teams,
      labels: {},
    });
  }

  function tradeSeenKey(ev) {
    if (ev && ev.tradeKey) return ev.tradeKey;
    if (ev && ev.tradeId) return `${ev.venue}|${ev.team}|${ev.tradeId}`;
    return null;
  }

  function restoreFromEvents(events, now = Date.now()) {
    rollDay(now);
    let applied = 0;
    const passCounts = new Map();
    for (const ev of orderPaperEvents(events)) {
      if (!ev) continue;
      if (!['fill', 'pair', 'cutoff', 'exit', 'settle'].includes(ev.kind)) continue;
      if (ev.seq != null && Number(ev.seq) > eventSeq) eventSeq = Number(ev.seq);
      const g = ensureFromEvent(ev);
      if (g) rememberKickoff(g, ev);
      if (ev.kind === 'cutoff') continue;
      const key = restoreIdentity(ev, passCounts);
      if (!key || restoredKeys.has(key)) continue;
      restoredKeys.add(key);
      if (!g) continue;
      if (ev.kind === 'fill') {
        const lot = applyFill(g, ev);
        if (!lot) continue;
        const seen = tradeSeenKey(ev);
        if (seen) seenTrades.add(seen);
        applied += 1;
      } else if (ev.kind === 'pair') {
        const paired = applyPair(g, ev);
        if (!paired) continue;
        if (!paired.legacy && ev.ts != null && etDay(ev.ts) === dailyDay) dailyLocked += paired.profit;
        applied += 1;
      } else if (ev.kind === 'exit') {
        const exited = applyExit(g, ev);
        if (!exited) continue;
        g.exits += 1;
        if (!exited.legacy && ev.ts != null && etDay(ev.ts) === dailyDay) dailyLocked += exited.pnl;
        applied += 1;
      } else if (ev.kind === 'settle') {
        if (applySettle(g, ev)) {
          g.closed = true;
          applied += 1;
        }
      }
    }
    // Restored lots restart their pair-timeout clock at boot, so a redeploy
    // never dumps every stale lot in one burst.
    const nowMs = Number(now);
    for (const g of games.values()) {
      for (const lot of g.lots) lot.ts = nowMs;
    }
    let openQty = 0;
    let lockedPnl = 0;
    for (const g of games.values()) {
      lockedPnl += g.lockedPnl;
      for (const lot of g.lots) if (lot.qty > 1e-9) openQty += lot.qty;
    }
    const lots = openLots();
    return {
      applied,
      openQty,
      lockedPnl: round2(lockedPnl),
      dailyLocked: round2(dailyLocked),
      lots,
    };
  }

  function setBook(gameId, venue, team, book) {
    const g = games.get(gameId);
    if (!g || (venue !== 'kalshi' && venue !== 'polymarket')) return;
    g.books[venue][team] = book || { bids: [], asks: [] };
  }

  function setOdds(gameId, odds) {
    const g = games.get(gameId);
    if (!g) return;
    g.odds = odds || {};
  }

  function setPolyMarket(gameId, byTeam) {
    const g = games.get(gameId);
    if (!g) return;
    g.poly = byTeam || {};
  }

  function replaceOdds(attached) {
    const live = new Set();
    for (const row of attached || []) {
      live.add(row.gameId);
      const g = ensure(row);
      g.labels = { ...g.labels, ...(row.labels || {}) };
      g.kalshiTickers = row.kalshi || {};
      g.odds = row.odds || {};
      g.rawTeams = row.rawTeams;
      if (row.commenceMs != null) setKickoff(row.gameId, { odds: row.commenceMs });
      if (row.kickoffMs != null) setKickoff(row.gameId, { kalshiTicker: row.kickoffMs });
    }
    for (const [id, g] of games) {
      if (!live.has(id)) g.odds = {};
    }
  }

  function unpairedLots(g, team) {
    return g.lots.filter((lot) => lot.team === team && lot.qty > 1e-9);
  }

  function unpairedQty(g, team) {
    return unpairedLots(g, team).reduce((s, lot) => s + lot.qty, 0);
  }

  function worstUnpairedNet(g, team) {
    const lots = unpairedLots(g, team);
    if (!lots.length) return null;
    return lots.reduce((m, lot) => (lot.net > m ? lot.net : m), 0);
  }

  function positions(g) {
    return (g.teams || []).map((team) => {
      const lots = unpairedLots(g, team);
      const qty = lots.reduce((s, lot) => s + lot.qty, 0);
      if (!(qty > 0)) return null;
      const cost = lots.reduce((s, lot) => s + lot.qty * lot.net, 0);
      const net = cost / qty;
      const venue = lots[lots.length - 1].venue;
      const view = priceView(net);
      return { team, venue, qty, net, cents: view.cents, american: view.american, americanText: view.americanText };
    }).filter(Boolean);
  }

  function markPnl(g) {
    let open = 0;
    let known = true;
    for (const pos of positions(g)) {
      const tops = ['polymarket', 'kalshi'].map((venue) => bookTop(g.books[venue][pos.team]));
      const mid = tops.map((t) => t.mid).find((m) => m != null);
      if (mid == null) {
        known = false;
        continue;
      }
      open += pos.qty * (mid - pos.net);
    }
    return { locked: g.lockedPnl, open: known ? open : null, positions: positions(g) };
  }

  function exposureOf(g) {
    let qty = 0;
    let usd = 0;
    for (const lot of g.lots) {
      if (!(lot.qty > 1e-9)) continue;
      qty += lot.qty;
      usd += lot.qty * lot.net;
    }
    return { qty, usd };
  }

  function pnlFields(g) {
    const pnl = markPnl(g);
    const exp = exposureOf(g);
    return {
      lockedPnl: round2(pnl.locked),
      legacyLockedPnl: round2(g.legacyLockedPnl || 0),
      exitPnl: round2(g.exitPnl || 0),
      openPnl: pnl.open == null ? null : round2(pnl.open),
      openPositions: pnl.positions,
      unpairedQty: round2(exp.qty),
      unpairedUsd: round2(exp.usd),
    };
  }

  // Largest fill (contracts) on `team` that keeps this game's unpaired
  // inventory within MM_MAX_UNPAIRED_QTY and MM_MAX_UNPAIRED_USD. A fill that
  // pairs off inventory on the other side is always allowed up to that
  // inventory. `px` bounds the per-contract cost of the new fill.
  function capRoom(g, team, px) {
    const capQ = Number.isFinite(cfg.maxUnpairedQty) ? cfg.maxUnpairedQty : Infinity;
    const capU = Number.isFinite(cfg.maxUnpairedUsd) ? cfg.maxUnpairedUsd : Infinity;
    const opp = otherTeam(g, team);
    const uT = unpairedQty(g, team);
    const uO = opp ? unpairedQty(g, opp) : 0;
    const price = px > 0 ? px : 1;
    const byQty = capQ + uO - uT;
    const byUsd = capU / price + uO - uT;
    const room = Math.max(uO, Math.min(byQty, byUsd));
    return Math.max(0, Math.floor(room * 100 + 1e-9) / 100);
  }

  function atCap(g) {
    const exp = exposureOf(g);
    const capQ = Number.isFinite(cfg.maxUnpairedQty) ? cfg.maxUnpairedQty : Infinity;
    const capU = Number.isFinite(cfg.maxUnpairedUsd) ? cfg.maxUnpairedUsd : Infinity;
    return exp.qty >= capQ - 1e-9 || exp.usd >= capU - 1e-9;
  }

  function baseEvent(g, kind, extra) {
    const extraFields = { ...(extra || {}) };
    const ts = extraFields.ts || Date.now();
    const phaseTs = extraFields.phaseTs != null ? extraFields.phaseTs : ts;
    const phase = extraFields.phase || phaseAt(g, phaseTs);
    delete extraFields.phaseTs;
    delete extraFields.phase;
    delete extraFields.ts;
    eventSeq += 1;
    return {
      seq: eventSeq,
      kind,
      ts,
      gameId: g.gameId,
      league: g.league,
      paper: true,
      orders: 'none',
      kickoffMs: g.kickoffMs,
      kickoffSource: g.kickoffSource || null,
      cutoffMs: cutoffMsOf(g),
      bufferSec: bufferMs(cfg) / 1000,
      phase,
      ...pnlFields(g),
      ...extraFields,
    };
  }

  function tryPair(g, ts, phaseTs, { quiet } = {}) {
    const events = [];
    const [aTeam, bTeam] = g.teams;
    for (;;) {
      const a = unpairedLots(g, aTeam)[0];
      const b = unpairedLots(g, bTeam)[0];
      if (!a || !b) break;
      const done = completePair(a, b);
      if (!done.ok) {
        if (quiet) break;
        events.push(baseEvent(g, 'pair_blocked', {
          ts,
          phaseTs: phaseTs != null ? phaseTs : ts,
          reason: done.reason,
          combinedNet: done.combinedNet,
          teams: {
            [aTeam]: priceView(a.net),
            [bTeam]: priceView(b.net),
          },
        }));
        break;
      }
      a.qty -= done.qty;
      b.qty -= done.qty;
      // A pair that consumes a legacy (pre-cutoff-logic) lot is suspect too.
      const legacy = !!(a.legacy || b.legacy);
      g.pairedQty += done.qty;
      if (legacy) {
        g.legacyPairedQty += done.qty;
        g.legacyLockedPnl += done.lockedProfit;
      } else {
        g.lockedPnl += done.lockedProfit;
        dailyLocked += done.lockedProfit;
      }
      events.push(baseEvent(g, 'pair', {
        ts,
        legacy,
        phaseTs: phaseTs != null ? phaseTs : ts,
        qty: done.qty,
        combinedNet: done.combinedNet,
        combinedCents: Math.round(done.combinedNet * 100),
        lockedProfit: round2(done.lockedProfit),
        legs: [a, b].map((lot) => ({
          team: lot.team,
          venue: lot.venue,
          ...priceView(lot.price),
          net: lot.net,
          netCents: Math.round(lot.net * 100),
          netAmerican: priceView(lot.net).american,
          netAmericanText: priceView(lot.net).americanText,
        })),
      }));
    }
    return events;
  }

  function kalshiTickerFor(g, team) {
    const row = g.kalshiTickers && g.kalshiTickers[team];
    return row && row.ticker ? row.ticker : null;
  }

  function applyTrade(gameId, venue, team, trade, now) {
    const g = games.get(gameId);
    if (!g || !trade) return [];
    const printTs = normalizePrintTs(trade.ts, now);
    const cut = cutoffMsOf(g);
    if (cut == null || printTs >= cut) return [];
    const key = `${venue}|${team}|${trade.id || `${trade.ts}|${trade.price}|${trade.qty}`}`;
    if (seenTrades.has(key)) return [];
    seenTrades.add(key);
    const quote = g.quotes[team];
    if (!quote || quote.venue !== venue) return [];
    // Our order is not live until fillLatencyMs after we posted it.
    const latency = cfg.fillModel === 'legacy' ? 0 : (Number(cfg.fillLatencyMs) || 0);
    if (trade.ts != null && quote.quotedAt != null && trade.ts + 1 < quote.quotedAt + latency) return [];
    const sim = simulateFill(quote, trade, { model: cfg.fillModel || 'queue', queuePad: cfg.queuePad });
    if (!sim) return [];
    quote.queueAhead = sim.queueAhead;
    if (!(sim.fillQty > 0)) return [];
    const filledPrice = quote.price;
    const net = netPerContract(venue, filledPrice, sim.fillQty, cfg);
    quote.size = sim.sizeLeft;
    if (!(quote.size > 1e-9)) delete g.quotes[team];
    g.lots.push({
      team,
      venue,
      price: filledPrice,
      net,
      qty: sim.fillQty,
      ts: now,
      legacy: false,
      kalshiTicker: kalshiTickerFor(g, team),
    });
    scheduleMarkouts(g, { team, venue, price: filledPrice, net, qty: sim.fillQty, tradeKey: key, now });
    const view = priceView(filledPrice);
    const events = [baseEvent(g, 'fill', {
      ts: now,
      team,
      venue,
      qty: sim.fillQty,
      price: view.price,
      cents: view.cents,
      american: view.american,
      americanText: view.americanText,
      net,
      netCents: Math.round(net * 100),
      netAmerican: priceView(net).american,
      netAmericanText: priceView(net).americanText,
      tradePrice: trade.price,
      tradeCents: Math.round(trade.price * 100),
      tradeAmerican: priceView(trade.price).american,
      tradeAmericanText: priceView(trade.price).americanText,
      queueReason: sim.reason,
      fillModel: cfg.fillModel || 'queue',
      aggressor: trade.aggressor || null,
      legacy: false,
      tradeId: trade.id || null,
      tradeKey: key,
      tradeTs: printTs,
      kalshiTicker: kalshiTickerFor(g, team),
      phaseTs: printTs,
    })];
    events.push(...tryPair(g, now, printTs));
    return events;
  }

  function sideRoom(g, team) {
    const filled = g.lots.filter((lot) => lot.team === team).reduce((s, lot) => s + lot.qty, 0);
    const resting = g.quotes[team] ? g.quotes[team].size : 0;
    return Math.max(0, cfg.positionCap - filled - resting);
  }

  function topOf(g, venue, team) {
    return bookTop((g.books[venue] && g.books[venue][team]) || null);
  }

  function quoteFor(g, team, { step, forceSize } = {}) {
    const opp = otherTeam(g, team);
    const oppPx = opp && g.odds[opp];
    if (!oppPx || oppPx.prob == null) return { skip: 'no_sportsbook' };
    const lock = lockPriceFromOpponent(oppPx.prob);
    if (lock == null) return { skip: 'no_lock' };
    const oppFilledNet = worstUnpairedNet(g, opp);
    const oppQuote = g.quotes[opp];
    const otherNet = oppFilledNet != null
      ? oppFilledNet
      : (oppQuote ? oppQuote.net : null);
    const size = Math.min(forceSize || Infinity, cfg.orderSize, sideRoom(g, team) + (g.quotes[team] ? g.quotes[team].size : 0));
    if (!(size >= 1)) return { skip: 'position_cap' };
    if (!forceSize) {
      const room = capRoom(g, team, lock);
      if (!(room >= 1)) return { skip: 'unpaired_cap' };
      if (room < size) return quoteFor(g, team, { step, forceSize: Math.floor(room) });
    }
    const restingVenue = step && g.quotes[team] ? g.quotes[team].venue : null;
    const venues = restingVenue ? [restingVenue] : ['kalshi', 'polymarket'];
    const offers = [];
    for (const venue of venues) {
      const cap = capBid({
        venue,
        contracts: size,
        lockPrice: lock,
        otherNet,
        cfg,
      });
      if (!cap) continue;
      const top = topOf(g, venue, team);
      let price = restingBid({ capPrice: cap.price, bestBid: top.bestBid, bestAsk: top.bestAsk });
      if (step && g.quotes[team] && g.quotes[team].venue === venue) {
        price = stepTowardMid({
          current: g.quotes[team].price,
          mid: top.mid,
          stepCents: cfg.stepCents,
          capPrice: cap.price,
          bestAsk: top.bestAsk,
        });
      }
      if (price == null) continue;
      const net = netPerContract(venue, price, size, cfg);
      if (net == null || net > lock + 1e-9) continue;
      if (otherNet != null && !pairNetsOk(net, otherNet)) continue;
      offers.push({ venue, price, net, cap: cap.price, top });
    }
    const picked = preferVenue(offers);
    if (!picked) return { skip: 'no_bid', lockPrice: lock };
    return {
      team,
      venue: picked.venue,
      price: picked.price,
      net: picked.net,
      size,
      lockPrice: lock,
      opponent: oppPx,
      top: picked.top,
    };
  }

  function pullQuote(g, team, reason, now) {
    const q = g.quotes[team];
    if (!q) return null;
    delete g.quotes[team];
    const view = priceView(q.price);
    return baseEvent(g, 'pull', {
      ts: now,
      team,
      venue: q.venue,
      reason,
      price: view.price,
      cents: view.cents,
      american: view.american,
      americanText: view.americanText,
    });
  }

  function restQuote(g, decision, reason, now) {
    const prev = g.quotes[decision.team];
    const same = prev
      && prev.venue === decision.venue
      && Math.abs(prev.price - decision.price) < 0.0005
      && Math.abs(prev.size - decision.size) < 1e-9;
    if (same) return null;
    const book = g.books[decision.venue][decision.team];
    const queueAhead = sizeAtBid(book, decision.price);
    const top = decision.top || topOf(g, decision.venue, decision.team);
    g.quotes[decision.team] = {
      venue: decision.venue,
      price: decision.price,
      net: decision.net,
      size: decision.size,
      queueAhead: queueAhead == null ? null : queueAhead,
      lockAtQuote: decision.lockPrice,
      midAtQuote: top.mid,
      quotedAt: now,
    };
    const view = priceView(decision.price);
    const lockView = priceView(decision.lockPrice);
    const oppView = priceView(decision.opponent.prob);
    return baseEvent(g, prev ? 'reprice' : 'quote', {
      ts: now,
      team: decision.team,
      venue: decision.venue,
      reason,
      action: prev ? 'reprice' : 'rest',
      price: view.price,
      cents: view.cents,
      american: view.american,
      americanText: view.americanText,
      net: decision.net,
      netCents: Math.round(decision.net * 100),
      netAmerican: priceView(decision.net).american,
      netAmericanText: priceView(decision.net).americanText,
      lockPrice: lockView.price,
      lockCents: lockView.cents,
      lockAmerican: lockView.american,
      lockAmericanText: lockView.americanText,
      opponentBook: decision.opponent.book,
      opponentAmerican: decision.opponent.american,
      opponentAmericanText: decision.opponent.american > 0
        ? `+${decision.opponent.american}`
        : String(decision.opponent.american),
      opponentCents: oppView.cents,
      opponentProb: decision.opponent.prob,
      midCents: top.mid == null ? null : Math.round(top.mid * 100),
      size: decision.size,
      queueAhead: queueAhead == null ? null : queueAhead,
    });
  }

  function hedgeEvents(g, now) {
    const events = [];
    for (const team of g.teams) {
      const qty = unpairedQty(g, team);
      if (!(qty > 0)) continue;
      const opp = otherTeam(g, team);
      const book = opp && g.odds[opp];
      if (!book || book.prob == null) continue;
      const net = worstUnpairedNet(g, team);
      if (net == null) continue;
      const combined = net + book.prob;
      if (!(combined < 1 - 1e-9)) continue;
      const key = `${g.gameId}|${team}|${book.american}|${Math.round(net * 100)}`;
      if (recentHedge.get(g.gameId + team) === key) continue;
      recentHedge.set(g.gameId + team, key);
      const view = priceView(book.prob);
      events.push(baseEvent(g, 'hedge', {
        ts: now,
        team,
        hedgeTeam: opp,
        note: 'sportsbook hedge available — not placed',
        placed: false,
        unpairedQty: qty,
        ourNet: net,
        ourNetCents: Math.round(net * 100),
        book: book.book,
        bookAmerican: book.american,
        bookAmericanText: book.american > 0 ? `+${book.american}` : String(book.american),
        bookCents: view.cents,
        bookProb: book.prob,
        combinedNet: combined,
        lockedIfHedged: round2(qty * (1 - combined)),
      }));
    }
    return events;
  }

  // ---- Adverse-fill markout -------------------------------------------
  // After each simulated fill, record the venue mid for that team at each
  // MM_MARKOUT_SEC horizon and at the kickoff cutoff (the last pregame book).
  // markoutCents = mid - fill price; negative means the market moved against
  // us (we were picked off). Pending markouts live in memory only.
  function midFor(g, venue, team) {
    const first = topOf(g, venue, team).mid;
    if (first != null) return { mid: first, venue };
    const other = venue === 'kalshi' ? 'polymarket' : 'kalshi';
    const second = topOf(g, other, team).mid;
    return second != null ? { mid: second, venue: other } : { mid: null, venue };
  }

  function scheduleMarkouts(g, fill) {
    const start = midFor(g, fill.venue, fill.team).mid;
    const horizons = (cfg.markoutSec || []).map((sec) => ({ label: `${sec >= 60 && sec % 60 === 0 ? `${sec / 60}m` : `${sec}s`}`, dueAt: fill.now + sec * 1000 }));
    const cut = cutoffMsOf(g);
    const items = horizons.slice();
    if (cut != null) items.push({ label: 'kickoff', dueAt: cut });
    for (const h of items) {
      if (h.label !== 'kickoff' && cut != null && h.dueAt > cut) continue;
      pendingMarkouts.push({
        gameId: g.gameId,
        team: fill.team,
        venue: fill.venue,
        price: fill.price,
        net: fill.net,
        qty: fill.qty,
        fillKey: fill.tradeKey,
        fillAt: fill.now,
        midAtFill: start,
        label: h.label,
        dueAt: h.dueAt,
      });
    }
  }

  function dueMarkouts(now) {
    const events = [];
    for (let i = pendingMarkouts.length - 1; i >= 0; i -= 1) {
      const m = pendingMarkouts[i];
      if (now < m.dueAt) continue;
      pendingMarkouts.splice(i, 1);
      const g = games.get(m.gameId);
      if (!g) continue;
      const got = midFor(g, m.venue, m.team);
      const mid = got.mid;
      const view = priceView(mid);
      const fillView = priceView(m.price);
      events.push(baseEvent(g, 'markout', {
        ts: now,
        team: m.team,
        venue: m.venue,
        horizon: m.label,
        horizonSec: Math.round((m.dueAt - m.fillAt) / 1000),
        fillKey: m.fillKey,
        qty: m.qty,
        fillCents: fillView.cents,
        fillAmerican: fillView.american,
        fillAmericanText: fillView.americanText,
        midVenue: got.venue,
        midCents: mid == null ? null : Math.round(mid * 100),
        midAmerican: view.american,
        midAmericanText: view.americanText,
        midAtFillCents: m.midAtFill == null ? null : Math.round(m.midAtFill * 100),
        markoutCents: mid == null ? null : round2((mid - m.price) * 100),
        markoutUsd: mid == null ? null : round2((mid - m.price) * m.qty),
        adverse: mid == null ? null : (mid - m.price) <= -(cfg.adverseCents / 100) + 1e-9,
      }));
    }
    events.sort((a, b) => a.seq - b.seq);
    return events;
  }

  // ---- Pair-completion timeout / exit ----------------------------------
  // Sell `qty` of `team` as a paper taker. bid mode walks the bids (VWAP);
  // mid mode takes the mid. Fees: venue taker fee. Returns null when the
  // book cannot take it (no bids).
  function exitQuote(g, team, qty, venuePref) {
    const venues = [venuePref, venuePref === 'kalshi' ? 'polymarket' : 'kalshi'].filter(Boolean);
    let best = null;
    for (const venue of venues) {
      const book = (g.books[venue] && g.books[venue][team]) || null;
      let fillQty;
      let px;
      if (cfg.exitMode === 'mid') {
        const top = bookTop(book);
        if (top.mid == null) continue;
        fillQty = qty;
        px = top.mid;
      } else {
        let left = qty;
        let notional = 0;
        for (const lvl of (book && book.bids) || []) {
          const take = Math.min(left, lvl.size);
          notional += take * lvl.price;
          left -= take;
          if (!(left > 1e-9)) break;
        }
        fillQty = qty - Math.max(0, left);
        if (!(fillQty > 1e-9)) continue;
        px = notional / fillQty;
      }
      const proceeds = takerProceedsPerContract(venue, Math.round(px * 10000) / 10000, fillQty, cfg);
      if (proceeds == null) continue;
      const cand = { venue, price: px, proceeds, qty: fillQty };
      if (!best
        || (cand.qty >= qty - 1e-9 && best.qty < qty - 1e-9)
        || ((cand.qty >= qty - 1e-9) === (best.qty >= qty - 1e-9) && cand.proceeds * cand.qty > best.proceeds * best.qty)) {
        best = cand;
      }
    }
    return best;
  }

  function exitEvents(g, now, why) {
    const events = [];
    if (!cfg.exitEnabled) return events;
    for (const team of g.teams) {
      const opp = otherTeam(g, team);
      // Only one-sided inventory is stuck. Anything the other side could pair
      // with is left to tryPair.
      if (opp && unpairedQty(g, opp) > 1e-9) continue;
      const lots = unpairedLots(g, team);
      if (!lots.length) continue;
      const timeoutMs = cfg.pairTimeoutSec * 1000;
      const due = lots.filter((lot) => why !== 'pair_timeout' || (lot.ts != null && now - lot.ts >= timeoutMs));
      if (!due.length) continue;
      if (now - (g.lastExitTryAt || 0) < 15000 && why === 'pair_timeout') continue;
      let qty = 0;
      for (const lot of due) qty += lot.qty;
      const quote = exitQuote(g, team, qty, due[0].venue);
      g.lastExitTryAt = now;
      if (!quote) {
        if (!g.exitBlockedAt || now - g.exitBlockedAt > 300000) {
          g.exitBlockedAt = now;
          events.push(baseEvent(g, 'exit_blocked', { ts: now, team, qty: round2(qty), reason: 'no_bid', why }));
        }
        continue;
      }
      let left = quote.qty;
      const view = priceView(quote.price);
      for (const lot of lots) {
        if (!(left > 1e-9)) break;
        if (!due.includes(lot)) break;
        const take = Math.min(lot.qty, left);
        left -= take;
        lot.qty -= take;
        const pnl = take * (quote.proceeds - lot.net);
        const legacy = !!lot.legacy;
        if (legacy) g.legacyExitPnl += pnl; else { g.exitPnl += pnl; dailyLocked += pnl; }
        g.exits += 1;
        events.push(baseEvent(g, 'exit', {
          ts: now,
          why,
          reason: why,
          legacy,
          team,
          venue: quote.venue,
          entryVenue: lot.venue,
          qty: take,
          price: view.price,
          cents: view.cents,
          american: view.american,
          americanText: view.americanText,
          proceeds: quote.proceeds,
          entryNet: lot.net,
          entryNetCents: Math.round(lot.net * 100),
          entryAmerican: priceView(lot.net).american,
          entryAmericanText: priceView(lot.net).americanText,
          exitMode: cfg.exitMode,
          ageSec: lot.ts == null ? null : Math.round((now - lot.ts) / 1000),
          pnl: round2(pnl),
        }));
      }
      g.cooldownUntil = Math.max(g.cooldownUntil || 0, now + (cfg.exitCooldownSec || 0) * 1000);
    }
    return events;
  }

  // ---- Settlement -------------------------------------------------------
  // results: Map gameId -> { payouts: {team: 0|1|push}, source }.
  function settleGames(results, now = Date.now()) {
    const events = [];
    if (!cfg.settleEnabled) return events;
    for (const g of games.values()) {
      if (g.settled) continue;
      const res = results && results.get(g.gameId);
      if (!res || !res.payouts) continue;
      const settledLots = [];
      let settlePnl = 0;
      let legacySettlePnl = 0;
      for (const lot of g.lots) {
        if (!(lot.qty > 1e-9)) continue;
        const payout = res.payouts[lot.team];
        if (payout == null) continue;
        const pnl = lot.qty * (payout - lot.net);
        if (lot.legacy) legacySettlePnl += pnl; else settlePnl += pnl;
        const v = priceView(lot.net);
        settledLots.push({
          team: lot.team, venue: lot.venue, qty: round2(lot.qty), entryNet: lot.net,
          entryAmericanText: v.americanText, payout, pnl: round2(pnl), legacy: !!lot.legacy,
        });
      }
      const active = g.pairedQty > 0 || g.exits > 0 || g.lots.length > 0;
      const haveAll = g.lots.every((lot) => !(lot.qty > 1e-9) || res.payouts[lot.team] != null);
      if (!haveAll) continue;
      const realized = g.lockedPnl + g.exitPnl + settlePnl;
      const legacyPnl = g.legacyLockedPnl + g.legacyExitPnl + legacySettlePnl;
      const winner = Object.keys(res.payouts).find((t) => res.payouts[t] === 1) || 'push';
      for (const team of g.teams) pullQuote(g, team, 'settled', now);
      for (const lot of g.lots) lot.qty = 0;
      g.settled = true;
      g.closed = true;
      g.settlement = { winner, realizedPnl: realized, legacyPnl };
      if (!active) continue; // never traded: settled silently, nothing to record
      events.push(baseEvent(g, 'settle', {
        ts: now,
        source: res.source || null,
        winner,
        payouts: res.payouts,
        settledLots,
        lockedPnl: round2(g.lockedPnl),
        exitPnl: round2(g.exitPnl),
        settlePnl: round2(settlePnl),
        realizedPnl: round2(realized),
        legacyLockedPnl: round2(g.legacyLockedPnl),
        legacyExitPnl: round2(g.legacyExitPnl),
        legacySettlePnl: round2(legacySettlePnl),
        legacyPnl: round2(legacyPnl),
        pairedQty: round2(g.pairedQty),
        openPositions: [],
        unpairedQty: 0,
        unpairedUsd: 0,
        openPnl: 0,
        phase: 'settled',
      }));
    }
    return events;
  }

  // Games that traded, are not settled, and started long enough ago that a
  // result should exist. The runner looks their results up.
  function unsettledGames(now = Date.now()) {
    const out = [];
    for (const g of games.values()) {
      if (g.settled) continue;
      if (!(g.pairedQty > 0 || g.exits > 0 || g.lots.length > 0)) continue;
      out.push({
        gameId: g.gameId,
        league: g.league,
        date: g.date,
        teams: g.teams.slice(),
        rawTeams: g.rawTeams,
        kickoffMs: g.kickoffMs,
        startedAgoMs: g.kickoffMs == null ? null : now - g.kickoffMs,
      });
    }
    return out;
  }

  function pnlTotals() {
    const t = { locked: 0, exit: 0, settled: 0, open: 0, legacy: 0, games: 0, settledGames: 0, openQty: 0, openUsd: 0 };
    for (const g of games.values()) {
      t.locked += g.lockedPnl;
      t.exit += g.exitPnl;
      t.legacy += g.legacyLockedPnl + g.legacyExitPnl;
      if (g.settlement) {
        t.settledGames += 1;
        t.settled += g.settlement.realizedPnl - g.lockedPnl - g.exitPnl;
        t.legacy += g.settlement.legacyPnl - g.legacyLockedPnl - g.legacyExitPnl;
      }
      const e = exposureOf(g);
      t.openQty += e.qty;
      t.openUsd += e.usd;
      t.games += 1;
    }
    return t;
  }

  function dayPnl(now) {
    rollDay(now);
    let open = 0;
    let known = true;
    for (const g of games.values()) {
      const pnl = markPnl(g);
      if (pnl.open == null) known = false;
      else open += pnl.open;
    }
    return {
      locked: dailyLocked,
      open: known ? open : null,
      total: known ? dailyLocked + open : null,
      day: dailyDay,
    };
  }

  function tick(now = Date.now()) {
    rollDay(now);
    const events = [];
    if (!halted && cfg.dailyLossLimit != null) {
      const pnl = dayPnl(now);
      if (pnl.total != null && pnl.total <= -cfg.dailyLossLimit) {
        halted = true;
        events.push({
          kind: 'halt',
          ts: now,
          paper: true,
          orders: 'none',
          reason: 'daily_loss_limit',
          dailyLossLimit: cfg.dailyLossLimit,
          lockedPnl: round2(pnl.locked),
          openPnl: round2(pnl.open),
        });
      }
    }
    events.push(...dueMarkouts(now));
    for (const g of games.values()) {
      const cut = cutoffMsOf(g);
      if (!g.closed && cut != null && now >= cut && g.kickoffMs != null && now < g.kickoffMs
        && cfg.exitEnabled && g.lots.some((l) => l.qty > 1e-9)) {
        // Last chance before the book goes stale: leftover one-sided lots exit.
        events.push(...exitEvents(g, now, 'cutoff'));
      }
      if (g.closed || (cut != null && now >= cut)) {
        const pulls = [];
        for (const team of g.teams) {
          const pulled = pullQuote(g, team, 'kickoff_cutoff', now);
          if (pulled) pulls.push(pulled);
        }
        if (!g.closed) {
          g.closed = true;
          const line = formatCutoffLine({
            gameId: g.gameId,
            kickoffEt: formatKickoffEt(g.kickoffMs),
            bufferSec: bufferMs(cfg) / 1000,
            pulled: pulls.length,
          });
          console.log(line);
          events.push(baseEvent(g, 'cutoff', {
            ts: now,
            reason: 'kickoff_cutoff',
            pulled: pulls.length,
            logLine: line,
            kickoffEt: formatKickoffEt(g.kickoffMs),
          }));
        }
        events.push(...pulls);
        continue;
      }
      if (cut == null) {
        for (const team of g.teams) {
          const pulled = pullQuote(g, team, 'no_kickoff', now);
          if (pulled) events.push(pulled);
        }
        if (!g.noKickoffLogged) {
          g.noKickoffLogged = true;
          const line = formatNoKickoffLine(g.gameId);
          console.log(line);
          events.push(baseEvent(g, 'no_kickoff', {
            ts: now,
            reason: 'unknown_kickoff',
            logLine: line,
          }));
        }
        continue;
      }
      if (halted) {
        for (const team of g.teams) {
          const pulled = pullQuote(g, team, 'daily_loss_limit', now);
          if (pulled) events.push(pulled);
        }
        continue;
      }
      if (cfg.exitEnabled && g.lots.some((l) => l.qty > 1e-9)) {
        const nearKickoff = g.kickoffMs != null
          && now >= g.kickoffMs - (cfg.exitBeforeKickoffSec || 0) * 1000;
        events.push(...exitEvents(g, now, nearKickoff ? 'pre_kickoff' : 'pair_timeout'));
      }
      if (cfg.exitEnabled && ((g.cooldownUntil || 0) > now
        || (g.kickoffMs != null && now >= g.kickoffMs - (cfg.exitBeforeKickoffSec || 0) * 1000
            && g.exits > 0))) {
        for (const team of g.teams) {
          const pulled = pullQuote(g, team, 'exit_cooldown', now);
          if (pulled) events.push(pulled);
        }
        continue;
      }
      for (const team of g.teams) {
        if (unpairedQty(g, team) > 0 && g.quotes[team]) {
          const pulled = pullQuote(g, team, 'hold_position', now);
          if (pulled) events.push(pulled);
        }
        const q = g.quotes[team];
        if (!q) continue;
        const opp = otherTeam(g, team);
        const oppPx = opp && g.odds[opp];
        const newLock = oppPx ? lockPriceFromOpponent(oppPx.prob) : null;
        const mid = topOf(g, q.venue, team).mid;
        const bookAdverse = adverseMove(q.lockAtQuote, newLock, cfg.adverseCents) || newLock == null;
        const midAdverse = adverseMove(q.midAtQuote, mid, cfg.adverseCents);
        if (bookAdverse || midAdverse) {
          const reason = newLock == null ? 'odds_stale' : (bookAdverse ? 'sportsbook_adverse' : 'mid_adverse');
          const pulled = pullQuote(g, team, reason, now);
          if (pulled) events.push(pulled);
        }
      }

      const oneSided = g.teams.filter((team) => unpairedQty(g, team) > 0);
      if (oneSided.length && atCap(g)) {
        // Unpaired cap hit: no more skew. The resting pair-completing bid
        // stays where it is; nothing new is quoted on the filled side.
        if (!capLogged.get(g.gameId)) {
          capLogged.set(g.gameId, true);
          events.push(baseEvent(g, 'cap', {
            ts: now,
            reason: 'unpaired_cap',
            maxUnpairedQty: cfg.maxUnpairedQty,
            maxUnpairedUsd: cfg.maxUnpairedUsd,
          }));
        }
        events.push(...hedgeEvents(g, now));
        continue;
      }
      if (!oneSided.length) capLogged.delete(g.gameId);
      const decisions = {};
      for (const team of g.teams) {
        if (unpairedQty(g, team) > 0) continue;
        const step = oneSided.length === 1 && g.quotes[team];
        const decision = quoteFor(g, team, { step: !!step });
        if (decision.skip) {
          if (g.quotes[team] && (decision.skip === 'no_sportsbook' || decision.skip === 'no_lock' || decision.skip === 'no_bid')) {
            const pulled = pullQuote(g, team, decision.skip, now);
            if (pulled) events.push(pulled);
          }
          continue;
        }
        decisions[team] = decision;
      }

      const teams = Object.keys(decisions);
      if (teams.length === 2) {
        const fit = enforcePair(
          { venue: decisions[teams[0]].venue, price: decisions[teams[0]].price, contracts: decisions[teams[0]].size },
          { venue: decisions[teams[1]].venue, price: decisions[teams[1]].price, contracts: decisions[teams[1]].size },
          cfg
        );
        if (!fit) {
          events.push(baseEvent(g, 'skip', { ts: now, reason: 'pair_crosses_dollar' }));
        } else {
          decisions[teams[0]].price = fit.a.price;
          decisions[teams[0]].net = fit.a.net;
          decisions[teams[1]].price = fit.b.price;
          decisions[teams[1]].net = fit.b.net;
          if (!pairNetsOk(fit.a.net, fit.b.net)) {
            events.push(baseEvent(g, 'skip', { ts: now, reason: 'pair_crosses_dollar' }));
          } else {
            for (const team of teams) {
              const ev = restQuote(g, decisions[team], oneSided.length ? 'step' : 'two_sided', now);
              if (ev) events.push(ev);
            }
          }
        }
      } else if (teams.length === 1) {
        const team = teams[0];
        const ev = restQuote(g, decisions[team], oneSided.length ? 'step' : 'one_sided', now);
        if (ev) events.push(ev);
      }
      events.push(...hedgeEvents(g, now));
    }
    return events;
  }

  function instruments() {
    const out = [];
    for (const g of games.values()) {
      if (g.closed || g.kickoffMs == null) continue;
      for (const team of g.teams) {
        const k = g.kalshiTickers && g.kalshiTickers[team];
        if (k && k.ticker) {
          out.push({ gameId: g.gameId, venue: 'kalshi', team, id: k.ticker });
        }
        const slug = g.poly && g.poly[team] && g.poly[team].slug;
        if (slug) out.push({ gameId: g.gameId, venue: 'polymarket', team, id: slug, inverted: !!g.poly[team].inverted });
      }
    }
    return out;
  }

  function openLots() {
    const out = [];
    for (const g of games.values()) {
      for (const lot of g.lots) {
        if (!(lot.qty > 1e-9)) continue;
        const view = priceView(lot.net);
        out.push({
          gameId: g.gameId,
          team: lot.team,
          venue: lot.venue || null,
          qty: lot.qty,
          net: lot.net,
          price: lot.price,
          americanText: view.americanText,
        });
      }
    }
    return out;
  }

  function snapshot() {
    return [...games.values()].map((g) => ({
      gameId: g.gameId,
      league: g.league,
      quotes: { ...g.quotes },
      lockedPnl: g.lockedPnl,
      legacyLockedPnl: g.legacyLockedPnl,
      exitPnl: g.exitPnl,
      settled: g.settled,
      pairedQty: g.pairedQty,
      positions: positions(g),
    }));
  }

  return {
    upsertGame,
    setBook,
    setOdds,
    setPolyMarket,
    replaceOdds,
    setKickoff,
    restoreFromEvents,
    settleGames,
    unsettledGames,
    pnlTotals,
    openLots,
    applyTrade,
    tick,
    instruments,
    snapshot,
    games,
  };
}

function round2(n) {
  if (n == null || !Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

module.exports = {
  createPaperSession,
  etDay,
  formatCutoffLine,
  formatNoKickoffLine,
  formatKickoffLine,
};
