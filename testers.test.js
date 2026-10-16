'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { selectTesters, planChanges, createSupervisor } = require('./start-testers');
const { buildTesterEnv, keyFingerprint, makeRedactor } = require('./tester-env');
const { resolveWorkerMode } = require('./worker-mode');

const KEVIN = '79ae1610-097e-4b46-a622-1e952f18e936';
const KEVIN2 = '968efed8-54db-48a6-808b-194a7a03a4cb';
const KENNY = '42b5ee16-68d5-4b3b-a931-40aa17cd1a47';
const A = '11111111-2222-4333-8444-555555555555';
const B = '22222222-2222-4333-8444-555555555555';
const C = '33333333-2222-4333-8444-555555555555';
const PEM_A = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\n-----END PRIVATE KEY-----';

assert.strictEqual(resolveWorkerMode({ WORKER_MODE: 'testers' }), 'testers');
assert.strictEqual(resolveWorkerMode({}), 'combo');

const users = [
  { user_id: KEVIN, is_owner: true, can_trade: true, paused: false },
  { user_id: KEVIN2, is_owner: false, can_trade: true, paused: false },
  { user_id: A, can_trade: true, paused: false },
  { user_id: B, can_trade: true, paused: true },
  { user_id: C, can_trade: true, paused: false }, // no Kalshi key
];
const keys = [
  { user_id: KEVIN2, venue: 'kalshi', key_id: 'kev-alt', secret: 'x' },
  { user_id: A, venue: 'kalshi', key_id: 'ka-key-1234', secret: PEM_A },
  { user_id: A, venue: 'polymarket_us', key_id: 'pa-key', secret: 'pa-secret-xyz' },
  { user_id: B, venue: 'kalshi', key_id: 'kb', secret: 'sb' },
  { user_id: C, venue: 'polymarket_us', key_id: 'pc', secret: 'sc' },
  { user_id: KENNY, venue: 'kalshi', key_id: 'kk', secret: 'sk' }, // not in combo_live_users
];

// Eligible: approved, not paused, not owner/Kevin, has a Kalshi key.
{
  const d = selectTesters({ users, keys, env: {} });
  assert.deepStrictEqual([...d.keys()], [A]);
  const a = d.get(A);
  assert.strictEqual(a.kalshi.keyId, 'ka-key-1234');
  assert.strictEqual(a.poly.keyId, 'pa-key');
  assert.strictEqual(a.fingerprint, keyFingerprint(a));
  assert.strictEqual(selectTesters({ users, keys, env: { COMBO_LIVE_USER_IDS: B } }).size, 0, 'env allowlist narrows');
  assert.strictEqual(selectTesters({ users, keys, env: { COMBO_LIVE_USER_IDS: 'garbage' } }).size, 0, 'garbage env => Kevin only => no testers');
  assert.strictEqual(selectTesters({ users: [], keys, env: {} }).size, 0, 'empty combo_live_users => nobody');
  assert.strictEqual(selectTesters({ users: [{ user_id: A, can_trade: false }], keys, env: {} }).size, 0);
}

// Plan: start new, stop gone, restart on key change.
{
  const plan = planChanges(new Map([[A, 'fp1'], [B, 'x']]), new Map([[A, { fingerprint: 'fp2' }], [C, { fingerprint: 'c' }]]));
  assert.deepStrictEqual(plan, { start: [C], stop: [B], restart: [A] });
}

// Child env: only that tester's keys; Kevin's creds/Telegram/bucket never leak.
{
  const base = {
    PATH: '/bin', SUPABASE_URL: 'https://x', SUPABASE_SERVICE_KEY: 'svc', KALSHI_SUBCENT: '1',
    KALSHI_KEY_ID: 'KEVIN-KEY', Kalshi_combo_key: 'KEVIN-PEM', KALSHI_PRIVATE_KEY: 'KEVIN-PEM2',
    POLYMARKET_KEY_ID: 'KEVIN-PM', POLYMARKET_SECRET_KEY: 'KEVIN-PMS', POLYMARKET_RFQ_LIVE: '1',
    TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALERT_CHAT_ID: 'c', KALSHI_BUCKET_AUTO: '1', COMBO_CAP_AT_CONFIRM: '1',
    DESK_PROTECT_SECRET: 'd', WORKER_MODE: 'testers', COMBO_WORKER_USER_ID: KEVIN,
    TESTER_ENV_KALSHI_WS_SHARD_FACTOR: '2', TESTER_ENV_KALSHI_KEY_ID: 'KEVIN-KEY', TESTER_ENV_TELEGRAM_BOT_TOKEN: 't',
  };
  const t = selectTesters({ users, keys, env: {} }).get(A);
  const env = buildTesterEnv(base, t);
  assert.strictEqual(env.COMBO_WORKER_USER_ID, A);
  assert.strictEqual(env.WORKER_MODE, 'combo');
  assert.strictEqual(env.KALSHI_KEY_ID, 'ka-key-1234');
  assert.strictEqual(env.Kalshi_combo_key, PEM_A);
  assert.strictEqual(env.KALSHI_PRIVATE_KEY, undefined);
  assert.strictEqual(env.POLYMARKET_KEY_ID, 'pa-key');
  assert.strictEqual(env.POLYMARKET_RFQ_LIVE, '1');
  assert.strictEqual(env.COMBO_CAP_AT_CONFIRM, '0');
  assert.strictEqual(env.KALSHI_BUCKET_AUTO, '0');
  assert.strictEqual(env.KALSHI_BUCKET_SWEEP, '0');
  assert.strictEqual(env.KALSHI_WS_SHARD_FACTOR, '2');
  assert.strictEqual(env.KALSHI_SUBCENT, '1');
  assert.strictEqual(env.SUPABASE_SERVICE_KEY, 'svc');
  for (const k of Object.keys(env)) assert.ok(!/^TELEGRAM_|^DESK_PROTECT_|^TESTER_ENV_/.test(k), k);
  assert.ok(!Object.values(env).some((v) => /KEVIN-/.test(String(v))), 'no Kevin credential in a tester env');
  const noPoly = buildTesterEnv(base, { userId: A, kalshi: t.kalshi, poly: null });
  assert.strictEqual(noPoly.POLYMARKET_RFQ_LIVE, '0');
  assert.strictEqual(noPoly.POLYMARKET_KEY_ID, undefined);
  assert.strictEqual(noPoly.POLYMARKET_SECRET_KEY, undefined);
}

