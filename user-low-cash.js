// Per-user low-cash alerts for Combo Locks (public.combo_user_alerts, SQL in
// aibetbuilder sql/20261009_combo_user_alerts.sql). Shown on the site to the
// user whose quote/order was rejected; Kevin also sees testers' in All users.
//
// Raised when a Kalshi or Polymarket quote create/confirm comes back
// insufficient_balance (engine.quoteFailureSkipReason) for one of the user's
// locks. Throttle: one unresolved row per (user, venue, lock) (partial unique
// index) and at most one NEW row per user per hour in this process; repeats
// only bump skipped_count on the open row. Resolved automatically when the
// user's cash (combo_balances: Kalshi shard 1 / Polymarket buying power)
// covers what the rejected quote needed, or a later quote for that lock posts
// fine. Routine successful moves never write here. Every method swallows
// errors: alerts must never block quoting.
'use strict';

const TABLE = 'combo_user_alerts';
const HOUR_MS = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const venueOf = (v) => (String(v || '').toLowerCase() === 'polymarket' ? 'polymarket' : 'kalshi');
const dedupeKey = (venue, parlayId) => `low_cash:${venue}:${parlayId || 'any'}`;
const round2 = (n) => Math.round(n * 100) / 100;
function money(n) { return `$${Number(n).toFixed(2)}`; }

function alertText({ venue, label, shortfallUsd }) {
  const lock = label ? ` on ${label}` : '';
  const short = shortfallUsd > 0 ? ` You're about ${money(shortfallUsd)} short.` : '';
  if (venue === 'polymarket') {
    return {
      title: 'Some Combo Locks quotes were skipped: not enough Polymarket cash',
      body: `Some of your Combo Locks quotes${lock} were skipped because your Polymarket US buying power is too low.${short} Add money on Polymarket US to keep quoting.`,
    };
  }
  return {
    title: 'Some Combo Locks quotes were skipped: combos cash too low',
    body: `Some of your Combo Locks quotes${lock} were skipped because your combos cash is too low.${short} Add money on Kalshi or raise your Amount to keep for combos.`,
  };
}

// Kalshi = shard 1 (combos) available; Polymarket = buying power (or available).
function availableFrom(rows, venue) {
  for (const r of rows || []) {
    if (!r || r.ok === false) continue;
    if (venue === 'kalshi' && r.venue === 'kalshi' && Number(r.shard) === 1 && r.available_usd != null) return Number(r.available_usd);
    if (venue === 'polymarket' && r.venue === 'polymarket') {
      const v = r.buying_power_usd != null ? r.buying_power_usd : r.available_usd;
      if (v != null) return Number(v);
    }
  }
  return null;
}

