'use strict';
const assert = require('assert');
const fs = require('fs');
const {
  bankersRoundCents,
  exactFee,
  roundedFee,
  netPerContract,
  lockPriceFromOpponent,
  capBid,
  pairNetsOk,
  completePair,
  preferVenue,
  enforcePair,
  restingBid,
  stepTowardMid,
  simulateFill,
  adverseMove,
  impliedProb,
  americanFromProb,
} = require('./mm-paper-math');
const { paperEnabled, readConfig } = require('./mm-paper-config');
const { bestTeamPrice } = require('./mm-paper-odds');
const { parseNcaafTicker, groupKalshiMarkets, matchOddsToGame } = require('./mm-paper-games');
const { parseKalshiOrderbook, parsePolyBook, invertBook, parsePolyMarketMessage } = require('./mm-paper-books');
const { assertPaperReadOnly, createKalshiReader, KALSHI_PUBLIC_ORIGIN } = require('./mm-paper-feed');
const { createPaperLog } = require('./mm-paper-log');
const { summarize } = require('./scripts/mm-paper-summary');

const cfg0 = { kalshiMakerCoeff: 0, polyMakerRebate: 0.0125, polyTakerFee: 0.0695 };

// Polymarket US published examples: 1,000 @ 50¢.
assert.strictEqual(bankersRoundCents(0.0125 * 1000 * 0.5 * 0.5), 3.12);
assert.strictEqual(bankersRoundCents(0.0695 * 1000 * 0.5 * 0.5), 17.38);
assert.strictEqual(bankersRoundCents(0.025), 0.02);
assert.strictEqual(bankersRoundCents(0.035), 0.04);
assert.strictEqual(roundedFee('polymarket', 0.5, 1000, cfg0), -3.12);
assert.strictEqual(roundedFee('polymarket', 0.5, 1000, cfg0, 'taker'), 17.38);
assert.strictEqual(exactFee('kalshi', 0.5, 100, cfg0), 0);
assert.strictEqual(netPerContract('kalshi', 0.42, 10, cfg0), 0.42);

const cfgFee = { ...cfg0, kalshiMakerCoeff: 0.02 };
const kFee = roundedFee('kalshi', 0.5, 100, cfgFee);
assert.strictEqual(kFee, bankersRoundCents(0.02 * 100 * 0.5 * 0.5));
assert.ok(kFee > 0);

// Inverse of team B. -150 → 0.60, lock on A is 0.40. Kalshi coeff 0 cannot bid 0.41.
assert.strictEqual(lockPriceFromOpponent(impliedProb(-150)), 0.4);
const kalshiCap = capBid({ venue: 'kalshi', contracts: 10, lockPrice: 0.4, cfg: cfg0 });
assert.strictEqual(kalshiCap.price, 0.4);
assert.ok(kalshiCap.net <= 0.4 + 1e-9);
assert.strictEqual(
  capBid({ venue: 'kalshi', contracts: 10, lockPrice: 0.4, cfg: cfg0, otherNet: null }).price,
  0.4
);
assert.ok(netPerContract('kalshi', 0.41, 10, cfg0) > 0.4);

// Rebate can lift the nominal bid above the lock when the net still clears.
// Lock 0.407: Kalshi stays at 40¢; Poly 1,000-lot can bid 41¢.
const polyCap = capBid({ venue: 'polymarket', contracts: 1000, lockPrice: 0.407, cfg: cfg0 });
const kalshiTight = capBid({ venue: 'kalshi', contracts: 1000, lockPrice: 0.407, cfg: cfg0 });
assert.strictEqual(kalshiTight.price, 0.4);
assert.strictEqual(polyCap.price, 0.41);
assert.ok(polyCap.net <= 0.407 + 1e-9);
assert.ok(polyCap.price > 0.407);

