// prophetx-worker hard sandbox guard. Runs before anything else.
// Refuses to start unless PX_SANDBOX=1, every ProphetX host is a sandbox host,
// and no Kalshi / Polymarket trading credentials are present in the env.
'use strict';

const SANDBOX_HOST_RE = /(^|\.)sandbox\.prophetx\.dev$/i;
const DEFAULTS = {
  PX_API_BASE: 'https://api.sandbox.prophetx.dev/partner',
  PX_PARLAY_BASE: 'https://api.sandbox.prophetx.dev/parlay/sp/v2',
};
// Names only. A trading key for another venue has no business in this process.
const FORBIDDEN_ENV_RE = /^(KALSHI_.*(KEY|SECRET|PEM|PRIVATE)|POLY(MARKET)?_.*(KEY|SECRET|PRIVATE|PASSPHRASE)|NOVIG_.*(KEY|SECRET|TOKEN)|PROPHETX_(API_KEY|ACCESS_KEY|SECRET_KEY)$)/i;

function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
}

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return ''; }
}

function checkSandboxEnv(env = process.env) {
  const problems = [];
  if (!truthy(env.PX_SANDBOX)) problems.push('PX_SANDBOX must be 1');
  const apiBase = env.PX_API_BASE || DEFAULTS.PX_API_BASE;
  const parlayBase = env.PX_PARLAY_BASE || DEFAULTS.PX_PARLAY_BASE;
  for (const [name, url] of [['PX_API_BASE', apiBase], ['PX_PARLAY_BASE', parlayBase]]) {
    const u = (() => { try { return new URL(url); } catch (_) { return null; } })();
    if (!u || u.protocol !== 'https:' || !SANDBOX_HOST_RE.test(u.hostname)) problems.push(`${name} must be an https sandbox.prophetx.dev host`);
  }
  if (!env.PROPHETX_SANDBOX_API_KEY) problems.push('PROPHETX_SANDBOX_API_KEY missing');
  if (!env.PROPHETX_SANDBOX_SECRET_KEY) problems.push('PROPHETX_SANDBOX_SECRET_KEY missing');
  const forbidden = Object.keys(env).filter((k) => FORBIDDEN_ENV_RE.test(k) && env[k]);
  if (forbidden.length) problems.push(`forbidden trading credentials present: ${forbidden.join(',')}`);
  return { ok: problems.length === 0, problems, apiBase, parlayBase };
}

// Callback URLs come from ProphetX inside events. Only ever POST to sandbox hosts.
function assertSandboxUrl(url) {
  const h = hostOf(url).replace(/:\d+$/, '');
  if (!SANDBOX_HOST_RE.test(h)) throw new Error(`refusing non-sandbox url host=${h || '?'}`);
  return url;
}

module.exports = { checkSandboxEnv, assertSandboxUrl, truthy, SANDBOX_HOST_RE, DEFAULTS, FORBIDDEN_ENV_RE };
