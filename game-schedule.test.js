'use strict';
// Canonical game schedule: parsing, matching (aliases, day-early NCAAF ML tickers, crosswalk names),
// resolver fallback order, disagreement flagging, the sync's "no verified start" alerts, and the sniper wiring.
const assert = require('assert');
const G = require('./game-schedule');
const { createScheduleSync } = require('./schedule-sync');
const { createKickoffResolver } = require('./sniper/kickoff');
const FX = require('./fixtures-espn-schedule-2026-10-27.json'); // real ESPN scoreboards, pulled Oct 27 2026

const games = Object.entries(FX).flatMap(([k, j]) => G.espnRows(k.split('|')[0], j));
const iso = (t) => { const r = G.resolveStart(t, games); assert.ok(r.verified, `${t} not verified: ${r.warn}`); return r.iso; };

// parseEvent
assert.deepStrictEqual(G.parseEvent('KXNBAGAME-26OCT27BKNBOS-BOS:yes'), { league: 'NBA', event: 'KXNBAGAME-26OCT27BKNBOS', gameKey: 'NBA|26OCT27BKNBOS', date: '2026-10-27', hhmm: null, teams: 'BKNBOS' });
assert.strictEqual(G.parseEvent('KXNCAAFSPREAD-26OCT31KSUCOLO-KSU7').league, 'NCAAF');
assert.strictEqual(G.parseEvent('KXNFLTD-26NOV01INDJAC-X').league, 'NFL');
assert.strictEqual(G.parseEvent('garbage'), null);

// Tonight's NBA / NHL legs (the ones the needle dropped): official times, Kalshi codes that differ from ESPN's.
assert.strictEqual(iso('KXNBAGAME-26OCT27BKNBOS-BOS'), '2026-10-27T23:30:00.000Z');
assert.strictEqual(iso('KXNBAGAME-26OCT27DETNYK-NYK'), '2026-10-28T00:00:00.000Z'); // ESPN "NY"
assert.strictEqual(iso('KXNBASPREAD-26OCT27SACSAS-SAS5'), '2026-10-28T00:00:00.000Z'); // ESPN "SA"
assert.strictEqual(iso('KXNBATOTAL-26OCT27PORLAL-220'), '2026-10-28T03:00:00.000Z');
assert.strictEqual(iso('KXNHLGAME-26OCT27BUFSJ-SJ'), '2026-10-28T02:30:00.000Z'); // ESPN "SJ"
assert.strictEqual(iso('KXNHLTOTAL-26OCT27NJDAL-5'), '2026-10-28T00:00:00.000Z'); // ESPN "NJ"
// NCAAF moneyline tickers are dated a day early (26OCT30 for Sat Oct 31); spread tickers are dated right. Same game.
assert.strictEqual(iso('KXNCAAFGAME-26OCT30KSUCOLO-KSU'), '2026-10-31T18:00:00.000Z');
assert.strictEqual(iso('KXNCAAFSPREAD-26OCT31KSUCOLO-KSU3'), '2026-10-31T18:00:00.000Z');
assert.strictEqual(iso('KXNCAAFGAME-26OCT31CLEMFSU-FSU'), '2026-10-31T23:00:00.000Z');
// NFL: JAC (Kalshi) vs JAX (ESPN), WAS vs WSH; Sunday night game time
assert.strictEqual(iso('KXNFLGAME-26NOV01INDJAC-IND'), '2026-11-01T18:00:00.000Z');
assert.strictEqual(iso('KXNFLGAME-26NOV01PHIWAS-PHI'), '2026-11-02T01:20:00.000Z');

