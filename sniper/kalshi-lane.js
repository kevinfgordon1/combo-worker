// Kalshi write-slot borrowing between Kevin's two apps on the same Kalshi account.
//   Combo Locks (kaygo-combo-worker) publishes a tiny "lane" row every ~2s: how many locks are
//   active and how many Kalshi writes (quote posts) it made in the last 10s.
//   The sniper reads it every ~2s and borrows ONLY verified-idle reserved slots.
// Combo Locks keeps priority:
//   - stale / missing / unreadable row       -> borrow 0 (sniper back to its base 6/s)
//   - any sniper 429                          -> borrow 0 for SNIPER_BORROW_COOLDOWN_MS (10 min)
//   - Combo Locks writes rising               -> borrow shrinks 3 slots per Combo Locks write/s
//   - always leaves SNIPER_BORROW_SAFETY_RPS of the reserve untouched
// Off unless SNIPER_KALSHI_BORROW=1. Nothing here touches caps, pricing or Combo Locks rules.
'use strict';

const num = (v, d) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : d; };
const LANE_TABLE = 'kalshi_write_lane';

function borrowConfig(env = process.env) {
  return {
    enabled: String(env.SNIPER_KALSHI_BORROW || '0') === '1',
    pollMs: Math.max(500, num(env.SNIPER_BORROW_POLL_MS, 2000)),
    staleMs: Math.max(1000, num(env.SNIPER_BORROW_STALE_MS, 6000)),
    safetyRps: Math.max(0, num(env.SNIPER_BORROW_SAFETY_RPS, 1)),
    maxActiveLocks: Math.max(0, num(env.SNIPER_BORROW_MAX_ACTIVE_LOCKS, 3)),
    perComboWriteRps: Math.max(1, num(env.SNIPER_BORROW_PER_COMBO_WRITE, 3)),
    cooldownMs: Math.max(0, num(env.SNIPER_BORROW_COOLDOWN_MS, 10 * 60 * 1000)),
  };
}

// Pure: how many of Combo Locks' reserved slots/s the sniper may borrow right now.
function computeBorrow({ lane, now, reserved, cfg, cooldownUntil = 0 }) {
  if (!cfg.enabled) return { borrow: 0, why: 'off' };
  if (now < cooldownUntil) return { borrow: 0, why: '429_cooldown' };
  if (!lane || !lane.ts) return { borrow: 0, why: 'no_signal' };
  const age = now - Date.parse(lane.ts);
  if (!Number.isFinite(age) || age > cfg.staleMs || age < -cfg.staleMs) return { borrow: 0, why: 'stale' };
  const active = num(lane.active_locks, NaN);
  const writes10 = num(lane.writes_10s, NaN);
  if (!Number.isFinite(active) || !Number.isFinite(writes10)) return { borrow: 0, why: 'bad_signal' };
  if (active > cfg.maxActiveLocks) return { borrow: 0, why: 'combo_busy' };
  const comboRps = Math.max(0, writes10) / 10;
  const room = reserved - cfg.safetyRps - comboRps * cfg.perComboWriteRps;
  const borrow = Math.max(0, Math.floor(room));
  return { borrow, why: borrow > 0 ? 'idle' : 'combo_writing', comboRps, active };
}

// Combo Locks side: publish the lane row. writeCount() = running total of Kalshi writes.
function startLanePublisher({ supabase, getActive, writeCount, intervalMs = 2000, log = () => {}, now = () => Date.now() }) {
  const hist = []; let failing = false;
  async function beat() {
    const t = now(); const w = Number(writeCount()) || 0;
    hist.push([t, w]); while (hist.length && hist[0][0] < t - 10000) hist.shift();
    const row = { app: 'combo_locks', ts: new Date(t).toISOString(), active_locks: Number(getActive()) || 0, writes_10s: Math.max(0, w - hist[0][1]) };
    try {
      const { error } = await supabase.from(LANE_TABLE).upsert(row, { onConflict: 'app' });
      if (error) throw new Error(error.message);
      if (failing) { failing = false; log('[LANE] publish recovered'); }
    } catch (e) { if (!failing) { failing = true; log(`[LANE] publish failed (sniper will not borrow): ${String(e.message).slice(0, 120)}`); } }
  }
  const id = setInterval(beat, intervalMs); if (id.unref) id.unref(); beat();
  return () => clearInterval(id);
}

// Sniper side: poll the lane row and retune the trade limiter to base + borrow.
function startBorrower({ supabase, limiter, baseRps, reserved, cfg, log = () => {}, now = () => Date.now() }) {
  let cooldownUntil = 0; let lane = null; let last = { borrow: 0, why: 'init' };
  async function tick() {
    try {
      const { data, error } = await supabase.from(LANE_TABLE).select('ts,active_locks,writes_10s').eq('app', 'combo_locks').maybeSingle();
      lane = error ? null : data;
    } catch (_) { lane = null; }
    apply();
  }
  function apply() {
    const r = computeBorrow({ lane, now: now(), reserved, cfg, cooldownUntil });
    limiter.setRate(baseRps + r.borrow);
    if (r.borrow !== last.borrow || r.why !== last.why) log(`[SNIPER] kalshi borrow ${last.borrow}->${r.borrow}/s (${r.why}) rate=${baseRps + r.borrow}/s`);
    last = r;
  }
  const id = setInterval(tick, cfg.pollMs); if (id.unref) id.unref(); tick();
  return {
    on429() { cooldownUntil = now() + cfg.cooldownMs; apply(); },
    state: () => ({ ...last, rate: baseRps + last.borrow, cooldownUntil }),
    stop: () => clearInterval(id),
  };
}

module.exports = { borrowConfig, computeBorrow, startLanePublisher, startBorrower, LANE_TABLE };
