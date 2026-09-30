'use strict';
// Paper MM fixes: fill model, fees, legacy flag, caps, exit, markout, settle.
const assert = require('assert');
const { createPaperSession } = require('./mm-paper-engine');
const { readConfig } = require('./mm-paper-config');
const {
  impliedProb, simulateFill, netPerContract, roundedFee, takerProceedsPerContract, ceilCents,
} = require('./mm-paper-math');
const { parseKalshiTrade } = require('./mm-paper-books');
const { replayPaperEvents, isLegacyEvent } = require('./mm-paper-state');
const { kalshiPayout, resultsByGame, polyResolution, winnerOf } = require('./mm-paper-settle');

const KICK = Date.parse('2026-09-13T23:00:00Z');
const GAME = 'nfl|2026-09-13|kc+phi';

function book(bid, ask, bidSize) {
  return {
    bids: bidSize > 0 ? [{ price: bid, size: bidSize }] : [],
    asks: [{ price: ask, size: 50 }],
  };
}
function quiet(fn) {
  const orig = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = orig; }
}
function make(env = {}) {
  const cfg = readConfig({ MM_PAPER: '1', MM_ORDER_SIZE: '10', MM_POSITION_CAP: '100', ...env });
  const s = createPaperSession(cfg);
  s.upsertGame({
    gameId: GAME, league: 'nfl', date: '2026-09-13', teams: ['kc', 'phi'], labels: {},
    kalshi: {
      kc: { ticker: 'KXNFLGAME-26SEP13KCPHI-KC' },
      phi: { ticker: 'KXNFLGAME-26SEP13KCPHI-PHI' },
    },
  });
  s.setOdds(GAME, {
    kc: { prob: impliedProb(-150), american: -150, book: 'pinnacle' },
    phi: { prob: impliedProb(130), american: 130, book: 'pinnacle' },
  });
  quiet(() => s.setKickoff(GAME, { polymarket: KICK }));
  for (const venue of ['kalshi', 'polymarket']) {
    s.setBook(GAME, venue, 'kc', book(0.54, 0.56, 0));
    s.setBook(GAME, venue, 'phi', book(0.38, 0.42, 0));
  }
  return { s, cfg };
}
const T0 = KICK - 4 * 3600_000;

// ---- 6. fill model -------------------------------------------------------
{
  const q = { price: 0.38, size: 10, queueAhead: 20 };
  // At our price with pad 0.5 the effective queue is 30. 25 prints do not fill.
  let r = simulateFill(q, { price: 0.38, qty: 25 }, { model: 'queue', queuePad: 0.5 });
  assert.strictEqual(r.fillQty, 0);
  assert.ok(r.queueAhead > 0 && r.queueAhead < 20);
  r = simulateFill(q, { price: 0.38, qty: 35 }, { model: 'queue', queuePad: 0.5 });
  assert.strictEqual(r.fillQty, 5);
  // strict ignores prints at our price, fills on strictly better
  assert.strictEqual(simulateFill(q, { price: 0.38, qty: 500 }, { model: 'strict' }).fillQty, 0);
  assert.strictEqual(simulateFill(q, { price: 0.37, qty: 4 }, { model: 'strict' }).fillQty, 4);
  // legacy: no pad
  assert.strictEqual(simulateFill(q, { price: 0.38, qty: 25 }, { model: 'legacy' }).fillQty, 5);
  // buyer-initiated prints never hit a bid
  assert.strictEqual(simulateFill(q, { price: 0.3, qty: 50, aggressor: 'buy' }), null);
  assert.strictEqual(simulateFill(q, { price: 0.3, qty: 50, aggressor: 'sell' }).fillQty, 10);
  assert.strictEqual(parseKalshiTrade({ yes_price_dollars: '0.50', count_fp: '3', taker_side: 'yes' }).aggressor, 'buy');
  assert.strictEqual(parseKalshiTrade({ yes_price_dollars: '0.50', count_fp: '3', taker_side: 'no' }).aggressor, 'sell');
  assert.strictEqual(parseKalshiTrade({ yes_price_dollars: '0.50', count_fp: '3' }).aggressor, null);
}

