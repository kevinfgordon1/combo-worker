// Tester auto-funding: keep a Combo Locks tester's Kalshi Combos balance
// (Exchange 1) topped up from THEIR OWN Default balance (Exchange 0).
//
// Runs only inside a tester child (start-testers.js -> live-runner.js with
// COMBO_WORKER_USER_ID=<tester>), whose env holds only that tester's key, so
// every call here is on the tester's own account. Kevin's worker never starts
// it (his bucket-manager.js is unchanged).
//
// The only money-moving call is POST /portfolio/intra_exchange_instance_transfer
// with source/destination event_contract, source_exchange_shard 0 and
// destination_exchange_shard 1 (hard-coded below). No subaccount field is ever
// sent, nothing moves 1 -> 0, nothing goes to another user (Kalshi's public API
// has no such endpoint).
//   https://docs.kalshi.com/api-reference/portfolio/intra-account-transfer
//
// Limits, checked before every move (all must pass; amounts in cents):
//   cap        Combos available cash + moves not yet confirmed never exceed the
//              tester's max_per_day_usd (combo_live_users; Kevin sets it).
//   per move   TESTER_FUND_MAX_MOVE_USD (default $100)
//   per day    TESTER_FUND_DAILY_USD (default $250), ET day, counted from
//              combo_fund_moves (persisted, so a restart does not reset it)
//   minimum    TESTER_FUND_MIN_MOVE_USD (default $5)
//   floor      Default keeps at least TESTER_FUND_MAIN_FLOOR_USD (default $0)
// Off switches (any one stops all moves on the next check):
//   global     TESTER_AUTOFUND=0 on the combo-testers service
//   per tester the tester's own kill switch (combo_settings.kill_switch must be
//              false), Kevin's Pause (combo_live_users.paused), can_trade=false,
//              or a key without Transfers / Full access (combo_exchange_keys.scopes)
// Every move is logged FIRST (combo_fund_moves status=sending) and then
// updated (accepted / confirmed / failed). If the log row cannot be written,
// nothing is sent. Any state read failure = no move (fail closed).
'use strict';

const { createKalshiBucketClient, MAIN_SHARD, BUCKET_SHARD, transferStatusClass } = require('./bucket-manager');
const { DEFAULT_LIVE_USER_IDS } = require('./live-users');

const TABLE = 'combo_fund_moves';
const DEFAULT_SHARD = MAIN_SHARD; // 0
const COMBOS_SHARD = BUCKET_SHARD; // 1
const CENTICENTS_PER_CENT = 100;
const PENDING_MAX_MS = 30 * 60 * 1000;
const SENDING_STALE_MS = 10 * 60 * 1000;
const COALESCE_MS = 60 * 1000;
const LOOKBACK_MS = 36 * 60 * 60 * 1000;

function envOff(v) { return v != null && /^(0|false|off|no)$/i.test(String(v).trim()); }
function envUsdCents(env, name, fallback) {
  const raw = env && env[name];
  const n = raw == null || raw === '' ? fallback : Number(raw);
  const use = Number.isFinite(n) && n >= 0 ? n : fallback;
  return Math.round(use * 100);
}

function loadFundConfig(env = process.env) {
  const iv = Number(env && env.TESTER_FUND_INTERVAL_MIN);
  return {
    enabled: !envOff(env && env.TESTER_AUTOFUND),
    maxMoveCents: envUsdCents(env, 'TESTER_FUND_MAX_MOVE_USD', 100),
    dailyCents: envUsdCents(env, 'TESTER_FUND_DAILY_USD', 250),
    minMoveCents: Math.max(100, envUsdCents(env, 'TESTER_FUND_MIN_MOVE_USD', 5)),
    mainFloorCents: envUsdCents(env, 'TESTER_FUND_MAIN_FLOOR_USD', 0),
    intervalMs: (Number.isFinite(iv) && iv >= 1 ? Math.floor(iv) : 5) * 60 * 1000,
    confirmDelayMs: 2000,
  };
}

