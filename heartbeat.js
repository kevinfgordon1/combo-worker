// ─────────────────────────────────────────────────────────────────────────
// heartbeat.js — OBSERVABILITY ONLY. Writes one combo_worker_stats row per
// interval so the database (and the Combo Locks monitor) can see that the
// worker is alive, the firehose is flowing, and what it has matched/posted.
//
// It NEVER reads or touches the order path. It only INSERTs a stats row on a
// timer. This is a single setInterval writing ONE row per interval — it is
// nothing like the per-message debug capture that caused the earlier OOM.
//
// ── HOW TO WIRE IN (one line, added by YOU inside live-runner.js) ──────────
//   At the top with the other requires:
//     const { startHeartbeat } = require('./heartbeat');
//   Inside main(), AFTER `counts` exists and AFTER the first `await refresh()`:
//     startHeartbeat(supabase, MODE, counts, () => parlays.length);
//
// That's it. No order logic changes. Remove the line to turn it off.
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const { resolveWorkerScope } = require('./worker-scope');
const SCOPE = resolveWorkerScope(process.env);

/**
 * @param {object} supabase        an initialized supabase-js client
 * @param {string} mode            e.g. 'LIVE' or 'SHADOW'
 * @param {object} counts          the runner's live tally object (read-only here)
 * @param {function} getActive     () => number of active parlays currently loaded
 * @param {number} [intervalMs]    heartbeat cadence (default 60s)
 * @returns {function} stop        call to stop the heartbeat
 */
function startHeartbeat(supabase, mode, counts, getActive, intervalMs = 60000, getExtra = null) {
  let lastRfqs = -1;

  async function beat() {
    try {
      const c = counts || {};
      const rfqs = c.rfqs || 0;
      // Infer WS health from the firehose advancing between beats. If rfqs
      // hasn't moved since the last beat, the socket is stalled/reconnecting.
      const wsConnected = lastRfqs < 0 ? true : rfqs > lastRfqs;
      lastRfqs = rfqs;

      const activeParlays =
        typeof getActive === 'function' ? Number(getActive()) || 0 : 0;

      const row = {
        ts: new Date().toISOString(),
        mode,
        ws_connected: wsConnected,
        rfqs,
        combos: c.combos || 0,
        matched: c.matched || 0,
        would_quote: c.wouldQuote || 0,
        declined: c.declined || 0,
        no_lock: c.noLock || 0,
        active_parlays: activeParlays,
        posted: c.posted || 0,
        post_failed: c.postFailed || 0,
        limit_reached: c.limitReached || 0,
        dollar_rfqs: c.dollarRfqs || 0,
      };
      // Tester child: stats belong to that tester (the main worker leaves the
      // DB default, Kevin). Keeps Kevin's bucket/stats view his own.
      if (SCOPE.writeUserId) row.user_id = SCOPE.writeUserId;
      // Optional extra columns (e.g. { poly: {...} } jsonb). If the column is
      // not migrated yet the insert is retried once without them.
      let extra = null;
      try { extra = typeof getExtra === 'function' ? getExtra() : null; } catch (_) { extra = null; }
      if (extra && typeof extra === 'object') {
        // A not-yet-migrated extra column must only drop THAT column, not every
        // extra (poly / latency / bucket ...). Retry, removing the column the
        // error names; give up to the bare row after a few rounds.
        const payload = { ...row, ...extra };
        let res = await supabase.from('combo_worker_stats').insert(payload);
        for (let i = 0; res && res.error && i < 6; i += 1) {
          const m = /Could not find the '([^']+)' column/i.exec(String(res.error.message || ''));
          if (!m || !(m[1] in payload) || m[1] in row) break;
          delete payload[m[1]];
          res = await supabase.from('combo_worker_stats').insert(payload);
        }
        if (res && res.error) await supabase.from('combo_worker_stats').insert(row);
      } else {
        await supabase.from('combo_worker_stats').insert(row);
      }
    } catch (e) {
      // Observability must never disrupt the worker — swallow and log only.
      console.error(`[${mode}] heartbeat insert failed`, e && e.message);
    }
  }

  beat(); // one immediate beat so liveness shows up right after deploy
  const timer = setInterval(beat, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return function stop() { clearInterval(timer); };
}

module.exports = { startHeartbeat };
