'use strict';
const assert = require('assert');
const { createPaperSession } = require('./mm-paper-engine');
const { impliedProb, pairNetsOk } = require('./mm-paper-math');
const { readConfig } = require('./mm-paper-config');

function book(bid, ask, bidSize) {
  return {
    bids: [{ price: bid, size: bidSize }],
    asks: [{ price: ask, size: 50 }],
  };
}

function sessionWithGame(overrides = {}) {
  const cfg = {
    ...readConfig({ MM_PAPER: '1', MM_ORDER_SIZE: '10', MM_POSITION_CAP: '100' }),
    ...overrides,
  };
  const session = createPaperSession(cfg);
  const gameId = 'nfl|2026-09-13|kc+phi';
  session.upsertGame({
    gameId,
    league: 'nfl',
    date: '2026-09-13',
    teams: ['kc', 'phi'],
    labels: { kc: 'Chiefs', phi: 'Eagles' },
  });
  session.setOdds(gameId, {
    kc: { prob: impliedProb(-150), american: -150, book: 'pinnacle' },
    phi: { prob: impliedProb(130), american: 130, book: 'pinnacle' },
  });
  for (const venue of ['kalshi', 'polymarket']) {
    session.setBook(gameId, venue, 'kc', book(0.54, 0.56, 100));
    session.setBook(gameId, venue, 'phi', book(0.38, 0.42, 20));
  }
  return { session, gameId, cfg };
}

const { session, gameId } = sessionWithGame();
const now = Date.parse('2026-09-13T16:00:00Z');
const quoted = session.tick(now);
const rests = quoted.filter((e) => e.kind === 'quote');
assert.strictEqual(rests.length, 2);
for (const q of rests) {
  assert.strictEqual(q.venue, 'polymarket');
  assert.ok(q.cents > 0);
  assert.ok(q.american);
  assert.strictEqual(q.orders, 'none');
  assert.ok(q.net < q.lockPrice + 1e-9);
}
const byTeam = Object.fromEntries(rests.map((q) => [q.team, q]));
assert.strictEqual(byTeam.phi.cents, 38);
assert.strictEqual(byTeam.kc.cents, 54);
assert.ok(pairNetsOk(byTeam.phi.net, byTeam.kc.net));
assert.ok(byTeam.phi.net + byTeam.kc.net < 1);

// Size already at 38¢ trades first. 20 contracts do not fill us.
const none = session.applyTrade(gameId, 'polymarket', 'phi', {
  id: 't-queue', price: 0.38, qty: 20, ts: now + 1000,
}, now + 1000);
assert.strictEqual(none.length, 0);

const filled = session.applyTrade(gameId, 'polymarket', 'phi', {
  id: 't-fill', price: 0.38, qty: 10, ts: now + 2000,
}, now + 2000);
assert.strictEqual(filled[0].kind, 'fill');
assert.strictEqual(filled[0].qty, 10);
assert.strictEqual(filled[0].cents, 38);
assert.ok(filled[0].american);
assert.ok(!filled.some((e) => e.kind === 'pair'));

const stepped = session.tick(now + 3000);
const hedge = stepped.find((e) => e.kind === 'hedge');
assert.ok(hedge);
assert.strictEqual(hedge.placed, false);
assert.strictEqual(hedge.bookAmerican, -150);
assert.ok(hedge.bookCents);
assert.ok(hedge.lockedIfHedged > 0);
const reprice = stepped.find((e) => e.kind === 'reprice' && e.team === 'kc');
assert.ok(reprice);
assert.strictEqual(reprice.cents, 55);
assert.ok(pairNetsOk(filled[0].net, reprice.net));
assert.ok(filled[0].net + reprice.net < 1);