function usdToCents(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
const centsToUsd = (c) => Math.round(c) / 100;
const fmt = (c) => `$${(Math.round(c) / 100).toFixed(2)}`;

function normScopes(list) {
  return (Array.isArray(list) ? list : []).map((s) => String(s == null ? '' : s).trim().toLowerCase()).filter(Boolean);
}
// Full access (write) or Transfers (write::transfer). Same rule as aibetbuilder's
// api/combo-keys-lib.js kalshiAutoFund.
function canTransfer(scopes) {
  const s = normScopes(scopes);
  return s.includes('write') || s.includes('write::transfer');
}

function etDayStartMs(now) {
  const fmtr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmtr.formatToParts(now).map((x) => [x.type, x.value]));
  const etAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  const offsetMs = etAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return Date.UTC(+p.year, +p.month - 1, +p.day) - offsetMs;
}

const isPending = (r) => r && (r.status === 'sending' || r.status === 'accepted');
// A failed row whose outcome is unknown (worker stopped mid-send, no Kalshi
// record) still counts toward the daily limit: it may have landed.
const countsToday = (r) => r && (r.status !== 'failed' || /^unconfirmed/.test(String(r.error || '')));

// Pure: why not, or how much. Cents throughout.
function planFund({ gate, comboCents, mainCents, capCents, pendingCents, todayCents, config }) {
  if (gate) return { action: 'hold', reason: gate, amountCents: 0 };
  const limits = {
    cap: capCents - comboCents - pendingCents,
    daily_limit: config.dailyCents - todayCents,
    default_balance: mainCents - config.mainFloorCents,
    per_move: config.maxMoveCents,
  };
  let amount = Infinity;
  let clamp = null;
  for (const [name, v] of Object.entries(limits)) {
    if (v < amount) { amount = v; clamp = name; }
  }
  amount = Math.max(0, Math.floor(amount));
  if (amount < config.minMoveCents) return { action: 'hold', reason: clamp === 'cap' ? 'at_cap' : clamp, amountCents: 0, limits };
  return { action: 'move', reason: clamp === 'per_move' ? 'top-up (per-move limit)' : 'top-up', amountCents: amount, clamp, limits };
}

function shortErr(e) {
  const code = e && (e.statusCode || e.status);
  const m = String((e && e.message) || e || 'error').replace(/\s+/g, ' ');
  return (code ? `HTTP ${code} ` : '') + m.slice(0, 100);
}

