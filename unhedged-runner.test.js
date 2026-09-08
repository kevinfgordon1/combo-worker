'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const runnerSrc = fs.readFileSync(path.join(__dirname, 'unhedged-runner.js'), 'utf8');
const startSrc = fs.readFileSync(path.join(__dirname, 'start-unhedged.js'), 'utf8');
const startLiveSrc = fs.readFileSync(path.join(__dirname, 'start-live.js'), 'utf8');
const liveSrc = fs.readFileSync(path.join(__dirname, 'live-runner.js'), 'utf8');

assert.ok(
  /const MODE = 'UNHEDGED'/.test(runnerSrc),
  'dedicated process must identify as UNHEDGED'
);
assert.ok(
  /createUnhedgedRuntime/.test(runnerSrc) && /createKalshiWs/.test(runnerSrc),
  'unhedged-runner owns Kalshi firehose + shared runtime'
);
assert.ok(
  /startPolymarketRfqLoop\(\{[\s\S]*quoteLocks:\s*false/.test(runnerSrc),
  'Poly loop in the unhedged process must never quote Combo Locks'
);
assert.ok(
  /unhedgedEnabled:\s*true/.test(runnerSrc),
  'unhedged process must persist unmatched Poly RFQs'
);
assert.ok(
  !/require\(['"]\.\/quote-watcher['"]\)/.test(runnerSrc),
  'quote-watcher stays parked'
);
assert.ok(
  !/require\(['"]\.\/engine['"]\)/.test(runnerSrc),
  'unhedged-runner must not import Combo Lock quote helpers'
);
assert.ok(
  !/buildQuoteBody|postQuote|confirmQuote/.test(runnerSrc),
  'unhedged-runner must not POST / confirm quotes'
);
assert.ok(
  !/require\(['"]\.\/skip-tape['"]\)/.test(runnerSrc) &&
    !/require\(['"]\.\/poly-miss-tape['"]\)/.test(runnerSrc) &&
    !/from\(['"]combo_submissions['"]\)/.test(runnerSrc),
  'Combo Locks Miss tape stays on live-runner'
);
assert.ok(
  /UNHEDGED_RFQ_LIVE/.test(runnerSrc) &&
    /this process never POSTs/.test(runnerSrc),
  'UNHEDGED_RFQ_LIVE must stay unwired even if the env is mistakenly on'
);
assert.ok(
  /MLB\/NFL/.test(runnerSrc) && /No Polymarket maker rebates/.test(runnerSrc),
  'scope comment must stay MLB/NFL full-game ML, no Poly maker rebate'
);
assert.ok(
  /WORKER_ROLE=locks/.test(runnerSrc),
  'refuse to run when someone pointed Combo Locks role at this entrypoint'
);
assert.ok(
  /require\.main === module/.test(runnerSrc),
  'do not start the firehose when tests require the file'
);

assert.ok(
  startSrc.includes('unhedged-runner.js') && !startSrc.includes('live-runner.js'),
  'start-unhedged must only spawn the unhedged worker'
);
assert.ok(
  !startSrc.includes('fills-reader.js'),
  'fills-reader is Combo Locks Filled tab — not unhedged'
);
assert.ok(
  startLiveSrc.includes('live-runner.js') && startLiveSrc.includes('fills-reader.js'),
  'start-live stays Combo Locks + fills-reader'
);
assert.ok(
  !startLiveSrc.includes('unhedged-runner.js'),
  'Combo Locks start command must not start unhedged'
);
assert.ok(
  /WORKER_ROLE=unhedged/.test(startLiveSrc),
  'start-live must refuse WORKER_ROLE=unhedged'
);

assert.ok(
  /isUnhedgedInProcess/.test(liveSrc) && /unhedgedInProcess/.test(liveSrc),
  'live-runner must gate in-process unhedged'
);
assert.ok(
  /if \(unhedgedInProcess\) \{[\s\S]*createUnhedgedRuntime/.test(liveSrc),
  'price cache / fill tracker start only when UNHEDGED_IN_PROCESS is on'
);
assert.ok(
  /if \(unhedgedInProcess && unhedged\) \{[\s\S]*shadowKalshiMiss/.test(liveSrc),
  'locks-only Kalshi path must not shadow unhedged on the hot path'
);
assert.ok(
  /unhedgedEnabled:\s*unhedgedInProcess/.test(liveSrc) &&
    /quoteLocks:\s*true/.test(liveSrc),
  'Combo Locks Poly loop always quotes; unhedged shadow follows the gate'
);
assert.ok(
  /startPolymarketRfqLoop/.test(liveSrc) && /createKalshiWs/.test(liveSrc),
  'locks-only process still runs Kalshi + Polymarket Combo Locks'
);
assert.ok(
  /WORKER_ROLE=unhedged/.test(liveSrc),
  'live-runner must refuse to run as the unhedged job'
);

console.log('unhedged-runner.test.js ok');
