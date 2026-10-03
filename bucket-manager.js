// Combo-bucket preallocation for Kalshi exchange shard 1.
//
// Combos clear on shard 1 (the Combo Locks bucket). Main cash stays on
// shard 0. Kalshi checks collateral inside that matching engine, so the
// bucket has to be funded before quotes are accepted. This module reads
// both shards and, when enabled, moves cash with
// POST /trade-api/v2/portfolio/intra_exchange_instance_transfer.
//
// Amount unit is centicents (1 USD = 10_000), not dollars and not cents.
// https://docs.kalshi.com/api-reference/portfolio/intra-account-transfer
// OpenAPI IntraExchangeInstanceTransferRequest.amount:
//   "The amount to transfer in centicents"
// Available balance from GET /portfolio/balance is integer cents, with
// balance_dollars as the exact fixed-point string. portfolio_value is
// integer cents on the requested exchange_index.
// https://docs.kalshi.com/api-reference/portfolio/get-balance
// The ceiling is measured on shard 1 available cash only. Open-position value
// (portfolio_value) is shown in status/alerts but does not count toward it, so
// locked positions never block a top-up.
//
// KALSHI_BUCKET_AUTO defaults to off: log the decision, do not POST.
// KALSHI_BUCKET_SWEEP defaults to off.
//
// In-app alerts (app-alerts.js -> public.app_alerts, shown to Kevin on
// aibetbuilder, not Telegram): every transfer performed / failed /
// unconfirmed, every blocked top-up (floor, daily cap, ceiling), shard 1
// cash below COMBO_LOW_CASH_ALERT_USD (default $1,000), and a Kalshi
// insufficient-funds skip. Low cash and blocked alerts are de-duplicated:
// one unresolved row per condition until it clears.
//
// Schedule (America/New_York, DST-aware). A window is { start, end }
// with dow 0=Sunday .. 6=Saturday and time "HH:MM". The end minute is
// included. A window that wraps the week (Friday through Monday) has
// start > end.
//   Friday 12:00 through Monday 23:59 (Friday playoff + college locks, weekend)
//   Thursday 12:00 through Friday 03:00 (NFL Thursday night)
'use strict';

const { createPolymarketHttp } = require('./polymarket-client');

const TRANSFER_PATH = '/trade-api/v2/portfolio/intra_exchange_instance_transfer';
// Kalshi's own record of each transfer (newest first): transfer_id, status,
// amount (dollars string), source/destination_exchange_shard.
const TRANSFERS_PATH = '/trade-api/v2/portfolio/intra_exchange_instance_transfers';
const BALANCE_PATH = '/trade-api/v2/portfolio/balance';
const POSITIONS_PATH = '/trade-api/v2/portfolio/positions';
const ORDERS_PATH = '/trade-api/v2/portfolio/orders';

// https://docs.kalshi.com/api-reference/portfolio/intra-account-transfer
const CENTICENTS_PER_DOLLAR = 10_000;
const CENTICENTS_PER_CENT = 100;
const MAIN_SHARD = 0;
const BUCKET_SHARD = 1;
const VENUE_ALERT_MS = 10 * 60 * 1000;
const LOW_REPEAT_MS = 60 * 60 * 1000;
// Top-up blocked (main floor, daily cap, or ceiling): at most once per hour
// per block reason. A different reason alerts on the next check.
const BLOCKED_ALERT_MS = 60 * 60 * 1000;
const INSUFFICIENT_IN_APP_MS = 5 * 60 * 1000;
const CHECK_COALESCE_MS = 15_000;
// A rejected quote's cost keeps lifting the top-up target for this long.
const NEED_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SETTLE_MS = 180_000;
// Pause between the transfer POST and the first confirm, so the first read is
// not the (known to lag) immediate balance re-read.
const DEFAULT_CONFIRM_DELAY_MS = 2_000;
const DEFAULT_ERROR_COOLDOWN_MS = 60_000;
const UNCONFIRMED_COOLDOWN_MS = 5 * 60 * 1000;
// A transfer Kalshi has no record of (and no balance trace) after this long
// is treated as never having happened and the hold is released.
const PENDING_MAX_MS = 30 * 60 * 1000;

const DOW = Object.freeze({
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
});

const DEFAULT_GAMEDAY_WINDOWS = Object.freeze([
  { id: 'weekend', start: { dow: 5, time: '12:00' }, end: { dow: 1, time: '23:59' } },
  { id: 'thursday-night', start: { dow: 4, time: '12:00' }, end: { dow: 5, time: '03:00' } },
]);

