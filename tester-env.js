// Build the environment for one tester's worker child. Pure (no I/O) so it
// can be unit-tested: a child only ever sees THAT tester's keys, the Supabase
// service connection, and explicit non-secret tuning flags.
'use strict';

const crypto = require('crypto');

// Never inherited from the supervisor (nor via TESTER_ENV_*): Kevin's
// exchange credentials, anything that would send a tester's activity to
// Kevin's channels, money-moving bucket flags, and the identity vars this
// module sets itself. Everything else (Supabase connection, tuning flags) is
// inherited, so a dedicated combo-testers service only needs its own vars.
const FORBIDDEN = /^(KALSHI_KEY_ID|Kalshi_combo_key|KALSHI_PRIVATE_KEY|KALSHI_.*KEY.*|POLYMARKET_KEY_ID|POLYMARKET_SECRET_KEY|POLYMARKET_.*SECRET.*|TELEGRAM_.*|COMBO_USER_TG_.*|DESK_PROTECT_.*|ADMIN_API_SECRET|COMBO_WORKER_USER_ID|WORKER_MODE|KALSHI_BUCKET_.*|COMBO_CAP_AT_CONFIRM|POLYMARKET_RFQ_LIVE|RAILWAY_.*)$/;

// Oct 25: 6 tester children each ran 8 Kalshi WS shards on the main event loop
// (loop lag 2-12s, ~1/3 of frames dropped) and Kenny's child signed with a bogus
// -3..-8s clock offset. These are the per-child settings TESTERS_PERF=1 applies.
const TESTERS_PERF_DEFAULTS = Object.freeze({
  COMBO_INTAKE_WORKER: '1',   // WS + pre-parse drops + 15s stale gate on a worker thread
  KALSHI_WS_SHARD_FACTOR: '2', // 2 sockets per tester instead of 8 (users have 1-9 locks)
  KALSHI_CLOCK_MIDPOINT: '1',  // RTT-midpoint clock offset, lag/RTT-gated, clamped
  COMBO_NEAR_MISS_LOG: '1',    // rate-limited NEAR-MISS leg-key lines for active locks
});
function testersPerfEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String((env && env.TESTERS_PERF) || '').trim());
}

function buildTesterEnv(base, { userId, kalshi, poly } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (v == null || /^TESTER_ENV_/.test(k) || FORBIDDEN.test(k)) continue;
    env[k] = v;
  }
  // TESTER_ENV_FOO=bar on the supervisor => FOO=bar in every child (tuning flags).
  for (const [k, v] of Object.entries(base)) {
    const m = /^TESTER_ENV_(.+)$/.exec(k);
    if (m && !FORBIDDEN.test(m[1])) env[m[1]] = v;
  }
  // TESTERS_PERF=1 (one switch, default off): per-child defaults for the Oct 25 overload
  // fix. Any of them can still be overridden one by one with TESTER_ENV_<NAME>.
  if (testersPerfEnabled(base)) {
    for (const [k, v] of Object.entries(TESTERS_PERF_DEFAULTS)) {
      if (!Object.prototype.hasOwnProperty.call(base, `TESTER_ENV_${k}`)) env[k] = v;
    }
  }
  env.WORKER_MODE = 'combo';
  env.COMBO_WORKER_USER_ID = userId;
  env.KALSHI_KEY_ID = kalshi.keyId;
  env.Kalshi_combo_key = kalshi.secret;
  // Open quotes reserve against the lock + day caps (strict for tester money).
  env.COMBO_CAP_AT_CONFIRM = '0';
  // Kevin's bucket manager stays off in tester children. Tester auto-funding
  // is tester-funder.js (own Default -> own Combos only), controlled by
  // TESTER_AUTOFUND / TESTER_FUND_* inherited from the supervisor.
  env.KALSHI_BUCKET_AUTO = '0';
  env.KALSHI_BUCKET_SWEEP = '0';
  if (poly && poly.keyId && poly.secret) {
    env.POLYMARKET_KEY_ID = poly.keyId;
    env.POLYMARKET_SECRET_KEY = poly.secret;
    env.POLYMARKET_RFQ_LIVE = '1';
  } else {
    env.POLYMARKET_RFQ_LIVE = '0';
  }
  return env;
}

// Changes when a key is rotated/removed, so the supervisor restarts the child.
function keyFingerprint({ kalshi, poly } = {}) {
  const h = crypto.createHash('sha256');
  h.update(String(kalshi && kalshi.keyId)); h.update('\0'); h.update(String(kalshi && kalshi.secret)); h.update('\0');
  h.update(String(poly && poly.keyId)); h.update('\0'); h.update(String(poly && poly.secret));
  return h.digest('hex');
}

// Replace any credential that shows up in child output.
function makeRedactor(secrets) {
  const needles = (secrets || []).map((s) => String(s || '')).filter((s) => s.length >= 6);
  const pemLines = [];
  for (const n of needles) for (const line of n.split(/\r?\n/)) if (line.trim().length >= 16 && !/^-----/.test(line.trim())) pemLines.push(line.trim());
  return (text) => {
    let out = String(text);
    for (const n of needles.concat(pemLines)) if (out.includes(n)) out = out.split(n).join('[redacted]');
    return out;
  };
}

module.exports = { buildTesterEnv, keyFingerprint, makeRedactor, FORBIDDEN, TESTERS_PERF_DEFAULTS, testersPerfEnabled };
