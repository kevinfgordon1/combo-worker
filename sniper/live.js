// Live quote lifecycle for the sniper (only reachable when the live gate is open; in dry run
// the same flow stops after the DB reservation). Mirrors combo-worker's live-runner order:
//   decide → Combo-Locks check → DB reserve (atomic caps) → re-price → POST quote
//   → 20s unaccepted TTL cancel → quote_accepted: shouldConfirmAccept + re-price (≥ min ROI)
//   + cap-at-confirm (DB) + lock check → PUT confirm, else decline (cancel)
//   → quote_executed: book confirmed portfolio fills for that order_id → ledger
//   → settlement loop: market result → realized P&L → release; daily loss stop.
'use strict';
const { snipeEconomics, minQuotePrice } = require('../auto-sniper');
const { shouldConfirmAccept } = require('../engine');
const { RESERVE_TTL_MS } = require('../reserve');
const { formatFillAlert } = require('./fill-alert');
// 'http_409:rfq_closed' | 'stale_drop:queue_wait' | 'error' — Kalshi error body code when present.
function postFailKey(err) {
  const m = String((err && err.message) || err || '');
  const sd = m.match(/STALE_DROP (\w+)/); if (sd) return `stale_drop:${sd[1]}`;
  const h = m.match(/Kalshi quote failed (\d+): ?(.*)$/s);
  if (h) { let code = ''; try { const j = JSON.parse(h[2]); code = (j.error && (j.error.code || j.error.message)) || j.code || ''; } catch (_) { code = ''; } return `http_${h[1]}${code ? `:${String(code).slice(0, 40)}` : ''}`; }
  return 'error';
}
const usdS = (x) => `$${(Number(x) || 0).toFixed(2)}`;

