// Canonical game schedule sync (writes public.game_schedule) + "leg without a verified start" alerts.
//  * Full pass (yesterday … +7 days, every league) every SCHEDULE_FULL_MS (30 min).
//  * Quick pass (today + tomorrow ET) every SCHEDULE_QUICK_MS (3 min) so time changes / postponements land fast.
//  * After each pass: every open Combo Lock leg is resolved; a leg with no verified start in the next 48h raises
//    an owner in-app alert + Telegram (one per game per day), and a lock leg whose saved starts_at is > 15 min off the
//    official time is reported too (that is the "today vs tomorrow" class of bug). Never touches quoting.
// Errors never throw out of tick(); a missing table (migration not run yet) logs once and the sync idles.
'use strict';
const G = require('./game-schedule');

const SYNC_LEAGUES = ['NFL', 'NCAAF', 'NBA', 'NHL', 'MLB', 'WNBA', 'MLS', 'EPL', 'NCAAMB'];
const H = 3600000;
const yieldLoop = () => new Promise((r) => setImmediate(r)); // let quoting run between ESPN pulls / parses

function createScheduleSync({ env = process.env, fetchFn = globalThis.fetch, log = console.log, alerts = null, now = () => Date.now() } = {}) {
  const base = env.SUPABASE_URL; const key = env.SUPABASE_SERVICE_KEY;
  const hdr = { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  let games = []; let tableMissing = false; const alerted = new Map(); let lastFull = 0;
  const stats = { passes: 0, upserted: 0, espnErrors: 0, unverifiedLegs: 0, disputedLegs: 0, lastPass: null, lookups: 0, lookupErrors: 0, lagTrips: 0, lookupsOff: false };
  // Hot-path cache: resolved result per ticker (LRU), dropped on every schedule refresh.
  const RESOLVE_MAX = Number(env.SCHEDULE_RESOLVE_CACHE || 20000);
  let resolveCache = G.makeLru(RESOLVE_MAX);
  // Safety: lookups are switched off (callers fall back to the old kickoff chain) when the event loop lags.
  let lookupsOff = false; let offUntil = 0; let lagTimer = null; let lagHigh = 0;

  async function rest(path, opts = {}) {
    const r = await fetchFn(`${base}/rest/v1/${path}`, { ...opts, headers: { ...hdr, ...(opts.headers || {}) } });
    if (!r.ok) { const t = await r.text().catch(() => ''); const e = new Error(`supabase ${r.status} ${t.slice(0, 160)}`); e.status = r.status; throw e; }
    return r.status === 204 ? null : r.json().catch(() => null);
  }

  async function pullEspn(days) {
    const out = []; const today = G.etDate(now());
    for (const lg of SYNC_LEAGUES) for (const d of days) {
      try { const rows = await G.fetchEspnDay(lg, G.addDays(today, d), fetchFn); for (const r of rows) out.push(r); } catch (e) { stats.espnErrors += 1; log(`[SCHEDULE] ESPN ${lg} ${d}: ${e.message}`); }
      await yieldLoop();
    }
    return out;
  }

  async function save(fresh) {
    if (!base || !key || tableMissing || !fresh.length) return 0;
    const dates = [...new Set(fresh.map((g) => G.etDate(g.start_ms)))];
    let prev = [];
    try { prev = await rest(`game_schedule?select=league,espn_id,start_time_utc,previous_start_utc&et_date=in.(${dates.join(',')})`) || []; } catch (e) {
      if (e.status === 404 || /42P01|game_schedule/.test(e.message)) { tableMissing = true; log('[SCHEDULE] table public.game_schedule missing — run migrations/20261027_game_schedule.sql; sync keeps an in-memory schedule only'); return 0; }
      throw e;
    }
    const pm = new Map(prev.map((r) => [`${r.league}|${r.espn_id}`, r]));
    const rows = fresh.map((g) => {
      const p = pm.get(`${g.league}|${g.espn_id}`);
      if (p && Date.parse(p.start_time_utc) !== g.start_ms) log(`[SCHEDULE] time change ${g.league} ${g.away.abbr}@${g.home.abbr}: ${p.start_time_utc} → ${new Date(g.start_ms).toISOString()}`);
      return G.gameToRow(g, now(), p);
    });
    for (let i = 0; i < rows.length; i += 500) await rest('game_schedule?on_conflict=league,espn_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)) });
    stats.upserted += rows.length; return rows.length;
  }

  function merge(fresh) {
    const m = new Map(games.map((g) => [`${g.league}|${g.espn_id}`, g]));
    for (const g of fresh) m.set(`${g.league}|${g.espn_id}`, g);
    const cut = now() - 3 * 24 * H; const next = [...m.values()].filter((g) => g.start_ms > cut);
    G.indexGames(next); // build the index here (off the hot path) so the first sniper lookup is already O(1)
    games = next; resolveCache = G.makeLru(RESOLVE_MAX);
  }

  /** Hot path (sniper, every RFQ leg). Never throws, never blocks: null => caller uses its old fallback chain. */
  function resolve(ticker, extras) {
    if (lookupsOff || !games.length) return null;
    try {
      const k = extras ? null : String(ticker || '');
      if (k) { const c = resolveCache.get(k); if (c !== undefined) return c; }
      stats.lookups += 1;
      const r = G.resolveStart(ticker, games, extras || {});
      if (k) resolveCache.set(k, r);
      return r;
    } catch (e) { stats.lookupErrors += 1; return null; }
  }

  // Event-loop lag guard. Every SCHEDULE_LAG_CHECK_MS, measure how late the check timer fired; above SCHEDULE_LAG_MS on two checks
  // in a row => lookups off for SCHEDULE_LAG_OFF_MS (sniper keeps quoting on the old kickoff chain), log + alert once.
  // After SCHEDULE_LAG_MAX_TRIPS trips lookups stay off until restart.
  function lagGuard() {
    const limit = Number(env.SCHEDULE_LAG_MS || 1500); const every = Number(env.SCHEDULE_LAG_CHECK_MS || 10000);
    const offMs = Number(env.SCHEDULE_LAG_OFF_MS || 15 * 60000); const maxTrips = Number(env.SCHEDULE_LAG_MAX_TRIPS || 3);
    // Lag = how late this timer fires (a blocked loop delays every timer by the same amount).
    let expected = Date.now() + every;
    lagTimer = setInterval(() => {
      const t = Date.now(); const maxMs = Math.max(0, t - expected); expected = t + every;
      if (lookupsOff && stats.lagTrips < maxTrips && now() >= offUntil && maxMs < limit) { lookupsOff = false; stats.lookupsOff = false; log(`[SCHEDULE] lag ok (${Math.round(maxMs)} ms) — canonical lookups back on`); }
      lagHigh = maxMs > limit ? lagHigh + 1 : 0;
      if (!lookupsOff && lagHigh >= 2) {
        lookupsOff = true; stats.lookupsOff = true; stats.lagTrips += 1; offUntil = now() + offMs; lagHigh = 0;
        const final = stats.lagTrips >= maxTrips;
        const msg = `event-loop lag ${Math.round(maxMs)} ms > ${limit} ms — canonical schedule lookups OFF ${final ? 'until restart' : `for ${Math.round(offMs / 60000)} min`} (trip ${stats.lagTrips}); sniper uses the old kickoff chain`;
        log(`[SCHEDULE] ${msg}`);
        const day = G.etDate(now());
        if (alerts && alerts.raise) Promise.resolve(alerts.raise({ kind: 'game_schedule', severity: 'warning', title: 'Schedule lookups paused (event-loop lag)', body: msg, dedupeKey: `lag|${day}|${stats.lagTrips}` })).catch(() => {});
        telegram(`Schedule lookups paused\n${msg}`);
      }
    }, every);
    if (lagTimer.unref) lagTimer.unref();
  }

  async function telegram(text) {
    const tok = env.TELEGRAM_BOT_TOKEN; const chat = env.TELEGRAM_ALERT_CHAT_ID; if (!tok || !chat) return;
    try { await fetchFn(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) }); } catch (_) { /* best effort */ }
  }

  async function auditLocks() {
    if (!base || !key) return { unverified: [], disputed: [] };
    const locks = await rest('combo_parlays?select=id,label,legs,starts_at&active=eq.true&archived_at=is.null&limit=2000') || [];
    const t = now(); const unverified = []; const disputed = [];
    for (const p of locks) for (const l of p.legs || []) {
      if (!l || !l.ticker) continue;
      const r = G.resolveStart(l.ticker, games, { lockStart: l.starts_at || null });
      if (!r.verified) { if (r.startMs == null || (r.startMs > t - 6 * H && r.startMs < t + 48 * H)) unverified.push({ lock: p.id, label: p.label, ticker: l.ticker, source: r.source, warn: r.warn }); continue; }
      const saved = Date.parse(l.starts_at || '');
      if (Number.isFinite(saved) && Math.abs(saved - r.startMs) > G.DISAGREE_MS && r.startMs > t) disputed.push({ lock: p.id, label: p.label, ticker: l.ticker, saved: l.starts_at, official: r.iso });
    }
    stats.unverifiedLegs = unverified.length; stats.disputedLegs = disputed.length;
    const day = G.etDate(t);
    const fire = async (k, title, body) => {
      if (alerted.get(k) === day) return; alerted.set(k, day);
      if (alerts && alerts.raise) await alerts.raise({ kind: 'game_schedule', severity: 'warning', title, body, dedupeKey: `${k}|${day}` });
      await telegram(`${title}\n${body}`);
    };
    for (const u of unverified) await fire(`unverified|${u.ticker.split('-').slice(0, 2).join('-')}`, 'Leg has no verified start time', `${u.ticker} (${u.label || u.lock}) — ${u.warn}. It is still counted on its ticker date; check the game time.`);
    for (const d of disputed) await fire(`disputed|${d.ticker.split('-').slice(0, 2).join('-')}`, 'Saved start time differs from official schedule', `${d.ticker} (${d.label || d.lock}): saved ${d.saved}, official ${d.official}. Readers now use the official time.`);
    return { unverified, disputed };
  }

  async function tick() {
    try {
      const full = now() - lastFull >= Number(env.SCHEDULE_FULL_MS || 30 * 60000);
      const fresh = await pullEspn(full ? [-1, 0, 1, 2, 3, 4, 5, 6, 7] : [0, 1]);
      if (full) lastFull = now();
      merge(fresh);
      await save(fresh).catch((e) => log(`[SCHEDULE] save error: ${e.message}`));
      await auditLocks().catch((e) => log(`[SCHEDULE] audit error: ${e.message}`));
      stats.passes += 1; stats.lastPass = new Date(now()).toISOString();
      log(`[SCHEDULE] pass ${stats.passes} ${full ? 'full' : 'quick'} fetched=${fresh.length} games=${games.length} lookups=${stats.lookups} cache=${resolveCache.size} unverifiedLegs=${stats.unverifiedLegs} lookupsOff=${lookupsOff}`);
    } catch (e) { log(`[SCHEDULE] tick error: ${e.message}`); }
  }

  function start() {
    const quick = Number(env.SCHEDULE_QUICK_MS || 3 * 60000);
    const delay = Number(env.SCHEDULE_START_DELAY_MS || 30000); // let the sniper's own startup finish first
    const run = async () => { await tick(); const tm = setTimeout(run, quick); if (tm.unref) tm.unref(); };
    const first = setTimeout(run, delay); if (first.unref) first.unref();
    if (env.SCHEDULE_LAG_GUARD !== '0') lagGuard();
    log(`[SCHEDULE] canonical schedule sync on (quick ${Math.round(quick / 1000)}s, full ${Math.round(Number(env.SCHEDULE_FULL_MS || 1800000) / 60000)} min)`);
  }

  function stop() { if (lagTimer) clearInterval(lagTimer); }
  return { tick, start, stop, auditLocks, resolve, games: () => games, stats: () => ({ ...stats, games: games.length, tableMissing, resolveCache: resolveCache.size }),
    _load: (list) => merge(list), _setLookupsOff: (v) => { lookupsOff = !!v; stats.lookupsOff = !!v; } };
}

module.exports = { createScheduleSync, SYNC_LEAGUES };