// Redactor scrubs the key id, the whole PEM and any PEM body line.
{
  const r = makeRedactor([PEM_A, 'ka-key-1234', 'pa-secret-xyz']);
  const out = r(`id=ka-key-1234 body=MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ pm=pa-secret-xyz`);
  assert.ok(!/ka-key-1234|MIIEvQ|pa-secret/.test(out), out);
}

// Supervisor: spawns 2 children per tester with the tester env, stops on pause,
// restarts on key rotation, never logs secrets, fails closed on read errors.
(async () => {
  const spawned = [];
  const spawnImpl = (exec, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    spawned.push({ script: args[0], env: opts.env, child });
    return child;
  };
  let state = { users, keys, fail: false };
  const supabase = {
    from: () => ({ select: () => Promise.resolve(state.fail ? { data: null, error: { message: 'down' } } : { data: state.users, error: null }) }),
    rpc: (name) => { assert.strictEqual(name, 'combo_exchange_keys_for_worker'); return Promise.resolve(state.fail ? { data: null, error: { message: 'down' } } : { data: state.keys, error: null }); },
  };
  const logs = [];
  const sup = createSupervisor({ supabase, env: { PATH: '/bin', Kalshi_combo_key: 'KEVIN-PEM' }, log: (m) => logs.push(m), spawnImpl, execPath: 'node' });
  let r = await sup.poll();
  assert.deepStrictEqual(r.start, [A]);
  assert.deepStrictEqual(spawned.map((s) => s.script).sort(), ['fills-reader.js', 'live-runner.js']);
  assert.ok(spawned.every((s) => s.env.COMBO_WORKER_USER_ID === A && s.env.Kalshi_combo_key === PEM_A));
  spawned[0].child.stdout.emit('data', Buffer.from('[LIVE] key ka-key-1234 ok\n'));
  assert.ok(logs.some((l) => /^\[T:11111111\] \[LIVE\] key \[redacted\] ok$/.test(l)), logs.join('\n'));

  // Same config => nothing changes.
  r = await sup.poll();
  assert.deepStrictEqual([r.start, r.stop, r.restart], [[], [], []]);
  assert.strictEqual(spawned.length, 2);

  // Key rotated => restart.
  state = { ...state, keys: keys.map((k) => (k.user_id === A && k.venue === 'kalshi' ? { ...k, secret: 'rotated-pem-value' } : k)) };
  r = await sup.poll();
  assert.deepStrictEqual(r.restart, [A]);
  assert.ok(spawned.slice(0, 2).every((s) => s.child.killed));
  assert.strictEqual(spawned.length, 4);

  // Owner pauses A => stopped, no auto-restart after exit.
  state = { ...state, users: users.map((u) => (u.user_id === A ? { ...u, paused: true } : u)) };
  r = await sup.poll();
  assert.deepStrictEqual(r.stop, [A]);
  assert.ok(spawned.slice(2).every((s) => s.child.killed));
  spawned[2].child.emit('exit', 0, 'SIGTERM');
  assert.strictEqual(sup.running.size, 0);
  assert.ok(!logs.some((l) => /KEVIN-PEM|rotated-pem-value|BEGIN PRIVATE/.test(l)), 'no secrets logged');

  // Read failures: nothing new starts; running testers are stopped once the
  // failure outlasts 3 polls' worth of time (fail closed).
  state = { users, keys, fail: false };
  await sup.poll();
  assert.strictEqual(sup.running.size, 1);
  state = { ...state, fail: true };
  assert.strictEqual(await sup.poll(), null);
  assert.strictEqual(sup.running.size, 1, 'one blip keeps running');
  sup.stopAll('test end');
  assert.strictEqual(sup.running.size, 0);
  console.log('testers tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
