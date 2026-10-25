const assert = require('assert');
const fs = require('fs');
const path = require('path');
const t = fs.readFileSync(path.join(__dirname, 'fly/combo-testers.toml'), 'utf8');
assert.match(t, /^\s*memory = "8gb"/m, "8192 MB");
const vms = t.match(/^\[\[vm\]\]/gm) || [];
assert.strictEqual(vms.length, 1, 'exactly one [[vm]] block');
assert.match(t, /^\s*size = "performance-4x"/m, 'dedicated CPU (no shared-quota throttle)');
const env = t.slice(t.indexOf('[env]'));
for (const [k, v] of [['WORKER_MODE', 'testers'], ['KALSHI_BUCKET_AUTO', '0'], ['KALSHI_BUCKET_SWEEP', '0'], ['TESTERS_PERF', '1']]) {
  assert.match(env, new RegExp(`^\\s*${k} = "${v}"`, 'm'), `${k}=${v}`);
}
assert.ok(!/^\s*\[http_service\]/m.test(t), 'no http_service (Fly must not auto-start extra machines)');
console.log('combo-testers-toml.test.js ok');
