// Combo Locks tester "Amount to keep for combos" (percentage of total Kalshi cash).
// Pure; shared by tester-funder.js (target) and live-users.js (0% = no trading).
'use strict';

const DEFAULT_KEEP_PCT = 90;

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Pure: the tester's "Amount to keep for combos" setting.
//   { mode: 'pct', pct } | { mode: 'usd', usd } (legacy dollar cap) | { mode: 'off' }
// blank pct (and no legacy dollars) = DEFAULT_KEEP_PCT; 0% / $0 = off.
function keepSetting(settings) {
  const pct = numOrNull(settings && settings.autofund_pct);
  if (pct != null) {
    const p = Math.min(100, Math.max(0, pct));
    return p > 0 ? { mode: 'pct', pct: p } : { mode: 'off' };
  }
  const usd = numOrNull(settings && settings.autofund_cap_usd);
  if (usd != null) return usd > 0 ? { mode: 'usd', usd } : { mode: 'off' };
  return { mode: 'pct', pct: DEFAULT_KEEP_PCT, defaulted: true };
}

// Pure: target Combos cash in cents. totalCents = Default + Combos available.
// Never more than exists; never above dailyCapCents when given.
function targetCents(keep, totalCents, dailyCapCents = null) {
  if (!keep || keep.mode === 'off') return null;
  const total = Math.max(0, Math.floor(Number(totalCents) || 0));
  let t = keep.mode === 'pct' ? Math.floor((total * keep.pct) / 100) : Math.round(keep.usd * 100);
  t = Math.min(t, total);
  if (dailyCapCents != null) t = Math.min(t, dailyCapCents);
  return Math.max(0, t);
}

module.exports = { DEFAULT_KEEP_PCT, keepSetting, targetCents };
