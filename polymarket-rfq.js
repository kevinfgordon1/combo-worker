// Polymarket US Retail combo RFQ quoting loop.
//
// Maker only: subscribe / poll open RFQs, map comboLegs onto matchParlay,
// price from Combo Locks fill odds, share remaining with Kalshi via reserve.js.
// Live POSTs (create quote, confirm) require POLYMARKET_RFQ_LIVE to be truthy.
// quoteExecuted means paired orders were submitted — not a fill.
'use strict';
const { matchParlay } = require('./rfq');
const { decideAtFill } = require('./engine');
const { findStartedEvent } = require('./started');
const {
  RESERVE_TTL_MS,
  sumOutstanding,
  wouldExceedCap,
  dropPendingForRfq,
  listStaleUnaccepted,
  isReserveKey,
} = require('./reserve');
const {
  buildPolymarketQuote,
  shouldPostPolymarketQuote,
  shouldConfirmPolymarketAccept,
} = require('./polymarket-quote');
const { isPolymarketRfqLive } = require('./polymarket-auth');
const { createPolymarketHttp, createPolymarketRfqWs } = require('./polymarket-client');

const MODE = 'POLY';
const RECONCILE_MS = 3000;

function normalizePolymarketSide(side) {
  const raw = String(side == null ? '' : side).trim().toLowerCase();
  const s = raw.replace(/^side_/, '');
  if (s === 'buy' || s === 'yes' || s === 'long') return 'yes';
  if (s === 'sell' || s === 'no' || s === 'short') return 'no';
  return null;
}

function polymarketLegSymbol(leg) {
  if (leg == null) return '';
  if (typeof leg === 'string') return leg.trim();
  return String(
    leg.symbol || leg.slug || leg.market_slug || leg.polymarket_symbol || ''
  ).trim();
}

function polymarketLegKey(leg) {
  const symbol = polymarketLegSymbol(leg);
  if (!symbol) return null;
  const rawSide = (leg && typeof leg === 'object') ? (leg.side || 'SIDE_BUY') : 'SIDE_BUY';
  const side = normalizePolymarketSide(rawSide);
  if (!side) return null;
  return `${symbol.toUpperCase()}:${side}`;
}

function mapComboLegs(comboLegs) {
  if (!Array.isArray(comboLegs) || !comboLegs.length) {
    return { ok: false, reason: 'no_legs', legKeys: [], skipped: [] };
  }
  const legKeys = [];
  const skipped = [];
  for (const leg of comboLegs) {
    const key = polymarketLegKey(leg);
    if (!key) {
      skipped.push(leg);
      continue;
    }
    legKeys.push(key);
  }
  if (skipped.length) {
    return { ok: false, reason: 'unmatched_leg', legKeys, skipped };
  }
  if (legKeys.length < 2) {
    return { ok: false, reason: 'not_combo', legKeys, skipped };
  }
  return { ok: true, reason: null, legKeys: [...legKeys].sort(), skipped };
}

function normalizePolymarketRfq(raw) {
  const r = raw && raw.rfq && typeof raw.rfq === 'object' ? raw.rfq : raw;
  if (!r || typeof r !== 'object') return null;
  const legs = r.comboLegs || r.combo_legs || r.legs || null;
  const mapped = mapComboLegs(legs);
  return {
    rfqId: r.id || r.rfqId || r.rfq_id || null,
    symbol: r.symbol || null,
    status: r.status || null,
    qtyDecimal: r.qtyDecimal != null ? r.qtyDecimal : r.qty_decimal,
    cashOrderQty: r.cashOrderQty != null ? r.cashOrderQty : r.cash_order_qty,
    comboLegs: legs,
    legs,
    legKeys: mapped.legKeys,
    isCombo: mapped.ok,
    map: mapped,
    createdTime: r.createdTime || r.created_time || null,
    restRemainder: r.restRemainder === true || r.rest_remainder === true,
  };
}

