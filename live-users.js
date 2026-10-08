// Server-side allowlist of users whose Combo Locks the worker may quote.
//
// The worker trades on ONE set of exchange keys (Kevin's Kalshi + Polymarket).
// combo_parlays / combo_settings are user-writable through the app (RLS "own
// rows"), so without this gate any signed-in user could create a lock, disarm
// their own kill switch, and have it quoted with Kevin's money.
//
// COMBO_LIVE_USER_IDS = comma/space separated auth.users ids. Unset, blank, or
// with no valid uuid => Kevin's own accounts only (DEFAULT_LIVE_USER_IDS).
// Every combo_parlays / combo_settings loader that can lead to a quote runs its
// rows through this gate. Skipped locks are logged once per lock id.
'use strict';

// Kevin: kev120909@gmail.com (primary aibetbuilder account) and
// kevin.f.gordon1@gmail.com. Looked up from auth.users.
const DEFAULT_LIVE_USER_IDS = Object.freeze([
  '79ae1610-097e-4b46-a622-1e952f18e936',
  '968efed8-54db-48a6-808b-194a7a03a4cb',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseLiveUserIds(raw) {
  if (raw == null) return [];
  return String(raw)
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => UUID_RE.test(s));
}

// { ids: Set<string>, source: 'env' | 'default', invalid: boolean }
function resolveLiveUserIds(env = process.env) {
  const raw = env && env.COMBO_LIVE_USER_IDS;
  const blank = raw == null || String(raw).trim() === '';
  const parsed = blank ? [] : parseLiveUserIds(raw);
  if (parsed.length) return { ids: new Set(parsed), source: 'env', invalid: false };
  return { ids: new Set(DEFAULT_LIVE_USER_IDS), source: 'default', invalid: !blank };
}

function normId(v) {
  return v == null ? '' : String(v).trim().toLowerCase();
}

function createLiveUserGate({ env = process.env, log = console.log } = {}) {
  const { ids, source, invalid } = resolveLiveUserIds(env);
  const skippedLogged = new Set();

  function isAllowed(userId) {
    const id = normId(userId);
    return !!id && ids.has(id);
  }

  // Keep only locks owned by an allowlisted user. Non-array input (a soft-failed
  // query) is returned as-is so the caller's soft-fail handling still applies.
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
        `user=${row && row.user_id} — not in COMBO_LIVE_USER_IDS; never loaded or quoted`
      );
    }
    return out;
  }

  // Kill-switch map { user_id: kill_switch } limited to allowlisted users. Anyone
  // else is absent, which every killEngagedFor treats as engaged.
  function filterKillByUser(map) {
    if (!map || typeof map !== 'object') return map;
    const out = {};
    for (const k of Object.keys(map)) if (isAllowed(k)) out[k] = map[k];
    return out;
  }

  function summary() {
    return `[LIVE-USERS] ${ids.size} live user(s) from ${source === 'env' ? 'COMBO_LIVE_USER_IDS' : 'default (Kevin only)'}` +
      (invalid ? ' — COMBO_LIVE_USER_IDS had no valid uuid, using default' : '');
  }

  return { ids, source, invalid, isAllowed, filterParlays, filterKillByUser, summary };
}

module.exports = { DEFAULT_LIVE_USER_IDS, parseLiveUserIds, resolveLiveUserIds, createLiveUserGate };
