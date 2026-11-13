// Novig V3 RFQ maker for Combo Locks.
//
// One signed socket (GET /rfq/v3/ws). Subscribe to rfq, quotes, and executions.
// The first quote stands; there is no update or cancel. Auction is 3s.
// quote_accepted must be confirmed within 1s. Events are not replayed: on
// reconnect, backfill GET /rfq/v3/executions.
//
// Live sends are off unless NOVIG_RFQ_LIVE=1 and NOVIG_DRY_RUN is not 1.
// Dry run is the default and blocks every quote and confirm. Shadow mode
// (default on) still opens the socket, resolves legs, and records what we
// would have quoted. A trading::read key is enough for shadow.
//
// Reserve the full payout (maxWager / price) in combo_venue_holds before the
// quote leaves. Confirm is then automatic. A hard fault (game started, stale
// socket or catalog, missing hold, kill switch, lock pause) rejects the last
// look and pauses quoting. COMBO_CAP_AT_CONFIRM does not apply.
'use strict';

const crypto = require('crypto');
const {
  novigKey,
  signedHeaders,
  novigHttpBase,
  novigRfqWsUrl,
} = require('./novig-sign');
const {
  quotePriceFromAmerican,
  milliFromDecimal,
  priceFromMilli,
  americanFromMilli,
  formatAmerican,
  collateralForWager,
  moneyString,
  decimalToNumber,
  maxWagerFor,
  payoutContracts,
  readCaps,
} = require('./novig-price');
const {
  indexNovigCatalog,
  indexLocks,
  matchOutcomes,
  leaguesForParlays,
} = require('./novig-legs');
const { liveRunnerFillRow } = require('./fills-attr');
const { formatAlertStatus } = require('./venue-alert');
const { findStartedEvent } = require('./started');

const CONFIRM_MS = 1000;
const PAUSE_MS = 5 * 60 * 1000;
const CATALOG_STALE_MS_DEFAULT = 8000;
const SOCKET_STALE_MS_DEFAULT = 20000;
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

