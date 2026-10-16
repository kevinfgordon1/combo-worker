'use strict';
// Betstamp live fan-out on the odds relay (GET /betstamp).
const assert = require('assert');
const { betstampRelay: br, startOddsRelay } = require('./odds-relay');

const mk = (fixture, prov, side, odds, extra = {}) => ({
  id: `id-${fixture}-${prov}-${side}-${odds}`, fixture_id: fixture, odd_provider_id: prov, bet_type: 'Moneyline', period: 'FT',
  is_alt: false, number: 0, side, odds, is_live: true, updated_at: '2026-10-02T15:00:00Z', ...extra,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Book ids: Fliff, Courtside-style unknown ids, Underdog Predict and BetMGM never go upstream.
{
  assert.deepStrictEqual(br.resolveBookIds('100,200,800,196,400,999', {}), [100, 200]);
  assert.deepStrictEqual(br.resolveBookIds('100,400', { BETSTAMP_INCLUDE_BETMGM: '1' }), [100, 400]);
  const dflt = br.resolveBookIds('', {});
  assert.ok(dflt.includes(100) && dflt.includes(191) && !dflt.includes(196) && !dflt.includes(400) && !dflt.includes(800));
  assert.deepStrictEqual(br.resolveBookIds('800,196', {}), dflt, 'nothing valid falls back to the default set');
}

// Diff: only changed / new rows go out, vanished rows are removed, id churn alone is a change.
{
  const a = br.indexMarkets([mk('f1', 100, 'CLE', 1.2), mk('f1', 100, 'PIT', 4.5), mk('f1', 200, 'CLE', 1.21)]);
  const b = br.indexMarkets([mk('f1', 100, 'CLE', 1.19), mk('f1', 100, 'PIT', 4.5), mk('f1', 365, 'CLE', 1.2)]);
  const d = br.diffMarkets(a, b);
  assert.strictEqual(d.up.length, 2);
  assert.deepStrictEqual(d.up.map(([, m]) => `${m.odd_provider_id}:${m.side}`).sort(), ['100:CLE', '365:CLE']);
  assert.strictEqual(d.rm.length, 1);
  assert.ok(d.rm[0].startsWith('f1|200|Moneyline'));
  assert.strictEqual(br.diffMarkets(a, a).up.length, 0);
  // duplicate key keeps the newer updated_at
  const dup = br.indexMarkets([mk('f1', 100, 'CLE', 1.2, { updated_at: '2026-10-02T15:00:05Z' }), mk('f1', 100, 'CLE', 1.3, { updated_at: '2026-10-02T15:00:01Z' })]);
  assert.strictEqual([...dup.values()][0].m.odds, 1.2);
}

function fakeUpstream(steps) {
  let i = 0;
  const calls = [];
  return {
    mode: 'proxy',
    calls,
    fetch: async (league, bookIds) => {
      calls.push({ league, bookIds, t: Date.now() });
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step() : step;
    },
  };
}
const fx = (score) => [{ id: 'f1', home_abbr: 'CLE', away_abbr: 'PIT', home_score: score, away_score: 0, status: 'inprogress' }];
function collector() {
  const events = [];
  let closed = false;
  return {
    events,
    get closed() { return closed; },
    write: (text) => {
      const m = /^event: bs\ndata: (.*)\n\n$/s.exec(text);
      if (m) events.push(JSON.parse(m[1]));
    },
    close: () => { closed = true; },
    kinds: () => events.map((e) => e.kind),
  };
}

// Hub: snapshot, delta, tick, fixtures-on-change, error without tick, recovery.
(async () => {
  const up = fakeUpstream([
    { markets: [mk('f1', 100, 'CLE', 1.2), mk('f1', 100, 'PIT', 4.5)], fixtures: fx(0), teams: [{ id: 't1' }], fetchedAt: 'T1' },
    { markets: [mk('f1', 100, 'CLE', 1.2), mk('f1', 100, 'PIT', 4.5)], fixtures: fx(0), teams: [{ id: 't1' }], fetchedAt: 'T2' },
    { markets: [mk('f1', 100, 'CLE', 1.18), mk('f1', 100, 'PIT', 4.5)], fixtures: fx(0), teams: [{ id: 't1' }], fetchedAt: 'T3' },
    { markets: [mk('f1', 100, 'CLE', 1.18)], fixtures: fx(7), teams: [{ id: 't1' }], fetchedAt: 'T4' },
    Object.assign(new Error('betstamp upstream 429'), { status: 429 }),
    { markets: [mk('f1', 100, 'CLE', 1.18)], fixtures: fx(7), teams: [{ id: 't1' }], fetchedAt: 'T6' },
  ]);
  let emptied = false;
  const hub = br.createHub({ league: 'NFL', bookIds: [100], upstream: up, pollMs: 15, quietPollMs: 15, idleStopMs: 40, maxBackoffMs: 30, onEmpty: () => { emptied = true; } });
  const c = collector();
  const unsub = hub.subscribe(c);
  await sleep(250);
  const kinds = c.kinds();
  assert.strictEqual(kinds[0], 'snapshot');
  assert.strictEqual(c.events[0].markets.length, 2);
  assert.strictEqual(c.events[0].fixtures.length, 1);
  assert.strictEqual(kinds[1], 'tick', 'no change = heartbeat only');
  assert.strictEqual(c.events[1].up, undefined);
  assert.strictEqual(kinds[2], 'delta');
  assert.strictEqual(c.events[2].up.length, 1);
  assert.strictEqual(c.events[2].up[0][1].odds, 1.18);
  assert.strictEqual(c.events[2].fixtures, undefined, 'fixtures only when they change');
  assert.strictEqual(kinds[3], 'delta');
  assert.strictEqual(c.events[3].rm.length, 1, 'vanished PIT row removed');
  assert.strictEqual(c.events[3].fixtures[0].home_score, 7);
  assert.strictEqual(kinds[4], 'error');
  assert.strictEqual(c.events[4].status, 429);
  assert.ok(!kinds.slice(4, 5).includes('tick'), 'no heartbeat during an outage');
  assert.ok(kinds.slice(5).includes('tick') || kinds.slice(5).includes('delta'), 'resumes after the outage');
  const seqs = c.events.filter((e) => e.kind !== 'error').map((e) => e.seq);
  assert.deepStrictEqual(seqs, [...seqs].sort((a, b) => a - b));
  // a second browser gets the current book at once (state is fresh)
  const c2 = collector();
  const unsub2 = hub.subscribe(c2);
  assert.strictEqual(c2.events[0] && c2.events[0].kind, 'snapshot');
  assert.strictEqual(c2.events[0].markets.length, 1);
  assert.strictEqual(up.calls.length === 0, false);
  const callsWithTwo = up.calls.length;
  unsub(); unsub2();
  await sleep(120);
  assert.strictEqual(emptied, true, 'hub stops when the last browser leaves');
  const after = up.calls.length;
  await sleep(80);
  assert.strictEqual(up.calls.length, after, 'no polling without subscribers');
  assert.ok(callsWithTwo >= 4);
})().catch((e) => { console.error(e); process.exit(1); });

// One upstream poller no matter how many browsers.
(async () => {
  const up = fakeUpstream([{ markets: [mk('f1', 100, 'CLE', 1.2)], fixtures: fx(0), teams: [], fetchedAt: 'T' }]);
  const hub = br.createHub({ league: 'NFL', bookIds: [100], upstream: up, pollMs: 40, quietPollMs: 40, idleStopMs: 20 });
  const cs = [];
  for (let i = 0; i < 25; i += 1) { const c = collector(); cs.push(c); hub.subscribe(c); }
  await sleep(220);
  assert.ok(up.calls.length >= 3 && up.calls.length <= 8, `calls=${up.calls.length}`);
  assert.ok(cs.every((c) => c.events.length >= 3));
  const gaps = up.calls.slice(1).map((c, i) => c.t - up.calls[i].t);
  assert.ok(Math.min(...gaps) >= 25, `polls are spaced: ${gaps}`);
  hub.stop();
})().catch((e) => { console.error(e); process.exit(1); });

// Upstream: direct mode sends the key only to Betstamp and asks for live games; fixtures are cached.
(async () => {
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push({ url: String(url), key: init.headers['X-API-KEY'] });
    const u = new URL(url);
    const body = u.pathname.endsWith('/markets') ? { markets: [mk('f1', 100, 'CLE', 1.2), { id: 'x', type: 'tournament', fixture_id: 'f9' }] }
      : u.pathname.endsWith('/fixtures') ? { fixtures: [{ id: 'f1', type: 'match' }, { id: 'f9', type: 'tournament' }] } : { teams: [{ id: 't' }] };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const upstream = br.createUpstream({ env: { BETSTAMP_API_KEY: 'sekret-key' }, fetchFn });
  assert.strictEqual(upstream.mode, 'direct');
  const cache = {};
  const r1 = await upstream.fetch('NFL', [100, 200], cache, 1000);
  const m = urls.find((u) => new URL(u.url).pathname.endsWith('/markets'));
  const q = new URL(m.url).searchParams;
  assert.strictEqual(q.get('is_live'), 'true');
  assert.strictEqual(q.get('league'), 'NFL');
  assert.strictEqual(q.get('book_ids'), '100,200');
  assert.strictEqual(q.get('include_alts'), 'false');
  assert.ok(urls.every((u) => u.key === 'sekret-key'));
  assert.ok(urls.every((u) => u.url.startsWith('https://api.pro.betstamp.com/')));
  assert.strictEqual(r1.markets.length, 1, 'non-match rows dropped');
  assert.strictEqual(r1.fixtures.length, 1);
  assert.strictEqual(urls.length, 3);
  const r2 = await upstream.fetch('NFL', [100, 200], cache, 2500);
  assert.strictEqual(urls.length, 4, 'second poll is markets only');
  assert.strictEqual(r2.fixtures.length, 1);
  await upstream.fetch('NFL', [100, 200], cache, 8000);
  assert.strictEqual(urls.length, 6, 'fixtures refresh after 6s');
  assert.ok(!JSON.stringify(r1).includes('sekret-key'));
  // 429 carries retry-after
  const limited = br.createUpstream({ env: { BETSTAMP_API_KEY: 'k' }, fetchFn: async () => ({ ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '7' : null) }, text: async () => '{}' }) });
  await assert.rejects(() => limited.fetch('NFL', [100], {}, 1), (e) => e.status === 429 && e.retryAfterMs === 7000);
  // proxy mode
  const purls = [];
  const proxy = br.createUpstream({ env: { BETSTAMP_PROXY_URL: 'https://app.example/' }, fetchFn: async (url) => { purls.push(String(url)); return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ ok: true, markets: [mk('f1', 100, 'CLE', 1.2)], fixtures: [], teams: [], fetchedAt: 'Z' }) }; } });
  assert.strictEqual(proxy.mode, 'proxy');
  await proxy.fetch('NFL', [100, 191]);
  const pu = new URL(purls[0]);
  assert.strictEqual(pu.origin + pu.pathname, 'https://app.example/api/betstamp-markets');
  assert.strictEqual(pu.searchParams.get('is_live'), 'true');
  assert.strictEqual(pu.searchParams.get('refresh'), '1');
  assert.strictEqual(pu.searchParams.get('book_ids'), '100,191');
  assert.strictEqual(br.createUpstream({ env: {} }).mode, 'off');
})().catch((e) => { console.error(e); process.exit(1); });

