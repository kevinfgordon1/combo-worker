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
// Shard total for the ceiling is available + portfolio_value.
//
// KALSHI_BUCKET_AUTO defaults to off: log the decision, do not POST.
// KALSHI_BUCKET_SWEEP defaults to off.
//
// Schedule (America/New_York, DST-aware). A window is { start, end }
// with dow 0=Sunday .. 6=Saturday and time "HH:MM". The end minute is
// included. A window that wraps the week (Saturday through Monday) has
// start > end.
//   Saturday 00:00 through Monday 23:59
//   Thursday 12:00 through Friday 03:00 (NFL Thursday night)
'use strict';

const { createPolymarketHttp } = require('./polymarket-client');

const TRANSFER_PATH = '/trade-api/v2/portfolio/intra_exchange_instance_transfer';
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
const CHECK_COALESCE_MS = 15_000;
const DEFAULT_SETTLE_MS = 180_000;
const DEFAULT_ERROR_COOLDOWN_MS = 60_000;
const UNCONFIRMED_COOLDOWN_MS = 5 * 60 * 1000;

const DOW = Object.freeze({
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
});

const DEFAULT_GAMEDAY_WINDOWS = Object.freeze([
  { id: 'weekend', start: { dow: 6, time: '00:00' }, end: { dow: 1, time: '23:59' } },
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
    ceilingCents: envDollarsToCents(env, 'KALSHI_BUCKET_CEILING', 15_000),
    floorCents: envDollarsToCents(env, 'KALSHI_MAIN_FLOOR', 2_000),
    maxTransferCents: envDollarsToCents(env, 'KALSHI_BUCKET_MAX_TRANSFER', 10_000),
    dailyCapCents: envDollarsToCents(env, 'KALSHI_BUCKET_DAILY_CAP', 15_000),
    minTransferCents: envDollarsToCents(env, 'KALSHI_BUCKET_MIN_TRANSFER', 100),
    targetGamedayCents: envDollarsToCents(env, 'KALSHI_BUCKET_TARGET_GAMEDAY', 10_000),
    targetDefaultCents: envDollarsToCents(env, 'KALSHI_BUCKET_TARGET_DEFAULT', 5_000),
    lowAlertCents: envDollarsToCents(env, 'KALSHI_BUCKET_LOW_ALERT', 1_500),
    polyLowAlertCents: envDollarsToCents(env, 'POLY_LOW_ALERT', 1_500),
    intervalMin: envPositiveInt(env, 'KALSHI_BUCKET_INTERVAL_MIN', 5, 1),
    settleMs: envPositiveInt(env, 'KALSHI_BUCKET_SETTLE_MS', DEFAULT_SETTLE_MS, 0),
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
  config,
}) {
  const targetCents = gameday ? config.targetGamedayCents : config.targetDefaultCents;
  const totalCents = bucketAvailableCents + (bucketPortfolioCents || 0);
  const gap = targetCents - bucketAvailableCents;
  const base = {
    targetCents,
    gameday: !!gameday,
    totalCents,
    gapCents: gap,
  };

  if (gap > 0) {
    const headroom = Math.min(
      config.ceilingCents - totalCents,
      config.ceilingCents - bucketAvailableCents,
    );
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

  return { getShard, transfer, shardActivity };
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
  client = null,
  signed = null,
  readPolyCash,
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
  let inflight = null;
  let timer = null;
  let balanceErrorAt = 0;
  let polyErrorAt = 0;
  let loggedPolySkip = false;

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

  function formatBalances(main, bucket) {
    const total = bucket.availableCents + (bucket.portfolioCents || 0);
    return `${shardLabel(MAIN_SHARD)} ${formatDollarsFromCents(main.availableCents)}, ` +
      `${shardLabel(BUCKET_SHARD)} available ${formatDollarsFromCents(bucket.availableCents)} ` +
      `total ${formatDollarsFromCents(total)}`;
  }

  async function loadShards() {
    const main = await kalshi.getShard(MAIN_SHARD);
    const bucket = await kalshi.getShard(BUCKET_SHARD);
    return { main, bucket };
  }

  function landed(before, after, decision) {
    const key = decision.toShard === BUCKET_SHARD ? 'bucket' : 'main';
    return after[key].availableCents >= before[key].availableCents + decision.amountCents - 1;
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
    const date = clock();
    const t = date.getTime();
    if (reason === 'insufficient_balance' && lastCheckAt && t - lastCheckAt < CHECK_COALESCE_MS) {
      return { skipped: 'coalesced' };
    }
    lastCheckAt = t;
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
      let after = null;
      try { after = await loadShards(); } catch (_) { after = null; }
      const showedUp = after && landed(
        { main: pending.beforeMain, bucket: pending.beforeBucket },
        after,
        pending.decision,
      );
      if (showedUp) {
        const done = pending;
        pending = null;
        log(`[BUCKET] transfer ${done.transferId || '?'} confirmed ${formatBalances(after.main, after.bucket)}`);
        await emit(
          `Kalshi bucket transfer\n` +
          `${formatDollarsFromCents(done.decision.amountCents)} ` +
          `${shardLabel(done.decision.fromShard)} → ${shardLabel(done.decision.toShard)}\n` +
          `reason: ${done.decision.reason}\n` +
          `transfer_id: ${done.transferId || '?'}\n` +
          formatBalances(after.main, after.bucket)
        );
        return { confirmed: true, late: true };
      } else if (t < pending.holdUntil) {
        log(`[BUCKET] holding — transfer ${pending.transferId || '?'} not visible on the re-read yet`);
        return { held: true };
      } else {
        const id = pending.transferId;
        pending = null;
        cooldownUntil = t + Math.max(config.errorCooldownMs, UNCONFIRMED_COOLDOWN_MS);
        await emit(
          `Kalshi bucket transfer not confirmed\n` +
          `transfer_id ${id || '?'}\n` +
          `The accept was not reflected in the balance re-read. ` +
          `No further transfer until the cooldown ends.`
        );
        return { unconfirmed: true };
      }
    }

    const gameday = isGameday(date, config.windows);
    const targetCents = gameday ? config.targetGamedayCents : config.targetDefaultCents;
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

    if (decision.action === 'blocked' && decision.block) {
      await emit(
        `Kalshi bucket top-up blocked (${decision.block})\n` +
        `shard 1 available ${formatDollarsFromCents(shards.bucket.availableCents)}, ` +
        `target ${formatDollarsFromCents(decision.targetCents)}, ` +
        `need ${formatDollarsFromCents(Math.max(0, decision.gapCents))}\n` +
        `shard 1 total ${formatDollarsFromCents(decision.totalCents)}, ` +
        `ceiling ${formatDollarsFromCents(config.ceilingCents)}\n` +
        `shard 0 available ${formatDollarsFromCents(shards.main.availableCents)}, ` +
        `floor ${formatDollarsFromCents(config.floorCents)}\n` +
        `daily auto-transferred ${formatDollarsFromCents(dailySpent(date))} ` +
        `of ${formatDollarsFromCents(config.dailyCapCents)}`
      );
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
      let after = null;
      try {
        after = await loadShards();
      } catch (e) {
        pending = {
          decision,
          transferId: sent.transferId,
          beforeMain: shards.main,
          beforeBucket: shards.bucket,
          holdUntil: t + config.settleMs,
        };
        await emit(
          `Kalshi bucket transfer accepted, balance re-read failed\n` +
          `${amountText} ${shardLabel(decision.fromShard)} → ${shardLabel(decision.toShard)}\n` +
          `reason: ${decision.reason}\n` +
          `transfer_id: ${sent.transferId || '?'}\n` +
          `${e && e.message ? e.message : e}\n` +
          `No further transfer until the balance re-read confirms this one.`
        );
        return { decision, transferId: sent.transferId, confirmed: false };
      }
      if (!landed(shards, after, decision)) {
        pending = {
          decision,
          transferId: sent.transferId,
          beforeMain: shards.main,
          beforeBucket: shards.bucket,
          holdUntil: t + config.settleMs,
        };
        await emit(
          `Kalshi bucket transfer accepted\n` +
          `${amountText} ${shardLabel(decision.fromShard)} → ${shardLabel(decision.toShard)}\n` +
          `reason: ${decision.reason}\n` +
          `transfer_id: ${sent.transferId || '?'}\n` +
          `Balance re-read does not show the move yet. No further transfer until it does.\n` +
          formatBalances(after.main, after.bucket)
        );
        return { decision, transferId: sent.transferId, confirmed: false };
      }
      await emit(
        `Kalshi bucket transfer\n` +
        `${amountText} ${shardLabel(decision.fromShard)} → ${shardLabel(decision.toShard)}\n` +
        `reason: ${decision.reason}\n` +
        `transfer_id: ${sent.transferId || '?'}\n` +
        formatBalances(after.main, after.bucket)
      );
      return { decision, transferId: sent.transferId, confirmed: true, after };
    } catch (e) {
      cooldownUntil = clock().getTime() + config.errorCooldownMs;
      log(`[BUCKET] transfer failed ${e && e.message ? e.message : e}`);
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

  async function onInsufficientBalance(venue) {
    const name = String(venue || '').toLowerCase() === 'polymarket' ? 'polymarket' : 'kalshi';
    const t = clock().getTime();
    const last = venueAlertAt.get(name) || 0;
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
      `ceiling=${formatDollarsFromCents(config.ceilingCents)} ` +
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
  BALANCE_PATH,
  POSITIONS_PATH,
  ORDERS_PATH,
  CENTICENTS_PER_DOLLAR,
  CENTICENTS_PER_CENT,
  MAIN_SHARD,
  BUCKET_SHARD,
  VENUE_ALERT_MS,
  LOW_REPEAT_MS,
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
  usdCashFromBalances,
  isOpenPosition,
  createKalshiBucketClient,
  readPolyCashFromHttp,
  polyReaderFromEnv,
  createBucketManager,
};
