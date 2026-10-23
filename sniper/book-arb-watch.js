// Runs the sportsbook arb check on each sniper fill, then re-checks open fills every
// SNIPER_BOOK_ARB_POLL_MS (default 5 min, the player-prop cache cadence) until the first leg
// kicks off. ALERT-ONLY: it reads cached odds and sends Telegram; it never places a bet.
// Each check is written to sniper_decisions (action 'book_arb') for the My Fills card.
// Every recheck logs a coverage line (X of Y open fills priceable, by leg type); a Telegram coverage
// summary goes out every SNIPER_BOOK_ARB_SUMMARY_MS (default 6h; 0 = off) so blind spots stay visible.
// Fills with an active logged hedge (sniper_hedges) are still priced + recorded (details.hedged) but never alerted.
// Telegram fires on a NEW arb, or when the best locked profit improves by ≥ $1 since the last alert.
'use strict';
const { checkFill, formatArbAlert, coverage, formatCoverage, formatCoverageSummary } = require('./book-arb');
const { legLabel } = require('./fill-alert');

function createBookArbWatch({ loadData, store, alert = () => {}, log = () => {}, kickoffOf = () => null, now = () => Date.now(), minImprove = 1, minProfit = 0.01, summaryMs = 6 * 3600e3 }) {
  const lastAlert = new Map(); // rfqId -> locked $ at last alert
  const stats = { checks: 0, arbs: 0, alerts: 0, errors: 0, skippedHedged: 0 };
  let cache = null; let lastCoverage = null; let lastSummaryAt = -Infinity;
  async function data() { if (!cache || now() - cache.at > 60000) cache = { at: now(), d: await loadData() }; return cache.d; }
  const started = (legs) => (legs || []).some((k) => { const ms = kickoffOf(String(k).split(':')[0]); return ms != null && ms <= now(); });

  async function check(fill, why) {
    try {
      if (started(fill.legs)) return null;
      const r = checkFill(fill, await data(), { minProfit });
      const hedged = (fill.hedges || []).length > 0;
      stats.checks += 1;
      const b = r.best;
      await store.decision({ rfq_id: fill.rfqId, action: 'book_arb', reason: r.reason, details: { ...r, hedged, trigger: why, checkedAt: new Date(now()).toISOString(), books: r.books.slice(0, 8) } });
      if (b && b.arb && hedged) stats.skippedHedged += 1;
      if (b && b.arb && !hedged) {
        stats.arbs += 1;
        const prev = lastAlert.get(fill.rfqId);
        if (prev == null || b.locked >= prev + minImprove) {
          const m = formatArbAlert(r, { legLabel, coverageLine: lastCoverage ? formatCoverage(lastCoverage) : null }); if (m) { alert(m); stats.alerts += 1; lastAlert.set(fill.rfqId, b.locked); }
        }
      }
      log(`[SNIPER] book_arb rfq=${fill.rfqId} ${why} ${r.reason}${hedged ? ' hedged' : ''}${b ? ` best=${b.label} ${b.american} locked=$${b.locked.toFixed(2)}` : ''}`);
      return r;
    } catch (e) { stats.errors += 1; log(`[SNIPER] book_arb error rfq=${fill.rfqId}: ${e.message}`); return null; }
  }
  async function recheckOpen() {
    const rows = await store.openFilledWithLegs();
    const results = [];
    for (const r of rows) {
      const fill = { rfqId: r.rfq_id, legs: r.legs, contracts: r.filled_contracts, cost: r.filled_cost, fee: r.filled_fee, hedges: r.hedges || [] };
      // Started fills are skipped by check(); still count them for coverage (priced from cache, no alert).
      let res = await check(fill, 'recheck');
      if (!res && started(fill.legs)) { try { res = checkFill(fill, await data(), { minProfit }); } catch (_) { res = null; } }
      if (res) results.push({ ...res, hedged: fill.hedges.length > 0 });
    }
    lastCoverage = coverage(results);
    log(`[SNIPER] book_arb ${formatCoverage(lastCoverage)}`);
    if (summaryMs > 0 && now() - lastSummaryAt >= summaryMs && results.length) {
      lastSummaryAt = now();
      alert(formatCoverageSummary(lastCoverage, results.filter((x) => x.best && x.best.arb && !x.hedged)));
    }
    return lastCoverage;
  }
  return { check, recheckOpen, stats: () => ({ ...stats }), coverage: () => lastCoverage };
}
module.exports = { createBookArbWatch };
