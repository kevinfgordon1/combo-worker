'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  SECRET_HEADER,
  DEFAULT_POLL_MS,
  DEFAULT_THROUGH_CENTS,
  DEFAULT_REST_OFFSET_CENTS,
  readDeskProtectConfig,
  isDeskProtectEnabled,
  deskProtectDisabledMessage,
  isAdverseProtectEvent,
  formatAdverseProtectAlert,
  sweepBody,
  parseSweepResponse,
  safeErrorText,
  createDeskProtectPoller,
} = require('./desk-protect');

const URL = 'https://aibetbuilder.example/api/desk-protect-sweep';
const SECRET = 'desk-protect-test-secret';

function enabledEnv(extra = {}) {
  return {
    DESK_PROTECT_SWEEP_URL: URL,
    DESK_PROTECT_SWEEP_SECRET: SECRET,
    ...extra,
  };
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function adverseEvent(extra = {}) {
  return {
    id: 'prot_1',
    kind: 'adverse-reprice',
    adverse: true,
    orderId: 'order-canceled-abcde',
    newOrderId: 'order-rested-fghij',
    marketSlug: 'aec-nfl-lac-ten-2026-09-24',
    label: 'Titans',
    action: 'buy',
    outcome: 'short',
    fromCents: 43,
    toCents: 40,
    midCents: 46,
    throughCents: 6,
    restOffsetCents: 1,
    ...extra,
  };
}

assert.strictEqual(isDeskProtectEnabled({}), false);
assert.strictEqual(readDeskProtectConfig({}).disabledReason, 'unset');
assert.strictEqual(readDeskProtectConfig({}).pollMs, DEFAULT_POLL_MS);
assert.strictEqual(readDeskProtectConfig({}).throughCents, DEFAULT_THROUGH_CENTS);
assert.strictEqual(readDeskProtectConfig({}).restOffsetCents, DEFAULT_REST_OFFSET_CENTS);
assert.ok(deskProtectDisabledMessage(readDeskProtectConfig({})).includes('DESK_PROTECT_SWEEP_URL unset'));

{
  const cfg = readDeskProtectConfig({ DESK_PROTECT_SWEEP_URL: URL });
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.disabledReason, 'missing-secret');
  assert.ok(deskProtectDisabledMessage(cfg).includes('DESK_PROTECT_SWEEP_SECRET is missing'));
}

{
  const cfg = readDeskProtectConfig({ DESK_PROTECT_SWEEP_URL: URL, DESK_PROTECT_SWEEP_SECRET: 'short' });
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.disabledReason, 'short-secret');
}

{
  const cfg = readDeskProtectConfig({
    DESK_PROTECT_SWEEP_URL: 'http://evil.example/sweep',
    DESK_PROTECT_SWEEP_SECRET: SECRET,
  });
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.disabledReason, 'bad-url');
}

{
  const cfg = readDeskProtectConfig({
    DESK_PROTECT_SWEEP_URL: `https://user:${SECRET}@aibetbuilder.example/sweep`,
    DESK_PROTECT_SWEEP_SECRET: SECRET,
  });
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.disabledReason, 'bad-url');
}

{
  const cfg = readDeskProtectConfig({
    DESK_PROTECT_SWEEP_URL: `https://aibetbuilder.example/sweep?token=${SECRET}`,
    DESK_PROTECT_SWEEP_SECRET: SECRET,
  });
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.disabledReason, 'secret-in-url');
}

{
  const cfg = readDeskProtectConfig({
    DESK_PROTECT_SWEEP_URL: `"${URL}"`,
    DESK_PROTECT_SWEEP_SECRET: `'${SECRET}'`,
    DESK_PROTECT_POLL_MS: '500',
    DESK_PROTECT_THROUGH_CENTS: '0',
    DESK_PROTECT_REST_OFFSET_CENTS: '0',
  });
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.url, URL);
  assert.strictEqual(cfg.secret, SECRET);
  assert.strictEqual(cfg.pollMs, 1000);
  assert.strictEqual(cfg.throughCents, DEFAULT_THROUGH_CENTS);
  assert.strictEqual(cfg.restOffsetCents, 0);
}

{
  const cfg = readDeskProtectConfig(enabledEnv({
    DESK_PROTECT_POLL_MS: '99999',
    DESK_PROTECT_THROUGH_CENTS: '4.5',
    DESK_PROTECT_REST_OFFSET_CENTS: '2',
  }));
  assert.strictEqual(cfg.pollMs, 10000);
  assert.strictEqual(cfg.throughCents, 4.5);
  assert.strictEqual(cfg.restOffsetCents, 2);
  assert.strictEqual(isAllowedLocal(cfg), true);
}

function isAllowedLocal(cfg) {
  return cfg.enabled && cfg.url.startsWith('https://');
}

{
  const local = readDeskProtectConfig({
    DESK_PROTECT_SWEEP_URL: 'http://127.0.0.1:3000/api/desk-protect-sweep',
    DESK_PROTECT_SWEEP_SECRET: SECRET,
  });
  assert.strictEqual(local.enabled, true);
}

