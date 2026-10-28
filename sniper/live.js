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
const { mapLimit } = require('./release-batch');
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
  onHold = () => {}, startedReason = () => null, kickoffOf = () => null, onFilled = () => {}, pullConcurrency = 4, pullGuard = true, requoteMemo = null,
  // Oct 28 2026 fix 3: onLateAccept(rec) gets every quote_accepted we did not act on (async, after the
  // handler returned). earlyRegister: track a quote as ours BEFORE the ledger 'quoted' write lands
  // (accept-race fix; SNIPER_EARLY_REGISTER=0 = old order). defer: scheduler for the late-accept log.
  // Oct 28 2026 cancel-backlog fixes (all off by default here; runner turns them on):
  //   cancelFifo: routine DELETEs go out oldest-first through a bounded pump (cancelConcurrency wide)
  //     instead of N parallel waiters racing for tokens (the race let some quotes wait minutes).
  //   postGate (sniper/cancel-backlog createPostGate): drop lowest-EV posts while the cancel queue is backed up.
  //   qtoBreaker (createQtoBreaker): pause posts during Kalshi 409 quote_timed_out bursts.
  //   qtoSampleEvery / qtoSampleFirst: sampled log of those 409s (RFQ age, Kalshi request id, body).
  cancelFifo = false, cancelConcurrency = 8, postGate = null, qtoBreaker = null, qtoSampleEvery = 50, qtoSampleFirst = 10,
  onLateAccept = () => {}, earlyRegister = true, defer = (fn) => setImmediate(fn), // requoteMemo: sniper/send-window createRequoteMemo (same-price re-quote skip) // onFilled: book-arb check (alert-only) // kickoffOf: ticker -> kickoff ms (fill alert); startedReason: (rfq) -> 'game_started' | 'no_kickoff' | null (rule 9)
} = {}) {
  const pending = new Map(); // quoteId -> { d, rfq, accepted, timer }
  const byRfq = new Map(); // rfqId -> quoteId
  const confirming = new Set();
  // RFQs Kalshi has closed/deleted (ws rfq_deleted etc.). Kalshi drops our quote with the RFQ, so a
  // routine TTL cancel for these is a wasted DELETE on the shared write budget. Bounded + aged.
  const closed = new Map(); // rfqId -> closedAtMs
  const CLOSED_KEEP_MS = 120000; const CLOSED_MAX = 20000;
  const inflight = new Set(); // rfqIds with a quote POST in flight (no quoteId yet)
  // Fix 3 (Oct 28 2026): quotes we stopped tracking, so a later quote_accepted can be explained
  // (expired by our TTL too soon? replaced? RFQ closed?). quoteId -> { rfqId, postedAt, droppedAt, reason, ev }.
  // Bounded + aged; one Map.set on the drop path, nothing on the quote path.
  const recent = new Map(); const RECENT_MAX = 20000; const RECENT_KEEP_MS = 120000;
  const noteDropped = (quoteId, p, reason) => {
    if (!quoteId || !p) return;
    recent.set(quoteId, { rfqId: p.rfq && p.rfq.rfqId, postedAt: p.postedAt, droppedAt: now(), reason, ev: p.d && p.d.ev, legs: p.d && p.d.legs ? p.d.legs.length : null });
    if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
  };
  // rfqId -> quoteId once the POST returned but before pending.set (only non-empty with earlyRegister off).
  const posted = new Map();
  // Accepts that arrived while our POST for that RFQ was still in flight (quoteId unknown yet): replayed
  // once the POST returns (earlyRegister only). rfqId -> { evt, at }.
  const earlyAccepts = new Map();
  const ttlCancelling = new Set(); // rfqIds whose routine cancel is queued
  const queuedCancel = new Map(); // quoteId -> postedAt for routine DELETEs still waiting for a write token
  // cancelFifo: routine DELETEs in drop order (TTL is fixed, so ~oldest quote first). Entries whose
  // quote left queuedCancel (skipped / snapshot) are discarded when reached.
  const cancelQ = []; let cancelActive = 0; const cancelRid = new Map(); // quoteId -> rfqId (queued routine DELETEs)
  let backlogCache = null; let backlogAt = 0;
  function backlogState() {
    const t = now();
    if (backlogCache && t - backlogAt < 200) return backlogCache;
    // Counts only DELETEs that will really be sent: a queued quote whose RFQ closed / that Kalshi no
    // longer lists is skipped for free when the pump reaches it, so it is not backlog.
    let oldest = null; let n = 0;
    for (const [qid, at] of queuedCancel) {
      const rid = cancelRid.get(qid);
      if ((rid && isClosed(rid)) || isGone(qid)) continue;
      n += 1; if (Number.isFinite(at) && (oldest == null || at < oldest)) oldest = at;
    }
    backlogCache = { queued: n, oldestAgeMs: oldest == null ? null : t - oldest }; backlogAt = t;
    return backlogCache;
  }
  // Routine DELETEs we skipped because a snapshot said "not open": quoteId -> skippedAt. Backstop: if a
  // later snapshot lists the quote as open after all, the DELETE is sent then (never left resting).
  const skippedNotOpen = new Map(); const SKIPPED_KEEP_MS = 120000;
  const noteSkippedNotOpen = (qid) => { if (gone.has(qid) && gone.get(qid).status === 'not_open') { skippedNotOpen.set(qid, now()); if (skippedNotOpen.size > GONE_MAX) skippedNotOpen.delete(skippedNotOpen.keys().next().value); } };
  const noteClosed = (rfqId) => {
    if (!rfqId) return;
    const t = now(); closed.set(rfqId, t);
    if (closed.size > CLOSED_MAX) { for (const [k, v] of closed) { if (closed.size <= CLOSED_MAX && t - v < CLOSED_KEEP_MS) break; closed.delete(k); } }
  };
  // Quotes Kalshi itself reports as no longer open (GET /communications/quotes poll, read lane):
  // cancelled with the RFQ (expired / executed with another maker / deleted). A DELETE for these is
  // a wasted write. quoteId -> status. Bounded + aged like `closed`.
  const gone = new Map(); const GONE_MAX = 20000;
  const isGone = (quoteId) => { const g = gone.get(quoteId); if (!g) return false; if (now() - g.at > CLOSED_KEEP_MS) { gone.delete(quoteId); return false; } return true; };
  const isClosed = (rfqId) => { const t = closed.get(rfqId); if (t == null) return false; if (now() - t > CLOSED_KEEP_MS) { closed.delete(rfqId); return false; } return true; };
  const stats = { cancelSkipped: 0, posted: 0, postFail: 0, staleDrop: 0, postFailBy: {}, postMs: [], preMs: [], cwMs: [], sendMs: [], accepted: 0, confirmed: 0, declined: {}, fills: 0, cancelled: 0, settled: 0, aborted: {}, droppedExpired: 0, droppedLowPriority: 0,
    // Cancel accounting (Oct 28 2026): DELETEs actually requested vs avoided, and why.
    cancelSent: 0, cancelAvoided: { rfq_closed_ws: 0, quote_gone_kalshi: 0, not_open_snapshot: 0, not_open_while_queued: 0, closed_while_queued: 0, closed_during_post: 0 }, releasedByWs: 0, releasedByPoll: 0,
    // Fix 3: accepts we did not act on, by class / accepted side; fix 2: waiting quotes replaced.
    lateAccepts: {}, lateAcceptsBySide: {}, earlyAcceptReplayed: 0, superseded: 0, markedNotOpen: 0, notOpenReappeared: 0 };
  // Send latency = RFQ age (Kalshi created_ts, via the receive-time age) when our POST returned.
  const sendAgeMs = (rfq) => (rfq && rfq.recvAt ? now() - rfq.recvAt + (Number(rfq.recvAge) || 0) : null);
  const pushSend = (ms) => { if (Number.isFinite(ms)) { stats.sendMs.push(ms); if (stats.sendMs.length > 500) stats.sendMs.shift(); } };
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
    // Releases are fire-and-forget here: with the write-behind store a release is chained after this
    // RFQ's background reserve, and awaiting it made a failed POST look like it took ~55s (v49).
    // liveStore.release frees the in-memory reservation synchronously before the DB write.
    const bg = (p) => { Promise.resolve(p).catch((e) => log(`[SNIPER] release error rfq=${d.rfqId}: ${e && e.message}`)); };
    const tSend = now();
    const abort = async (reason) => { bump(stats.aborted, reason); bg(store.release(d.rfqId, 'cancelled', {})); return { sent: false, reason }; };
    if (!live()) return abort(halted ? 'halted' : 'not_live');
    const st = startedReason(rfq); if (st) return abort(st);
    const b = coord.blockReason(rfq); if (b) return abort(b);
    const tCw = now(); const cw = await coord.comboWorkerQuoting(rfq.rfqId);
    stats.cwMs.push(now() - tCw); if (stats.cwMs.length > 200) stats.cwMs.shift();
    if (cw) return abort(cw);
    stats.preMs.push(now() - tSend); if (stats.preMs.length > 200) stats.preMs.shift();
    // Re-price at send time with the freshest books.
    const fresh = reprice(rfq);
    const e = roiAt(d, fresh);
    if (!e || e.roi < (d.minRoi != null ? d.minRoi : config.minRoi) - 1e-12) return abort('reprice_below_min');
    // Cancel-backlog gate / 409 breaker: re-checked right before the POST (the runner already checked
    // before the DB reserve). Only posts are dropped; cancels and confirms never pass through here.
    if (qtoBreaker && qtoBreaker.paused()) { qtoBreaker.drop(); return abort('qto_breaker'); }
    if (postGate) { const g = postGate.check(Number.isFinite(e.ev) ? e.ev : d.ev, backlogState(), { record: false }); if (g) return abort(g); }
    let res;
    const tPost = now();
    inflight.add(rfq.rfqId);
    try { res = await trader.postQuote(rfq, d.quoteYes, config.tick, { priority: Number.isFinite(e.ev) ? e.ev : 0 }); } catch (err) {
      inflight.delete(rfq.rfqId); earlyAccepts.delete(rfq.rfqId);
      // Free the reservation first so a failed POST never sits in pending risk.
      const postMs = now() - tPost;
      stats.postMs.push(postMs); if (stats.postMs.length > 200) stats.postMs.shift();
      bg(store.release(d.rfqId, 'failed', {}));
      const k = postFailKey(err); bump(stats.postFailBy, k);
      if (k.startsWith('stale_drop')) stats.staleDrop += 1; else stats.postFail += 1;
      const isQto = k === 'http_409:quote_timed_out';
      if (qtoBreaker && !k.startsWith('stale_drop')) qtoBreaker.record(isQto);
      if (isQto) {
        // Sampled (first qtoSampleFirst, then 1 in qtoSampleEvery): RFQ age when the POST started / ended,
        // Kalshi request id and body. Unsampled 409s are only counted (bursts were ~1,200 log lines/min).
        stats.qtoSeen = (stats.qtoSeen || 0) + 1;
        if (stats.qtoSeen <= qtoSampleFirst || (qtoSampleEvery > 0 && stats.qtoSeen % qtoSampleEvery === 0)) {
          stats.qtoSampled = (stats.qtoSampled || 0) + 1;
          const ageEnd = sendAgeMs(rfq);
          log(`[SNIPER] QTO_SAMPLE n=${stats.qtoSeen} rfq=${rfq.rfqId} rfq_age_start=${ageEnd == null ? '?' : `${ageEnd - postMs}ms`} rfq_age_end=${ageEnd == null ? '?' : `${ageEnd}ms`} post_ms=${postMs} wire_ms=${err.wireMs == null ? '?' : err.wireMs} pre=${tPost - tSend} legs=${d.legs ? d.legs.length : '?'} ev=${Number.isFinite(e.ev) ? e.ev.toFixed(2) : '?'} req_id=${err.requestId || '?'} status=${err.statusCode || '?'} body=${String(err.body || err.message || '').slice(0, 300)}`);
        }
        return { sent: false, reason: 'post_failed' };
      }
      if (k === 'stale_drop:expired') stats.droppedExpired += 1;
      else if (k === 'stale_drop:low_priority') stats.droppedLowPriority += 1;
      // Deadline drops are routine under load (counted + summarized each minute); log the rest.
      if (k !== 'stale_drop:expired' && k !== 'stale_drop:low_priority') log(`[SNIPER] quote POST failed rfq=${rfq.rfqId} kind=${k} ms=${postMs} pre=${tPost - tSend}: ${String(err.message || err).slice(0, 400)}`);
      return { sent: false, reason: k.startsWith('stale_drop') ? 'post_stale_drop' : 'post_failed' };
    }
    inflight.delete(rfq.rfqId);
    stats.postMs.push(now() - tPost); if (stats.postMs.length > 200) stats.postMs.shift();
    if (qtoBreaker) qtoBreaker.record(false);
    if (!res.quoteId) { await store.release(d.rfqId, 'failed', {}); return { sent: false, reason: 'no_quote_id' }; }
    stats.posted += 1; pushSend(sendAgeMs(rfq));
    if (requoteMemo) requoteMemo.note(d, res.noBid);
    if (earlyRegister) {
      // Accept-race fix (Oct 28 2026): register the quote as ours BEFORE awaiting the ledger write. The
      // batched ledger resolves update() only after its next flush (300 ms timer + DB), and a
      // quote_accepted arriving in that gap hit onAccepted -> not_ours and was dropped (Kalshi then
      // expired it after acceptance). confirmCheck still flushes this RFQ's row before the DB cap check.
      const entry = { d, rfq, accepted: false, yesBid: res.yesBid, timer: null, postedAt: now() };
      entry.timer = setTimeout(() => { expire(res.quoteId).catch(() => {}); }, ttlMs);
      if (entry.timer.unref) entry.timer.unref();
      pending.set(res.quoteId, entry); byRfq.set(rfq.rfqId, res.quoteId);
      const ea = earlyAccepts.get(rfq.rfqId);
      if (ea) { earlyAccepts.delete(rfq.rfqId); if (!ea.evt.quoteId || ea.evt.quoteId === res.quoteId) { stats.earlyAcceptReplayed += 1; onAccepted(ea.evt).catch((e) => log(`[SNIPER] accept error: ${e.message}`)); } }
      await store.update(d.rfqId, { phase: 'quoted', quote_id: res.quoteId, no_bid: res.noBid });
      const cur = pending.get(res.quoteId);
      if (cur && isClosed(rfq.rfqId) && !cur.accepted && !confirming.has(res.quoteId)) {
        clearTimeout(cur.timer); pending.delete(res.quoteId); byRfq.delete(rfq.rfqId); noteDropped(res.quoteId, cur, 'closed_during_post');
        await store.release(d.rfqId, 'cancelled', {}); stats.cancelled += 1; stats.cancelSkipped += 1; stats.cancelAvoided.closed_during_post += 1;
        log(`[SNIPER] LIVE QUOTE rfq=${rfq.rfqId} quote_id=${res.quoteId} closed during POST, no cancel needed`);
        return { sent: true, quoteId: res.quoteId };
      }
      if (abortAfterPost.has(rfq.rfqId)) { const r = abortAfterPost.get(rfq.rfqId); abortAfterPost.delete(rfq.rfqId); if (cur && !cur.accepted && !confirming.has(res.quoteId)) await dropQuote(res.quoteId, 'cancelled', r); return { sent: true, quoteId: res.quoteId, aborted: r }; }
      log(`[SNIPER] LIVE QUOTE rfq=${rfq.rfqId} quote_id=${res.quoteId} no_bid=${res.noBid} yes=${d.quoteYes} fair=${fresh.toFixed(4)} roi=${(e.roi * 100).toFixed(2)}%`);
      return { sent: true, quoteId: res.quoteId };
    }
    posted.set(rfq.rfqId, res.quoteId);
    try { await store.update(d.rfqId, { phase: 'quoted', quote_id: res.quoteId, no_bid: res.noBid }); } finally { posted.delete(rfq.rfqId); }
    if (isClosed(rfq.rfqId)) {
      // RFQ closed while our POST was in flight: the quote died with it. No TTL timer, no cancel.
      await store.release(d.rfqId, 'cancelled', {}); stats.cancelled += 1; stats.cancelSkipped += 1; stats.cancelAvoided.closed_during_post += 1;
      log(`[SNIPER] LIVE QUOTE rfq=${rfq.rfqId} quote_id=${res.quoteId} closed during POST, no cancel needed`);
      return { sent: true, quoteId: res.quoteId };
    }
    const entry = { d, rfq, accepted: false, yesBid: res.yesBid, timer: null, postedAt: now() };
    entry.timer = setTimeout(() => { expire(res.quoteId).catch(() => {}); }, ttlMs);
    if (entry.timer.unref) entry.timer.unref();
    pending.set(res.quoteId, entry); byRfq.set(rfq.rfqId, res.quoteId);
    if (abortAfterPost.has(rfq.rfqId)) { const r = abortAfterPost.get(rfq.rfqId); abortAfterPost.delete(rfq.rfqId); await dropQuote(res.quoteId, 'cancelled', r); return { sent: true, quoteId: res.quoteId, aborted: r }; }
    log(`[SNIPER] LIVE QUOTE rfq=${rfq.rfqId} quote_id=${res.quoteId} no_bid=${res.noBid} yes=${d.quoteYes} fair=${fresh.toFixed(4)} roi=${(e.roi * 100).toFixed(2)}%`);
    return { sent: true, quoteId: res.quoteId };
  }

  function routineSkipped(quoteId, rid) {
    stats.cancelSkipped += 1; stats.cancelAvoided.closed_while_queued += 1;
    if (!isClosed(rid) && gone.has(quoteId) && gone.get(quoteId).status === 'not_open') { stats.cancelAvoided.not_open_while_queued += 1; noteSkippedNotOpen(quoteId); }
  }
  function pumpCancels() {
    while (cancelActive < cancelConcurrency && cancelQ.length) {
      const { quoteId, rid } = cancelQ.shift();
      if (!queuedCancel.has(quoteId)) continue;
      const done = () => { ttlCancelling.delete(rid); queuedCancel.delete(quoteId); cancelRid.delete(quoteId); backlogCache = null; };
      if (isClosed(rid) || isGone(quoteId)) { routineSkipped(quoteId, rid); done(); continue; }
      cancelActive += 1;
      (async () => {
        try {
          const r = await trader.cancel(quoteId, { urgent: false, skipIf: () => isClosed(rid) || isGone(quoteId) });
          if (r && r.skipped) routineSkipped(quoteId, rid); else stats.cancelSent += 1;
        } catch (e) { log(`[SNIPER] cancel ${quoteId} failed: ${e.message}`); } finally { done(); cancelActive -= 1; pumpCancels(); }
      })();
    }
  }
  async function dropQuote(quoteId, phase, reason) {
    const p = pending.get(quoteId); if (!p) return;
    clearTimeout(p.timer); pending.delete(quoteId); byRfq.delete(p.rfq.rfqId); noteDropped(quoteId, p, reason);
    const rid = p.rfq.rfqId;
    // 'superseded' (fix 2: a new RFQ on the same parlay replaced this waiting quote) is routine cleanup
    // exactly like the TTL: it would have been TTL-cancelled anyway, just later.
    if (reason === 'ttl' || reason === 'superseded') {
      // Routine cleanup only. Urgent cancels (price move / started game / decline / shutdown)
      // always go out, even if we think the RFQ is gone.
      // Oct 26 2026: release the ledger row NOW and send the routine cancel in the background.
      // Awaiting the (low-priority) DELETE first left ~210 rows / $9.6K 'quoted' in the DB for
      // minutes and blocked fresh quotes on the same combo (open-combo unique index). An expired
      // quote can't fill without our confirm (onAccepted -> not_ours), so releasing first is safe.
      await store.release(p.d.rfqId, phase, {}); stats.cancelled += 1;
      if (isClosed(rid)) { stats.cancelSkipped += 1; stats.cancelAvoided.rfq_closed_ws += 1; }
      else if (isGone(quoteId)) { stats.cancelSkipped += 1; stats.cancelAvoided.quote_gone_kalshi += 1; if (gone.get(quoteId).status === 'not_open') { stats.cancelAvoided.not_open_snapshot += 1; noteSkippedNotOpen(quoteId); } }
      else {
        ttlCancelling.add(rid); queuedCancel.set(quoteId, p.postedAt); cancelRid.set(quoteId, rid); backlogCache = null;
        if (cancelFifo) { cancelQ.push({ quoteId, rid }); pumpCancels(); return; }
        (async () => {
          // Re-checked while the routine DELETE waits for a token: the RFQ closing on the WS or Kalshi
          // reporting the quote cancelled (status poll) both make the DELETE pointless.
          try {
            const r = await trader.cancel(quoteId, { urgent: false, skipIf: () => isClosed(rid) || isGone(quoteId) });
            if (r && r.skipped) { stats.cancelSkipped += 1; stats.cancelAvoided.closed_while_queued += 1; if (!isClosed(rid) && gone.has(quoteId) && gone.get(quoteId).status === 'not_open') { stats.cancelAvoided.not_open_while_queued += 1; noteSkippedNotOpen(quoteId); } } else stats.cancelSent += 1;
          } catch (e) { log(`[SNIPER] cancel ${quoteId} failed: ${e.message}`); } finally { ttlCancelling.delete(rid); queuedCancel.delete(quoteId); cancelRid.delete(quoteId); }
        })();
      }
      return;
    } else {
      try { await trader.cancel(quoteId, { urgent: true }); stats.cancelSent += 1; } catch (e) { log(`[SNIPER] cancel ${quoteId} failed: ${e.message}`); }
    }
    await store.release(p.d.rfqId, phase, {});
    if (phase === 'declined') { bump(stats.declined, reason); log(`[SNIPER] DECLINE quote_id=${quoteId} rfq=${p.rfq.rfqId} reason=${reason}`); } else stats.cancelled += 1;
  }
  // Rule 9: pull every open (unconfirmed) quote touching a game that has reached commence time.
  // Rule 9 sweep. One at a time (a 5s interval must never stack sweeps), cancels pullConcurrency wide.
  let pulling = false; stats.pullSkipped = 0;
  async function pullStarted() {
    if (pullGuard && pulling) { stats.pullSkipped += 1; return 0; }
    pulling = true;
    try {
      const todo = [];
      for (const [qid, p] of [...pending]) {
        if (confirming.has(qid)) continue;
        const r = startedReason(p.rfq); if (!r) continue;
        todo.push([qid, p, r]);
      }
      await mapLimit(todo, pullConcurrency, async ([qid, p, r]) => {
        await dropQuote(qid, p.accepted ? 'declined' : 'cancelled', r);
        log(`[SNIPER] PULLED quote_id=${qid} rfq=${p.rfq.rfqId} reason=${r}`);
      });
      return todo.length;
    } finally { pulling = false; }
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
    clearTimeout(p.timer); pending.delete(qid); byRfq.delete(p.rfq.rfqId); noteDropped(qid, p, 'rfq_closed_ws');
    await store.release(p.d.rfqId, 'cancelled', {}); stats.cancelled += 1; stats.releasedByWs += 1;
  }

  // Kalshi quote-status poll (read lane, no write budget): quotes Kalshi reports as `cancelled` are
  // already dead on the exchange (their RFQ expired / was deleted / executed with another maker),
  // so the pending one is released with no DELETE and a queued routine DELETE is skipped.
  // accepted / confirmed / executed are left to the WS handlers (onAccepted / onExecuted).
  async function onQuoteStatuses(list) {
    let released = 0;
    for (const q of list || []) {
      const id = q && (q.id || q.quote_id); const st = String((q && q.status) || '').toLowerCase();
      if (!id || st !== 'cancelled') continue;
      gone.set(id, { status: st, at: now() }); if (gone.size > GONE_MAX) gone.delete(gone.keys().next().value);
      const p = pending.get(id);
      if (!p || p.accepted || confirming.has(id)) continue;
      clearTimeout(p.timer); pending.delete(id); byRfq.delete(p.rfq.rfqId); noteDropped(id, p, 'kalshi_cancelled_poll');
      await store.release(p.d.rfqId, 'cancelled', {}); stats.cancelled += 1; stats.releasedByPoll += 1; released += 1;
    }
    return released;
  }

  // Fix 3 (Oct 28 2026): a quote_accepted for a quote we no longer (or never) tracked. Classified and
  // counted synchronously (two Map lookups + a counter); the log line and the onLateAccept callback
  // (runner: one sniper_decisions row) run later via defer, so the WS handler returns immediately and
  // nothing in the quote path waits on it.
  //   after_ttl            we expired it ourselves (12s TTL) -> evidence quotes expire too soon
  //   superseded           replaced by a newer RFQ on the same parlay (fix 2)
  //   after_rfq_closed_ws / after_kalshi_cancelled_poll / after_<urgent reason>   released for that reason
  //   during_post          POST returned but the quote was not registered yet (accept race)
  //   during_post_buffered accept arrived while our POST was in flight; replayed when it returns
  //   unknown              never ours in this process (another process / Combo Locks / before a restart)
  function lateAccept(evt, forced = null) {
    const quoteId = evt && evt.quoteId; const rid = evt && evt.rfqId;
    const r = quoteId ? recent.get(quoteId) : null;
    const fresh = r && now() - r.droppedAt <= RECENT_KEEP_MS ? r : null;
    let cls = forced;
    if (!cls) {
      if (fresh) cls = fresh.reason === 'ttl' ? 'after_ttl' : fresh.reason === 'superseded' ? 'superseded' : `after_${fresh.reason}`;
      else if (rid && (posted.has(rid) || inflight.has(rid))) cls = 'during_post';
      else cls = 'unknown';
    }
    const side = String((evt && evt.acceptedSide) || '').toLowerCase() || 'unknown';
    stats.lateAccepts[cls] = (stats.lateAccepts[cls] || 0) + 1;
    stats.lateAcceptsBySide[side] = (stats.lateAcceptsBySide[side] || 0) + 1;
    const at = now();
    const rec = {
      quoteId: quoteId || null, rfqId: rid || (fresh && fresh.rfqId) || null, cls, side,
      ageMs: fresh && fresh.postedAt != null ? at - fresh.postedAt : null,
      sinceDropMs: fresh ? at - fresh.droppedAt : null, ev: fresh ? fresh.ev : null, legs: fresh ? fresh.legs : null,
      contracts: evt && evt.contractsAccepted != null ? evt.contractsAccepted : null,
    };
    defer(() => {
      try {
        if (cls !== 'unknown' || stats.lateAccepts.unknown <= 20 || stats.lateAccepts.unknown % 50 === 0) {
          log(`[SNIPER] LATE_ACCEPT cls=${cls} side=${side} quote_id=${rec.quoteId} rfq=${rec.rfqId} age=${rec.ageMs == null ? '?' : `${rec.ageMs}ms`} sinceDrop=${rec.sinceDropMs == null ? '?' : `${rec.sinceDropMs}ms`}`);
        }
        Promise.resolve(onLateAccept(rec)).catch(() => {});
      } catch (_) { /* metrics only */ }
    });
    return cls;
  }

  // Fix 2 (Oct 28 2026): can a new RFQ on the same parlay replace our waiting quote on rfqId? Only a
  // quote this process tracks, posted, not accepted / confirming, and either older than minAgeMs (most
  // takes land in the first ~1-3 s) or worth less than the new quote.
  function canSupersede(rfqId, { ev = null, minAgeMs = 3000 } = {}) {
    if (!live() || !rfqId || inflight.has(rfqId) || posted.has(rfqId)) return false;
    const qid = byRfq.get(rfqId); const p = qid && pending.get(qid);
    if (!p || p.accepted || confirming.has(qid)) return false;
    if (now() - p.postedAt >= minAgeMs) return true;
    return Number.isFinite(ev) && Number.isFinite(p.d && p.d.ev) && ev > p.d.ev;
  }
  // Pull the waiting quote on rfqId: untracked + ledger released NOW (memory synchronously), routine
  // DELETE in the background (skipped if Kalshi already closed it). If it is accepted afterwards we do
  // not confirm it (logged as LATE_ACCEPT superseded), so a parlay is never doubled.
  function supersede(rfqId) {
    const qid = byRfq.get(rfqId); const p = qid && pending.get(qid);
    if (!p || p.accepted || confirming.has(qid)) return false;
    stats.superseded += 1;
    dropQuote(qid, 'cancelled', 'superseded').catch((e) => log(`[SNIPER] supersede ${qid} failed: ${e.message}`));
    return true;
  }

  // Open-quote snapshot (Oct 28 2026; replaces the status=cancelled poll, which Kalshi can't answer for
  // un-accepted quotes). snap = { ids: Set of OPEN quote ids, complete, startedAt (local ms when the read
  // began), newestCreatedLocalMs }. A tracked quote is marked gone only when ALL hold:
  //   - the snapshot is complete (every page read) and the read succeeded,
  //   - the quote was posted at least graceMs before the read began (listing lag),
  //   - the snapshot already lists a quote created at/after ours (the listing has caught up past it),
  //   - it is not accepted / confirming.
  // "Gone" only skips the ROUTINE TTL DELETE (now, or while it waits for a token). It never releases
  // the quote early (an accept the WS hasn't delivered yet still confirms) and never touches urgent
  // cancels. Unknown / listed-open => the DELETE goes out as before.
  function onOpenSnapshot(snap, { graceMs = 2000 } = {}) {
    if (!snap || !snap.complete || !(snap.ids instanceof Set) || !Number.isFinite(snap.startedAt)) return 0;
    const newest = Number.isFinite(snap.newestCreatedLocalMs) ? snap.newestCreatedLocalMs : null;
    let marked = 0;
    const consider = (qid, postedAt, p) => {
      if (!qid || snap.ids.has(qid) || isGone(qid)) return;
      if (p && (p.accepted || confirming.has(qid))) return;
      if (!Number.isFinite(postedAt) || postedAt + graceMs > snap.startedAt) return;
      if (newest == null || newest < postedAt) return;
      gone.set(qid, { status: 'not_open', at: now() }); if (gone.size > GONE_MAX) gone.delete(gone.keys().next().value);
      marked += 1;
    };
    for (const [qid, p] of pending) consider(qid, p.postedAt, p);
    for (const [qid, postedAt] of queuedCancel) consider(qid, postedAt, null);
    stats.markedNotOpen += marked;
    // Backstop: listed open after all -> forget the mark, and send any DELETE we skipped for it.
    for (const qid of snap.ids) {
      const g = gone.get(qid); if (g && g.status === 'not_open') gone.delete(qid);
      if (skippedNotOpen.has(qid)) {
        skippedNotOpen.delete(qid); stats.notOpenReappeared += 1;
        if (live()) trader.cancel(qid, { urgent: false }).then(() => { stats.cancelSent += 1; }).catch((e) => log(`[SNIPER] cancel ${qid} failed: ${e.message}`));
      }
    }
    for (const [qid, at] of skippedNotOpen) { if (now() - at <= SKIPPED_KEEP_MS) break; skippedNotOpen.delete(qid); }
    return marked;
  }

  async function onAccepted(evt) {
    const quoteId = evt && evt.quoteId; const p = quoteId && pending.get(quoteId);
    if (!p) {
      // POST for this RFQ still in flight (quoteId not known yet): hold the accept and replay it the
      // moment the POST returns (earlyRegister). Kalshi gives the maker a few seconds to confirm.
      const rid = evt && evt.rfqId;
      if (earlyRegister && rid && inflight.has(rid)) {
        earlyAccepts.set(rid, { evt, at: now() }); if (earlyAccepts.size > 2000) earlyAccepts.delete(earlyAccepts.keys().next().value);
        lateAccept(evt, 'during_post_buffered');
        return { confirmed: false, reason: 'buffered' };
      }
      lateAccept(evt);
      return { confirmed: false, reason: 'not_ours' };
    }
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
      const cap = await store.confirmCheck(d.rfqId, Math.round(e.risk * 100) / 100, caps(d));
      if (!cap.ok) return decline(`cap_${cap.reason}`);
      // Accepted: hold the exposure until the games settle (was only the short quote hold).
      try { await onHold(d); } catch (err) { log(`[SNIPER] hold extend failed rfq=${d.rfqId}: ${err.message}`); }
      try { await trader.confirm(evt.rfqId || rfq.rfqId, quoteId); } catch (err) {
        await store.release(d.rfqId, 'failed', {}); noteDropped(quoteId, p, 'confirm_failed'); pending.delete(quoteId); byRfq.delete(rfq.rfqId);
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
    // 8 wide (urgent cancels) so a few hundred resting quotes clear well inside Fly's kill_timeout.
    const todo = [...pending].filter(([qid, p]) => !p.accepted && !confirming.has(qid));
    await mapLimit(todo, 8, ([qid]) => dropQuote(qid, 'cancelled', 'shutdown'));
    return todo.length;
  }
  const pct = (arr, q) => { if (!arr.length) return null; const b = [...arr].sort((x, y) => x - y); return Math.round(b[Math.min(b.length - 1, Math.floor(b.length * q))]); };
  return { sendLatency: () => ({ n: stats.sendMs.length, p50: pct(stats.sendMs, 0.5), p90: pct(stats.sendMs, 0.9) }), shutdown, stopping: () => stopping, send, abortRfq, hasRfqId: (id) => byRfq.has(id) || inflight.has(id) || ttlCancelling.has(id), forEachRfqId: (cb) => { for (const id of byRfq.keys()) cb(id); for (const id of inflight) cb(id); for (const id of ttlCancelling) cb(id); }, isClosed, isGone, onQuoteStatuses, onOpenSnapshot, queuedCancelCount: () => queuedCancel.size, backlogState, isTrackedQuote: (qid) => pending.has(qid) || queuedCancel.has(qid) || skippedNotOpen.has(qid), postBlockReason: (ev) => {
    if (qtoBreaker && qtoBreaker.paused()) { qtoBreaker.drop(); return 'qto_breaker'; }
    return postGate ? postGate.check(ev, backlogState(), { record: true }) : null;
  }, canSupersede, supersede, lateAccept, oldestPendingMs: () => { let m = null; for (const p of pending.values()) { const t = p.postedAt; if (t != null && (m == null || t < m)) m = t; } return m; }, onAccepted, onExecuted, onRfqClosed, settleOnce, halt, resumeIfNewDay, pullStarted, haltReason: () => haltReason, halted: () => halted, pending, stats: () => { const a = [...stats.postMs].sort((x, y) => x - y); return { ...stats, postFailBy: { ...stats.postFailBy }, cancelAvoided: { ...stats.cancelAvoided }, lateAccepts: { ...stats.lateAccepts }, lateAcceptsBySide: { ...stats.lateAcceptsBySide }, backlog: { ...backlogState(), fifo: cancelFifo, fifoQueued: cancelQ.length, fifoActive: cancelActive }, postGate: postGate ? postGate.stats() : null, qtoBreaker: qtoBreaker ? qtoBreaker.stats() : null, postMs: undefined, preMs: undefined, cwMs: undefined, sendMs: undefined, sendP50: pct(stats.sendMs, 0.5), sendP90: pct(stats.sendMs, 0.9), cwP50: (() => { const b = [...stats.cwMs].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; })(), preP50: (() => { const b = [...stats.preMs].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; })(), postP50: a.length ? a[Math.floor(a.length / 2)] : null, postP90: a.length ? a[Math.floor(a.length * 0.9)] : null, pending: pending.size }; }, _minQuotePrice: minQuotePrice };
}

module.exports = { createLiveSniper, postFailKey };
