// Per-user dollar caps for tester accounts (combo_live_users.max_per_lock_usd /
// max_per_day_usd; defaults $50 / $250, Kevin = NULL = uncapped).
//
// Dollars = hedge cost = contracts x NO price the worker pays (fees excluded).
//
// Per lock: the lock's ceiling (max_contracts) is clamped in memory to
//   floor(max_per_lock_usd / cost per contract). Both venues already honour
//   max_contracts through the shared reserve, so the cap applies to Kalshi
//   and Polymarket alike. A lock that cannot afford one contract is dropped.
// Per day (ET): before every quote the user counts as kill-engaged when
//   today's confirmed fills + session fills since the last read + every open
//   quote/confirm + the largest quote any of their locks could still take
//   (the lock being quoted, or the user's largest when no lock is given) would
//   exceed max_per_day_usd. Strict: the cap can't be overrun even if the next
//   quote fills in full, so a user can stop up to one lock's room short of it. If today's fills can't be read, capped users
//   stay engaged (fail closed).
// Uncapped users (Kevin) skip all of this; their rows pass through untouched.
'use strict';

function etDayStartIso(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const etAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  const offsetMs = etAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - offsetMs).toISOString();
}

function createUserCaps({ gate, costFor, countsTowardCap = () => true, log = console.log, now = () => new Date() } = {}) {
  const cost = (row) => {
    let c = null;
    try { c = costFor ? Number(costFor(row)) : null; } catch (_) { c = null; }
    return Number.isFinite(c) && c > 0 && c <= 1 ? c : 1;
  };
  let dayUsedUsd = new Map();
  let dayOk = false;
  let filledAtRead = {};
  const droppedLogged = new Set();

  function capsFor(userId) { return gate && gate.capsFor ? gate.capsFor(userId) : null; }

  function applyLockCaps(rows) {
    if (!Array.isArray(rows)) return rows;
    const out = [];
    for (const row of rows) {
      const caps = row && capsFor(row.user_id);
      if (!caps || caps.perLockUsd == null) { out.push(row); continue; }
      const lim = Math.floor(caps.perLockUsd / cost(row));
      if (!(lim >= 1)) {
        if (!droppedLogged.has(row.id)) {
          droppedLogged.add(row.id);
          log(`[CAPS] lock ${row.id} (${row.label || ''}) dropped — $${caps.perLockUsd} per-lock cap buys < 1 contract`);
        }
        continue;
      }
      const cur = Number(row.max_contracts) > 0 ? Number(row.max_contracts) : Infinity;
      out.push(lim < cur ? { ...row, max_contracts: lim, user_cap_contracts: lim } : row);
    }
    return out;
  }

  function cappedUserIds(parlays) {
    const ids = new Set();
    for (const p of parlays || []) {
      const caps = p && capsFor(p.user_id);
      if (caps && caps.perDayUsd != null) ids.add(p.user_id);
    }
    return [...ids];
  }

  // Read today's confirmed fills for capped users. Never throws.
  async function refreshDay({ supabase, parlays, filledSoFarFor }) {
    const ids = cappedUserIds(parlays);
    if (!ids.length) { dayUsedUsd = new Map(); dayOk = true; filledAtRead = {}; return true; }
    try {
      const snap = {};
      for (const p of parlays) if (ids.includes(p.user_id)) snap[p.id] = Number(filledSoFarFor ? filledSoFarFor(p.id) : 0) || 0;
      const { data, error } = await supabase
        .from('combo_fills')
        .select('parlay_id,count,user_id,fill_id,order_id,raw')
        .in('user_id', ids)
        .eq('is_combo', true)
        .eq('is_taker', false)
        .gte('recorded_at', etDayStartIso(now()));
      if (error || !Array.isArray(data)) throw new Error(error ? error.message : 'no data');
      const byId = new Map((parlays || []).map((p) => [p.id, p]));
      const next = new Map();
      for (const r of data) {
        if (!countsTowardCap(r)) continue;
        const lock = byId.get(r.parlay_id);
        const usd = (Number(r.count) || 0) * (lock ? cost(lock) : 1);
        next.set(r.user_id, (next.get(r.user_id) || 0) + usd);
      }
      dayUsedUsd = next;
      filledAtRead = snap;
      dayOk = true;
      return true;
    } catch (e) {
      dayOk = false;
      log(`[CAPS] today's fills read failed (${e && e.message}) — capped users stay engaged`);
      return false;
    }
  }

  function dayBlocked(userId, { parlays = [], filledSoFarFor = () => 0, outstandingFor = () => 0, lock = null } = {}) {
    const caps = capsFor(userId);
    if (!caps || caps.perDayUsd == null) return false;
    if (!dayOk) return true;
    let used = dayUsedUsd.get(userId) || 0;
    let open = 0;
    let maxNext = 0;
    for (const p of parlays) {
      if (!p || p.user_id !== userId) continue;
      const c = cost(p);
      const filled = Number(filledSoFarFor(p.id)) || 0;
      const outstanding = Number(outstandingFor(p.id)) || 0;
      used += Math.max(0, filled - (filledAtRead[p.id] || 0)) * c;
      open += outstanding * c;
      const ceiling = Number(p.max_contracts) > 0 ? Number(p.max_contracts) : Infinity;
      const room = Math.max(0, ceiling - filled - outstanding);
      const next = Number.isFinite(room) ? room * c : (caps.perLockUsd != null ? caps.perLockUsd : caps.perDayUsd);
      // Quoting a specific lock: only that lock's remaining room matters.
      if (lock && p.id !== lock.id) continue;
      if (next > maxNext) maxNext = next;
    }
    return used + open + maxNext > caps.perDayUsd + 1e-9;
  }

  function dayUsed(userId) { return dayUsedUsd.get(userId) || 0; }

  return { applyLockCaps, refreshDay, dayBlocked, dayUsed, cappedUserIds, get dayOk() { return dayOk; } };
}

module.exports = { createUserCaps, etDayStartIso };
