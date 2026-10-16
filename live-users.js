// Who may trade through THIS worker process.
//
// A lock is loaded/quoted only when its user_id is:
//   1. in this process's scope (worker-scope.js: Kevin's ids for the main
//      worker, exactly one tester id for a per-tester child), AND
//   2. in public.combo_live_users with can_trade and not paused (polled with
//      every refresh, service role), AND
//   3. in COMBO_LIVE_USER_IDS when that env is set (extra global allowlist).
//
// Until combo_live_users has been read once (or if the read keeps failing),
// the main worker keeps Kevin's scope so his path never depends on the new
// table; a tester child fails closed (quotes nothing).
//
// Per-user caps (max_per_lock_usd / max_per_day_usd) come from the same rows;
// see user-caps.js. Skipped locks are logged once per lock id.
'use strict';

// Kevin: kev120909@gmail.com (owner) and kevin.f.gordon1@gmail.com.
const DEFAULT_LIVE_USER_IDS = Object.freeze([
  '79ae1610-097e-4b46-a622-1e952f18e936',
  '968efed8-54db-48a6-808b-194a7a03a4cb',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const USERS_COLUMNS = 'user_id,can_trade,paused,max_per_lock_usd,max_per_day_usd,fund_unlimited';
const USERS_COLUMNS_BASE = 'user_id,can_trade';

function parseLiveUserIds(raw) {
  if (raw == null) return [];
  return String(raw)
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => UUID_RE.test(s));
}

// Extra env allowlist. null = not set (no extra restriction). Set but with no
// valid uuid => Kevin only (never "everyone").
function resolveEnvAllowlist(env = process.env) {
  const raw = env && env.COMBO_LIVE_USER_IDS;
  if (raw == null || String(raw).trim() === '') return { ids: null, invalid: false };
  const parsed = parseLiveUserIds(raw);
  if (parsed.length) return { ids: new Set(parsed), invalid: false };
  return { ids: new Set(DEFAULT_LIVE_USER_IDS), invalid: true };
}

function normId(v) {
  return v == null ? '' : String(v).trim().toLowerCase();
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function createLiveUserGate({ env = process.env, scope = null, log = console.log } = {}) {
  const sc = scope || require('./worker-scope').resolveWorkerScope(env);
  const scopeIds = new Set((sc.userIds || []).map(normId));
  const envAllow = resolveEnvAllowlist(env);
  let dbUsers = null; // Map<user_id, row> once combo_live_users has been read
  let baseColumnsOnly = false;
  let lastAllowedKey = null;
  const skippedLogged = new Set();

  function inScope(userId) {
    const id = normId(userId);
    return !!id && scopeIds.has(id);
  }

  function isAllowed(userId) {
    const id = normId(userId);
    if (!id || !scopeIds.has(id)) return false;
    if (envAllow.ids && !envAllow.ids.has(id)) return false;
    if (dbUsers) {
      const row = dbUsers.get(id);
      if (!row || row.can_trade === false || row.paused === true) return false;
      // "Amount to keep for combos" (combo_settings.autofund_pct, blank = 90%):
      // 0% = off, nothing trades. fund_unlimited testers also hold when their
      // settings could not be read (their only limit is that setting).
      if (row._keep_off === true) return false;
      if (row.fund_unlimited === true && row._keep_read !== true) return false;
      return true;
    }
    return !sc.isTester;
  }

  // { perLockUsd, perDayUsd } (either may be null) or null when uncapped.
  function capsFor(userId) {
    if (!dbUsers) return sc.isTester ? { perLockUsd: 0, perDayUsd: 0 } : null;
    const row = dbUsers.get(normId(userId));
    if (!row) return null;
    const perLockUsd = numOrNull(row.max_per_lock_usd);
    const perDayUsd = numOrNull(row.max_per_day_usd);
    if (perLockUsd == null && perDayUsd == null) return null;
    return { perLockUsd, perDayUsd };
  }

  async function query(supabase) {
    if (!supabase) return null;
    const res = await supabase.from('combo_live_users').select(baseColumnsOnly ? USERS_COLUMNS_BASE : USERS_COLUMNS);
    if (!res || res.error || !Array.isArray(res.data)) return res;
    const ids = res.data.filter((r) => r && r.user_id && !DEFAULT_LIVE_USER_IDS.includes(normId(r.user_id))).map((r) => r.user_id);
    if (!ids.length) return res;
    let rows = null;
    try {
      const sq = await supabase.from('combo_settings').select('user_id,autofund_cap_usd,autofund_pct').in('user_id', ids);
      if (sq && !sq.error && Array.isArray(sq.data)) rows = new Map(sq.data.map((r) => [normId(r.user_id), r]));
      else log('[LIVE-USERS] combo_settings read failed — fund_unlimited users held (Amount to keep unknown)');
    } catch (_) { log('[LIVE-USERS] combo_settings read threw — fund_unlimited users held'); }
    const { keepSetting } = require('./keep-pct');
    return {
      ...res,
      data: res.data.map((r) => {
        if (!r || !rows || !ids.includes(r.user_id)) return r;
        const keep = keepSetting(rows.get(normId(r.user_id)) || null);
        return { ...r, _keep_read: true, _keep_off: keep.mode === 'off' };
      }),
    };
  }

  // Apply a combo_live_users read. Soft-fail keeps the previous snapshot.
  function apply(result) {
    if (!result || result.error || !Array.isArray(result.data)) {
      const msg = result && result.error ? String(result.error.message || result.error) : 'no data';
      if (!baseColumnsOnly && /column|schema cache|does not exist|Could not find/i.test(msg)) {
        baseColumnsOnly = true;
        log('[LIVE-USERS] combo_live_users caps/pause columns missing — reading user_id,can_trade only');
      } else {
        log(`[LIVE-USERS] combo_live_users read failed (${msg}) — keeping ${dbUsers ? 'last snapshot' : (sc.isTester ? 'nothing (tester fails closed)' : 'Kevin scope')}`);
      }
      return false;
    }
    const next = new Map();
    for (const r of result.data) if (r && r.user_id) next.set(normId(r.user_id), r);
    dbUsers = next;
    const allowedNow = [...scopeIds].filter((id) => isAllowed(id)).sort();
    const key = allowedNow.join(',');
    if (key !== lastAllowedKey) {
      lastAllowedKey = key;
      skippedLogged.clear();
      log(`[LIVE-USERS] trading for ${allowedNow.length} user(s) of ${scopeIds.size} in scope`);
    }
    return true;
  }

  async function poll(supabase) {
    try { return apply(await query(supabase)); } catch (e) { return apply({ error: e }); }
  }

  function filterParlays(rows) {
    if (!Array.isArray(rows)) return rows;
    const out = [];
    for (const row of rows) {
      if (row && isAllowed(row.user_id)) {
        out.push(row);
        continue;
      }
      const key = row && row.id != null ? String(row.id) : JSON.stringify(row);
      if (skippedLogged.has(key)) continue;
      skippedLogged.add(key);
      log(
        `[LIVE-USERS] skipping lock ${row && row.id} (${(row && row.label) || 'no label'}) ` +
        `user=${row && row.user_id} — not a live user of this worker; never loaded or quoted`
      );
    }
    return out;
  }

  // Fill attribution: scope only (a paused user's late fills still book to
  // their own locks), never another user's locks.
  function filterByScope(rows) {
    if (!Array.isArray(rows)) return rows;
    return rows.filter((row) => row && inScope(row.user_id));
  }

  function filterKillByUser(map) {
    if (!map || typeof map !== 'object') return map;
    const out = {};
    for (const k of Object.keys(map)) if (isAllowed(k)) out[k] = map[k];
    return out;
  }

  function summary() {
    const env = envAllow.ids ? ` ∩ COMBO_LIVE_USER_IDS(${envAllow.ids.size})` : '';
    return `[LIVE-USERS] scope ${scopeIds.size} user(s)${env} ∩ combo_live_users` +
      (envAllow.invalid ? ' — COMBO_LIVE_USER_IDS had no valid uuid, using Kevin only' : '');
  }

  return {
    scope: sc,
    get loaded() { return !!dbUsers; },
    isAllowed, inScope, capsFor, query, apply, poll,
    filterParlays, filterByScope, filterKillByUser, summary,
  };
}

module.exports = {
  DEFAULT_LIVE_USER_IDS, parseLiveUserIds, resolveEnvAllowlist, createLiveUserGate,
};
