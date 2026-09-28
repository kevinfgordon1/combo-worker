'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPaperSession } = require('./mm-paper-engine');
const { readConfig } = require('./mm-paper-config');
const { impliedProb } = require('./mm-paper-math');
const { createRunner } = require('./mm-paper-runner');
const {
  paperEventKey,
  loadPaperHistory,
  loadSupabasePaperEvents,
  compareReplayToSnapshots,
  formatRestoreLog,
} = require('./mm-paper-state');
const { main: summaryMain, formatCompare } = require('./scripts/mm-paper-summary');

const KICK = Date.parse('2026-09-13T23:00:00Z');
const GAME = 'nfl|2026-09-13|kc+phi';
const BULK = 'nfl|2026-09-13|dal+nyg';

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

function roundLot(lot) {
  const n = (v) => Math.round(Number(v) * 1e8) / 1e8;
  return {
    gameId: lot.gameId,
    team: lot.team,
    venue: lot.venue || null,
    qty: n(lot.qty),
    net: n(lot.net),
    price: n(lot.price),
  };
}

function lotsOf(session) {
  return session.openLots().map(roundLot);
}

function assertSameLots(actual, expected) {
  assert.deepStrictEqual(actual.map(roundLot), expected.map(roundLot));
}

function arm(session, gameId, teams) {
  const [a, b] = teams;
  session.upsertGame({
    gameId,
    league: 'nfl',
    date: '2026-09-13',
    teams,
    labels: {},
    kalshi: {
      [a]: { ticker: `KXNFLGAME-26SEP13-${a.toUpperCase()}` },
      [b]: { ticker: `KXNFLGAME-26SEP13-${b.toUpperCase()}` },
    },
  });
  session.setOdds(gameId, {
    [a]: { prob: impliedProb(-150), american: -150, book: 'pinnacle' },
    [b]: { prob: impliedProb(130), american: 130, book: 'pinnacle' },
  });
  for (const venue of ['kalshi', 'polymarket']) {
    session.setBook(gameId, venue, a, book(0.54, 0.56, 0));
    session.setBook(gameId, venue, b, book(0.38, 0.42, 0));
  }
  quiet(() => session.setKickoff(gameId, { polymarket: KICK }));
}

function quoteOf(session, gameId, team) {
  const snap = session.snapshot().find((row) => row.gameId === gameId);
  return snap && snap.quotes[team];
}

function fill(session, gameId, team, qty, now, id) {
  const quote = quoteOf(session, gameId, team);
  assert.ok(quote, `missing quote ${gameId} ${team}`);
  return session.applyTrade(gameId, quote.venue, team, {
    id,
    price: quote.price - 0.02,
    qty,
    ts: now,
  }, now);
}

function pagingClient(rows, { honorKind = true } = {}) {
  const calls = [];
  return {
    calls,
    from() {
      const state = { kinds: null };
      const api = {
        select() { return api; },
        in(_col, vals) {
          state.kinds = vals.slice();
          return api;
        },
        order() { return api; },
        range(from, to) {
          calls.push({ from, to, kinds: state.kinds ? state.kinds.slice() : null });
          let list = rows;
          if (honorKind && state.kinds) list = list.filter((row) => state.kinds.includes(row.kind));
          return Promise.resolve({ data: list.slice(from, to + 1), error: null });
        },
      };
      return api;
    },
  };
}

