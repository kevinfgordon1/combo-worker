// poly-worker fill-check scheduler.
//
// Fills reach poly-worker on the private WebSocket (quote / order execution
// events, plus SUBSCRIPTION_TYPE_POSITION pushes). The REST fill check
// (GET /v1/portfolio/activities + /v1/portfolio/positions) is only a backstop:
//   - private socket live      -> one REST check every safetyMs (default 5 min)
//   - private socket down      -> one REST check every downMs (default 60s)
//   - socket reconnected / a position push arrived -> one prompt check
//     (debounced to at most one every minGapMs) to cover any gap.
// Only one check runs at a time. Duplicate fills are already rejected by the
// reconcile's fill-id / size dedupe (seenFillIds, booked fills); this module
// only decides *when* to run it.
'use strict';

function createPolyFillScheduler({
  safetyMs = 5 * 60 * 1000,
  downMs = 60 * 1000,
  minGapMs = 15 * 1000,
  liveSilentMs = 15 * 1000,
  now = () => Date.now(),
} = {}) {
  let lastRunAt = 0;
  let pending = null; // reason of a queued prompt check
  let inFlight = false;
  const stats = { runs: 0, safety: 0, down: 0, trigger: 0, skippedInFlight: 0 };

  // Private socket is "live" when it delivered any message recently. This is
  // deliberately separate from the RFQ-intake stall-recovery window: an RFQ
  // stall 9 minutes ago must not force the fill check back to fast polling.
  function socketLive(wsStats) {
    if (!wsStats || wsStats.lastMessageAt == null) return false;
    const silent = wsStats.silentMs != null ? wsStats.silentMs : now() - wsStats.lastMessageAt;
    return silent <= liveSilentMs;
  }

  function trigger(reason) { pending = reason || 'trigger'; }

  // Returns the reason to run now, or null.
  function due(wsStats) {
    if (inFlight) { stats.skippedInFlight += 1; return null; }
    const t = now();
    const since = t - lastRunAt;
    if (pending && since >= minGapMs) return pending;
    if (socketLive(wsStats)) return since >= safetyMs ? 'safety' : null;
    return since >= downMs ? 'ws-down' : null;
  }

  async function run(reason, fn) {
    if (inFlight) { stats.skippedInFlight += 1; return null; }
    inFlight = true;
    lastRunAt = now();
    if (reason === pending) pending = null;
    else if (pending && reason) pending = null; // any run covers a queued trigger
    stats.runs += 1;
    if (reason === 'safety') stats.safety += 1;
    else if (reason === 'ws-down') stats.down += 1;
    else stats.trigger += 1;
    try { return await fn(); } finally { inFlight = false; }
  }

  async function tick(wsStats, fn) {
    const reason = due(wsStats);
    if (!reason) return null;
    return run(reason, fn);
  }

  function rollStats() {
    const out = { ...stats };
    for (const k of Object.keys(stats)) stats[k] = 0;
    return out;
  }

  return { tick, trigger, due, run, socketLive, rollStats, peek: () => ({ lastRunAt, pending, inFlight, ...stats }) };
}

// SUBSCRIPTION_TYPE_POSITION pushes are parsed as type 'other'. Accept the
// documented camelCase / snake_case wrappers.
function isPositionPush(evt) {
  if (!evt || evt.type !== 'other' || !evt.raw || typeof evt.raw !== 'object') return false;
  const r = evt.raw;
  return !!(r.positionUpdate || r.position_update || r.position || r.positions
    || r.positionSubscriptionUpdate || r.position_subscription_update);
}

module.exports = { createPolyFillScheduler, isPositionPush };
