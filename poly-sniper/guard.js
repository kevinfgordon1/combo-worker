// Polymarket combo sniper guard.
// Phase 1 (Kevin Oct 23) was dry run only. Phase 2 (Kevin Oct 29, preview) adds a live mode, but the
// dry run stays the hard fallback and is enforced in code, not just config:
//   1. createPolySniper refuses to start unless POLY_SNIPER_DRY_RUN is exactly '1' (dry) or '0' (live-capable).
//      Unset or anything else = refuse to start (never guess).
//   2. POLY_SNIPER_DRY_RUN=1: the module is NEVER handed a Polymarket HTTP client / key, exactly like
//      Phase 1. It only receives RFQ payloads poly-worker already read. assertNoTradingClient() throws if
//      anything that looks like a trading client is passed in, and attachTrading() refuses.
//   3. POLY_SNIPER_DRY_RUN=0 only makes live POSSIBLE. Nothing is posted until the runtime switch
//      (public.poly_sniper_control.live, default false) is turned on. See poly-sniper/live.js.
'use strict';
const TRADING_METHODS = ['createQuote', 'confirmQuote', 'deleteQuote', 'acceptQuote', 'insertOrder', 'request'];

function dryRunValue(env = process.env) {
  return String(env.POLY_SNIPER_DRY_RUN == null ? '' : env.POLY_SNIPER_DRY_RUN).trim();
}
// True = hard dry run. Only an explicit '0' turns it off.
function dryRunOn(env = process.env) {
  return dryRunValue(env) !== '0';
}
function enabled(env = process.env) {
  return String(env.POLY_SNIPER_ENABLED == null ? '' : env.POLY_SNIPER_ENABLED).trim() === '1';
}
function liveCapable(env = process.env) {
  return enabled(env) && dryRunValue(env) === '0';
}
function assertValidMode(env = process.env) {
  const v = dryRunValue(env);
  if (v !== '1' && v !== '0') throw new Error(`POLY_SNIPER_DRY_RUN must be exactly 1 (dry run) or 0 (live-capable, switch default off); got "${v}"`);
  return v === '1' ? 'dry' : 'live_capable';
}
function assertNoTradingClient(deps) {
  for (const [name, v] of Object.entries(deps || {})) {
    if (!v || (typeof v !== 'object' && typeof v !== 'function')) continue;
    for (const m of TRADING_METHODS) {
      if (typeof v[m] === 'function') throw new Error(`poly-sniper dry run: dependency "${name}" exposes ${m}() — trading clients are not allowed`);
    }
  }
}
module.exports = { dryRunOn, enabled, liveCapable, assertValidMode, assertNoTradingClient, TRADING_METHODS };