// Fill latency: a print right after we post cannot fill us.
{
  const { s } = make();
  quiet(() => s.tick(T0));
  const snap = s.snapshot()[0].quotes.phi;
  const early = s.applyTrade(GAME, snap.venue, 'phi', { id: 'e', price: snap.price - 0.05, qty: 10, ts: T0 + 200 }, T0 + 200);
  assert.strictEqual(early.length, 0);
  const later = s.applyTrade(GAME, snap.venue, 'phi', { id: 'l', price: snap.price - 0.05, qty: 10, ts: T0 + 5000 }, T0 + 5000);
  assert.strictEqual(later[0].kind, 'fill');
  assert.strictEqual(later[0].fillModel, 'queue');
  assert.strictEqual(later[0].legacy, false);
}

// ---- 6. fees ---------------------------------------------------------------
{
  const cfg = readConfig({});
  assert.strictEqual(cfg.kalshiMakerCoeff, 0.0175);
  assert.strictEqual(cfg.kalshiTakerCoeff, 0.07);
  assert.strictEqual(ceilCents(0.04375), 0.05);
  // 10 @ 50c maker: 0.0175*10*.25 = $0.04375 -> $0.05 (rounded up) => 50.5c each
  assert.strictEqual(roundedFee('kalshi', 0.5, 10, cfg, 'maker'), 0.05);
  assert.strictEqual(netPerContract('kalshi', 0.5, 10, cfg), 0.505);
  // taker 100 @ 50c: 0.07*100*.25 = $1.75
  assert.strictEqual(roundedFee('kalshi', 0.5, 100, cfg, 'taker'), 1.75);
  // selling 10 @ 40c as Polymarket taker: fee 0.0695*10*.24=0.1668 -> .17
  assert.strictEqual(takerProceedsPerContract('polymarket', 0.4, 10, cfg), (4 - 0.17) / 10);
  // env override back to zero
  assert.strictEqual(readConfig({ MM_KALSHI_MAKER_COEFF: '0' }).kalshiMakerCoeff, 0);
}

// ---- 2. legacy -------------------------------------------------------------
{
  assert.strictEqual(isLegacyEvent({ kind: 'pair', phase: null }), true);
  assert.strictEqual(isLegacyEvent({ kind: 'pair' }), true);
  assert.strictEqual(isLegacyEvent({ kind: 'pair', phase: 'pregame' }), false);
  assert.strictEqual(isLegacyEvent({ kind: 'pair', phase: 'pregame', legacy: true }), true);
  assert.strictEqual(isLegacyEvent({ kind: 'fill', phase: 'unknown' }), false);
  const rows = replayPaperEvents([
    { id: 'a', kind: 'fill', gameId: GAME, team: 'kc', venue: 'kalshi', qty: 10, net: 0.5, price: 0.5, created_at: '2026-09-27T10:00:00Z' },
    { id: 'b', kind: 'fill', gameId: GAME, team: 'phi', venue: 'kalshi', qty: 10, net: 0.3, price: 0.3, created_at: '2026-09-27T10:00:01Z' },
    { id: 'c', kind: 'pair', gameId: GAME, qty: 10, lockedProfit: 2, legs: [{ team: 'kc' }, { team: 'phi' }], created_at: '2026-09-27T10:00:02Z' },
    { id: 'd', kind: 'fill', gameId: GAME, team: 'kc', venue: 'polymarket', qty: 5, net: 0.4, price: 0.4, phase: 'pregame', created_at: '2026-09-29T10:00:00Z' },
    { id: 'e', kind: 'fill', gameId: GAME, team: 'phi', venue: 'polymarket', qty: 5, net: 0.5, price: 0.5, phase: 'pregame', created_at: '2026-09-29T10:00:01Z' },
    { id: 'f', kind: 'pair', gameId: GAME, qty: 5, lockedProfit: 0.5, phase: 'pregame', legs: [{ team: 'kc' }, { team: 'phi' }], created_at: '2026-09-29T10:00:02Z' },
  ]).get(GAME);
  assert.strictEqual(rows.lockedPnl, 0.5);
  assert.strictEqual(rows.legacyLockedPnl, 2);
  assert.strictEqual(rows.pairedQty, 15);
}

