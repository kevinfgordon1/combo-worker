'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const px = require('./prophetx-feed');
const { rowsFromRelayQuotes, createProphetXClient, hasProphetXCreds } = require('./noboost/prophetx-live');

const sel = (name, price, value, extra = {}) => ({ name, display_name: name, price, value, quantity: value, outcome_id: extra.o || 1, competitor_id: extra.c, strike: extra.strike, updated_at: 1792645130163088000 });
const restMarkets = [
  { id: 1, sub_type: 'moneyline', type: 'moneyline', line: 0, selections: [[{ name: 'Chicago Bears', odds: -146, value: 822.93, stake: 563.65, outcome_id: 4, competitor_id: 10 }, { name: 'Chicago Bears', odds: -150, value: 385, outcome_id: 4, competitor_id: 10 }], [{ name: 'New England Patriots', odds: 132, value: 300, outcome_id: 5, competitor_id: 11 }]] },
  { id: 64, sub_type: 'first_half_moneyline', type: 'moneyline', line: 0, selections: [[], []] },
  { id: 223, sub_type: 'spread', type: 'spread', market_lines: [
    { line: -10.5, selections: [[{ name: 'Chicago Bears -10.5', odds: 385, value: 46.6, line: -10.5, outcome_id: 1714, competitor_id: 10 }], [{ name: 'New England Patriots +10.5', odds: -520, value: 335, line: 10.5, outcome_id: 1715, competitor_id: 11 }]] },
    { line: -2.5, selections: [[{ name: 'Chicago Bears -2.5', odds: -105, value: 500, line: -2.5, outcome_id: 1714, competitor_id: 10 }], [{ name: 'New England Patriots +2.5', odds: -110, value: 400, line: 2.5, outcome_id: 1715, competitor_id: 11 }]] },
  ] },
  { id: 225, sub_type: 'total', type: 'total', market_lines: [{ line: 44.5, selections: [[{ name: 'over 44.5', odds: -108, value: 1000, line: 44.5, outcome_id: 12 }], [{ name: 'under 44.5', odds: -112, value: 900, line: 44.5, outcome_id: 13 }]] }] },
];

{
  const mains = px.mainMarketsFromRest(restMarkets);
  assert.deepStrictEqual(mains.map((m) => m.subType), ['moneyline', 'spread', 'total']);
  assert.strictEqual(px.probFromAmerican(-150), 0.6);
  assert.strictEqual(px.nsToMs(1792645130163088000), 1792645130163);
  const frame = { event: 'v2.market_selections', data: JSON.stringify({ op: 'u', change_type: 'market_selections', payload: Buffer.from(JSON.stringify({ market_id: 223, sport_event_id: 99, info: { id: 223, strike: -2.5, status: 'active', sequence_number: 7, selections: [[sel('Chicago Bears -2.5', 101, 250, { strike: -2.5, c: 10, o: 1714 })], [sel('New England Patriots +2.5', -121, 700, { strike: 2.5, c: 11, o: 1715 })]] } })).toString('base64') }) };
  const u = px.decodePushFrame(frame);
  assert.strictEqual(u.eventId, 99); assert.strictEqual(u.marketId, 223); assert.strictEqual(u.strike, -2.5); assert.strictEqual(u.seq, 7);
  assert.ok(u.sentAtMs > 0);
  assert.strictEqual(px.decodePushFrame({ event: 'market_selections', data: '{}' }), null);
  console.log('prophetx decode ok');
}

