// Combo Locks testers supervisor (WORKER_MODE=testers, its own Railway
// service — never inside Kevin's combo-worker).
//
// Every POLL_MS it reads combo_live_users + the keys RPC
// (combo_exchange_keys_for_worker, service role only) and runs, per eligible
// tester, a live-runner.js + fills-reader.js pair whose env carries ONLY that
// tester's Kalshi (and optional Polymarket US) key and
// COMBO_WORKER_USER_ID=<tester>. Each child therefore quotes, hedges, reads
// fills and checks balances on that tester's account only, and its queries
// and writes are scoped to that tester's rows.
//
// Eligible = combo_live_users row with can_trade, not paused, not owner, not
// one of Kevin's ids, in COMBO_LIVE_USER_IDS when that env is set, and with a
// Kalshi key stored. Paused/removed/disconnected => children stopped within
// one poll; key rotated => children restarted. Secrets are never logged:
// child output is prefixed [T:xxxxxxxx] and scrubbed of the tester's keys.
'use strict';

const { spawn } = require('child_process');
const { DEFAULT_LIVE_USER_IDS, resolveEnvAllowlist } = require('./live-users');
const { buildTesterEnv, keyFingerprint, makeRedactor } = require('./tester-env');

const POLL_MS = Math.max(15_000, Number(process.env.TESTERS_POLL_MS) || 60_000);
const SCRIPTS = ['live-runner.js', 'fills-reader.js'];
const short = (id) => String(id).slice(0, 8);
// (user ids in Supabase are lowercase uuids; env ids are normalized by live-users.)

// Pure: which testers should be running, with which keys.
function selectTesters({ users, keys, env = process.env, excludeIds = DEFAULT_LIVE_USER_IDS }) {
  const allow = resolveEnvAllowlist(env).ids; // null = no env narrowing
  const byUser = new Map();
  for (const k of keys || []) {
    if (!k || !k.user_id || !k.venue || !k.key_id || !k.secret) continue;
    const e = byUser.get(k.user_id) || {};
    if (k.venue === 'kalshi') e.kalshi = { keyId: k.key_id, secret: k.secret };
    if (k.venue === 'polymarket_us') e.poly = { keyId: k.key_id, secret: k.secret };
    byUser.set(k.user_id, e);
  }
  const out = new Map();
  for (const u of users || []) {
    if (!u || !u.user_id) continue;
    const id = String(u.user_id).trim().toLowerCase();
    if (u.is_owner || u.can_trade === false || u.paused === true) continue;
    if (excludeIds.includes(id)) continue;
    if (allow && !allow.has(id)) continue;
    const k = byUser.get(u.user_id);
    if (!k || !k.kalshi) continue;
    out.set(u.user_id, { userId: u.user_id, kalshi: k.kalshi, poly: k.poly || null, fingerprint: keyFingerprint(k) });
  }
  return out;
}

// Pure: what to start/stop/restart given running fingerprints.
function planChanges(running, desired) {
  const start = []; const stop = []; const restart = [];
  for (const [id, fp] of running) {
    if (!desired.has(id)) stop.push(id);
    else if (desired.get(id).fingerprint !== fp) restart.push(id);
  }
  for (const id of desired.keys()) if (!running.has(id)) start.push(id);
  return { start, stop, restart };
}

