// Kalshi RFQ trading calls for the sniper — the SAME requests combo-worker's live-runner makes
// (quote POST /communications/quotes with buildQuoteBody, confirm PUT
// /communications/rfqs/{rfq}/quotes/{quote}/confirm with "{}" + JSON content-type, cancel
// DELETE /communications/quotes/{id} treating 404 as gone, fills GET /portfolio/fills?order_id=…
// via fillsQuery/fillReferencesOrder/bookFromQuoteExecution), reusing the shared modules:
// kalshi-auth.signedRequest (sign right before send, one retry on timestamp-expired),
// kalshi-http.createKalshiRestPair (own pools), quote-sender (stale-RFQ drop / dedupe),
// engine.buildQuoteBody/quoteYesBid/shouldConfirmAccept.
// Mutations are refused unless the live gate is open. Own key only (SNIPER_KALSHI_*).
'use strict';
const { parseSubBalanceUsd } = require('./soon-cap');
const { signedRequest, signedNow } = require('../kalshi-auth');
const { createKalshiRestPair, QUOTE_TIMEOUT_MS } = require('../kalshi-http');
const { createQuoteSender, rfqAgeMs, DEFAULT_MAX_RFQ_AGE_MS } = require('../quote-sender');
const { createPostEstimator } = require('./send-window');
const { buildQuoteBody, quoteYesBid, YES_DECLINE } = require('../engine');
const { fillsQuery, fillReferencesOrder, bookFromQuoteExecution } = require('../kalshi-fill-confirm');

const QUOTE_PATH = '/trade-api/v2/communications/quotes';
const confirmPath = (rfqId, quoteId) => `/trade-api/v2/communications/rfqs/${rfqId}/quotes/${quoteId}/confirm`;
const cancelPath = (quoteId) => `/trade-api/v2/communications/quotes/${quoteId}`;
const FILLS_PATH = '/trade-api/v2/portfolio/fills';

// NO bid for selling YES at q on the tick grid (0.001 when sub-cent, else cents). Rounded DOWN
// (we pay ≤ 1−q for NO, i.e. never sell YES below the price that cleared min ROI).
function noBidFor(quoteYes, tick = 0.001) {
  const dp = tick < 0.01 ? 3 : 2; const m = 10 ** dp;
  const no = Math.floor((1 - quoteYes) * m + 1e-7) / m;
  return no.toFixed(dp);
}
const sizeSource = (rfq) => (Number(rfq && rfq.contracts) > 0 ? 'contracts' : 'dollar');

class LiveGateClosed extends Error { constructor(op) { super(`LIVE_GATE_CLOSED ${op}`); this.liveGateClosed = true; } }

