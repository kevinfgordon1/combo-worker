'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPaperSession, formatCutoffLine } = require('./mm-paper-engine');
const { readConfig } = require('./mm-paper-config');
const { impliedProb } = require('./mm-paper-math');
const {
  chooseKickoff,
  polyKickoffMs,
  groupKalshiMarkets,
  attachOdds,
  formatKickoffEt,
} = require('./mm-paper-games');
const { loadPaperHistory } = require('./mm-paper-state');
const { createRunner } = require('./mm-paper-runner');
const { summarize, formatReport, settleRows, phaseOf } = require('./scripts/mm-paper-summary');

const KICK = Date.parse('2026-09-13T17:00:00Z');
// Later the same ET day as the game id, so the kickoff log stays on 2026-09-13.
const SAME_DAY_KICK = Date.parse('2026-09-13T23:00:00Z');
const GAME = 'nfl|2026-09-13|kc+phi';
assert.strictEqual(formatKickoffEt(SAME_DAY_KICK).slice(0, 10), GAME.split('|')[1]);

function book(bid, ask, bidSize) {
  return {
    bids: bidSize > 0 ? [{ price: bid, size: bidSize }] : [],
    asks: [{ price: ask, size: 50 }],
  };
}

function quiet(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { lines, value: fn() };
  } finally {
    console.log = orig;
  }
}

function makeSession({ bufferSec, kickoff } = {}) {
  const env = { MM_PAPER: '1', MM_ORDER_SIZE: '10', MM_POSITION_CAP: '100' };
  if (bufferSec != null) env.MM_PAPER_KICKOFF_BUFFER_SEC = String(bufferSec);
  const cfg = readConfig(env);
  const session = createPaperSession(cfg);
  session.upsertGame({
    gameId: GAME,
    league: 'nfl',
    date: '2026-09-13',
    teams: ['kc', 'phi'],
    labels: { kc: 'Chiefs', phi: 'Eagles' },
    kalshi: {
      kc: { ticker: 'KXNFLGAME-26SEP13KCPHI-KC' },
      phi: { ticker: 'KXNFLGAME-26SEP13KCPHI-PHI' },
    },
  });
  session.setOdds(GAME, {
    kc: { prob: impliedProb(-150), american: -150, book: 'pinnacle' },
    phi: { prob: impliedProb(130), american: 130, book: 'pinnacle' },
  });
  for (const venue of ['kalshi', 'polymarket']) {
    session.setBook(GAME, venue, 'kc', book(0.54, 0.56, 0));
    session.setBook(GAME, venue, 'phi', book(0.38, 0.42, 0));
  }
  if (kickoff !== false) {
    quiet(() => session.setKickoff(GAME, { polymarket: kickoff == null ? KICK : kickoff }));
  }
  return { session, cfg };
}

function quotesOf(events) {
  return (events || []).filter((e) => e.kind === 'quote' || e.kind === 'reprice');
}

assert.strictEqual(readConfig({ MM_PAPER: '1' }).kickoffBufferSec, 60);
assert.strictEqual(readConfig({ MM_PAPER: '1', MM_PAPER_KICKOFF_BUFFER_SEC: '120' }).kickoffBufferSec, 120);
assert.strictEqual(readConfig({ MM_PAPER: '1', MM_PAPER_KICKOFF_BUFFER_SEC: '0' }).kickoffBufferSec, 0);
assert.strictEqual(readConfig({ MM_PAPER: '1', MM_PAPER_KICKOFF_BUFFER_SEC: 'nope' }).kickoffBufferSec, 60);

assert.strictEqual(polyKickoffMs({
  startDate: '2026-09-13T06:00:20Z',
  gameStartTime: '2026-09-28T00:20:00Z',
}), Date.parse('2026-09-28T00:20:00Z'));
assert.strictEqual(polyKickoffMs({ startDate: '2026-09-13T06:00:20Z' }), null);

const nfl = groupKalshiMarkets([
  {
    ticker: 'KXNFLGAME-26SEP27LARDEN-DEN',
    yes_sub_title: 'Denver',
    open_time: '2026-09-15T16:16:00Z',
    close_time: '2026-09-30T00:20:00Z',
    expected_expiration_time: '2026-09-28T06:20:00Z',
    occurrence_datetime: '2026-09-28T03:20:00Z',
  },
  {
    ticker: 'KXNFLGAME-26SEP27LARDEN-LAR',
    yes_sub_title: 'Los Angeles R',
    occurrence_datetime: '2026-09-28T03:20:00Z',
  },
], new Set(['nfl']));
assert.strictEqual(nfl.length, 1);
assert.strictEqual(nfl[0].kickoffMs, null);
assert.strictEqual(nfl[0].startMinutes, null);

