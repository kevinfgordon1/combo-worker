// Adverse Protect poller for Kevin's Live Trading Desk (Polymarket US).
//
// Combo Locks calls aibetbuilder's protect-sweep on a short interval. That
// server owns the price math: while a Desk rest has Protect armed, if the
// resting price is >= X¢ through mid (picked off / stale gift), it cancels
// and re-rests better (buy lower / sell higher at mid ± Y¢). If the market
// runs away from the rest, it does nothing. This process does not call
// Polymarket, does not read combo user tables, and does not chase.
//
// Off unless DESK_PROTECT_SWEEP_URL and DESK_PROTECT_SWEEP_SECRET are both
// set. Unhedged RFQs never start this script. See RAILWAY.md for the
// request contract (POST, header X-Desk-Protect-Secret, mode adverse-only).
//
// Defaults sent to the sweep: X = 3¢ through mid, Y = 1¢ rest offset.
// One Telegram ping per adverse event id. Sweep HTTP errors stay in this
// process — they must not exit it (start-live treats a child exit as fatal).
'use strict';

const { shortId } = require('./short-id');

const MODE = 'DESK-PROTECT';
const SECRET_HEADER = 'X-Desk-Protect-Secret';
const DEFAULT_POLL_MS = 1500;
const MIN_POLL_MS = 1000;
const MAX_POLL_MS = 10000;
const DEFAULT_THROUGH_CENTS = 3;
const DEFAULT_REST_OFFSET_CENTS = 1;
const SWEEP_TIMEOUT_MS = 8000;
const ERROR_LOG_MS = 60000;
const ALERT_RETRY_MS = 30000;
const MAX_ALERT_ATTEMPTS = 5;
const MAX_EVENTS_PER_TICK = 25;
const MAX_EVENTS_SCAN = 200;
const MAX_ACKED = 200;
const MAX_PENDING = 50;
const MIN_SECRET_LEN = 16;

const ADVERSE_KINDS = new Set([
  'adverse',
  'adverse-reprice',
  'adverse-protect',
  'protect-adverse',
]);

function trim(v) {
  if (v == null) return '';
  return String(v).trim();
}

function trimEnv(v) {
  let s = trim(v);
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2)
    || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function positiveNumber(raw, fallback) {
  if (raw == null || trim(raw) === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function restOffsetCents(raw) {
  if (raw == null || trim(raw) === '') return DEFAULT_REST_OFFSET_CENTS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_REST_OFFSET_CENTS;
  return n;
}

function clampPollMs(raw) {
  const n = positiveNumber(raw, DEFAULT_POLL_MS);
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(n)));
}

function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function isAllowedSweepUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return false; }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:' && isLocalHost(u.hostname)) return true;
  return false;
}

function publicUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    return '';
  }
}

function safeErrorText(text, secret) {
  let s = trim(text).replace(/\s+/g, ' ').slice(0, 180);
  if (secret) s = s.split(secret).join('[secret]');
  return s;
}

function readDeskProtectConfig(env = process.env) {
  const source = env || {};
  const url = trimEnv(source.DESK_PROTECT_SWEEP_URL);
  const secret = trimEnv(source.DESK_PROTECT_SWEEP_SECRET);
  const throughCents = positiveNumber(source.DESK_PROTECT_THROUGH_CENTS, DEFAULT_THROUGH_CENTS);
  const offsetCents = restOffsetCents(source.DESK_PROTECT_REST_OFFSET_CENTS);
  let disabledReason = '';
  if (!url) disabledReason = 'unset';
  else if (!secret) disabledReason = 'missing-secret';
  else if (secret.length < MIN_SECRET_LEN) disabledReason = 'short-secret';
  else if (/[\r\n]/.test(secret)) disabledReason = 'bad-secret';
  else if (!isAllowedSweepUrl(url)) disabledReason = 'bad-url';
  else if (url.includes(secret)) disabledReason = 'secret-in-url';
  const enabled = !disabledReason;
  return {
    url,
    secret,
    pollMs: clampPollMs(source.DESK_PROTECT_POLL_MS),
    throughCents,
    restOffsetCents: offsetCents,
    enabled,
    disabledReason: enabled ? '' : disabledReason,
  };
}

function isDeskProtectEnabled(env = process.env) {
  return readDeskProtectConfig(env).enabled;
}