function floorCents(dollars) {
  if (typeof dollars !== 'number' || !Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.floor(dollars * 100 + 1e-6);
}

function signedCents(dollars) {
  if (typeof dollars !== 'number' || !Number.isFinite(dollars)) return null;
  return Math.floor(dollars * 100 + 1e-6);
}

// Floor to the cent, then convert. Sub-cent centicents are never sent.
function dollarsToCenticents(dollars) {
  return floorCents(dollars) * CENTICENTS_PER_CENT;
}

function centsToCenticents(cents) {
  const n = Math.trunc(Number(cents));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n * CENTICENTS_PER_CENT;
}

function formatDollarsFromCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return '$0.00';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(n));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}$${whole.toLocaleString('en-US')}.${String(frac).padStart(2, '0')}`;
}

function shardLabel(index) {
  if (Number(index) === MAIN_SHARD) return 'shard 0 (main)';
  if (Number(index) === BUCKET_SHARD) return 'shard 1 (combo)';
  return `shard ${index}`;
}

function envOn(env, name) {
  const v = String(env && env[name] != null ? env[name] : '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function envDollarsToCents(env, name, fallbackDollars) {
  const raw = env && env[name];
  const n = raw == null || raw === '' ? fallbackDollars : Number(raw);
  const use = Number.isFinite(n) && n >= 0 ? n : fallbackDollars;
  return Math.round(use * 100);
}

function envPositiveInt(env, name, fallback, min) {
  const raw = env && env[name];
  const n = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function pointToMinute(point) {
  if (!point) return null;
  const dow = Number(point.dow);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(point.time || ''));
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return dow * 1440 + hour * 60 + minute;
}

function compileWindows(list) {
  const out = [];
  for (const w of list) {
    const start = pointToMinute(w && w.start);
    const end = pointToMinute(w && w.end);
    if (start == null || end == null) return null;
    out.push({ id: (w && w.id) || '', start, end });
  }
  return out;
}

function loadGamedayWindows(env) {
  const raw = env && env.KALSHI_BUCKET_SCHEDULE;
  if (raw == null || String(raw).trim() === '') {
    return { windows: compileWindows(DEFAULT_GAMEDAY_WINDOWS), scheduleError: null };
  }
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed) || !parsed.length) {
      return { windows: compileWindows(DEFAULT_GAMEDAY_WINDOWS), scheduleError: 'schedule must be a non-empty JSON list' };
    }
    const windows = compileWindows(parsed);
    if (!windows) {
      return { windows: compileWindows(DEFAULT_GAMEDAY_WINDOWS), scheduleError: 'schedule entry needs start/end {dow, time}' };
    }
    return { windows, scheduleError: null };
  } catch (e) {
    return {
      windows: compileWindows(DEFAULT_GAMEDAY_WINDOWS),
      scheduleError: `schedule JSON: ${e && e.message ? e.message : e}`,
    };
  }
}

function loadBucketConfig(env = process.env) {
  const schedule = loadGamedayWindows(env || {});
  return {
    auto: envOn(env, 'KALSHI_BUCKET_AUTO'),
    sweep: envOn(env, 'KALSHI_BUCKET_SWEEP'),
    ceilingCents: envDollarsToCents(env, 'KALSHI_BUCKET_CEILING', 22_000),
    floorCents: envDollarsToCents(env, 'KALSHI_MAIN_FLOOR', 2_000),
    maxTransferCents: envDollarsToCents(env, 'KALSHI_BUCKET_MAX_TRANSFER', 10_000),
    dailyCapCents: envDollarsToCents(env, 'KALSHI_BUCKET_DAILY_CAP', 15_000),
    minTransferCents: envDollarsToCents(env, 'KALSHI_BUCKET_MIN_TRANSFER', 100),
    // Extra cash kept above a rejected quote's cost when topping up after an insufficient_balance.
    insufficientBufferCents: envDollarsToCents(env, 'KALSHI_BUCKET_INSUFFICIENT_BUFFER', 500),
    targetGamedayCents: envDollarsToCents(env, 'KALSHI_BUCKET_TARGET_GAMEDAY', 12_000),
    targetDefaultCents: envDollarsToCents(env, 'KALSHI_BUCKET_TARGET_DEFAULT', 8_000),
    lowAlertCents: envDollarsToCents(env, 'KALSHI_BUCKET_LOW_ALERT', 1_500),
    comboLowCashCents: envDollarsToCents(env, 'COMBO_LOW_CASH_ALERT_USD', 1_000),
    polyLowAlertCents: envDollarsToCents(env, 'POLY_LOW_ALERT', 1_500),
    intervalMin: envPositiveInt(env, 'KALSHI_BUCKET_INTERVAL_MIN', 5, 1),
    settleMs: envPositiveInt(env, 'KALSHI_BUCKET_SETTLE_MS', DEFAULT_SETTLE_MS, 0),
    confirmDelayMs: envPositiveInt(env, 'KALSHI_BUCKET_CONFIRM_DELAY_MS', DEFAULT_CONFIRM_DELAY_MS, 0),
    errorCooldownMs: envPositiveInt(env, 'KALSHI_BUCKET_ERROR_COOLDOWN_MS', DEFAULT_ERROR_COOLDOWN_MS, 0),
    windows: schedule.windows,
    scheduleError: schedule.scheduleError,
  };
}

function etParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const minute = Number(parts.minute);
  const dow = DOW[parts.weekday];
  if (!Number.isInteger(dow) || !Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return {
    dow,
    hour,
    minute,
    weekMinute: dow * 1440 + hour * 60 + minute,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function inWindow(weekMinute, start, end) {
  if (start <= end) return weekMinute >= start && weekMinute <= end;
  return weekMinute >= start || weekMinute <= end;
}

function isGameday(date, windows) {
  const parts = etParts(date instanceof Date ? date : new Date(date));
  if (!parts) return false;
  const list = windows || compileWindows(DEFAULT_GAMEDAY_WINDOWS);
  return list.some((w) => inWindow(parts.weekMinute, w.start, w.end));
}

function etDateKey(date) {
  const parts = etParts(date instanceof Date ? date : new Date(date));
  return parts ? parts.dateKey : '';
}

// Pure decision. Amounts are integer cents. One of:
//   topup | sweep | blocked | hold
function planBucketAction({
  mainAvailableCents,
  bucketAvailableCents,
  bucketPortfolioCents,
  gameday,
  sweepEnabled,
  flat,
  dailyTopupCents,
  needCents,
  config,
}) {
  const baseTargetCents = gameday ? config.targetGamedayCents : config.targetDefaultCents;
  // A recently rejected quote (insufficient_balance) lifts the target to its
  // cost plus the buffer. Every limit below (floor, ceiling, daily cap,
  // per-transfer cap, minimum) still applies to the resulting amount.
  const needTargetCents = needCents > 0
    ? Math.floor(needCents) + (config.insufficientBufferCents || 0)
    : 0;
  const targetCents = Math.max(baseTargetCents, needTargetCents);
  const totalCents = bucketAvailableCents + (bucketPortfolioCents || 0);
  const gap = targetCents - bucketAvailableCents;
  const base = {
    targetCents,
    needTargetCents,
    gameday: !!gameday,
    totalCents,
    gapCents: gap,
  };

  if (gap > 0) {
    // Ceiling on available cash only (open positions do not count).
    const headroom = config.ceilingCents - bucketAvailableCents;
    const spare = mainAvailableCents - config.floorCents;
    const dailyLeft = config.dailyCapCents - (dailyTopupCents || 0);
    let amount = gap;
    let clamp = null;
    const apply = (limit, name) => {
      if (limit < amount) {
        amount = Math.max(0, Math.floor(limit));
        clamp = name;
      }
    };
    apply(headroom, 'ceiling');
    apply(spare, 'floor');
    apply(dailyLeft, 'daily_cap');
    apply(config.maxTransferCents, 'max_transfer');
    amount = Math.max(0, Math.floor(amount));
    if (amount < config.minTransferCents) {
      let block = null;
      if (gap >= config.minTransferCents) {
        if (spare < config.minTransferCents) block = 'floor';
        else if (dailyLeft < config.minTransferCents) block = 'daily_cap';
        else if (headroom < config.minTransferCents) block = 'ceiling';
      }
      return {
        ...base,
        action: block ? 'blocked' : 'hold',
        block,
        clamp,
        amountCents: 0,
        reason: block || 'min_transfer',
        headroomCents: headroom,
        spareCents: spare,
        dailyLeftCents: dailyLeft,
      };
    }
    return {
      ...base,
      action: 'topup',
      block: null,
      clamp,
      amountCents: amount,
      fromShard: MAIN_SHARD,
      toShard: BUCKET_SHARD,
      reason: clamp ? `top-up clamped by ${clamp}` : 'top-up',
      headroomCents: headroom,
      spareCents: spare,
      dailyLeftCents: dailyLeft,
    };
  }

  const excess = bucketAvailableCents - targetCents;
  if (!sweepEnabled || excess < config.minTransferCents) {
    return { ...base, action: 'hold', block: null, amountCents: 0, reason: 'hold' };
  }
  if (gameday) {
    return { ...base, action: 'hold', block: null, amountCents: 0, reason: 'sweep_gameday' };
  }
  if (!flat || flat.uncertain) {
    return { ...base, action: 'hold', block: null, amountCents: 0, reason: 'sweep_flat_unknown' };
  }
  if (flat.openPositions) {
    return { ...base, action: 'hold', block: null, amountCents: 0, reason: 'sweep_open_positions' };
  }
  if (flat.restingOrders) {
    return { ...base, action: 'hold', block: null, amountCents: 0, reason: 'sweep_resting_orders' };
  }
  let amount = excess;
  let clamp = null;
  if (config.maxTransferCents < amount) {
    amount = config.maxTransferCents;
    clamp = 'max_transfer';
  }
  amount = Math.max(0, Math.floor(amount));
  if (amount < config.minTransferCents) {
    return { ...base, action: 'hold', block: null, amountCents: 0, reason: 'min_transfer' };
  }
  return {
    ...base,
    action: 'sweep',
    block: null,
    clamp,
    amountCents: amount,
    fromShard: BUCKET_SHARD,
    toShard: MAIN_SHARD,
    reason: clamp ? 'sweep clamped by max_transfer' : 'sweep',
  };
}

function parseShardBalance(json) {
  const body = json || {};
  let availableCents = null;
  if (body.balance_dollars != null && body.balance_dollars !== '') {
    availableCents = signedCents(Number(body.balance_dollars));
  }
  if (availableCents == null && body.balance != null && body.balance !== '') {
    const n = Number(body.balance);
    if (Number.isFinite(n)) availableCents = Math.trunc(n);
  }
  if (availableCents == null) {
    throw new Error('Kalshi balance response missing balance');
  }
  let portfolioCents = 0;
  if (body.portfolio_value_dollars != null && body.portfolio_value_dollars !== '') {
    const n = signedCents(Number(body.portfolio_value_dollars));
    if (n != null) portfolioCents = n;
  } else if (body.portfolio_value != null && body.portfolio_value !== '') {
    const n = Number(body.portfolio_value);
    if (Number.isFinite(n)) portfolioCents = Math.trunc(n);
  }
  return { availableCents, portfolioCents };
}

function usdCashFromBalances(json) {
  if (!json || typeof json !== 'object') return null;
  const list = Array.isArray(json.balances)
    ? json.balances
    : (json.currentBalance != null ? [json] : []);
  if (!list.length) return null;
  const usd = list.find((row) => String((row && row.currency) || 'USD').toUpperCase() === 'USD') || list[0];
  if (!usd || usd.currentBalance == null || usd.currentBalance === '') return null;
  const n = Number(usd.currentBalance);
  return Number.isFinite(n) ? n : null;
}

function isOpenPosition(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.position_fp != null && row.position_fp !== '') {
    const n = Number(row.position_fp);
    if (Number.isFinite(n)) return n !== 0;
  }
  const n = Number(row.position);
  return Number.isFinite(n) && n !== 0;
}

function isRestingOrder(row) {
  if (!row || typeof row !== 'object') return false;
  const status = String(row.status || 'resting').toLowerCase();
  return status === 'resting';
}

function orderOnShard(row, shard) {
  if (!row || typeof row !== 'object') return false;
  const idx = row.exchange_index != null ? row.exchange_index : row.exchange_shard;
  if (idx == null || idx === '') return true;
  return Number(idx) === Number(shard);
}

const TRANSFER_DONE = new Set(['complete', 'completed', 'success', 'succeeded', 'settled']);
const TRANSFER_BAD = new Set(['failed', 'failure', 'rejected', 'cancelled', 'canceled', 'error', 'reversed']);

function transferStatusClass(status) {
  const v = String(status == null ? '' : status).trim().toLowerCase();
  if (TRANSFER_DONE.has(v)) return 'complete';
  if (TRANSFER_BAD.has(v)) return 'failed';
  return 'processing';
}

function parseTransfers(json) {
  const rows = json && Array.isArray(json.transfers) ? json.transfers : [];
  return rows.map((r) => {
    const amount = Number(r && r.amount);
    return {
      transferId: (r && (r.transfer_id || r.transferId)) || null,
      status: r && r.status != null ? String(r.status) : '',
      amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
      fromShard: r && r.source_exchange_shard != null ? Number(r.source_exchange_shard) : null,
      toShard: r && r.destination_exchange_shard != null ? Number(r.destination_exchange_shard) : null,
    };
  }).filter((r) => r.transferId);
}

function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

async function kalshiCall(signed, method, signPath, { query, body } = {}) {
  let qs = '';
  if (query && Object.keys(query).length) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === '') continue;
      usp.set(k, String(v));
    }
    const s = usp.toString();
    if (s) qs = `?${s}`;
  }
  const res = await signed(method, signPath, {
    path: `${signPath}${qs}`,
    headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const status = res && res.statusCode;
  const json = parseJson(res && res.text);
  if (!(status >= 200 && status < 300)) {
    const msg = (json && (json.message || (json.error && (json.error.message || json.error.code))))
      || (res && res.text)
      || '';
    const err = new Error(`Kalshi ${method} ${signPath} ${status} ${String(msg).slice(0, 300)}`);
    err.statusCode = status;
    throw err;
  }
  return json || {};
}

function createKalshiBucketClient(signed) {
  if (typeof signed !== 'function') throw new Error('signed request function required');

  async function getShard(index) {
    const json = await kalshiCall(signed, 'GET', BALANCE_PATH, {
      query: { exchange_index: String(index) },
    });
    return parseShardBalance(json);
  }

  async function transfer({ amountCenticents, fromShard, toShard }) {
    const amount = Math.trunc(Number(amountCenticents));
    if (!Number.isFinite(amount) || amount <= 0 || amount % CENTICENTS_PER_CENT !== 0) {
      throw new Error('transfer amount must be a positive whole-cent count of centicents');
    }
    // Both legs are event-contract instances. Shard 0 is main cash and
    // shard 1 is the combo bucket. Same-instance subaccount moves are a
    // different call; this one crosses exchange shards.
    const body = {
      source: 'event_contract',
      destination: 'event_contract',
      amount,
      source_exchange_shard: fromShard,
      destination_exchange_shard: toShard,
    };
    const json = await kalshiCall(signed, 'POST', TRANSFER_PATH, { body });
    return { transferId: (json && (json.transfer_id || json.transferId)) || null };
  }

  async function pagePositions(shard) {
    let cursor = '';
    for (let i = 0; i < 5; i++) {
      const query = {
        exchange_index: String(shard),
        count_filter: 'position',
        limit: '200',
      };
      if (cursor) query.cursor = cursor;
      const json = await kalshiCall(signed, 'GET', POSITIONS_PATH, { query });
      const rows = [].concat(json.market_positions || [], json.event_positions || []);
      if (rows.some(isOpenPosition)) return { openPositions: true, uncertain: false };
      if (!json.cursor || !rows.length) return { openPositions: false, uncertain: false };
      cursor = json.cursor;
    }
    return { openPositions: false, uncertain: true };
  }

  async function pageOrders(shard, query) {
    let cursor = '';
    for (let i = 0; i < 5; i++) {
      const q = { ...query };
      if (cursor) q.cursor = cursor;
      const json = await kalshiCall(signed, 'GET', ORDERS_PATH, { query: q });
      const rows = (json.orders || []).filter((row) => isRestingOrder(row) && orderOnShard(row, shard));
      if (rows.length) return { restingOrders: true, uncertain: false };
      if (!json.cursor || !(json.orders || []).length) return { restingOrders: false, uncertain: false };
      cursor = json.cursor;
    }
    return { restingOrders: false, uncertain: true };
  }

  async function shardActivity(shard) {
    const positions = await pagePositions(shard);
    let orders;
    try {
      orders = await pageOrders(shard, {
        status: 'resting',
        limit: '200',
        exchange_index: String(shard),
      });
    } catch (e) {
      // Some order listings reject exchange_index. One retry without it,
      // then keep only rows that are unscoped or on this shard.
      if (e && e.statusCode === 400) {
        orders = await pageOrders(shard, { status: 'resting', limit: '200' });
      } else {
        throw e;
      }
    }
    return {
      openPositions: positions.openPositions,
      restingOrders: orders.restingOrders,
      uncertain: !!(positions.uncertain || orders.uncertain),
    };
  }

  // Kalshi's transfer records, newest first. Definitive for "did it land".
  async function getTransfers() {
    const json = await kalshiCall(signed, 'GET', TRANSFERS_PATH, { query: { limit: '50' } });
    return parseTransfers(json);
  }

  return { getShard, transfer, getTransfers, shardActivity };
}

async function readPolyCashFromHttp(http) {
  const res = await http.request('GET', '/v1/account/balances');
  if (!res || res.statusCode < 200 || res.statusCode >= 300) {
    const err = new Error(`Polymarket GET /v1/account/balances ${res && res.statusCode}`);
    err.statusCode = res && res.statusCode;
    throw err;
  }
  return usdCashFromBalances(res.json);
}

function polyReaderFromEnv(env, factory = createPolymarketHttp) {
  const keyId = env && env.POLYMARKET_KEY_ID;
  const secretKey = env && env.POLYMARKET_SECRET_KEY;
  if (!keyId || !secretKey) return null;
  let http = null;
  return function readPolyCash() {
    if (!http) http = factory({ keyId, secretKey });
    return readPolyCashFromHttp(http);
  };
}

function createBucketManager({
  env = process.env,
  now = () => new Date(),
  alert = async () => {},
  log = (...args) => console.log(...args),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  client = null,
  signed = null,
  readPolyCash,
  appAlerts = null,
  config: configOverride = null,
} = {}) {
  const config = configOverride || loadBucketConfig(env);
  const kalshi = client || (signed ? createKalshiBucketClient(signed) : null);
  const readPoly = readPolyCash === undefined ? polyReaderFromEnv(env) : readPolyCash;
  const venueAlertAt = new Map();
  let lowAt = 0;
  let polyLowAt = 0;
  let lowClear = true;
  let polyLowClear = true;
  let daily = { day: '', cents: 0 };
  let pending = null;
  let cooldownUntil = 0;
  let lastCheckAt = 0;
  let needCents = 0;
  let needAt = 0;
  let lastNeedUsed = 0;
  let inflight = null;
  let timer = null;
  let balanceErrorAt = 0;
  let polyErrorAt = 0;
  let loggedPolySkip = false;
  const blockedAlertAt = new Map();
  let lastBucketCents = null;
  let seenBucketThisRun = null;
  // null = unknown since start (resolve once on the first healthy read).
  let comboLowOpen = null;
  let blockedOpen = null;
  let insufficientInAppAt = 0;

  if (config.scheduleError) {
    log(`[BUCKET] ${config.scheduleError} — using the default game-day list`);
  }

  function clock() {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  }

  function dailySpent(date) {
    const day = etDateKey(date);
    if (daily.day !== day) daily = { day, cents: 0 };
    return daily.cents;
  }

  function addDaily(date, cents) {
    dailySpent(date);
    daily.cents += cents;
  }

  async function emit(text) {
    try {
      await alert(text);
    } catch (e) {
      log(`[BUCKET] alert failed ${e && e.message ? e.message : e}`);
    }
  }

  // Kevin asked for in-app alerts, not Telegram, for routine bucket activity:
  // a completed transfer and a blocked top-up. With the in-app writer wired
  // those are log-only on Telegram unless KALSHI_BUCKET_TELEGRAM=1. Failures,
  // unconfirmed transfers, balance-read errors, low-cash and INSUFFICIENT
  // BALANCE keep their existing Telegram alerts (plus an in-app row).
  const bucketTelegram = !(appAlerts && appAlerts.enabled) || envOn(env, 'KALSHI_BUCKET_TELEGRAM');
  async function emitBucket(text) {
    if (bucketTelegram) return emit(text);
    log(`[BUCKET] ALERT (in-app only): ${String(text).replace(/\n/g, ' | ')}`);
    return undefined;
  }

  // In-app alert for Kevin (app_alerts). Never throws, never blocks trading.
  async function inApp(spec) {
    if (!appAlerts || typeof appAlerts.raise !== 'function') return false;
    try {
      return await appAlerts.raise(spec);
    } catch (e) {
      log(`[BUCKET] in-app alert failed ${e && e.message ? e.message : e}`);
      return false;
    }
  }

  async function inAppResolve(keys, opts) {
    if (!appAlerts || typeof appAlerts.resolve !== 'function') return false;
    try {
      return await appAlerts.resolve(keys, opts);
    } catch (e) {
      log(`[BUCKET] in-app resolve failed ${e && e.message ? e.message : e}`);
      return false;
    }
  }

  function transferText(decision) {
    return `${formatDollarsFromCents(decision.amountCents)} ` +
      `${shardLabel(decision.fromShard)} → ${shardLabel(decision.toShard)}`;
  }

  async function reportTransferFailed(decision, transferId, why) {
    log(`[BUCKET] transfer ${transferId || '?'} failed ${why}`);
    await inApp({
      kind: 'bucket_transfer_failed',
      severity: 'error',
      title: 'Kalshi bucket transfer failed',
      body: `${transferText(decision)} (transfer_id ${transferId || '?'}) did not complete: ${why}. ` +
        `No further automatic transfer for a few minutes.`,
      meta: { transferId: transferId || null, amountCents: decision.amountCents, reason: decision.reason },
    });
    await emit(
      `Kalshi bucket transfer failed\n` +
      `${transferText(decision)}\n` +
      `transfer_id: ${transferId || '?'}\n` +
      `${why}\n` +
      `No automatic retry until the cooldown ends.`
    );
  }

  async function inAppTransfer(decision, transferId, after, state) {
    const balances = after ? formatBalances(after.main, after.bucket) : '';
    await inApp({
      kind: 'bucket_transfer',
      severity: 'info',
      title: `Kalshi bucket moved ${formatDollarsFromCents(decision.amountCents)}`,
      body: `${transferText(decision)} (${decision.reason}${state === 'accepted' ? ', confirmation pending' : ''}). ` +
        (balances ? `${balances}. ` : '') + `transfer_id ${transferId || '?'}.`,
      meta: {
        transferId: transferId || null,
        amountCents: decision.amountCents,
        fromShard: decision.fromShard,
        toShard: decision.toShard,
        reason: decision.reason,
        state,
      },
    });
  }

  // Shard 1 available cash vs COMBO_LOW_CASH_ALERT_USD. One unresolved alert
  // until cash recovers (or is dismissed and still low: it stays quiet).
  async function checkComboLowCash(availableCents) {
    const threshold = config.comboLowCashCents;
    if (!(threshold > 0) || availableCents == null) return;
    if (availableCents < threshold) {
      if (comboLowOpen === true) return;
      const ok = await inApp({
        kind: 'combo_low_cash',
        severity: 'warn',
        title: 'Kalshi combo cash is low',
        body: `Shard 1 (combo) available cash is ${formatDollarsFromCents(availableCents)}, ` +
          `below your ${formatDollarsFromCents(threshold)} alert level. ` +
          `Combo Locks can skip RFQs with "insufficient funds" until it is topped up.`,
        dedupeKey: 'combo_low_cash',
        meta: { availableCents, thresholdCents: threshold },
      });
      if (ok) comboLowOpen = true;
    } else if (comboLowOpen !== false) {
      if (await inAppResolve(['combo_low_cash'])) comboLowOpen = false;
    }
    if (availableCents >= threshold) {
      // A skip alert older than an hour clears once cash is healthy again.
      await inAppResolve(['combo_insufficient_funds'], { olderThanMs: 60 * 60 * 1000 });
    }
  }

  function formatBalances(main, bucket) {
    const total = bucket.availableCents + (bucket.portfolioCents || 0);
    return `${shardLabel(MAIN_SHARD)} ${formatDollarsFromCents(main.availableCents)}, ` +
      `${shardLabel(BUCKET_SHARD)} available ${formatDollarsFromCents(bucket.availableCents)} ` +
      `total ${formatDollarsFromCents(total)}`;
  }

  async function loadShards() {
    const main = await kalshi.getShard(MAIN_SHARD);
    const bucket = await kalshi.getShard(BUCKET_SHARD);
    lastBucketCents = bucket.availableCents;
    seenBucketThisRun = bucket.availableCents;
    return { main, bucket };
  }

  function landed(before, after, decision) {
    const key = decision.toShard === BUCKET_SHARD ? 'bucket' : 'main';
    return after[key].availableCents >= before[key].availableCents + decision.amountCents - 1;
  }

  // Shard-0 move check. Shard 0 is main cash and combo fills/locks happen on
  // shard 1, so a shard 0 drop (or rise for a sweep) cannot be explained by
  // spend. This is the fallback when Kalshi's transfer record is unavailable.
  function mainShowsMove(before, after, decision) {
    if (decision.fromShard === MAIN_SHARD) {
      return before.main.availableCents - after.main.availableCents >= decision.amountCents - 1;
    }
    return after.main.availableCents >= before.main.availableCents + decision.amountCents - 1;
  }

  // Definitive record first, then the shard-0 check, then the destination
  // balance. Never confirms or fails a transfer off shard 1 spend noise.
  //   confirmed  - record complete, or balances show the move
  //   failed     - record says failed/rejected
  //   processing - record exists, not complete yet
  //   missing    - no record and balances do not show it (record API worked
  //                or does not exist on this client)
  //   unknown    - record API errored and balances do not show it
  async function verifyTransfer(p, afterHint) {
    const canRecord = !!p.transferId && typeof kalshi.getTransfers === 'function';
    let record = null;
    let recordOk = false;
    if (canRecord) {
      try {
        const list = await kalshi.getTransfers();
        recordOk = true;
        record = list.find((r) => r.transferId === p.transferId) || null;
      } catch (e) {
        log(`[BUCKET] transfer record read failed ${e && e.message ? e.message : e}`);
      }
    }
    if (record) {
      const cls = transferStatusClass(record.status);
      if (cls === 'complete') {
        // Balances are display only here; the record is what confirms.
        let shown = afterHint || null;
        if (!shown) {
          try { shown = await loadShards(); } catch (_) { shown = null; }
        }
        return { state: 'confirmed', via: 'record', record, after: shown };
      }
      if (cls === 'failed') return { state: 'failed', via: 'record', record };
      return { state: 'processing', via: 'record', record };
    }
    let after = afterHint || null;
    if (!after) {
      try { after = await loadShards(); } catch (_) { after = null; }
    }
    const before = { main: p.beforeMain, bucket: p.beforeBucket };
    if (after && mainShowsMove(before, after, p.decision)) return { state: 'confirmed', via: 'shard0', after };
    if (after && landed(before, after, p.decision)) return { state: 'confirmed', via: 'balance', after };
    if (canRecord && !recordOk) return { state: 'unknown', via: 'none', after };
    return { state: 'missing', via: recordOk ? 'record-missing' : 'balance', after };
  }

  async function maybeLow(bucket, polyCash, t) {
    const avail = bucket.availableCents;
    if (avail >= config.lowAlertCents) {
      lowClear = true;
    } else if (lowClear || t - lowAt >= LOW_REPEAT_MS) {
      lowClear = false;
      lowAt = t;
      await emit(
        `Kalshi combo bucket low\n` +
        `${shardLabel(BUCKET_SHARD)} available ${formatDollarsFromCents(avail)} ` +
        `is below ${formatDollarsFromCents(config.lowAlertCents)}.`
      );
    }
    if (polyCash == null) return;
    const polyCents = floorCents(Number(polyCash));
    if (polyCents >= config.polyLowAlertCents) {
      polyLowClear = true;
    } else if (polyLowClear || t - polyLowAt >= LOW_REPEAT_MS) {
      polyLowClear = false;
      polyLowAt = t;
      await emit(
        `Polymarket cash low\n` +
        `Cash balance ${formatDollarsFromCents(polyCents)} is below ` +
        `${formatDollarsFromCents(config.polyLowAlertCents)}.\n` +
        `Alert only — no Polymarket transfer.`
      );
    }
  }

  async function evaluate(reason) {
    seenBucketThisRun = null;
    let out;
    try {
      out = await evaluateInner(reason);
    } finally {
      // Latest shard 1 read from this run (post-transfer when one landed), so
      // a top-up that fixes low cash does not raise a low-cash alert.
      if (seenBucketThisRun != null) {
        try { await checkComboLowCash(seenBucketThisRun); } catch (_) { /* alert only */ }
      }
    }
    return out;
  }

  async function evaluateInner(reason) {
    const date = clock();
    const t = date.getTime();
    if (needAt && t - needAt >= NEED_TTL_MS) { needCents = 0; needAt = 0; }
    if (
      reason === 'insufficient_balance' && lastCheckAt && t - lastCheckAt < CHECK_COALESCE_MS &&
      !(needCents > lastNeedUsed)
    ) {
      return { skipped: 'coalesced' };
    }
    lastCheckAt = t;
    lastNeedUsed = needCents;
    if (!kalshi) {
      log('[BUCKET] no Kalshi client — skipping balance check');
      return { skipped: 'no_client' };
    }

    let shards;
    try {
      shards = await loadShards();
    } catch (e) {
      log(`[BUCKET] balance read failed ${e && e.message ? e.message : e}`);
      if (t - balanceErrorAt >= VENUE_ALERT_MS) {
        balanceErrorAt = t;
        await emit(
          `Kalshi bucket balance read failed\n${e && e.message ? e.message : e}\n` +
          `No transfer. Next attempt on the following check.`
        );
      }
      return { error: e && e.message ? e.message : String(e) };
    }

    let polyCash = null;
    if (readPoly) {
      try {
        polyCash = await readPoly();
      } catch (e) {
        log(`[BUCKET] Polymarket balance read failed ${e && e.message ? e.message : e}`);
        if (t - polyErrorAt >= VENUE_ALERT_MS) {
          polyErrorAt = t;
          await emit(`Polymarket cash read failed\n${e && e.message ? e.message : e}`);
        }
      }
    } else if (!loggedPolySkip) {
      loggedPolySkip = true;
      log('[BUCKET] Polymarket cash alert skipped — POLYMARKET_KEY_ID / POLYMARKET_SECRET_KEY not set');
    }
    await maybeLow(shards.bucket, polyCash, t);

    if (pending) {
      // Never drop a pending transfer without verifying it: Kalshi's transfer
      // record first, then the shard 0 move, then the destination balance.
      const p = pending;
      const v = await verifyTransfer(p, shards);
      if (v.state === 'confirmed') {
        pending = null;
        log(
          `[BUCKET] transfer ${p.transferId || '?'} confirmed via ${v.via}` +
          (v.after ? ` ${formatBalances(v.after.main, v.after.bucket)}` : '')
        );
        await emitBucket(
          `Kalshi bucket transfer\n` +
          `${formatDollarsFromCents(p.decision.amountCents)} ` +
          `${shardLabel(p.decision.fromShard)} → ${shardLabel(p.decision.toShard)}\n` +
          `reason: ${p.decision.reason}\n` +
          `transfer_id: ${p.transferId || '?'}\n` +
          (v.after ? formatBalances(v.after.main, v.after.bucket) : `confirmed by Kalshi transfer record`)
        );
        // The in-app row was already written when the transfer was accepted.
        return { confirmed: true, late: true, via: v.via };
      }
      if (v.state === 'failed') {
        pending = null;
        cooldownUntil = t + Math.max(config.errorCooldownMs, UNCONFIRMED_COOLDOWN_MS);
        await reportTransferFailed(p.decision, p.transferId, `Kalshi transfer record status "${v.record.status}"`);
        return { failed: true, transferId: p.transferId, via: v.via };
      }
      // processing / missing / unknown: still unverified.
      const overdue = t >= p.holdUntil;
      if (overdue && !p.alertedUnconfirmed) {
        p.alertedUnconfirmed = true;
        cooldownUntil = t + Math.max(config.errorCooldownMs, UNCONFIRMED_COOLDOWN_MS);
        const why = v.state === 'missing'
          ? 'Kalshi has no transfer record for it yet and the balances do not show it'
          : v.state === 'processing'
            ? `Kalshi transfer record status is "${v.record && v.record.status}"`
            : 'the Kalshi transfer record could not be read';
        await inApp({
          kind: 'bucket_transfer_unconfirmed',
          severity: 'error',
          title: 'Kalshi bucket transfer not confirmed',
          body: `${transferText(p.decision)} was accepted ` +
            `(transfer_id ${p.transferId || '?'}) but ${why}. ` +
            `Holding further automatic transfers until it is verified. Check Kalshi balances.`,
          meta: { transferId: p.transferId || null, verify: v.state },
        });
        await emit(
          `Kalshi bucket transfer not confirmed\n` +
          `transfer_id ${p.transferId || '?'}\n` +
          `${why}. Holding further transfers until it is verified.`
        );
      }
      // A transfer with no Kalshi record (record API healthy) and no balance
      // trace after PENDING_MAX_MS never happened; release the hold then.
      // Any other unverified state keeps holding.
      if (overdue && v.state === 'missing' && t - p.sentAt >= PENDING_MAX_MS) {
        pending = null;
        log(`[BUCKET] transfer ${p.transferId || '?'} has no Kalshi record after ${Math.round(PENDING_MAX_MS / 60000)}m — releasing hold`);
        await inApp({
          kind: 'bucket_transfer_failed',
          severity: 'error',
          title: 'Kalshi bucket transfer never appeared',
          body: `${transferText(p.decision)} (transfer_id ${p.transferId || '?'}) has no Kalshi transfer record ` +
            `and no balance change after ${Math.round(PENDING_MAX_MS / 60000)} minutes. Automatic transfers resume.`,
          meta: { transferId: p.transferId || null },
        });
        return { lost: true, transferId: p.transferId };
      }
      log(`[BUCKET] holding — transfer ${p.transferId || '?'} not verified yet (${v.state})`);
      return overdue ? { held: true, unconfirmed: true, verify: v.state } : { held: true, verify: v.state };
    }

    const gameday = isGameday(date, config.windows);
    const baseTarget = gameday ? config.targetGamedayCents : config.targetDefaultCents;
    const targetCents = Math.max(
      baseTarget,
      needCents > 0 ? Math.floor(needCents) + (config.insufficientBufferCents || 0) : 0,
    );
    const excessCents = shards.bucket.availableCents - targetCents;
    let flat = null;
    if (config.sweep && !gameday && excessCents >= config.minTransferCents) {
      try {
        flat = await kalshi.shardActivity(BUCKET_SHARD);
      } catch (e) {
        log(`[BUCKET] shard 1 flat check failed ${e && e.message ? e.message : e} — not sweeping`);
        flat = { uncertain: true, openPositions: false, restingOrders: false };
      }
    }

    const decision = planBucketAction({
      mainAvailableCents: shards.main.availableCents,
      bucketAvailableCents: shards.bucket.availableCents,
      bucketPortfolioCents: shards.bucket.portfolioCents,
      gameday,
      sweepEnabled: config.sweep,
      flat,
      dailyTopupCents: dailySpent(date),
      needCents,
      config,
    });

    const mode = config.auto ? 'LIVE' : 'DRY RUN';
    const amountText = formatDollarsFromCents(decision.amountCents || 0);
    log(
      `[BUCKET] ${mode} ${decision.action} ${decision.reason} ` +
      `${decision.amountCents ? amountText + ' ' : ''}` +
      `target=${formatDollarsFromCents(decision.targetCents)} ` +
      `${formatBalances(shards.main, shards.bucket)}` +
      `${gameday ? ' gameday' : ''}` +
      ` trigger=${reason || 'check'}`
    );

    // Close in-app "blocked" rows whose reason no longer applies. First run
    // after a restart closes any stale ones (in-memory state is lost).
    {
      const nowBlocked = decision.action === 'blocked' && decision.block ? String(decision.block) : null;
      const stale = ['floor', 'daily_cap', 'ceiling'].filter((r) => r !== nowBlocked && (blockedOpen === null || blockedOpen.has(r)));
      const resolved = !stale.length || await inAppResolve(stale.map((r) => `bucket_blocked:${r}`));
      if (blockedOpen === null && resolved) blockedOpen = new Set();
      if (resolved) for (const r of stale) blockedOpen.delete(r);
    }

    if (decision.action === 'blocked' && decision.block) {
      const reason = String(decision.block);
      // In-app: one unresolved row per reason (dedupe_key), raised whenever the
      // block starts. Telegram stays throttled to once per hour per reason.
      if (!blockedOpen || !blockedOpen.has(reason)) {
        const blockedWhy = {
          floor: `Main (shard 0) is at or under the ${formatDollarsFromCents(config.floorCents)} floor`,
          daily_cap: `Today's auto-transfers hit the ${formatDollarsFromCents(config.dailyCapCents)} daily cap`,
          ceiling: `Shard 1 is at the ${formatDollarsFromCents(config.ceilingCents)} ceiling on available cash`,
        }[reason] || reason;
        const ok = await inApp({
          kind: 'bucket_blocked',
          severity: 'warn',
          title: `Kalshi bucket top-up blocked (${reason})`,
          body: `${blockedWhy}, so the combo bucket was not topped up. ` +
            `Shard 1 available ${formatDollarsFromCents(shards.bucket.availableCents)}, ` +
            `target ${formatDollarsFromCents(decision.targetCents)}, ` +
            `need ${formatDollarsFromCents(Math.max(0, decision.gapCents))}. ` +
            `Shard 0 available ${formatDollarsFromCents(shards.main.availableCents)}.`,
          dedupeKey: `bucket_blocked:${reason}`,
          meta: { block: reason, bucketCents: shards.bucket.availableCents, mainCents: shards.main.availableCents },
        });
        if (ok && blockedOpen) blockedOpen.add(reason);
      }
      const lastBlocked = blockedAlertAt.get(reason) || 0;
      if (!lastBlocked || t - lastBlocked >= BLOCKED_ALERT_MS) {
        blockedAlertAt.set(reason, t);
        await emitBucket(
          `Kalshi bucket top-up blocked (${decision.block})\n` +
          `shard 1 available ${formatDollarsFromCents(shards.bucket.availableCents)}, ` +
          `target ${formatDollarsFromCents(decision.targetCents)}, ` +
          `need ${formatDollarsFromCents(Math.max(0, decision.gapCents))}\n` +
          `shard 1 open positions ${formatDollarsFromCents(Math.max(0, decision.totalCents - shards.bucket.availableCents))}, ` +
          `ceiling on available cash ${formatDollarsFromCents(config.ceilingCents)}\n` +
          `shard 0 available ${formatDollarsFromCents(shards.main.availableCents)}, ` +
          `floor ${formatDollarsFromCents(config.floorCents)}\n` +
          `daily auto-transferred ${formatDollarsFromCents(dailySpent(date))} ` +
          `of ${formatDollarsFromCents(config.dailyCapCents)}`
        );
      }
      return { decision, dryRun: !config.auto };
    }

    if (decision.action !== 'topup' && decision.action !== 'sweep') {
      return { decision, dryRun: !config.auto };
    }

    if (!config.auto) {
      log(
        `[BUCKET] DRY RUN would transfer ${amountText} ` +
        `${shardLabel(decision.fromShard)} → ${shardLabel(decision.toShard)} ` +
        `reason=${decision.reason}`
      );
      return { decision, dryRun: true };
    }

    if (t < cooldownUntil) {
      log('[BUCKET] transfer cooldown — not sending');
      return { decision, cooledDown: true };
    }

    const amountCenticents = centsToCenticents(decision.amountCents);
    try {
      const sent = await kalshi.transfer({
        amountCenticents,
        fromShard: decision.fromShard,
        toShard: decision.toShard,
      });
      if (decision.action === 'topup') addDaily(date, decision.amountCents);
      // Pending from the moment Kalshi accepts it: nothing else may transfer
      // until it is verified, even if the reads below throw.
      const p = {
        decision,
        transferId: sent.transferId,
        beforeMain: shards.main,
        beforeBucket: shards.bucket,
        sentAt: t,
        holdUntil: t + config.settleMs,
        alertedUnconfirmed: false,
      };
      pending = p;
      // The immediate balance re-read is known to lag, so wait briefly and
      // ask Kalshi's transfer record instead of alerting off one early read.
      if (config.confirmDelayMs > 0) await sleep(config.confirmDelayMs);
      let v;
      try {
        v = await verifyTransfer(p, null);
      } catch (e) {
        log(`[BUCKET] confirm check failed ${e && e.message ? e.message : e}`);
        v = { state: 'unknown', via: 'none', after: null };
      }
      if (v.state === 'failed') {
        pending = null;
        cooldownUntil = clock().getTime() + Math.max(config.errorCooldownMs, UNCONFIRMED_COOLDOWN_MS);
        await reportTransferFailed(decision, sent.transferId, `Kalshi transfer record status "${v.record.status}"`);
        return { decision, transferId: sent.transferId, failed: true };
      }
      if (v.state !== 'confirmed') {
        // Not visible yet. Info row only (no Telegram, no error): the next
        // checks keep verifying and only alert if the hold window expires
        // with no record, or the record says failed.
        await inAppTransfer(decision, sent.transferId, v.after || null, 'accepted');
        log(
          `[BUCKET] transfer ${sent.transferId || '?'} accepted, not confirmed yet (${v.state}) — holding further transfers`
        );
        return { decision, transferId: sent.transferId, confirmed: false, verify: v.state };
      }
      pending = null;
      await inAppTransfer(decision, sent.transferId, v.after || null, 'confirmed');
      await emitBucket(
        `Kalshi bucket transfer\n` +
        `${amountText} ${shardLabel(decision.fromShard)} → ${shardLabel(decision.toShard)}\n` +
        `reason: ${decision.reason}\n` +
        `transfer_id: ${sent.transferId || '?'}\n` +
        (v.after ? formatBalances(v.after.main, v.after.bucket) : 'confirmed by Kalshi transfer record')
      );
      return { decision, transferId: sent.transferId, confirmed: true, after: v.after || null, via: v.via };
    } catch (e) {
      cooldownUntil = clock().getTime() + config.errorCooldownMs;
      log(`[BUCKET] transfer failed ${e && e.message ? e.message : e}`);
      await inApp({
        kind: 'bucket_transfer_failed',
        severity: 'error',
        title: 'Kalshi bucket transfer failed',
        body: `${transferText(decision)} failed: ${String(e && e.message ? e.message : e).slice(0, 300)}. ` +
          `No automatic retry for ${Math.round(config.errorCooldownMs / 1000)}s.`,
        meta: { amountCents: decision.amountCents, reason: decision.reason },
      });
      await emit(
        `Kalshi bucket transfer failed\n` +
        `${amountText} ${shardLabel(decision.fromShard)} → ${shardLabel(decision.toShard)}\n` +
        `reason: ${decision.reason}\n` +
        `${e && e.message ? e.message : e}\n` +
        `No automatic retry until the cooldown ends.`
      );
      return { decision, error: e && e.message ? e.message : String(e) };
    }
  }

  function requestCheck(reason) {
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(() => evaluate(reason))
      .catch((e) => {
        log(`[BUCKET] check failed ${e && e.message ? e.message : e}`);
        return { error: e && e.message ? e.message : String(e) };
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  // info.costDollars / info.costCents: what the rejected quote needed in cash.
  async function onInsufficientBalance(venue, info = null) {
    const name = String(venue || '').toLowerCase() === 'polymarket' ? 'polymarket' : 'kalshi';
    const t = clock().getTime();
    const last = venueAlertAt.get(name) || 0;
    let costCents = 0;
    if (name === 'kalshi' && info) {
      const c = info.costCents != null ? Number(info.costCents) : Number(info.costDollars) * 100;
      if (Number.isFinite(c) && c > 0) costCents = Math.ceil(c);
    }
    if (costCents > 0) {
      if (!needAt || t - needAt >= NEED_TTL_MS) needCents = 0;
      needCents = Math.max(needCents, costCents);
      needAt = t;
      log(`[BUCKET] insufficient_balance: rejected quote needs ${formatDollarsFromCents(costCents)} ` +
        `(+${formatDollarsFromCents(config.insufficientBufferCents || 0)} buffer)`);
    }
    if (name === 'kalshi' && t - insufficientInAppAt >= INSUFFICIENT_IN_APP_MS) {
      insufficientInAppAt = t;
      const cash = lastBucketCents != null
        ? `Last read: shard 1 (combo) available ${formatDollarsFromCents(lastBucketCents)}. `
        : '';
      await inApp({
        kind: 'combo_insufficient_funds',
        severity: 'error',
        title: 'Combo Locks skipped: Kalshi insufficient funds',
        body: `A Kalshi combo quote was rejected for insufficient balance. ${cash}` +
          (costCents > 0 ? `It needed about ${formatDollarsFromCents(costCents)}. ` : '') +
          `The bucket manager is re-checking both shards now.`,
        dedupeKey: 'combo_insufficient_funds',
        meta: { availableCents: lastBucketCents, needCents: costCents || null },
      });
    }
    if (t - last >= VENUE_ALERT_MS) {
      venueAlertAt.set(name, t);
      const label = name === 'polymarket' ? 'Polymarket' : 'Kalshi';
      await emit(
        `INSUFFICIENT BALANCE (${label})\n` +
        `A ${label} quote was rejected for insufficient_balance.\n` +
        (name === 'polymarket'
          ? 'Polymarket cash is alert-only. The combo bucket is checked separately.'
          : 'Checking shard 0 and shard 1 now.')
      );
    }
    return requestCheck('insufficient_balance');
  }

  function start() {
    const ms = config.intervalMin * 60 * 1000;
    log(
      `[BUCKET] started auto=${config.auto ? '1' : '0'} sweep=${config.sweep ? '1' : '0'} ` +
      `interval=${config.intervalMin}m ` +
      `target gameday=${formatDollarsFromCents(config.targetGamedayCents)} ` +
      `default=${formatDollarsFromCents(config.targetDefaultCents)} ` +
      `ceiling=${formatDollarsFromCents(config.ceilingCents)}(available cash) ` +
      `floor=${formatDollarsFromCents(config.floorCents)} ` +
      `max=${formatDollarsFromCents(config.maxTransferCents)} ` +
      `daily=${formatDollarsFromCents(config.dailyCapCents)} ` +
      `min=${formatDollarsFromCents(config.minTransferCents)}`
    );
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      requestCheck('interval').catch(() => {});
    }, ms);
    requestCheck('startup').catch(() => {});
    return stop;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    config,
    start,
    stop,
    check: requestCheck,
    onInsufficientBalance,
    evaluate: requestCheck,
  };
}

module.exports = {
  TRANSFER_PATH,
  TRANSFERS_PATH,
  BALANCE_PATH,
  POSITIONS_PATH,
  ORDERS_PATH,
  CENTICENTS_PER_DOLLAR,
  CENTICENTS_PER_CENT,
  MAIN_SHARD,
  BUCKET_SHARD,
  VENUE_ALERT_MS,
  LOW_REPEAT_MS,
  BLOCKED_ALERT_MS,
  DEFAULT_GAMEDAY_WINDOWS,
  floorCents,
  dollarsToCenticents,
  centsToCenticents,
  formatDollarsFromCents,
  loadBucketConfig,
  isGameday,
  etDateKey,
  planBucketAction,
  parseShardBalance,
  parseTransfers,
  transferStatusClass,
  usdCashFromBalances,
  isOpenPosition,
  createKalshiBucketClient,
  readPolyCashFromHttp,
  polyReaderFromEnv,
  createBucketManager,
};
