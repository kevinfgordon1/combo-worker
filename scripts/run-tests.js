#!/usr/bin/env node
'use strict';
// Runs EVERY *.test.js in the repo (except node_modules) (one node process each) and reports all
// failures at the end, instead of the old `a && b && ...` chain that stopped at the first one.
// Files using node:test are run with `node --test`. Usage: node scripts/run-tests.cjs [filter]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const dirs = ['.'];
const filter = process.argv[2] || '';
const files = [];
function walk(d) {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.test\.(c?js|mjs)$/.test(e.name)) files.push(path.relative(root, p));
  }
}
dirs.forEach((d) => walk(path.join(root, d)));
files.sort();
const run = files.filter((f) => f.includes(filter));
const failed = [];
const t0 = Date.now();
for (const f of run) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  const args = /['"]node:test['"]/.test(src) ? ['--test', f] : [f];
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) {
    failed.push(f);
    process.stdout.write(`✗ ${f}\n${String(r.stderr || r.stdout || r.error || '').split('\n').slice(0, 12).join('\n')}\n`);
  }
}
console.log(`\n${run.length - failed.length}/${run.length} test files passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failed.length) { console.log('Failed:\n  ' + failed.join('\n  ')); process.exit(1); }