const mlb = groupKalshiMarkets([
  { ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS', yes_sub_title: 'White Sox' },
  { ticker: 'KXMLBGAME-26AUG141840CWSDET-DET', yes_sub_title: 'Tigers' },
], new Set(['mlb']));
assert.strictEqual(mlb.length, 1);
assert.strictEqual(mlb[0].kickoffMs, Date.parse('2026-08-14T22:40:00Z'));

const polyAt = Date.parse('2026-09-28T00:20:00Z');
const oddsEarly = Date.parse('2026-09-27T17:00:00Z');
const oddsClose = Date.parse('2026-09-28T00:15:00Z');
const disagreed = chooseKickoff({ polymarket: polyAt, odds: oddsEarly });
assert.strictEqual(disagreed.source, 'odds');
assert.strictEqual(disagreed.kickoffMs, oddsEarly);
assert.ok(disagreed.note);
const agreed = chooseKickoff({ polymarket: polyAt, odds: oddsClose });
assert.strictEqual(agreed.source, 'polymarket');
assert.strictEqual(agreed.kickoffMs, polyAt);
assert.strictEqual(agreed.note, null);
assert.strictEqual(chooseKickoff({}), null);
assert.strictEqual(chooseKickoff(null), null);
assert.strictEqual(formatKickoffEt(KICK), '2026-09-13 1:00 PM ET');

// startMinutes is not a kickoff. No clock means no quotes, logged once.
{
  const { session } = makeSession({ kickoff: false });
  session.upsertGame({
    gameId: GAME,
    league: 'nfl',
    date: '2026-09-13',
    teams: ['kc', 'phi'],
    labels: {},
    startMinutes: 13 * 60,
  });
  const first = quiet(() => session.tick(KICK - 3600_000));
  const second = quiet(() => session.tick(KICK - 3500_000));
  assert.strictEqual(quotesOf(first.value).length, 0);
  assert.strictEqual(quotesOf(second.value).length, 0);
  assert.ok(first.value.some((e) => e.kind === 'no_kickoff' && e.gameId === GAME));
  assert.ok(!second.value.some((e) => e.kind === 'no_kickoff'));
  const logs = [...first.lines, ...second.lines].filter((l) => l.includes('no kickoff') && l.includes(GAME));
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0], `[MM-PAPER] no kickoff ${GAME} — not quoting`);
  const later = quiet(() => {
    session.setKickoff(GAME, { polymarket: KICK });
    return session.tick(KICK - 3600_000);
  });
  assert.ok(quotesOf(later.value).length >= 1);
}

// Default 60s buffer: quote before the cutoff, pull at the cutoff, nothing after.
{
  const { session } = makeSession();
  const before = quiet(() => session.tick(KICK - 61_000));
  const rests = before.value.filter((e) => e.kind === 'quote');
  assert.strictEqual(rests.length, 2);

  const at = quiet(() => session.tick(KICK - 60_000));
  const cutoff = at.value.find((e) => e.kind === 'cutoff');
  assert.ok(cutoff);
  assert.strictEqual(cutoff.pulled, 2);
  assert.strictEqual(cutoff.bufferSec, 60);
  const expected = formatCutoffLine({
    gameId: GAME,
    kickoffEt: '2026-09-13 1:00 PM ET',
    bufferSec: 60,
    pulled: 2,
  });
  assert.strictEqual(cutoff.logLine, expected);
  assert.ok(at.lines.includes(expected));
  assert.ok(at.value.filter((e) => e.kind === 'pull' && e.reason === 'kickoff_cutoff').length === 2);
  assert.strictEqual(quotesOf(at.value).length, 0);
  assert.deepStrictEqual(session.snapshot()[0].quotes, {});

  session.setBook(GAME, 'polymarket', 'kc', book(0.55, 0.58, 0));
  session.setBook(GAME, 'kalshi', 'kc', book(0.55, 0.58, 0));
  session.setOdds(GAME, {
    kc: { prob: impliedProb(-130), american: -130, book: 'pinnacle' },
    phi: { prob: impliedProb(110), american: 110, book: 'pinnacle' },
  });
  const after = quiet(() => session.tick(KICK - 30_000));
  assert.strictEqual(quotesOf(after.value).length, 0);
  assert.ok(!after.value.some((e) => e.kind === 'quote' || e.kind === 'reprice' || e.kind === 'cutoff'));
  const rewound = quiet(() => session.tick(KICK - 120_000));
  assert.strictEqual(quotesOf(rewound.value).length, 0);
}