function upperKeys(arr) {
  return (arr || []).map((k) => {
    const s = String(k);
    const i = s.lastIndexOf(':');
    if (i === -1) return s.toUpperCase();
    return `${s.slice(0, i).toUpperCase()}:${s.slice(i + 1).toLowerCase()}`;
  });
}

function matchPolymarketParlay(rfq, parlays) {
  if (!rfq || !rfq.legKeys || !rfq.legKeys.length || !Array.isArray(parlays)) return null;
  const asRfq = { ...rfq, legKeys: upperKeys(rfq.legKeys) };

  const withUpper = parlays.map((p) => {
    const lk = upperKeys(p.leg_keys || p.legKeys);
    return { ...p, leg_keys: lk, legKeys: lk };
  });
  const direct = matchParlay(asRfq, withUpper);
  if (direct) return parlays.find((x) => x.id === direct.id) || direct;

  const rewritten = [];
  for (const p of parlays) {
    const keys = [];
    for (const leg of p.legs || []) {
      const key = polymarketLegKey(leg);
      if (key) keys.push(key);
    }
    if (keys.length) rewritten.push({ ...p, leg_keys: keys, legKeys: keys });
  }
  const viaLegs = rewritten.length ? matchParlay(asRfq, rewritten) : null;
  if (viaLegs) return parlays.find((x) => x.id === viaLegs.id) || viaLegs;
  return null;
}

function evaluatePolymarketRfq({
  rfq: raw,
  parlays,
  filledSoFar = 0,
  outstanding = 0,
  now,
  startedFor,
  killEngaged,
} = {}) {
  const rfq = raw && raw.map ? raw : normalizePolymarketRfq(raw);
  if (!rfq || !rfq.rfqId) return { action: 'skip', reason: 'bad_rfq' };
  if (rfq.status && rfq.status !== 'RFQ_STATUS_OPEN') {
    return { action: 'skip', reason: 'not_open', rfq };
  }
  if (!rfq.map || !rfq.map.ok) {
    return {
      action: 'skip',
      reason: (rfq.map && rfq.map.reason) || 'unmatched_leg',
      rfq,
    };
  }

  const parlay = matchPolymarketParlay(rfq, parlays || []);
  if (!parlay) return { action: 'skip', reason: 'unmatched', rfq };

  const started = startedFor
    ? startedFor(parlay, rfq)
    : findStartedEvent(rfq, parlay, null, now);
  if (started && started.started) {
    return { action: 'skip', reason: 'game_started', rfq, parlay, started };
  }

  const quote = buildPolymarketQuote({
    fillAmerican: parlay.fill_american,
    cashOrderQty: rfq.cashOrderQty,
    qtyDecimal: rfq.qtyDecimal,
  });
  if (!shouldPostPolymarketQuote(quote)) {
    return { action: 'skip', reason: 'bad_size', rfq, parlay, quote };
  }

  const decision = decideAtFill({
    parlayStake: parlay.parlay_stake,
    parlayAmerican: parlay.parlay_american,
    fillAmerican: parlay.fill_american,
    fairAmerican: parlay.fair_american,
    rfqContracts: quote.estimatedContracts,
    hedgeMode: parlay.hedge_mode || '1x',
    maxContracts: parlay.max_contracts,
    filledSoFar,
    outstanding,
  });
  if (!decision.ok) {
    return {
      action: 'skip',
      reason: decision.reason || 'declined',
      rfq,
      parlay,
      quote,
      decision,
    };
  }

  const kill = typeof killEngaged === 'function' ? !!killEngaged(parlay.user_id) : false;
  return {
    action: 'quoteable',
    reason: kill ? 'kill' : null,
    rfq,
    parlay,
    quote,
    decision,
    kill,
  };
}

function shouldPostNow(evaluation, { live } = {}) {
  if (!evaluation || evaluation.action !== 'quoteable') {
    return { post: false, reason: (evaluation && evaluation.reason) || 'skip' };
  }
  if (evaluation.kill) return { post: false, reason: 'kill' };
  if (!live) return { post: false, reason: 'live_off' };
  return { post: true, reason: null };
}