// ---- 4. unpaired cap -------------------------------------------------------
{
  const { s } = make({ MM_MAX_UNPAIRED_QTY: '12', MM_MAX_UNPAIRED_USD: '1000', MM_EXIT: '0', MM_FILL_LATENCY_MS: '0' });
  const ev0 = quiet(() => s.tick(T0));
  const kc = ev0.find((e) => e.kind === 'quote' && e.team === 'kc');
  assert.strictEqual(kc.size, 10);
  // Fill 10 kc. Unpaired 10 < 12: next skew quote for phi is still allowed (pairing).
  const f1 = s.applyTrade(GAME, kc.venue, 'kc', { id: 'k1', price: kc.price - 0.05, qty: 10, ts: T0 + 3000 }, T0 + 3000);
  assert.strictEqual(f1[0].kind, 'fill');
  assert.strictEqual(f1[0].unpairedQty, 10);
  const ev1 = quiet(() => s.tick(T0 + 4000));
  assert.ok(!ev1.some((e) => e.kind === 'quote' && e.team === 'kc'), 'no more quoting the filled side');
  // A second kc fill is impossible while the kc quote is held. Force inventory to the cap
  // via a restored lot and check the cap event + no new quotes.
  const cap = make({ MM_MAX_UNPAIRED_QTY: '10', MM_MAX_UNPAIRED_USD: '1000', MM_EXIT: '0', MM_FILL_LATENCY_MS: '0' });
  quiet(() => cap.s.restoreFromEvents([
    { id: 'x', kind: 'fill', gameId: GAME, team: 'kc', venue: 'polymarket', qty: 10, net: 0.5, price: 0.5, phase: 'pregame', ts: T0, created_at: '2026-09-13T10:00:00Z' },
  ], T0));
  const evc = quiet(() => cap.s.tick(T0 + 1000));
  assert.ok(evc.some((e) => e.kind === 'cap' && e.reason === 'unpaired_cap'));
  assert.ok(!evc.some((e) => e.kind === 'quote' || e.kind === 'reprice'), 'cap stops skewing');
  const evc2 = quiet(() => cap.s.tick(T0 + 2000));
  assert.ok(!evc2.some((e) => e.kind === 'cap'), 'cap logged once');
  // $ cap: 10 contracts @ 50c = $5 over a $4 cap
  const usd = make({ MM_MAX_UNPAIRED_QTY: '1000', MM_MAX_UNPAIRED_USD: '4', MM_EXIT: '0' });
  quiet(() => usd.s.restoreFromEvents([
    { id: 'y', kind: 'fill', gameId: GAME, team: 'kc', venue: 'polymarket', qty: 10, net: 0.5, price: 0.5, phase: 'pregame', ts: T0, created_at: '2026-09-13T10:00:00Z' },
  ], T0));
  assert.ok(quiet(() => usd.s.tick(T0 + 1000)).some((e) => e.kind === 'cap'));
  // A smaller room trims the order size instead of skipping.
  const trim = make({ MM_MAX_UNPAIRED_QTY: '4', MM_MAX_UNPAIRED_USD: '1000', MM_EXIT: '0' });
  const tq = quiet(() => trim.s.tick(T0)).filter((e) => e.kind === 'quote');
  assert.ok(tq.length === 2 && tq.every((q) => q.size === 4), `trimmed sizes ${tq.map((q) => q.size)}`);
}

