'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { superviseChild, PROTECT_RESTART_MIN_MS, PROTECT_RESTART_MAX_MS } = require('./protect-supervise');

function fakeSpawn() {
  const exits = [];
  let handler = null;
  return {
    exits,
    spawn() {
      return {
        on(ev, fn) { if (ev === 'exit') handler = fn; },
        kill() { exits.push('kill'); },
      };
    },
    exit(code, signal) {
      const fn = handler;
      handler = null;
      fn(code, signal);
    },
  };
}

{
  const child = fakeSpawn();
  const waits = [];
  const pending = [];
  let clock = 0;
  const sup = superviseChild({
    spawnImpl: child.spawn,
    command: process.execPath,
    args: ['desk-protect-ws.js'],
    now: () => clock,
    setTimer(fn, ms) {
      waits.push(ms);
      pending.push(fn);
      return pending.length;
    },
    clearTimer() { pending.length = 0; },
  });
  child.exit(0, null);
  assert.deepStrictEqual(waits, [PROTECT_RESTART_MIN_MS], 'code 0 still restarts');
  pending.shift()();
  child.exit(1, null);
  assert.equal(waits[1], PROTECT_RESTART_MIN_MS * 2);
  pending.shift()();
  clock = PROTECT_RESTART_MAX_MS;
  child.exit(0, null);
  assert.equal(waits[2], PROTECT_RESTART_MIN_MS, 'a child that stayed up resets the backoff');
  sup.stop();
  assert.equal(pending.length, 0, 'stop cancels a pending restart');
}

{
  const child = fakeSpawn();
  const sup = superviseChild({
    spawnImpl: child.spawn,
    command: process.execPath,
    args: ['desk-protect-ws.js'],
    setTimer() { return 1; },
    clearTimer() {},
  });
  sup.stop();
  assert.deepStrictEqual(child.exits, ['kill']);
}

{
  let delay = PROTECT_RESTART_MIN_MS;
  const seen = [];
  for (let i = 0; i < 8; i += 1) {
    seen.push(delay);
    delay = Math.min(delay * 2, PROTECT_RESTART_MAX_MS);
  }
  assert.deepStrictEqual(seen.slice(0, 5), [2000, 4000, 8000, 16000, 30000]);
  assert.equal(seen[7], 30000);
}

{
  const src = fs.readFileSync(path.join(__dirname, 'start-poly.js'), 'utf8');
  assert.ok(src.includes('superviseChild'));
  assert.ok(src.includes('desk-protect-ws.js'));
  assert.ok(!/code === 0/.test(src), 'a clean protect exit must not be ignored');
  assert.ok(/quoter\.on\('exit'[\s\S]{0,200}process\.exit/.test(src), 'quoting child exit still stops this process');
  const protectExit = src.indexOf('desk-protect-ws.js exited');
  const quoterExit = src.indexOf('live-runner.js exited');
  assert.ok(protectExit > 0 && quoterExit > 0);
  assert.ok(!src.slice(protectExit, protectExit + 180).includes('process.exit'), 'protect exit must not restart quoting');
}

console.log('protect-supervise.test.js ok');
