'use strict';
const assert = require('assert');
const { createTelegramGate, classifyAlert } = require('./tg-gate');
const { createPolyDeskFillWatcher } = require('./poly-desk-fills');
const { formatAlertStatus } = require('./venue-alert');
const { formatOverfillAlert } = require('./cap-confirm');

(async () => {
  // Classification: fills (both venues) + failed transfers only.
  assert.strictEqual(classifyAlert(`${formatAlertStatus('✅ FILL CONFIRMED', 'polymarket')} — A + B\nx`), 'fill');
  assert.strictEqual(classifyAlert(`${formatAlertStatus('✅ FILL CONFIRMED', 'kalshi')} — A + B`), 'fill');
  assert.strictEqual(classifyAlert('💰 REAL FILL (from Kalshi account) — T'), 'fill');
  assert.strictEqual(classifyAlert('💰 DESK FILL (Polymarket US) — x'), 'fill');
  assert.strictEqual(classifyAlert(formatOverfillAlert({ venue: 'polymarket', label: 'L', quoted: 1, filled: 2 })), 'fill');
  assert.strictEqual(classifyAlert('Kalshi bucket transfer failed\n$5'), 'critical');
  assert.strictEqual(classifyAlert('Kalshi bucket transfer not confirmed\nid'), 'critical');
  for (const t of [
    `${formatAlertStatus('✅ QUOTED', 'kalshi')} — L`, `${formatAlertStatus('❌ QUOTE FAILED', 'kalshi')} — L\nFILL CONFIRMED`,
    `${formatAlertStatus('❌ CONFIRM FAILED', 'kalshi')} — L`, 'Kalshi combo bucket low\n..', 'INSUFFICIENT BALANCE (Kalshi)',
    'Polymarket cash low', '⚠️ RFQ matched but DECLINED', 'Kalshi WS down', '⚠️ [LIVE] HOLD FORCE-RELEASED', 'Bet Protect · x',
  ]) assert.strictEqual(classifyAlert(t), null, t);

  // Gate: routine never hits the network; fills batch; 429 pauses and resumes.
  let clock = 1000;
  const calls = [];
  let reply = { status: 200, ok: true };
  const timers = [];
  const gate = createTelegramGate({
    env: { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALERT_CHAT_ID: 'c', TG_MIN_GAP_MS: '3000' },
    now: () => clock,
    pauseFile: null,
    log: () => {},
    setTimeout: (fn, ms) => { timers.push({ fn, at: clock + ms }); },
    fetchImpl: async (url, o) => { calls.push(JSON.parse(o.body).text); const r = reply; return { ...r, json: async () => r.body }; },
  });
  await gate.send('✅ QUOTED (Kalshi) — L');
  assert.strictEqual(calls.length, 0);
  await gate.send('✅ FILL CONFIRMED (Kalshi) — A');
  assert.strictEqual(calls.length, 1);
  await gate.send('✅ FILL CONFIRMED (Kalshi) — B');
  await gate.send('✅ FILL CONFIRMED (Polymarket) — C');
  assert.strictEqual(calls.length, 1, 'min gap holds second send');
  clock += 3000; timers.shift().fn(); await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[1].includes('— B') && calls[1].includes('— C'), 'batched');

  // 429: respect retry_after, no hammering during the pause.
  reply = { status: 429, ok: false, body: { parameters: { retry_after: 600 } } };
  clock += 3000;
  await gate.send('✅ FILL CONFIRMED (Polymarket) — D');
  assert.strictEqual(calls.length, 3);
  const pausedUntil = gate._state().pausedUntil;
  assert.ok(pausedUntil >= clock + 600000);
  reply = { status: 200, ok: true };
  for (let i = 0; i < 60; i++) await gate.send(`✅ FILL CONFIRMED (Kalshi) — F${i}`);
  assert.strictEqual(calls.length, 3, 'nothing sent while paused');
  assert.ok(gate._state().queue.length <= 40);
  clock = pausedUntil + 1;
  while (timers.length) { const t = timers.shift(); t.fn(); await new Promise((r) => setImmediate(r)); clock += 3000; }
  assert.ok(calls.length >= 4);
  assert.ok(calls[3].includes('dropped while Telegram was rate-limited'));
  assert.ok(calls.join('\n').includes('— F59'));

  // Desk fill watcher: primes silently, skips combo slugs, alerts desk trades.
  let acts = [{ type: 'ACTIVITY_TYPE_TRADE', trade: { id: 'old', qty: '5', price: '0.4', marketSlug: 'nfl-x' } }];
  const sent = [];
  const w = createPolyDeskFillWatcher({
    http: { listActivities: async () => ({ activities: acts }) },
    sendAlert: async (t) => { sent.push(t); },
    log: () => {},
  });
  await w.tick();
  assert.strictEqual(sent.length, 0);
  acts = [
    { type: 'ACTIVITY_TYPE_TRADE', trade: { id: 'combo1', qty: '10', price: '0.2', marketSlug: 'caoc-abc' } },
    { type: 'ACTIVITY_TYPE_TRADE', trade: { id: 'desk1', qty: '20', price: '0.55', marketSlug: 'mlb-cle-lad', marketMetadata: { title: 'Guardians vs Dodgers' } } },
    ...acts,
  ];
  await w.tick();
  assert.strictEqual(sent.length, 1);
  assert.ok(/DESK FILL/.test(sent[0]) && sent[0].includes('Guardians vs Dodgers'));
  assert.strictEqual(classifyAlert(sent[0]), 'fill');
  await w.tick();
  assert.strictEqual(sent.length, 1, 'no repeat');
  console.log('tg-gate.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
