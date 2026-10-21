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
const { signedRequest, signedNow } = require('../kalshi-auth');
const { createKalshiRestPair, QUOTE_TIMEOUT_MS } = require('../kalshi-http');
const { createQuoteSender, rfqAgeMs, DEFAULT_MAX_RFQ_AGE_MS } = require('../quote-sender');
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

function createSniperTrader({ gate, keyId, pem, limiter = null, request = null, log = console.log } = {}) {
  const live = !!(gate && gate.live);
  let pair = null;
  const pools = () => { if (!pair) pair = createKalshiRestPair(); return pair; };
  const sender = createQuoteSender({ maxConcurrent: 4, serverNow: () => signedNow(), log: (m) => log(`[SNIPER] ${m}`) });
  const stats = { posts: 0, confirms: 0, cancels: 0, fillReads: 0, refused: 0 };

  async function raw(method, signPath, { path, body, quote = false, timeoutMs, shouldRetryExpired } = {}) {
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
    const res = limiter ? await limiter.run(async () => { const r = await go(); return { ...r, ok: r.statusCode !== 429, status: r.statusCode }; }) : await go();
    return res;
  }
  function mustBeLive(op) { if (!live) { stats.refused += 1; throw new LiveGateClosed(op); } }

  async function postQuote(rfq, quoteYes, tick) {
    mustBeLive('quote');
    const noBid = noBidFor(quoteYes, tick);
    const yesBid = quoteYesBid(sizeSource(rfq), noBid);
    const body = JSON.stringify(buildQuoteBody(rfq.rfqId, noBid, yesBid, false));
    const { statusCode, text } = await sender.send(rfq.rfqId, rfq.createdTs, () => raw('POST', QUOTE_PATH, {
      body, quote: true, timeoutMs: QUOTE_TIMEOUT_MS,
      shouldRetryExpired: () => { const a = rfqAgeMs(rfq.createdTs, signedNow()); return a == null || a <= DEFAULT_MAX_RFQ_AGE_MS; },
    }));
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
  async function cancel(quoteId) {
    mustBeLive('cancel');
    const { statusCode, text } = await raw('DELETE', cancelPath(quoteId), { quote: true });
    stats.cancels += 1;
    if (statusCode === 204 || statusCode === 404 || (statusCode >= 200 && statusCode < 300)) return { statusCode };
    throw new Error(`Kalshi cancel failed ${statusCode}: ${text}`);
  }
  // Read-only: fills for one order_id (our quote's execution).
  async function fillsForOrder(orderId) {
    if (!orderId) return { book: [], contracts: 0, reason: 'no-order-id' };
    const out = []; let cursor = '';
    for (let page = 0; page < 10; page += 1) {
      const qs = fillsQuery({ orderId, limit: 200, cursor });
      const res = await raw('GET', FILLS_PATH, { path: `${FILLS_PATH}?${qs}` });
      stats.fillReads += 1;
      if (!res || res.statusCode !== 200) throw new Error(`fills read ${res && res.statusCode}`);
      const j = JSON.parse(res.text || '{}');
      out.push(...(j.fills || []).filter((f) => fillReferencesOrder(f, orderId)));
      if (!j.cursor || !(j.fills || []).length) break;
      cursor = j.cursor;
    }
    return bookFromQuoteExecution({ orderId, fills: out });
  }
  return { live, postQuote, confirm, cancel, fillsForOrder, stats: () => ({ ...stats }) };
}

module.exports = { createSniperTrader, noBidFor, sizeSource, LiveGateClosed, YES_DECLINE };