function createTesterFunder({
  userId,
  supabase,
  client = null,
  signed = null,
  env = process.env,
  now = () => new Date(),
  log = (m) => console.log(m),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  config: configOverride = null,
} = {}) {
  const config = configOverride || loadFundConfig(env);
  const uid = String(userId || '').trim().toLowerCase();
  const kalshi = client || (signed ? createKalshiBucketClient(signed) : null);
  let refused = null; // set when Kalshi refuses the transfer permission
  let inflight = null;
  let lastRunAt = 0;
  let lastReason = '';
  let timer = null;

  function note(reason, extra = '') {
    if (reason === lastReason && !extra) return;
    lastReason = reason;
    log(`[FUND] ${reason}${extra ? ' ' + extra : ''}`);
  }

  async function readState(t) {
    const since = new Date(t - LOOKBACK_MS).toISOString();
    const one = (q) => (typeof q.maybeSingle === 'function' ? q.maybeSingle() : q);
    const [liveQ, setQ, keyQ, movesQ] = await Promise.all([
      one(supabase.from('combo_live_users').select('user_id,is_owner,can_trade,paused,max_per_day_usd').eq('user_id', uid)),
      one(supabase.from('combo_settings').select('kill_switch').eq('user_id', uid)),
      one(supabase.from('combo_exchange_keys').select('scopes,scope_status').eq('user_id', uid).eq('venue', 'kalshi')),
      supabase.from(TABLE).select('id,amount_usd,status,transfer_id,error,created_at').eq('user_id', uid).gte('created_at', since).order('created_at', { ascending: false }).limit(200),
    ]);
    const err = liveQ.error || setQ.error || keyQ.error || movesQ.error;
    if (err) throw new Error(`state read: ${err.message || err}`);
    return { live: liveQ.data || null, settings: setQ.data || null, key: keyQ.data || null, moves: movesQ.data || [] };
  }

  function gateFor(s) {
    if (!config.enabled) return 'off: TESTER_AUTOFUND=0';
    if (!uid || DEFAULT_LIVE_USER_IDS.includes(uid)) return 'off: owner account';
    if (refused) return `off: Kalshi refused transfers (${refused})`;
    if (!s.live || s.live.is_owner) return 'off: not an approved tester';
    if (s.live.can_trade === false) return 'off: can_trade is false';
    if (s.live.paused) return 'off: paused by owner';
    if (!s.settings || s.settings.kill_switch !== false) return 'off: kill switch engaged';
    if (!s.key || s.key.scope_status !== 'ok' || !canTransfer(s.key.scopes)) return 'off: key has no Transfers / Full access';
    const cap = usdToCents(s.live.max_per_day_usd);
    if (cap == null || cap <= 0) return 'off: no daily limit set';
    return null;
  }

  async function update(id, patch) {
    const { error } = await supabase.from(TABLE).update({ ...patch, updated_at: now().toISOString() }).eq('id', id).eq('user_id', uid);
    if (error) log(`[FUND] log update failed ${error.message || error}`);
    return !error;
  }

  // Settle moves not yet confirmed. Returns the rows still pending.
  async function settlePending(moves, t) {
    const pending = moves.filter(isPending);
    if (!pending.length) return [];
    let records = null;
    if (pending.some((r) => r.transfer_id)) {
      try { records = await kalshi.getTransfers(); } catch (e) { log(`[FUND] transfer record read failed ${shortErr(e)}`); }
    }
    const still = [];
    for (const r of pending) {
      const age = t - new Date(r.created_at).getTime();
      const rec = records && r.transfer_id ? records.find((x) => x.transferId === r.transfer_id) : null;
      if (rec) {
        const cls = transferStatusClass(rec.status);
        if (cls === 'complete') { await update(r.id, { status: 'confirmed' }); r.status = 'confirmed'; continue; }
        if (cls === 'failed') { await update(r.id, { status: 'failed', error: `Kalshi status ${rec.status}`.slice(0, 120) }); r.status = 'failed'; continue; }
      } else if (r.status === 'sending' && age > SENDING_STALE_MS) {
        await update(r.id, { status: 'failed', error: 'unconfirmed: worker stopped while sending' }); r.status = 'failed'; r.error = 'unconfirmed'; continue;
      } else if (records && r.status === 'accepted' && age > PENDING_MAX_MS) {
        await update(r.id, { status: 'failed', error: 'unconfirmed: no Kalshi record after 30 min' }); r.status = 'failed'; r.error = 'unconfirmed'; continue;
      }
      still.push(r);
    }
    return still;
  }

  // The one money-moving call: tester's own Default (0) -> own Combos (1).
  async function moveDefaultToCombos(amountCents) {
    const cents = Math.trunc(Number(amountCents));
    if (!(cents > 0) || cents > config.maxMoveCents) throw new Error('move amount outside limits');
    return kalshi.transfer({ amountCenticents: cents * CENTICENTS_PER_CENT, fromShard: DEFAULT_SHARD, toShard: COMBOS_SHARD });
  }

  async function run(trigger) {
    const date = now();
    const t = date.getTime();
    lastRunAt = t;
    if (!kalshi || !supabase) return { skipped: 'no_client' };
    if (!config.enabled) { note('off: TESTER_AUTOFUND=0'); return { skipped: 'global_off' }; }
    let s;
    try { s = await readState(t); } catch (e) { note('hold: could not read settings', shortErr(e)); return { skipped: 'state_read_failed' }; }
    const gate = gateFor(s);
    const pending = await settlePending(s.moves, t);
    if (gate) { note(gate); return { skipped: gate }; }
    if (pending.length) { note('hold: waiting for the last move to confirm'); return { skipped: 'pending' }; }
    let main; let combo;
    try {
      main = await kalshi.getShard(DEFAULT_SHARD);
      combo = await kalshi.getShard(COMBOS_SHARD);
    } catch (e) { note('hold: balance read failed', shortErr(e)); return { skipped: 'balance_read_failed' }; }
    const dayStart = etDayStartMs(date);
    const todayCents = s.moves.filter((r) => countsToday(r) && new Date(r.created_at).getTime() >= dayStart)
      .reduce((a, r) => a + (usdToCents(r.amount_usd) || 0), 0);
    const capCents = usdToCents(s.live.max_per_day_usd);
    const plan = planFund({ gate: null, comboCents: combo.availableCents, mainCents: main.availableCents, capCents, pendingCents: 0, todayCents, config });
    if (plan.action !== 'move') {
      note(`hold: ${plan.reason}`, `combos=${fmt(combo.availableCents)} default=${fmt(main.availableCents)} cap=${fmt(capCents)} today=${fmt(todayCents)}`);
      return { plan };
    }
    // Log first; no row, no move.
    const row = {
      user_id: uid, venue: 'kalshi', from_shard: DEFAULT_SHARD, to_shard: COMBOS_SHARD,
      amount_usd: centsToUsd(plan.amountCents), status: 'sending',
      combo_before_usd: centsToUsd(combo.availableCents), default_before_usd: centsToUsd(main.availableCents),
      cap_usd: centsToUsd(capCents), reason: `${plan.reason} (${trigger || 'check'})`.slice(0, 80),
    };
    const ins = await supabase.from(TABLE).insert(row).select('id').single();
    if (ins.error || !ins.data || !ins.data.id) { note('hold: could not write the move log', String((ins.error && ins.error.message) || '')); return { skipped: 'log_failed' }; }
    const id = ins.data.id;
    let sent;
    try {
      sent = await moveDefaultToCombos(plan.amountCents);
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 401 || code === 403) refused = `HTTP ${code}`;
      await update(id, { status: 'failed', error: shortErr(e).slice(0, 120) });
      log(`[FUND] move ${fmt(plan.amountCents)} Default -> Combos failed ${shortErr(e)}`);
      return { plan, failed: true };
    }
    await update(id, { status: 'accepted', transfer_id: sent && sent.transferId ? String(sent.transferId) : null });
    log(`[FUND] moved ${fmt(plan.amountCents)} Default -> Combos (combos was ${fmt(combo.availableCents)}, cap ${fmt(capCents)}, today ${fmt(todayCents + plan.amountCents)})`);
    lastReason = '';
    if (config.confirmDelayMs > 0) await sleep(config.confirmDelayMs);
    await settlePending([{ id, status: 'accepted', transfer_id: sent && sent.transferId, created_at: date.toISOString() }], now().getTime());
    return { plan, moved: plan.amountCents, transferId: sent && sent.transferId };
  }

  function check(trigger = 'check') {
    if (inflight) return inflight;
    if (trigger === 'insufficient_balance' && now().getTime() - lastRunAt < COALESCE_MS) return Promise.resolve({ skipped: 'coalesced' });
    inflight = run(trigger).catch((e) => { log(`[FUND] check failed ${shortErr(e)}`); return { error: true }; })
      .finally(() => { inflight = null; });
    return inflight;
  }

  function start() {
    log(`[FUND] tester auto-funding ${config.enabled ? 'on' : 'OFF (TESTER_AUTOFUND=0)'}: Default -> Combos only, ` +
      `per move ${fmt(config.maxMoveCents)}, per day ${fmt(config.dailyCents)}, min ${fmt(config.minMoveCents)}, ` +
      `cap = tester daily limit, every ${Math.round(config.intervalMs / 60000)}m`);
    if (timer) clearInterval(timer);
    timer = setInterval(() => { check('interval'); }, config.intervalMs);
    if (timer.unref) timer.unref();
    check('startup');
    return stop;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { config, check, start, stop, _moveDefaultToCombos: moveDefaultToCombos };
}

