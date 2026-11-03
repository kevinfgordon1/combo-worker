'use strict';
const assert = require('assert');
const c = require('./soccer-clubs.mjs');

assert.equal(c.soccerClubId('PSG'), 'psg');
assert.equal(c.soccerClubId('Paris Saint-Germain FC'), 'psg');
assert.equal(c.soccerClubId('FC Bayern München'), 'bayern');
assert.equal(c.soccerClubId('Bayern Munich'), 'bayern');
assert.equal(c.soccerClubId('FK Bodø / Glimt'), 'bodoglimt');
assert.equal(c.soccerSameClub('Bodoe/Glimt', 'FK Bodø / Glimt'), true);
assert.equal(c.clubMentioned('Lille OSC @ FK Bodø / Glimt', 'bodoglimt'), true);
assert.equal(c.clubMentioned('Lille OSC @ FK Bodø / Glimt', 'lille'), true);
assert.equal(c.soccerClubId('Inter'), 'inter');
assert.equal(c.soccerClubId('Internazionale'), 'inter');
assert.equal(c.soccerClubId('FC Internazionale Milano'), 'inter');
assert.equal(c.soccerClubId('Inter Miami CF'), 'inter-miami');
assert.equal(c.soccerSameClub('Inter', 'Internazionale'), true);
assert.equal(c.soccerSameClub('Inter', 'Inter Miami'), false);
assert.equal(c.soccerSameClub('PSG', 'Paris Saint-Germain'), true);
assert.equal(c.soccerSameClub('Bayern Munich', 'FC Bayern München'), true);
assert.equal(c.soccerSameClub('Manchester United', 'Manchester City'), false);
assert.equal(c.soccerSameClub('Chelsea', 'Arsenal'), null);

assert.equal(c.clubMentioned('Paris Saint-Germain FC @ Villarreal CF', 'psg'), true);
assert.equal(c.clubMentioned('PSG vs Villarreal', 'psg'), true);
assert.equal(c.clubMentioned('Inter Miami CF @ Orlando City', 'inter'), false);
assert.equal(c.clubMentioned('FC Internazionale Milano @ Feyenoord Rotterdam', 'inter'), true);
assert.equal(c.clubMentioned('FC Bayern München @ Club Atlético de Madrid', 'bayern'), true);
assert.equal(c.clubMentioned('FC Bayern München @ Club Atlético de Madrid', 'atletico'), true);

assert.deepStrictEqual(c.splitUclCodes('VILPSG'), ['VIL', 'PSG']);
assert.deepStrictEqual(c.splitUclCodes('ATMBMU'), ['ATM', 'BMU']);
assert.deepStrictEqual(c.splitUclCodes('FEYINT'), ['FEY', 'INT']);
assert.deepStrictEqual(c.splitUclCodes('MUNROM'), ['MUN', 'ROM']);
assert.equal(c.uclClubFromCode('BMU'), 'bayern');
assert.equal(c.uclClubFromCode('MUN'), 'manutd');
assert.equal(c.uclClubFromCode('PSG'), 'psg');
assert.notEqual(c.uclClubFromCode('MUN'), c.uclClubFromCode('BMU'));

const week = ['GALVFB', 'SHASPO', 'ASKSLO', 'ATMBMU', 'BARAVL', 'BOGLIL', 'FEYINT', 'MUNROM', 'VILPSG', 'AEKRMA', 'FENLFC', 'BVBRBB', 'FCPNAP', 'PSVBRU', 'RBLMCI', 'RCLCOM', 'SLAARS', 'VIKSBH'];
for (const blob of week) assert.ok(c.splitUclCodes(blob), blob);

console.log('soccer-clubs ok');