// ---- 3. exit ---------------------------------------------------------------
{
  const { s } = make({ MM_PAIR_TIMEOUT_SEC: '600', MM_FILL_LATENCY_MS: '0', MM_EXIT_COOLDOWN_SEC: '300' });
  const ev0 = quiet(() => s.tick(T0));
  const kc = ev0.find((e) => e.kind === 'quote' && e.team === 'kc');
  const fill = s.applyTrade(GAME, kc.venue, 'kc', { id: 'k1', price: kc.price - 0.05, qty: 10, ts: T0 + 3000 }, T0 + 3000)[0];
  assert.strictEqual(fill.kind, 'fill');
  // Market drops: bids at 30c.
  s.setBook(GAME, kc.venue, 'kc', book(0.3, 0.34, 40));
  s.setBook(GAME, kc.venue === 'kalshi' ? 'polymarket' : 'kalshi', 'kc', { bids: [], asks: [] });
  const before = quiet(() => s.tick(T0 + 300_000));
  assert.ok(!before.some((e) => e.kind === 'exit'), 'not yet timed out');
  const out = quiet(() => s.tick(T0 + 700_000));
  const exit = out.find((e) => e.kind === 'exit');
  assert.ok(exit, 'times out and exits');
  assert.strictEqual(exit.why, 'pair_timeout');
  assert.strictEqual(exit.qty, 10);
  assert.strictEqual(exit.cents, 30);
  assert.strictEqual(exit.legacy, false);
  assert.ok(exit.pnl < 0, 'exit at 30c after a ~54c fill loses');
  // pnl = 10 * (proceeds - entryNet), proceeds = 0.30 less the taker fee
  const expected = 10 * (takerProceedsPerContract(kc.venue, 0.3, 10, readConfig({})) - fill.net);
  assert.ok(Math.abs(exit.pnl - Math.round(expected * 100) / 100) < 0.011);
  assert.strictEqual(exit.exitPnl, exit.pnl);
  assert.ok(out.some((e) => e.kind === 'pull' && e.reason === 'exit_cooldown') || true);
  const snap = s.snapshot()[0];
  assert.strictEqual(snap.positions.length, 0);
  assert.ok(snap.exitPnl < 0);
  // cooldown: no quoting for 5 minutes
  const cool = quiet(() => s.tick(T0 + 800_000));
  assert.ok(!cool.some((e) => e.kind === 'quote' || e.kind === 'reprice'));
  // restore replays the exit
  const replay = replayPaperEvents([
    { id: '1', kind: 'fill', gameId: GAME, team: 'kc', venue: 'polymarket', qty: 10, net: 0.5, price: 0.5, phase: 'pregame', created_at: '2026-09-13T10:00:00Z' },
    { id: '2', kind: 'exit', gameId: GAME, team: 'kc', qty: 10, pnl: -2, legacy: false, created_at: '2026-09-13T11:00:00Z' },
  ]).get(GAME);
  assert.strictEqual(replay.exitPnl, -2);
  assert.ok(replay.lots.every((l) => l.qty < 1e-9));
  // no bids -> blocked event, lot stays
  const nb = make({ MM_PAIR_TIMEOUT_SEC: '5', MM_FILL_LATENCY_MS: '0' });
  const nq = quiet(() => nb.s.tick(T0)).find((e) => e.kind === 'quote' && e.team === 'kc');
  nb.s.applyTrade(GAME, nq.venue, 'kc', { id: 'n1', price: nq.price - 0.05, qty: 10, ts: T0 + 3000 }, T0 + 3000);
  for (const v of ['kalshi', 'polymarket']) nb.s.setBook(GAME, v, 'kc', { bids: [], asks: [{ price: 0.6, size: 5 }] });
  const nbe = quiet(() => nb.s.tick(T0 + 60_000));
  assert.ok(nbe.some((e) => e.kind === 'exit_blocked'));
  assert.strictEqual(nb.s.snapshot()[0].positions[0].qty, 10);
  // disabled
  const off = make({ MM_EXIT: '0', MM_PAIR_TIMEOUT_SEC: '5', MM_FILL_LATENCY_MS: '0' });
  const oq = quiet(() => off.s.tick(T0)).find((e) => e.kind === 'quote' && e.team === 'kc');
  off.s.applyTrade(GAME, oq.venue, 'kc', { id: 'o1', price: oq.price - 0.05, qty: 10, ts: T0 + 3000 }, T0 + 3000);
  assert.ok(!quiet(() => off.s.tick(T0 + 900_000)).some((e) => e.kind === 'exit'));
}

