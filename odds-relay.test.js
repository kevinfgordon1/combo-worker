'use strict';
const assert = require('assert');
const {
  pairKeyFromSlug,
  noAskFromBid,
  bestAskFromOffers,
  usMarketsFromEvents,
  usQuotesFromMessage,
  usSubscribeMessage,
  relayKalshiCreds,
  willOpenKalshiWs,
  usOwnsPair,
  formatQuoteSse,
  mergeQuoteSnapshot,
  replaySnapshot,
  startOddsRelay,
  applyPolymarketStreamMessage,
  bestAskFromLevels,
  kalshiYesAskFromNoBids,
  pairFromTicker,
  quotesFromKalshiOrderbook,
} = require('./odds-relay');

{
  assert.strictEqual(noAskFromBid(0.54), 0.46);
  assert.strictEqual(pairKeyFromSlug('nfl-atl-gb-2026-09-24'), 'atl|gb');
  assert.strictEqual(pairKeyFromSlug('aec-nfl-atl-gb-2026-09-24'), 'atl|gb');
  assert.strictEqual(pairKeyFromSlug('nfl-atl-gb-2026-09-25'), 'atl|gb');
  const offers = [
    { px: { value: '0.99' }, qty: '10' },
    { px: { value: '0.56' }, qty: '4' },
    { px: { value: '0.50' }, qty: '0' },
  ];
  assert.strictEqual(bestAskFromOffers(offers), 0.56);
}

{
  const events = [{
    slug: 'nfl-atl-gb-2026-09-24',
    title: 'ATL Falcons vs GB Packers',
    startTime: '2026-09-25T00:15:00Z',
    live: true,
    markets: [{
      slug: 'aec-nfl-atl-gb-2026-09-24',
      sportsMarketType: 'football_team_full_game_winner',
      active: true,
      bestBidQuote: { value: '0.54', currency: 'USD' },
      bestAskQuote: { value: '0.56', currency: 'USD' },
      marketSides: [
        { long: true, team: { name: 'Atlanta Falcons', displayAbbreviation: 'ATL', ordering: 'away' } },
        { long: false, team: { name: 'Green Bay Packers', displayAbbreviation: 'GB', ordering: 'home' } },
      ],
    }, {
      slug: 'aec-nfl-atl-gb-2026-09-24-spread',
      sportsMarketType: 'football_team_full_game_spread',
      marketSides: [],
    }],
  }];
  const markets = usMarketsFromEvents(events, 'NFL', Date.parse('2026-09-25T01:00:00Z'));
  assert.strictEqual(markets.length, 1);
  assert.strictEqual(markets[0].yesName, 'Atlanta Falcons');
  assert.strictEqual(markets[0].noName, 'Green Bay Packers');
  assert.strictEqual(markets[0].pairKey, 'atl|gb');
  const catalog = new Map([[markets[0].slug, markets[0]]]);
  const lite = usQuotesFromMessage({
    marketDataLite: {
      marketSlug: 'aec-nfl-atl-gb-2026-09-24',
      bestBid: { value: '0.54' },
      bestAsk: { value: '0.56' },
      transactTime: '2026-09-25T01:00:01.000Z',
    },
  }, catalog, Date.parse('2026-09-25T01:00:01Z'));
  const yes = lite.find((q) => q.token_id.endsWith(':yes'));
  const no = lite.find((q) => q.token_id.endsWith(':no'));
  assert.strictEqual(yes.odds, 0.56);
  assert.strictEqual(yes.side, 'Atlanta Falcons');
  assert.strictEqual(no.odds, 0.46);
  assert.strictEqual(no.side, 'Green Bay Packers');
  assert.strictEqual(yes.feed, 'polymarket-us');
  const book = usQuotesFromMessage({
    marketData: {
      marketSlug: 'aec-nfl-atl-gb-2026-09-24',
      offers: offersWorstFirst(),
      bids: [{ px: { value: '0.54' }, qty: '8' }],
      transactTime: '2026-09-25T01:00:02.000Z',
    },
  }, catalog, Date.parse('2026-09-25T01:00:02Z'));
  assert.strictEqual(book.find((q) => q.side === 'Atlanta Falcons').odds, 0.56);
}

function offersWorstFirst() {
  return [
    { px: { value: '0.99' }, qty: '10' },
    { px: { value: '0.56' }, qty: '4' },
  ];
}

