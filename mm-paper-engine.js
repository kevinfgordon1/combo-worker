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
} = require('./mm-paper-math');
const { bookTop, sizeAtBid } = require('./mm-paper-books');

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
  let halted = false;
  let dailyDay = null;
  let dailyLocked = 0;
  const recentHedge = new Map();

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
        pairedQty: 0,
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
    return g;
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

  function pnlFields(g) {
    const pnl = markPnl(g);
    return {
      lockedPnl: round2(pnl.locked),
      openPnl: pnl.open == null ? null : round2(pnl.open),
      openPositions: pnl.positions,
    };
  }

  function baseEvent(g, kind, extra) {
    return {
      kind,
      ts: extra && extra.ts ? extra.ts : Date.now(),
      gameId: g.gameId,
      league: g.league,
      paper: true,
      orders: 'none',
      ...pnlFields(g),
      ...extra,
    };
  }

  function tryPair(g, ts) {
    const events = [];
    const [aTeam, bTeam] = g.teams;
    for (;;) {
      const a = unpairedLots(g, aTeam)[0];
      const b = unpairedLots(g, bTeam)[0];
      if (!a || !b) break;
      const done = completePair(a, b);
      if (!done.ok) {
        events.push(baseEvent(g, 'pair_blocked', {
          ts,
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
      g.pairedQty += done.qty;
      g.lockedPnl += done.lockedProfit;
      dailyLocked += done.lockedProfit;
      events.push(baseEvent(g, 'pair', {
        ts,
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

  function applyTrade(gameId, venue, team, trade, now) {
    const g = games.get(gameId);
    if (!g || !trade) return [];
    const key = `${venue}|${team}|${trade.id || `${trade.ts}|${trade.price}|${trade.qty}`}`;
    if (seenTrades.has(key)) return [];
    seenTrades.add(key);
    const quote = g.quotes[team];
    if (!quote || quote.venue !== venue) return [];
    if (trade.ts != null && quote.quotedAt != null && trade.ts + 1 < quote.quotedAt) return [];
    const sim = simulateFill(quote, trade);
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
    });
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
      tradeId: trade.id || null,
    })];
    events.push(...tryPair(g, now));
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

  function quoteFor(g, team, { step } = {}) {
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
    const size = Math.min(cfg.orderSize, sideRoom(g, team) + (g.quotes[team] ? g.quotes[team].size : 0));
    if (!(size >= 1)) return { skip: 'position_cap' };
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
    for (const g of games.values()) {
      if (halted) {
        for (const team of g.teams) {
          const pulled = pullQuote(g, team, 'daily_loss_limit', now);
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

  function snapshot() {
    return [...games.values()].map((g) => ({
      gameId: g.gameId,
      league: g.league,
      quotes: { ...g.quotes },
      lockedPnl: g.lockedPnl,
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
};