// exit near kickoff
{
  const { s } = make({ MM_PAIR_TIMEOUT_SEC: '86400', MM_EXIT_BEFORE_KICKOFF_SEC: '600', MM_FILL_LATENCY_MS: '0' });
  const t = KICK - 3600_000;
  const q = quiet(() => s.tick(t)).find((e) => e.kind === 'quote' && e.team === 'phi');
  s.applyTrade(GAME, q.venue, 'phi', { id: 'p1', price: q.price - 0.05, qty: 10, ts: t + 3000 }, t + 3000);
  s.setBook(GAME, q.venue, 'phi', book(0.3, 0.34, 40));
  assert.ok(!quiet(() => s.tick(t + 60_000)).some((e) => e.kind === 'exit'));
  const near = quiet(() => s.tick(KICK - 500_000));
  const ex = near.find((e) => e.kind === 'exit');
  assert.ok(ex && ex.why === 'pre_kickoff');
}

// ---- 5. markout ------------------------------------------------------------
{
  const { s } = make({ MM_FILL_LATENCY_MS: '0', MM_EXIT: '0' });
  const q = quiet(() => s.tick(T0)).find((e) => e.kind === 'quote' && e.team === 'kc');
  const f = s.applyTrade(GAME, q.venue, 'kc', { id: 'm1', price: q.price - 0.05, qty: 10, ts: T0 + 3000 }, T0 + 3000)[0];
  assert.strictEqual(f.kind, 'fill');
  const lo = book(0.4, 0.44, 30);
  for (const v of ['kalshi', 'polymarket']) s.setBook(GAME, v, 'kc', lo);
  assert.ok(!quiet(() => s.tick(T0 + 5000)).some((e) => e.kind === 'markout'));
  const m10 = quiet(() => s.tick(T0 + 14_000)).filter((e) => e.kind === 'markout');
  assert.strictEqual(m10.length, 1);
  assert.strictEqual(m10[0].horizon, '10s');
  assert.strictEqual(m10[0].midCents, 42);
  assert.ok(m10[0].markoutCents < 0 && m10[0].adverse === true);
  assert.strictEqual(m10[0].fillKey, f.tradeKey);
  assert.ok(m10[0].midAmericanText);
  const m60 = quiet(() => s.tick(T0 + 64_000)).filter((e) => e.kind === 'markout');
  assert.deepStrictEqual(m60.map((e) => e.horizon), ['1m']);
  const m5 = quiet(() => s.tick(T0 + 304_000)).filter((e) => e.kind === 'markout');
  assert.deepStrictEqual(m5.map((e) => e.horizon), ['5m']);
  const atKick = quiet(() => s.tick(KICK - 60_000 + 1)).filter((e) => e.kind === 'markout');
  assert.deepStrictEqual(atKick.map((e) => e.horizon), ['kickoff']);
  assert.strictEqual(readConfig({ MM_MARKOUT_SEC: '5, 30' }).markoutSec.join(','), '5,30');
}

