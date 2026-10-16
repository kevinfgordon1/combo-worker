// Balance reporter: what is available to trade on THIS process's exchange
// accounts, written to public.combo_balances every ~60s for the Combo Locks
// page ("Available to trade") and the owner "All users" table.
//
// Read-only. GET requests only:
//   Kalshi      GET /trade-api/v2/portfolio/balance?exchange_index=0|1
//               shard 1 = combo bucket (KXMVE combos clear here), shard 0 = main /
//               single-game. balance_dollars (or integer-cent balance) = cash.
//   Polymarket  GET /v1/account/balances -> USD currentBalance + buyingPower.
//
// Rows are keyed (user_id, venue, shard). user_id = the scope's write user
// (tester child) or Kevin's main id (owner worker), so a process only ever
// writes balances for the account whose keys it holds. On a failed read the
// last good amount stays; ok=false + a short generic error is stored. No key
// material, request body, or raw response text is ever logged or stored.
//
// BALANCE_REPORT_MS (default 60000, min 15000); BALANCE_REPORT=0 disables.
'use strict';

const { createKalshiBucketClient, MAIN_SHARD, BUCKET_SHARD } = require('./bucket-manager');
const { createPolymarketHttp } = require('./polymarket-client');

const OWNER_USER_ID = '79ae1610-097e-4b46-a622-1e952f18e936';
const DEFAULT_MS = 60_000;
const MIN_MS = 15_000;

function reportIntervalMs(env = process.env) {
  const raw = env && env.BALANCE_REPORT_MS;
  const n = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(n)) return DEFAULT_MS;
  return Math.max(MIN_MS, Math.trunc(n));
}

function reportEnabled(env = process.env) {
  const v = env && env.BALANCE_REPORT;
  return !(v != null && /^(0|false|off|no)$/i.test(String(v).trim()));
}

function centsToUsd(c) {
  return Number.isFinite(c) ? Math.round(c) / 100 : null;
}

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

// Short, generic, never includes response text (could echo request data).
function errorLabel(e) {
  const code = e && (e.statusCode || e.status);
  if (code) return `HTTP ${code}`;
  const m = String((e && e.message) || '');
  if (/timeout|timed out|ETIMEDOUT|UND_ERR_.*TIMEOUT/i.test(m)) return 'timeout';
  if (/ECONNRE|ENOTFOUND|EAI_AGAIN|socket/i.test(m)) return 'network';
  if (/missing balance|parse/i.test(m)) return 'bad response';
  return 'error';
}

function polyBalanceFromJson(json) {
  if (!json || typeof json !== 'object') return null;
  const list = Array.isArray(json.balances) ? json.balances : (json.currentBalance != null ? [json] : []);
  if (!list.length) return null;
  const usd = list.find((r) => String((r && r.currency) || 'USD').toUpperCase() === 'USD') || list[0];
  if (!usd) return null;
  const cash = money(usd.currentBalance);
  const bp = money(usd.buyingPower);
  if (cash == null && bp == null) return null;
  return { cash, buyingPower: bp };
}