function deskProtectDisabledMessage(cfg) {
  const reason = cfg && cfg.disabledReason;
  if (reason === 'missing-secret') {
    return '[start-live] desk protect not started — DESK_PROTECT_SWEEP_URL is set but DESK_PROTECT_SWEEP_SECRET is missing';
  }
  if (reason === 'short-secret' || reason === 'bad-secret') {
    return '[start-live] desk protect not started — DESK_PROTECT_SWEEP_SECRET must be at least 16 characters and a single line';
  }
  if (reason === 'bad-url') {
    return '[start-live] desk protect not started — DESK_PROTECT_SWEEP_URL must be https (http://localhost is allowed)';
  }
  if (reason === 'secret-in-url') {
    return '[start-live] desk protect not started — put the secret in DESK_PROTECT_SWEEP_SECRET, not in the URL';
  }
  return '[start-live] desk protect off (DESK_PROTECT_SWEEP_URL unset)';
}

function publicConfigOf(cfg) {
  return {
    enabled: cfg.enabled,
    disabledReason: cfg.disabledReason,
    pollMs: cfg.pollMs,
    throughCents: cfg.throughCents,
    restOffsetCents: cfg.restOffsetCents,
    sweepOrigin: cfg.url ? publicUrl(cfg.url) : '',
  };
}

function kindOf(ev) {
  return trim(ev && (ev.kind || ev.reason || ev.type)).toLowerCase();
}

function isChaseEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.chase === true || ev.chased === true) return true;
  return /chase|follow|toward/.test(kindOf(ev));
}

function isAdverseProtectEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.adverse === false) return false;
  if (isChaseEvent(ev)) return false;
  const kind = kindOf(ev);
  if (ADVERSE_KINDS.has(kind)) return true;
  if (ev.adverse === true && !kind) return true;
  return false;
}

function eventIdOf(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const explicit = trim(ev.id);
  if (explicit) return explicit.slice(0, 200);
  const orderId = trim(ev.orderId || ev.order_id);
  const newOrderId = trim(ev.newOrderId || ev.new_order_id);
  if (!orderId && !newOrderId) return '';
  return [
    'adverse',
    orderId,
    newOrderId,
    ev.fromCents != null ? ev.fromCents : (ev.from_cents != null ? ev.from_cents : ''),
    ev.toCents != null ? ev.toCents : (ev.to_cents != null ? ev.to_cents : ''),
  ].join(':').slice(0, 200);
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = kindOf(raw);
  return {
    id: eventIdOf(raw),
    kind,
    adverse: raw.adverse,
    chase: raw.chase === true || raw.chased === true || /chase|follow|toward/.test(kind),
    orderId: trim(raw.orderId || raw.order_id),
    newOrderId: trim(raw.newOrderId || raw.new_order_id),
    marketSlug: trim(raw.marketSlug || raw.market_slug),
    label: trim(raw.label || raw.outcomeName || raw.outcome_name || raw.title),
    action: trim(raw.action).toLowerCase(),
    outcome: trim(raw.outcome).toLowerCase(),
    fromCents: raw.fromCents != null ? raw.fromCents : raw.from_cents,
    toCents: raw.toCents != null ? raw.toCents : raw.to_cents,
    midCents: raw.midCents != null ? raw.midCents : raw.mid_cents,
    throughCents: raw.throughCents != null ? raw.throughCents : raw.through_cents,
    restOffsetCents: raw.restOffsetCents != null ? raw.restOffsetCents : raw.rest_offset_cents,
  };
}