function createLiveSniper({
  config, trader, store, coord, caps, reprice, alert = () => {}, log = console.log,
  now = () => Date.now(), ttlMs = RESERVE_TTL_MS, fillRetries = 4, fillRetryMs = 1500,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onHalt = () => {},
  onHold = () => {}, startedReason = () => null, kickoffOf = () => null, onFilled = () => {}, // onFilled: book-arb check (alert-only) // kickoffOf: ticker -> kickoff ms (fill alert); startedReason: (rfq) -> 'game_started' | 'no_kickoff' | null (rule 9)
} = {}) {
  const pending = new Map(); // quoteId -> { d, rfq, accepted, timer }
  const byRfq = new Map(); // rfqId -> quoteId
  const confirming = new Set();
  // RFQs Kalshi has closed/deleted (ws rfq_deleted etc.). Kalshi drops our quote with the RFQ, so a
  // routine TTL cancel for these is a wasted DELETE on the shared write budget. Bounded + aged.
  const closed = new Map(); // rfqId -> closedAtMs
  const CLOSED_KEEP_MS = 120000; const CLOSED_MAX = 20000;
  const inflight = new Set(); // rfqIds with a quote POST in flight (no quoteId yet)
  const ttlCancelling = new Set(); // rfqIds whose routine cancel is queued
  const noteClosed = (rfqId) => {
    if (!rfqId) return;
    const t = now(); closed.set(rfqId, t);
    if (closed.size > CLOSED_MAX) { for (const [k, v] of closed) { if (closed.size <= CLOSED_MAX && t - v < CLOSED_KEEP_MS) break; closed.delete(k); } }
  };
  const isClosed = (rfqId) => { const t = closed.get(rfqId); if (t == null) return false; if (now() - t > CLOSED_KEEP_MS) { closed.delete(rfqId); return false; } return true; };
  const stats = { cancelSkipped: 0, posted: 0, postFail: 0, staleDrop: 0, postFailBy: {}, postMs: [], accepted: 0, confirmed: 0, declined: {}, fills: 0, cancelled: 0, settled: 0, aborted: {} };
  let halted = false;
  let haltReason = null; let haltDay = null;
  const etDayKey = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const live = () => !!trader.live && !halted;

  // ROI of OUR quoted price against a freshly computed fair (null fair => fails).
  function roiAt(d, fair, contracts = d.contracts) {
    if (!(fair > 0 && fair < 1)) return null;
    return snipeEconomics({ fair, q: d.quoteYes, n: contracts, makerRate: d.makerRate });
  }

  // Called after decide() returned a quote AND the DB reservation succeeded.
  async function send(rfq, d) {
    const abort = async (reason) => { bump(stats.aborted, reason); await store.release(d.rfqId, 'cancelled', {}); return { sent: false, reason }; };
    if (!live()) return abort(halted ? 'halted' : 'not_live');
    const st = startedReason(rfq); if (st) return abort(st);
    const b = coord.blockReason(rfq); if (b) return abort(b);
    const cw = await coord.comboWorkerQuoting(rfq.rfqId); if (cw) return abort(cw);
    // Re-price at send time with the freshest books.
    const fresh = reprice(rfq);
    const e = roiAt(d, fresh);
    if (!e || e.roi < (d.minRoi != null ? d.minRoi : config.minRoi) - 1e-12) return abort('reprice_below_min');
    let res;
    const tPost = now();
    inflight.add(rfq.rfqId);
    try { res = await trader.postQuote(rfq, d.quoteYes, config.tick, { priority: Number.isFinite(e.ev) ? e.ev : 0 }); } catch (err) {
      inflight.delete(rfq.rfqId);
      // Free the reservation first so a failed POST never sits in pending risk.
      stats.postMs.push(now() - tPost); if (stats.postMs.length > 200) stats.postMs.shift();
      await store.release(d.rfqId, 'failed', {});
      const k = postFailKey(err); bump(stats.postFailBy, k);
      if (k.startsWith('stale_drop')) stats.staleDrop += 1; else stats.postFail += 1;
      log(`[SNIPER] quote POST failed rfq=${rfq.rfqId} kind=${k} ms=${now() - tPost}: ${String(err.message || err).slice(0, 400)}`);
      return { sent: false, reason: k.startsWith('stale_drop') ? 'post_stale_drop' : 'post_failed' };
    }
    inflight.delete(rfq.rfqId);
    stats.postMs.push(now() - tPost); if (stats.postMs.length > 200) stats.postMs.shift();
    if (!res.quoteId) { await store.release(d.rfqId, 'failed', {}); return { sent: false, reason: 'no_quote_id' }; }
    stats.posted += 1;
    await store.update(d.rfqId, { phase: 'quoted', quote_id: res.quoteId, no_bid: res.noBid });
    if (isClosed(rfq.rfqId)) {
      // RFQ closed while our POST was in flight: the quote died with it. No TTL timer, no cancel.
      await store.release(d.rfqId, 'cancelled', {}); stats.cancelled += 1; stats.cancelSkipped += 1;
      log(`[SNIPER] LIVE QUOTE rfq=${rfq.rfqId} quote_id=${res.quoteId} closed during POST, no cancel needed`);
      return { sent: true, quoteId: res.quoteId };
    }
    const entry = { d, rfq, accepted: false, yesBid: res.yesBid, timer: null };
    entry.timer = setTimeout(() => { expire(res.quoteId).catch(() => {}); }, ttlMs);
    if (entry.timer.unref) entry.timer.unref();
    pending.set(res.quoteId, entry); byRfq.set(rfq.rfqId, res.quoteId);
    if (abortAfterPost.has(rfq.rfqId)) { const r = abortAfterPost.get(rfq.rfqId); abortAfterPost.delete(rfq.rfqId); await dropQuote(res.quoteId, 'cancelled', r); return { sent: true, quoteId: res.quoteId, aborted: r }; }
    log(`[SNIPER] LIVE QUOTE rfq=${rfq.rfqId} quote_id=${res.quoteId} no_bid=${res.noBid} yes=${d.quoteYes} fair=${fresh.toFixed(4)} roi=${(e.roi * 100).toFixed(2)}%`);
    return { sent: true, quoteId: res.quoteId };
  }

  async function dropQuote(quoteId, phase, reason) {
    const p = pending.get(quoteId); if (!p) return;
    clearTimeout(p.timer); pending.delete(quoteId); byRfq.delete(p.rfq.rfqId);
    const rid = p.rfq.rfqId;
    if (reason === 'ttl') {
      // Routine cleanup only. Urgent cancels (price move / started game / decline / shutdown)
      // always go out, even if we think the RFQ is gone.
      if (isClosed(rid)) { stats.cancelSkipped += 1; }
      else {
        ttlCancelling.add(rid);
        try { const r = await trader.cancel(quoteId, { urgent: false, skipIf: () => isClosed(rid) }); if (r && r.skipped) stats.cancelSkipped += 1; } catch (e) { log(`[SNIPER] cancel ${quoteId} failed: ${e.message}`); } finally { ttlCancelling.delete(rid); }
      }
    } else {
      try { await trader.cancel(quoteId, { urgent: true }); } catch (e) { log(`[SNIPER] cancel ${quoteId} failed: ${e.message}`); }
    }
    await store.release(p.d.rfqId, phase, {});
    if (phase === 'declined') { bump(stats.declined, reason); log(`[SNIPER] DECLINE quote_id=${quoteId} rfq=${p.rfq.rfqId} reason=${reason}`); } else stats.cancelled += 1;
  }
  // Rule 9: pull every open (unconfirmed) quote touching a game that has reached commence time.
  async function pullStarted() {
    let n = 0;
    for (const [qid, p] of [...pending]) {
      if (confirming.has(qid)) continue;
      const r = startedReason(p.rfq); if (!r) continue;
      await dropQuote(qid, p.accepted ? 'declined' : 'cancelled', r); n += 1;
      log(`[SNIPER] PULLED quote_id=${qid} rfq=${p.rfq.rfqId} reason=${r}`);
    }
    return n;
  }
  async function expire(quoteId) {
    const p = pending.get(quoteId);
    if (!p || p.accepted || confirming.has(quoteId)) return;
    await dropQuote(quoteId, 'cancelled', 'ttl');
  }
  // Ledger reserve failed in the background: cancel our quote now (urgent) or as soon as the POST returns.
  const abortAfterPost = new Map();
  async function abortRfq(rfqId, reason) {
    const qid = byRfq.get(rfqId);
    if (qid && !confirming.has(qid)) { await dropQuote(qid, 'cancelled', reason); return true; }
    abortAfterPost.set(rfqId, reason); if (abortAfterPost.size > 2000) abortAfterPost.delete(abortAfterPost.keys().next().value);
    return false;
  }
  async function onRfqClosed(evt) {
    if (evt && evt.rfqId) noteClosed(evt.rfqId);
    const qid = evt && byRfq.get(evt.rfqId);
    const p = qid && pending.get(qid);
    if (!p || p.accepted || confirming.has(qid)) return;
    clearTimeout(p.timer); pending.delete(qid); byRfq.delete(p.rfq.rfqId);
    await store.release(p.d.rfqId, 'cancelled', {}); stats.cancelled += 1;
  }

  async function onAccepted(evt) {
    const quoteId = evt && evt.quoteId; const p = quoteId && pending.get(quoteId);
    if (!p) return { confirmed: false, reason: 'not_ours' };
    if (confirming.has(quoteId)) return { confirmed: false, reason: 'in_flight' };
    confirming.add(quoteId); p.accepted = true; clearTimeout(p.timer); stats.accepted += 1;
    try {
      const { d, rfq } = p;
      const decline = async (reason) => { await dropQuote(quoteId, 'declined', reason); return { confirmed: false, reason }; };
      if (!live()) return decline(halted ? 'halted' : 'not_live');
      if (!shouldConfirmAccept(p.yesBid, evt.acceptedSide)) return decline('yes_side_accept');
      const n = Number(evt.contractsAccepted) > 0 ? Number(evt.contractsAccepted) : d.contracts;
      if (n > config.maxPayout + 1e-9) return decline('payout_over_cap');
      const b = coord.blockReason(rfq); if (b) return decline(b);
      const fresh = reprice(rfq);
      const e = roiAt(d, fresh, n);
      if (!e || e.roi < (d.minRoi != null ? d.minRoi : config.minRoi) - 1e-12) return decline('reprice_below_min');
      const cap = await store.confirmCheck(d.rfqId, Math.round(e.risk * 100) / 100, caps());
      if (!cap.ok) return decline(`cap_${cap.reason}`);
      // Accepted: hold the exposure until the games settle (was only the short quote hold).
      try { await onHold(d); } catch (err) { log(`[SNIPER] hold extend failed rfq=${d.rfqId}: ${err.message}`); }
      try { await trader.confirm(evt.rfqId || rfq.rfqId, quoteId); } catch (err) {
        await store.release(d.rfqId, 'failed', {}); pending.delete(quoteId); byRfq.delete(rfq.rfqId);
        log(`[SNIPER] confirm failed quote_id=${quoteId}: ${err.message}`);
        return { confirmed: false, reason: 'confirm_failed' };
      }
      stats.confirmed += 1;
      // One Telegram message per fill: sent from onExecuted once fills are confirmed.
      log(`[SNIPER] ACCEPTED+confirmed rfq=${rfq.rfqId} quote_id=${quoteId} n=${n} yes=${d.quoteYes} fair=${fresh.toFixed(4)} roi=${(e.roi * 100).toFixed(1)}% risk=$${e.risk.toFixed(2)}`);
      return { confirmed: true };
    } finally { confirming.delete(quoteId); }
  }

  async function onExecuted(evt) {
    const quoteId = evt && evt.quoteId; const p = quoteId && pending.get(quoteId);
    if (!p) return { booked: false, reason: 'not_ours' };
    // Record the order id first so Combo Locks' fill readers can recognize it as a sniper order.
    if (evt.orderId) await store.update(p.d.rfqId, { order_id: evt.orderId });
    let book = null;
    for (let i = 0; i < fillRetries; i += 1) {
      try { book = await trader.fillsForOrder(evt.orderId); } catch (e) { log(`[SNIPER] fills read failed: ${e.message}`); }
      if (book && book.reason === 'confirmed') break;
      await sleep(fillRetryMs);
    }
    if (!book || book.reason !== 'confirmed') {
      await store.update(p.d.rfqId, { order_id: evt.orderId || null });
      log(`[SNIPER] executed but fills not yet visible rfq=${p.rfq.rfqId} order=${evt.orderId}`);
      alert(`🎯 SNIPER ⚠️ A quote was taken but Kalshi hasn't shown the fill yet (${p.d.legs.length}-leg parlay, about ${usdS(p.d.risk)} risk). The money stays reserved; the dashboard will update when it shows.`);
      return { booked: false, reason: book ? book.reason : 'fills_unreadable' };
    }
    const cost = book.book.reduce((s, r) => s + r.count * (Number(r.no_price) || 0), 0);
    const fee = book.book.reduce((s, r) => s + (Number(r.fee) || 0), 0);
    await store.update(p.d.rfqId, {
      phase: 'filled', order_id: evt.orderId, filled_contracts: book.contracts,
      filled_cost: Math.round(cost * 1e4) / 1e4, filled_fee: Math.round(fee * 1e4) / 1e4,
      fill_ids: book.book.map((r) => r.fill_id), market_ticker: p.rfq.marketTicker || (book.book[0] && book.book[0].ticker) || null,
    });
    stats.fills += 1; pending.delete(quoteId); byRfq.delete(p.rfq.rfqId);
    alert(formatFillAlert({ d: p.d, contracts: book.contracts, cost, fee, kickoffOf }));
    try { Promise.resolve(onFilled({ rfqId: p.d.rfqId, legs: p.d.legs, contracts: book.contracts, cost, fee })).catch(() => {}); } catch (_) { /* never blocks booking */ }
    return { booked: true, contracts: book.contracts };
  }

  // Settlement: result per market from Kalshi (public market data). We hold NO.
  async function settleOnce(marketResult, dayStartIso) {
    const rows = await store.openFilled();
    for (const r of rows) {
      if (!r.market_ticker) continue;
      let res; try { res = await marketResult(r.market_ticker); } catch (_) { continue; }
      if (res !== 'yes' && res !== 'no') { if (res === 'void' || res === 'cancelled') await store.release(r.rfq_id, 'settled', { market_result: res, realized_pnl: 0, settled_at: new Date(now()).toISOString() }); continue; }
      const n = Number(r.filled_contracts) || 0; const cost = Number(r.filled_cost) || 0; const fee = Number(r.filled_fee) || 0;
      const pnl = (res === 'no' ? n : 0) - cost - fee;
      await store.release(r.rfq_id, 'settled', { market_result: res, realized_pnl: Math.round(pnl * 1e4) / 1e4, settled_at: new Date(now()).toISOString() });
      stats.settled += 1;
    }
    const day = await store.dayRealized(dayStartIso);
    if (!halted && -day >= config.dailyLossCap) {
      halted = true; haltReason = 'daily_loss'; haltDay = etDayKey(now()); onHalt('daily_loss');
      alert(`🎯 SNIPER (not Combo Locks) 🛑 AUTO-DISABLED: realized loss today $${(-day).toFixed(2)} ≥ $${config.dailyLossCap} daily stop. No new quotes until the next ET day (auto-resumes after midnight ET).`);
    }
    return day;
  }

  function halt(reason) { if (!halted) { halted = true; haltReason = reason; haltDay = etDayKey(now()); onHalt(reason); } }
  // Daily-loss stop lifts at the next ET day. Other halts (rate limit) still need a restart.
  function resumeIfNewDay() {
    if (halted && haltReason === 'daily_loss' && etDayKey(now()) !== haltDay) {
      halted = false; haltReason = null; haltDay = null;
      alert('🎯 SNIPER (not Combo Locks) — new ET day: daily loss stop lifted, quoting resumes.');
      return true;
    }
    return false;
  }
  // Graceful stop (SIGTERM): stop sending, cancel every open unaccepted quote on Kalshi and
  // release its row. Accepted / confirming quotes are left to the DB (phase accepted).
  let stopping = false;
  async function shutdown() {
    stopping = true; halted = true; haltReason = haltReason || 'shutdown';
    let n = 0;
    for (const [qid, p] of [...pending]) {
      if (p.accepted || confirming.has(qid)) continue;
      await dropQuote(qid, 'cancelled', 'shutdown'); n += 1;
    }
    return n;
  }
  return { shutdown, stopping: () => stopping, send, abortRfq, hasRfqId: (id) => byRfq.has(id) || inflight.has(id) || ttlCancelling.has(id), forEachRfqId: (cb) => { for (const id of byRfq.keys()) cb(id); for (const id of inflight) cb(id); for (const id of ttlCancelling) cb(id); }, isClosed, onAccepted, onExecuted, onRfqClosed, settleOnce, halt, resumeIfNewDay, pullStarted, haltReason: () => haltReason, halted: () => halted, pending, stats: () => { const a = [...stats.postMs].sort((x, y) => x - y); return { ...stats, postFailBy: { ...stats.postFailBy }, postMs: undefined, postP50: a.length ? a[Math.floor(a.length / 2)] : null, postP90: a.length ? a[Math.floor(a.length * 0.9)] : null, pending: pending.size }; }, _minQuotePrice: minQuotePrice };
}

module.exports = { createLiveSniper, postFailKey };
