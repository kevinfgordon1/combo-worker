'use strict';
// Underdog live push on the odds relay (GET /underdog) + Betstamp proxy ?parts= polling.
const assert = require('assert');
const { underdogRelay: ur, betstampRelay: br, startOddsRelay } = require('./odds-relay');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const game = (id, american, extra = {}) => ({
  matchId: id, sport: 'NCAAF', away: `A${id}`, home: `H${id}`, live: true,
  lines: [{ market: 'h2h', name: `A${id}`, american, choice: 'away', updatedAt: 1790000000000 }], ...extra,
});
function collector() {
  const events = [];
  return {
    events,
    write: (text) => { const m = /^event: ud\ndata: (.*)\n\n$/s.exec(text); if (m) events.push(JSON.parse(m[1])); },
    close: () => {},
    kinds: () => events.map((e) => e.kind),
  };
}
function fakeUpstream(steps) {
  let i = 0;
  const calls = [];
  return {
    mode: 'proxy', calls,
    fetch: async (league) => {
      calls.push({ league, t: Date.now() });
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

// diff is per game
{
  const a = ur.indexGames([game(1, -110), game(2, 150)]);
  const b = ur.indexGames([game(1, -112), game(3, 200)]);
  const d = ur.diffGames(a, b);
  assert.deepStrictEqual(d.up.map((g) => g.matchId).sort(), [1, 3]);
  assert.deepStrictEqual(d.rm, ['2']);
  assert.strictEqual(ur.diffGames(a, a).up.length, 0);
}

// hub: snapshot, delta, tick, error with no tick, recovery, shrink guard, idle stop
(async () => {
  const many = (price) => Array.from({ length: 8 }, (_, i) => game(i + 1, i === 0 ? price : -110));
  const up = fakeUpstream([
    { games: many(-110), fetchedAt: 'T1' },
    { games: many(-110), fetchedAt: 'T2' },
    { games: many(-125), fetchedAt: 'T3' },
    Object.assign(new Error('underdog proxy 502'), { status: 502 }),
    { games: [], fetchedAt: 'T5' }, // upstream hiccup: whole slate gone
    { games: [], fetchedAt: 'T6' },
    { games: many(-125), fetchedAt: 'T7' },
  ]);
  let emptied = false;
  const hub = ur.createHub({ league: 'NCAAF', upstream: up, pollMs: 15, idleStopMs: 40, maxBackoffMs: 30, onEmpty: () => { emptied = true; } });
  const c = collector();
  const unsub = hub.subscribe(c);
  await sleep(400);
  const kinds = c.kinds();
  assert.strictEqual(kinds[0], 'snapshot');
  assert.strictEqual(c.events[0].games.length, 8);
  assert.strictEqual(kinds[1], 'tick');
  assert.strictEqual(kinds[2], 'delta');
  assert.strictEqual(c.events[2].up.length, 1, 'only the repriced game is sent');
  assert.strictEqual(c.events[2].up[0].lines[0].american, -125);
  assert.strictEqual(kinds[3], 'error');
  assert.strictEqual(c.events[3].status, 502);
  assert.ok(!kinds.some((k, i) => k === 'delta' && c.events[i].rm && c.events[i].rm.length), 'a one or two poll empty slate never wipes the board');
  assert.ok(hub.stats().skippedShrinks >= 2);
  assert.ok(kinds.slice(4).includes('tick'), 'resumes after the hiccup');
  const seqs = c.events.filter((e) => e.kind !== 'error').map((e) => e.seq);
  assert.deepStrictEqual(seqs, [...seqs].sort((a, b) => a - b));
  const c2 = collector();
  const unsub2 = hub.subscribe(c2);
  assert.strictEqual(c2.events[0] && c2.events[0].kind, 'snapshot');
  unsub(); unsub2();
  await sleep(120);
  assert.strictEqual(emptied, true);
  const after = up.calls.length;
  await sleep(60);
  assert.strictEqual(up.calls.length, after, 'no polling without subscribers');
})().catch((e) => { console.error(e); process.exit(1); });

// a slate that truly shrinks (3 polls in a row) is believed
(async () => {
  const many = Array.from({ length: 8 }, (_, i) => game(i + 1, -110));
  const up = fakeUpstream([{ games: many, fetchedAt: 'a' }, { games: many.slice(0, 2), fetchedAt: 'b' }]);
  const hub = ur.createHub({ league: 'NFL', upstream: up, pollMs: 10, idleStopMs: 20 });
  const c = collector();
  hub.subscribe(c);
  await sleep(200);
  const rmEv = c.events.find((e) => e.kind === 'delta' && e.rm.length);
  assert.ok(rmEv && rmEv.rm.length === 6, 'real shrink goes through after repeats');
  hub.stop();
})().catch((e) => { console.error(e); process.exit(1); });

// upstream: asks the app for fresh + the league only
(async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, games: [game(1, -110)] }) };
  };
  const u = ur.createUpstream({ env: { BETSTAMP_PROXY_URL: 'https://app.example/' }, fetchFn });
  assert.strictEqual(u.mode, 'proxy');
  const out = await u.fetch('NCAAF');
  assert.strictEqual(out.games.length, 1);
  const q = new URL(urls[0]);
  assert.strictEqual(q.pathname, '/api/underdog-predict');
  assert.strictEqual(q.searchParams.get('live'), '1');
  assert.strictEqual(q.searchParams.get('fresh'), '1');
  assert.strictEqual(q.searchParams.get('sport'), 'NCAAF');
  assert.strictEqual(ur.createUpstream({ env: {} }).mode, 'off');
  const bad = ur.createUpstream({ env: { UNDERDOG_PROXY_URL: 'https://x' }, fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, games: [], error: 'cfg' }) }) });
  await assert.rejects(() => bad.fetch('NFL'), /cfg/);
})().catch((e) => { console.error(e); process.exit(1); });

