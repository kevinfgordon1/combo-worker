// Runs the sportsbook arb check on each sniper fill, then re-checks open fills every
// SNIPER_BOOK_ARB_POLL_MS (default 5 min, the player-prop cache cadence) until the first leg
// kicks off. ALERT-ONLY: it reads cached odds and sends Telegram; it never places a bet.
// Each check is written to sniper_decisions (action 'book_arb') for the My Fills card.
// Telegram fires on a NEW arb, or when the best locked profit improves by ≥ $1 since the last alert.
'use strict';
const { checkFill, formatArbAlert } = require('./book-arb');
const { legLabel } = require('./fill-alert');

function createBookArbWatch({ loadData, store, alert = () => {}, log = () => {}, kickoffOf = () => null, now = () => Date.now(), minImprove = 1, minProfit = 0.01 }) {
  const lastAlert = new Map(); // rfqId -> locked $ at last alert
  const stats = { checks: 0, arbs: 0, alerts: 0, errors: 0 };
  let cache = null;
  async function data() { if (!cache || now() - cache.at > 60000) cache = { at: now(), d: await loadData() }; return cache.d; }
  const started = (legs) => (legs || []).some((k) => { const ms = kickoffOf(String(k).split(':')[0]); return ms != null && ms <= now(); });

  async function check(fill, why) {
    try {
      if (started(fill.legs)) return null;
      const r = checkFill(fill, await data(), { minProfit });
      stats.checks += 1;
      const b = r.best;
      await store.decision({ rfq_id: fill.rfqId, action: 'book_arb', reason: r.reason, details: { ...r, trigger: why, checkedAt: new Date(now()).toISOString(), books: r.books.slice(0, 8) } });
      if (b && b.arb) {
        stats.arbs += 1;
        const prev = lastAlert.get(fill.rfqId);
        if (prev == null || b.locked >= prev + minImprove) {
          const m = formatArbAlert(r, { legLabel }); if (m) { alert(m); stats.alerts += 1; lastAlert.set(fill.rfqId, b.locked); }
        }
      }
      log(`[SNIPER] book_arb rfq=${fill.rfqId} ${why} ${r.reason}${b ? ` best=${b.label} ${b.american} locked=$${b.locked.toFixed(2)}` : ''}`);
      return r;
    } catch (e) { stats.errors += 1; log(`[SNIPER] book_arb error rfq=${fill.rfqId}: ${e.message}`); return null; }
  }
  async function recheckOpen() {
    const rows = await store.openFilledWithLegs();
    for (const r of rows) await check({ rfqId: r.rfq_id, legs: r.legs, contracts: r.filled_contracts, cost: r.filled_cost, fee: r.filled_fee }, 'recheck');
  }
  return { check, recheckOpen, stats: () => ({ ...stats }) };
}
module.exports = { createBookArbWatch };
