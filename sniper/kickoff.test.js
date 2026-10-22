'use strict';
const assert = require('assert');
const { createKickoffResolver } = require('./kickoff');
const { espnKickoffs, oddsKickoffs } = require('../noboost/kickoffs');
const { pregameCheck } = require('./engine');
const espn = require('./fixtures-espn-2026-10-22.json'); // real ESPN scoreboard, Oct 22 2026

const logs = []; const K = createKickoffResolver({ log: (m) => logs.push(m) });
assert.ok(K.setKickoffs(espnKickoffs(espn)) >= 4);
const iso = (t) => new Date(K.kickoffFor(t)).toISOString();
// Real kickoffs (ET): TNF NE@CHI 8:15 PM Thu; PIT-NO London 9:30 AM Sun; CIN@BAL 1:00 PM; KC@SEA SNF 8:20 PM
assert.strictEqual(iso('KXNFLGAME-26OCT22NECHI-NE'), '2026-10-23T00:15:00.000Z');
assert.strictEqual(iso('KXNFLGAME-26OCT25PITNO-PIT:no'), '2026-10-25T13:30:00.000Z');
assert.strictEqual(iso('KXNFLGAME-26OCT25CINBAL-CIN'), '2026-10-25T17:00:00.000Z');
assert.strictEqual(iso('KXNFLTD-26OCT25CINBAL-BALDHENRY22-1:yes'), '2026-10-25T17:00:00.000Z');
assert.strictEqual(iso('KXNFLGAME-26OCT25KCSEA-SEA'), '2026-10-26T00:20:00.000Z');
assert.strictEqual(K.resolve('KXNFLGAME-26OCT22NECHI-NE').source, 'espn');

// ESPN beats a wrong Kalshi time; odds_cache used when ESPN lacks the game; Kalshi−3h only as logged fallback
K.setKalshiOccurrence('KXNFLGAME-26OCT22NECHI-NE', Date.parse('2026-10-23T05:00:00Z'));
assert.strictEqual(iso('KXNFLGAME-26OCT22NECHI-NE'), '2026-10-23T00:15:00.000Z');
K.setKickoffs(oddsKickoffs([{ commence_time: '2026-10-27T00:15:00Z', home_team: 'Philadelphia Eagles', away_team: 'Dallas Cowboys' }]));
assert.strictEqual(K.resolve('KXNFLGAME-26OCT26DALPHI-PHI').source, 'odds_cache');
assert.strictEqual(logs.length, 0);
K.setKalshiOccurrence('KXNFLGAME-26NOV01BUFKC-KC', Date.parse('2026-11-01T23:25:00Z'));
assert.strictEqual(K.resolve('KXNFLGAME-26NOV01BUFKC-KC').source, 'kalshi_occ_minus_3h');
assert.strictEqual(iso('KXNFLGAME-26NOV01BUFKC-KC'), '2026-11-01T20:25:00.000Z');
K.kickoffFor('KXNFLGAME-26NOV01BUFKC-BUF');
assert.strictEqual(logs.length, 1); assert.ok(/FALLBACK/.test(logs[0]));
assert.strictEqual(K.kickoffFor('KXNFLGAME-26DEC01AAABBB-AAA'), null);

// Rule 9 with real times: TNF quotable at 8:14 PM ET (no buffer), refused at 8:15; ESPN 'in' = started early
const legs = ['KXNFLGAME-26OCT22NECHI-NE:yes', 'KXNFLGAME-26OCT25CINBAL-CIN:yes'];
assert.strictEqual(pregameCheck(legs, K.kickoffFor, Date.parse('2026-10-23T00:14:00Z'), 0), null);
assert.strictEqual(pregameCheck(legs, K.kickoffFor, Date.parse('2026-10-23T00:15:00Z'), 0), 'game_started');
const live = JSON.parse(JSON.stringify(espn)); live.events[0].status.type.state = 'in';
K.setKickoffs(espnKickoffs(live));
assert.strictEqual(pregameCheck(legs, K.kickoffFor, Date.parse('2026-10-22T20:00:00Z'), 0), 'game_started');
console.log('sniper/kickoff.test.js ok');