// Pair completion never reaches $1, including the 50/50 cent grid.
assert.strictEqual(pairNetsOk(0.5, 0.5), false);
assert.strictEqual(completePair({ qty: 10, net: 0.5 }, { qty: 10, net: 0.5 }).ok, false);
assert.strictEqual(completePair({ qty: 10, net: 0.51 }, { qty: 4, net: 0.5 }).reason, 'pair_crosses_dollar');
const okPair = completePair({ qty: 10, net: 0.4 }, { qty: 6, net: 0.55 });
assert.strictEqual(okPair.ok, true);
assert.strictEqual(okPair.qty, 6);
assert.ok(okPair.combinedNet < 1);
assert.ok(okPair.lockedProfit > 0);

const fitted = enforcePair(
  { venue: 'kalshi', price: 0.5, contracts: 10 },
  { venue: 'kalshi', price: 0.5, contracts: 10 },
  cfg0
);
assert.ok(fitted);
assert.ok(fitted.a.net + fitted.b.net < 1);
assert.ok(fitted.a.price <= 0.5 && fitted.b.price <= 0.5);
assert.ok(fitted.a.price < 0.5 || fitted.b.price < 0.5);

const tied = preferVenue([
  { venue: 'kalshi', price: 0.4, net: 0.4 },
  { venue: 'polymarket', price: 0.4, net: 0.4 },
]);
assert.strictEqual(tied.venue, 'polymarket');
const cheaper = preferVenue([
  { venue: 'kalshi', price: 0.4, net: 0.4 },
  { venue: 'polymarket', price: 0.42, net: 0.41 },
]);
assert.strictEqual(cheaper.venue, 'kalshi');

assert.strictEqual(restingBid({ capPrice: 0.6, bestBid: 0.54, bestAsk: 0.56 }), 0.54);
assert.strictEqual(restingBid({ capPrice: 0.4, bestBid: 0.54, bestAsk: 0.56 }), 0.4);
assert.strictEqual(restingBid({ capPrice: 0.56, bestBid: 0.54, bestAsk: 0.55 }), 0.54);
assert.strictEqual(stepTowardMid({
  current: 0.4, mid: 0.5, stepCents: 1, capPrice: 0.42, bestAsk: 0.55,
}), 0.41);
assert.strictEqual(stepTowardMid({
  current: 0.4, mid: 0.5, stepCents: 1, capPrice: 0.4, bestAsk: 0.55,
}), 0.4);

// Queue: at our price the size already there goes first. Through clears it.
const joined = { price: 0.38, size: 10, queueAhead: 20 };
const behind = simulateFill(joined, { price: 0.38, qty: 20 });
assert.strictEqual(behind.fillQty, 0);
assert.strictEqual(behind.queueAhead, 0);
const at = simulateFill({ ...joined, queueAhead: 0 }, { price: 0.38, qty: 4 });
assert.strictEqual(at.fillQty, 4);
assert.strictEqual(at.reason, 'at');
const through = simulateFill(joined, { price: 0.3, qty: 3 });
assert.strictEqual(through.fillQty, 3);
assert.strictEqual(through.reason, 'through');
assert.strictEqual(simulateFill({ price: 0.38, size: 10, queueAhead: null }, { price: 0.38, qty: 100 }).fillQty, 0);

assert.strictEqual(adverseMove(0.4, 0.37, 3), true);
assert.strictEqual(adverseMove(0.4, 0.38, 3), false);
assert.strictEqual(adverseMove(0.4, null, 3), true);

assert.strictEqual(paperEnabled({}), false);
assert.strictEqual(paperEnabled({ MM_PAPER: '0' }), false);
assert.strictEqual(paperEnabled({ MM_PAPER: '1' }), true);
const defaults = readConfig({});
assert.strictEqual(defaults.enabled, false);
assert.ok(defaults.leagues.has('nfl'));
assert.ok(!defaults.leagues.has('mlb'));
assert.ok(!defaults.leagues.has('ncaaf'));
assert.strictEqual(defaults.kalshiMakerCoeff, 0);
assert.strictEqual(defaults.polyMakerRebate, 0.0125);
assert.strictEqual(defaults.polyTakerFee, 0.0695);
assert.strictEqual(defaults.adverseCents, 3);
assert.strictEqual(defaults.dailyLossLimit, null);
assert.strictEqual(defaults.kalshiWs, false);
const both = readConfig({ MM_LEAGUES: 'nfl,mlb,cfb' });
assert.ok(both.leagues.has('mlb') && both.leagues.has('ncaaf'));

