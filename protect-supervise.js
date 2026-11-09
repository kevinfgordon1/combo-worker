// Restarts the Bet Protect child without touching Combo Locks quoting.
// Any exit, including code 0, is restarted. Backoff grows from 2s to 30s
// and resets after the child has stayed up for 30s.
'use strict';

const PROTECT_RESTART_MIN_MS = 2000;
const PROTECT_RESTART_MAX_MS = 30000;

function superviseChild({
  spawnImpl,
  command,
  args,
  env,
  cwd,
  onExit,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let stopped = false;
  let child = null;
  let timer = null;
  let delay = PROTECT_RESTART_MIN_MS;
  let startedAt = 0;

  function start() {
    if (stopped) return;
    timer = null;
    startedAt = now();
    child = spawnImpl(command, args, { stdio: 'inherit', env, cwd });
    child.on('exit', (code, signal) => {
      const lived = now() - startedAt;
      child = null;
      try { if (onExit) onExit(code, signal); } catch (_) {}
      if (stopped) return;
      if (lived >= PROTECT_RESTART_MAX_MS) delay = PROTECT_RESTART_MIN_MS;
      const wait = delay;
      delay = Math.min(delay * 2, PROTECT_RESTART_MAX_MS);
      timer = setTimer(start, wait);
    });
  }

  start();
  return {
    stop(signal) {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      if (child && typeof child.kill === 'function') child.kill(signal || 'SIGINT');
    },
  };
}

module.exports = {
  PROTECT_RESTART_MIN_MS,
  PROTECT_RESTART_MAX_MS,
  superviseChild,
};
