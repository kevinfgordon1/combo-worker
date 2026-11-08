// Low-balance-only pre-quote cash check for Combo Locks (Kevin Nov 4 2026).
//
// Combo Locks' only SIZE limits are the user's contract cap and the cash in the
// prediction-market account. The exchange already refuses a fill the account
// cannot cover, but on Polymarket an accepted quote we cannot pay for counts as
// a DECLINE (poly-decline-guard: ~15% declines pauses the whole maker account),
// and on Kalshi an unconfirmable accept times out. This gate stops us posting
// quotes the account clearly cannot honor.
//
// Hot path cost: NONE beyond arithmetic. Cash comes from the balance reporter's
// own ~60s reads (balance-reporter.js onRows -> update) and from the shared
// balance cache (refresh on fill / interval, never once per RFQ), held in
// memory here. check() and afford() never do network or DB I/O. Holds (cost of
// quotes we already have open) are an in-memory sum the caller supplies lazily.
//
//   no fresh snapshot / gate off      -> allow (exchange rejection is the backup)
//   cash >= COMFORT x (cost + holds)  -> allow (normal case, no further check)
//   otherwise (low cash):  free = cash - holds; allow if free >= cost, else
//                          skip as insufficient_balance. Both venues quote the
//                          FULL RFQ size (no partial quotes), so a quote that
//                          does not fit is skipped rather than sized down;
//                          maxContracts reports what would fit.
//
// Kalshi combos clear on the combo bucket (shard 1); Polymarket US uses buying
// power (venue polymarket_us, shard 0), as stored by balance-reporter.js.
//
// Env: COMBO_BALANCE_GATE=0|false|off|no disables.
//      COMBO_BALANCE_GATE_COMFORT (default 2, min 1) comfort multiple.
//      COMBO_BALANCE_GATE_MAX_AGE_MS (default 180000) snapshot older than this
//        is ignored (allow) so a stalled reporter never blocks quoting.
'use strict';

const DEFAULT_COMFORT = 2;
const DEFAULT_MAX_AGE_MS = 180_000;
const VENUE_KEY = Object.freeze({
  kalshi: 'kalshi:1',
  polymarket: 'polymarket_us:0',
  polymarket_us: 'polymarket_us:0',
});

function gateEnabled(env = process.env) {
  const v = env && env.COMBO_BALANCE_GATE;
  return !(v != null && /^(0|false|off|no)$/i.test(String(v).trim()));
}

function readComfort(env = process.env) {
  const n = Number(env && env.COMBO_BALANCE_GATE_COMFORT);
  if (!(env && env.COMBO_BALANCE_GATE_COMFORT != null && env.COMBO_BALANCE_GATE_COMFORT !== '') || !Number.isFinite(n)) {
    return DEFAULT_COMFORT;
  }
  return Math.max(1, n);
}

function readMaxAgeMs(env = process.env) {
  const n = Number(env && env.COMBO_BALANCE_GATE_MAX_AGE_MS);
  if (!(env && env.COMBO_BALANCE_GATE_MAX_AGE_MS) || !Number.isFinite(n) || n <= 0) return DEFAULT_MAX_AGE_MS;
  return n;
}

function venueKey(venue) {
  return VENUE_KEY[String(venue || '').toLowerCase()] || null;
}

/** Dollars to collateralize `contracts` at `unitCost` per contract (0 < unitCost < 1). */
function quoteCostUsd(contracts, unitCost) {
  const c = Number(contracts);
  const u = Number(unitCost);
  if (!(c > 0) || !(u > 0) || u >= 1.0001) return 0;
  return c * u;
}

/** Kalshi pending quote: we buy NO at no_bid. Falls back to 1 - yes_bid, then $1/contract. */
function kalshiPendingCostUsd(q) {
  if (!q) return 0;
  const no = Number(q.noBid);
  if (no > 0 && no < 1) return quoteCostUsd(q.contracts, no);
  const yes = Number(q.yesBid);
  if (yes > 0 && yes < 1) return quoteCostUsd(q.contracts, 1 - yes);
  return quoteCostUsd(q.contracts, 1);
}

/** Polymarket pending quote: requester buys YES at buyPrice, we put up 1 - buyPrice. */
function polyPendingCostUsd(q) {
  if (!q) return 0;
  const px = Number(q.buyPrice);
  if (px > 0 && px < 1) return quoteCostUsd(q.contracts, 1 - px);
  return quoteCostUsd(q.contracts, 1);
}

/** In-memory sum over a pending-quotes Map (no I/O). */
function sumHoldsUsd(pendingQuotes, costOf) {
  if (!pendingQuotes || typeof pendingQuotes.values !== 'function') return 0;
  let total = 0;
  for (const q of pendingQuotes.values()) {
    const v = costOf(q);
    if (v > 0) total += v;
  }
  return total;
}