function flagOn(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function sendsBlocked(env = process.env) {
  const src = env || {};
  const dry = flagOn(src.NOVIG_DRY_RUN, true);
  const live = flagOn(src.NOVIG_RFQ_LIVE, false);
  return { dry, live, blocked: dry || !live };
}

function numEnv(env, name, fallback) {
  const n = Number(env && env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function createNovigQuoter(ctx = {}) {
  const env = ctx.env || process.env;
  const caps = readCaps(env);
  const now = ctx.now || Date.now;
  const log = ctx.log || ((m) => console.log(`[NOVIG] ${m}`));
  const alert = ctx.alert || (() => {});
  const quotes = new Map();
  const looks = [];
  const shadow = new Map();
  const booked = new Set();
  const stats = {
    rfq: 0, matched: 0, silent: 0, quoted: 0, confirmed: 0, rejected: 0,
    filled: 0, shadow: 0, paused: 0,
  };
  let nonce = 0;
  let pauseUntil = 0;
  let pauseReason = null;
  let quotingEnabled = true;

  function nextNonce() {
    nonce += 1;
    return nonce;
  }

  function fresh(kind) {
    const t = now();
    if (kind === 'catalog') {
      const at = ctx.catalogAt ? ctx.catalogAt() : null;
      const limit = numEnv(env, 'NOVIG_CATALOG_STALE_MS', CATALOG_STALE_MS_DEFAULT);
      if (at == null) return { ok: false, reason: 'catalog_stale' };
      return t - at <= limit ? { ok: true } : { ok: false, reason: 'catalog_stale' };
    }
    const at = ctx.socketAt ? ctx.socketAt() : null;
    const limit = numEnv(env, 'NOVIG_SOCKET_STALE_MS', SOCKET_STALE_MS_DEFAULT);
    if (at == null) return { ok: false, reason: 'socket_stale' };
    return t - at <= limit ? { ok: true } : { ok: false, reason: 'socket_stale' };
  }

  function trailingRate(t) {
    const cut = t - LOOKBACK_MS;
    let counted = 0;
    let confirmed = 0;
    for (const row of looks) {
      if (row.at < cut) continue;
      counted += 1;
      if (row.ok) confirmed += 1;
    }
    return { counted, confirmed, rate: counted ? confirmed / counted : 1 };
  }

  function rateBlocks(t) {
    const rate = trailingRate(t);
    if (rate.counted < caps.confirmMinSample) return null;
    if (rate.rate + 1e-12 < caps.confirmRateFloor) return rate;
    return null;
  }

  function quoteBlock(t) {
    if (pauseReason && String(pauseReason).startsWith('maker_lock') && pauseUntil && t >= pauseUntil) {
      quotingEnabled = true;
      pauseReason = null;
      pauseUntil = 0;
    }
    if (!quotingEnabled) return pauseReason || 'paused';
    const rate = rateBlocks(t);
    if (rate) return 'confirm_rate';
    return null;
  }

  function tripPause(reason, t) {
    if (!quotingEnabled) return;
    pauseReason = reason;
    pauseUntil = (t || now()) + PAUSE_MS;
    quotingEnabled = false;
    stats.paused += 1;
    const text = `${formatAlertStatus('⏸ NOVIG PAUSED', 'novig')}\n${reason}\nquoting stopped`;
    log(text.replace(/\n/g, ' '));
    Promise.resolve(alert(text)).catch(() => {});
  }

  function noteLook(ok, t) {
    looks.push({ at: t || now(), ok: !!ok });
    if (looks.length > 5000) looks.splice(0, looks.length - 4000);
    if (!ok) stats.rejected += 1;
    else stats.confirmed += 1;
    if (quotingEnabled && rateBlocks(t || now())) tripPause('confirm_rate', t || now());
  }

  function ourOpen(parlayId, exceptRfq) {
    let contracts = 0;
    let collateral = 0;
    for (const q of quotes.values()) {
      if (!q.claimed || q.parlayId !== parlayId || q.rfqId === exceptRfq) continue;
      if (q.state === 'dead' || q.state === 'filled') continue;
      contracts += q.contracts;
      collateral += q.collateral;
    }
    return { contracts, collateral };
  }

  function totalOpenCollateral() {
    let n = 0;
    for (const q of quotes.values()) {
      if (q.claimed && q.state !== 'dead' && q.state !== 'filled') n += q.collateral;
    }
    return n;
  }

  function lockAlive(lock) {
    const rows = ctx.getParlays ? ctx.getParlays() : null;
    if (!Array.isArray(rows)) return lock;
    return rows.find((p) => p && p.id === lock.id) || null;
  }

  function hardFault(q, t) {
    if (!q || !q.claimed) return 'hold_missing';
    const cat = fresh('catalog');
    if (!cat.ok) return cat.reason;
    const sock = fresh('socket');
    if (!sock.ok) return sock.reason;
    const live = lockAlive(q.lock);
    if (!live) return 'lock_gone';
    if (ctx.isPaused && ctx.isPaused(live.id)) return 'lock_paused';
    if (ctx.killEngaged && ctx.killEngaged(live.user_id, live)) return 'kill_switch';
    const started = ctx.started ? ctx.started(live) : findStartedEvent(null, live);
    if (started && started.started) return 'game_started';
    if (q.legsStarted) return 'game_started';
    return null;
  }

  function plan(msg, t) {
    stats.rfq += 1;
    const outcomeIds = Array.isArray(msg && msg.outcomeIds) ? msg.outcomeIds.map(String) : [];
    const hit = matchOutcomes(outcomeIds, ctx.outcomeIndex ? ctx.outcomeIndex() : new Map(), ctx.lockIndex ? ctx.lockIndex() : new Map());
    if (!hit.ok) {
      stats.silent += 1;
      return { action: 'silent', reason: hit.reason || 'unknown', rfqId: msg && msg.rfqId };
    }
    stats.matched += 1;
    const lock = hit.lock;
    const american = lock.fill_american;
    const price = quotePriceFromAmerican(american);
    const priceMilli = price ? milliFromDecimal(price) : null;
    const base = {
      action: 'shadow',
      rfqId: String(msg.rfqId),
      outcomeIds,
      lock,
      price,
      priceMilli,
      american: priceMilli ? americanFromMilli(priceMilli) : null,
      fillAmerican: american,
      minWager: decimalToNumber(msg.minWager),
      expiresTs: Number(msg.expiresTs) || null,
      legsStarted: !!hit.started,
    };
    if (!price || priceMilli == null) return { ...base, skip: 'bad_price' };
    if (base.expiresTs && t >= base.expiresTs) return { ...base, skip: 'expired' };
    if (hit.started) return { ...base, skip: 'game_started' };
    const started = ctx.started ? ctx.started(lock) : findStartedEvent(null, lock, null, t);
    if (started && started.started) return { ...base, skip: 'game_started' };
    if (ctx.isPaused && ctx.isPaused(lock.id)) return { ...base, skip: 'lock_paused' };
    if (ctx.killEngaged && ctx.killEngaged(lock.user_id, lock)) return { ...base, skip: 'kill_switch' };
    const cat = fresh('catalog');
    if (!cat.ok) return { ...base, skip: cat.reason };
    const sock = fresh('socket');
    if (!sock.ok) return { ...base, skip: sock.reason };
    const blocked = quoteBlock(t);
    if (blocked) return { ...base, skip: blocked };
    const filled = ctx.filledFor ? Number(ctx.filledFor(lock.id)) || 0 : 0;
    const other = ctx.otherHeld ? Number(ctx.otherHeld(lock.id)) || 0 : 0;
    const open = ourOpen(lock.id);
    const maxContracts = Number(lock.max_contracts);
    const remaining = (Number.isFinite(maxContracts) ? maxContracts : 0) - filled - other - open.contracts;
    const bal = ctx.balance ? ctx.balance() : null;
    const liveSend = !sendsBlocked(env).blocked;
    let freeBalance = null;
    if (bal && Number.isFinite(Number(bal.balance))) {
      const age = bal.at != null ? t - bal.at : 0;
      const staleMs = numEnv(env, 'NOVIG_BALANCE_STALE_MS', 15000);
      if (liveSend && age > staleMs) return { ...base, skip: 'balance_stale' };
      const tied = Number(bal.openCollateral) || 0;
      freeBalance = Math.max(0, Number(bal.balance) - tied - totalOpenCollateral());
    } else if (liveSend) {
      return { ...base, skip: 'balance_unknown' };
    }
    const sized = maxWagerFor({
      priceMilli,
      remainingContracts: remaining,
      freeBalance,
      perQuoteCollateral: caps.perQuoteCollateral,
      perLockCollateral: Math.max(0, caps.perLockCollateral - open.collateral),
      totalCollateral: Math.max(0, caps.totalCollateral - totalOpenCollateral()),
      hardWagerCap: caps.hardWagerCap,
    });
    const wager = sized.wager;
    const collateral = collateralForWager(wager, priceMilli);
    const contracts = payoutContracts(wager, priceMilli);
    const row = {
      ...base,
      maxWager: wager,
      collateral,
      contracts,
      remaining,
      freeBalance,
    };
    if (!(wager > 0)) return { ...row, skip: 'no_size' };
    if (row.minWager != null && wager + 1e-9 < row.minWager) return { ...row, skip: 'below_min_wager' };
    if (sendsBlocked(env).blocked) return { ...row, skip: sendsBlocked(env).dry ? 'dry_run' : 'live_off' };
    return { ...row, action: 'quote', skip: null };
  }

  function shadowRow(p, extra) {
    const prev = shadow.get(p.rfqId) || {};
    const row = {
      rfq_id: p.rfqId,
      outcome_ids: p.outcomeIds || prev.outcome_ids || [],
      parlay_id: p.lock ? p.lock.id : prev.parlay_id || null,
      user_id: p.lock ? p.lock.user_id : prev.user_id || null,
      label: p.lock ? (p.lock.label || null) : prev.label || null,
      would_price: p.price || prev.would_price || null,
      would_american: p.american != null ? p.american : prev.would_american,
      would_max_wager: p.maxWager != null ? p.maxWager : prev.would_max_wager,
      would_collateral: p.collateral != null ? p.collateral : prev.would_collateral,
      min_wager: p.minWager != null ? p.minWager : prev.min_wager,
      skip_reason: p.skip != null ? p.skip : prev.skip_reason,
      executed_price: extra && extra.executed_price != null ? extra.executed_price : (prev.executed_price || null),
      executed_wager: extra && extra.executed_wager != null ? extra.executed_wager : (prev.executed_wager ?? null),
      would_win: extra && Object.prototype.hasOwnProperty.call(extra, 'would_win') ? extra.would_win : (prev.would_win ?? null),
      detail: {
        fill_american: p.fillAmerican != null ? p.fillAmerican : (prev.detail && prev.detail.fill_american),
        contracts: p.contracts != null ? p.contracts : (prev.detail && prev.detail.contracts),
        remaining: p.remaining != null ? p.remaining : (prev.detail && prev.detail.remaining),
      },
    };
    if (row.would_price && row.executed_price && row.would_win == null) {
      const ours = milliFromDecimal(row.would_price);
      const exec = milliFromDecimal(row.executed_price);
      row.would_win = ours == null || exec == null ? null : (ours < exec ? true : ours > exec ? false : null);
    }
    shadow.set(p.rfqId, row);
    return row;
  }

  function emitShadow(p, extra) {
    if (!flagOn(env.NOVIG_SHADOW, true)) return null;
    const row = shadowRow(p, extra);
    stats.shadow += 1;
    const am = row.would_american != null ? formatAmerican(row.would_american) : '';
    log(
      `shadow rfq=${row.rfq_id} lock=${row.label || row.parlay_id || '?'} ` +
      `price=${row.would_price || '-'} ${am} maxWager=${row.would_max_wager == null ? '-' : row.would_max_wager} ` +
      `skip=${row.skip_reason || 'quote'}`
    );
    const write = ctx.shadowWrite
      || (ctx.supabase ? ((r) => ctx.supabase.from('combo_novig_shadow').upsert(r, { onConflict: 'rfq_id' })) : null);
    if (write) Promise.resolve(write(row)).catch((e) => log(`shadow write failed ${e && e.message}`));
    return row;
  }

  async function release(q) {
    if (!q || !q.claimed) return;
    q.claimed = false;
    q.state = q.state === 'filled' ? 'filled' : 'dead';
    if (!ctx.release) return;
    try {
      await ctx.release({ parlayId: q.parlayId, quoteId: q.clientId });
    } catch (e) {
      log(`hold release failed rfq=${q.rfqId} ${e && e.message}`);
    }
  }

  async function onRfqCreated(msg) {
    const t = now();
    const p = plan(msg, t);
    if (p.action === 'silent') return p;
    if (p.action !== 'quote') {
      emitShadow(p);
      return p;
    }
    const clientId = crypto.randomUUID();
    const quote = {
      rfqId: p.rfqId,
      clientId,
      quoteId: null,
      lock: p.lock,
      parlayId: p.lock.id,
      price: p.price,
      priceMilli: p.priceMilli,
      american: p.american,
      fillAmerican: p.fillAmerican,
      maxWager: p.maxWager,
      collateral: p.collateral,
      contracts: p.contracts,
      outcomeIds: p.outcomeIds,
      claimed: false,
      state: 'pending',
      legsStarted: p.legsStarted,
    };
    let claimed;
    try {
      claimed = await ctx.claim({
        parlayId: quote.parlayId,
        quoteId: clientId,
        size: quote.contracts,
        meta: { label: p.lock.label || null, rfqId: p.rfqId, maxWager: p.maxWager, price: p.price },
      });
    } catch (e) {
      emitShadow({ ...p, skip: 'hold_failed' });
      log(`hold failed rfq=${p.rfqId} ${e && e.message}`);
      return { ...p, skip: 'hold_failed' };
    }
    if (!claimed || claimed.ok === false) {
      emitShadow({ ...p, skip: 'hold_failed' });
      return { ...p, skip: 'hold_failed' };
    }
    const other = Number(claimed.other) || 0;
    const filled = ctx.filledFor ? Number(ctx.filledFor(quote.parlayId)) || 0 : 0;
    const maxContracts = Number(p.lock.max_contracts);
    if (Number.isFinite(maxContracts) && filled + other + quote.contracts > maxContracts + 1e-6) {
      quote.claimed = true;
      await release(quote);
      emitShadow({ ...p, skip: 'cap' });
      return { ...p, skip: 'cap' };
    }
    quote.claimed = true;
    quote.state = 'quoted';
    quotes.set(quote.rfqId, quote);
    const frame = {
      nonce: nextNonce(),
      quote: {
        rfqId: quote.rfqId,
        price: quote.price,
        maxWager: moneyString(quote.maxWager),
        clientId,
      },
    };
    try {
      ctx.send(frame);
    } catch (e) {
      await release(quote);
      tripPause('send_fault', t);
      emitShadow({ ...p, skip: 'send_fault' });
      return { ...p, skip: 'send_fault' };
    }
    stats.quoted += 1;
    const am = formatAmerican(quote.american);
    log(`QUOTED rfq=${quote.rfqId} lock=${p.lock.label || p.lock.id} price=${quote.price} ${am} maxWager=${frame.quote.maxWager} collateral=${quote.collateral.toFixed(2)}`);
    Promise.resolve(alert(
      `${formatAlertStatus('✅ QUOTED', 'novig')} — ${p.lock.label || p.lock.id}\n` +
      `${am} · stake up to $${frame.quote.maxWager}\nrfq ${quote.rfqId}`
    )).catch(() => {});
    emitShadow({ ...p, skip: null });
    return { ...p, action: 'quoted', clientId };
  }

  function sendConfirm(q, msg, confirmed, t) {
    const quoteId = (msg && msg.quoteId) || q.quoteId;
    if (!quoteId) return false;
    const frame = {
      nonce: nextNonce(),
      confirm: { rfqId: q.rfqId, quoteId, confirmed: !!confirmed },
    };
    ctx.send(frame);
    q.confirmed = !!confirmed;
    q.state = confirmed ? 'accepted' : 'dead';
    if (!confirmed) q.claimed = q.claimed;
    return true;
  }

  function onQuoteAccepted(msg, receivedAt) {
    const t = receivedAt != null ? receivedAt : now();
    const q = quotes.get(String(msg && msg.rfqId));
    if (!q) return { action: 'ignore' };
    if (msg.quoteId) q.quoteId = msg.quoteId;
    const eventTs = Number(msg.ts);
    const base = Number.isFinite(eventTs) ? Math.min(eventTs, t) : t;
    const deadline = base + CONFIRM_MS;
    const fault = hardFault(q, t);
    if (fault) {
      if (t < deadline && !sendsBlocked(env).blocked) {
        try { sendConfirm(q, msg, false, t); } catch (_) { /* still a miss */ }
      }
      noteLook(false, t);
      tripPause(fault, t);
      release(q);
      log(`CONFIRM REJECT rfq=${q.rfqId} ${fault}`);
      return { action: 'reject', reason: fault };
    }
    if (t >= deadline) {
      noteLook(false, t);
      tripPause('confirm_deadline', t);
      release(q);
      log(`CONFIRM MISS rfq=${q.rfqId} deadline`);
      return { action: 'miss', reason: 'confirm_deadline' };
    }
    if (sendsBlocked(env).blocked) {
      noteLook(false, t);
      tripPause(sendsBlocked(env).dry ? 'dry_run' : 'live_off', t);
      release(q);
      return { action: 'blocked' };
    }
    try {
      sendConfirm(q, msg, true, t);
    } catch (e) {
      noteLook(false, t);
      tripPause('send_fault', t);
      release(q);
      return { action: 'reject', reason: 'send_fault' };
    }
    noteLook(true, t);
    const am = formatAmerican(q.american);
    log(`CONFIRM rfq=${q.rfqId} wager=${msg.wager || '?'} price=${q.price} ${am}`);
    Promise.resolve(alert(
      `${formatAlertStatus('✅ CONFIRM', 'novig')} — ${q.lock && q.lock.label || q.parlayId}\n` +
      `stake $${msg.wager || '?'} @ ${am}`
    )).catch(() => {});
    return { action: 'confirm', deadline };
  }

  async function bookFill(q, evt) {
    if (!q || booked.has(q.rfqId)) return { status: 'exists' };
    const wager = decimalToNumber(evt && (evt.wager || evt.userCost)) || q.maxWager;
    const priceMilli = milliFromDecimal((evt && evt.price) || q.price) || q.priceMilli;
    const cost = decimalToNumber(evt && evt.cost);
    const payout = cost != null && wager != null
      ? Math.round((wager + cost) * 100) / 100
      : payoutContracts(wager, priceMilli);
    const quoteId = (evt && evt.quoteId) || q.quoteId || q.clientId;
    const fill = liveRunnerFillRow({
      quoteId: q.clientId,
      orderId: quoteId,
      fillId: `novig:${q.rfqId}`,
      parlayId: q.parlayId,
      count: payout,
      ticker: null,
      rfqId: q.rfqId,
      label: q.lock && q.lock.label,
      venue: 'novig',
      source: 'novig-rfq',
      yesPrice: priceFromMilli(priceMilli),
      fee: 0,
    });
    if (ctx.supabase) {
      const sb = ctx.supabase;
      const { error: fillErr } = await sb.from('combo_fills').upsert(fill, { onConflict: 'fill_id' });
      if (fillErr) {
        log(`combo_fills failed ${fillErr.message}`);
        return { status: 'error' };
      }
      const { error: subErr } = await sb.from('combo_submissions').insert({
        user_id: q.lock && q.lock.user_id,
        parlay_id: q.parlayId,
        rfq_id: q.rfqId,
        label: q.lock && q.lock.label,
        contracts: payout,
        status: 'filled',
        quote_id: q.clientId,
        order_id: quoteId,
        is_live: true,
        venue: 'novig',
        fill_american: q.fillAmerican,
      });
      if (subErr) log(`combo_submissions failed ${subErr.message}`);
    }
    booked.add(q.rfqId);
    q.state = 'filled';
    stats.filled += 1;
    if (ctx.onFill) {
      try { ctx.onFill({ parlayId: q.parlayId, contracts: payout, rfqId: q.rfqId }); } catch (_) { /* local */ }
    }
    await release(q);
    const am = formatAmerican(americanFromMilli(priceMilli));
    log(`FILL rfq=${q.rfqId} payout=${payout} price=${priceFromMilli(priceMilli)} ${am}`);
    Promise.resolve(alert(
      `${formatAlertStatus('💰 FILL', 'novig')} — ${q.lock && q.lock.label || q.parlayId}\n` +
      `${am} · payout $${payout}`
    )).catch(() => {});
    return { status: 'new', payout, fill };
  }

  async function onQuoteExecuted(msg) {
    const q = quotes.get(String(msg && msg.rfqId));
    if (!q) return { status: 'unknown' };
    const out = await bookFill(q, msg);
    return out;
  }

  async function onTerminal(msg, state) {
    const q = quotes.get(String(msg && msg.rfqId));
    if (!q || q.state === 'filled') return;
    q.state = state;
    await release(q);
  }

  function noteTape(msg) {
    const rfqId = String(msg && msg.rfqId || '');
    if (!rfqId) return;
    const price = msg.price != null ? String(msg.price) : null;
    const wager = decimalToNumber(msg.wager);
    const prev = shadow.get(rfqId);
    if (!prev && !quotes.has(rfqId)) return;
    const ours = prev && prev.would_price ? milliFromDecimal(prev.would_price) : null;
    const exec = price ? milliFromDecimal(price) : null;
    const would = ours == null || exec == null ? null : (ours < exec ? true : ours > exec ? false : null);
      if (prev) {
        prev.executed_price = price;
        prev.executed_wager = wager;
        prev.would_win = would;
        shadow.set(rfqId, prev);
        const write = () => {
          if (ctx.shadowWrite) return ctx.shadowWrite(prev);
          if (flagOn(env.NOVIG_SHADOW, true) && ctx.supabase) {
            return ctx.supabase.from('combo_novig_shadow').upsert(prev, { onConflict: 'rfq_id' });
          }
          return null;
        };
        Promise.resolve().then(write).catch((e) => log(`shadow tape failed ${e && e.message}`));
      }
    const off = Number(msg.offset);
    if (Number.isFinite(off)) {
      if (quoterOffset != null && off > quoterOffset + 1 && ctx.onExecutionGap) ctx.onExecutionGap(quoterOffset, off);
      quoterOffset = off;
    }
  }

  let quoterOffset = null;

  async function reconcileExecutions(items) {
    const out = [];
    for (const item of items || []) {
      if (!item || !item.rfqId) continue;
      noteTape({
        rfqId: item.rfqId,
        price: item.price,
        wager: item.userCost != null ? item.userCost : item.wager,
      });
      const q = quotes.get(String(item.rfqId));
      if (!q || booked.has(q.rfqId)) continue;
      out.push(await bookFill(q, {
        rfqId: item.rfqId,
        quoteId: q.quoteId,
        price: item.price,
        wager: item.userCost,
        cost: item.cost,
      }));
    }
    return out;
  }

  function onFrame(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.code) {
      log(`socket error ${msg.code}`);
      if (msg.code === 'MAKER_LOCKED' || msg.code === 'READ_ONLY_KEY' || msg.code === 'MAKER_BARRED') {
        tripPause(String(msg.code).toLowerCase(), now());
      }
      return;
    }
    const type = msg.type;
    if (type === 'rfq_created') {
      onRfqCreated(msg).catch((e) => log(`rfq error ${e && e.message}`));
      return;
    }
    if (type === 'quote_created') {
      const q = quotes.get(String(msg.rfqId));
      if (q && msg.quoteId) q.quoteId = msg.quoteId;
      return;
    }
    if (type === 'quote_accepted') {
      onQuoteAccepted(msg);
      return;
    }
    if (type === 'quote_executed') {
      onQuoteExecuted(msg).catch((e) => log(`fill error ${e && e.message}`));
      return;
    }
    if (type === 'quote_unfilled' || type === 'quote_dropped') {
      onTerminal(msg, type).catch(() => {});
      return;
    }
    if (type === 'rfq_closed') {
      const q = quotes.get(String(msg.rfqId));
      if (!q || q.state === 'accepted' || q.state === 'filled' || q.state === 'dead') return;
      const timer = setTimeout(() => {
        if (q.state === 'quoted' || q.state === 'pending') onTerminal(q, 'rfq_closed').catch(() => {});
      }, 2500);
      if (timer.unref) timer.unref();
      return;
    }
    if (type === 'executed') noteTape(msg);
  }

  function applyMaker(body) {
    if (!body) return;
    const lock = body.lock;
    if (lock && lock.source) {
      const until = Number(lock.untilTs);
      if (Number.isFinite(until) && until > now()) pauseUntil = Math.max(pauseUntil, until);
      else pauseUntil = Math.max(pauseUntil, now() + PAUSE_MS);
      pauseReason = `maker_lock:${lock.source}`;
      quotingEnabled = false;
    }
    const standing = body.confirmStanding;
    if (standing && Number(standing.counted) >= caps.confirmMinSample) {
      const rate = Number(standing.confirmed) / Number(standing.counted);
      if (Number.isFinite(rate) && rate + 1e-12 < caps.confirmRateFloor) tripPause('confirm_rate', now());
    }
  }

  return {
    onRfqCreated,
    onQuoteAccepted,
    onQuoteExecuted,
    onTerminal,
    reconcileExecutions,
    onFrame,
    noteTape,
    applyMaker,
    nextNonce,
    plan,
    fresh,
    trailingRate: () => trailingRate(now()),
    paused: () => !!(quoteBlock(now()) || (pauseUntil && now() < pauseUntil) || !quotingEnabled),
    pauseReason: () => pauseReason,
    quotes,
    shadowRows: () => [...shadow.values()],
    stats: () => ({ ...stats, pauseReason, pauseUntil }),
    sendsBlocked: () => sendsBlocked(env),
  };
}

function pageItems(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.items)) return body.items;
  return [];
}