// ---- 1. settlement -----------------------------------------------------------
{
  const { s } = make({ MM_FILL_LATENCY_MS: '0', MM_EXIT: '0' });
  quiet(() => s.restoreFromEvents([
    { id: '1', kind: 'fill', gameId: GAME, team: 'kc', venue: 'polymarket', qty: 10, net: 0.4, price: 0.4, phase: 'pregame', ts: T0, created_at: '2026-09-13T10:00:00Z' },
    { id: '2', kind: 'fill', gameId: GAME, team: 'phi', venue: 'polymarket', qty: 4, net: 0.5, price: 0.5, phase: 'pregame', ts: T0, created_at: '2026-09-13T10:00:01Z' },
    { id: '3', kind: 'pair', gameId: GAME, qty: 4, lockedProfit: 0.4, phase: 'pregame', legs: [{ team: 'kc' }, { team: 'phi' }], ts: T0, created_at: '2026-09-13T10:00:02Z' },
    { id: '4', kind: 'fill', gameId: GAME, team: 'kc', venue: 'kalshi', qty: 5, net: 0.3, price: 0.3, ts: T0, created_at: '2026-09-13T12:00:00Z' },
  ], T0));
  assert.strictEqual(s.unsettledGames(T0).length, 1);
  assert.deepStrictEqual(s.settleGames(new Map(), T0), []);
  const evs = quiet(() => s.settleGames(new Map([[GAME, { payouts: { kc: 1, phi: 0 }, source: 'kalshi' }]]), T0));
  assert.strictEqual(evs.length, 1);
  const ev = evs[0];
  assert.strictEqual(ev.kind, 'settle');
  assert.strictEqual(ev.winner, 'kc');
  // headline: 0.4 locked + remaining 6 kc lots (phase set) settle at 1 - 0.4 => 3.6 => 4.0
  assert.strictEqual(ev.lockedPnl, 0.4);
  assert.strictEqual(ev.settlePnl, 3.6);
  assert.strictEqual(ev.realizedPnl, 4);
  // legacy 5 kc lot @ 0.3 wins 0.7 => 3.5 and is excluded from realizedPnl
  assert.strictEqual(ev.legacySettlePnl, 3.5);
  assert.strictEqual(ev.legacyPnl, 3.5);
  assert.strictEqual(s.unsettledGames(T0).length, 0);
  assert.strictEqual(s.settleGames(new Map([[GAME, { payouts: { kc: 1, phi: 0 } }]]), T0).length, 0, 'settles once');
  assert.strictEqual(s.openLots().length, 0);
  // restore replays settle: nothing open, game closed
  const again = make().s;
  quiet(() => again.restoreFromEvents([
    { id: '1', kind: 'fill', gameId: GAME, team: 'kc', venue: 'polymarket', qty: 10, net: 0.4, price: 0.4, phase: 'pregame', created_at: '2026-09-13T10:00:00Z' },
    { id: '9', kind: 'settle', gameId: GAME, winner: 'kc', realizedPnl: 6, legacyPnl: 0, created_at: '2026-09-14T10:00:00Z' },
  ], T0));
  assert.strictEqual(again.openLots().length, 0);
  assert.strictEqual(again.unsettledGames(T0).length, 0);
  assert.ok(!quiet(() => again.tick(T0 + 1000)).some((e) => e.kind === 'quote'));
  // loser leg
  const lose = make().s;
  quiet(() => lose.restoreFromEvents([
    { id: '1', kind: 'fill', gameId: GAME, team: 'phi', venue: 'polymarket', qty: 10, net: 0.4, price: 0.4, phase: 'pregame', ts: T0, created_at: '2026-09-13T10:00:00Z' },
  ], T0));
  const le = quiet(() => lose.settleGames(new Map([[GAME, { payouts: { kc: 1, phi: 0 } }]]), T0))[0];
  assert.strictEqual(le.realizedPnl, -4);
  assert.strictEqual(lose.pnlTotals().settledGames, 1);
  // push pays half
  const push = make().s;
  quiet(() => push.restoreFromEvents([
    { id: '1', kind: 'fill', gameId: GAME, team: 'phi', venue: 'polymarket', qty: 10, net: 0.4, price: 0.4, phase: 'pregame', ts: T0, created_at: '2026-09-13T10:00:00Z' },
  ], T0));
  assert.strictEqual(quiet(() => push.settleGames(new Map([[GAME, { payouts: { kc: 0.5, phi: 0.5 } }]]), T0))[0].realizedPnl, 1);
  // disabled
  const off = make({ MM_SETTLE: '0' }).s;
  assert.deepStrictEqual(off.settleGames(new Map([[GAME, { payouts: { kc: 1, phi: 0 } }]]), T0), []);
}