function formatCents(v) {
  if (v == null || v === '') return '';
  const n = typeof v === 'number' ? v : Number(String(v).replace(/¢/g, '').trim());
  if (!Number.isFinite(n)) return '';
  const rounded = Math.round(n * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text}¢`;
}

function formatAdverseProtectAlert(ev) {
  const label = (ev && (ev.label || ev.marketSlug)) || 'Desk rest';
  const action = ev && (ev.action === 'buy' || ev.action === 'sell') ? ev.action : '';
  const from = formatCents(ev && ev.fromCents);
  const to = formatCents(ev && ev.toCents);
  const mid = formatCents(ev && ev.midCents);
  const through = formatCents(ev && ev.throughCents);
  let line = action ? action : 'rest';
  if (from) line += ` ${from}`;
  if (through && mid) line += ` was ${through} through mid ${mid}`;
  else if (through) line += ` was ${through} through mid`;
  const moved = to
    ? `canceled ${shortId(ev && ev.orderId)} → re-rested ${shortId(ev && ev.newOrderId)} at ${to}`
    : `canceled ${shortId(ev && ev.orderId)} → re-rested ${shortId(ev && ev.newOrderId)}`;
  return [
    `⚠️ ADVERSE PROTECT (Polymarket) — ${label}`,
    line,
    moved,
  ].join('\n');
}

function sweepBody(cfg, ackedIds) {
  return {
    op: 'sweep',
    mode: 'adverse-only',
    defaults: {
      throughCents: cfg.throughCents,
      restOffsetCents: cfg.restOffsetCents,
    },
    ackedIds: ackedIds || [],
  };
}

function parseSweepResponse(status, json) {
  if (status < 200 || status >= 300) {
    const err = new Error(`sweep HTTP ${status}`);
    err.statusCode = status;
    throw err;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('sweep response was not an object');
  }
  if (json.ok === false) {
    const err = new Error(safeErrorText(json.error || 'sweep ok:false'));
    err.statusCode = status;
    throw err;
  }
  return Array.isArray(json.events) ? json.events : [];
}

async function sendTelegramAlert(text, env = process.env, fetchImpl = fetch) {
  const token = trimEnv(env && env.TELEGRAM_BOT_TOKEN);
  const chat = trimEnv(env && env.TELEGRAM_ALERT_CHAT_ID);
  if (!token || !chat) {
    console.log(`[${MODE}] (telegram not configured) ${String(text).replace(/\n/g, ' | ')}`);
    return;
  }
  const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text }),
  });
  if (!r.ok) {
    const body = typeof r.text === 'function' ? await r.text() : '';
    throw new Error(`telegram ${r.status} ${safeErrorText(body, token)}`);
  }
}

function createDeskProtectPoller(opts = {}) {
  const env = opts.env || process.env;
  const cfg = readDeskProtectConfig(env);
  const fetchImpl = opts.fetchImpl || fetch;
  const sendAlert = opts.sendAlert || ((text) => sendTelegramAlert(text, env, fetchImpl));
  const log = opts.log || ((m) => console.log(`[${MODE}] ${m}`));
  const logError = opts.logError || ((m) => console.error(`[${MODE}] ${m}`));
  const now = opts.now || Date.now;
  const timeoutMs = opts.timeoutMs || SWEEP_TIMEOUT_MS;

  const acked = [];
  const ackedSet = new Set();
  const pending = new Map();
  let inFlight = false;
  let running = false;
  let stopped = false;
  let timer = null;
  let lastErrorAt = -Infinity;
  let lastWarnAt = -Infinity;
  let lastNoIdAt = -Infinity;

  function noteError(msg) {
    const t = now();
    if (t - lastErrorAt < ERROR_LOG_MS) return;
    lastErrorAt = t;
    logError(msg);
  }

  function noteWarn(msg) {
    const t = now();
    if (t - lastWarnAt < ERROR_LOG_MS) return;
    lastWarnAt = t;
    log(msg);
  }

  function rememberAck(id) {
    if (!id || ackedSet.has(id)) return;
    acked.push(id);
    ackedSet.add(id);
    pending.delete(id);
    while (acked.length > MAX_ACKED) {
      const old = acked.shift();
      ackedSet.delete(old);
    }
  }

  async function postSweep() {
    const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    const res = await fetchImpl(cfg.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        [SECRET_HEADER]: cfg.secret,
      },
      body: JSON.stringify(sweepBody(cfg, acked.slice())),
      signal,
    });
    const status = res && res.status;
    if (status >= 300 && status < 400) {
      throw new Error(`sweep redirected (${status})`);
    }
    const text = res && typeof res.text === 'function' ? await res.text() : '';
    if (status < 200 || status >= 300) {
      throw new Error(`sweep HTTP ${status} ${safeErrorText(text, cfg.secret)}`);
    }
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch (_) { json = null; }
    }
    return parseSweepResponse(status, json);
  }

  async function notify(ev) {
    const id = ev && ev.id;
    if (!id) {
      const t = now();
      if (t - lastNoIdAt >= ERROR_LOG_MS) {
        lastNoIdAt = t;
        log('ignored protect event with no id');
      }
      return { pinged: false };
    }
    if (ackedSet.has(id)) return { pinged: false };
    const waiting = pending.get(id);
    if (waiting && waiting.nextAt > now()) return { pinged: false };
    if (!isAdverseProtectEvent(ev)) {
      if (ev.chase || isChaseEvent(ev)) log(`ignored chase event ${id}`);
      else log(`ignored non-adverse event ${id}${ev.kind ? ` kind=${ev.kind}` : ''}`);
      rememberAck(id);
      return { pinged: false };
    }
    if (!pending.has(id) && pending.size >= MAX_PENDING) {
      noteWarn('protect ping queue full — leaving event unacked');
      return { pinged: false };
    }
    try {
      await sendAlert(formatAdverseProtectAlert(ev));
      rememberAck(id);
      return { pinged: true };
    } catch (e) {
      const attempts = (waiting ? waiting.attempts : 0) + 1;
      if (attempts >= MAX_ALERT_ATTEMPTS) {
        logError(`dropped protect ping ${id} after ${attempts} tries`);
        rememberAck(id);
        return { pinged: false };
      }
      pending.set(id, { ev, attempts, nextAt: now() + ALERT_RETRY_MS });
      noteError(safeErrorText(`telegram failed for ${id}: ${e && e.message ? e.message : e}`, cfg.secret));
      return { pinged: false };
    }
  }

  async function flushPending() {
    const t = now();
    let pinged = 0;
    for (const item of pending.values()) {
      if (!item || item.nextAt > t) continue;
      const result = await notify(item.ev);
      if (result && result.pinged) pinged += 1;
    }
    return pinged;
  }

  async function tick() {
    if (stopped) return { skipped: 'stopped' };
    if (!cfg.enabled) return { skipped: 'disabled', reason: cfg.disabledReason };
    if (inFlight) return { skipped: 'in-flight' };
    inFlight = true;
    try {
      let pinged = await flushPending();
      const rawEvents = await postSweep();
      const scan = rawEvents.slice(0, MAX_EVENTS_SCAN);
      if (rawEvents.length > scan.length) noteWarn(`sweep returned ${rawEvents.length} events; scanning ${scan.length}`);
      let handled = 0;
      for (const raw of scan) {
        const ev = normalizeEvent(raw);
        if (!ev) continue;
        if (ev.id && ackedSet.has(ev.id)) continue;
        if (handled >= MAX_EVENTS_PER_TICK) {
          noteWarn(`protect sweep has more than ${MAX_EVENTS_PER_TICK} new events; rest wait for the next tick`);
          break;
        }
        handled += 1;
        const result = await notify(ev);
        if (result && result.pinged) pinged += 1;
      }
      return { ok: true, events: scan.length, handled, pinged };
    } catch (e) {
      noteError(e && e.message ? e.message : String(e));
      return { ok: false, error: e && e.message ? e.message : String(e) };
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (!cfg.enabled) {
      log(deskProtectDisabledMessage(cfg).replace('[start-live] ', ''));
      return { enabled: false, reason: cfg.disabledReason };
    }
    if (running) return { enabled: true, already: true };
    running = true;
    stopped = false;
    log(`on — adverse-only sweep ${publicUrl(cfg.url)} every ${cfg.pollMs}ms (X=${cfg.throughCents}¢ Y=${cfg.restOffsetCents}¢). Protect stays off unless armed on the order.`);
    const started = tick();
    timer = setInterval(() => { tick(); }, cfg.pollMs);
    return { enabled: true, started };
  }

  function stop() {
    stopped = true;
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    tick,
    config: publicConfigOf(cfg),
    ackedIds() { return acked.slice(); },
  };
}

function main() {
  const poller = createDeskProtectPoller();
  const started = poller.start();
  if (!started.enabled) {
    process.exit(0);
  }
  const shutdown = () => {
    poller.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (e) => {
    console.error(`[${MODE}] unhandled`, e && e.message ? e.message : e);
  });
}

if (require.main === module) main();

module.exports = {
  SECRET_HEADER,
  DEFAULT_POLL_MS,
  DEFAULT_THROUGH_CENTS,
  DEFAULT_REST_OFFSET_CENTS,
  MIN_SECRET_LEN,
  readDeskProtectConfig,
  isDeskProtectEnabled,
  deskProtectDisabledMessage,
  isAdverseProtectEvent,
  isChaseEvent,
  normalizeEvent,
  formatAdverseProtectAlert,
  sweepBody,
  parseSweepResponse,
  safeErrorText,
  createDeskProtectPoller,
  sendTelegramAlert,
};