{
  const sub = usSubscribeMessage(['aec-nfl-atl-gb-2026-09-24'], 'req-1');
  assert.strictEqual(sub.subscribe.subscriptionType, 'SUBSCRIPTION_TYPE_MARKET_DATA_LITE');
  assert.strictEqual(sub.responsesDebounced, undefined);
  assert.deepStrictEqual(sub.subscribe.marketSlugs, ['aec-nfl-atl-gb-2026-09-24']);
}

{
  assert.strictEqual(relayKalshiCreds({
    KALSHI_KEY_ID: 'combo-key',
    Kalshi_combo_key: 'not-a-real-pem',
    KALSHI_PRIVATE_KEY: 'not-a-real-pem',
  }), null);
  assert.strictEqual(willOpenKalshiWs({ KALSHI_KEY_ID: 'combo-key', Kalshi_combo_key: 'pem' }), false);
  const opened = relayKalshiCreds({
    KALSHI_KEY_ID: 'combo-key',
    ODDS_RELAY_KALSHI_KEY_ID: 'relay-key',
    ODDS_RELAY_KALSHI_KEY: 'AAAA',
  });
  assert.strictEqual(opened.keyId, 'relay-key');
  assert.ok(!String(opened.pem).includes('combo-key'));
}

{
  const state = {
    usPairs: new Set(['atl|gb']),
    usSocketUp: true,
    usLastFrameAt: 0,
  };
  assert.strictEqual(usOwnsPair(state, 'atl|gb', 10_000), true);
  state.usSocketUp = false;
  state.usLastFrameAt = 0;
  assert.strictEqual(usOwnsPair(state, 'atl|gb', 20_000), false);
  state.usLastFrameAt = 10_000;
  assert.strictEqual(usOwnsPair(state, 'atl|gb', 20_000), true);
  assert.strictEqual(usOwnsPair(state, 'atl|gb', 30_000), false);
}

{
  const levels = [['0.99', '10'], ['0.36', '5'], ['0.01', '0']];
  assert.strictEqual(bestAskFromLevels(levels), 0.36);
  const store = new Map();
  const applied = applyPolymarketStreamMessage(store, {
    event_type: 'book',
    asset_id: 'tok',
    timestamp: 1000,
    bids: [['0.01', '10'], ['0.30', '4']],
    asks: [['0.99', '10'], ['0.36', '5']],
  });
  assert.strictEqual(applied[0].bestAsk, 0.36);
  assert.strictEqual(kalshiYesAskFromNoBids([['0.01', '10'], ['0.70', '3']]), 0.3);
  assert.deepStrictEqual(pairFromTicker('KXNFLGAME-26SEP24ATLGB-ATL'), ['ATL', 'GB']);
  assert.deepStrictEqual(pairFromTicker('KXMLBGAME-26SEP241905TBNYY-TB'), ['TB', 'NYY']);
}

