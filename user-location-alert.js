// Per-user "verify your location" site alert (public.combo_user_alerts kind
// 'location_expired', SQL in aibetbuilder sql/20261025_combo_user_alerts_location.sql).
// Kalshi 403s a quote with "location attestation for API trading is missing or
// expired" when the user's geo check lapses. We raise one open row per user
// (dedupe_key 'location_expired:kalshi') and resolve it on their next accepted
// quote. Off with USER_LOCATION_ALERTS=0. Never throws, never on the hot path.
'use strict';

const DEDUPE = 'location_expired:kalshi';
const TITLE = 'Verify your location on Kalshi';
const BODY = 'Kalshi is rejecting your Combo Locks quotes because your location verification expired. Open the Kalshi app or website and verify your location to resume quoting.';

function isLocationAttestationFailure(message) {
  return /location[_ ]attestation|verify your location/i.test(String(message || ''));
}

function createUserLocationAlert({ client, log = console.log, enabled = !/^(0|false|no|off)$/i.test(process.env.USER_LOCATION_ALERTS || '1') } = {}) {
  const open = new Set();      // users with a known open row
  const inflight = new Set();
  async function onRejected(userId) {
    if (!enabled || !client || !userId || open.has(userId) || inflight.has(userId)) return;
    inflight.add(userId);
    try {
      const { error } = await client.from('combo_user_alerts').insert({
        user_id: userId, kind: 'location_expired', venue: 'kalshi', title: TITLE, body: BODY, dedupe_key: DEDUPE,
      });
      if (error && !(error.code === '23505' || /duplicate|unique/i.test(String(error.message || '')))) {
        log(`[LOCATION] alert insert failed: ${error.message || error}`);
        return;
      }
      open.add(userId);
      if (!error) log(`[LOCATION] user=${String(userId).slice(0, 8)} location attestation expired — site alert raised`);
    } catch (e) { log(`[LOCATION] alert error: ${e && e.message}`); } finally { inflight.delete(userId); }
  }
  async function onQuoted(userId) {
    if (!enabled || !client || !userId || !open.has(userId)) return;
    open.delete(userId);
    try {
      await client.from('combo_user_alerts').update({ resolved_at: new Date().toISOString() })
        .eq('user_id', userId).eq('dedupe_key', DEDUPE).is('resolved_at', null);
      log(`[LOCATION] user=${String(userId).slice(0, 8)} quote accepted — site alert resolved`);
    } catch (_) { /* best effort */ }
  }
  // Boot: learn open rows (e.g. one Kevin inserted) so the first accepted quote resolves them.
  async function load() {
    if (!enabled || !client) return;
    try {
      const { data } = await client.from('combo_user_alerts').select('user_id').eq('dedupe_key', DEDUPE).is('resolved_at', null);
      for (const r of data || []) if (r && r.user_id) open.add(r.user_id);
    } catch (_) { /* ignore */ }
  }
  return { onRejected, onQuoted, load, _open: open };
}

module.exports = { createUserLocationAlert, isLocationAttestationFailure, DEDUPE, BODY };