function createBalanceReporter({
  supabase,
  userId,
  signed,
  polyHttp = null,
  now = () => new Date(),
  log = (m) => console.log(m),
} = {}) {
  if (!supabase) throw new Error('supabase client required');
  if (!userId) throw new Error('userId required');
  const kalshi = typeof signed === 'function' ? createKalshiBucketClient(signed) : null;
  const last = new Map(); // `${venue}:${shard}` -> last good row (keeps amounts on failure)
  let running = false;
  let lastErrLog = 0;

  function rowKey(venue, shard) { return `${venue}:${shard}`; }

  function okRow(venue, shard, fields) {
    const at = now().toISOString();
    const row = {
      user_id: userId, venue, shard,
      available_usd: fields.available_usd,
      portfolio_usd: fields.portfolio_usd == null ? null : fields.portfolio_usd,
      buying_power_usd: fields.buying_power_usd == null ? null : fields.buying_power_usd,
      ok: true, error: null, fetched_at: at, checked_at: at,
    };
    last.set(rowKey(venue, shard), row);
    return row;
  }

  function failRow(venue, shard, e) {
    const prev = last.get(rowKey(venue, shard));
    const at = now().toISOString();
    // Without a previous good read in this process, do not overwrite amounts
    // a sibling/previous process stored: upsert only status columns.
    if (!prev) return { user_id: userId, venue, shard, ok: false, error: errorLabel(e), checked_at: at, _statusOnly: true };
    return { ...prev, ok: false, error: errorLabel(e), checked_at: at };
  }

  async function readKalshi() {
    const rows = [];
    for (const shard of [BUCKET_SHARD, MAIN_SHARD]) {
      try {
        const b = await kalshi.getShard(shard);
        rows.push(okRow('kalshi', shard, { available_usd: centsToUsd(b.availableCents), portfolio_usd: centsToUsd(b.portfolioCents) }));
      } catch (e) {
        rows.push(failRow('kalshi', shard, e));
      }
    }
    return rows;
  }

  async function readPoly() {
    try {
      const res = await polyHttp.request('GET', '/v1/account/balances');
      if (!res || res.statusCode < 200 || res.statusCode >= 300) {
        const err = new Error('poly balance'); err.statusCode = res && res.statusCode; throw err;
      }
      const b = polyBalanceFromJson(res.json);
      if (!b) throw new Error('bad response');
      const avail = b.buyingPower != null ? b.buyingPower : b.cash;
      return [okRow('polymarket_us', 0, { available_usd: avail, portfolio_usd: null, buying_power_usd: b.buyingPower })];
    } catch (e) {
      return [failRow('polymarket_us', 0, e)];
    }
  }

  async function write(rows) {
    const full = rows.filter((r) => !r._statusOnly);
    const statusOnly = rows.filter((r) => r._statusOnly).map(({ _statusOnly, ...r }) => r);
    if (full.length) {
      const { error } = await supabase.from('combo_balances').upsert(full, { onConflict: 'user_id,venue,shard' });
      if (error) throw new Error(`combo_balances upsert: ${error.message}`);
    }
    for (const r of statusOnly) {
      // Status-only: insert a blank row if missing, else update ok/error/checked_at.
      const { error } = await supabase.from('combo_balances')
        .upsert(r, { onConflict: 'user_id,venue,shard', ignoreDuplicates: true });
      if (error) throw new Error(`combo_balances insert: ${error.message}`);
      const upd = await supabase.from('combo_balances')
        .update({ ok: false, error: r.error, checked_at: r.checked_at })
        .eq('user_id', r.user_id).eq('venue', r.venue).eq('shard', r.shard);
      if (upd.error) throw new Error(`combo_balances update: ${upd.error.message}`);
    }
  }

  async function tick() {
    if (running) return null;
    running = true;
    try {
      const rows = [];
      if (kalshi) rows.push(...await readKalshi());
      if (polyHttp) rows.push(...await readPoly());
      if (rows.length) await write(rows);
      const bad = rows.filter((r) => !r.ok);
      if (bad.length && Date.now() - lastErrLog > 10 * 60 * 1000) {
        lastErrLog = Date.now();
        log(`[balances] ${bad.map((r) => `${r.venue}/${r.shard}: ${r.error}`).join(', ')}`);
      }
      return rows.map(({ _statusOnly, ...r }) => r);
    } catch (e) {
      if (Date.now() - lastErrLog > 10 * 60 * 1000) {
        lastErrLog = Date.now();
        log(`[balances] write failed: ${String((e && e.message) || e).slice(0, 160)}`);
      }
      return null;
    } finally {
      running = false;
    }
  }

  return { tick, _last: last };
}

// Wiring helper for live-runner: returns a stop() or null when disabled.
function startBalanceReporter({ supabase, scope, env = process.env, signed, wrap = (f) => f, log, polyFactory = createPolymarketHttp } = {}) {
  if (!reportEnabled(env) || !scope || scope.invalid) return null;
  const userId = scope.writeUserId || OWNER_USER_ID;
  const keyId = env.POLYMARKET_KEY_ID;
  const secretKey = env.POLYMARKET_SECRET_KEY;
  const polyHttp = keyId && secretKey ? polyFactory({ keyId, secretKey }) : null;
  const reporter = createBalanceReporter({ supabase, userId, signed, polyHttp, log });
  const ms = reportIntervalMs(env);
  const run = wrap(() => { reporter.tick(); });
  const first = setTimeout(run, 5_000);
  const t = setInterval(run, ms);
  if (t.unref) t.unref();
  if (first.unref) first.unref();
  (log || console.log)(`[balances] reporting every ${Math.round(ms / 1000)}s for user=${userId.slice(0, 8)} (kalshi${polyHttp ? ' + polymarket_us' : ''})`);
  return { reporter, stop: () => { clearInterval(t); clearTimeout(first); } };
}

module.exports = {
  OWNER_USER_ID,
  reportIntervalMs,
  reportEnabled,
  errorLabel,
  polyBalanceFromJson,
  createBalanceReporter,
  startBalanceReporter,
};
