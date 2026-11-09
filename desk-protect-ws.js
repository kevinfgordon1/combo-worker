// Realtime Bet Protect on kaygo-poly-worker.
//
// Armed desk_protect_rests are watched on the Polymarket US market-data
// websocket. A pick through the cushion, a trade through our price, or a
// dead socket cancels that order from this process (the only runtime that
// already holds the Polymarket US keys). The replacement is not priced
// here. After the cancel ack, the row is handed to aibetbuilder
// /api/desk-protect-sweep op ws-replace, which is the same chain cap,
// reconcile, and create-unknown path as the 1.5s REST sweep. If that call
// is not configured, the row is left pending_lineage / pending_book and
// the REST sweep finishes it. Both paths claim the row, so only one
// cancels and only one re-rests.
//
// Off unless DESK_PROTECT_WS is explicitly on, or
// public.desk_protect_ws_control id=1 enabled is true. Default off.
'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { createPolymarketHttp } = require('./polymarket-client');
const { readDeskProtectConfig, SECRET_HEADER } = require('./desk-protect');
const {
  evaluateBookProtect,
  evaluateTradeProtect,
  bookSideOf,
  isPolymarketSlug,
  amountValue,
} = require('./desk-protect-ws-decide');
const { createMarketFeed, ordersFromPayload } = require('./desk-protect-ws-feed');

const MODE = 'DESK-PROTECT-WS';
const ARM_MS = 2000;
const POLL_OFF_MS = 10000;
const HEARTBEAT_MS = 30000;
const ARMED_COLUMNS = 'order_id,owner_email,market_slug,outcome,action,yes_price,contracts,x_cents,status';
const ARMED_STATUSES = ['armed', 'pending_rereset', 'pending_lineage', 'pending_book', 'sweeping'];
const SILENCE_CHECK_MS = 250;
const DEFAULT_SILENT_MS = 1500;
const MIN_SILENT_MS = 400;
const MAX_SILENT_MS = 5000;
const AUDIT_GATE_MS = 30000;
const ERROR_LOG_MS = 60000;
const CONTROL_TABLE = 'desk_protect_ws_control';
const RESTS = 'desk_protect_rests';
const AUDITS = 'desk_protect_audits';

function trim(v) {
  return v == null ? '' : String(v).trim();
}

function envOn(raw) {
  return /^(1|true|yes|on)$/i.test(trim(raw));
}

function envOff(raw) {
  return /^(0|false|no|off)$/i.test(trim(raw));
}

function clampSilentMs(raw) {
  if (raw == null || trim(raw) === '') return DEFAULT_SILENT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SILENT_MS;
  return Math.min(MAX_SILENT_MS, Math.max(MIN_SILENT_MS, Math.round(n)));
}

// Explicit DESK_PROTECT_WS=0 is a kill switch. Explicit 1 turns the socket
// on. Unset follows the Supabase control row, which defaults to off.
function resolveWsProtectEnabled({ env = process.env, control } = {}) {
  const source = env || {};
  const raw = source.DESK_PROTECT_WS;
  if (envOff(raw)) return { enabled: false, reason: 'env-off' };
  if (envOn(raw)) return { enabled: true, reason: 'env' };
  if (control && control.error) return { enabled: false, reason: 'control-unread' };
  if (control && control.present && control.enabled === true) return { enabled: true, reason: 'control' };
  if (control && control.present) return { enabled: false, reason: 'control-off' };
  return { enabled: false, reason: 'default-off' };
}

