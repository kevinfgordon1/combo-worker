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

// PostgREST returns at most 1000 rows unless the caller pages. A single
// combo_fills select was that short page, and refresh replaced the in-memory
// cap with it.
const CAP_FILL_PAGE_SIZE = 1000;
const CAP_FILL_MAX_ROWS = 20000;

function roundContracts(n) {
  return Math.round(n * 1e6) / 1e6;
}

// Both venues. Session and the DB map each move by `contracts` once.
// filledSoFar is max(map, session), so the same fill is not added twice.
function noteCapFill(filledByParlay, sessionFilledByParlay, parlayId, contracts) {
  if (!parlayId) return;
  const n = Number(contracts);
  if (!Number.isFinite(n) || !(n > 0)) return;
  if (filledByParlay) {
    filledByParlay[parlayId] = roundContracts((Number(filledByParlay[parlayId]) || 0) + n);
  }
  if (sessionFilledByParlay) {
    sessionFilledByParlay[parlayId] = roundContracts((Number(sessionFilledByParlay[parlayId]) || 0) + n);
  }
}

// One row per fill_id. Overlapping pages must not add the same fill twice.
function sumCapFills(rows, countField = 'count') {
  const seen = new Set();
  const next = {};
  for (const r of rows || []) {
    if (!r || !r.parlay_id) continue;
    if (r.fill_id) {
      if (seen.has(r.fill_id)) continue;
      seen.add(r.fill_id);
    }
    const n = Number(r[countField]);
    if (!Number.isFinite(n)) continue;
    next[r.parlay_id] = roundContracts((next[r.parlay_id] || 0) + n);
  }
  return next;
}

// Per lock, keep the larger of memory and the DB snapshot. Never add them:
// a fill noted in memory and present in the snapshot counts once. A fill
// noted in memory but missing from this snapshot is kept.
function mergeCapFilled(memory, dbSum) {
  const next = {};
  const ids = new Set([
    ...Object.keys(memory || {}),
    ...Object.keys(dbSum || {}),
  ]);
  for (const id of ids) {
    const mem = Number(memory && memory[id]) || 0;
    const db = Number(dbSum && dbSum[id]) || 0;
    const n = Math.max(mem, db);
    if (n > 0) next[id] = roundContracts(n);
  }
  return next;
}

// Incomplete page (error, or the ceiling hit before a short page) returns
// the same memory object. A finished read merges; it does not add.
function applyCapFillPage(memory, page, { countField = 'count', keepRow = () => true } = {}) {
  if (!page || page.ok !== true || !Array.isArray(page.rows)) return memory;
  const dbSum = sumCapFills(page.rows.filter(keepRow), countField);
  return mergeCapFilled(memory, dbSum);
}

// Page combo_fills the way scripts/reconcile-kalshi-phantom-fills.js does.
// `ok: false` means the caller must keep its in-memory counts.
async function loadCapFillRows(supabase, { parlayId = null, pageSize = CAP_FILL_PAGE_SIZE, maxRows = CAP_FILL_MAX_ROWS } = {}) {
  if (!supabase) return { ok: false, rows: [], error: { message: 'no supabase' } };
  const size = pageSize > 0 ? pageSize : CAP_FILL_PAGE_SIZE;
  const ceiling = maxRows > 0 ? maxRows : CAP_FILL_MAX_ROWS;
  const rows = [];
  for (let from = 0; from < ceiling; from += size) {
    let q = supabase
      .from('combo_fills')
      .select('parlay_id,count,fill_id,order_id,raw')
      .eq('is_combo', true)
      .eq('is_taker', false)
      .not('parlay_id', 'is', null);
    if (parlayId) q = q.eq('parlay_id', parlayId);
    const res = await q.order('fill_id', { ascending: true }).range(from, from + size - 1);
    if (!res || res.error || !Array.isArray(res.data)) {
      return { ok: false, rows, error: (res && res.error) || { message: 'cap fills page missing' } };
    }
    rows.push(...res.data);
    if (res.data.length < size) return { ok: true, rows, error: null };
  }
  return { ok: false, rows, error: { message: `cap fills exceeded ${ceiling} rows` } };
}

module.exports = {
  querySoftFailed,
  lockLabels,
  applyRefreshParlays,
  applyRefreshKillByUser,
  applyRefreshFilledByParlay,
  CAP_FILL_PAGE_SIZE,
  CAP_FILL_MAX_ROWS,
  noteCapFill,
  sumCapFills,
  mergeCapFilled,
  applyCapFillPage,
  loadCapFillRows,
};