// sendWindow (sniper/send-window.js sendWindowConfig): hard per-RFQ deadline on the quote queue.
// Quote sends/s for the estimate = the trade limiter's rate minus the routine-cancel share; sends
// waiting in the urgent lane (risk-reducing cancels) count as ahead of every quote.
function createSniperTrader({ gate, keyId, pem, subaccount = null, limiter = null, readLimiter = null, request = null, log = console.log, maxConcurrent = 8, maxQueued = 24, sendWindow = null, now = () => Date.now(), serverNow = () => signedNow() } = {}) {
  const live = !!(gate && gate.live);
  let pair = null;
  const pools = () => { if (!pair) pair = createKalshiRestPair(); return pair; };
  const win = sendWindow && sendWindow.enabled !== false && sendWindow.windowMs > 0 ? sendWindow : null;
  const postEst = createPostEstimator({ minMs: win ? win.postEstMinMs : 60, maxMs: win ? win.postEstMaxMs : 1000 });
  const quoteRps = () => {
    if (!limiter || typeof limiter.rate !== 'function') return 6;
    const share = typeof limiter.lowShareRps === 'function' ? limiter.lowShareRps() : 0;
    return Math.max(0.5, limiter.rate() - share);
  };
  const deadline = win ? {
    windowMs: win.windowMs, safetyMs: win.safetyMs, rps: quoteRps, postEstMs: () => postEst.get(),
    aheadExtra: () => (limiter && typeof limiter.waitingAt === 'function' ? limiter.waitingAt(2) : 0),
  } : null;
  const sender = createQuoteSender({ maxConcurrent, maxQueued, serverNow, now, deadline, log: (m) => log(`[SNIPER] ${m}`) });
  const maxAge = win ? win.windowMs : DEFAULT_MAX_RFQ_AGE_MS;
  const stats = { posts: 0, confirms: 0, cancels: 0, cancelsSkipped: 0, fillReads: 0, refused: 0 };

  async function raw(method, signPath, { path, body, quote = false, timeoutMs, shouldRetryExpired, low = false, priority, abortIf = null, lim = limiter, onWireMs = null } = {}) {
    const doReq = request || (async ({ method: m, path: p, headers, body: b }) => {
      const http = quote ? pools().quote : pools().rest;
      const req = { method: m, path: p, headers };
      if (b != null) req.body = b;
      if (timeoutMs) { req.headersTimeout = timeoutMs; req.bodyTimeout = timeoutMs; }
      const { statusCode, headers: h, body: rb } = await http.request(req);
      return { statusCode, headers: h, text: await rb.text() };
    });
    const go = () => signedRequest(doReq, {
      keyId, pem, method, signPath, path, body, shouldRetryExpired,
      headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
    });
    const timed = async () => { const t0 = now(); try { return await go(); } finally { if (onWireMs) onWireMs(now() - t0); } };
    const res = lim ? await lim.run(async () => { const r = await timed(); return { ...r, ok: r.statusCode !== 429, status: r.statusCode }; }, { low, priority, abortIf }) : await timed();
    return res;
  }
  function mustBeLive(op) { if (!live) { stats.refused += 1; throw new LiveGateClosed(op); } }

  async function postQuote(rfq, quoteYes, tick, { priority = 0 } = {}) {
    mustBeLive('quote');
    if (!(subaccount >= 1)) throw new LiveGateClosed('quote_no_subaccount');
    const noBid = noBidFor(quoteYes, tick);
    const yesBid = quoteYesBid(sizeSource(rfq), noBid);
    const body = JSON.stringify({ ...buildQuoteBody(rfq.rfqId, noBid, yesBid, false), subaccount });
    const r = await sender.send(rfq.rfqId, rfq.createdTs, (ctx) => raw('POST', QUOTE_PATH, {
      body, quote: true, timeoutMs: QUOTE_TIMEOUT_MS,
      shouldRetryExpired: () => { const a = rfqAgeMs(rfq.createdTs, serverNow()); return a == null || a <= maxAge; },
      // Deadline mode: give up the token wait once the POST can't land inside the window.
      abortIf: ctx && ctx.abortIf ? ctx.abortIf : null,
      onWireMs: (ms) => postEst.add(ms),
    }), { priority });
    if (r && r.aborted) {
      stats.expiredAtToken = (stats.expiredAtToken || 0) + 1;
      const a = rfqAgeMs(rfq.createdTs, serverNow());
      log(`[SNIPER] STALE_DROP reason=expired rfq=${rfq.rfqId} age=${a == null ? '?' : Math.round(a)}ms at=token`);
      const e = new Error(`STALE_DROP expired at=token`); e.staleDrop = true; e.staleReason = 'expired'; throw e;
    }
    const { statusCode, text } = r;
    stats.posts += 1;
    if (statusCode < 200 || statusCode >= 300) throw new Error(`Kalshi quote failed ${statusCode}: ${text}`);
    const j = JSON.parse(text || '{}');
    return { quoteId: j.id || (j.quote && j.quote.id) || null, noBid, yesBid };
  }
  async function confirm(rfqId, quoteId) {
    mustBeLive('confirm');
    const { statusCode, text } = await raw('PUT', confirmPath(rfqId, quoteId), { body: '{}', quote: true });
    stats.confirms += 1;
    if (statusCode < 200 || statusCode >= 300) throw new Error(`Kalshi confirm failed ${statusCode}: ${text}`);
    return { statusCode };
  }
  // urgent=true (price move / started game / reprice abort / shutdown): ahead of quotes.
  // urgent=false (routine 20s TTL): yields to quotes and confirms.
  // skipIf (routine cancels only): re-checked while the cancel waits for a token; true => the
  // RFQ is already closed on Kalshi (our quote is gone with it), so no DELETE is spent.
  async function cancel(quoteId, { urgent = true, skipIf = null } = {}) {
    mustBeLive('cancel');
    const r = await raw('DELETE', cancelPath(quoteId), { quote: true, priority: urgent ? 2 : 0, abortIf: urgent ? null : skipIf });
    if (r && r.aborted) { stats.cancelsSkipped = (stats.cancelsSkipped || 0) + 1; return { skipped: true }; }
    const { statusCode, text } = r;
    stats.cancels += 1;
    if (statusCode === 204 || statusCode === 404 || (statusCode >= 200 && statusCode < 300)) return { statusCode };
    throw new Error(`Kalshi cancel failed ${statusCode}: ${text}`);
  }
  // Read-only: fills for one order_id (our quote's execution).
  async function fillsForOrder(orderId) {
    if (!orderId) return { book: [], contracts: 0, reason: 'no-order-id' };
    const out = []; let cursor = '';
    for (let page = 0; page < 10; page += 1) {
      const qs = fillsQuery({ orderId, limit: 200, cursor }) + (subaccount >= 1 ? `&subaccount=${subaccount}` : '');
      const res = await raw('GET', FILLS_PATH, { path: `${FILLS_PATH}?${qs}`, lim: readLimiter || limiter }); // reads: own (read-bucket) lane
      stats.fillReads += 1;
      if (!res || res.statusCode !== 200) throw new Error(`fills read ${res && res.statusCode}`);
      const j = JSON.parse(res.text || '{}');
      out.push(...(j.fills || []).filter((f) => fillReferencesOrder(f, orderId)));
      if (!j.cursor || !(j.fills || []).length) break;
      cursor = j.cursor;
    }
    return bookFromQuoteExecution({ orderId, fills: out });
  }
  // Read-only (read lane, never the write budget): our quotes Kalshi updated since minTsSec with the
  // given status (default cancelled), e.g. killed with an expired / executed / deleted RFQ.
  // GET /communications/quotes?user_filter=self&status=…&min_ts=… (limit 500, cursor pages).
  async function listQuotes({ minTsSec, status = 'cancelled', maxPages = 4 } = {}) {
    const out = []; let cursor = '';
    for (let page = 0; page < maxPages; page += 1) {
      const qs = new URLSearchParams({ user_filter: 'self', limit: '500' });
      if (status) qs.set('status', status);
      if (Number.isFinite(minTsSec)) qs.set('min_ts', String(Math.floor(minTsSec)));
      if (cursor) qs.set('cursor', cursor);
      const res = await raw('GET', QUOTE_PATH, { path: `${QUOTE_PATH}?${qs.toString()}`, lim: readLimiter || limiter, low: true });
      stats.quoteReads = (stats.quoteReads || 0) + 1;
      if (!res || res.statusCode !== 200) throw new Error(`quotes read ${res && res.statusCode}`);
      const j = JSON.parse(res.text || '{}');
      const qsList = Array.isArray(j.quotes) ? j.quotes : [];
      out.push(...qsList);
      if (!j.cursor || !qsList.length) break;
      cursor = j.cursor;
    }
    return out;
  }
  // Read-only (read lane): COMPLETE snapshot of this subaccount's OPEN quotes (Oct 28 2026, fix for the
  // quote-status poll). Kalshi's list only keeps cancelled quotes that were ACCEPTED first ("expired after
  // acceptance"); a quote that dies with its RFQ un-accepted drops out of the list entirely, so polling
  // status=cancelled saw ~4 quotes a run and saved no DELETEs. A quote absent from a complete open
  // snapshot is not open. complete=false (cursor left after maxPages) => callers must not infer anything.
  async function openQuotesSnapshot({ maxPages = 6 } = {}) {
    const out = []; let cursor = ''; let complete = false; let newestCreatedMs = null;
    for (let page = 0; page < maxPages; page += 1) {
      const qs = new URLSearchParams({ user_filter: 'self', limit: '500', status: 'open' });
      if (subaccount >= 1) qs.set('subaccount', String(subaccount));
      if (cursor) qs.set('cursor', cursor);
      const res = await raw('GET', QUOTE_PATH, { path: `${QUOTE_PATH}?${qs.toString()}`, lim: readLimiter || limiter, low: true });
      stats.quoteReads = (stats.quoteReads || 0) + 1;
      if (!res || res.statusCode !== 200) throw new Error(`open quotes read ${res && res.statusCode}`);
      const j = JSON.parse(res.text || '{}');
      const list = Array.isArray(j.quotes) ? j.quotes : [];
      for (const q of list) {
        if (String(q.status || 'open').toLowerCase() !== 'open') continue;
        out.push(q);
        const c = Date.parse(q.created_ts || ''); if (Number.isFinite(c) && (newestCreatedMs == null || c > newestCreatedMs)) newestCreatedMs = c;
      }
      if (!j.cursor || !list.length) { complete = true; break; }
      cursor = j.cursor;
    }
    return { ids: new Set(out.map((q) => q.id).filter(Boolean)), count: out.length, complete, newestCreatedMs };
  }
  // Read-only: this sniper subaccount's cash ($) for the soon-cap tier (sniper/soon-cap.js).
  async function subBalanceUsd() {
    const p = '/trade-api/v2/portfolio/subaccounts/balances';
    const res = await raw('GET', p, { path: p, lim: readLimiter || limiter, low: true });
    if (!res || res.statusCode !== 200) throw new Error(`subaccount balance read ${res && res.statusCode}`);
    return parseSubBalanceUsd(JSON.parse(res.text || '{}'), subaccount);
  }
  // Pre-reserve admission (runner): would a quote with this priority land inside the window?
  function admission(rfq, priority = 0) {
    if (!win) return { ok: true, projectedMs: null, ahead: 0, capacity: Infinity };
    return sender.admission(rfq && rfq.createdTs, priority);
  }
  const queueState = () => ({ queued: sender.queued, active: sender.active, capacity: typeof sender.capacity === 'function' ? sender.capacity() : Infinity });
  return {
    live, postQuote, confirm, cancel, fillsForOrder, subBalanceUsd, listQuotes, openQuotesSnapshot, admission, queueState,
    postEstMs: () => postEst.get(), quoteRps, sendWindow: win,
    senderStats: () => (typeof sender.stats === 'function' ? sender.stats() : {}),
    stats: () => ({ ...stats, queued: sender.queued, active: sender.active }),
  };
}

module.exports = { createSniperTrader, noBidFor, sizeSource, LiveGateClosed, YES_DECLINE };