{
  const relay = startOddsRelay({ upstream: false });
  const yes = {
    book: 'polymarket', book_id: 193, league: 'NFL', away: 'Atlanta Falcons', home: 'Green Bay Packers',
    side: 'Atlanta Falcons', bet_type: 'moneyline', odds: 0.56, is_live: true,
    updated_at: '2026-09-25T01:00:00.000Z', token_id: 'us:aec:yes', feed: 'polymarket-us', pair_key: 'atl|gb',
  };
  const no = { ...yes, side: 'Green Bay Packers', odds: 0.46, token_id: 'us:aec:no' };
  const clob = {
    ...yes, odds: 0.55, token_id: 'clob-token', feed: 'clob', updated_at: '2026-09-25T01:00:05.000Z',
  };
  relay.publish('polymarket', 'NFL', [clob], 'snapshot', 'clob');
  assert.strictEqual(relay.state.books.polymarket.NFL.get('clob-token').odds, 0.55);
  relay.publish('polymarket', 'NFL', [yes, no], 'snapshot', 'polymarket-us');
  assert.strictEqual(relay.state.books.polymarket.NFL.get('clob-token').odds, 0.55, 'gateway seed does not evict CLOB while the US socket is down');
  relay.state.usSocketUp = true;
  relay.publish('polymarket', 'NFL', [yes, no], 'snapshot', 'polymarket-us');
  assert.strictEqual(relay.state.books.polymarket.NFL.has('clob-token'), false);
  assert.strictEqual(relay.state.books.polymarket.NFL.size, 2);
  const seen = [];
  const unsub = relay.state.channels.polymarket.NFL.subscribe((packet) => seen.push(packet));
  assert.strictEqual(seen[0].complete, true);
  assert.strictEqual(seen[0].quotes.length, 2);
  relay.publish('polymarket', 'NFL', [{ ...yes, odds: 0.57, updated_at: '2026-09-25T01:00:06.000Z' }], 'ws', 'polymarket-us');
  assert.strictEqual(seen[seen.length - 1].complete, false);
  assert.strictEqual(seen[seen.length - 1].quotes.length, 1);
  assert.strictEqual(relay.state.books.polymarket.NFL.size, 2);
  const late = [];
  relay.state.channels.polymarket.NFL.subscribe((packet) => late.push(packet));
  assert.strictEqual(late[0].complete, true);
  assert.strictEqual(late[0].quotes.length, 2);
  relay.publish('polymarket', 'NFL', [{ ...clob, odds: 0.4, updated_at: '2026-09-25T01:00:07.000Z' }], 'ws', 'clob');
  assert.strictEqual(relay.state.books.polymarket.NFL.has('clob-token'), false);
  relay.state.usSocketUp = false;
  relay.state.usLastFrameAt = Date.now() - 20_000;
  relay.publish('polymarket', 'NFL', [{ ...clob, odds: 0.41, updated_at: '2026-09-25T01:00:30.000Z' }], 'ws', 'clob');
  assert.strictEqual(relay.state.books.polymarket.NFL.get('clob-token').odds, 0.41);
  unsub();
  const sse = formatQuoteSse(seen[0].quotes, '2026-09-25T01:00:00.000Z', {
    source: 'polymarket', complete: false, mode: 'ws',
  });
  assert.match(sse, /"complete":false/);
  const replaced = mergeQuoteSnapshot(
    { quotes: [clob], complete: true },
    { quotes: [yes, no], complete: true, mode: 'snapshot' },
  );
  assert.strictEqual(replaced.quotes.length, 2);
  assert.strictEqual(replaySnapshot({ quotes: [yes], complete: false }).complete, true);
  relay.close();
}

{
  const books = new Map();
  const meta = new Map([['T', {
    book: 'kalshi', book_id: 194, league: 'NFL', away: 'Atlanta Falcons', home: 'Green Bay Packers',
    side: 'Atlanta Falcons', bet_type: 'moneyline', is_live: true, odds: 0.5, ticker: 'T',
  }]]);
  const snap = quotesFromKalshiOrderbook({
    type: 'orderbook_snapshot',
    msg: { market_ticker: 'T', no_dollars: [['0.01', '10'], ['0.31', '5']], ts: 1000 },
  }, books, meta);
  assert.strictEqual(snap[0].odds, 0.69);
  const delta = quotesFromKalshiOrderbook({
    type: 'orderbook_delta',
    msg: { market_ticker: 'T', side: 'no', price_dollars: '0.40', delta_fp: '2', ts: 2000 },
  }, books, meta);
  assert.strictEqual(delta[0].odds, 0.6);
}

(async () => {
  const relay = startOddsRelay({ upstream: false });
  const addr = await relay.listen(0, '127.0.0.1');
  relay.publish('kalshi', 'NFL', [{
    book: 'kalshi', book_id: 194, league: 'NFL', away: 'Atlanta Falcons', home: 'Green Bay Packers',
    side: 'Atlanta Falcons', bet_type: 'moneyline', odds: 0.69, is_live: true,
    updated_at: '2026-09-25T01:00:00.000Z', ticker: 'KXNFLGAME-26SEP24ATLGB-ATL',
  }], 'snapshot', 'kalshi-rest');
  const board = await fetch(`http://127.0.0.1:${addr.port}/board?league=NFL&venue=kalshi`);
  const body = await board.json();
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.quotes[0].odds, 0.69);
  const health = await fetch(`http://127.0.0.1:${addr.port}/health`);
  assert.strictEqual((await health.json()).ok, true);
  const opt = await fetch(`http://127.0.0.1:${addr.port}/stream?league=NFL&venue=polymarket`, { method: 'OPTIONS' });
  assert.strictEqual(opt.status, 204);
  assert.strictEqual(opt.headers.get('access-control-allow-origin'), '*');
  const stream = await fetch(`http://127.0.0.1:${addr.port}/stream?league=NFL&venue=kalshi`, {
    headers: { Accept: 'text/event-stream' },
  });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  assert.match(text, /event: quote/);
  assert.match(text, /"source":"kalshi"/);
  assert.match(text, /"complete":true/);
  await reader.cancel();
  await relay.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
