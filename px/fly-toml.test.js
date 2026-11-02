// fly/prophetx-sandbox.toml: sandbox-only env, one machine, no public ports, no trading keys.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { checkSandboxEnv, FORBIDDEN_ENV_RE, SANDBOX_HOST_RE } = require('./guard');

const t = fs.readFileSync(path.join(__dirname, '..', 'fly/prophetx-sandbox.toml'), 'utf8');
const code = t.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
assert.match(code, /^app = "kaygo-prophetx-sandbox"$/m);
assert.match(code, /^\s*app = "node start-prophetx\.js"/m, 'process runs the sandbox quoter');
assert.strictEqual((code.match(/^\[\[vm\]\]/gm) || []).length, 1, 'exactly one [[vm]] block');
assert.match(code, /^\s*strategy = "immediate"/m, 'no overlap of two copies');
assert.ok(!/^\s*\[(http_service|\[services\]|\[http_service\.)/m.test(code), 'no public ports');

const env = {};
for (const m of code.slice(code.indexOf('[env]')).matchAll(/^\s*([A-Z0-9_]+) = "([^"]*)"/gm)) env[m[1]] = m[2];
assert.strictEqual(env.PX_SANDBOX, '1');
for (const [k, v] of Object.entries(env)) {
  assert.ok(!FORBIDDEN_ENV_RE.test(k), `forbidden key name in [env]: ${k}`);
  assert.ok(!/KEY|SECRET|TOKEN|PRIVATE|PASSPHRASE|PEM/i.test(k), `no credential in [env]: ${k}`);
  if (k === 'PX_ODDS_RELAY_URL') { assert.strictEqual(v, 'http://kaygo-odds-relay.internal:8787', 'relay over Fly private network only'); continue; }
  if (/^https?:\/\//.test(v)) assert.ok(SANDBOX_HOST_RE.test(new URL(v).hostname), `${k} must be a sandbox host`);
  assert.ok(!/prophetx\.co\b/i.test(v), `${k} points at ProphetX production`);
}
const g = checkSandboxEnv({ ...env, PROPHETX_SANDBOX_API_KEY: 'x', PROPHETX_SANDBOX_SECRET_KEY: 'y' });
assert.ok(g.ok, g.problems.join('; '));
assert.ok(!checkSandboxEnv({ ...env, PROPHETX_SANDBOX_API_KEY: 'x', PROPHETX_SANDBOX_SECRET_KEY: 'y', PROPHETX_API_BASE: 'https://cash.api.prophetx.co/partner' }).ok, 'production PROPHETX_API_BASE refused');
assert.ok(!checkSandboxEnv({ ...env, PROPHETX_SANDBOX_API_KEY: 'x', PROPHETX_SANDBOX_SECRET_KEY: 'y', PX_ODDS_RELAY_URL: 'https://evil.example.com' }).ok, 'relay must be *.internal / *.fly.dev');
console.log('px/fly-toml.test.js ok');