function createBalanceGate({ env = process.env, now = () => Date.now() } = {}) {
  const enabled = gateEnabled(env);
  const comfort = readComfort(env);
  const maxAgeMs = readMaxAgeMs(env);
  const snap = new Map(); // venueKey -> { cashUsd, atMs }
  const stats = { fast: 0, checked: 0, skipped: 0, noData: 0 };

  // Rows straight from balance-reporter tick (ok=false rows keep the last good
  // read here too, and age out via maxAgeMs).
  function update(rows) {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (!r || r.ok !== true) continue;
      const v = Number(r.available_usd);
      if (r.available_usd == null || !Number.isFinite(v)) continue;
      const at = Date.parse(r.fetched_at || r.checked_at || '');
      snap.set(`${r.venue}:${r.shard}`, { cashUsd: v, atMs: Number.isFinite(at) ? at : now() });
    }
  }

  function cashFor(venue) {
    const k = venueKey(venue);
    if (!k) return null;
    const s = snap.get(k);
    if (!s || now() - s.atMs > maxAgeMs) return null;
    return s.cashUsd;
  }

  // Last successful read, any age. A failed refresh does not erase it and
  // does not replace it with a larger guess (update() ignores ok:false).
  function knownCash(venue) {
    const k = venueKey(venue);
    if (!k) return null;
    const s = snap.get(k);
    if (!s || !Number.isFinite(s.cashUsd)) return null;
    return s.cashUsd;
  }

  // venue: 'kalshi' | 'polymarket'; costUsd: this quote's max cost;
  // holdsUsd: number or () => number (in-memory sum; skipped when no fresh snapshot);
  // unitCost: per-contract cost, used to report how many contracts would fit.
  function check({ venue, costUsd, holdsUsd = 0, unitCost = null } = {}) {
    if (!enabled) return { ok: true, path: 'off' };
    const cost = Number(costUsd);
    if (!(cost > 0)) return { ok: true, path: 'no_cost' };
    const cash = cashFor(venue);
    if (cash == null) { stats.noData += 1; return { ok: true, path: 'no_data' }; }
    const holds = Math.max(0, typeof holdsUsd === 'function' ? Number(holdsUsd()) || 0 : Number(holdsUsd) || 0);
    if (cash >= comfort * (cost + holds)) { stats.fast += 1; return { ok: true, path: 'fast', cashUsd: cash }; }
    return slow(cash, cost, holds, unitCost);
  }

  function slow(cash, cost, holds, unitCost) {
    const free = cash - Math.max(0, holds);
    const u = Number(unitCost);
    const maxContracts = u > 0 && u < 1.0001 ? Math.max(0, Math.floor((free / u) * 100 + 1e-9) / 100) : null;
    const base = { cashUsd: cash, holdsUsd: holds, freeUsd: free, costUsd: cost, maxContracts };
    if (free + 1e-9 >= cost) { stats.checked += 1; return { ok: true, path: 'checked', ...base }; }
    stats.skipped += 1;
    return { ok: false, path: 'low', reason: 'insufficient_balance', ...base };
  }

  // Accept / confirm, using the cached balance only. No network.
  // A fresh last-known cash that cannot cover this accept plus other open
  // quotes is skipped, so we do not wait for Kalshi to time the confirm out.
  // No reading, or a stalled one (older than maxAge): do not block. Kalshi
  // already rejects an underfunded confirm. Inventing a zero balance there
  // would cancel accepts we can pay.
  function afford({ venue, costUsd, holdsUsd = 0, unitCost = null } = {}) {
    if (!enabled) return { ok: true, path: 'off' };
    const cost = Number(costUsd);
    if (!(cost > 0)) return { ok: true, path: 'no_cost' };
    const k = venueKey(venue);
    const s = k ? snap.get(k) : null;
    if (!s || !Number.isFinite(s.cashUsd) || now() - s.atMs > maxAgeMs) {
      return { ok: true, path: 'unknown', costUsd: cost };
    }
    const cash = s.cashUsd;
    const holds = Math.max(0, typeof holdsUsd === 'function' ? Number(holdsUsd()) || 0 : Number(holdsUsd) || 0);
    const free = cash - holds;
    const u = Number(unitCost);
    const maxContracts = u > 0 && u < 1.0001 ? Math.max(0, Math.floor((free / u) * 100 + 1e-9) / 100) : null;
    const base = { cashUsd: cash, holdsUsd: holds, freeUsd: free, costUsd: cost, maxContracts };
    if (free + 1e-9 >= cost) return { ok: true, path: 'known', ...base };
    return { ok: false, path: 'low', reason: 'insufficient_balance', ...base };
  }

  return {
    enabled, comfort, maxAgeMs, update, cashFor, knownCash, check, afford,
    stats: () => ({ ...stats }),
  };
}

module.exports = {
  DEFAULT_COMFORT,
  DEFAULT_MAX_AGE_MS,
  gateEnabled,
  readComfort,
  readMaxAgeMs,
  venueKey,
  quoteCostUsd,
  kalshiPendingCostUsd,
  polyPendingCostUsd,
  sumHoldsUsd,
  createBalanceGate,
};
