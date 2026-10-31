'use strict';
// NCAAB (men's college basketball) on the odds relay (Kevin Oct 30 2026): moneylines only, D1 vs D1 only,
// ESPN tip times, Polymarket US on its own subscription so the 100 main slugs are never crowded out.
const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const R = require('./odds-relay');

(async () => {
  // League list + slug pair key
  assert.ok(R.LEAGUES.includes('NCAAB'), 'NCAAB served by default (RELAY_NCAAB=0 turns it off)');
  assert.strictEqual(R.LEAGUES[R.LEAGUES.length - 1], 'NCAAB', 'NCAAB last: never ahead of NFL / NBA');
  assert.strictEqual(R.pairKeyFromSlug('aec-cbb-vill-nd-2026-11-01'), 'nd|vill');
  assert.ok(R.createState().books.kalshi.NCAAB instanceof Map);
  // ESPN: D1 board (groups=50) for today + the next two ET days
  const urls = R.espnBoardUrls('NCAAB', Date.parse('2026-11-01T16:00:00Z'));
  assert.strictEqual(urls.length, 3);
  assert.ok(urls.every((u) => /mens-college-basketball\/scoreboard\?groups=50&limit=500&dates=2026110[123]$/.test(u)), urls.join(' '));
  assert.deepStrictEqual(R.espnBoardUrls('NBA'), ['https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard']);

  // Scope: D1 vs D1 only, inside 48h (or live)
  const now = Date.parse('2026-11-01T12:00:00Z');
  assert.strictEqual(R.ncaabInScope('Villanova', 'Notre Dame', '2026-11-01T14:30:00Z', false, now), true);
  assert.strictEqual(R.ncaabInScope('Fisk', 'Belmont', '2026-11-01T14:30:00Z', false, now), false, 'non-D1 opponent dropped');
  assert.strictEqual(R.ncaabInScope('Villanova', 'Notre Dame', '2026-11-04T14:30:00Z', false, now), false, 'beyond 48h');
  assert.strictEqual(R.ncaabInScope('Villanova', 'Notre Dame', '2026-11-01T10:00:00Z', true, now), true, 'live');

  // Kalshi quotes -> ESPN tip time + home/away by D1 team (Kalshi codes are not ESPN abbreviations)
  const espn = { events: [{ date: '2026-11-01T14:30Z', competitions: [{ status: { type: { state: 'pre' } }, competitors: [
    { homeAway: 'home', team: { id: '87', abbreviation: 'ND', displayName: 'Notre Dame Fighting Irish' } },
    { homeAway: 'away', team: { id: '222', abbreviation: 'VILL', displayName: 'Villanova Wildcats' } },
  ] }] }] };
  const sched = R.scheduleFromEspn(espn);
  assert.deepStrictEqual(sched[0].ids.sort(), ['222', '87']);
  const q = [{ league: 'NCAAB', ticker: 'KXNCAAMBGAME-26NOV01NDVILL-VILL', away: 'Notre Dame', home: 'Villanova', side: 'Villanova', start: '2026-11-01T14:30:00.000Z' }];
  R.applyKalshiSchedule(q, sched, now);
  assert.strictEqual(q[0].start, '2026-11-01T14:30Z');
  assert.strictEqual(q[0].away, 'Villanova Wildcats');
  assert.strictEqual(q[0].home, 'Notre Dame Fighting Irish');
  // NFL matching unchanged (abbreviations)
  const nq = [{ league: 'NFL', ticker: 'KXNFLGAME-26NOV01BUFKC-BUF', away: 'Buffalo', home: 'Kansas City' }];
  R.applyKalshiSchedule(nq, R.scheduleFromEspn({ events: [{ date: '2026-11-01T21:25Z', competitions: [{ competitors: [
    { homeAway: 'home', team: { abbreviation: 'KC', displayName: 'Kansas City Chiefs' } }, { homeAway: 'away', team: { abbreviation: 'BUF', displayName: 'Buffalo Bills' } }] }] }] }), now);
  assert.strictEqual(nq[0].start, '2026-11-01T21:25Z');

  // Novig: NCAAB catalog keeps D1 vs D1 moneylines only
  const N = R.novigFeed;
  assert.ok(N.LEAGUES.includes('NCAAB'));
  const at = Date.now();
  const cat = N.buildCatalog('NCAAB', { items: [
    { eventId: 'e1', description: 'Villanova @ Notre Dame', league: 'NCAAB', status: 'OPEN_PREGAME', startsTs: at + 3600e3 },
    { eventId: 'e2', description: 'Fisk @ Belmont', league: 'NCAAB', status: 'OPEN_PREGAME', startsTs: at + 3600e3 },
    { eventId: 'e3', description: 'Duke @ Kansas', league: 'NCAAB', status: 'OPEN_PREGAME', startsTs: at + 5 * 864e5 },
  ] }, { items: [] }, at);
  assert.deepStrictEqual([...cat.events.keys()], ['e1'], 'non-D1 and >48h events dropped');

  // Polymarket US: NCAAB rides its own subscription; the 100 main slugs stay NFL/NBA/...
  const sent = [];
  class FakeWs extends EventEmitter {
    constructor() { super(); this.readyState = 1; setImmediate(() => this.emit('open')); }
    send(m) { sent.push(JSON.parse(m)); }
    ping() {}
    close() { this.readyState = 3; }
  }
  const { privateKey } = crypto.generateKeyPairSync('ed25519'); // throwaway test key (never a real credential)
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32).toString('base64');
  const soon = new Date(Date.now() + 3 * 3600e3).toISOString();
  const mk = (lg, a, h, kind, names) => ({ slug: `${lg}-${a}-${h}-2026-11-01`, startTime: soon, live: false, closed: false, markets: [{
    slug: `aec-${lg}-${a}-${h}-2026-11-01`, sportsMarketType: kind, bestBidQuote: { value: '0.45' }, bestAskQuote: { value: '0.47' },
    marketSides: [{ long: true, team: { name: names[0], ordering: 'away' } }, { long: false, team: { name: names[1], ordering: 'home' } }],
  }] });
  const nfl = Array.from({ length: 120 }, (_, i) => mk('nfl', `a${i}`, `h${i}`, 'football_team_full_game_winner', [`A${i}`, `H${i}`]));
  const cbb = [
    mk('cbb', 'vill', 'nd', 'basketball_team_full_game_winner', ['Villanova', 'Notre Dame']),
    mk('cbb', 'duke', 'kan', 'basketball_team_full_game_winner', ['Duke', 'Kansas']),
    mk('cbb', 'fisk', 'bel', 'basketball_team_full_game_winner', ['Fisk', 'Belmont']),
  ];
  const fetchFn = async (url) => {
    const path = /\/v2\/leagues\/([a-z]+)\/events/.exec(url);
    const events = !path ? [] : path[1] === 'nfl' ? nfl : path[1] === 'cbb' ? cbb : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ events }) };
  };
  const state = R.createState();
  const stop = R.startPolymarketUs(state, { env: { POLYMARKET_KEY_ID: 'test-key', POLYMARKET_SECRET_KEY: seed }, fetchFn, WebSocket: FakeWs });
  await new Promise((ok) => setTimeout(ok, 1500));
  stop();
  const subs = sent.filter((m) => m.subscribe);
  const main = subs.find((m) => String(m.subscribe.requestId).startsWith('odds-'));
  const lane = subs.find((m) => String(m.subscribe.requestId).startsWith('cbb-'));
  assert.ok(main && lane, `both subscriptions sent (${subs.map((m) => m.subscribe.requestId).join(',')})`);
  assert.strictEqual(main.subscribe.marketSlugs.length, 100);
  assert.ok(main.subscribe.marketSlugs.every((s) => s.startsWith('aec-nfl-')), 'no college slug in the main 100');
  assert.deepStrictEqual(lane.subscribe.marketSlugs.sort(), ['aec-cbb-duke-kan-2026-11-01', 'aec-cbb-vill-nd-2026-11-01'], 'D1 only (Fisk dropped)');
  assert.strictEqual(state.books.polymarket.NCAAB.size, 4, '2 games x yes/no');
  const vill = [...state.books.polymarket.NCAAB.values()].find((x) => x.token_id === 'us:aec-cbb-vill-nd-2026-11-01:yes');
  assert.ok(vill && vill.pair_key === 'nd|vill' && vill.side === 'Villanova');
  assert.ok(state.usCbbSubscribed.has('aec-cbb-vill-nd-2026-11-01'));
  console.log('odds-relay-ncaab ok');
  process.exit(0); // the US loop's 30s discover sleep would otherwise hold the process open
})().catch((e) => { console.error(e); process.exit(1); });