// Outlier soft number must not set the inverse. Pinnacle -150 stays.
const now = Date.parse('2026-09-13T18:00:00Z');
const fresh = new Date(now - 60_000).toISOString();
const game = {
  home_team: 'Kansas City Chiefs',
  away_team: 'Philadelphia Eagles',
  bookmakers: [
    {
      key: 'pinnacle',
      markets: [{ key: 'h2h', outcomes: [
        { name: 'Kansas City Chiefs', price: -150 },
        { name: 'Philadelphia Eagles', price: 130 },
      ] }],
    },
    {
      key: 'draftkings',
      markets: [{ key: 'h2h', outcomes: [
        { name: 'Kansas City Chiefs', price: 200 },
        { name: 'Philadelphia Eagles', price: 130 },
      ] }],
    },
    {
      key: 'kalshi',
      markets: [{ key: 'h2h', outcomes: [{ name: 'Kansas City Chiefs', price: 180 }] }],
    },
  ],
};
const best = bestTeamPrice(game, 'Kansas City Chiefs', {
  fetchedAt: fresh, now, maxAgeMs: 360000, pinnacleMaxDev: 0.03,
});
assert.strictEqual(best.book, 'pinnacle');
assert.strictEqual(best.american, -150);
assert.strictEqual(bestTeamPrice(game, 'Kansas City Chiefs', {
  fetchedAt: new Date(now - 400000).toISOString(), now, maxAgeMs: 360000, pinnacleMaxDev: 0.03,
}), null);

const ncaaf = parseNcaafTicker('KXNCAAFGAME-26SEP03MASSRUTG-MASS');
assert.ok(ncaaf);
assert.strictEqual(ncaaf.league, 'ncaaf');
assert.strictEqual(ncaaf.date, '2026-09-03');
assert.ok(ncaaf.teams.includes('mass') && ncaaf.teams.includes('rutg'));

const grouped = groupKalshiMarkets([
  { ticker: 'KXNFLGAME-26SEP13KCBUF-KC', yes_sub_title: 'Kansas City' },
  { ticker: 'KXNFLGAME-26SEP13KCBUF-BUF', yes_sub_title: 'Buffalo' },
  { ticker: 'KXMLBGAME-26SEP131840NYYBOS-NYY', yes_sub_title: 'Yankees' },
], new Set(['nfl']));
assert.strictEqual(grouped.length, 1);
assert.strictEqual(grouped[0].league, 'nfl');
assert.ok(grouped[0].kalshi.kc && grouped[0].kalshi.buf);

const linked = matchOddsToGame({
  home_team: 'Kansas City Chiefs',
  away_team: 'Buffalo Bills',
  commence_time: '2026-09-13T17:00:00Z',
  bookmakers: game.bookmakers,
}, grouped[0], { fetchedAt: fresh, now: Date.parse('2026-09-13T16:00:00Z'), maxAgeMs: 360000, pinnacleMaxDev: 0.03 });
assert.ok(linked);
assert.strictEqual(linked.odds.kc.american, -150);

const book = parseKalshiOrderbook({
  orderbook_fp: {
    yes_dollars: [['0.5400', '20']],
    no_dollars: [['0.4400', '15']],
  },
});
assert.strictEqual(book.bids[0].price, 0.54);
assert.strictEqual(book.asks[0].price, 0.56);
const polyBook = parsePolyBook({
  marketData: {
    bids: [{ px: { value: '0.38' }, qty: '20' }],
    offers: [{ px: { value: '0.42' }, qty: '10' }],
    stats: { lastTradePx: { value: '0.40' }, lastTradeQty: '5' },
  },
});
assert.strictEqual(polyBook.bids[0].price, 0.38);
assert.strictEqual(invertBook(polyBook).bids[0].price, 0.58);
const frame = parsePolyMarketMessage(JSON.stringify({
  trade: { marketSlug: 'aec-nfl-kc-buf-2026-09-13', price: { value: '0.41' }, quantity: { value: '8' }, tradeTime: '2026-09-13T17:01:00Z', tradeId: 't1' },
}));
assert.strictEqual(frame.trade.price, 0.41);
assert.strictEqual(frame.trade.qty, 8);