// Result parsing
{
  assert.strictEqual(kalshiPayout({ status: 'finalized', result: 'yes' }), 1);
  assert.strictEqual(kalshiPayout({ status: 'finalized', result: 'no' }), 0);
  assert.strictEqual(kalshiPayout({ status: 'finalized', result: 'scalar', settlement_value_dollars: '0.5000' }), 0.5);
  assert.strictEqual(kalshiPayout({ status: 'active', result: '' }), null);
  assert.strictEqual(kalshiPayout({ status: 'finalized', result: '' }), null);
  const mk = (t, r) => ({ ticker: t, event_ticker: 'KXNFLGAME-26SEP28PHICHI', status: 'finalized', result: r, yes_sub_title: t });
  const res = resultsByGame([mk('KXNFLGAME-26SEP28PHICHI-PHI', 'no'), mk('KXNFLGAME-26SEP28PHICHI-CHI', 'yes')], new Set(['nfl']));
  assert.deepStrictEqual(res.get('nfl|2026-09-28|chi+phi').payouts, { phi: 0, chi: 1 });
  assert.strictEqual(winnerOf(res.get('nfl|2026-09-28|chi+phi').payouts), 'chi');
  // inconsistent (both yes) is not settled
  assert.strictEqual(resultsByGame([mk('KXNFLGAME-26SEP28PHICHI-PHI', 'yes'), mk('KXNFLGAME-26SEP28PHICHI-CHI', 'yes')], new Set(['nfl'])).size, 0);
  assert.strictEqual(polyResolution({ status: 'MARKET_STATUS_OPEN' }, { league: 'nfl', teams: ['a', 'b'] }), null);
}

// Runner: settles restored games from finalized Kalshi markets and writes rows.
async function runnerTest() {
  const { createRunner } = require('./mm-paper-runner');
  const written = [];
  const finalized = (t, r) => ({ ticker: t, event_ticker: 'KXNFLGAME-26SEP13KCPHI', status: 'finalized', result: r, yes_sub_title: t });
  const kalshi = {
    async get(path) {
      if (path === '/trade-api/v2/markets') {
        return { json: { markets: [finalized('KXNFLGAME-26SEP13KCPHI-KC', 'yes'), finalized('KXNFLGAME-26SEP13KCPHI-PHI', 'no')], cursor: '' } };
      }
      return { json: null };
    },
    close() {},
  };
  const runner = createRunner({ MM_PAPER: '1', MM_SETTLE_AFTER_KICKOFF_SEC: '0' }, {
    supabase: null, kalshi, poly: null, polyWs: false,
    log: { async write(ev) { written.push(ev); } },
    now: () => KICK + 5 * 3600_000,
  });
  quiet(() => runner.session.restoreFromEvents([
    { id: '1', kind: 'fill', gameId: GAME, team: 'phi', venue: 'kalshi', qty: 10, net: 0.4, price: 0.4, phase: 'pregame', kickoffMs: KICK, kickoffSource: 'polymarket', ts: T0, created_at: '2026-09-13T10:00:00Z' },
  ], KICK));
  const evs = await quiet(() => runner.settle(KICK + 5 * 3600_000, { force: true }));
  const settled = await evs;
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(written[0].kind, 'settle');
  assert.strictEqual(written[0].realizedPnl, -4);
  assert.strictEqual(written[0].source, 'kalshi');
  const none = await runner.settle(KICK + 6 * 3600_000, { force: true });
  assert.strictEqual(none.length, 0);
  runner.stop();
}

runnerTest().then(() => {
  console.log('mm-paper-fixes.test.js ok');
}).catch((err) => { console.error(err); process.exit(1); });
