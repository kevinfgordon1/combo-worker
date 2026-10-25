// Shared Supabase circuit breaker (DB_BREAKER=0 turns it off).
//
// Oct 25 2026: when PostgREST's pool saturated, every app kept retrying at full speed, so the
// queue never drained and aibetbuilder.io / Combo Locks / testers stayed down. This wraps the
// fetch every supabase-js client uses: when, inside windowMs, at least minErrors requests failed
// with 5xx / 408 / 429 / Cloudflare 52x / network errors / timeouts AND they are >= ratio of all
// requests, the breaker OPENS for a jittered openMinMs..openMaxMs. While open, DB calls fail fast
// locally (no network) and callers that ask isOpen() stop quoting (fail closed). After the pause a
// single probe request is let through; success closes it, failure re-opens with a longer pause.
'use strict';

const BAD = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

function createDbBreaker({
  windowMs = 10000, minErrors = 20, ratio = 0.5, openMinMs = 30000, openMaxMs = 60000, maxOpenMs = 300000,
  now = () => Date.now(), random = Math.random, log = console.log, name = 'db', enabled = true,
} = {}) {
  let ev = []; let head = 0; let bad = 0; // [ts, isBad]
  let openUntil = 0; let trips = 0; let probing = false; const stats = { trips: 0, shortCircuited: 0, failures: 0, ok: 0 };
  function trim(t) { while (head < ev.length && ev[head][0] < t - windowMs) { if (ev[head][1]) bad -= 1; head += 1; } if (head > 4096) { ev = ev.slice(head); head = 0; } }
  function record(isBad) {
    const t = now(); ev.push([t, isBad]); if (isBad) { bad += 1; stats.failures += 1; } else stats.ok += 1; trim(t);
    const n = ev.length - head;
    if (probing) { probing = false; if (isBad) trip(t, 'probe failed'); else { trips = 0; openUntil = 0; log(`[${name}-breaker] closed (probe ok)`); } return; }
    if (!openUntil && bad >= minErrors && bad / n >= ratio) trip(t, `${bad}/${n} failed in ${windowMs / 1000}s`);
  }
  function trip(t, why) {
    trips += 1; stats.trips += 1;
    const base = openMinMs + random() * (openMaxMs - openMinMs);
    const ms = Math.min(maxOpenMs, base * 2 ** Math.min(trips - 1, 3));
    openUntil = t + ms; ev = []; head = 0; bad = 0;
    log(`[${name}-breaker] OPEN for ${Math.round(ms / 1000)}s (${why}) — DB calls fail fast, quoting paused`);
  }
  function isOpen() { if (!enabled) return false; return openUntil > now(); }
  function wrapFetch(fetchImpl = globalThis.fetch) {
    return async function breakerFetch(input, init) {
      if (enabled && openUntil) {
        if (openUntil > now()) { stats.shortCircuited += 1; throw new Error(`${name}_breaker_open`); }
        if (probing) { stats.shortCircuited += 1; throw new Error(`${name}_breaker_open`); }
        probing = true; // half-open: this request is the probe
      }
      let res;
      try { res = await fetchImpl(input, init); } catch (e) { if (enabled) record(true); throw e; }
      if (enabled) record(BAD.has(res.status));
      return res;
    };
  }
  return { wrapFetch, isOpen, record, stats: () => ({ ...stats, open: isOpen(), openForMs: Math.max(0, openUntil - now()) }) };
}

let shared = null;
// One breaker per process, shared by every client in it.
function getDbBreaker(env = process.env, log = console.log) {
  if (!shared) shared = createDbBreaker({ enabled: String(env.DB_BREAKER || '1') !== '0', log, minErrors: Number(env.DB_BREAKER_MIN_ERRORS) || 20 });
  return shared;
}
// supabase-js options with the breaker's fetch merged in.
function withBreaker(opts = {}, env = process.env) {
  const b = getDbBreaker(env);
  return { ...opts, global: { ...(opts.global || {}), fetch: b.wrapFetch((opts.global && opts.global.fetch) || globalThis.fetch) } };
}

module.exports = { createDbBreaker, getDbBreaker, withBreaker };
