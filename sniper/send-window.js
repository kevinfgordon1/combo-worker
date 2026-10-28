// Combo Sniper send-queue deadline (Oct 27 2026, Kevin: "anything past 3 seconds should just get
// dropped"). One config for every place that decides whether a quote can still reach Kalshi in time:
//   - runner pre-reserve admission (before the DB lock),
//   - quote-sender admission at arrival (queue position / sends-per-second), dequeue, and
//   - the rate-limit token wait right before the POST (abortIf).
// windowMs: max RFQ age (Kalshi created_ts) at which our POST may land. Default 3000.
// safetyMs: margin subtracted from the window (clock skew, jitter). Default 250.
// Also: busy-queue low-value skip and the same-price re-quote memo.
'use strict';

const num = (v, d) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : d; };

function sendWindowConfig(env = process.env) {
  // SNIPER_QUOTE_WINDOW_MS wins; SNIPER_POST_DEADLINE_MS is the older name for the same budget.
  const windowMs = Math.max(500, num(env.SNIPER_QUOTE_WINDOW_MS, num(env.SNIPER_POST_DEADLINE_MS, 3000)));
  return {
    enabled: String(env.SNIPER_SEND_DEADLINE || '1') !== '0',
    windowMs,
    safetyMs: Math.max(0, Math.min(windowMs - 100, num(env.SNIPER_QUOTE_SAFETY_MS, 250))),
    // POST latency estimate floor/cap (EWMA of recent POST round trips, clamped).
    postEstMinMs: Math.max(0, num(env.SNIPER_POST_EST_MIN_MS, 60)),
    postEstMaxMs: Math.max(100, num(env.SNIPER_POST_EST_MAX_MS, 1000)),
    // Busy queue: skip RFQs with >= busyMaxLegs legs AND EV < busyMinEv once the send queue is at
    // least busyFrac of its capacity. busyMaxLegs=0 disables.
    busyFrac: Math.max(0, Math.min(1, num(env.SNIPER_BUSY_QUEUE_FRAC, 0.5))),
    busyMaxLegs: Math.max(0, num(env.SNIPER_BUSY_MAX_LEGS, 5)),
    busyMinEv: Math.max(0, num(env.SNIPER_BUSY_MIN_EV, 0.5)),
    // Same combo + size quoted at the same NO price within this window (and not taken): don't
    // spend another write on it. 0 disables.
    requoteMs: Math.max(0, num(env.SNIPER_REQUOTE_SAME_PRICE_MS, 15000)),
  };
}

// EWMA of POST round trips, clamped to [min, max] so one slow call can't latch the gate shut.
function createPostEstimator({ minMs = 60, maxMs = 1000, initMs = 150, alpha = 0.2 } = {}) {
  let v = initMs;
  return {
    add(ms) { if (Number.isFinite(ms) && ms >= 0) v = (1 - alpha) * v + alpha * ms; },
    get() { return Math.max(minMs, Math.min(maxMs, v)); },
  };
}

// Busy-queue low-value skip. queued/capacity from the sender.
function lowValueWhenBusy(d, { queued = 0, capacity = Infinity } = {}, cfg) {
  if (!cfg || !(cfg.busyMaxLegs > 0) || !d) return false;
  if (!(capacity > 0) || queued < cfg.busyFrac * capacity) return false;
  const legs = Array.isArray(d.legs) ? d.legs.length : 0;
  const ev = Number(d.ev);
  return legs >= cfg.busyMaxLegs && Number.isFinite(ev) && ev < cfg.busyMinEv;
}

// "Don't re-quote unless the price moved": remembers the NO bid we last POSTed per combo+size.
function createRequoteMemo({ windowMs = 15000, max = 20000, now = () => Date.now() } = {}) {
  const m = new Map(); // key -> { noBid, at }
  const keyOf = (d) => (d && d.combo ? `${d.combo}#${Number(d.contracts) || 0}` : null);
  return {
    keyOf,
    // true => same combo+size already quoted at this exact NO bid within windowMs (and not taken).
    isRepeat(d, noBid) {
      if (!(windowMs > 0)) return false;
      const k = keyOf(d); if (!k) return false;
      const e = m.get(k); if (!e) return false;
      if (now() - e.at > windowMs) { m.delete(k); return false; }
      return String(e.noBid) === String(noBid);
    },
    note(d, noBid) {
      if (!(windowMs > 0)) return;
      const k = keyOf(d); if (!k || noBid == null) return;
      m.delete(k); m.set(k, { noBid: String(noBid), at: now() });
      if (m.size > max) m.delete(m.keys().next().value);
    },
    forget(d) { const k = keyOf(d); if (k) m.delete(k); },
    size: () => m.size,
  };
}

module.exports = { sendWindowConfig, createPostEstimator, lowValueWhenBusy, createRequoteMemo };