// Betstamp proxy: markets-only polls, fixtures on their clock, legacy route detected
(async () => {
  const calls = [];
  const route = (legacy) => async (url) => {
    const u = new URL(url);
    const parts = (u.searchParams.get('parts') || '').split(',').filter(Boolean);
    calls.push(parts.join(','));
    const all = legacy;
    const body = {
      ok: true, fetchedAt: new Date().toISOString(),
      markets: [{ id: 'm', fixture_id: 'f1', odd_provider_id: 100, bet_type: 'Moneyline', period: 'FT', side: 'A', odds: 1.5 }],
      fixtures: all || parts.includes('fixtures') ? [{ id: 'f1' }] : [],
      teams: all || parts.includes('teams') ? [{ id: 't1' }] : [],
      query: legacy ? { league: 'NCAAF' } : { league: 'NCAAF', parts: parts.join(',') },
    };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const up = br.createUpstream({ env: { BETSTAMP_PROXY_URL: 'https://app.example' }, fetchFn: route(false) });
  const cache = {};
  const t0 = 1_000_000;
  const r1 = await up.fetch('NCAAF', [100], cache, t0);
  assert.strictEqual(calls[0], 'markets,fixtures,teams');
  assert.strictEqual(r1.fixtures.length, 1);
  assert.strictEqual(r1.teams.length, 1);
  assert.strictEqual(r1.pollMs, undefined);
  const r2 = await up.fetch('NCAAF', [100], cache, t0 + 1500);
  assert.strictEqual(calls[1], 'markets', 'plain polls are markets only');
  assert.strictEqual(r2.fixtures.length, 1, 'cached fixtures ride along');
  assert.strictEqual(r2.teams.length, 1);
  await up.fetch('NCAAF', [100], cache, t0 + 6100);
  assert.strictEqual(calls[2], 'markets,fixtures');
  await up.fetch('NCAAF', [100], cache, t0 + 300_500);
  assert.strictEqual(calls[3], 'markets,fixtures,teams');
  const legacyUp = br.createUpstream({ env: { BETSTAMP_PROXY_URL: 'https://app.example' }, fetchFn: route(true) });
  const lr = await legacyUp.fetch('NCAAF', [100], {}, t0);
  assert.strictEqual(lr.pollMs, 2500, 'a route without ?parts= keeps the slower pace');
  assert.strictEqual(lr.fixtures.length, 1);
  // registry default pace: 1.5s in proxy mode, env wins
  const reg = br.createRegistry({ env: { BETSTAMP_PROXY_URL: 'https://app.example' }, upstream: { mode: 'proxy', fetch: async () => ({ markets: [] }) } });
  assert.strictEqual(reg.mode, 'proxy');
  reg.stop();
})().catch((e) => { console.error(e); process.exit(1); });

// HTTP: /underdog end to end, 400 for a bad league, 503 when off
(async () => {
  const up = fakeUpstream([{ games: [game(1, -110)], fetchedAt: 'a' }, { games: [game(1, -115)], fetchedAt: 'b' }]);
  const relay = startOddsRelay({ upstream: false, betstamp: false, underdogUpstream: up, underdogPollMs: 30 });
  const addr = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  assert.strictEqual((await fetch(`${base}/underdog?league=NHL`)).status, 400);
  const ctrl = new AbortController();
  const res = await fetch(`${base}/underdog?league=NCAAF`, { signal: ctrl.signal });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  while (!/"kind":"delta"/.test(text)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value);
  }
  assert.match(text, /event: ud\ndata: .*"kind":"snapshot"/s);
  assert.match(text, /"american":-115/);
  assert.strictEqual(up.calls[0].league, 'NCAAF');
  const health = await (await fetch(`${base}/health`)).json();
  assert.strictEqual(health.underdog.clients, 1);
  ctrl.abort();
  await reader.cancel().catch(() => {});
  await relay.close();
  const off = startOddsRelay({ upstream: false, betstamp: false, env: {} });
  const a2 = await off.listen(0, '127.0.0.1');
  const r503 = await fetch(`http://127.0.0.1:${a2.port}/underdog?league=NFL`);
  assert.strictEqual(r503.status, 503);
  assert.strictEqual((await r503.json()).error, 'underdog_upstream_not_configured');
  await off.close();
  console.log('underdog-relay.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