assert.strictEqual(isAdverseProtectEvent(adverseEvent()), true);
assert.strictEqual(isAdverseProtectEvent(adverseEvent({ kind: 'chase', adverse: true })), false);
assert.strictEqual(isAdverseProtectEvent(adverseEvent({ chase: true })), false);
assert.strictEqual(isAdverseProtectEvent(adverseEvent({ kind: 'follow-mid' })), false);
assert.strictEqual(isAdverseProtectEvent(adverseEvent({ adverse: false })), false);
assert.strictEqual(isAdverseProtectEvent({ id: 'x' }), false);
assert.strictEqual(isAdverseProtectEvent({ id: 'x', adverse: true }), true);

{
  const text = formatAdverseProtectAlert(adverseEvent());
  assert.ok(text.startsWith('⚠️ ADVERSE PROTECT (Polymarket) — Titans'));
  assert.ok(text.includes('buy 43¢ was 6¢ through mid 46¢'));
  assert.ok(text.includes('canceled abcde → re-rested fghij at 40¢'));
  assert.ok(!text.includes(SECRET));
}

{
  const body = sweepBody(readDeskProtectConfig(enabledEnv()), ['prot_1']);
  assert.strictEqual(body.op, 'sweep');
  assert.strictEqual(body.mode, 'adverse-only');
  assert.deepStrictEqual(body.defaults, { throughCents: 3, restOffsetCents: 1 });
  assert.deepStrictEqual(body.ackedIds, ['prot_1']);
  assert.ok(!JSON.stringify(body).includes(SECRET));
}

assert.deepStrictEqual(parseSweepResponse(200, { ok: true, events: [{ id: 'a' }] }), [{ id: 'a' }]);
assert.deepStrictEqual(parseSweepResponse(200, { events: [] }), []);
assert.throws(() => parseSweepResponse(401, { ok: false }), /sweep HTTP 401/);
assert.throws(() => parseSweepResponse(200, { ok: false, error: 'nope' }), /nope/);
assert.strictEqual(safeErrorText(`bad ${SECRET} here`, SECRET).includes(SECRET), false);

async function testPoller() {
  let calls = 0;
  const alerts = [];
  const seenBodies = [];
  const poller = createDeskProtectPoller({
    env: enabledEnv(),
    log() {},
    logError() {},
    sendAlert: async (text) => { alerts.push(text); },
    fetchImpl: async (url, opts) => {
      calls += 1;
      assert.strictEqual(url, URL);
      assert.strictEqual(opts.method, 'POST');
      assert.strictEqual(opts.redirect, 'manual');
      assert.strictEqual(opts.headers[SECRET_HEADER], SECRET);
      assert.ok(!opts.body.includes(SECRET));
      const body = JSON.parse(opts.body);
      assert.strictEqual(body.mode, 'adverse-only');
      seenBodies.push(body);
      return jsonResponse(200, { ok: true, events: [adverseEvent()] });
    },
  });
  assert.strictEqual(poller.config.enabled, true);
  assert.strictEqual(poller.config.sweepOrigin, URL);
  assert.ok(!('secret' in poller.config));
  const first = await poller.tick();
  assert.strictEqual(first.pinged, 1);
  assert.strictEqual(alerts.length, 1);
  const second = await poller.tick();
  assert.strictEqual(second.pinged, 0);
  assert.strictEqual(alerts.length, 1);
  assert.deepStrictEqual(seenBodies[1].ackedIds, ['prot_1']);
  assert.strictEqual(calls, 2);

  const disabled = createDeskProtectPoller({
    env: {},
    fetchImpl: async () => { throw new Error('should not fetch'); },
    sendAlert: async () => { throw new Error('should not alert'); },
    log() {},
  });
  assert.deepStrictEqual(await disabled.tick(), { skipped: 'disabled', reason: 'unset' });
  const started = disabled.start();
  assert.strictEqual(started.enabled, false);
  disabled.stop();
}

