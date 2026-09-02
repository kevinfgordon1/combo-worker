// In-process cache for Polymarket market metadata keyed by comboLeg symbol.
// Lookups are injected so tests never hit the network. Live uses GET
// /v1/market/slug/{slug} (signed Retail) or a public gateway fallback.
'use strict';

const DEFAULT_TTL_MS = 6 * 3600 * 1000;
const MISS_TTL_MS = 60 * 1000;
const DEFAULT_MAX_ENTRIES = 128;

function createMarketCache({
  fetchMarket,
  ttlMs = DEFAULT_TTL_MS,
  missTtlMs = MISS_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const map = new Map();
  const cap = Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_ENTRIES;

  function peek(symbol) {
    return map.get(String(symbol || ''));
  }

  function ttlFor(hit) {
    return hit && hit.market ? ttlMs : missTtlMs;
  }

  function pruneExpired(now = Date.now()) {
    for (const [key, hit] of map) {
      if (!hit || now - hit.at >= ttlFor(hit)) map.delete(key);
    }
  }

  function evictIfNeeded() {
    while (map.size > cap) {
      const oldest = map.keys().next().value;
      if (oldest == null) break;
      map.delete(oldest);
    }
  }

  function write(key, hit) {
    if (map.has(key)) map.delete(key);
    map.set(key, hit);
    evictIfNeeded();
  }

  async function get(symbol) {
    const key = String(symbol || '').trim();
    if (!key) return null;
    const now = Date.now();
    const hit = map.get(key);
    if (hit && now - hit.at < ttlFor(hit)) {
      write(key, hit);
      return hit.market;
    }
    if (hit) map.delete(key);
    if (typeof fetchMarket !== 'function') {
      write(key, { market: null, at: now });
      return null;
    }
    try {
      const market = await fetchMarket(key);
      write(key, { market: market || null, at: now });
      return market || null;
    } catch (_) {
      write(key, { market: null, at: now });
      return null;
    }
  }

  async function getMany(symbols) {
    pruneExpired();
    const out = new Map();
    const list = [...new Set((symbols || []).map((s) => String(s || '').trim()).filter(Boolean))];
    await Promise.all(list.map(async (s) => {
      out.set(s, await get(s));
    }));
    return out;
  }

  return { get, getMany, peek, pruneExpired, _map: map };
}

module.exports = { createMarketCache, DEFAULT_TTL_MS, MISS_TTL_MS, DEFAULT_MAX_ENTRIES };