// End to end with fake ProphetX REST + push socket.
(async () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const path = url.replace(/^https:\/\/[^/]+\/partner/, '');
    calls.push(path);
    assert.ok(!/order|cancel|place/i.test(path), `never an order endpoint: ${path}`);
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
    if (path === '/auth/login') return ok({ access_token: 'T', refresh_token: 'R' });
    if (path === '/websocket/connection-config') return ok({ key: 'k', ws_host: 'ws.example', cluster: 'mt1' });
    if (path.startsWith('/mm/get_sport_events')) {
      if (!path.endsWith('=31')) return ok({ sport_events: [] });
      return ok({ sport_events: [{ event_id: 99, status: 'not_started', scheduled: '2026-10-23T00:15:00Z', competitors: [{ id: 10, side: 'home', display_name: 'Chicago Bears' }, { id: 11, side: 'away', display_name: 'New England Patriots' }] }] });
    }
    if (path.startsWith('/v2/mm/get_markets')) return ok({ markets: restMarkets });
    if (path === '/v4/mm/websocket') {
      const body = JSON.parse(init.body);
      assert.strictEqual(init.headers['X-CFTC-Terminology'], 'true');
      assert.deepStrictEqual(body.subscriptions, [{ type: 'event', ids: ['99'] }]);
      return ok({ channel_limit: 500, authenticated: { auth: 'a', user_data: '{}' }, authorized_channel: [
        { channel_name: 'private-service=6-device_type=5-user=x', auth: 'u' },
        { channel_name: 'private-broadcast-service=6-device_type=5-event=99', auth: 'e', scope: { event_id: 99 } }] });
    }
    throw new Error(`unexpected ${path}`);
  };
  let sock;
  class FakeWs extends EventEmitter { constructor(url) { super(); this.url = url; this.sent = []; sock = this; setImmediate(() => this.emit('message', JSON.stringify({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '1.2' }) }))); } send(m) { this.sent.push(JSON.parse(m)); } close() {} terminate() {} }
  const got = [];
  const feed = px.createProphetXFeed({ env: { PROPHETX_ACCESS_KEY: 'a', PROPHETX_SECRET_KEY: 'b', PROPHETX_LEAGUES: 'NFL', PROPHETX_REST_RPS: '1' }, fetchFn, WebSocket: FakeWs, log: () => {}, onQuotes: (league, quotes, mode) => got.push({ league, quotes, mode }) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !got.length; i += 1) await wait(100);
  assert.ok(got.length, 'snapshot published');
  const snap = got[got.length - 1].quotes;
  const ml = snap.find((q) => q.bet_type === 'moneyline' && q.side === 'Chicago Bears');
  assert.strictEqual(ml.american, -146); assert.strictEqual(ml.size, 822.93); assert.strictEqual(ml.depth.length, 2);
  const sp = snap.filter((q) => q.bet_type === 'spread');
  assert.deepStrictEqual(sp.map((q) => [q.side, q.line, q.american]), [['Chicago Bears', -2.5, -105], ['New England Patriots', 2.5, -110]]);
  const tot = snap.filter((q) => q.bet_type === 'total');
  assert.deepStrictEqual(tot.map((q) => [q.side, q.line]), [['Over', 44.5], ['Under', 44.5]]);
  assert.ok(!snap.some((q) => q.bet_type === 'first_half_moneyline'));
  // subscribed only to the event channel (not the private orders channel)
  for (let i = 0; i < 30 && !sock.sent.some((m) => m.event === 'pusher:subscribe'); i += 1) await wait(50);
  const subs = sock.sent.filter((m) => m.event === 'pusher:subscribe').map((m) => m.data.channel);
  assert.deepStrictEqual(subs, ['private-broadcast-service=6-device_type=5-event=99']);
  // a push moves the spread
  const n = got.length;
  sock.emit('message', JSON.stringify({ event: 'v2.market_selections', data: JSON.stringify({ op: 'u', payload: Buffer.from(JSON.stringify({ market_id: 223, sport_event_id: 99, info: { strike: -2.5, status: 'active', selections: [[sel('Chicago Bears -2.5', 101, 250, { strike: -2.5, c: 10, o: 1714 })], [sel('New England Patriots +2.5', -121, 700, { strike: 2.5, c: 11, o: 1715 })]] } })).toString('base64') }) }));
  for (let i = 0; i < 30 && got.length === n; i += 1) await wait(50);
  const pushed = got[got.length - 1];
  assert.strictEqual(pushed.mode, 'ws');
  const bears = pushed.quotes.find((q) => q.bet_type === 'spread' && q.side === 'Chicago Bears');
  assert.strictEqual(bears.american, 101); assert.strictEqual(bears.feed, 'ws');
  const h = feed.health();
  assert.strictEqual(h.ws, 'up'); assert.strictEqual(h.wsUpdates, 1); assert.strictEqual(h.events.NFL, 1); assert.strictEqual(h.channels, 1);
  feed.stop();

  // relay wiring: off by default, publishes 'prophetx' venue when on
  const relay = require('./odds-relay');
  const off = relay.startOddsRelay({ upstream: false, betstamp: false, underdog: false });
  assert.strictEqual(off.state.status.prophetx, 'off');
  await off.close();
  const st = relay.createState();
  relay.publishProphetX(st, 'NFL', snap, 'rest');
  assert.strictEqual(st.books.prophetx.NFL.size, snap.length);

  // sniper/noboost relay mode
  assert.strictEqual(hasProphetXCreds({ PROPHETX_AUTH_MODE: 'relay' }), false);
  assert.strictEqual(hasProphetXCreds({ PROPHETX_AUTH_MODE: 'relay', SNIPER_ODDS_RELAY_URL: 'http://r' }), true);
  const rows = rowsFromRelayQuotes(snap);
  assert.deepStrictEqual(rows.map((r) => r.side).sort(), ['Chicago Bears', 'New England Patriots']);
  assert.deepStrictEqual(rows.find((r) => r.side === 'Chicago Bears').levels[0], { american: -146, size: 822.93 });
  const client = createProphetXClient({ env: { PROPHETX_AUTH_MODE: 'relay', PROPHETX_RELAY_URL: 'http://r/' }, fetchImpl: async (u) => { assert.strictEqual(u, 'http://r/board?venue=prophetx&league=NFL'); return { ok: true, json: async () => ({ quotes: snap }) }; } });
  assert.strictEqual((await client.nflMoneylines()).length, 2);
  console.log('prophetx feed e2e ok');
})().catch((e) => { console.error(e); process.exit(1); });

// ProphetX anytime-TD markets kept only when asked (relay RELAY_TD), with the player name.
{
  const assert = require('assert');
  const px = require('./prophetx-feed');
  const raw = [{ id: 9, sub_type: 'to_score_a_touchdown', type: 'moneyline', line: 0, name: 'Devaughn Vele To Score a Touchdown', selections: [[{ name: 'YES', odds: 117, value: 400 }], [{ name: 'NO', odds: -150, value: 300 }]] }, { id: 1, sub_type: 'moneyline', type: 'moneyline', selections: [[], []] }];
  assert.strictEqual(px.mainMarketsFromRest(raw).length, 1);
  const withTd = px.mainMarketsFromRest(raw, { td: true });
  assert.strictEqual(withTd.length, 2);
  assert.strictEqual(withTd.find((m) => m.marketId === 9).player, 'Devaughn Vele');
  console.log('prophetx td markets ok');
}
