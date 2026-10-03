// In-app alert policy for Polymarket RFQ WebSocket stalls.
//
// A single stall that self-heals (watchdog reconnects, traffic resumes) is
// routine: it is recorded as an INFO row and resolved the moment traffic is
// back, so the app hides it from the banner (it stays in the bell history).
// Only a real problem escalates to a WARN row (banner stays up):
//   - 3+ stalls inside one hour, or
//   - a stall that has not recovered after unrecoveredMs.
// The escalation row clears itself once the socket is recovered and fewer than
// 3 stalls remain inside the hour.
'use strict';

const STALL_KEY = 'poly_ws_stall';
const ESCALATED_KEY = 'poly_ws_stall_escalated';
const DEFAULTS = {
  windowMs: 60 * 60 * 1000,
  repeatCount: 3,
  unrecoveredMs: 2 * 60 * 1000,
};

function fmtCause(info) {
  const i = info || {};
  const p = i.ping || {};
  const parts = [`silent ${Math.round((i.silentMs || 0) / 1000)}s`];
  if (i.lastMessageType !== undefined) parts.push(`last message: ${i.lastMessageType || 'none this connection'}`);
  if (i.messagesThisConn != null) parts.push(`${i.messagesThisConn} msgs on this socket`);
  if (p.state) parts.push(`ping/pong: ${p.state}`);
  return parts.join('; ');
}

function createPolyStallAlerts({ appAlerts, now = () => Date.now(), log = () => {}, ...opts } = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const stallTimes = [];
  let pendingSince = 0;
  let escalated = false;

  function recent() {
    const cut = now() - cfg.windowMs;
    while (stallTimes.length && stallTimes[0] < cut) stallTimes.shift();
    return stallTimes.length;
  }

  async function escalate(reason, info) {
    escalated = true;
    return appAlerts.raise({
      kind: 'poly_ws_stall_escalated',
      severity: 'warn',
      title: 'Polymarket RFQ WebSocket keeps stalling',
      body: `${reason}. ${fmtCause(info)}. REST crawl is covering intake meanwhile.`,
      dedupeKey: ESCALATED_KEY,
      meta: { reason, stalls_last_hour: recent(), service: 'combo-worker', ...(info || {}) },
    });
  }

  async function onStall(info) {
    const t = now();
    stallTimes.push(t);
    if (!pendingSince) pendingSince = t;
    const n = recent();
    const out = await appAlerts.raise({
      kind: 'poly_ws_stall',
      severity: 'info',
      title: 'Polymarket RFQ WebSocket stalled - reconnecting',
      body: `${fmtCause(info)}. Socket terminated and reconnected; REST crawl is covering intake meanwhile.`,
      dedupeKey: STALL_KEY,
      meta: {
        service: 'combo-worker',
        stalls_last_hour: n,
        silent_ms: info && info.silentMs,
        stalls: info && info.stalls,
        reconnects: info && info.reconnects,
        last_message_type: info && info.lastMessageType,
        messages_this_conn: info && info.messagesThisConn,
        socket_age_ms: info && info.socketAgeMs,
        ping: info && info.ping,
      },
    });
    if (n >= cfg.repeatCount && !escalated) {
      await escalate(`${n} stalls in the last hour`, info);
    }
    return out;
  }

  async function onRecovered() {
    pendingSince = 0;
    const out = await appAlerts.resolve([STALL_KEY]);
    await tick();
    return out;
  }

  // Periodic: escalate an unrecovered stall; clear the escalation once healthy.
  async function tick() {
    if (pendingSince && now() - pendingSince >= cfg.unrecoveredMs && !escalated) {
      await escalate(`stall not recovered after ${Math.round((now() - pendingSince) / 1000)}s`, null);
    }
    if (escalated && !pendingSince && recent() < cfg.repeatCount) {
      escalated = false;
      await appAlerts.resolve([ESCALATED_KEY]);
    }
  }

  return { onStall, onRecovered, tick, _state: () => ({ escalated, pending: !!pendingSince, recent: recent() }) };
}

module.exports = { createPolyStallAlerts, fmtCause, STALL_KEY, ESCALATED_KEY, DEFAULTS };