function rowsFrom(events, { junk = 0 } = {}) {
  const history = events.filter((ev) => ev.kind === 'fill' || ev.kind === 'pair' || ev.kind === 'cutoff');
  const rows = [];
  for (let i = 0; i < junk; i += 1) {
    rows.push({
      id: `junk-${i}`,
      kind: 'quote',
      game_id: GAME,
      created_at: new Date(1_700_000_000_000 + i).toISOString(),
      payload: { kind: 'quote', gameId: GAME, ts: i },
    });
  }
  history.forEach((ev, i) => {
    rows.push({
      id: `hist-${String(i).padStart(6, '0')}`,
      kind: ev.kind,
      game_id: ev.gameId,
      venue: ev.venue || null,
      team: ev.team || null,
      created_at: new Date(1_800_000_000_000 + i).toISOString(),
      payload: ev,
    });
  });
  return rows;
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = (i * 17 + 3) % (i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

const src = fs.readFileSync(path.join(__dirname, 'mm-paper-state.js'), 'utf8');
assert.ok(!src.includes('from < 50000'), 'restore must not stop at a 50000-row offset');
assert.ok(src.includes(".in('kind'"), 'restore must filter fill/pair/cutoff on the server');

const cfg = readConfig({
  MM_PAPER: '1',
  MM_ORDER_SIZE: '2000',
  MM_POSITION_CAP: '100000',
});
const live = createPaperSession(cfg);
arm(live, GAME, ['kc', 'phi']);
arm(live, BULK, ['dal', 'nyg']);
const t0 = KICK - 3600_000;
quiet(() => live.tick(t0));

const emitted = [];
const now = t0 + 1000;
const repeated = [];
repeated.push(...fill(live, GAME, 'kc', 1, now, 'kc-a'));
repeated.push(...fill(live, GAME, 'phi', 1, now, 'phi-a'));
repeated.push(...fill(live, GAME, 'kc', 1, now, 'kc-b'));
repeated.push(...fill(live, GAME, 'phi', 1, now, 'phi-b'));
emitted.push(...repeated);
const pairKeys = repeated.filter((ev) => ev.kind === 'pair').map(paperEventKey);
assert.strictEqual(pairKeys.length, 2);
assert.strictEqual(pairKeys[0], pairKeys[1], 'partial tape should emit two identical pair keys');

emitted.push(...fill(live, GAME, 'kc', 6.77, now, 'kc-partial'));
emitted.push(...fill(live, GAME, 'phi', 2.5, now, 'phi-partial'));

for (let i = 0; i < 550; i += 1) {
  const ts = now + 10_000 + i;
  emitted.push(...fill(live, BULK, 'dal', 1, ts, `dal-${i}`));
  emitted.push(...fill(live, BULK, 'nyg', 1, ts, `nyg-${i}`));
}
emitted.push(...quiet(() => live.tick(now + 20_000)).value);

const historyKinds = emitted.filter((ev) => ev.kind === 'fill' || ev.kind === 'pair');
assert.ok(historyKinds.length > 1000, `expected >1000 fill/pair events, got ${historyKinds.length}`);
const before = lotsOf(live);
assert.ok(before.some((lot) => lot.gameId === GAME && lot.team === 'kc' && Math.abs(lot.qty - 4.27) < 1e-6));

const restored = createPaperSession(readConfig({ MM_PAPER: '1' }));
const once = quiet(() => restored.restoreFromEvents(emitted, now + 30_000)).value;
const twice = quiet(() => restored.restoreFromEvents(emitted, now + 30_000)).value;
assertSameLots(restored.openLots(), before);
assert.strictEqual(twice.openQty, once.openQty);
const lotSum = once.lots.reduce((sum, lot) => sum + lot.qty, 0);
assert.ok(Math.abs(lotSum - once.openQty) < 1e-6);

const stripped = emitted.map((ev) => {
  const copy = { ...ev };
  delete copy.seq;
  delete copy.id;
  delete copy.createdAt;
  return copy;
});
const historical = createPaperSession(readConfig({ MM_PAPER: '1' }));
quiet(() => historical.restoreFromEvents(stripped, now + 30_000));
assertSameLots(historical.openLots(), before);
quiet(() => historical.restoreFromEvents(stripped, now + 31_000));
assertSameLots(historical.openLots(), before);

const compare = compareReplayToSnapshots(emitted);
assert.strictEqual(compare.ok, true, JSON.stringify(compare.diffs));
assert.match(formatCompare(compare, 'events'), /compare ok/);

async function main() {
  const ordered = rowsFrom(emitted);
  const shuffled = shuffle(ordered);
  const paged = pagingClient(shuffled, { honorKind: true });
  const loaded = await loadPaperHistory({ supabase: paged });
  assert.strictEqual(loaded.source, 'supabase');
  assert.ok(loaded.events.length > 1000);
  assert.ok(paged.calls.length > 1, 'expected a second page past the 1000-row default');
  assert.ok(paged.calls.some((call) => call.from === 1000));
  assert.ok(paged.calls.every((call) => call.to - call.from + 1 === 1000));
  assert.ok(paged.calls[0].kinds.includes('fill') && paged.calls[0].kinds.includes('pair'));
  const fromPages = createPaperSession(readConfig({ MM_PAPER: '1' }));
  quiet(() => fromPages.restoreFromEvents(loaded.events, now + 30_000));
  assertSameLots(fromPages.openLots(), before);

  const junked = pagingClient(rowsFrom(emitted, { junk: 1000 }), { honorKind: false });
  const pastJunk = await loadSupabasePaperEvents(junked);
  assert.ok(junked.calls.length >= 2);
  assert.ok(pastJunk.rowsRead > pastJunk.events.length);
  const fromJunk = createPaperSession(readConfig({ MM_PAPER: '1' }));
  quiet(() => fromJunk.restoreFromEvents(pastJunk.events, now + 30_000));
  assertSameLots(fromJunk.openLots(), before);

  const tiny = pagingClient(ordered.slice(0, 5), { honorKind: true });
  const tinyLoaded = await loadSupabasePaperEvents(tiny, { pageSize: 2 });
  assert.deepStrictEqual(tiny.calls.map((call) => call.from), [0, 2, 4]);
  assert.strictEqual(tinyLoaded.events.length, 5);
  assert.strictEqual(tinyLoaded.pages, 3);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-paper-restore-'));
  const file = path.join(dir, 'mm-paper.jsonl');
  fs.writeFileSync(file, `${emitted.map((ev) => JSON.stringify(ev)).join('\n')}\n`);
  const runner = createRunner({
    MM_PAPER: '1',
    MM_LOG_PATH: file,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_KEY: 'test-key',
  }, {
    supabase: pagingClient(shuffled),
    session: createPaperSession(readConfig({ MM_PAPER: '1' })),
    kalshi: null,
    poly: null,
    polyWs: false,
    log: { write: async () => {}, supabaseDisabled: () => true },
  });
  const started = await quietAsync(() => runner.restore(now + 40_000));
  runner.stop();
  assert.strictEqual(started.value.source, 'supabase');
  assert.ok(started.value.events > 1000);
  const restoredLines = started.lines.filter((line) => line.startsWith('[MM-PAPER] restored'));
  assert.match(restoredLines[0], new RegExp(`\\(${started.value.events} events, ${started.value.rowsRead} rows read, ${started.value.pages} pages\\)`));
  assert.ok(restoredLines.some((line) => line.startsWith(`[MM-PAPER] restored lot ${GAME}`)));
  assert.ok(restoredLines.some((line) => line.includes('kc 4.27')));
  assert.ok(started.lines.some((line) => line.includes('kickoff nfl|2026-09-13|kc+phi') && line.includes('kickoff=2026-09-13')));
  const loggedSum = started.value.lots.reduce((sum, lot) => sum + lot.qty, 0);
  assert.ok(Math.abs(loggedSum - started.value.openQty) < 1e-6);
  assertSameLots(runner.session.openLots(), before);
  const formatted = formatRestoreLog({
    openQty: started.value.openQty,
    lockedPnl: started.value.lockedPnl,
    source: started.value.source,
    events: started.value.events,
    rowsRead: started.value.rowsRead,
    pages: started.value.pages,
    lots: started.value.lots,
  });
  assert.deepStrictEqual(formatted, restoredLines);

  const compared = await quietAsync(() => summaryMain(
    ['node', 'scripts/mm-paper-summary.js', '--compare', file],
    { MM_PAPER_SETTLE: '0' },
  ));
  assert.strictEqual(compared.value.compare.ok, true);
  assert.ok(compared.lines[0].includes('compare ok'));
  assert.ok(compared.lines.some((line) => line.includes(GAME) && line.includes('kc')));
}

main().then(() => {
  console.log('mm-paper-restore.test.js ok');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
