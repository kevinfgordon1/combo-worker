// Paper market-making config. Off unless MM_PAPER=1.
// This module only reads env. It does not quote, subscribe, or touch
// Combo Locks quoting and the desk protect sweep are not touched.
'use strict';

const POLY_MAKER_REBATE = 0.0125;
const POLY_TAKER_FEE = 0.0695;
// Kalshi KXNFLGAME (kalshi.com/fee-schedule, captured 2026-09-02, multiplier 1):
// taker $0.07-$1.75 per 100 contracts => 0.07 * p * (1-p) per contract,
// maker $0.02-$0.44 per 100 => 0.0175 * p * (1-p). Both round UP to the cent.
const KALSHI_MAKER_COEFF = 0.0175;
const KALSHI_TAKER_COEFF = 0.07;

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

function pick(raw, allowed, fallback) {
  const v = raw == null ? '' : String(raw).trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

function numList(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback.slice();
  const out = String(raw).split(',')
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 24 * 3600);
  return out.length ? out : fallback.slice();
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
    kalshiMakerCoeff: num(env && env.MM_KALSHI_MAKER_COEFF, KALSHI_MAKER_COEFF, { min: 0, max: 1 }),
    kalshiTakerCoeff: num(env && env.MM_KALSHI_TAKER_COEFF, KALSHI_TAKER_COEFF, { min: 0, max: 1 }),
    polyMakerRebate: num(env && env.MM_POLY_MAKER_REBATE, POLY_MAKER_REBATE, { min: 0, max: 1 }),
    polyTakerFee: num(env && env.MM_POLY_TAKER_FEE, POLY_TAKER_FEE, { min: 0, max: 1 }),
    oddsMaxAgeMs: num(env && env.MM_ODDS_MAX_AGE_MS, 360000, { min: 1000, max: 24 * 3600 * 1000 }),
    pinnacleMaxDev: num(env && env.MM_PINNACLE_MAX_DEV, 0.03, { min: 0, max: 1 }),
    adverseCents: num(env && env.MM_ADVERSE_CENTS, 3, { min: 0, max: 50 }),
    stepCents: num(env && env.MM_STEP_CENTS, 1, { min: 1, max: 20 }),
    positionCap: num(env && env.MM_POSITION_CAP, 100, { min: 1, max: 100000 }),
    orderSize: num(env && env.MM_ORDER_SIZE, 10, { min: 1, max: 100000 }),
    dailyLossLimit,
    // Fill model. queue (default): a print strictly below our bid fills us;
    // a print at our bid must first eat the queue ahead (padded by queuePad)
    // and unknown queue never fills; only aggressor sells count. strict:
    // only strictly-below prints fill. legacy: the pre-2026-09-30 model.
    fillModel: pick(env && env.MM_FILL_MODEL, ['queue', 'strict', 'legacy'], 'queue'),
    queuePad: num(env && env.MM_QUEUE_PAD, 0.5, { min: 0, max: 10 }),
    fillLatencyMs: num(env && env.MM_FILL_LATENCY_MS, 1500, { min: 0, max: 600000 }),
    // Pair-completion timeout and exit (paper taker exit with fees).
    exitEnabled: !flagOff(env && env.MM_EXIT),
    pairTimeoutSec: num(env && env.MM_PAIR_TIMEOUT_SEC, 7200, { min: 5, max: 24 * 3600 }),
    exitBeforeKickoffSec: num(env && env.MM_EXIT_BEFORE_KICKOFF_SEC, 600, { min: 0, max: 24 * 3600 }),
    exitMode: pick(env && env.MM_EXIT_MODE, ['bid', 'mid'], 'bid'),
    exitCooldownSec: num(env && env.MM_EXIT_COOLDOWN_SEC, 600, { min: 0, max: 24 * 3600 }),
    // Per-game cap on unpaired inventory.
    maxUnpairedQty: num(env && env.MM_MAX_UNPAIRED_QTY, 20, { min: 1, max: 100000 }),
    maxUnpairedUsd: num(env && env.MM_MAX_UNPAIRED_USD, 12, { min: 1, max: 1000000 }),
    // Adverse-fill markout horizons (seconds) plus kickoff.
    markoutSec: numList(env && env.MM_MARKOUT_SEC, [10, 60, 300]),
    // Settlement from Kalshi market results.
    settleEnabled: !flagOff(env && env.MM_SETTLE),
    settlePollMs: num(env && env.MM_SETTLE_POLL_SEC, 300, { min: 10, max: 24 * 3600 }) * 1000,
    settleLookbackDays: num(env && env.MM_SETTLE_LOOKBACK_DAYS, 21, { min: 1, max: 365 }),
    settleAfterKickoffSec: num(env && env.MM_SETTLE_AFTER_KICKOFF_SEC, 7200, { min: 0, max: 7 * 24 * 3600 }),
    logPath: (env && env.MM_LOG_PATH && String(env.MM_LOG_PATH).trim()) || 'mm-paper.jsonl',
    pollMs: num(env && env.MM_POLL_MS, 4000, { min: 500, max: 120000 }),
    oddsPollMs: num(env && env.MM_ODDS_POLL_MS, 30000, { min: 1000, max: 30 * 60 * 1000 }),
    marketRefreshMs: num(env && env.MM_MARKET_REFRESH_MS, 60000, { min: 5000, max: 30 * 60 * 1000 }),
    maxGames: num(env && env.MM_MAX_GAMES, 40, { min: 1, max: 200 }),
    // Stop quoting this many seconds before scheduled kickoff. 0 quotes until
    // the kickoff instant, then stops. Unknown kickoff never quotes.
    kickoffBufferSec: num(env && env.MM_PAPER_KICKOFF_BUFFER_SEC, 60, { min: 0, max: 24 * 3600 }),
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
  KALSHI_MAKER_COEFF,
  KALSHI_TAKER_COEFF,
  paperEnabled,
  enabledLeagues,
  readConfig,
  flagOn,
  flagOff,
};