async function testChaseAndRetry() {
  const alerts = [];
  const errors = [];
  let t = 1000;
  let failTelegram = true;
  const events = [
    adverseEvent({ id: 'chase_1', kind: 'chase', chase: true }),
    adverseEvent({ id: 'plain_1', kind: '', adverse: undefined }),
    { kind: 'adverse-reprice', orderId: 'oid-old-11111', newOrderId: 'oid-new-22222', fromCents: 10, toCents: 8, label: 'Chargers', action: 'sell', midCents: 7, throughCents: 3 },
  ];
  const poller = createDeskProtectPoller({
    env: enabledEnv(),
    now: () => t,
    log() {},
    logError: (m) => errors.push(m),
    sendAlert: async (text) => {
      alerts.push(text);
      if (failTelegram) throw new Error(`telegram down ${SECRET}`);
    },
    fetchImpl: async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const acked = new Set(body.ackedIds);
      return jsonResponse(200, {
        ok: true,
        events: events.filter((ev) => !acked.has(ev.id) && !acked.has(`adverse:${ev.orderId}:${ev.newOrderId}:${ev.fromCents}:${ev.toCents}`)),
      });
    },
  });

  const first = await poller.tick();
  assert.strictEqual(first.pinged, 0);
  assert.strictEqual(alerts.length, 1);
  assert.ok(alerts[0].includes('sell 10¢'));
  assert.ok(errors.some((m) => m.includes('telegram failed') && !m.includes(SECRET)));
  assert.ok(poller.ackedIds().includes('chase_1'));
  assert.ok(poller.ackedIds().includes('plain_1'));

  t = 1001;
  await poller.tick();
  assert.strictEqual(alerts.length, 1, 'retry waits out the telegram cooldown');

  failTelegram = false;
  t = 1000 + 30000;
  const retried = await poller.tick();
  assert.strictEqual(retried.pinged, 1);
  assert.strictEqual(alerts.length, 2);
  assert.ok(poller.ackedIds().some((id) => id.startsWith('adverse:oid-old-11111:oid-new-22222')));

  const again = await poller.tick();
  assert.strictEqual(again.pinged, 0);
  assert.strictEqual(alerts.length, 2);
}

async function testInFlightAndErrors() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const errors = [];
  let t = 0;
  const hanging = createDeskProtectPoller({
    env: enabledEnv(),
    now: () => t,
    log() {},
    logError: (m) => errors.push(m),
    sendAlert: async () => {},
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return jsonResponse(200, { ok: true, events: [] });
    },
  });
  const pending = hanging.tick();
  const skipped = await hanging.tick();
  assert.strictEqual(skipped.skipped, 'in-flight');
  assert.strictEqual(calls, 1);
  release();
  assert.strictEqual((await pending).ok, true);

  const failing = createDeskProtectPoller({
    env: enabledEnv(),
    now: () => t,
    log() {},
    logError: (m) => errors.push(m),
    sendAlert: async () => { throw new Error('no alert'); },
    fetchImpl: async () => jsonResponse(500, `nope ${SECRET}`),
  });
  const boom = await failing.tick();
  assert.strictEqual(boom.ok, false);
  await failing.tick();
  assert.strictEqual(errors.filter((m) => m.includes('sweep HTTP 500')).length, 1);
  assert.ok(errors.every((m) => !m.includes(SECRET)));
  t = 60000;
  await failing.tick();
  assert.strictEqual(errors.filter((m) => m.includes('sweep HTTP 500')).length, 2);

  const redirected = createDeskProtectPoller({
    env: enabledEnv(),
    now: () => 0,
    log() {},
    logError() {},
    fetchImpl: async () => ({ status: 302, ok: false, text: async () => '' }),
  });
  const redir = await redirected.tick();
  assert.strictEqual(redir.ok, false);
  assert.ok(redir.error.includes('redirected'));
}

async function testCapAndQueue() {
  const alerts = [];
  const events = [];
  for (let i = 0; i < 30; i++) {
    events.push(adverseEvent({ id: `prot_${i}`, fromCents: 40 + i }));
  }
  const poller = createDeskProtectPoller({
    env: enabledEnv(),
    log() {},
    logError() {},
    sendAlert: async (text) => { alerts.push(text); },
    fetchImpl: async () => jsonResponse(200, { ok: true, events }),
  });
  const first = await poller.tick();
  assert.strictEqual(first.pinged, 25);
  assert.strictEqual(alerts.length, 25);
  const second = await poller.tick();
  assert.strictEqual(second.pinged, 5);
  assert.strictEqual(alerts.length, 30);
}

async function testSourceGuards() {
  const src = fs.readFileSync(path.join(__dirname, 'desk-protect.js'), 'utf8');
  const startLive = fs.readFileSync(path.join(__dirname, 'start-live.js'), 'utf8');
  const startUnhedged = fs.readFileSync(path.join(__dirname, 'start-unhedged.js'), 'utf8');
  assert.ok(src.includes("mode: 'adverse-only'"));
  assert.ok(!/mode:\s*'chase'/.test(src));
  assert.ok(!src.includes('polymarket-client'));
  assert.ok(!src.includes('POLYMARKET_SECRET'));
  assert.ok(!src.includes('supabase'));
  assert.ok(!src.includes('createOrder'));
  assert.ok(!src.includes('cancelOrder'));
  assert.ok(/if \(protectCfg\.enabled\) \{\s*run\('desk-protect\.js'\)/.test(startLive));
  assert.ok(!startUnhedged.includes('desk-protect'));
  const startedOff = createDeskProtectPoller({ env: {}, log() {} });
  const off = startedOff.start();
  assert.strictEqual(off.enabled, false);
  startedOff.stop();
}

(async () => {
  await testPoller();
  await testChaseAndRetry();
  await testInFlightAndErrors();
  await testCapAndQueue();
  await testSourceGuards();
  console.log('desk-protect.test.js ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