// Buffer env is the cutoff, not just a stored number.
{
  const { session, cfg } = makeSession({ bufferSec: 120 });
  assert.strictEqual(cfg.kickoffBufferSec, 120);
  const early = quiet(() => session.tick(KICK - 121_000));
  assert.strictEqual(early.value.filter((e) => e.kind === 'quote').length, 2);
  const cut = quiet(() => session.tick(KICK - 120_000));
  assert.ok(cut.value.some((e) => e.kind === 'cutoff' && e.bufferSec === 120 && e.pulled === 2));
  assert.strictEqual(quotesOf(cut.value).length, 0);
  const mid = quiet(() => session.tick(KICK - 90_000));
  assert.strictEqual(quotesOf(mid.value).length, 0);
}

// One bid on Kalshi and one on Polymarket are both pulled.
{
  const { session } = makeSession();
  session.setBook(GAME, 'polymarket', 'phi', book(0.38, 0.02, 0));
  session.setBook(GAME, 'kalshi', 'kc', book(0.54, 0.02, 0));
  const quoted = quiet(() => session.tick(KICK - 90_000));
  const rests = quoted.value.filter((e) => e.kind === 'quote');
  const venues = new Set(rests.map((e) => e.venue));
  assert.ok(venues.has('kalshi') && venues.has('polymarket'), `venues ${[...venues].join(',')}`);
  const cut = quiet(() => session.tick(KICK - 60_000));
  const pulls = cut.value.filter((e) => e.kind === 'pull' && e.reason === 'kickoff_cutoff');
  const pulledVenues = new Set(pulls.map((e) => e.venue));
  assert.ok(pulledVenues.has('kalshi') && pulledVenues.has('polymarket'));
  assert.strictEqual(session.snapshot()[0].quotes.kc, undefined);
  assert.strictEqual(session.snapshot()[0].quotes.phi, undefined);
}

// Fills that print before the cutoff count. Prints at or after the cutoff do not.
{
  const before = makeSession();
  const placed = quiet(() => before.session.tick(KICK - 90_000));
  const phi = placed.value.find((e) => e.kind === 'quote' && e.team === 'phi');
  assert.ok(phi);
  const filled = before.session.applyTrade(GAME, phi.venue, 'phi', {
    id: 'pre', price: phi.price, qty: phi.size, ts: KICK - 60_000 - 1,
  }, KICK - 1000);
  assert.strictEqual(filled[0] && filled[0].kind, 'fill');
  assert.strictEqual(filled[0].phase, 'pregame');
  assert.ok(before.session.snapshot()[0].positions.some((p) => p.team === 'phi' && p.qty === phi.size));

  const at = makeSession();
  const atQuotes = quiet(() => at.session.tick(KICK - 90_000));
  const atPhi = atQuotes.value.find((e) => e.kind === 'quote' && e.team === 'phi');
  const ignoredAt = at.session.applyTrade(GAME, atPhi.venue, 'phi', {
    id: 'at', price: atPhi.price, qty: atPhi.size, ts: KICK - 60_000,
  }, KICK - 90_000);
  assert.strictEqual(ignoredAt.length, 0);
  assert.strictEqual(at.session.snapshot()[0].positions.length, 0);

  const after = makeSession();
  const afterQuotes = quiet(() => after.session.tick(KICK - 90_000));
  const afterPhi = afterQuotes.value.find((e) => e.kind === 'quote' && e.team === 'phi');
  const ignoredAfter = after.session.applyTrade(GAME, afterPhi.venue, 'phi', {
    id: 'post', price: afterPhi.price, qty: afterPhi.size, ts: KICK + 1000,
  }, KICK - 90_000);
  assert.strictEqual(ignoredAfter.length, 0);
  assert.strictEqual(after.session.snapshot()[0].positions.length, 0);
}

