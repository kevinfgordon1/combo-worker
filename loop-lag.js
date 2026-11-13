// Lightweight event-loop lag monitor.
//
// perf_hooks.monitorEventLoopDelay records how late the loop is. Once a
// second-or-so check sees a block over the threshold, we log it with the
// label (and a short stack) of the task that was running, when one was
// marked with enterTask(). Observability only: it never changes quoting.
'use strict';
const { monitorEventLoopDelay } = require('perf_hooks');

let active = null;
let recent = null;

function shortStack() {
  const lines = String(new Error().stack || '').split('\n').slice(3, 6);
  return lines.map((l) => l.trim()).filter(Boolean).join(' | ').slice(0, 300);
}

// Mark a stretch of work. Returns a leave() function. Nesting is a stack,
// so a task that calls another labeled task restores the outer one.
function enterTask(label) {
  const prev = active;
  active = { label: String(label || 'task'), at: Date.now(), stack: shortStack(), prev };
  let left = false;
  return function leave() {
    if (left || active == null) return;
    left = true;
    recent = { label: active.label, ms: Date.now() - active.at, stack: active.stack, ended: Date.now() };
    active = prev;
  };
}

function currentTask() {
  return active;
}

function startLoopLagMonitor({
  thresholdMs = 250,
  intervalMs = 200,
  log = console.warn,
} = {}) {
  let hist = null;
  try {
    hist = monitorEventLoopDelay({ resolution: 20 });
    hist.enable();
  } catch (_) { hist = null; }
  let expected = Date.now() + intervalMs;
  const timer = setInterval(() => {
    const now = Date.now();
    const late = now - expected;
    expected = now + intervalMs;
    const histMax = hist ? hist.max / 1e6 : 0;
    if (hist) hist.reset();
    const block = Math.max(late, histMax);
    if (!(block >= thresholdMs)) return;
    const task = active || (recent && now - recent.ended <= block + intervalMs ? recent : null);
    const where = task && task.stack ? ` ${task.stack}` : '';
    try {
      log(`[LOOP] block ${Math.round(block)}ms task=${task ? task.label : 'unknown'}${where}`);
    } catch (_) { /* logging must not throw into the timer */ }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return {
    stop() {
      clearInterval(timer);
      try { hist && hist.disable(); } catch (_) {}
    },
  };
}

module.exports = { enterTask, startLoopLagMonitor, currentTask };
