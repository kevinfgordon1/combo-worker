'use strict';
// Kalshi is_live for college football: the ESPN overlay must cover FBS (groups=80) AND FCS (groups=81),
// otherwise games like Montana State at Idaho never match and is_live falls back to the late Kalshi start.
const assert = require('assert');
const { espnSchedule, applyKalshiSchedule } = require('./odds-relay.js');

const ev = (home, away, hAb, aAb, state) => ({
  date: '2026-10-03T02:30Z',
  competitions: [{ status: { type: { state } }, competitors: [
    { homeAway: 'home', team: { abbreviation: hAb, displayName: home } },
    { homeAway: 'away', team: { abbreviation: aAb, displayName: away } },
  ] }],
});

(async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    const events = /groups=81/.test(url)
      ? [ev('Idaho Vandals', 'Montana State Bobcats', 'IDHO', 'MTST', 'in')]
      : [ev('Northwestern Wildcats', 'Penn State Nittany Lions', 'NU', 'PSU', 'in')];
    return { ok: true, status: 200, json: async () => ({ events }), text: async () => JSON.stringify({ events }) };
  };
  const games = await espnSchedule('NCAAF', fetchFn);
  assert.ok(urls.some((u) => /groups=80/.test(u)) && urls.some((u) => /groups=81/.test(u)), 'fetches FBS and FCS boards');
  assert.strictEqual(games.length, 2);
  const quotes = [
    { ticker: 'KXNCAAFGAME-26OCT02MTSTIDHO-IDHO', start: '2026-10-03T05:30:00Z' },
    { ticker: 'KXNCAAFGAME-26OCT02PSUNW-PSU', start: '2026-10-03T03:00:00Z' },
  ];
  applyKalshiSchedule(quotes, games, Date.parse('2026-10-03T03:00:00Z'));
  assert.strictEqual(quotes[0].is_live, true, 'Idaho (FCS) live from ESPN despite future Kalshi start');
  assert.strictEqual(quotes[1].is_live, true);
  console.log('kalshi-ncaaf-schedule.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
