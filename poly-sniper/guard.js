// Polymarket combo sniper — DRY RUN guard (Phase 1, Kevin Oct 23).
// The dry run is enforced in code, not just config:
//   1. createPolySniper refuses to start unless POLY_SNIPER_DRY_RUN=1 exactly.
//   2. The module is NEVER handed a Polymarket HTTP client / key. It only receives RFQ
//      payloads that poly-worker already read, so it has nothing that could create,
//      replace, confirm or delete a quote.
//   3. assertNoTradingClient() throws if anything that looks like a trading client is
//      passed in (createQuote / confirmQuote / deleteQuote / request).
'use strict';
const TRADING_METHODS = ['createQuote', 'confirmQuote', 'deleteQuote', 'acceptQuote', 'insertOrder', 'request'];

function dryRunOn(env = process.env) {
  return String(env.POLY_SNIPER_DRY_RUN == null ? '' : env.POLY_SNIPER_DRY_RUN).trim() === '1';
}
function enabled(env = process.env) {
  return String(env.POLY_SNIPER_ENABLED == null ? '' : env.POLY_SNIPER_ENABLED).trim() === '1';
}
function assertNoTradingClient(deps) {
  for (const [name, v] of Object.entries(deps || {})) {
    if (!v || (typeof v !== 'object' && typeof v !== 'function')) continue;
    for (const m of TRADING_METHODS) {
      if (typeof v[m] === 'function') throw new Error(`poly-sniper dry run: dependency "${name}" exposes ${m}() — trading clients are not allowed`);
    }
  }
}
module.exports = { dryRunOn, enabled, assertNoTradingClient, TRADING_METHODS };
