// Per-user Combo Locks fees gate (aibetbuilder sql/20261010_combo_fees_per_user.sql).
//
// Users with combo_live_users.fees_enabled pay 1% of the amount at risk on each
// filled lock; the DATABASE charges it (trigger on combo_fills): monthly
// allowance first, then purchased credits. This module only decides whether a
// fee user may START new quotes: when both their allowance and purchased
// credits are used up (combo_fee_status_for_worker.can_quote = false) the user
// counts as kill-engaged, and we raise one "Add credits to keep quoting" alert
// (combo_user_alerts kind 'no_credits'), resolved once they can quote again.
// Existing fills are never touched.
//
// Fee-free users (Kevin, everyone without fees_enabled) are never blocked.
// Before the migration exists (function missing) everyone is fee-free.
// Read errors keep the last snapshot. Until the first read (one refresh,
// ~seconds after boot) nobody is blocked; the DB still charges every fill.
'use strict';

const ALERT_KEY = 'no_credits';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALERT_TEXT = Object.freeze({
  title: 'Add credits to keep quoting',
  body: 'Your free monthly Combo Locks credits and purchased credits are used up, so new quotes are paused. Add credits on Combo Locks to keep quoting. Fills you already have stay as they are.',
});

function money(n) { return Math.round(Number(n) * 100) / 100; }

function createUserCredits({ client, log = console.log } = {}) {
  let status = new Map(); // userId -> row
  let schemaMissing = false;
  const alerted = new Set();

  function blocked(userId) {
    const r = status.get(String(userId || '').toLowerCase());
    return !!(r && r.fees_enabled && r.can_quote === false);
  }

  async function raise(userId, r) {
    if (alerted.has(userId)) return;
    try {
      const { error } = await client.from('combo_user_alerts').insert({
        user_id: userId, kind: 'no_credits', venue: 'kalshi',
        title: ALERT_TEXT.title, body: ALERT_TEXT.body,
        available_usd: money(Number(r.allowance_left_usd || 0) + Number(r.credits_usd || 0)),
        dedupe_key: ALERT_KEY,
      });
      if (error && !(error.code === '23505' || /duplicate|unique/i.test(String(error.message || '')))) {
        log(`[CREDITS] alert insert failed: ${error.message || error}`);
        return;
      }
      alerted.add(userId);
      log(`[CREDITS] user=${userId.slice(0, 8)} out of credits — new quotes paused`);
    } catch (e) { log(`[CREDITS] alert error: ${e && e.message}`); }
  }

  async function resolve(userId) {
    try {
      const { error } = await client.from('combo_user_alerts').update({ resolved_at: new Date().toISOString() })
        .eq('user_id', userId).eq('dedupe_key', ALERT_KEY).is('resolved_at', null);
      if (!error) alerted.delete(userId);
    } catch (_) { /* best effort */ }
  }

  // Never throws. Returns true when the snapshot was refreshed.
  async function refresh(userIds = []) {
    const ids = [...new Set([].concat(userIds || []).map((u) => String(u || '').toLowerCase()).filter((u) => UUID.test(u)))];
    if (!client || !ids.length || schemaMissing) return false;
    try {
      const { data, error } = await client.rpc('combo_fee_status_for_worker', { uids: ids });
      if (error) {
        const msg = String(error.message || error);
        if (error.code === 'PGRST202' || error.code === '42883' || /could not find the function|does not exist/i.test(msg)) {
          schemaMissing = true;
          log('[CREDITS] combo_fee_status_for_worker missing — everyone fee-free until the migration is applied');
        } else {
          log(`[CREDITS] fee status read failed (${msg}) — keeping last snapshot`);
        }
        return false;
      }
      const prev = status;
      const next = new Map();
      for (const r of data || []) if (r && r.user_id) next.set(String(r.user_id).toLowerCase(), r);
      status = next;
      for (const [uid, r] of next) {
        const wasBlocked = !!(prev.get(uid) && prev.get(uid).fees_enabled && prev.get(uid).can_quote === false);
        if (r.fees_enabled && r.can_quote === false) await raise(uid, r);
        else if (wasBlocked || alerted.has(uid)) await resolve(uid);
      }
      return true;
    } catch (e) {
      log(`[CREDITS] fee status error (${e && e.message}) — keeping last snapshot`);
      return false;
    }
  }

  return { refresh, blocked, get snapshot() { return status; } };
}

module.exports = { createUserCredits, ALERT_TEXT, ALERT_KEY };