function dryRun(env = process.env) {
  return envOn(env && env.POLY_DRY_RUN);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function gapCents(decision) {
  if (!decision || decision.gapMicro == null) return null;
  return decision.gapMicro / 10000;
}

function referenceCents(decision) {
  if (!decision || decision.referenceMicro == null) return null;
  return decision.referenceMicro / 10000;
}

function triggerName(kind) {
  if (kind === 'trade-through') return 'ws-trade';
  if (kind === 'disconnect' || kind === 'ws-disconnect') return 'ws-disconnect';
  return 'ws-through';
}

function ownBuckets(orders, slug) {
  const ownBids = [];
  const ownOffers = [];
  const prices = [];
  const ids = new Set();
  for (const order of orders || []) {
    if (!order || order.marketSlug !== slug || !(order.leaves > 0)) continue;
    ids.add(order.id);
    if (Number.isFinite(order.yesPrice)) prices.push(order.yesPrice);
    const entry = { yesPrice: order.yesPrice, leaves: order.leaves };
    if (order.bookSide === 'sell') ownOffers.push(entry);
    else if (order.bookSide === 'buy') ownBids.push(entry);
  }
  return { ownBids, ownOffers, prices, ids };
}

function ownFromRows(rows, slug) {
  const ownBids = [];
  const ownOffers = [];
  const prices = [];
  for (const row of rows || []) {
    if (!row || row.market_slug !== slug || row.status !== 'armed') continue;
    const yes = num(row.yes_price);
    const leaves = num(row.contracts);
    if (!(yes > 0) || !(leaves > 0)) continue;
    prices.push(yes);
    const entry = { yesPrice: yes, leaves };
    if (bookSideOf(row.outcome, row.action) === 'sell') ownOffers.push(entry);
    else ownBids.push(entry);
  }
  return { ownBids, ownOffers, prices, ids: new Set() };
}

function lastTradeOf(stats, receivedAt) {
  if (!stats || typeof stats !== 'object') return null;
  const px = amountValue(stats.lastTradePx || stats.last_trade_px);
  if (!(px > 0 && px < 1)) return null;
  const ts = Date.parse(stats.lastTradeSetTime || stats.last_trade_set_time || '');
  return {
    price: px,
    ts: Number.isFinite(ts) ? ts : receivedAt,
    id: `stats:${Number.isFinite(ts) ? ts : receivedAt}:${px}`,
    orderId: '',
  };
}

function topLevels(levels, n = 20) {
  return (levels || []).slice(0, n);
}

function safeError(text, secret) {
  let s = trim(text).replace(/\s+/g, ' ').slice(0, 180);
  if (secret) s = s.split(secret).join('[secret]');
  return s;
}

function createMemoryAudit() {
  const rows = [];
  const last = new Map();
  return {
    rows,
    async record(sample) {
      if (!sample || !sample.orderId) return null;
      const at = Date.parse(sample.checkedAt) || Date.now();
      const key = sample.orderId;
      const prev = last.get(key);
      const replacement = sample.replacementId || '';
      const changed = !prev || prev.trigger !== sample.trigger || prev.action !== sample.action || prev.replacementId !== replacement;
      if (!changed && prev && at - prev.at < AUDIT_GATE_MS) return null;
      last.set(key, { trigger: sample.trigger, action: sample.action, replacementId: replacement, at });
      rows.push({ ...sample });
      return sample;
    },
  };
}

function createSupabaseSide({ env = process.env, client } = {}) {
  let cached = client || null;
  function db() {
    if (cached) return cached;
    const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_KEY;
    if (!url || !key) return null;
    cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return cached;
  }
  const auditLast = new Map();
  let latencyColumn = true;
  return {
    configured() { return !!db(); },
    async readControl() {
      const supabase = db();
      if (!supabase) return { present: false, error: 'no-supabase' };
      const { data, error } = await supabase.from(CONTROL_TABLE).select('enabled').eq('id', 1).maybeSingle();
      if (error) {
        const message = error.message || '';
        if (/desk_protect_ws_control|does not exist|schema cache|PGRST205/i.test(message)) {
          return { present: false };
        }
        return { present: false, error: message };
      }
      if (!data) return { present: false };
      return { present: true, enabled: data.enabled === true };
    },
    async listArmed() {
      const supabase = db();
      if (!supabase) return [];
      const { data, error } = await supabase
        .from(RESTS)
        .select(ARMED_COLUMNS)
        .in('status', ARMED_STATUSES);
      if (error) throw new Error(error.message || 'protect list failed');
      return data || [];
    },
    async claim(orderId, token, { nowIso, fromStatus } = {}) {
      const supabase = db();
      if (!supabase) throw new Error('Protect registry is not configured');
      const { data, error } = await supabase
        .from(RESTS)
        .update({
          status: 'sweeping',
          hold_from: fromStatus,
          sweep_token: token,
          updated_at: nowIso || new Date().toISOString(),
        })
        .eq('order_id', orderId)
        .eq('status', fromStatus)
        .select('*');
      if (error) throw new Error(error.message || 'protect claim failed');
      return (data && data[0]) || null;
    },
    async update(orderId, patch, { token } = {}) {
      const supabase = db();
      if (!supabase) throw new Error('Protect registry is not configured');
      let q = supabase.from(RESTS).update({ ...patch, updated_at: new Date().toISOString() }).eq('order_id', orderId);
      if (token) q = q.eq('sweep_token', token);
      const { data, error } = await q.select('*');
      if (error) throw new Error(error.message || 'protect update failed');
      return (data && data[0]) || null;
    },
    async record(sample) {
      const supabase = db();
      if (!supabase || !sample || !sample.orderId || !sample.ownerEmail) return null;
      const at = Date.parse(sample.checkedAt) || Date.now();
      const prev = auditLast.get(sample.orderId);
      const replacement = sample.replacementId || '';
      const changed = !prev || prev.trigger !== sample.trigger || prev.action !== sample.action || prev.replacementId !== replacement;
      if (!changed && prev && at - prev.at < AUDIT_GATE_MS) return null;
      auditLast.set(sample.orderId, { trigger: sample.trigger, action: sample.action, replacementId: replacement, at });
      const row = {
        order_id: trim(sample.orderId),
        owner_email: trim(sample.ownerEmail).toLowerCase(),
        market_slug: trim(sample.marketSlug),
        checked_at: sample.checkedAt || new Date().toISOString(),
        feed_at: sample.feedAt || null,
        feed_age_ms: Number.isFinite(sample.feedAgeMs) ? Math.round(sample.feedAgeMs) : null,
        order_cents: sample.orderCents == null ? null : sample.orderCents,
        reference_cents: sample.referenceCents == null ? null : sample.referenceCents,
        mid_cents: sample.midCents == null ? null : sample.midCents,
        gap_cents: sample.gapCents == null ? null : sample.gapCents,
        trigger: trim(sample.trigger) || 'ws-through',
        action: trim(sample.action) || 'none',
        cancel_result: sample.cancelResult || null,
        replacement_id: sample.replacementId || null,
      };
      if (latencyColumn && Number.isFinite(sample.latencyMs)) row.latency_ms = Math.round(sample.latencyMs);
      let { error } = await supabase.from(AUDITS).insert(row);
      if (error && row.latency_ms != null && /latency_ms/i.test(error.message || '')) {
        latencyColumn = false;
        delete row.latency_ms;
        ({ error } = await supabase.from(AUDITS).insert(row));
      }
      if (error) throw new Error(error.message || 'protect audit insert failed');
      return sample;
    },
  };
}

function createDeskProtectWs(opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now || Date.now;
  const log = opts.log || ((m) => console.log(`[${MODE}] ${m}`));
  const logError = opts.logError || ((m) => console.error(`[${MODE}] ${m}`));
  const side = opts.side || createSupabaseSide({ env });
  const audits = opts.audits || side;
  const store = opts.store || side;
  const http = opts.client || null;
  const fetchImpl = opts.fetchImpl || fetch;
  const silentMs = opts.silentMs || clampSilentMs(env.DESK_PROTECT_WS_SILENT_MS);
  const sweepCfg = readDeskProtectConfig(env);

  let rows = [];
  let control = { present: false };
  let flag = resolveWsProtectEnabled({ env, control });
  let orders = [];
  let ordersKnown = false;
  const ownFillIds = new Set();
  const books = new Map();
  const seenTrades = new Set();
  const firing = new Set();
  const slugSince = new Map();
  const handoffAt = new Map();
  let wantFeed = false;
  let stopped = false;
  let pollTimer = null;
  let beatTimer = null;
  let silenceTimer = null;
  let lastErrorAt = -Infinity;
  let handoffWarned = false;
  const decisions = [];

  const feed = opts.feed || createMarketFeed({
    keyId: env.POLYMARKET_KEY_ID,
    secretKey: env.POLYMARKET_SECRET_KEY,
    WebSocketImpl: opts.WebSocketImpl,
    now,
    onBook: (book, at) => { onBook(book, at); },
    onTrade: (trade, at) => { onTrade(trade, at); },
    onOrders: (list, info) => { applyOrders(list, info); },
    onExecution: (exec) => { noteExecution(exec); },
    onStatus: (s) => { onFeedStatus(s); },
  });

  function noteError(msg) {
    const t = now();
    if (t - lastErrorAt < ERROR_LOG_MS) return;
    lastErrorAt = t;
    logError(safeError(msg, sweepCfg.secret));
  }

  function armedPolymarket() {
    return rows.filter((row) => row && row.status === 'armed' && isPolymarketSlug(row.market_slug));
  }

  function syncFeed() {
    if (stopped || !flag.enabled || dryRun(env)) {
      wantFeed = false;
      feed.stop();
      return;
    }
    const slugs = [...new Set(armedPolymarket().map((row) => String(row.market_slug).trim()))];
    if (!slugs.length) {
      wantFeed = false;
      feed.stop();
      slugSince.clear();
      return;
    }
    const keep = new Set(slugs);
    for (const slug of [...slugSince.keys()]) if (!keep.has(slug)) slugSince.delete(slug);
    const t = now();
    for (const slug of slugs) if (!slugSince.has(slug)) slugSince.set(slug, t);
    wantFeed = true;
    feed.setSlugs(slugs);
  }

  async function refreshControl() {
    if (opts.control != null) {
      control = opts.control;
    } else if (side && side.readControl) {
      try { control = await side.readControl(); } catch (err) {
        control = { present: false, error: err && err.message };
      }
    }
    const next = resolveWsProtectEnabled({ env, control });
    const changed = next.enabled !== flag.enabled || next.reason !== flag.reason;
    flag = next;
    if (changed) log(`flag ${flag.enabled ? 'on' : 'off'} (${flag.reason})`);
  }

  async function refreshOrders() {
    const client = http;
    if (!client || typeof client.listOpenOrders !== 'function') return;
    try {
      const payload = await client.listOpenOrders();
      orders = ordersFromPayload(payload);
      ordersKnown = true;
    } catch (err) {
      noteError(`open orders: ${err && err.message ? err.message : err}`);
    }
  }

  function applyOrders(list, info) {
    if (!list) return;
    if (info && info.full) {
      orders = list.slice();
      ordersKnown = true;
      return;
    }
    const byId = new Map(orders.map((order) => [order.id, order]));
    for (const order of list) {
      if (!order || !order.id) continue;
      if (order.gone || !(order.leaves > 0)) byId.delete(order.id);
      else byId.set(order.id, order);
    }
    orders = [...byId.values()];
    if (list.length) ordersKnown = true;
  }

  function noteExecution(exec) {
    const id = exec && exec.orderId;
    if (!id) return;
    ownFillIds.add(id);
    const found = orders.find((order) => order.id === id);
    if (!found) return;
    const shares = Number(exec.lastShares);
    if (Number.isFinite(shares) && shares > 0) found.leaves = Math.max(0, found.leaves - shares);
    if (!(found.leaves > 0)) orders = orders.filter((order) => order.id !== id);
  }

  async function refreshArmed() {
    await refreshControl();
    if (!flag.enabled) {
      rows = [];
      syncFeed();
      return { enabled: false, reason: flag.reason };
    }
    try {
      const listed = opts.listArmed ? await opts.listArmed() : await store.listArmed();
      rows = (listed || []).filter((row) => row && isPolymarketSlug(row.market_slug));
    } catch (err) {
      noteError(`armed list: ${err && err.message ? err.message : err}`);
    }
    if (flag.enabled && !dryRun(env)) await refreshOrders();
    syncFeed();
    for (const row of rows) {
      if (row.status === 'pending_lineage') await handoff(row, { trigger: 'ws-through', retry: true });
      if (row.status === 'pending_book') {
        const book = books.get(row.market_slug);
        if (book) await handoff(row, { trigger: 'ws-through', book, retry: true });
      }
    }
    return { enabled: true, armed: armedPolymarket().length };
  }

  function maskFor(slug) {
    if (ordersKnown) return { ...ownBuckets(orders, slug), known: true };
    return { ...ownFromRows(rows, slug), known: false };
  }

  function sample(row, book, decision, extra) {
    const yes = num(row && row.yes_price);
    const feedMs = book && book.transactTime ? Date.parse(String(book.transactTime).replace(/(\.\d{3})\d+Z$/, '$1Z')) : NaN;
    return {
      orderId: row.order_id,
      ownerEmail: row.owner_email,
      marketSlug: row.market_slug,
      feedAt: Number.isFinite(feedMs) ? new Date(feedMs).toISOString() : null,
      feedAgeMs: Number.isFinite(feedMs) ? now() - feedMs : null,
      orderCents: yes == null ? null : yes * 100,
      referenceCents: referenceCents(decision),
      gapCents: gapCents(decision),
      checkedAt: new Date(now()).toISOString(),
      ...extra,
    };
  }

  async function audit(row, book, decision, extra) {
    try {
      const saved = await audits.record(sample(row, book, decision, extra));
      if (saved) decisions.push(saved);
    } catch (err) {
      noteError(`audit: ${err && err.message ? err.message : err}`);
    }
  }

  async function cancelClaimed(row, token, eventAt) {
    const client = http;
    if (!client || typeof client.cancelOrder !== 'function') {
      throw new Error('no polymarket client');
    }
    try {
      const res = await client.cancelOrder(row.order_id, row.market_slug);
      const code = res && res.statusCode;
      return { ok: true, cancelResult: code === 404 ? 'http-404' : 'ok', latencyMs: now() - eventAt };
    } catch (err) {
      const code = Number(err && err.statusCode);
      if (code === 404 || code === 409) {
        return { ok: true, cancelResult: `http-${code}`, latencyMs: now() - eventAt };
      }
      return { ok: false, cancelResult: `http-${code || 0}`, error: err && err.message, latencyMs: now() - eventAt };
    }
  }

  async function handoff(row, { trigger, book, tradeYes, latencyMs, retry } = {}) {
    const prev = handoffAt.get(row.order_id) || 0;
    if (prev && now() - prev < 2000) return { skipped: 'backoff' };
    handoffAt.set(row.order_id, now());
    if (!sweepCfg.enabled) {
      if (!handoffWarned) {
        handoffWarned = true;
        log('re-rest left to the 1.5s sweep (DESK_PROTECT_SWEEP_URL unset on this process)');
      }
      return { skipped: 'no-sweep-url' };
    }
    const marketData = book ? {
      marketSlug: row.market_slug,
      bids: topLevels(book.bids),
      offers: topLevels(book.offers),
      stats: book.stats || null,
      transactTime: book.transactTime || null,
    } : null;
    try {
      const res = await fetchImpl(sweepCfg.url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          [SECRET_HEADER]: sweepCfg.secret,
        },
        body: JSON.stringify({
          op: 'ws-replace',
          mode: 'adverse-only',
          orderId: row.order_id,
          trigger,
          canceled: true,
          latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
          tradeYes: tradeYes == null ? null : tradeYes,
          book: marketData ? { marketData } : null,
        }),
      });
      const status = res && res.status;
      if (status < 200 || status >= 300) {
        const text = res && typeof res.text === 'function' ? await res.text() : '';
        noteError(`ws-replace HTTP ${status} ${safeError(text, sweepCfg.secret)}`);
        handoffAt.delete(row.order_id);
        return { ok: false, status };
      }
      let json = null;
      try { json = await res.json(); } catch (_) { json = null; }
      if (!retry) log(`handoff ${row.order_id} ${trigger} ${json && json.actions && json.actions[0] ? json.actions[0].result || json.actions[0].reason : 'ok'}`);
      return json || { ok: true };
    } catch (err) {
      noteError(`ws-replace: ${err && err.message ? err.message : err}`);
      handoffAt.delete(row.order_id);
      return { ok: false };
    }
  }

  async function fire(row, decision, { book, eventAt, kind, tradeYes } = {}) {
    const id = row.order_id;
    if (!id || firing.has(id)) return { skipped: 'in-flight' };
    if (row.status !== 'armed') return { skipped: row.status };
    if (!flag.enabled || dryRun(env)) {
      if (dryRun(env)) log(`dry run would cancel ${id} ${triggerName(kind)}`);
      return { skipped: 'off' };
    }
    firing.add(id);
    const token = crypto.randomUUID();
    const trigger = triggerName(kind || (decision && decision.reason));
    try {
      const claimed = await store.claim(id, token, { nowIso: new Date(now()).toISOString(), fromStatus: 'armed' });
      if (!claimed) return { skipped: 'unclaimed' };
      const cancelled = await cancelClaimed(claimed, token, eventAt);
      if (!cancelled.ok) {
        await store.update(id, { status: 'armed', sweep_token: null, hold_from: null }, { token });
        await audit(claimed, book, decision, {
          trigger,
          action: 'cancel-failed',
          cancelResult: cancelled.cancelResult,
          latencyMs: cancelled.latencyMs,
        });
        logError(`cancel failed ${id} ${cancelled.cancelResult}`);
        return { ok: false };
      }
      const blind = trigger === 'ws-disconnect';
      const next = blind ? 'pending_book' : 'pending_lineage';
      const moved = await store.update(id, {
        status: next,
        sweep_token: null,
        hold_from: null,
        cooldown_until: null,
      }, { token });
      if (moved) row.status = next;
      claimed.status = next;
      await audit(claimed, book, decision, {
        trigger,
        action: 'cancelled',
        cancelResult: cancelled.cancelResult,
        latencyMs: cancelled.latencyMs,
      });
      log(`cancel ${id} ${trigger} ${cancelled.latencyMs}ms ${cancelled.cancelResult}`);
      if (!moved) return { ok: true, handed: false };
      if (!blind) await handoff(claimed, { trigger, book, tradeYes, latencyMs: cancelled.latencyMs });
      return { ok: true, latencyMs: cancelled.latencyMs, trigger };
    } catch (err) {
      noteError(`fire ${id}: ${err && err.message ? err.message : err}`);
      return { ok: false };
    } finally {
      firing.delete(id);
    }
  }

  async function considerBook(row, book, eventAt) {
    const mask = maskFor(row.market_slug);
    if (!mask.known) {
      await audit(row, book, { reason: 'own-unknown' }, { trigger: 'ws-through', action: 'none' });
      return;
    }
    const feedAt = book.transactTime ? Date.parse(book.transactTime) : NaN;
    const decision = evaluateBookProtect({
      outcome: row.outcome,
      action: row.action,
      yesPrice: num(row.yes_price),
      bids: book.bids,
      offers: book.offers,
      ownBids: mask.ownBids,
      ownOffers: mask.ownOffers,
      xCents: num(row.x_cents),
      feedAgeMs: Number.isFinite(feedAt) ? eventAt - feedAt : null,
      receivedAgeMs: 0,
    });
    if (!decision.fire) {
      await audit(row, book, decision, { trigger: decision.reason === 'through' ? 'ws-through' : (decision.reason || 'inside'), action: 'none' });
      const print = lastTradeOf(book.stats, eventAt);
      if (print) await considerTrade(row, { ...print, slug: row.market_slug }, book, eventAt);
      return;
    }
    await fire(row, decision, { book, eventAt, kind: 'through' });
  }

  async function considerTrade(row, trade, book, eventAt) {
    if (!trade || trade.slug !== row.market_slug) return;
    const key = trade.id || `${trade.slug}|${trade.ts}|${trade.price}`;
    if (seenTrades.has(key + '|' + row.order_id)) return;
    seenTrades.add(key + '|' + row.order_id);
    while (seenTrades.size > 4000) {
      const first = seenTrades.values().next().value;
      seenTrades.delete(first);
    }
    const mask = ordersKnown ? ownBuckets(orders, row.market_slug) : ownFromRows(rows, row.market_slug);
    if (trade.orderId && (ownFillIds.has(trade.orderId) || mask.ids.has(trade.orderId))) {
      await audit(row, book, { reason: 'own-fill' }, { trigger: 'ws-trade', action: 'none' });
      return;
    }
    const decision = evaluateTradeProtect({
      outcome: row.outcome,
      action: row.action,
      yesPrice: num(row.yes_price),
      tradeYes: trade.price,
      tradeAtMs: trade.ts == null ? eventAt : trade.ts,
      nowMs: eventAt,
      xCents: num(row.x_cents),
      ownYesPrices: mask.prices,
    });
    if (!decision.fire) {
      await audit(row, book, decision, { trigger: 'ws-trade', action: 'none' });
      return;
    }
    await fire(row, decision, { book, eventAt, kind: 'trade-through', tradeYes: trade.price });
  }

  async function onBook(book, at) {
    if (stopped || !flag.enabled || !book || !book.slug) return;
    const eventAt = at || now();
    books.set(book.slug, { ...book, receivedAt: eventAt });
    slugSince.set(book.slug, 0);
    const mine = armedPolymarket().filter((row) => row.market_slug === book.slug);
    for (const row of mine) await considerBook(row, books.get(book.slug), eventAt);
    for (const row of rows) {
      if (row.status === 'pending_book' && row.market_slug === book.slug) {
        await handoff(row, { trigger: 'ws-through', book: books.get(book.slug) });
      }
    }
  }

  async function onTrade(trade, at) {
    if (stopped || !flag.enabled || !trade) return;
    const eventAt = at || now();
    const book = books.get(trade.slug) || null;
    const mine = armedPolymarket().filter((row) => row.market_slug === trade.slug);
    for (const row of mine) await considerTrade(row, trade, book, eventAt);
  }

  async function failSafe(reasonAt) {
    const eventAt = reasonAt || now();
    const mine = armedPolymarket();
    for (const row of mine) {
      await fire(row, { reason: 'ws-disconnect', referenceMicro: null, gapMicro: null }, {
        book: books.get(row.market_slug) || null,
        eventAt,
        kind: 'disconnect',
      });
    }
  }

  function onFeedStatus(state) {
    if (state === 'closed' && wantFeed && !stopped) failSafe(now());
    if (state === 'open' || state === 'closed' || state === 'error') log(`ws ${state}`);
  }

  async function checkSilence() {
    if (stopped || !wantFeed || !flag.enabled) return;
    const mine = armedPolymarket();
    if (!mine.length) return;
    const st = feed.stats();
    const t = now();
    if (!st.open) {
      if (st.everOpened) await failSafe(t);
      return;
    }
    const pongAt = st.lastPongAt || 0;
    const msgAt = st.lastMessageAt || 0;
    const pongAge = pongAt ? t - pongAt : Infinity;
    const msgAge = msgAt ? t - msgAt : Infinity;
    if (pongAge <= silentMs) {
      for (const row of mine) {
        const since = slugSince.get(row.market_slug) || 0;
        if (since > 0 && t - since > silentMs && !books.has(row.market_slug)) {
          await fire(row, { reason: 'ws-disconnect' }, { eventAt: t, kind: 'disconnect' });
        }
      }
      return;
    }
    if (Math.min(pongAge, msgAge) > silentMs) await failSafe(t);
  }

  function pollDelay() {
    if (!flag.enabled) return opts.flagPollMs || POLL_OFF_MS;
    return opts.armMs || ARM_MS;
  }

  function heartbeat() {
    const st = feed.stats();
    const age = st.lastMessageAt ? now() - st.lastMessageAt : null;
    log(`heartbeat flag=${flag.enabled ? 'on' : 'off'} reason=${flag.reason} armed=${armedPolymarket().length} ws=${st.open ? 'open' : 'closed'} lastMsgAgeMs=${age == null ? '-' : age}`);
  }

  // Ref'd on purpose. An unref'd timer plus a closed socket lets Node exit 0
  // while nothing is armed, and a rest armed later is never watched.
  function armPoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (stopped || opts.timers === false) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      refreshArmed()
        .catch((err) => noteError(err && err.message))
        .then(() => { if (!stopped) armPoll(); });
    }, pollDelay());
  }

  function holdsProcess() {
    const refd = (timer) => !!(timer && typeof timer.hasRef === 'function' && timer.hasRef());
    return refd(pollTimer) || refd(beatTimer);
  }

  function start() {
    stopped = false;
    log(`starting silentMs=${silentMs} flag=${flag.reason}`);
    if (opts.timers !== false) {
      beatTimer = setInterval(() => heartbeat(), opts.heartbeatMs || HEARTBEAT_MS);
      silenceTimer = setInterval(() => { checkSilence().catch((err) => noteError(err && err.message)); }, opts.silenceCheckMs || SILENCE_CHECK_MS);
    }
    refreshArmed()
      .catch((err) => noteError(err && err.message))
      .then(() => { if (!stopped) armPoll(); });
    return { enabled: flag.enabled };
  }

  function stop() {
    stopped = true;
    wantFeed = false;
    feed.stop();
    if (pollTimer) clearTimeout(pollTimer);
    if (beatTimer) clearInterval(beatTimer);
    if (silenceTimer) clearInterval(silenceTimer);
    pollTimer = null;
    beatTimer = null;
    silenceTimer = null;
  }

  return {
    start,
    stop,
    refreshArmed,
    onBook,
    onTrade,
    checkSilence,
    heartbeat,
    failSafe,
    flag: () => ({ ...flag }),
    nextPollMs: () => pollDelay(),
    holdsProcess,
    decisions: () => decisions.slice(),
    stats: () => ({
      armed: armedPolymarket().length,
      ordersKnown,
      books: books.size,
      ...feed.stats(),
    }),
  };
}

if (require.main === module) {
  const env = process.env;
  let http = null;
  if (!trim(env.POLYMARKET_KEY_ID) || !trim(env.POLYMARKET_SECRET_KEY)) {
    console.error(`[${MODE}] Polymarket keys are not in this process. Staying up and polling; no market socket until the keys are present.`);
  } else {
    http = createPolymarketHttp({
      keyId: env.POLYMARKET_KEY_ID,
      secretKey: env.POLYMARKET_SECRET_KEY,
    });
  }
  const engine = createDeskProtectWs({ client: http });
  engine.start();
  const shutdown = () => {
    engine.stop();
    try { http.close && http.close(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (err) => {
    console.error(`[${MODE}] unhandled`, err && err.message ? err.message : err);
  });
}

module.exports = {
  ARM_MS,
  POLL_OFF_MS,
  HEARTBEAT_MS,
  ARMED_COLUMNS,
  ARMED_STATUSES,
  DEFAULT_SILENT_MS,
  resolveWsProtectEnabled,
  createDeskProtectWs,
  createMemoryAudit,
  createSupabaseSide,
};
