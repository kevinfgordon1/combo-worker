// Paper market-making config. Off unless MM_PAPER=1.
// This module only reads env. It does not quote, subscribe, or touch
// Combo Locks quoting and the desk protect sweep are not touched.
'use strict';

const POLY_MAKER_REBATE = 0.0125;
const POLY_TAKER_FEE = 0.0695;

function flagOn(raw) {
  if (raw == null || String(raw).trim() === '') return false;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function flagOff(raw) {
  if (raw == null || String(raw).trim() === '') return false;
  return /^(0|false|no|off)$/i.test(String(raw).trim());
}

function paperEnabled(env = process.env) {
  return flagOn(env && env.MM_PAPER);
}

function num(raw, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function enabledLeagues(env = process.env) {
  const raw = env && env.MM_LEAGUES;
  const src = raw == null || String(raw).trim() === '' ? 'nfl' : String(raw);
  const out = new Set();
  for (const part of src.split(',')) {
    const s = part.trim().toLowerCase();
    if (s === 'nfl') out.add('nfl');
    else if (s === 'mlb') out.add('mlb');
    else if (s === 'cfb' || s === 'ncaaf' || s === 'college' || s === 'ncaafb') out.add('ncaaf');
  }
  if (!out.size) out.add('nfl');
  return out;
}

function readConfig(env = process.env) {
  const lossRaw = env && env.MM_DAILY_LOSS_LIMIT;
  const lossBlank = lossRaw == null || String(lossRaw).trim() === '';
  const dailyLossLimit = lossBlank ? null : num(lossRaw, null, { min: 0 });
  return {
    enabled: paperEnabled(env),
    leagues: enabledLeagues(env),
    kalshiMakerCoeff: num(env && env.MM_KALSHI_MAKER_COEFF, 0, { min: 0, max: 1 }),
    polyMakerRebate: num(env && env.MM_POLY_MAKER_REBATE, POLY_MAKER_REBATE, { min: 0, max: 1 }),
    polyTakerFee: num(env && env.MM_POLY_TAKER_FEE, POLY_TAKER_FEE, { min: 0, max: 1 }),
    oddsMaxAgeMs: num(env && env.MM_ODDS_MAX_AGE_MS, 360000, { min: 1000, max: 24 * 3600 * 1000 }),
    pinnacleMaxDev: num(env && env.MM_PINNACLE_MAX_DEV, 0.03, { min: 0, max: 1 }),
    adverseCents: num(env && env.MM_ADVERSE_CENTS, 3, { min: 0, max: 50 }),
    stepCents: num(env && env.MM_STEP_CENTS, 1, { min: 1, max: 20 }),
    positionCap: num(env && env.MM_POSITION_CAP, 100, { min: 1, max: 100000 }),
    orderSize: num(env && env.MM_ORDER_SIZE, 10, { min: 1, max: 100000 }),
    dailyLossLimit,
    logPath: (env && env.MM_LOG_PATH && String(env.MM_LOG_PATH).trim()) || 'mm-paper.jsonl',
    pollMs: num(env && env.MM_POLL_MS, 4000, { min: 500, max: 120000 }),
    oddsPollMs: num(env && env.MM_ODDS_POLL_MS, 30000, { min: 1000, max: 30 * 60 * 1000 }),
    marketRefreshMs: num(env && env.MM_MARKET_REFRESH_MS, 60000, { min: 5000, max: 30 * 60 * 1000 }),
    maxGames: num(env && env.MM_MAX_GAMES, 40, { min: 1, max: 200 }),
    // Supabase tape is optional. Default on only when the project URL + service
    // key are already set. MM_SUPABASE=0 disables even then. A missing table
    // must not stop the JSONL log (see mm-paper-log.js).
    supabase: flagOff(env && env.MM_SUPABASE)
      ? false
      : !!(env && env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY),
    // Markets WS is a different socket from Combo Locks' private RFQ WS.
    polyWs: !flagOff(env && env.MM_POLY_WS),
    // Never open a Kalshi WS from this module. A second socket on the Combo
    // Locks API key unsubscribes the communications channel.
    kalshiWs: false,
  };
}

module.exports = {
  POLY_MAKER_REBATE,
  POLY_TAKER_FEE,
  paperEnabled,
  enabledLeagues,
  readConfig,
  flagOn,
  flagOff,
};
