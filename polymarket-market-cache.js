// In-process cache for Polymarket market metadata keyed by comboLeg symbol.
// Lookups are injected so tests never hit the network. Live uses GET
// /v1/market/slug/{slug} (signed Retail) or a public gateway fallback.
'use strict';

const DEFAULT_TTL_MS = 6 * 3600 * 1000;
const MISS_TTL_MS = 60 * 1000;

function createMarketCache({ fetchMarket, ttlMs = DEFAULT_TTL_MS, missTtlMs = MISS_TTL_MS } = {}) {
  const map = new Map();

  function peek(symbol) {
    return map.get(String(symbol || ''));
  }

  async function get(symbol) {
    const key = String(symbol || '').trim();
    if (!key) return null;
    const hit = map.get(key);
    const now = Date.now();
    if (hit && now - hit.at < (hit.market ? ttlMs : missTtlMs)) {
      return hit.market;
    }
    if (typeof fetchMarket !== 'function') {
      map.set(key, { market: null, at: now });
      return null;
    }
    try {
      const market = await fetchMarket(key);
      map.set(key, { market: market || null, at: now });
      return market || null;
    } catch (_) {
      map.set(key, { market: null, at: now });
      return null;
    }
  }

  async function getMany(symbols) {
    const out = new Map();
    const list = [...new Set((symbols || []).map((s) => String(s || '').trim()).filter(Boolean))];
    await Promise.all(list.map(async (s) => {
      out.set(s, await get(s));
    }));
    return out;
  }

  return { get, getMany, peek, _map: map };
}

module.exports = { createMarketCache, DEFAULT_TTL_MS, MISS_TTL_MS };
