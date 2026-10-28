// Untracked-quote sweep (Oct 28 2026, SNIPER_UNTRACKED_SWEEP, default on in live). Runs on each complete
// open-quote snapshot the quote-status poll already reads (read lane, no extra write budget for the read).
// Cancels OPEN quotes on the sniper subaccount that this process is NOT tracking (not pending, no queued
// routine DELETE, not a skipped-not-open quote the backstop owns) and that are older than minAgeMs
// (default 30s, Kalshi server time). Covers quotes Kalshi created although our POST errored / timed out,
// and anything else no timer will ever cancel.
// Safety: subaccount must be >= 1 and equal each quote's creator_subaccount (missing / 0 / other =>
// skipped, so Combo Locks quotes are never touched); status 'open' only; partial snapshot => nothing;
// one DELETE per quote per resendMs; at most maxPerTick DELETEs per snapshot; routine (low) lane.
'use strict';
const { selectStartupCancels } = require('./startup-cancel');

function createUntrackedSweep({ enabled = true, trader, subaccount, isTracked, minAgeMs = 30000, maxPerTick = 25, resendMs = 30000, now = () => Date.now(), log = console.log }) {
  const sent = new Map(); // quoteId -> sentAt
  const stats = { ticks: 0, partial: 0, candidates: 0, sent: 0, gone: 0, failed: 0, skippedTracked: 0, skippedRecent: 0, skippedOther: 0, refused: null, lastAt: null };
  if (!(Number(subaccount) >= 1)) stats.refused = 'no_subaccount';
  const mark = (ids) => { const t = now(); for (const id of ids || []) sent.set(id, t); };
  function prune(t) { for (const [id, at] of sent) { if (t - at <= Math.max(resendMs, 120000)) break; sent.delete(id); } }
  // snap: trader.openQuotesSnapshot() result; serverNowMs: Kalshi server time (created_ts clock).
  function onSnapshot(snap, serverNowMs) {
    if (!enabled || stats.refused || !snap) return [];
    stats.ticks += 1; stats.lastAt = now();
    if (!snap.complete) { stats.partial += 1; return []; }
    const t = now(); prune(t);
    const sel = selectStartupCancels(snap.quotes || [], { subaccount, cutoffMs: serverNowMs - minAgeMs });
    stats.skippedOther += sel.skipped.other_subaccount;
    const todo = [];
    for (const id of sel.ids) {
      if (isTracked(id)) { stats.skippedTracked += 1; continue; }
      const at = sent.get(id); if (at != null && t - at < resendMs) { stats.skippedRecent += 1; continue; }
      todo.push(id); if (todo.length >= maxPerTick) break;
    }
    stats.candidates += todo.length;
    for (const id of todo) {
      sent.set(id, t);
      Promise.resolve().then(() => trader.cancel(id, { urgent: false })).then((r) => {
        if (r && r.skipped) return;
        if (r && r.statusCode === 404) stats.gone += 1; else stats.sent += 1;
      }).catch((e) => { stats.failed += 1; if (stats.failed <= 5 || stats.failed % 100 === 0) log(`[SNIPER] untracked cancel ${id} failed: ${String(e.message || e).slice(0, 160)}`); });
    }
    if (todo.length && (stats.candidates <= 50 || stats.candidates % 500 < todo.length)) log(`[SNIPER] untracked sweep: cancelling ${todo.length} open quote(s) we do not track, older than ${Math.round(minAgeMs / 1000)}s (total ${stats.candidates})`);
    return todo;
  }
  return { onSnapshot, mark, stats: () => ({ ...stats, enabled, minAgeMs, remembered: sent.size }) };
}

module.exports = { createUntrackedSweep };