// Fallback order: canonical → venue → lock starts_at → ticker date (never dropped; verified:false + warn).
const none = [];
let r = G.resolveStart('KXNBAGAME-26OCT27BKNBOS-BOS', none, { venue: { 'KXNBAGAME-26OCT27BKNBOS': '2026-10-27T23:35:00Z' }, lockStart: '2026-10-27T23:00:00Z' });
assert.deepStrictEqual([r.source, r.verified, r.iso], ['venue', false, '2026-10-27T23:35:00.000Z']); assert.ok(r.warn);
r = G.resolveStart('KXNBAGAME-26OCT27BKNBOS-BOS', none, { lockStart: '2026-10-27T23:00:00Z' });
assert.deepStrictEqual([r.source, r.verified], ['lock', false]);
r = G.resolveStart('KXNHLGAME-26OCT27LACHI-LA', none);
assert.deepStrictEqual([r.source, r.verified, r.date], ['ticker_date', false, '2026-10-27']); assert.ok(Number.isFinite(r.startMs));
r = G.resolveStart('nonsense', none); assert.strictEqual(r.source, 'none');
// Canonical beats a wrong venue / lock time.
r = G.resolveStart('KXNBAGAME-26OCT27BKNBOS-BOS', games, { venue: { 'KXNBAGAME-26OCT27BKNBOS': '2026-10-28T02:30:00Z' }, lockStart: '2026-10-28T03:00:00Z' });
assert.strictEqual(r.source, 'canonical'); assert.strictEqual(r.iso, '2026-10-27T23:30:00.000Z');

// TBD (timeValid:false) is not verified; ambiguous matches are not guessed.
const tbd = G.espnRows('NCAAF', { events: [{ id: '1', date: '2026-11-07T05:00Z', status: { type: { state: 'pre', shortDetail: 'TBD' } }, competitions: [{ date: '2026-11-07T05:00Z', timeValid: false, competitors: [{ homeAway: 'home', team: { abbreviation: 'COLO', location: 'Colorado' } }, { homeAway: 'away', team: { abbreviation: 'KSU', location: 'Kansas State' } }] }] }] });
r = G.resolveStart('KXNCAAFGAME-26NOV07KSUCOLO-KSU', tbd); assert.strictEqual(r.verified, false);
const twice = [...games.filter((g) => g.league === 'NBA'), ...games.filter((g) => g.league === 'NBA').map((g) => ({ ...g, espn_id: `${g.espn_id}b`, start_ms: g.start_ms + 24 * 3600000 }))];
assert.strictEqual(G.resolveStart('KXNBAGAME-26OCT27BKNBOS-BOS', twice).iso, '2026-10-27T23:30:00.000Z'); // exact date wins

// Kalshi placeholders (03:00Z / 04:00Z) are never treated as times; real ones are occurrence − 3h.
assert.strictEqual(G.kalshiStartGuess('2026-10-28T03:00:00Z', 'NHL'), null);
assert.strictEqual(new Date(G.kalshiStartGuess('2026-10-28T02:30:00Z', 'NBA')).toISOString(), '2026-10-27T23:30:00.000Z');

// buildRows flags venue disagreement > 15 min.
const b = G.buildRows(['KXNBAGAME-26OCT27BKNBOS', 'KXNBAGAME-26OCT27XXXYYY'], games, { 'KXNBAGAME-26OCT27BKNBOS': { polymarket: '2026-10-28T00:00:00Z' } });
assert.strictEqual(b.rows[0].confidence, 'official_disputed'); assert.strictEqual(b.rows[0].disagreement_min, 30);
assert.deepStrictEqual(b.misses, [{ event: 'KXNBAGAME-26OCT27XXXYYY', why: 'no_official_match' }]);

// Row round trip keeps matching.
const back = games.map((g) => G.rowToGame(G.gameToRow(g)));
assert.strictEqual(G.resolveStart('KXNCAAFGAME-26OCT30KSUCOLO-KSU', back).iso, '2026-10-31T18:00:00.000Z');