function shouldConfirmNow(acceptedSide, { live } = {}) {
  if (!shouldConfirmPolymarketAccept(acceptedSide)) {
    return { confirm: false, reason: 'side_not_buy' };
  }
  if (!live) return { confirm: false, reason: 'live_off' };
  return { confirm: true, reason: null };
}

function quoteBodyFromEval(evaluation) {
  const q = evaluation && evaluation.quote;
  const rfq = evaluation && evaluation.rfq;
  if (!q || !rfq) return null;
  return {
    rfqId: rfq.rfqId,
    buyPrice: q.buyPrice,
    sellPrice: q.sellPrice,
    restRemainder: false,
  };
}

function pendingEntry(p, rfq, contracts, extra) {
  return {
    venue: 'polymarket',
    parlayId: p.id,
    userId: p.user_id,
    contracts,
    label: p.label,
    rfqId: rfq && rfq.rfqId,
    starts_at: p.starts_at,
    legs: p.legs,
    leg_keys: p.leg_keys || p.legKeys,
    maxContracts: p.max_contracts,
    postedAt: extra && extra.postedAt != null ? extra.postedAt : Date.now(),
    ...extra,
  };
}

function acceptedFromEvent(evt) {
  const q = (evt && evt.quote) || {};
  const r = (evt && evt.rfq) || {};
  return {
    quoteId: q.id || q.quoteId || q.quote_id || null,
    rfqId: q.rfqId || q.rfq_id || r.id || r.rfqId || null,
    acceptedSide: q.acceptedSide || q.accepted_side || r.acceptedSide || null,
    creatorOrderId: q.creatorOrderId || q.creator_order_id || null,
    confirmationDeadline: q.confirmationDeadline || q.confirmation_deadline || null,
  };
}

function logSkip(evaluation, extra) {
  const rfq = evaluation.rfq || {};
  const p = evaluation.parlay;
  const symbols = (rfq.comboLegs || []).map((l) => (l && l.symbol) || '?').join(',');
  const label = (p && p.label) || '(none)';
  const bits = [
    `[${MODE}] SKIP ${evaluation.reason} ${label} rfq=${rfq.rfqId || '?'}`,
  ];
  if (evaluation.reason === 'unmatched' || evaluation.reason === 'unmatched_leg' || evaluation.reason === 'no_legs') {
    bits.push(`legs=${symbols || '(none)'} keys=${(rfq.legKeys || []).join('|') || '(none)'}`);
  }
  if (evaluation.decision) {
    bits.push(`want=${evaluation.quote && evaluation.quote.estimatedContracts} remaining=${evaluation.decision.remaining}/${evaluation.decision.totalLimit}`);
  }
  if (extra) bits.push(extra);
  console.log(bits.join(' '));
}

async function hydrateRfq(http, raw) {
  let rfq = normalizePolymarketRfq(raw);
  if (!rfq) return null;
  if (rfq.map && rfq.map.ok) return rfq;

  if (rfq.rfqId) {
    try {
      const listed = await http.listRfqs({ rfqId: rfq.rfqId });
      const rows = (listed && listed.rfqs) || [];
      const hit = rows.find((x) => (x.id || x.rfqId) === rfq.rfqId) || rows[0];
      if (hit) rfq = normalizePolymarketRfq(hit) || rfq;
    } catch (e) {
      console.error(`[${MODE}] GET rfq ${rfq.rfqId}`, e.message);
    }
  }
  if (rfq.map && rfq.map.ok) return rfq;

  if (rfq.symbol) {
    try {
      const listed = await http.getCombo(rfq.symbol);
      const combo = (listed && listed.combo)
        || ((listed && listed.combos && listed.combos[0]) || null);
      if (combo && Array.isArray(combo.legs) && combo.legs.length) {
        rfq = normalizePolymarketRfq({
          id: rfq.rfqId,
          symbol: rfq.symbol,
          status: rfq.status || 'RFQ_STATUS_OPEN',
          qtyDecimal: rfq.qtyDecimal,
          cashOrderQty: rfq.cashOrderQty,
          comboLegs: combo.legs,
        }) || rfq;
      }
    } catch (e) {
      console.error(`[${MODE}] GET combo ${rfq.symbol}`, e.message);
    }
  }
  return rfq;
}

