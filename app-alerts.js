// Owner-only in-app alerts (public.app_alerts in Supabase), shown on
// aibetbuilder as a bell/banner for Kevin. NOT Telegram.
//
// Table: sql/app_alerts.sql. Service-role writes only from this worker.
// One unresolved row per dedupe_key (partial unique index). raise() with a
// key that is still unresolved is a no-op; resolve() closes it when the
// condition clears so the next occurrence inserts a fresh row.
//
// Every method swallows errors and returns false/null: an alert failure must
// never stop the bucket manager or quoting.
'use strict';

const TABLE = 'app_alerts';
const OWNER_EMAIL = 'kev120909@gmail.com';

function errText(e) {
  return e && e.message ? e.message : String(e);
}

function isUniqueViolation(err) {
  if (!err) return false;
  return err.code === '23505' || /duplicate key|unique/i.test(String(err.message || ''));
}

// client: a supabase-js client (service role). log: console-style function.
function createAppAlerts({ client, log = (...a) => console.log(...a), ownerEmail = OWNER_EMAIL } = {}) {
  if (!client || typeof client.from !== 'function') {
    return {
      enabled: false,
      async raise() { return false; },
      async resolve() { return false; },
    };
  }

  // Returns true when the alert exists afterwards (new row, or an unresolved
  // row with the same dedupe_key already there); false on a write error.
  // quiet: record the row for history but stamp read_at/resolved_at so it
  // never shows as a banner or bell badge (routine, successful activity).
  async function raise({ kind, severity = 'info', title, body = '', dedupeKey = null, meta = {}, quiet = false }) {
    try {
      const row = {
        owner_email: ownerEmail,
        kind: String(kind),
        severity,
        title: String(title),
        body: String(body),
        dedupe_key: dedupeKey || null,
        meta: meta || {},
      };
      if (quiet) {
        const now = new Date().toISOString();
        row.read_at = now;
        row.resolved_at = now;
      }
      const { error } = await client.from(TABLE).insert(row);
      if (error) {
        if (dedupeKey && isUniqueViolation(error)) return true;
        log(`[APP-ALERT] insert failed ${kind}: ${errText(error)}`);
        return false;
      }
      log(`[APP-ALERT] ${quiet ? 'logged (quiet)' : 'raised'} ${kind}${dedupeKey ? ` key=${dedupeKey}` : ''}`);
      return true;
    } catch (e) {
      log(`[APP-ALERT] insert error ${kind}: ${errText(e)}`);
      return false;
    }
  }

  // Marks every unresolved row with one of these keys as resolved.
  // opts.olderThanMs: only rows created at least that long ago.
  async function resolve(dedupeKeys, opts = {}) {
    const keys = [].concat(dedupeKeys || []).filter(Boolean);
    if (!keys.length) return false;
    try {
      let q = client
        .from(TABLE)
        .update({ resolved_at: new Date().toISOString() })
        .eq('owner_email', ownerEmail)
        .in('dedupe_key', keys)
        .is('resolved_at', null);
      if (opts && opts.olderThanMs > 0) {
        q = q.lt('created_at', new Date(Date.now() - opts.olderThanMs).toISOString());
      }
      const { error } = await q;
      if (error) {
        log(`[APP-ALERT] resolve failed ${keys.join(',')}: ${errText(error)}`);
        return false;
      }
      return true;
    } catch (e) {
      log(`[APP-ALERT] resolve error ${keys.join(',')}: ${errText(e)}`);
      return false;
    }
  }

  return { enabled: true, raise, resolve };
}

module.exports = { TABLE, OWNER_EMAIL, createAppAlerts, isUniqueViolation };
