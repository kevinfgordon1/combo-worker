// ProphetX sandbox session: ONE /auth/login, then /auth/refresh before expiry.
// Each login takes a session slot on the key and revoking does not free it, so
// we only log in again when a refresh fails. Tokens are never logged.
'use strict';

function toMs(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e17) return Math.floor(n / 1e6); // ns
  if (n > 1e14) return Math.floor(n / 1e3); // us
  if (n > 1e11) return n; // ms
  return n * 1000; // s
}

function createSession({ apiBase, accessKey, secretKey, fetch: f = globalThis.fetch, now = Date.now, logger = console } = {}) {
  let access = null;
  let refresh = null;
  let accessExp = 0;
  let refreshExp = 0;
  let inflight = null;
  let logins = 0;
  let refreshes = 0;

  function absorb(data, t0) {
    access = data.access_token;
    refresh = data.refresh_token || refresh;
    accessExp = toMs(data.access_expire_time) || t0 + 9 * 60 * 1000;
    if (data.refresh_expire_time) refreshExp = toMs(data.refresh_expire_time) || refreshExp;
  }

  async function post(path, body) {
    const res = await f(apiBase + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => null);
    return { status: res.status, data: j && j.data, error: j && (j.error || j.message) };
  }

  async function doLogin() {
    const t0 = now();
    const r = await post('/auth/login', { access_key: accessKey, secret_key: secretKey });
    if (r.status !== 200 || !r.data || !r.data.access_token) throw new Error(`login failed status=${r.status} ${r.error || ''}`);
    logins += 1;
    absorb(r.data, t0);
    logger.log(`[PX-AUTH] login ok (#${logins}) access_ttl_s=${Math.round((accessExp - t0) / 1000)}`);
  }

  async function doRefresh() {
    const t0 = now();
    const r = await post('/auth/refresh', { refresh_token: refresh });
    if (r.status !== 200 || !r.data || !r.data.access_token) throw new Error(`refresh failed status=${r.status} ${r.error || ''}`);
    refreshes += 1;
    absorb(r.data, t0);
  }

  async function renew() {
    if (refresh && (!refreshExp || now() < refreshExp - 60_000)) {
      try { await doRefresh(); return; } catch (e) { logger.warn(`[PX-AUTH] ${e.message}; logging in again`); }
    }
    await doLogin();
  }

  // Refresh at ~75% of the access lifetime (min 60s before expiry).
  function needsRenew() {
    if (!access) return true;
    return now() > accessExp - 120_000;
  }

  async function token({ force = false } = {}) {
    if (force || needsRenew()) {
      if (!inflight) inflight = (access && refresh ? renew() : doLogin()).finally(() => { inflight = null; });
      await inflight;
    }
    return access;
  }

  async function authHeaders() {
    return { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' };
  }

  return { token, authHeaders, stats: () => ({ logins, refreshes, accessExp }) };
}

module.exports = { createSession, toMs };
