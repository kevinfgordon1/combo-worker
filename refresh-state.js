// Apply combo_parlays / combo_settings / fills refresh slices.
// supabase-js returns { data: null, error } on 5xx/timeout without throwing.
// Treating null as [] wiped live locks and made missing settings look like kill ON.
'use strict';

function queryErrorMessage(error) {
  if (!error) return 'null data';
  return error.message || String(error);
}

// Soft-fail: Postgrest error, or data is not a real list (null on 5xx).
// Success + [] is NOT a soft-fail — that is an authentic empty snapshot.
function querySoftFailed(result) {
  if (!result) return true;
  const { data, error } = result;
  return error != null || !Array.isArray(data);
}

function lockLabels(parlays) {
  if (!Array.isArray(parlays) || !parlays.length) return 'none';
  return parlays.map((p) => p.label || p.id).join(', ');
}

function killSwitchSummary(killByUser) {
  if (!killByUser || typeof killByUser !== 'object') return 'none';
  const keys = Object.keys(killByUser);
  if (!keys.length) return 'none';
  return keys.map((id) => `${id}=${killByUser[id]}`).join(', ');
}

function applyRefreshParlays(prev, result, log = console) {
  if (querySoftFailed(result)) {
    const n = Array.isArray(prev) ? prev.length : 0;
    log.error(
      `refresh soft-fail parlays: ${queryErrorMessage(result && result.error)} — ` +
      `keeping ${n} lock(s): ${lockLabels(prev)}`
    );
    return prev;
  }
  return result.data;
}

function applyRefreshKillByUser(prev, result, log = console) {
  if (querySoftFailed(result)) {
    log.error(
      `refresh soft-fail settings: ${queryErrorMessage(result && result.error)} — ` +
      `keeping kill_switch ${killSwitchSummary(prev)}`
    );
    return prev;
  }
  const next = {};
  result.data.forEach((r) => { next[r.user_id] = r.kill_switch; });
  return next;
}

function applyRefreshFilledByParlay(prev, result, countField, log = console) {
  if (querySoftFailed(result)) {
    const n = prev && typeof prev === 'object' ? Object.keys(prev).length : 0;
    log.error(`refresh soft-fail fills: ${queryErrorMessage(result && result.error)} — keeping ${n} parlay fill(s)`);
    return prev;
  }
  const next = {};
  result.data.forEach((r) => {
    next[r.parlay_id] = (next[r.parlay_id] || 0) + Number(r[countField] || 0);
  });
  return next;
}

module.exports = {
  querySoftFailed,
  lockLabels,
  applyRefreshParlays,
  applyRefreshKillByUser,
  applyRefreshFilledByParlay,
};
