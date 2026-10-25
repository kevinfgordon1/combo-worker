// Near-miss RFQ log for active Combo Locks (COMBO_NEAR_MISS_LOG=1, default off).
//
// Answers "did an RFQ close to my lock arrive and why no quote?" with leg keys:
// an RFQ that missed every lock, shares all-but-one leg (at least one) with an
// active lock, and has at most one leg more than that lock is logged as
//   NEAR-MISS rfq=<id> lock=<id8> lockLegs=<n> rfqLegs=<m> shared=<k>
//     missing=<lock keys not in the RFQ> extra=<RFQ keys not in the lock>
// Hot-path cost when on: a Set lookup per RFQ leg against a key index rebuilt
// only when the lock list changes. Strings are built only after the rate
// limit passes: at most one line per lock per COMBO_NEAR_MISS_LOG_MS (default
// 10s) and COMBO_NEAR_MISS_MAX_PER_MIN lines overall (default 20).
'use strict';
const { parlayKeys, canonicalizeLegKey } = require('./rfq');

function on(raw) { return /^(1|true|yes|on)$/i.test(String(raw || '').trim()); }
function intEnv(raw, dflt, min, max) {
  const n = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function nearMissEnabled(env = process.env) { return on(env && env.COMBO_NEAR_MISS_LOG); }

// Min shared legs for a lock of n legs to count as a near miss.
function nearThreshold(n) { return Math.max(1, n - 1); }

function createNearMissLogger({ env = process.env, log = console.log, now = () => Date.now(), defer = setImmediate, mode = 'LIVE' } = {}) {
  const enabled = nearMissEnabled(env);
  const perLockMs = intEnv(env && env.COMBO_NEAR_MISS_LOG_MS, 10_000, 1000, 600_000);
  const maxPerMin = intEnv(env && env.COMBO_NEAR_MISS_MAX_PER_MIN, 20, 1, 600);
  let indexFor = null; // parlays array the index was built from
  let byKey = new Map(); // canon key -> [lockIdx]
  let locks = []; // { id, keys:[raw], canon:Set }
  const lastByLock = new Map();
  let minuteStart = 0; let minuteCount = 0;
  const stats = { seen: 0, near: 0, logged: 0, suppressed: 0 };

  function rebuild(parlays) {
    indexFor = parlays; byKey = new Map(); locks = [];
    for (const p of parlays || []) {
      const keys = parlayKeys(p) || [];
      const canon = keys.map(canonicalizeLegKey).filter(Boolean);
      if (!canon.length) continue;
      const i = locks.length;
      locks.push({ id: String((p && p.id) || ''), keys, canon: new Set(canon) });
      for (const c of new Set(canon)) { const a = byKey.get(c); if (a) a.push(i); else byKey.set(c, [i]); }
    }
  }

  // -> null or { lockId, shared, lockLegs, rfqLegs, missing, extra } (also logged, rate-limited)
  function observe(rfq, parlays) {
    if (!enabled || !rfq) return null;
    if (parlays !== indexFor) rebuild(parlays);
    if (!locks.length) return null;
    stats.seen += 1;
    const rk = (rfq.legKeys || []);
    if (!rk.length) return null;
    const counts = new Map();
    const rfqCanon = [];
    for (const k of rk) {
      const c = canonicalizeLegKey(k); if (!c) continue;
      rfqCanon.push(c);
      const hit = byKey.get(c); if (!hit) continue;
      for (const i of hit) counts.set(i, (counts.get(i) || 0) + 1);
    }
    let best = -1; let bestShared = 0;
    for (const [i, n] of counts) {
      if (n < nearThreshold(locks[i].canon.size)) continue;
      if (rfqCanon.length > locks[i].canon.size + 1) continue; // big parlays that merely contain the legs are not near misses
      if (n > bestShared || (n === bestShared && best >= 0 && locks[i].canon.size < locks[best].canon.size)) { best = i; bestShared = n; }
    }
    if (best < 0) return null;
    stats.near += 1;
    const lock = locks[best];
    const t = now();
    if (lastByLock.has(lock.id) && t - lastByLock.get(lock.id) < perLockMs) { stats.suppressed += 1; return { lockId: lock.id, suppressed: true }; }
    if (t - minuteStart >= 60_000) { minuteStart = t; minuteCount = 0; }
    if (minuteCount >= maxPerMin) { stats.suppressed += 1; return { lockId: lock.id, suppressed: true }; }
    lastByLock.set(lock.id, t); minuteCount += 1; stats.logged += 1;
    const rfqSet = new Set(rfqCanon);
    const missing = lock.keys.filter((k) => !rfqSet.has(canonicalizeLegKey(k)));
    const extra = rk.filter((k) => !lock.canon.has(canonicalizeLegKey(k)));
    const out = { lockId: lock.id, shared: bestShared, lockLegs: lock.canon.size, rfqLegs: rk.length, missing, extra };
    const id = rfq.rfqId;
    defer(() => {
      log(`[${mode}] NEAR-MISS rfq=${id} lock=${lock.id.slice(0, 8)} lockLegs=${out.lockLegs} rfqLegs=${out.rfqLegs} shared=${out.shared} ` +
        `missing=${missing.join('|') || '-'} extra=${extra.slice(0, 12).join('|') || '-'}${extra.length > 12 ? `|+${extra.length - 12}` : ''}`);
    });
    return out;
  }

  return { enabled, observe, stats: () => ({ ...stats }) };
}

module.exports = { createNearMissLogger, nearMissEnabled, nearThreshold };