// HTTP: /betstamp streams, validates, and is off without an upstream.
(async () => {
  const up = fakeUpstream([{ markets: [mk('f1', 100, 'CLE', 1.2)], fixtures: fx(0), teams: [], fetchedAt: 'T' }]);
  const relay = startOddsRelay({ upstream: false, betstampUpstream: up, betstampPollMs: 30, betstampQuietPollMs: 30 });
  const addr = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const bad = await fetch(`${base}/betstamp?league=MLB`);
  assert.strictEqual(bad.status, 400);
  const ctrl = new AbortController();
  const res = await fetch(`${base}/betstamp?league=NFL&book_ids=100,200,800,196`, { signal: ctrl.signal });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  while (!/event: bs\ndata: .*"kind":"tick"/s.test(text)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value);
  }
  assert.match(text, /"kind":"snapshot"/);
  assert.deepStrictEqual(up.calls[0].bookIds, [100, 200], 'Fliff and Underdog never requested');
  const health = await (await fetch(`${base}/health`)).json();
  assert.strictEqual(health.betstamp.clients, 1);
  assert.strictEqual(health.betstamp.hubs.length, 1);
  ctrl.abort();
  await reader.cancel().catch(() => {});
  await relay.close();

  const off = startOddsRelay({ upstream: false, env: {} });
  const a2 = await off.listen(0, '127.0.0.1');
  const r503 = await fetch(`http://127.0.0.1:${a2.port}/betstamp?league=NFL`);
  assert.strictEqual(r503.status, 503);
  assert.strictEqual((await r503.json()).error, 'betstamp_upstream_not_configured');
  await off.close();
  console.log('betstamp-relay.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