// Sniper kickoff resolver prefers canonical, falls back to the old chain when canonical is unverified.
const K = createKickoffResolver();
K.setKalshiOccurrence('KXNBAGAME-26OCT27BKNBOS-BOS', Date.parse('2026-10-28T03:00:00Z'));
assert.strictEqual(K.resolve('KXNBAGAME-26OCT27BKNBOS-BOS').source, 'kalshi_occ_minus_3h');
K.setCanonical((t) => G.resolveStart(t, games));
assert.deepStrictEqual([K.resolve('KXNBAGAME-26OCT27BKNBOS-BOS').source, new Date(K.kickoffFor('KXNBAGAME-26OCT27BKNBOS-BOS')).toISOString()], ['canonical', '2026-10-27T23:30:00.000Z']);
K.setCanonical(() => ({ verified: false, startMs: 1 }));
assert.strictEqual(K.resolve('KXNBAGAME-26OCT27BKNBOS-BOS').source, 'kalshi_occ_minus_3h');

// Sync: writes rows, alerts once per game/day for a leg without a verified start and for a wrong saved start.
(async () => {
  const NOW = Date.parse('2026-10-27T19:00:00Z'); const posts = []; const tg = []; const raised = [];
  const fx = (k) => FX[k] || { events: [] };
  const fetchFn = async (url, opts = {}) => {
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
    if (url.includes('espn.com')) { const lg = url.includes('/nba/') ? 'NBA' : url.includes('/nhl/') ? 'NHL' : url.includes('college-football') ? 'NCAAF' : url.includes('/nfl/') ? 'NFL' : 'X'; const d = /dates=(\d+)/.exec(url)[1]; return ok(fx(`${lg}|${d}`)); }
    if (url.includes('telegram')) { tg.push(JSON.parse(opts.body).text); return ok({}); }
    if (url.includes('game_schedule') && opts.method === 'POST') { posts.push(...JSON.parse(opts.body)); return { ok: true, status: 201, json: async () => null, text: async () => '' }; }
    if (url.includes('game_schedule')) return ok([{ league: 'NBA', espn_id: games.find((g) => g.home.abbr === 'BOS').espn_id, start_time_utc: '2026-10-27T23:00:00.000Z' }]);
    if (url.includes('combo_parlays')) return ok([{ id: 'L1', label: 'tonight', legs: [
      { ticker: 'KXNBAGAME-26OCT27BKNBOS-BOS', starts_at: '2026-10-27T23:30:00.000Z' },
      { ticker: 'KXNHLGAME-26OCT27BUFSJ-SJ', starts_at: '2026-10-28T00:00:00.000Z' }, // saved wrong (+2.5h off)
      { ticker: 'KXNHLGAME-26OCT27QQQZZZ-QQQ', starts_at: null }, // no official game → alert, still counted on ticker date
    ] }]);
    return ok([]);
  };
  const s = createScheduleSync({ env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALERT_CHAT_ID: 'c' }, fetchFn, log: () => {}, alerts: { raise: async (a) => raised.push(a) }, now: () => NOW });
  await s.tick(); await s.tick();
  assert.ok(posts.length >= 70, `rows written: ${posts.length}`);
  const bos = posts.find((p) => p.home_abbr === 'BOS' && p.league === 'NBA');
  assert.strictEqual(bos.previous_start_utc, '2026-10-27T23:00:00.000Z'); // time change recorded
  assert.strictEqual(raised.length, 2); assert.strictEqual(tg.length, 2); // deduped across the two ticks
  assert.ok(raised.some((a) => /no verified start/.test(a.title) && /QQQZZZ/.test(a.body)));
  assert.ok(raised.some((a) => /differs/.test(a.title) && /BUFSJ/.test(a.body)));
  assert.strictEqual(s.stats().unverifiedLegs, 1);
  // Missing table: sync keeps working in memory and still audits.
  const s2 = createScheduleSync({ env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' }, fetchFn: async (u, o) => (u.includes('game_schedule') ? { ok: false, status: 404, json: async () => ({}), text: async () => 'relation "game_schedule" does not exist' } : fetchFn(u, o)), log: () => {}, now: () => NOW });
  await s2.tick(); assert.strictEqual(s2.stats().tableMissing, true); assert.ok(s2.resolve('KXNBAGAME-26OCT27BKNBOS-BOS').verified);
  console.log('game-schedule tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
