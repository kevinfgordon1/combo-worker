// Server-side Combo Locks auto market check (preview; COMBO_AUTO_CHECK=1 turns it on).
//
// Same rule as the old browser-only check on the lock card: once a lock has 10 quotes with
// no fill, and then every 20 more (30, 50, 70…), run "Check market price" on it:
//   1. stamp probe_paused_at / probe_pause_until on THIS lock only (the existing 5s pause
//      poll in live-runner pulls only this lock's open quotes; every other lock keeps quoting;
//      the worker's 30s backstop drops a stale stamp),
//   2. wait for this lock's open quotes to clear (≤6s),
//   3. RFQ the lock's combo on this process's own Kalshi key (Kevin's on combo-worker, the
//      tester's on a tester child), collect competing quotes for COMBO_AUTO_CHECK_WAIT_MS
//      (default 5s, same as the button), DELETE the RFQ — never accept / confirm,
//   4. clear the pause and save the result on the lock (auto_check_* columns).
// One check at a time per process; never on paused / inactive / Polymarket-only locks.
// Never changes a price or any Combo Locks rule. Optional Telegram alert when we'd lose on
// price: COMBO_AUTO_CHECK_TG=1 (default off).
'use strict';

const lib = require('./lock-probe-lib');

const AUTO_CHECK_FIRST_MISSED = 10;
const AUTO_CHECK_EVERY_MISSED = 20;
const PROBE_PAUSE_HOLD_MS = 25_000; // same as aibetbuilder combo-lock-check-lib
const PAUSE_SETTLE_MAX_MS = 6_000;
const API = '/trade-api/v2';
const ON = /^(1|true|yes|on)$/i;

function autoCheckEnabled(env = process.env) { return ON.test(String((env && env.COMBO_AUTO_CHECK) || '')); }
function autoCheckTgEnabled(env = process.env) { return ON.test(String((env && env.COMBO_AUTO_CHECK_TG) || '')); }
function waitMsFrom(env = process.env) {
  const n = Number(env && env.COMBO_AUTO_CHECK_WAIT_MS);
  return Number.isFinite(n) && n >= 2000 && n <= 10_000 ? n : 5_000; // pause hold is 25s
}

function hasKalshiSide(p) {
  const legs = Array.isArray(p && p.legs) ? p.legs : [];
  return legs.length > 0 && legs.every((l) => /^KX[A-Z0-9]/i.test(String((l && l.ticker) || '').trim()));
}

/** Same rule as aibetbuilder src/comboLockCheck.js autoCheckDue. lastMissed 0 = never checked. */
function autoCheckDue({ missed, lastMissed = 0 }) {
  const m = Number(missed) || 0;
  const last = Math.max(0, Math.min(Number(lastMissed) || 0, m)); // counts can shrink → re-baseline
  if (m < AUTO_CHECK_FIRST_MISSED) return false;
  if (last === 0) return true;
  return m - last >= AUTO_CHECK_EVERY_MISSED;
}

function eligible(p) {
  if (!p || p.active === false || p.paused === true || p.probe_pause_until) return false;
  if (!hasKalshiSide(p)) return false;
  const n = Math.floor(Number(p.max_contracts));
  return Number.isFinite(n) && n > 0;
}

/** Seller-side American: higher fill_american = cheaper for the buyer = better quote. */
function verdict(ourAmerican, bestAmerican) {
  if (bestAmerican == null || !Number.isFinite(Number(bestAmerican))) return 'none';
  const o = Number(ourAmerican); const b = Number(bestAmerican);
  if (!Number.isFinite(o)) return 'unknown';
  return o > b ? 'win' : o === b ? 'tie' : 'lose';
}

const am = (a) => (a == null || !Number.isFinite(Number(a)) ? '—' : Number(a) > 0 ? `+${Number(a)}` : `${Number(a)}`);

function formatLoseAlert(p, r) {
  return `📉 Combo Locks auto check: ${p.label || p.id} is NOT top of market. ` +
    `Best other seller ${am(r.bestAmerican)}, ours ${am(r.ourAmerican)} ` +
    `(${r.competitorCount} other seller${r.competitorCount === 1 ? '' : 's'}, after ${r.missed} quotes with no fill).`;
}