function startNovigRfqLoop(ctx = {}) {
  const env = ctx.env || process.env;
  const log = ctx.log || ((m) => console.log(`[NOVIG] ${m}`));
  const base = novigHttpBase(env);
  const key = ctx.key !== undefined ? ctx.key : novigKey(env);
  let catalogAt = null;
  let socketAt = null;
  let outcomeIndex = new Map();
  let lockIndex = new Map();
  let balance = null;
  let stopped = false;
  let socket = null;
  let reconnectTimer = null;
  let attempt = 0;
  const WebSocketImpl = ctx.WebSocket || require('ws');

  const quoter = createNovigQuoter({
    ...ctx,
    env,
    log,
    now: ctx.now || Date.now,
    catalogAt: () => catalogAt,
    socketAt: () => socketAt,
    outcomeIndex: () => outcomeIndex,
    lockIndex: () => lockIndex,
    balance: () => balance,
    otherHeld: (id) => (ctx.otherHeld ? ctx.otherHeld(id) : 0),
    send: (frame) => {
      const gate = sendsBlocked(env);
      if (gate.blocked && (frame.quote || frame.confirm)) {
        throw new Error(gate.dry ? 'dry_run' : 'live_off');
      }
      if (!socket || socket.readyState !== 1) throw new Error('socket_down');
      socket.send(JSON.stringify(frame));
    },
    onExecutionGap: () => { backfill().catch(() => {}); },
  });

  async function publicGet(pathAndQuery) {
    const fetchImpl = ctx.fetch || fetch;
    const res = await fetchImpl(`${base}${pathAndQuery}`, { headers: { accept: 'application/json' } });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, body };
  }

  async function signedGet(path, query) {
    if (!key || !key.key) return { ok: false, status: 0, body: null };
    const headers = signedHeaders(key, { method: 'GET', path, query: query || '' });
    const fetchImpl = ctx.fetch || fetch;
    const url = `${base}${path}${query ? `?${query}` : ''}`;
    const res = await fetchImpl(url, { headers: { ...headers, accept: 'application/json' } });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, body };
  }

  async function paged(path, query, limitPages) {
    const items = [];
    let after = '';
    for (let i = 0; i < limitPages && !stopped; i += 1) {
      const q = [query, after].filter(Boolean).join('&');
      const res = await (path.startsWith('/v3/public/') ? publicGet(`${path}?${q}`) : signedGet(path, q));
      if (!res.ok) return { ok: false, items, status: res.status };
      items.push(...pageItems(res.body));
      const next = res.body && res.body.next;
      if (!next) return { ok: true, items };
      after = `after=${encodeURIComponent(next)}`;
    }
    return { ok: true, items };
  }

  async function refreshCatalog() {
    const parlays = ctx.getParlays ? ctx.getParlays() : [];
    lockIndex = indexLocks(parlays);
    const leagues = leaguesForParlays(parlays);
    if (!leagues.length) {
      catalogAt = Date.now();
      outcomeIndex = new Map();
      return;
    }
    const merged = new Map();
    for (const league of leagues) {
      if (stopped) return;
      const events = await paged('/v3/public/catalog/events', `league=${encodeURIComponent(league)}&limit=100`, 6);
      const board = await paged('/v3/public/catalog/markets', `league=${encodeURIComponent(league)}&marketType=MONEY,SPREAD,TOTAL&limit=500`, 8);
      if (!events.ok || !board.ok) {
        log(`catalog ${league} not fresh events=${events.status || 'ok'} markets=${board.status || 'ok'}`);
        return;
      }
      const extra = [];
      for (const type of ['TOUCHDOWNS', 'HOME_RUNS']) {
        const prop = await paged('/v3/public/catalog/markets', `league=${encodeURIComponent(league)}&marketType=${type}&limit=500`, 4);
        if (prop.ok) extra.push(...prop.items);
      }
      const indexed = indexNovigCatalog(league, { items: events.items }, { items: board.items.concat(extra) }, Date.now());
      for (const [id, row] of indexed.byOutcome) {
        if (merged.has(id) && row && row.key && merged.get(id).key !== row.key) merged.set(id, { ambiguous: true });
        else if (!merged.has(id)) merged.set(id, row);
      }
    }
    outcomeIndex = merged;
    catalogAt = Date.now();
    log(`catalog fresh leagues=${leagues.join(',')} outcomes=${merged.size} locks=${lockIndex.size}`);
  }

  async function refreshBalance() {
    if (!key || !key.key) return;
    const bal = await signedGet(`/v3/account/subaccounts/${encodeURIComponent(key.id)}/balance`, '');
    const col = await signedGet('/rfq/v3/collateral', '');
    if (!bal.ok) return;
    balance = {
      balance: bal.body && decimalToNumber(bal.body.balance),
      openCollateral: col.ok && col.body ? (decimalToNumber(col.body.collateral) || 0) : 0,
      at: Date.now(),
    };
  }

  async function refreshMaker() {
    if (!key || !key.key) return;
    const res = await signedGet('/rfq/v3/maker', '');
    if (res.ok) quoter.applyMaker(res.body);
  }

  async function backfill() {
    if (!key || !key.key) return;
    const page = await paged('/rfq/v3/executions', 'limit=100', 5);
    if (!page.ok) {
      log(`executions backfill failed status=${page.status}`);
      return;
    }
    await quoter.reconcileExecutions(page.items);
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    attempt += 1;
    const wait = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function connect() {
    if (stopped) return;
    if (!key || !key.key) {
      log(key && key.error ? 'NOVIG_PRIVATE_KEY unusable; socket idle' : 'NOVIG_KEY_ID unset; shadow socket idle');
      return;
    }
    let headers;
    try {
      headers = signedHeaders(key, { method: 'GET', path: '/rfq/v3/ws' });
    } catch (e) {
      log(`sign failed ${e && e.message}`);
      return;
    }
    const url = novigRfqWsUrl(base);
    const sock = new WebSocketImpl(url, { headers });
    socket = sock;
    const arm = () => { socketAt = Date.now(); };
    sock.on('open', () => {
      attempt = 0;
      arm();
      log(`socket up ${sendsBlocked(env).blocked ? 'shadow/dry' : 'LIVE'}`);
      try {
        sock.send(JSON.stringify({
          nonce: quoter.nextNonce(),
          subscribe: ['rfq', 'quotes', 'executions'],
        }));
      } catch (e) {
        log(`subscribe failed ${e && e.message}`);
      }
      backfill().catch((e) => log(`backfill ${e && e.message}`));
    });
    sock.on('ping', arm);
    sock.on('message', (buf) => {
      arm();
      let msg = null;
      try { msg = JSON.parse(Buffer.isBuffer(buf) ? buf.toString() : String(buf)); } catch (_) { return; }
      quoter.onFrame(msg);
    });
    sock.on('close', (code) => {
      if (socket !== sock) return;
      socketAt = null;
      socket = null;
      log(`socket closed ${code}`);
      scheduleReconnect();
    });
    sock.on('error', (err) => {
      log(`socket error ${err && err.message}`);
    });
  }

  const catalogMs = numEnv(env, 'NOVIG_CATALOG_MS', 4000);
  const balanceMs = numEnv(env, 'NOVIG_BALANCE_MS', 10000);
  const reconcileMs = numEnv(env, 'NOVIG_RECONCILE_MS', 30000);
  const timers = [
    setInterval(() => { refreshCatalog().catch((e) => log(`catalog ${e && e.message}`)); }, catalogMs),
    setInterval(() => { refreshBalance().catch((e) => log(`balance ${e && e.message}`)); }, balanceMs),
    setInterval(() => { refreshMaker().catch(() => {}); }, 60000),
    setInterval(() => { backfill().catch((e) => log(`reconcile ${e && e.message}`)); }, reconcileMs),
  ];
  for (const t of timers) if (t.unref) t.unref();
  const gate = sendsBlocked(env);
  log(
    `role start dry=${gate.dry ? '1' : '0'} live=${gate.live ? '1' : '0'} shadow=${flagOn(env.NOVIG_SHADOW, true) ? '1' : '0'} ` +
    `capAtConfirm=ignored host=${base.replace(/\/\/[^/]*@/, '//')}`
  );
  refreshCatalog().catch((e) => log(`catalog ${e && e.message}`));
  refreshBalance().catch(() => {});
  connect();

  function stop() {
    stopped = true;
    for (const t of timers) clearInterval(t);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { if (socket) socket.close(); } catch (_) { /* closed */ }
  }

  return { stop, quoter, sendsBlocked: () => sendsBlocked(env) };
}

module.exports = {
  CONFIRM_MS,
  PAUSE_MS,
  sendsBlocked,
  createNovigQuoter,
  startNovigRfqLoop,
};