function createUserLowCash({ client, log = (...a) => console.log(...a), clock = () => Date.now(), throttleMs = HOUR_MS } = {}) {
  const off = { enabled: false, async onRejected() { return false; }, async onQuoted() { return false; }, async tick() { return 0; } };
  if (!client || typeof client.from !== 'function') return off;
  const lastNewAt = new Map(); // userId -> ms of last NEW row
  const open = new Map(); // `${userId}|${key}` -> { id, userId, venue, parlayId, needUsd, skipped }

  async function balances(userId) {
    try {
      const { data, error } = await client.from('combo_balances')
        .select('venue,shard,available_usd,buying_power_usd,ok').eq('user_id', userId);
      return error ? null : (data || []);
    } catch (_) { return null; }
  }

  async function findOpen(userId, key) {
    const k = `${userId}|${key}`;
    if (open.has(k)) return open.get(k);
    try {
      const { data } = await client.from(TABLE).select('id,venue,parlay_id,need_usd,skipped_count')
        .eq('user_id', userId).eq('dedupe_key', key).is('resolved_at', null).limit(1);
      const r = data && data[0];
      if (!r) return null;
      const o = { id: r.id, userId, venue: r.venue, parlayId: r.parlay_id, needUsd: r.need_usd != null ? Number(r.need_usd) : null, skipped: Number(r.skipped_count) || 1 };
      open.set(k, o);
      return o;
    } catch (_) { return null; }
  }

  // info: { userId, parlayId, label, venue, costDollars }
  async function onRejected(info = {}) {
    try {
      const userId = info.userId && String(info.userId);
      if (!userId || !UUID.test(userId)) return false;
      const venue = venueOf(info.venue);
      const parlayId = info.parlayId && UUID.test(String(info.parlayId)) ? String(info.parlayId) : null;
      const key = dedupeKey(venue, parlayId);
      const need = Number(info.costDollars) > 0 ? round2(Number(info.costDollars)) : null;
      const existing = await findOpen(userId, key);
      if (existing) {
        existing.skipped += 1;
        if (need != null) existing.needUsd = Math.max(existing.needUsd || 0, need);
        await client.from(TABLE).update({ skipped_count: existing.skipped, need_usd: existing.needUsd })
          .eq('id', existing.id).is('resolved_at', null);
        return true;
      }
      const t = clock();
      if (lastNewAt.has(userId) && t - lastNewAt.get(userId) < throttleMs) return false; // one new alert per user per hour
      const avail = availableFrom(await balances(userId), venue);
      const shortfall = need != null && avail != null && need > avail ? round2(need - avail) : null;
      const label = info.label ? String(info.label).slice(0, 200) : null;
      const text = alertText({ venue, label, shortfallUsd: shortfall });
      const row = {
        user_id: userId, kind: 'low_cash', venue, parlay_id: parlayId, lock_label: label,
        title: text.title, body: text.body,
        need_usd: need, available_usd: avail != null ? round2(avail) : null, shortfall_usd: shortfall,
        skipped_count: 1, dedupe_key: key,
      };
      const { data, error } = await client.from(TABLE).insert(row).select('id');
      if (error) {
        if (error.code === '23505' || /duplicate|unique/i.test(String(error.message || ''))) return true;
        log(`[LOW-CASH] insert failed: ${error.message || error}`);
        return false;
      }
      lastNewAt.set(userId, t);
      const id = data && data[0] && data[0].id;
      if (id) open.set(`${userId}|${key}`, { id, userId, venue, parlayId, needUsd: need, skipped: 1 });
      log(`[LOW-CASH] alert user=${userId.slice(0, 8)} venue=${venue}${shortfall ? ` short=${money(shortfall)}` : ''}`);
      return true;
    } catch (e) {
      log(`[LOW-CASH] error: ${e && e.message}`);
      return false;
    }
  }

  async function resolveIds(ids) {
    if (!ids.length) return 0;
    try {
      const { error } = await client.from(TABLE).update({ resolved_at: new Date(clock()).toISOString() }).in('id', ids).is('resolved_at', null);
      if (error) return 0;
      for (const [k, o] of open) if (ids.includes(o.id)) open.delete(k);
      return ids.length;
    } catch (_) { return 0; }
  }

  // A quote for this lock posted fine => cash covered it.
  async function onQuoted({ userId, parlayId, venue } = {}) {
    if (!userId || !parlayId) return false;
    const o = open.get(`${userId}|${dedupeKey(venueOf(venue), parlayId)}`);
    return o ? (await resolveIds([o.id])) > 0 : false;
  }

  // Every ~minute: resolve open rows for these users once cash covers the need
  // (or, with need unknown, once combos cash is above $1 and higher than at alert time).
  async function tick(userIds = []) {
    const ids = [].concat(userIds || []).filter((u) => UUID.test(String(u)));
    if (!ids.length) return 0;
    try {
      const { data, error } = await client.from(TABLE).select('id,user_id,venue,need_usd,available_usd')
        .in('user_id', ids).is('resolved_at', null).limit(200);
      if (error || !data || !data.length) return 0;
      const done = [];
      const balCache = new Map();
      for (const r of data) {
        if (!balCache.has(r.user_id)) balCache.set(r.user_id, await balances(r.user_id));
        const avail = availableFrom(balCache.get(r.user_id), venueOf(r.venue));
        if (avail == null) continue;
        const need = r.need_usd != null ? Number(r.need_usd) : null;
        const ok = need != null ? avail >= need : (avail >= 1 && avail > Number(r.available_usd || 0));
        if (ok) done.push(r.id);
      }
      return resolveIds(done);
    } catch (_) { return 0; }
  }

  return { enabled: true, onRejected, onQuoted, tick };
}

module.exports = { TABLE, createUserLowCash, alertText, availableFrom, dedupeKey };