function competitorQuotes(quotes, { selfCreatorId = null, ownQuoteIds = [] } = {}) {
  const own = new Set((ownQuoteIds || []).filter(Boolean).map(String));
  const self = selfCreatorId ? String(selfCreatorId) : null;
  return (Array.isArray(quotes) ? quotes : []).filter((q) => {
    if (!q) return false;
    if (q.id && own.has(String(q.id))) return false;
    const creator = q.creator_id || q.creator_user_id || q.quoter_id || null;
    return !(self && creator && String(creator) === self);
  });
}

/**
 * kalshi(method, pathWithQuery, body?) → { status, data } on this process's own key.
 * getParlays() → this process's live, in-scope locks (live-runner `parlays`).
 */
function createLockAutoCheck({ supabase, kalshi, getParlays, sendAlert = async () => {}, env = process.env,
  log = (m) => console.log(m), now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const enabled = autoCheckEnabled(env);
  const tg = autoCheckTgEnabled(env);
  const waitMs = waitMsFrom(env);
  let running = false;
  let colsMissing = false;

  async function missedQuotes(parlayId) {
    const { count, error } = await supabase.from('combo_submissions').select('id', { count: 'exact', head: true })
      .eq('parlay_id', parlayId).not('quote_id', 'is', null).not('status', 'in', '(filled,shadow)');
    if (error) return null;
    return Number(count) || 0;
  }

  async function k(method, p, body) {
    const r = await kalshi(method, API + p, body);
    return r || { status: 0, data: null };
  }

  async function pickCollection(legs, requested) {
    const order = [requested, ...lib.COMBO_COLLECTION_CANDIDATES.filter((c) => c !== requested)];
    for (const c of order) {
      const r = await k('GET', `/multivariate_event_collections/${encodeURIComponent(c)}`);
      if (r.status !== 200) continue;
      const resolved = lib.legsInCollection(legs, lib.collectionEventTickers(r.data));
      if (resolved) return { ok: true, collection: c, legs: resolved };
    }
    return { ok: false, error: 'No Kalshi combo collection holds every leg' };
  }

  async function makerRate(marketTicker) {
    const series = String(marketTicker || '').split('-')[0];
    const r = series ? await k('GET', `/series/${encodeURIComponent(series)}`) : null;
    const st = r && r.status === 200 && r.data && r.data.series;
    return st && st.fee_type ? lib.makerRateFromSeries(st.fee_type, st.fee_multiplier) : lib.FALLBACK_MAKER_RATE;
  }

  async function liveQuoteIds(parlayId) {
    const { data, error } = await supabase.from('combo_submissions').select('quote_id').eq('parlay_id', parlayId).eq('is_live', true);
    return error ? null : (data || []).map((r) => r && r.quote_id).filter(Boolean);
  }

  async function probe(p) {
    const legsRes = lib.normalizeLegs(p.legs);
    if (!legsRes.ok) return { ok: false, error: legsRes.error };
    const contracts = Math.floor(Number(p.max_contracts));
    const pausedAt = new Date(now()).toISOString();
    const pause = { probe_paused_at: pausedAt, probe_pause_until: new Date(now() + PROBE_PAUSE_HOLD_MS).toISOString() };
    const pz = await supabase.from('combo_parlays').update(pause).eq('id', p.id);
    if (pz.error) return { ok: false, error: 'could not pause lock for the check' };
    try {
      // Wait for live-runner's 5s pause poll to pull this lock's open quotes.
      const t0 = now(); const own = new Set();
      while (true) {
        const ids = await liveQuoteIds(p.id);
        if (!ids) break;
        ids.forEach((i) => own.add(i));
        if (!ids.length || now() - t0 >= PAUSE_SETTLE_MAX_MS) break;
        await sleep(1000);
      }
      const picked = await pickCollection(legsRes.legs, String(p.mve_collection || lib.COMBO_COLLECTION));
      if (!picked.ok) return picked;
      const mk = await k('POST', `/multivariate_event_collections/${encodeURIComponent(picked.collection)}`,
        { selected_markets: lib.selectedMarkets(picked.legs) });
      const marketTicker = mk.status >= 200 && mk.status < 300 ? lib.marketTickerFromCreate(mk.data) : null;
      if (!marketTicker) return { ok: false, error: `combo market create failed (${mk.status})` };
      const [rate, me] = await Promise.all([makerRate(marketTicker), k('GET', '/communications/id')]);
      const selfId = me.status === 200 && me.data ? (me.data.communications_id || me.data.id || null) : null;
      const cr = await k('POST', '/communications/rfqs', { market_ticker: marketTicker, contracts, contracts_fp: String(contracts), rest_remainder: false });
      const rfqId = cr.status >= 200 && cr.status < 300 ? lib.rfqIdFromCreate(cr.data) : null;
      if (!rfqId) return { ok: false, error: `probe RFQ create failed (${cr.status})` };
      const byId = new Map();
      try {
        const s = now();
        while (true) {
          const l = await k('GET', lib.quotesListPath(rfqId));
          if (l.status === 200) lib.quotesFromList(l.data).forEach((q, i) => byId.set((q && q.id) || `idx-${i}`, q));
          if (now() - s >= waitMs) break;
          await sleep(Math.min(500, Math.max(0, s + waitMs - now())));
        }
      } finally {
        await k('DELETE', `/communications/rfqs/${encodeURIComponent(rfqId)}`).catch(() => {}); // never accept / confirm
      }
      const comps = competitorQuotes([...byId.values()], { selfCreatorId: selfId, ownQuoteIds: [...own] });
      const best = lib.pickBestQuote(comps, rate);
      return { ok: true, bestAmerican: best.bestAmerican, bestNoBid: best.bestNoBid, competitorCount: best.usableQuoteCount, marketTicker };
    } finally {
      // Only clear our own stamp; the worker's 30s backstop covers a failed clear.
      await supabase.from('combo_parlays').update({ probe_paused_at: null, probe_pause_until: null })
        .eq('id', p.id).eq('probe_paused_at', pausedAt).then(() => {}, () => {});
    }
  }

  async function save(p, row) {
    const { error } = await supabase.from('combo_parlays').update(row).eq('id', p.id);
    if (error && /auto_check_/i.test(String(error.message || ''))) {
      colsMissing = true;
      log('[AUTO-CHECK] auto_check_* columns missing — run sql/20261026_combo_auto_check.sql; checks off until restart');
    }
  }

  async function tick() {
    if (!enabled || running || colsMissing) return null;
    running = true;
    try {
      for (const p of (getParlays() || []).filter(eligible)) {
        const missed = await missedQuotes(p.id);
        if (missed == null || !autoCheckDue({ missed, lastMissed: p.auto_check_missed })) continue;
        const ourAmerican = Number(p.fill_american);
        let r;
        try { r = await probe(p); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
        const at = new Date(now()).toISOString();
        const v = r.ok ? verdict(ourAmerican, r.bestAmerican) : null;
        await save(p, {
          auto_check_at: at,
          auto_check_missed: missed,
          auto_check_our_american: Number.isFinite(ourAmerican) ? ourAmerican : null,
          auto_check_best_american: r.ok ? r.bestAmerican : null,
          auto_check_best_no_bid: r.ok ? r.bestNoBid : null,
          auto_check_competitors: r.ok ? r.competitorCount : null,
          auto_check_result: r.ok ? v : 'error',
          auto_check_error: r.ok ? null : String(r.error || 'error').slice(0, 300),
        });
        p.auto_check_missed = missed; // in-memory, until the next refresh reloads the row
        log(`[AUTO-CHECK] lock=${String(p.id).slice(0, 8)} missed=${missed} ours=${am(ourAmerican)} best=${r.ok ? am(r.bestAmerican) : '—'} result=${r.ok ? v : 'error: ' + r.error}`);
        if (tg && r.ok && v === 'lose') await sendAlert(formatLoseAlert(p, { ...r, ourAmerican, missed })).catch(() => {});
        return { lockId: p.id, result: r.ok ? v : 'error' }; // one check per tick
      }
      return null;
    } finally { running = false; }
  }

  function start(intervalMs = 30_000) {
    if (!enabled) { log('[AUTO-CHECK] off (COMBO_AUTO_CHECK not set)'); return null; }
    log(`[AUTO-CHECK] on: first at ${AUTO_CHECK_FIRST_MISSED} quotes with no fill, then every ${AUTO_CHECK_EVERY_MISSED}; collect ${waitMs}ms; telegram ${tg ? 'on' : 'off'}`);
    const t = setInterval(() => { tick().catch((e) => log(`[AUTO-CHECK] tick error ${e && e.message}`)); }, intervalMs);
    if (t.unref) t.unref();
    return t;
  }

  return { enabled, tick, start, _probe: probe };
}

module.exports = { createLockAutoCheck, autoCheckDue, autoCheckEnabled, autoCheckTgEnabled, verdict, eligible, hasKalshiSide, formatLoseAlert, waitMsFrom,
  AUTO_CHECK_FIRST_MISSED, AUTO_CHECK_EVERY_MISSED };
