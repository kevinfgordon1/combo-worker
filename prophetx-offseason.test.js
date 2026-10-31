'use strict';
// MLB off-season: ProphetX answers 404 data_not_found on get_sport_events for tournament 109.
// That must not stop NFL / NBA discovery or snapshots (relay sat at 'starting' with 0 quotes).
const assert = require('assert');
const { EventEmitter } = require('events');
const px = require('./prophetx-feed');

(async () => {
  const calls = [];
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  const ev = (id, home, away) => ({ event_id: id, status: 'not_started', scheduled: '2026-11-01T17:00:00Z', competitors: [{ id: id * 10, side: 'home', display_name: home }, { id: id * 10 + 1, side: 'away', display_name: away }] });
  const ml = (home, away) => [{ id: 1, sub_type: 'moneyline', type: 'moneyline', line: 0, selections: [[{ name: home, odds: -120, value: 300, outcome_id: 1 }], [{ name: away, odds: 105, value: 200, outcome_id: 2 }]] }];
  const fetchFn = async (url) => {
    const path = url.replace(/^https:\/\/[^/]+\/partner/, '');
    calls.push(path);
    assert.ok(!/order|cancel|place/i.test(path), `never an order endpoint: ${path}`);
    if (path === '/auth/login') return ok({ access_token: 'T', refresh_token: 'R' });
    if (path.startsWith('/mm/get_sport_events')) {
      if (path.endsWith('=109')) return { ok: false, status: 404, json: async () => ({ error: 'data_not_found' }) };
      if (path.endsWith('=31')) return ok({ sport_events: [ev(7, 'Jacksonville Jaguars', 'Indianapolis Colts')] });
      if (path.endsWith('=132')) return ok({ sport_events: [ev(8, 'Dallas Mavericks', 'Houston Rockets')] });
      return ok({ sport_events: [] });
    }
    if (path.includes('event_id=7')) return ok({ markets: ml('Jacksonville Jaguars', 'Indianapolis Colts') });
    if (path.includes('event_id=8')) return ok({ markets: ml('Dallas Mavericks', 'Houston Rockets') });
    throw new Error(`unexpected ${path}`);
  };
  class FakeWs extends EventEmitter { send() {} close() {} terminate() {} }
  const got = {};
  const feed = px.createProphetXFeed({ env: { PROPHETX_ACCESS_KEY: 'a', PROPHETX_SECRET_KEY: 'b', PROPHETX_LEAGUES: 'NFL,MLB,NBA', MLB_ENABLED: '1', PROPHETX_REST_RPS: '1', PROPHETX_PUSH: '0' }, fetchFn, WebSocket: FakeWs, log: () => {}, onQuotes: (league, quotes) => { got[league] = quotes; } });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !(got.NFL && got.NFL.length && got.NBA && got.NBA.length); i += 1) await wait(100);
  const h = feed.health();
  feed.stop();
  assert.ok(got.NFL && got.NFL.length === 2, 'NFL published despite MLB 404');
  assert.ok(got.NBA && got.NBA.length === 2, 'NBA (after MLB in the list) discovered and published');
  assert.strictEqual(h.events.MLB, 0);
  assert.strictEqual(h.rest, 'up');
  assert.strictEqual(h.lastRestError, null, '404 empty league is not an error');
  assert.deepStrictEqual(h.leagueErrors, {});
  console.log('prophetx offseason 404 ok');
})().catch((e) => { console.error(e); process.exit(1); });