// Read-only boot line: which scopes THIS process's own Kalshi key has
// (GET /api_keys). Scope names only; never the key id or any secret.
async function logOwnKeyScopes({ signed, keyId, log = (m) => console.log(m) }) {
  try {
    const res = await signed('GET', '/trade-api/v2/api_keys', { path: '/trade-api/v2/api_keys' });
    if (!res || res.statusCode < 200 || res.statusCode >= 300) { log(`[KEY] scope check: HTTP ${res && res.statusCode}`); return null; }
    let body = null;
    try { body = JSON.parse(res.text || ''); } catch (_) { body = null; }
    const list = body && Array.isArray(body.api_keys) ? body.api_keys : [];
    const entry = list.find((k) => k && String(k.api_key_id) === String(keyId));
    const scopes = entry ? normScopes(entry.scopes) : null;
    log(`[KEY] this worker's Kalshi key scopes: ${scopes ? scopes.join(',') || '(none listed)' : '(not listed)'}` +
      (scopes ? ` transfer=${canTransfer(scopes) ? 'yes' : 'no'}` : ''));
    return scopes;
  } catch (e) {
    log(`[KEY] scope check failed ${shortErr(e)}`);
    return null;
  }
}

module.exports = {
  TABLE, loadFundConfig, planFund, canTransfer, etDayStartMs, createTesterFunder, logOwnKeyScopes,
};
