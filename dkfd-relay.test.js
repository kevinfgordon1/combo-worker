'use strict';
// DraftKings / FanDuel public-JSON feed on the odds relay (DKFD_FEED=1).
const assert = require('assert');
const http = require('http');
const { dkfdFeed: f, publishDkfd, createDkfdState, dkfdEnabled, dkfdLeagues, startOddsRelay } = require('./odds-relay');
const fx = require('./fixtures-dkfd.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // American odds parsing (DK uses U+2212 for minus).
  assert.strictEqual(f.americanInt('\u2212455'), -455);
  assert.strictEqual(f.americanInt('+350'), 350);
  assert.strictEqual(f.americanInt(-110), -110);
  assert.strictEqual(f.americanInt('0.55'), null);
  assert.strictEqual(f.americanInt(null), null);
  assert.strictEqual(f.cleanTeam('Milwaukee Brewers (F Peralta)'), 'Milwaukee Brewers');

  // DK league JSON -> moneyline / spread / total quotes.
  const dk = f.quotesFromDraftKings(fx.draftkings, 'NFL', { nowMs: 1_790_000_000_000 });
  assert.strictEqual(dk.length, 6);
  const dkMl = dk.filter((q) => q.bet_type === 'moneyline');
  assert.deepStrictEqual(dkMl.map((q) => [q.side_type, q.side, q.odds]), [['Away', 'TB Buccaneers', 350], ['Home', 'DAL Cowboys', -455]]);
  const dkSpr = dk.find((q) => q.bet_type === 'spread' && q.side_type === 'Home');
  assert.strictEqual(dkSpr.line, -8.5);
  assert.strictEqual(dkSpr.odds, -112);
  const dkOver = dk.find((q) => q.side_type === 'Over');
  assert.strictEqual(dkOver.line, 47.5);
  assert.strictEqual(dkOver.side, 'Over');
  for (const q of dk) {
    assert.strictEqual(q.book, 'draftkings');
    assert.strictEqual(q.book_id, 200);
    assert.strictEqual(q.away, 'TB Buccaneers');
    assert.strictEqual(q.home, 'DAL Cowboys');
    assert.ok(q.start.startsWith('2026-10-09T00:15'));
    assert.ok(/^dk:\d+:(moneyline|spread|total):(Away|Home|Over|Under)$/.test(q.token_id), q.token_id);
  }

  // FD page -> catalog; prices from getMarketPrices override the cached page.
  const cat = f.fdCatalogFromPage(fx.fanduel, 'NFL', 1_790_000_000_000);
  assert.strictEqual(cat.markets.size, 3);
  const pageQuotes = f.quotesFromFdState(cat, new Map(), 'NFL', 1_790_000_000_000);
  assert.strictEqual(pageQuotes.length, 6);
  assert.ok(pageQuotes.every((q) => q.price_source === 'page' && q.book_id === 100));
  const fdMlAway = pageQuotes.find((q) => q.bet_type === 'moneyline' && q.side_type === 'Away');
  assert.strictEqual(fdMlAway.side, 'Minnesota Vikings');
  assert.strictEqual(fdMlAway.odds, -130);
  const priceRows = [{
    marketId: '734.188987842', marketStatus: 'OPEN', inplay: false,
    runnerDetails: [
      { selectionId: 50191, handicap: 0, runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOddsInt: -140 } } },
      { selectionId: 50196, handicap: 0, runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOddsInt: 118 } } },
    ],
  }, {
    marketId: '734.188987843', marketStatus: 'SUSPENDED', inplay: true,
    runnerDetails: [
      { selectionId: 50191, handicap: -2.5, runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOddsInt: -105 } } },
      { selectionId: 50196, handicap: 2.5, runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOddsInt: -115 } } },
    ],
  }];
  const prices = f.fdPricesFromBody(priceRows, 1_790_000_000_500);
  const fd = f.quotesFromFdState(cat, prices, 'NFL', 1_790_000_001_000);
  const ml = fd.filter((q) => q.bet_type === 'moneyline');
  assert.deepStrictEqual(ml.map((q) => [q.side_type, q.odds, q.price_source]), [['Away', -140, 'prices'], ['Home', 118, 'prices']]);
  const spr = fd.filter((q) => q.bet_type === 'spread');
  assert.deepStrictEqual(spr.map((q) => [q.side_type, q.line, q.suspended, q.is_live]), [['Away', -2.5, true, true], ['Home', 2.5, true, true]]);
  // A price row older than the trust window falls back to the page.
  const old = f.quotesFromFdState(cat, prices, 'NFL', 1_790_000_000_500 + 6 * 60_000);
  assert.ok(old.every((q) => q.price_source === 'page'));

  // Batch picker: <= 80 ids, hot (soon / in-play) markets every time, rest rotate.
  const bigCat = { markets: new Map() };
  const now = 1_790_000_000_000;
  for (let i = 0; i < 200; i += 1) {
    const soon = i < 10;
    bigCat.markets.set(`m${i}`, { marketId: `m${i}`, betType: i % 3 === 0 ? 'moneyline' : 'spread', inPlay: false, start: new Date(now + (soon ? 3600_000 : 3 * 86400_000)).toISOString() });
  }
  const b1 = f.fdPriceBatch(bigCat, 0, now);
  assert.strictEqual(b1.ids.length, f.FD_PRICE_BATCH);
  for (let i = 0; i < 10; i += 1) assert.ok(b1.ids.includes(`m${i}`));
  const b2 = f.fdPriceBatch(bigCat, b1.cursor, now);
  for (let i = 0; i < 10; i += 1) assert.ok(b2.ids.includes(`m${i}`));
  const rest1 = b1.ids.filter((id) => !/^m\d$/.test(id));
  const rest2 = b2.ids.filter((id) => !/^m\d$/.test(id));
  assert.ok(rest1.every((id) => !rest2.includes(id)), 'rest rotates');

  // Change times: an unchanged price keeps its original updated_at.
  const prevMap = new Map(dk.map((q) => [q.token_id, q]));
  const later = f.quotesFromDraftKings(fx.draftkings, 'NFL', { nowMs: 1_790_000_100_000 });
  const carried = f.carryChangeTimes(prevMap, later);
  assert.ok(carried.every((q) => q.updated_at === new Date(1_790_000_000_000).toISOString()));
  const moved = later.map((q) => (q.bet_type === 'moneyline' && q.side_type === 'Away' ? { ...q, odds: 360 } : q));
  const carried2 = f.carryChangeTimes(prevMap, moved);
  assert.strictEqual(carried2.find((q) => q.odds === 360).updated_at, new Date(1_790_000_100_000).toISOString());

  // Flag + leagues.
  assert.strictEqual(dkfdEnabled({}), false);
  assert.strictEqual(dkfdEnabled({ DKFD_FEED: '1' }), true);
  assert.strictEqual(dkfdEnabled({ DKFD_FEED: 'on' }), true);
  assert.deepStrictEqual(dkfdLeagues({}), ['NFL', 'NCAAF', 'MLB', 'NHL']);
  assert.deepStrictEqual(dkfdLeagues({ DKFD_LEAGUES: 'nfl, ncaaf ,XFL' }), ['NFL', 'NCAAF']);

  // publishDkfd: first full set is a snapshot, then only changes, removal
  // is a fresh snapshot, and a feed heartbeat follows every poll.
  {
    const state = { dkfd: createDkfdState(['NFL']) };
    const packets = [];
    const feeds = [];
    state.dkfd.channels.draftkings.NFL.subscribe((p) => packets.push(p), (i) => feeds.push(i));
    const h = { book: 'draftkings', league: 'NFL', state: 'ok', last_ok_at: 1, quotes: 6 };
    publishDkfd(state, 'draftkings', 'NFL', dk, { health: h });
    assert.strictEqual(packets.length, 1);
    assert.strictEqual(packets[0].complete, true);
    assert.strictEqual(packets[0].quotes.length, 6);
    publishDkfd(state, 'draftkings', 'NFL', dk, { health: { ...h, last_ok_at: 2 } });
    assert.strictEqual(packets.length, 1, 'no change, no quote packet');
    assert.strictEqual(feeds.length, 2);
    assert.strictEqual(feeds[1].last_ok_at, 2);
    publishDkfd(state, 'draftkings', 'NFL', moved, { health: h });
    assert.strictEqual(packets.length, 2);
    assert.strictEqual(packets[1].complete, false);
    assert.deepStrictEqual(packets[1].quotes.map((q) => q.odds), [360]);
    publishDkfd(state, 'draftkings', 'NFL', moved.slice(2), { health: h });
    assert.strictEqual(packets[2].complete, true);
    assert.strictEqual(packets[2].quotes.length, 4);
  }

  // Poller: 403 Akamai page -> blocked state with long backoff (no hammering).
  {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return { ok: false, status: 403, text: async () => '<HTML><TITLE>Access Denied</TITLE>', headers: { get: () => null } };
    };
    const p = f.createDkFdPoller({ books: ['draftkings'], leagues: ['NFL'], fetchFn, pollMs: 3000, blockedBaseMs: 60_000 }).start();
    await sleep(80);
    const hh = p.health().draftkings.NFL;
    assert.strictEqual(hh.state, 'blocked');
    assert.strictEqual(hh.blocked, 1);
    assert.strictEqual(hh.last_status, 403);
    assert.strictEqual(calls, 1);
    p.stop();
    assert.ok(f.nextDelayMs(4000, 3, null) >= 32_000);
    assert.strictEqual(f.nextDelayMs(4000, 1, 120), 120_000);
  }

  // Poller happy path with fake fetch for both books.
  {
    const fetchFn = async (url, init) => {
      if (url.includes('draftkings')) return { ok: true, status: 200, json: async () => fx.draftkings };
      if (url.includes('getMarketPrices')) {
        const ids = JSON.parse(init.body).marketIds;
        assert.ok(ids.length <= 80);
        return { ok: true, status: 200, json: async () => priceRows.filter((r) => ids.includes(r.marketId)) };
      }
      return { ok: true, status: 200, json: async () => fx.fanduel };
    };
    const got = {};
    const p = f.createDkFdPoller({ leagues: ['NFL'], fetchFn, pollMs: 3000, onQuotes: (book, league, quotes) => { got[book] = (got[book] || []).concat([quotes]); } }).start();
    await sleep(4900);
    p.stop();
    assert.ok(got.draftkings && got.draftkings[0].length === 6);
    assert.ok(got.fanduel && got.fanduel.length >= 2, 'catalog then prices');
    const last = got.fanduel[got.fanduel.length - 1];
    assert.strictEqual(last.find((q) => q.bet_type === 'moneyline' && q.side_type === 'Away').odds, -140);
  }

  // Relay routes: off -> 503; on -> /board and /stream with feed events.
  {
    const off = startOddsRelay({ upstream: false, betstamp: false, underdog: false, env: {} });
    const addr = await off.listen(0, '127.0.0.1');
    const body = await new Promise((resolve) => http.get(`http://127.0.0.1:${addr.port}/board?venue=draftkings&league=NFL`, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, b }));
    }));
    assert.strictEqual(body.status, 503);
    assert.ok(body.b.includes('dkfd_feed_off'));
    await off.close();

    const fetchFn = async (url) => {
      if (url.includes('draftkings')) return { ok: true, status: 200, json: async () => fx.draftkings };
      if (url.includes('getMarketPrices')) return { ok: true, status: 200, json: async () => priceRows };
      return { ok: true, status: 200, json: async () => fx.fanduel };
    };
    const on = startOddsRelay({ upstream: false, betstamp: false, underdog: false, env: { DKFD_FEED: '1', DKFD_LEAGUES: 'NFL' }, dkfdFetch: fetchFn, dkfdPollMs: 3000 });
    const a2 = await on.listen(0, '127.0.0.1');
    await sleep(1800);
    const board = await new Promise((resolve) => http.get(`http://127.0.0.1:${a2.port}/board?venue=fanduel&league=NFL`, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(JSON.parse(b)));
    }));
    assert.strictEqual(board.ok, true);
    assert.strictEqual(board.quotes.length, 6);
    assert.strictEqual(board.feed.state, 'ok');
    const bad = await new Promise((resolve) => http.get(`http://127.0.0.1:${a2.port}/board?venue=fanduel&league=MLB`, (res) => { res.resume(); resolve(res.statusCode); }));
    assert.strictEqual(bad, 400);
    const sse = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${a2.port}/stream?venue=draftkings&league=NFL`, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        setTimeout(() => { req.destroy(); resolve(b); }, 300);
      });
    });
    assert.ok(sse.includes('event: quote'));
    assert.ok(sse.includes('event: feed'));
    assert.ok(sse.indexOf('event: quote') < sse.indexOf('event: feed'));
    const health = await new Promise((resolve) => http.get(`http://127.0.0.1:${a2.port}/health`, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(JSON.parse(b)));
    }));
    assert.strictEqual(health.dkfd.draftkings.NFL.state, 'ok');
    await on.close();
  }

  console.log('dkfd-relay.test.js ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
