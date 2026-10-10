// Per-series Kalshi maker fee for Combo Locks.
// Kalshi fee schedule (effective 2026-07-07) + GET /series/{ticker} fee_type/fee_multiplier:
//   quadratic                        → makers pay 0
//   quadratic_with_maker_fees        → 0.0175 × multiplier
//   quadratic_with_combo_maker_fees  → 0.035  × multiplier  (combo maker multiplier 0.5 of taker)
// Unknown type / failed lookup → conservative 0.035 (never quote past the user's net target).
// Verified on our fills: KXMVECROSSCATEGORY0 maker fee_cost ≈ $0; KXMVECROSSCATEGORY 0.035·C·P·(1−P).
'use strict';

const KALSHI_REST = 'https://api.elections.kalshi.com/trade-api/v2';
const FALLBACK_MAKER_RATE = 0.035;
const TTL_MS = 6 * 3600 * 1000;
const RETRY_MS = 60 * 1000;

function makerRateFromSeries(feeType, multiplier) {
  const m = Number(multiplier);
  const mult = Number.isFinite(m) && m >= 0 ? m : 1;
  switch (String(feeType || '')) {
    case 'quadratic': return 0;
    case 'quadratic_with_maker_fees': return 0.0175 * mult;
    case 'quadratic_with_combo_maker_fees': return 0.035 * mult;
    default: return FALLBACK_MAKER_RATE;
  }
}

// "KXMVECROSSCATEGORY0-S2026A0E…-D44B…" → "KXMVECROSSCATEGORY0"
function seriesOfTicker(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) return null;
  const s = t.split('-')[0];
  return s || null;
}

function createSeriesFeeCache({ fetchImpl = (typeof fetch === 'function' ? fetch : null), base = KALSHI_REST, now = () => Date.now(), log = () => {} } = {}) {
  const cache = new Map(); // series → { rate, feeType, multiplier, at, ok }
  const inflight = new Map();

  async function load(series) {
    if (!fetchImpl) throw new Error('no fetch');
    const r = await fetchImpl(`${base}/series/${encodeURIComponent(series)}`, { headers: { accept: 'application/json' } });
    if (!r || !r.ok) throw new Error(`series ${series} HTTP ${r && r.status}`);
    const j = await r.json();
    const s = (j && j.series) || j || {};
    if (!s.fee_type) throw new Error(`series ${series} missing fee_type`);
    return { rate: makerRateFromSeries(s.fee_type, s.fee_multiplier), feeType: s.fee_type, multiplier: s.fee_multiplier, ok: true };
  }

  function fresh(e) {
    if (!e) return false;
    return now() - e.at < (e.ok ? TTL_MS : RETRY_MS);
  }

  async function prefetch(series) {
    if (!series) return null;
    const hit = cache.get(series);
    if (fresh(hit)) return hit;
    if (inflight.has(series)) return inflight.get(series);
    const p = load(series)
      .then((e) => { const v = { ...e, at: now() }; cache.set(series, v); log(`maker fee ${series} ${e.feeType}×${e.multiplier} → ${e.rate}`); return v; })
      .catch((err) => {
        const prev = cache.get(series);
        const v = prev && prev.ok ? { ...prev, at: now() - TTL_MS + RETRY_MS } : { rate: FALLBACK_MAKER_RATE, ok: false, at: now(), error: err.message };
        cache.set(series, v);
        log(`maker fee ${series} lookup failed (${err.message}) → ${v.rate}`);
        return v;
      })
      .finally(() => inflight.delete(series));
    inflight.set(series, p);
    return p;
  }

  // Sync read for the hot path. Unknown series → fallback now, fetch in background.
  function rateForTicker(ticker) {
    const series = seriesOfTicker(ticker);
    if (!series) return FALLBACK_MAKER_RATE;
    const hit = cache.get(series);
    if (!fresh(hit)) prefetch(series).catch(() => {});
    return hit ? hit.rate : FALLBACK_MAKER_RATE;
  }

  async function prefetchTickers(tickers) {
    const set = new Set((tickers || []).map(seriesOfTicker).filter(Boolean));
    await Promise.all([...set].map((s) => prefetch(s)));
  }

  return { rateForTicker, prefetch, prefetchTickers, _cache: cache };
}

module.exports = { FALLBACK_MAKER_RATE, makerRateFromSeries, seriesOfTicker, createSeriesFeeCache };