assert.throws(() => assertPaperReadOnly('POST', '/v1/orders'), /refuses/);
assert.throws(() => assertPaperReadOnly('GET', '/v1/orders'), /refuses/);
assert.throws(() => assertPaperReadOnly('GET', '/trade-api/v2/communications/quotes'), /refuses/);
assert.doesNotThrow(() => assertPaperReadOnly('GET', '/trade-api/v2/markets/trades'));
assert.doesNotThrow(() => assertPaperReadOnly('GET', '/v1/markets/abc/book'));

async function main() {
const publicReader = createKalshiReader({
  fetchFn: async (url) => ({
    status: 200,
    text: async () => '{"markets":[]}',
    called: url,
  }),
});
assert.strictEqual(publicReader.signed, false);
let fetched = null;
const traced = createKalshiReader({
  fetchFn: async (url) => {
    fetched = url;
    return { status: 200, text: async () => '{"markets":[]}' };
  },
});
const listed = await traced.get('/trade-api/v2/markets', 'limit=1');
assert.strictEqual(listed.json.markets.length, 0);
assert.strictEqual(fetched, `${KALSHI_PUBLIC_ORIGIN}/trade-api/v2/markets?limit=1`);
await assert.rejects(() => publicReader.get('/trade-api/v2/portfolio/balance'), /refuses/);

const lines = [];
let inserts = 0;
const paperLog = createPaperLog({
  writeFn: (line) => lines.push(line),
  insertFn: async () => {
    inserts += 1;
    const err = new Error("Could not find the table 'public.mm_paper_events' in the schema cache");
    err.code = 'PGRST205';
    throw err;
  },
  onError: () => {},
});
await paperLog.write({ kind: 'quote', gameId: 'g', cents: 40, american: -150 });
await paperLog.write({ kind: 'fill', gameId: 'g' });
assert.strictEqual(lines.length, 2);
assert.strictEqual(inserts, 1);
const rows = summarize(lines.map((l) => JSON.parse(l)));
assert.strictEqual(rows[0].quotes, 1);
assert.strictEqual(rows[0].fills, 1);

for (const file of [
  'start-live.js', 'start-all.js', 'start-unhedged.js', 'start-odds-relay.js',
  'live-runner.js', 'worker-mode.js', 'polymarket-rfq.js', 'engine.js',
  'desk-protect.js', 'odds-relay.js',
]) {
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(!src.includes('mm-paper'), `${file} must not reference paper MM`);
  assert.ok(!src.includes('MM_PAPER'), `${file} must not reference MM_PAPER`);
}
const runnerSrc = fs.readFileSync('mm-paper-runner.js', 'utf8');
assert.ok(!runnerSrc.includes('KALSHI_KEY_ID'), 'paper runner must not read the Combo Locks Kalshi key');
assert.ok(!runnerSrc.includes('startOddsRelay'), 'paper runner must not start the odds relay');
for (const file of fs.readdirSync('.').filter((f) => (
  (f.startsWith('mm-paper') || f === 'start-mm-paper.js') && !f.endsWith('.test.js')
))) {
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(!src.includes('createQuote'), `${file} must not create quotes`);
  assert.ok(!src.includes('confirmQuote'), `${file} must not confirm quotes`);
  assert.ok(!src.includes('live-runner'), `${file} must not load Combo Locks`);
  assert.ok(!src.includes('desk-protect'), `${file} must not load desk-protect`);
  assert.ok(!src.includes('polymarket-rfq'), `${file} must not load Combo Locks poly RFQ`);
  assert.ok(!src.includes("require('./odds-relay')") && !src.includes('require("./odds-relay")'), `${file} must not start the odds relay`);
  assert.ok(!src.includes('startOddsRelay'), `${file} must not start the odds relay`);
}

assert.strictEqual(americanFromProb(0.4), 150);
assert.strictEqual(americanFromProb(0.6), -150);
assert.ok(impliedProb(-150) > 0.59 && impliedProb(-150) < 0.61);
}

main().then(() => {
  console.log('mm-paper-math.test.js ok');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