// Do not step through the pair ceiling. A 60¢ fill leaves < 40¢ for the other side.
const tight = sessionWithGame();
tight.session.setBook(gameId, 'polymarket', 'phi', book(0.6, 0.63, 0));
tight.session.setBook(gameId, 'kalshi', 'phi', book(0.6, 0.63, 0));
// Cap on phi is the inverse of kc 0.60 → 0.40, so 60¢ is not quotable.
const tightQuotes = tight.session.tick(now);
const phiQuote = tightQuotes.find((e) => e.kind === 'quote' && e.team === 'phi');
assert.ok(phiQuote);
assert.ok(phiQuote.cents <= 40);
assert.ok(phiQuote.net <= 0.4 + 1e-9);

// One-sided 60¢ inventory: the other bid cannot be raised to a combined $1.
const held = createPaperSession(readConfig({ MM_PAPER: '1', MM_ORDER_SIZE: '10' }));
held.upsertGame({
  gameId, league: 'nfl', date: '2026-09-13', teams: ['kc', 'phi'], labels: {},
});
held.setOdds(gameId, {
  kc: { prob: 0.35, american: -186, book: 'pinnacle' },
  phi: { prob: 0.35, american: -186, book: 'pinnacle' },
});
held.setBook(gameId, 'kalshi', 'kc', book(0.62, 0.66, 0));
held.setBook(gameId, 'polymarket', 'kc', book(0.62, 0.66, 0));
held.setBook(gameId, 'kalshi', 'phi', book(0.62, 0.66, 0));
held.setBook(gameId, 'polymarket', 'phi', book(0.62, 0.66, 0));
// Seed a fill by quoting at an empty level under a loose book, then trading through.
const seeded = held.tick(now);
const bothQuotes = seeded.filter((e) => e.kind === 'quote');
assert.strictEqual(bothQuotes.length, 2);
for (const q of bothQuotes) assert.ok(q.net < 0.65);
const nets = bothQuotes.map((q) => q.net);
assert.ok(nets[0] + nets[1] < 1);

const kcQ = bothQuotes.find((q) => q.team === 'kc');
const got = held.applyTrade(gameId, kcQ.venue, 'kc', {
  id: 'through', price: kcQ.price - 0.02, qty: kcQ.size, ts: now + 5000,
}, now + 5000);
assert.strictEqual(got[0].kind, 'fill');
const after = held.tick(now + 6000);
const phiAfter = after.find((e) => (e.kind === 'quote' || e.kind === 'reprice') && e.team === 'phi')
  || held.snapshot()[0].quotes.phi;
const phiNet = phiAfter && (phiAfter.net != null ? phiAfter.net : held.snapshot()[0].quotes.phi.net);
if (phiNet != null) {
  assert.ok(got[0].net + phiNet < 1, `pair net ${got[0].net + phiNet} crossed $1`);
}

// Adverse sportsbook move pulls the resting bid.
const { session: adv, gameId: gid } = sessionWithGame();
adv.tick(now);
adv.setOdds(gid, {
  kc: { prob: impliedProb(-150), american: -150, book: 'pinnacle' },
  phi: { prob: impliedProb(-110), american: -110, book: 'pinnacle' },
});
const pulled = adv.tick(now + 10000);
assert.ok(pulled.some((e) => e.kind === 'pull' && e.team === 'kc' && e.reason === 'sportsbook_adverse'));

// Daily loss limit halts and pulls. Open mark is the book mid.
const { session: loss } = sessionWithGame({ dailyLossLimit: 1 });
loss.tick(now);
loss.applyTrade(gameId, 'polymarket', 'phi', {
  id: 'loss-fill', price: 0.38, qty: 30, ts: now + 1000,
}, now + 1000);
loss.setBook(gameId, 'polymarket', 'phi', book(0.08, 0.12, 10));
loss.setBook(gameId, 'kalshi', 'phi', book(0.08, 0.12, 10));
const halted = loss.tick(now + 2000);
assert.ok(halted.some((e) => e.kind === 'halt' && e.reason === 'daily_loss_limit'));
assert.ok(halted.some((e) => e.kind === 'pull'));
const later = loss.tick(now + 3000);
assert.ok(!later.some((e) => e.kind === 'quote'));

console.log('mm-paper-engine.test.js ok');