function startPolymarketRfqLoop(ctx = {}) {
  const env = ctx.env || process.env;
  const keyId = env.POLYMARKET_KEY_ID;
  const secretKey = env.POLYMARKET_SECRET_KEY;
  if (!keyId || !secretKey) {
    console.log(`[${MODE}] skipped — missing POLYMARKET_KEY_ID or POLYMARKET_SECRET_KEY`);
    return { stop() {} };
  }

  const live = isPolymarketRfqLive(env);
  const pendingQuotes = ctx.pendingQuotes || new Map();
  const confirmingQuotes = ctx.confirmingQuotes || new Set();
  const seenRfqs = new Set();
  let reserveSeq = 0;
  let stopped = false;

  const http = ctx.http || createPolymarketHttp({ keyId, secretKey, requestFn: ctx.requestFn });

  console.log(
    `[${MODE}] starting — live=${live}. ` +
    `POST create-quote / confirm only when POLYMARKET_RFQ_LIVE is truthy. ` +
    `Kalshi quoting keeps running. Remaining is shared via reserve.js.`
  );

  function parlays() {
    return typeof ctx.getParlays === 'function' ? (ctx.getParlays() || []) : (ctx.parlays || []);
  }

  function outstandingFor(parlayId, excludeQuoteId) {
    if (typeof ctx.getOutstanding === 'function') {
      return ctx.getOutstanding(parlayId, excludeQuoteId);
    }
    const self = sumOutstanding(pendingQuotes, parlayId, excludeQuoteId);
    const other = ctx.kalshiPendingQuotes
      ? sumOutstanding(ctx.kalshiPendingQuotes, parlayId, excludeQuoteId)
      : 0;
    return self + other;
  }

  function filledSoFarFor(id) {
    return typeof ctx.filledSoFarFor === 'function' ? ctx.filledSoFarFor(id) : 0;
  }

  function startedFor(p, rfq) {
    if (typeof ctx.startedFor === 'function') return ctx.startedFor(p, rfq);
    return findStartedEvent(rfq, p);
  }

  function killEngagedFor(userId) {
    return typeof ctx.killEngagedFor === 'function' ? ctx.killEngagedFor(userId) : false;
  }

  function bump(key) {
    if (ctx.counts && key in ctx.counts) ctx.counts[key] += 1;
  }

  async function handleRfq(raw) {
    const rfq = await hydrateRfq(http, raw);
    if (!rfq || !rfq.rfqId) return { action: 'skip', reason: 'bad_rfq' };
    if (seenRfqs.has(rfq.rfqId)) return { action: 'skip', reason: 'seen' };
    seenRfqs.add(rfq.rfqId);
    bump('polyRfqs');

    const matched = matchPolymarketParlay(rfq, parlays());
    const evaluation = evaluatePolymarketRfq({
      rfq,
      parlays: parlays(),
      filledSoFar: matched ? filledSoFarFor(matched.id) : 0,
      outstanding: matched ? outstandingFor(matched.id) : 0,
      startedFor,
      killEngaged: killEngagedFor,
    });

    if (evaluation.action !== 'quoteable') {
      logSkip(evaluation);
      if (evaluation.parlay && ctx.logAsync) {
        ctx.logAsync(evaluation.parlay, { rfqId: rfq.rfqId, contracts: evaluation.quote && evaluation.quote.estimatedContracts }, evaluation.decision, 'declined');
      }
      return evaluation;
    }

    const gate = shouldPostNow(evaluation, { live });
    const p = evaluation.parlay;
    const q = evaluation.quote;
    const d = evaluation.decision;

    if (!gate.post) {
      console.log(
        `[${MODE}] WOULD-QUOTE ${p.label} rfq=${rfq.rfqId} ` +
        `buy=${q.buyPrice} sell=${q.sellPrice} contracts=${q.estimatedContracts} ` +
        `reserved=${outstandingFor(p.id)}/${d.totalLimit} reason=${gate.reason}`
      );
      if (ctx.logAsync) ctx.logAsync(p, { rfqId: rfq.rfqId, contracts: q.estimatedContracts }, d, 'shadow');
      return { ...evaluation, post: false, reason: gate.reason };
    }

    const reserveKey = `reserve:pm:${++reserveSeq}`;
    pendingQuotes.set(reserveKey, pendingEntry(p, rfq, d.contracts));
    try {
      const posted = await http.createQuote(quoteBodyFromEval(evaluation));
      const quoteId = posted && (posted.quoteId || posted.id);
      pendingQuotes.delete(reserveKey);
      if (quoteId) {
        pendingQuotes.set(quoteId, pendingEntry(p, rfq, d.contracts));
      }
      bump('polyPosted');
      console.log(
        `[${MODE}] QUOTED ${p.label} rfq=${rfq.rfqId} quote_id=${quoteId || '?'} ` +
        `buy=${q.buyPrice} sell=${q.sellPrice} contracts=${d.contracts} ` +
        `reserved=${outstandingFor(p.id)}/${d.totalLimit}`
      );
      if (ctx.logAsync) {
        ctx.logAsync(p, { rfqId: rfq.rfqId, contracts: d.contracts }, d, 'quoted', {
          quote_id: quoteId, is_live: true, contracts: d.contracts,
        });
      }
      return { ...evaluation, post: true, quoteId };
    } catch (e) {
      pendingQuotes.delete(reserveKey);
      console.error(`[${MODE}] POST FAILED ${p.label} rfq=${rfq.rfqId}`, e.message);
      if (ctx.logAsync) ctx.logAsync(p, { rfqId: rfq.rfqId, contracts: d.contracts }, d, 'unfilled');
      return { ...evaluation, post: false, reason: 'post_failed', error: e.message };
    }
  }

  async function handleQuoteAccepted(evt) {
    const acc = acceptedFromEvent(evt);
    const { quoteId, rfqId, acceptedSide } = acc;
    const pending = quoteId ? pendingQuotes.get(quoteId) : null;
    if (pending) pending.accepted = true;
    const gate = shouldConfirmNow(acceptedSide, { live });
    if (!gate.confirm) {
      console.log(
        `[${MODE}] CONFIRM SKIPPED ${gate.reason} quote_id=${quoteId || '?'} ` +
        `rfq_id=${rfqId || '?'} side=${acceptedSide || '?'}`
      );
      if (quoteId && pending && live && gate.reason === 'side_not_buy') {
        try { await http.deleteQuote(rfqId, quoteId); } catch (e) {
          console.error(`[${MODE}] decline delete failed`, e.message);
        }
        pendingQuotes.delete(quoteId);
      }
      return { confirmed: false, reason: gate.reason };
    }
    if (!quoteId || !rfqId) {
      console.error(`[${MODE}] quoteAccepted missing ids`);
      return { confirmed: false, reason: 'missing_ids' };
    }
    if (confirmingQuotes.has(quoteId)) return { confirmed: false, reason: 'in_flight' };
    confirmingQuotes.add(quoteId);
    try {
      if (pending) {
        const maxContracts = pending.maxContracts;
        const filledSoFar = filledSoFarFor(pending.parlayId);
        const outstandingOthers = outstandingFor(pending.parlayId, quoteId);
        if (wouldExceedCap(maxContracts, filledSoFar, outstandingOthers, pending.contracts)) {
          console.log(
            `[${MODE}] CONFIRM SKIPPED cap exceeded quote_id=${quoteId} ` +
            `filled=${filledSoFar} reserved=${outstandingOthers} want=${pending.contracts} max=${maxContracts}`
          );
          try { await http.deleteQuote(rfqId, quoteId); } catch (_) {}
          pendingQuotes.delete(quoteId);
          return { confirmed: false, reason: 'cap_exceeded' };
        }
      }
      await http.confirmQuote(rfqId, quoteId);
      console.log(
        `[${MODE}] CONFIRMED quote_id=${quoteId} rfq_id=${rfqId} side=${acceptedSide} ` +
        `label=${pending ? pending.label : '(unknown)'}`
      );
      return { confirmed: true };
    } catch (e) {
      console.error(`[${MODE}] CONFIRM FAILED quote_id=${quoteId} rfq_id=${rfqId}`, e.message);
      return { confirmed: false, reason: 'confirm_failed', error: e.message };
    } finally {
      confirmingQuotes.delete(quoteId);
    }
  }

  function handleRfqClosed(evt) {
    const rfq = (evt && evt.rfq) || {};
    const rfqId = rfq.id || rfq.rfqId || (evt && evt.rfqId);
    if (!rfqId) return;
    const dropped = dropPendingForRfq(pendingQuotes, rfqId, { confirming: confirmingQuotes });
    for (const { id, quote } of dropped) {
      console.log(
        `[${MODE}] RESERVE RELEASED closed ${quote.label || ''} quote_id=${id} rfq=${rfqId}`
      );
    }
  }

  function handleQuoteExecuted(evt) {
    const q = (evt && evt.quote) || {};
    const quoteId = q.id || q.quoteId;
    const pending = quoteId ? pendingQuotes.get(quoteId) : null;
    if (pending) {
      pending.executed = true;
      pending.creatorOrderId = q.creatorOrderId || q.creator_order_id || null;
    }
    console.log(
      `[${MODE}] quoteExecuted orders submitted (not a fill) ` +
      `quote_id=${quoteId || '?'} rfq=${q.rfqId || (pending && pending.rfqId) || '?'} ` +
      `creatorOrderId=${q.creatorOrderId || q.creator_order_id || '?'}`
    );
  }

  function handleOrderExecution(ex) {
    if (!ex || typeof ex !== 'object') return;
    const typ = String(ex.type || '').toUpperCase();
    const order = ex.order || {};
    const orderId = order.id || ex.orderId || ex.order_id || null;
    let pending = null;
    let pendingId = null;
    pendingQuotes.forEach((q, id) => {
      if (q.creatorOrderId && q.creatorOrderId === orderId) {
        pending = q;
        pendingId = id;
      }
    });
    if (!pending) return;

    if (typ === 'EXECUTION_TYPE_FILL' || typ === 'EXECUTION_TYPE_PARTIAL_FILL') {
      const n = parseFloat(ex.lastShares || ex.last_shares || 0);
      const contracts = Number.isFinite(n) && n > 0 ? n : pending.contracts;
      if (typeof ctx.onFill === 'function') ctx.onFill(pending.parlayId, contracts);
      else if (ctx.sessionFilledByParlay) {
        ctx.sessionFilledByParlay[pending.parlayId] =
          (ctx.sessionFilledByParlay[pending.parlayId] || 0) + contracts;
      }
      if (typ === 'EXECUTION_TYPE_FILL') pendingQuotes.delete(pendingId);
      console.log(
        `[${MODE}] ORDER FILL ${pending.label} order_id=${orderId} contracts=${contracts}`
      );
      return;
    }
    if (
      typ === 'EXECUTION_TYPE_CANCELED' ||
      typ === 'EXECUTION_TYPE_REJECTED' ||
      typ === 'EXECUTION_TYPE_EXPIRED'
    ) {
      pendingQuotes.delete(pendingId);
      console.log(`[${MODE}] RESERVE RELEASED order ${typ} quote_id=${pendingId}`);
    }
  }

  async function reconcileOpenRfqs() {
    try {
      const listed = await http.listRfqs({ status: 'RFQ_STATUS_OPEN', limit: 100 });
      const rows = (listed && listed.rfqs) || [];
      console.log(`[${MODE}] reconcile open=${rows.length} live=${live}`);
      for (const row of rows) {
        if (stopped) return;
        await handleRfq(row);
      }
    } catch (e) {
      console.error(`[${MODE}] reconcile rfqs`, e.message);
    }
  }

  async function cancelUnaccepted() {
    const stale = listStaleUnaccepted(pendingQuotes, Date.now(), RESERVE_TTL_MS, {
      confirming: confirmingQuotes,
    });
    for (const { id, quote } of stale) {
      if (isReserveKey(id)) {
        pendingQuotes.delete(id);
        continue;
      }
      try {
        if (live && quote.rfqId) await http.deleteQuote(quote.rfqId, id);
      } catch (e) {
        console.error(`[${MODE}] TTL delete failed`, e.message);
      }
      pendingQuotes.delete(id);
      console.log(`[${MODE}] CANCEL unaccepted quote_id=${id} rfq=${quote.rfqId || '?'}`);
    }
  }

  function onWsEvent(evt) {
    if (!evt || stopped) return;
    if (evt.type === 'rfqCreated') {
      handleRfq(evt.rfq || evt).catch((e) => console.error(`[${MODE}] onRfq`, e.message));
    } else if (evt.type === 'rfqClosed') {
      handleRfqClosed(evt);
    } else if (evt.type === 'quoteAccepted') {
      handleQuoteAccepted(evt).catch((e) => console.error(`[${MODE}] onAccept`, e.message));
    } else if (evt.type === 'quoteExecuted') {
      handleQuoteExecuted(evt);
    } else if (evt.type === 'quoteDeleted') {
      const q = evt.quote || {};
      const id = q.id || q.quoteId;
      if (id && pendingQuotes.has(id)) {
        pendingQuotes.delete(id);
        console.log(`[${MODE}] RESERVE RELEASED deleted quote_id=${id}`);
      }
    } else if (evt.type === 'orderExecution') {
      handleOrderExecution(evt.execution);
    }
  }

  let ws = null;
  if (!ctx.http || ctx.startWs !== false) {
    ws = ctx.ws || createPolymarketRfqWs({
      keyId,
      secretKey,
      onStatus: (s, i) => console.log(`[${MODE}] ws:${s}`, i && i.message ? i.message : (i && i.wait != null ? `wait=${i.wait}` : '')),
      onEvent: onWsEvent,
      subscribeOrders: live,
    });
    try { ws.start(); } catch (e) { console.error(`[${MODE}] ws start`, e.message); }
  }

  http.getUserId().then((j) => {
    const id = j && (j.rfqUserId || j.rfq_user_id);
    console.log(`[${MODE}] auth ok rfqUserId=${id || '(none)'} live=${live}`);
  }).catch((e) => {
    console.error(`[${MODE}] user-id failed`, e.message);
  });

  reconcileOpenRfqs().catch((e) => console.error(`[${MODE}] initial reconcile`, e.message));
  const reconcileTimer = setInterval(() => {
    reconcileOpenRfqs().catch((e) => console.error(`[${MODE}] reconcile`, e.message));
  }, ctx.reconcileMs != null ? ctx.reconcileMs : RECONCILE_MS);
  const ttlTimer = setInterval(() => {
    cancelUnaccepted().catch((e) => console.error(`[${MODE}] ttl`, e.message));
  }, 2000);
  if (reconcileTimer.unref) reconcileTimer.unref();
  if (ttlTimer.unref) ttlTimer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(reconcileTimer);
      clearInterval(ttlTimer);
      try { ws && ws.stop && ws.stop(); } catch (_) {}
      try { http.close && http.close(); } catch (_) {}
    },
    handleRfq,
    handleQuoteAccepted,
    handleRfqClosed,
    handleQuoteExecuted,
    handleOrderExecution,
    onWsEvent,
    pendingQuotes,
    live,
  };
}

module.exports = {
  MODE,
  normalizePolymarketSide,
  polymarketLegSymbol,
  polymarketLegKey,
  mapComboLegs,
  normalizePolymarketRfq,
  matchPolymarketParlay,
  evaluatePolymarketRfq,
  shouldPostNow,
  shouldConfirmNow,
  quoteBodyFromEval,
  acceptedFromEvent,
  startPolymarketRfqLoop,
};
