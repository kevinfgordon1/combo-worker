// Combo Locks Polymarket decline guard (Nov 1 2026).
//
// Polymarket pauses a maker whose account-wide decline rate (accepts it did not confirm) goes over
// ~15%. On Nov 1 Combo Locks declined 68 of 70 Polymarket accepts in an hour while it kept posting,
// and none of those declines were written anywhere but the console. This guard:
//   - remembers every Combo Locks accept outcome (confirmed or declined + reason) for the window;
//   - per lock: after `lockMaxDeclines` declines inside `lockWindowMs`, that lock stops posting on
//     Polymarket for `lockCooldownMs` (it cannot honor its accepts; quoting it only adds declines);
//   - account: when Combo Locks' own decline rate over the window is above `ratio` with at least
//     `minDeclines` declines, ALL Combo Locks Polymarket posting stops until it is back under.
// Kalshi Combo Locks and the Polymarket sniper are not touched. POLY_COMBO_DECLINE_GUARD=0 = off.
'use strict';

function num(raw, dflt) {
  if (raw == null || String(raw).trim() === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}
function off(raw) { return /^(0|false|off|no)$/i.test(String(raw == null ? '' : raw).trim()); }

function readDeclineGuardConfig(env = process.env) {
  return {
    enabled: !off(env && env.POLY_COMBO_DECLINE_GUARD),
    windowMs: num(env && env.POLY_COMBO_DECLINE_WINDOW_MS, 3_600_000),
    // 4%: with the sniper held to 10% of its own share, the account stays under Polymarket's 15%.
    ratio: num(env && env.POLY_COMBO_DECLINE_RATIO, 0.04),
    minDeclines: num(env && env.POLY_COMBO_DECLINE_MIN, 3),
    lockWindowMs: num(env && env.POLY_COMBO_LOCK_DECLINE_WINDOW_MS, 1_800_000),
    lockMaxDeclines: num(env && env.POLY_COMBO_LOCK_DECLINES, 2),
    lockCooldownMs: num(env && env.POLY_COMBO_LOCK_COOLDOWN_MS, 1_800_000),
  };
}

function createDeclineGuard(cfg = {}, { now = Date.now, log = () => {} } = {}) {
  const c = { ...readDeclineGuardConfig({}), ...cfg };
  const events = []; // { at, parlayId, declined, reason }
  const lockUntil = new Map(); // parlayId -> ms
  let accountPaused = false;
  const skipped = {};

  function prune(t) {
    while (events.length && events[0].at < t - c.windowMs) events.shift();
    for (const [id, until] of lockUntil) if (until <= t) lockUntil.delete(id);
  }
  function tally(t = now()) {
    prune(t);
    let declines = 0;
    const byReason = {};
    for (const e of events) {
      if (!e.declined) continue;
      declines += 1;
      byReason[e.reason] = (byReason[e.reason] || 0) + 1;
    }
    const accepts = events.length;
    return { accepts, declines, ratio: accepts ? declines / accepts : 0, byReason };
  }
  function accountOver(r) { return r.declines >= c.minDeclines && r.ratio > c.ratio; }

  // -> { lockTripped, accountTripped } so the caller can cancel open quotes.
  function record({ parlayId, confirmed, reason } = {}) {
    const t = now();
    const declined = !confirmed;
    events.push({ at: t, parlayId: parlayId != null ? String(parlayId) : null, declined, reason: declined ? String(reason || 'unknown') : null });
    const out = { lockTripped: false, accountTripped: false };
    if (!c.enabled || !declined) { refresh(t); return out; }
    if (parlayId != null && c.lockMaxDeclines > 0) {
      const id = String(parlayId);
      const n = events.filter((e) => e.declined && e.parlayId === id && e.at >= t - c.lockWindowMs).length;
      if (n >= c.lockMaxDeclines && !lockUntil.has(id)) {
        lockUntil.set(id, t + c.lockCooldownMs);
        out.lockTripped = true;
        log(`DECLINE GUARD lock=${id} paused on Polymarket for ${Math.round(c.lockCooldownMs / 60000)}m after ${n} declines (last: ${reason || 'unknown'})`);
      }
    }
    const was = accountPaused;
    refresh(t);
    if (accountPaused && !was) out.accountTripped = true;
    return out;
  }
  function refresh(t = now()) {
    const r = tally(t);
    const over = c.enabled && accountOver(r);
    if (over && !accountPaused) {
      accountPaused = true;
      log(`DECLINE GUARD account: Combo Locks declined ${r.declines}/${r.accepts} Polymarket accepts in the last ${Math.round(c.windowMs / 60000)}m (${(r.ratio * 100).toFixed(0)}% > ${(c.ratio * 100).toFixed(0)}%) — Combo Locks stops posting on Polymarket. reasons=${JSON.stringify(r.byReason)}`);
    } else if (!over && accountPaused) {
      accountPaused = false;
      log(`DECLINE GUARD account cleared: ${r.declines}/${r.accepts} (${(r.ratio * 100).toFixed(0)}%)`);
    }
    return r;
  }
  // null = may post; else { reason }
  function check(parlayId) {
    if (!c.enabled) return null;
    const t = now();
    refresh(t);
    let hit = null;
    if (accountPaused) hit = { reason: 'combo_decline_rate' };
    else if (parlayId != null && (lockUntil.get(String(parlayId)) || 0) > t) hit = { reason: 'lock_declines', until: lockUntil.get(String(parlayId)) };
    if (hit) skipped[hit.reason] = (skipped[hit.reason] || 0) + 1;
    return hit;
  }
  function stats() {
    const r = tally();
    const out = { enabled: c.enabled, accountPaused, ...r, pausedLocks: lockUntil.size, skipped: { ...skipped } };
    for (const k of Object.keys(skipped)) delete skipped[k];
    return out;
  }
  return { record, check, stats, config: c, _lockUntil: lockUntil };
}

module.exports = { createDeclineGuard, readDeclineGuardConfig };