function createSupervisor({ supabase, env = process.env, log = console.log, spawnImpl = spawn, execPath = process.execPath }) {
  const running = new Map(); // userId -> { fingerprint, children: Map(script -> child), stopping, backoff, timers }
  let lastOk = 0;

  function pipe(stream, prefix, redact, write) {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { write(`${prefix} ${redact(buf.slice(0, i))}`); buf = buf.slice(i + 1); }
      if (buf.length > 16_384) { write(`${prefix} ${redact(buf)}`); buf = ''; }
    });
  }

  function startChild(entry, script) {
    const t = entry.tester;
    const prefix = `[T:${short(t.userId)}${script === 'fills-reader.js' ? ':fills' : ''}]`;
    const redact = makeRedactor([t.kalshi.secret, t.kalshi.keyId, t.poly && t.poly.secret, t.poly && t.poly.keyId]);
    const child = spawnImpl(execPath, [script], { env: buildTesterEnv(env, t), stdio: ['ignore', 'pipe', 'pipe'] });
    entry.children.set(script, child);
    if (child.stdout) pipe(child.stdout, prefix, redact, (l) => log(l));
    if (child.stderr) pipe(child.stderr, prefix, redact, (l) => console.error(l));
    child.on('exit', (code, signal) => {
      if (entry.children.get(script) === child) entry.children.delete(script);
      if (entry.stopping) return;
      const wait = Math.min(300_000, 5_000 * 2 ** Math.min(6, entry.backoff[script] || 0));
      entry.backoff[script] = (entry.backoff[script] || 0) + 1;
      log(`[testers] ${prefix} ${script} exited code=${code} signal=${signal || ''}; restart in ${Math.round(wait / 1000)}s`);
      entry.timers.push(setTimeout(() => { if (!entry.stopping) startChild(entry, script); }, wait));
    });
    // Healthy for 10 min => reset backoff.
    entry.timers.push(setTimeout(() => { if (entry.children.get(script) === child) entry.backoff[script] = 0; }, 600_000));
  }

  function start(tester) {
    const entry = { tester, fingerprint: tester.fingerprint, children: new Map(), stopping: false, backoff: {}, timers: [] };
    running.set(tester.userId, entry);
    log(`[testers] start ${short(tester.userId)} kalshi=yes polymarket=${tester.poly ? 'yes' : 'no'}`);
    for (const s of SCRIPTS) startChild(entry, s);
  }

  function stop(userId, why) {
    const entry = running.get(userId);
    if (!entry) return;
    entry.stopping = true;
    for (const t of entry.timers) clearTimeout(t);
    for (const child of entry.children.values()) { try { child.kill('SIGTERM'); } catch (_) {} }
    running.delete(userId);
    log(`[testers] stop ${short(userId)} (${why})`);
  }

  function stopAll(why) { for (const id of [...running.keys()]) stop(id, why); }

  async function poll() {
    const [usersQ, keysQ] = await Promise.all([
      supabase.from('combo_live_users').select('user_id,is_owner,can_trade,paused'),
      supabase.rpc('combo_exchange_keys_for_worker'),
    ]);
    if (usersQ.error || keysQ.error) {
      const msg = (usersQ.error || keysQ.error).message;
      // Fail closed: if we can't confirm a tester is still approved, stop them.
      if (Date.now() - lastOk > 3 * POLL_MS) stopAll(`config read failing: ${msg}`);
      log(`[testers] config read failed: ${msg}`);
      return null;
    }
    lastOk = Date.now();
    const desired = selectTesters({ users: usersQ.data, keys: keysQ.data, env });
    const fps = new Map([...running].map(([id, e]) => [id, e.fingerprint]));
    const plan = planChanges(fps, desired);
    for (const id of plan.stop) stop(id, 'no longer eligible (paused, removed or key disconnected)');
    for (const id of plan.restart) { stop(id, 'key changed'); start(desired.get(id)); }
    for (const id of plan.start) start(desired.get(id));
    return { desired: desired.size, ...plan };
  }

  return { poll, stopAll, running };
}

async function main() {
  const { createClient } = require('@supabase/supabase-js');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('[testers] missing env: need SUPABASE_URL, SUPABASE_SERVICE_KEY');
    process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const sup = createSupervisor({ supabase });
  const allow = resolveEnvAllowlist(process.env).ids;
  console.log(`[testers] supervisor up; poll ${POLL_MS / 1000}s; env allowlist ${allow ? allow.size + ' id(s)' : 'not set (combo_live_users only)'}`);
  let last = '';
  const tick = async () => {
    try {
      const r = await sup.poll();
      const line = r ? `[testers] eligible=${r.desired} running=${sup.running.size}` : '';
      if (line && line !== last) { console.log(line); last = line; }
    } catch (e) { console.error('[testers] poll error', e && e.message); }
  };
  await tick();
  setInterval(tick, POLL_MS);
  const shutdown = (sig) => { sup.stopAll(sig); setTimeout(() => process.exit(0), 3000); };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) main();

module.exports = { selectTesters, planChanges, createSupervisor };
