// Runs the no-boost test files. Kept out of package.json "test" on purpose: any package.json change
// triggers a Railway redeploy of the live services (watch pattern /package.json). Wire into npm test later.
'use strict';
const { spawnSync } = require('child_process');
let bad = 0;
for (const f of ['quote', 'risk', 'book', 'shadow', 'paper', 'promo-fair', 'matching']) {
  const r = spawnSync(process.execPath, [`${__dirname}/${f}.test.js`], { stdio: 'inherit' });
  if (r.status !== 0) { bad += 1; console.error(`FAILED noboost/${f}.test.js`); }
}
process.exit(bad ? 1 : 0);
