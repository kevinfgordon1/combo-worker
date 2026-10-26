// Oct 26 2026: backstop sweep for live sniper_ledger rows stuck 'reserved'/'quoted' past their hold
// (release_at) with no order and no fills. Skips anything this process still tracks (pending quote,
// in-flight POST, background TTL cancel). Cancel is best-effort (404 = already gone); the row is
// released either way, since an untracked quote can't fill without our confirm.
'use strict';

async function sweepStaleQuotes({ store, trader, release, tracked = () => false, log = () => {}, graceMs = 15000 }) {
  const out = { seen: 0, released: 0, usd: 0, cancelled: 0, failed: 0 };
  const rows = await store.stalePastHold(graceMs);
  for (const r of rows) {
    if (tracked(r.rfq_id)) continue;
    if (Number(r.filled_contracts) > 0) continue;
    out.seen += 1;
    if (r.quote_id && trader && trader.live) {
      try { await trader.cancel(r.quote_id, { urgent: false }); out.cancelled += 1; } catch (e) { out.failed += 1; log(`[SNIPER] stale sweep cancel ${r.quote_id} failed: ${e.message}`); }
    }
    await release(r.rfq_id); out.released += 1; out.usd += Number(r.risk) || 0;
  }
  return out;
}

module.exports = { sweepStaleQuotes };