// Open lots and a locked pair survive a restart, and the same print does not fill twice.
{
  const first = makeSession({ kickoff: SAME_DAY_KICK });
  const placed = quiet(() => first.session.tick(KICK));
  const byTeam = Object.fromEntries(placed.value.filter((e) => e.kind === 'quote').map((e) => [e.team, e]));
  assert.ok(byTeam.phi && byTeam.kc);
  const phiFill = first.session.applyTrade(GAME, byTeam.phi.venue, 'phi', {
    id: 'phi-1', price: byTeam.phi.price, qty: byTeam.phi.size, ts: KICK + 1000,
  }, KICK + 1000);
  const kcFill = first.session.applyTrade(GAME, byTeam.kc.venue, 'kc', {
    id: 'kc-1', price: byTeam.kc.price, qty: byTeam.kc.size, ts: KICK + 2000,
  }, KICK + 2000);
  assert.strictEqual(phiFill[0].kind, 'fill');
  assert.ok(kcFill.some((e) => e.kind === 'pair'));
  const tape = [...placed.value, ...phiFill, ...kcFill];
  const before = first.session.snapshot()[0];
  const openBefore = before.positions.reduce((s, p) => s + p.qty, 0);

  const second = makeSession({ kickoff: false });
  const once = quiet(() => second.session.restoreFromEvents(tape, KICK + 5000)).value;
  const twice = quiet(() => second.session.restoreFromEvents(tape, KICK + 5000)).value;
  const afterSnap = second.session.snapshot()[0];
  const openAfter = afterSnap.positions.reduce((s, p) => s + p.qty, 0);
  assert.strictEqual(openAfter, openBefore);
  assert.strictEqual(twice.openQty, once.openQty);
  assert.strictEqual(roundCents(afterSnap.lockedPnl), roundCents(before.lockedPnl));
  assert.ok(afterSnap.lockedPnl > 0);

  quiet(() => second.session.setKickoff(GAME, { polymarket: SAME_DAY_KICK }));
  for (const venue of ['kalshi', 'polymarket']) {
    second.session.setBook(GAME, venue, 'kc', book(0.54, 0.56, 0));
    second.session.setBook(GAME, venue, 'phi', book(0.38, 0.42, 0));
  }
  quiet(() => second.session.tick(KICK + 6000));
  const again = second.session.applyTrade(GAME, byTeam.phi.venue, 'phi', {
    id: 'phi-1', price: byTeam.phi.price, qty: byTeam.phi.size, ts: KICK + 1000,
  }, KICK + 7000);
  assert.strictEqual(again.length, 0);
  const openStill = second.session.snapshot()[0].positions.reduce((s, p) => s + p.qty, 0);
  assert.strictEqual(openStill, openBefore);
  assert.strictEqual(roundCents(second.session.snapshot()[0].lockedPnl), roundCents(before.lockedPnl));
}

function roundCents(n) {
  return Math.round(Number(n) * 100) / 100;
}

async function quietAsync(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { lines, value: await fn() };
  } finally {
    console.log = orig;
  }
}

