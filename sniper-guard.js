// Keeps the isolated sniper's Kalshi activity (same Kalshi ACCOUNT, different API key) out of
// Combo Locks. Read-only lookup of sniper_ledger (written only by the sniper service).
//  - isSniperQuote(quoteId): combo-worker must never confirm a sniper quote.
//  - isSniperFill(row): fills-reader must never record a sniper fill into combo_fills
//    (matched by order_id, or by the combo market ticker the sniper traded).
// Missing table (sniper never deployed) => not a sniper item. Other DB errors on the
// confirm path are reported as unknown so the caller can fail closed.
'use strict';

function createSniperGuard({ supabase, ttlMs = 60_000, now = Date.now } = {}) {
  const cache = new Map(); // key -> { v, at }
  const missing = (e) => e && (e.code === '42P01' || /does not exist|schema cache/i.test(e.message || ''));
  async function lookup(col, val) {
    if (!supabase || !val) return false;
    const key = `${col}:${val}`;
    const c = cache.get(key);
    if (c && (c.v || now() - c.at < 5000)) return c.v; // positives stick; negatives re-checked after 5s
    const { data, error } = await supabase.from('sniper_ledger').select('rfq_id').eq(col, val).limit(1);
    if (error) { if (missing(error)) return false; throw new Error(error.message); }
    const v = !!(data && data.length);
    cache.set(key, { v, at: now() });
    if (cache.size > 5000) for (const [k, x] of cache) if (now() - x.at > ttlMs) cache.delete(k);
    return v;
  }
  async function isSniperQuote(quoteId) {
    try { return { sniper: await lookup('quote_id', quoteId) }; } catch (e) { return { sniper: false, unknown: true, error: e.message }; }
  }
  async function isSniperFill(row) {
    try {
      if (row && row.order_id && await lookup('order_id', row.order_id)) return true;
      if (row && row.ticker && await lookup('market_ticker', row.ticker)) return true;
      return false;
    } catch (_) { return false; }
  }
  return { isSniperQuote, isSniperFill };
}

module.exports = { createSniperGuard };
