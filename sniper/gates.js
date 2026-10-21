// Live-trading gates for the isolated sniper. ALL THREE must hold, otherwise the service is
// dry run and the trader refuses every mutating call (quote POST / confirm PUT / cancel DELETE):
//   SNIPER_ENABLED=1, SNIPER_DRY_RUN=0 (exactly "0"), SNIPER_LIVE_CONFIRM=<LIVE_CONFIRM_TOKEN>
// plus the sniper's own Kalshi key (SNIPER_KALSHI_KEY_ID / SNIPER_KALSHI_PRIVATE_KEY).
'use strict';
const LIVE_CONFIRM_TOKEN = 'I_UNDERSTAND_SNIPER_TRADES_REAL_MONEY';

function liveGate(env = process.env) {
  const why = [];
  if (String(env.SNIPER_ENABLED || '').trim() !== '1') why.push('SNIPER_ENABLED!=1');
  if (String(env.SNIPER_DRY_RUN == null ? '' : env.SNIPER_DRY_RUN).trim() !== '0') why.push('SNIPER_DRY_RUN!=0');
  if (String(env.SNIPER_LIVE_CONFIRM || '') !== LIVE_CONFIRM_TOKEN) why.push('SNIPER_LIVE_CONFIRM_missing_or_wrong');
  if (!env.SNIPER_KALSHI_KEY_ID || !env.SNIPER_KALSHI_PRIVATE_KEY) why.push('SNIPER_KALSHI_KEY_missing');
  return { live: why.length === 0, why };
}

module.exports = { liveGate, LIVE_CONFIRM_TOKEN };