async function main() {
// Supabase down falls back to JSONL. A successful Supabase read is the only
// source, so the same fill in both stores counts once.
{
  const seeded = makeSession({ kickoff: SAME_DAY_KICK });
  const placed = quiet(() => seeded.session.tick(KICK));
  const phi = placed.value.find((e) => e.kind === 'quote' && e.team === 'phi');
  const filled = seeded.session.applyTrade(GAME, phi.venue, 'phi', {
    id: 'jsonl-fill', price: phi.price, qty: phi.size, ts: KICK + 1000,
  }, KICK + 1000);
  const fill = filled.find((e) => e.kind === 'fill');
  assert.ok(fill);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-paper-'));
  const file = path.join(dir, 'mm-paper.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(fill)}\n`);
  const failing = {
    from() {
      return {
        select() { return this; },
        order() { return this; },
        range: async () => ({ data: null, error: { message: 'offline' } }),
      };
    },
  };
  const fresh = createPaperSession(readConfig({ MM_PAPER: '1' }));
  const runner = createRunner({
    MM_PAPER: '1',
    MM_LOG_PATH: file,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_KEY: 'test-key',
  }, {
    supabase: failing,
    session: fresh,
    kalshi: null,
    poly: null,
    polyWs: false,
    log: { write: async () => {}, supabaseDisabled: () => true },
  });
  const restored = await quietAsync(() => runner.restore(KICK + 5000));
  assert.strictEqual(restored.value.source, 'jsonl');
  assert.strictEqual(fresh.snapshot()[0].positions[0].qty, fill.qty);
  runner.stop();

  const duped = await loadPaperHistory({
    filePath: file,
    supabase: {
      from() {
        return {
          select() { return this; },
          order() { return this; },
          range: async () => ({ data: [{ payload: fill }], error: null }),
        };
      },
    },
  });
  assert.strictEqual(duped.source, 'supabase');
  assert.strictEqual(duped.events.filter((e) => e.kind === 'fill').length, 1);
  const merged = createPaperSession(readConfig({ MM_PAPER: '1' }));
  const stats = quiet(() => merged.restoreFromEvents(duped.events, KICK + 5000)).value;
  assert.strictEqual(stats.openQty, fill.qty);
}

// Summary splits pregame and ingame, shows American odds, and settles leftovers.
{
  const preTs = KICK - 120_000;
  const inTs = KICK + 10_000;
  const events = [
    {
      kind: 'fill',
      gameId: GAME,
      league: 'nfl',
      team: 'phi',
      venue: 'polymarket',
      qty: 10,
      price: 0.4,
      net: 0.4,
      ts: preTs,
      tradeTs: preTs,
      tradeId: 'sum-pre',
      tradeKey: 'polymarket|phi|sum-pre',
      kalshiTicker: 'KXNFLGAME-26SEP13KCPHI-PHI',
      kickoffMs: KICK,
      bufferSec: 60,
      phase: 'pregame',
    },
    {
      kind: 'fill',
      gameId: GAME,
      league: 'nfl',
      team: 'phi',
      venue: 'polymarket',
      qty: 10,
      price: 0.4,
      net: 0.4,
      ts: preTs,
      tradeId: 'sum-pre',
      tradeKey: 'polymarket|phi|sum-pre',
      kalshiTicker: 'KXNFLGAME-26SEP13KCPHI-PHI',
      kickoffMs: KICK,
      phase: 'pregame',
    },
    {
      kind: 'fill',
      gameId: GAME,
      league: 'nfl',
      team: 'kc',
      venue: 'kalshi',
      qty: 4,
      price: 0.55,
      net: 0.55,
      ts: inTs,
      tradeTs: inTs,
      tradeId: 'sum-in',
      tradeKey: 'kalshi|kc|sum-in',
      kalshiTicker: 'KXNFLGAME-26SEP13KCPHI-KC',
      kickoffMs: KICK,
      bufferSec: 60,
    },
    {
      kind: 'pair',
      gameId: GAME,
      ts: preTs + 1000,
      qty: 0,
      lockedProfit: 1.25,
      phase: 'pregame',
      kickoffMs: KICK,
      legs: [{ team: 'phi' }, { team: 'kc' }],
    },
  ];
  assert.strictEqual(phaseOf(events[2], new Map()), 'ingame');
  const rows = summarize(events);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].phases.pregame.fills, 1);
  assert.strictEqual(rows[0].phases.ingame.fills, 1);
  assert.strictEqual(rows[0].fills, 2);
  assert.strictEqual(rows[0].phases.pregame.locked, 1.25);
  await settleRows(rows, async (ticker) => {
    if (ticker.endsWith('-PHI')) return { result: 'no' };
    if (ticker.endsWith('-KC')) return { result: '' };
    return null;
  });
  const text = formatReport(rows);
  assert.match(text, /pregame fills=1/);
  assert.match(text, /ingame fills=1/);
  assert.match(text, /\+150/);
  assert.match(text, /settledLeftover=-\$4\.00/);
  assert.match(text, /open=4/);
  assert.match(text, /net=-\$2\.75/);
  assert.match(text, /locked=\$1\.25/);
}

const oddsGames = attachOdds([
  {
    gameId: GAME,
    league: 'nfl',
    date: '2026-09-13',
    teams: ['kc', 'phi'],
    labels: { kc: 'Kansas City Chiefs', phi: 'Philadelphia Eagles' },
    startMinutes: null,
    rawTeams: ['kc', 'phi'],
  },
], [{
  sport: 'americanfootball_nfl',
  fetched_at: '2026-09-13T16:00:00Z',
  data: [{
    home_team: 'Kansas City Chiefs',
    away_team: 'Philadelphia Eagles',
    commence_time: '2026-09-13T17:00:00Z',
    bookmakers: [{
      key: 'pinnacle',
      markets: [{ key: 'h2h', outcomes: [
        { name: 'Kansas City Chiefs', price: -150 },
        { name: 'Philadelphia Eagles', price: 130 },
      ] }],
    }],
  }],
}], { now: Date.parse('2026-09-13T16:00:00Z'), maxAgeMs: 360000, pinnacleMaxDev: 0.03 });
assert.strictEqual(oddsGames[0].commenceMs, KICK);
}

main().then(() => {
  console.log('mm-paper-cutoff.test.js ok');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
