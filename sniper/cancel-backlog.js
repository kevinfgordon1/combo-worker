// Oct 28 2026: keep routine cancels ahead of quotes so no sniper quote rests on Kalshi for minutes.
//
// createPostGate (fix 2, SNIPER_BACKLOG_GATE): when routine DELETEs back up, drop the LOWEST-EV posts
// (never a cancel / confirm) until the queue drains. Levels from the routine cancel queue
// (queued count, age of the oldest queued quote since it was posted):
//   1: queued > maxQueued  or oldest > maxAgeMs      -> drop posts below the recent EV median (p50)
//   2: queued > 2x         or oldest > 1.5x maxAgeMs -> drop posts below the recent p90
//   3: queued > 4x         or oldest > 2x maxAgeMs   -> drop every post until it recovers
// The EV reference is a rolling window of candidate EVs (what we would have posted), so the cut adapts
// to the current slate. Pure / clock-injected for tests.
//
// createQtoBreaker (fix 3, SNIPER_QTO_BREAKER): Kalshi answers 409 quote_timed_out in bursts (Oct 28:
// 12:02-12:07 PM ET and 2:08-2:16 PM ET every POST failed, Combo Locks too). When more than `ratio` of
// the POST outcomes in the last windowMs are quote_timed_out (with at least minSamples), pause posts for
// pauseMs (doubling per consecutive trip up to maxPauseMs). Paused quotes never take a write token, so
// the whole budget goes to cancels. After the pause the window starts fresh (half-open).
'use strict';

function pctOf(sorted, q) { if (!sorted.length) return null; return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]; }

function createPostGate({ enabled = true, maxQueued = 50, maxAgeMs = 15000, evWindow = 400, now = () => Date.now() } = {}) {
  const evs = []; let sorted = null;
  const stats = { checks: 0, dropped: 0, droppedByLevel: { 1: 0, 2: 0, 3: 0 }, level: 0, maxLevel: 0, cutEv: null };
  function note(ev) { if (!Number.isFinite(ev)) return; evs.push(ev); if (evs.length > evWindow) evs.shift(); sorted = null; }
  function level({ queued = 0, oldestAgeMs = null } = {}) {
    if (!enabled) return 0;
    const age = Number.isFinite(oldestAgeMs) ? oldestAgeMs : 0;
    if (queued > maxQueued * 4 || age > maxAgeMs * 2) return 3;
    if (queued > maxQueued * 2 || age > maxAgeMs * 1.5) return 2;
    if (queued > maxQueued || age > maxAgeMs) return 1;
    return 0;
  }
  // -> null (post) or 'cancel_backlog_l<level>' (drop). record=false for the re-check right before POST.
  function check(ev, backlog, { record = true } = {}) {
    if (!enabled) return null;
    stats.checks += 1;
    if (record) note(ev);
    const lv = level(backlog); stats.level = lv; if (lv > stats.maxLevel) stats.maxLevel = lv;
    if (lv === 0) { stats.cutEv = null; return null; }
    let cut = Infinity;
    if (lv < 3) { if (!sorted) sorted = [...evs].sort((a, b) => a - b); cut = pctOf(sorted, lv === 1 ? 0.5 : 0.9); if (cut == null) cut = -Infinity; }
    stats.cutEv = Number.isFinite(cut) ? Math.round(cut * 100) / 100 : (cut === Infinity ? 'all' : null);
    const e = Number.isFinite(ev) ? ev : -Infinity;
    if (e >= cut) return null;
    stats.dropped += 1; stats.droppedByLevel[lv] += 1;
    return `cancel_backlog_l${lv}`;
  }
  return { check, level, note, stats: () => ({ ...stats, droppedByLevel: { ...stats.droppedByLevel }, enabled, maxQueued, maxAgeMs }) };
}

function createQtoBreaker({ enabled = true, windowMs = 10000, ratio = 0.5, minSamples = 20, pauseMs = 10000, maxPauseMs = 30000, now = () => Date.now(), onTrip = () => {}, onResume = () => {} } = {}) {
  const win = []; // [atMs, isQto]
  let pausedUntil = 0; let streak = 0; let lastTripEnd = 0; let wasPaused = false;
  const stats = { trips: 0, pausedDrops: 0, pausedMs: 0, outcomes: 0, qto: 0, lastTripAt: null, lastPauseMs: 0 };
  const trim = (t) => { while (win.length && win[0][0] < t - windowMs) win.shift(); };
  function paused() {
    if (!enabled) return false;
    const t = now();
    if (t < pausedUntil) return true;
    if (wasPaused) { wasPaused = false; lastTripEnd = pausedUntil; win.length = 0; try { onResume({ streak }); } catch (_) {} }
    return false;
  }
  function record(isQto) {
    if (!enabled) return;
    const t = now(); stats.outcomes += 1; if (isQto) stats.qto += 1;
    if (t < pausedUntil) return; // in-flight POSTs finishing during a pause don't re-trip
    win.push([t, !!isQto]); trim(t);
    if (win.length < minSamples) return;
    let q = 0; for (const [, x] of win) if (x) q += 1;
    if (q / win.length > ratio) {
      // A clean window (no trip for 2 windows after the last pause) resets the escalation.
      streak = lastTripEnd && t - lastTripEnd <= windowMs * 2 ? streak + 1 : 1;
      const ms = Math.min(maxPauseMs, pauseMs * 2 ** (streak - 1));
      pausedUntil = t + ms; wasPaused = true; stats.trips += 1; stats.lastTripAt = t; stats.lastPauseMs = ms; stats.pausedMs += ms;
      const frac = q / win.length; const n = win.length; win.length = 0;
      try { onTrip({ pauseMs: ms, frac, samples: n, streak }); } catch (_) {}
    }
  }
  function drop() { stats.pausedDrops += 1; }
  return { paused, record, drop, stats: () => ({ ...stats, enabled, paused: paused(), pausedForMs: Math.max(0, pausedUntil - now()), streak }) };
}

module.exports = { createPostGate, createQtoBreaker };
