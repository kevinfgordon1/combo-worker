// prophetx_sandbox_quotes writes via PostgREST. Small and bounded: one insert
// per QUOTED parlay, then patches on confirm / finalize / settle. Declines only
// bump in-memory counters, flushed to prophetx_sandbox_stats every 5 minutes.
// With no Supabase env (local run) every write becomes a log line instead.
'use strict';

function etDay(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
}

function createStore({ url, key, fetch: f = globalThis.fetch, logger = console, maxInFlight = 4 } = {}) {
  const enabled = !!(url && key);
  const counts = {};
  let countsDay = etDay();
  let inFlight = 0;
  let dropped = 0;

  async function rest(method, path, body, prefer) {
    if (!enabled) { logger.log(`[PX-DB-OFF] ${method} ${path} ${JSON.stringify(body).slice(0, 300)}`); return true; }
    if (inFlight >= maxInFlight) { dropped += 1; return false; }
    inFlight += 1;
    try {
      const res = await f(`${url.replace(/\/+$/, '')}/rest/v1/${path}`, {
        method,
        headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: prefer || 'return=minimal' },
        body: JSON.stringify(body),
      });
      if (res.status >= 300) {
        const t = await res.text().catch(() => '');
        logger.warn(`[PX-DB] ${method} ${path.split('?')[0]} ${res.status} ${t.slice(0, 160)}`);
        return false;
      }
      return true;
    } catch (e) {
      logger.warn(`[PX-DB] ${method} ${path.split('?')[0]} ${e.message}`);
      return false;
    } finally { inFlight -= 1; }
  }

  const enc = encodeURIComponent;
  return {
    enabled,
    insertQuote: (row) => rest('POST', 'prophetx_sandbox_quotes', row, 'return=minimal,resolution=ignore-duplicates'),
    patchQuote: (parlayId, patch) => rest('PATCH', `prophetx_sandbox_quotes?parlay_id=eq.${enc(parlayId)}`, patch),
    bump(name, n = 1) {
      const d = etDay();
      if (d !== countsDay) { for (const k of Object.keys(counts)) delete counts[k]; countsDay = d; }
      counts[name] = (counts[name] || 0) + n;
    },
    counts: () => ({ ...counts }),
    flushStats: () => rest('POST', 'prophetx_sandbox_stats?on_conflict=day', { day: countsDay, counts: { ...counts, db_dropped: dropped }, updated_at: new Date().toISOString() }, 'return=minimal,resolution=merge-duplicates'),
  };
}

module.exports = { createStore, etDay };
