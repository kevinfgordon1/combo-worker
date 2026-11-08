// Startup REST for poly-worker. A restart used to fire the account check,
// quote-socket warm, and the activities/positions fill hydrate in the same
// instant. That burst is what returned 429 on /v1/portfolio/activities and
// Cloudflare 1015 (nov8-9497c14). Tasks run one at a time, at least gapMs
// apart, through the shared limiter. A 429 holds the queue for Retry-After
// when the response has one, and never starts the next read early.
'use strict';

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    const v = headers.get(name);
    if (v != null && v !== '') return String(Array.isArray(v) ? v[0] : v);
  }
  const want = String(name || '').toLowerCase();
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() !== want) continue;
    const v = headers[k];
    if (v == null || v === '') return null;
    return String(Array.isArray(v) ? v[0] : v);
  }
  return null;
}

// Milliseconds to wait. null when the header is missing or not a delay.
// Delta-seconds and HTTP-date are both accepted. Never shorter than the header.
function retryAfterMs(headers, now = Date.now()) {
  const raw = headerValue(headers, 'retry-after');
  if (raw == null) return null;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - now);
  return null;
}

function retryAfterFromError(err, now = Date.now()) {
  if (!err) return null;
  if (Number.isFinite(err.backoffMs) && err.backoffMs >= 0) return err.backoffMs;
  if (Number.isFinite(err.retryInMs) && err.retryInMs >= 0) return err.retryInMs;
  return retryAfterMs(err.headers, now);
}

function createPolyStartupRest({
  gapMs = 1200,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  limiter = null,
} = {}) {
  const jobs = [];
  let pumping = false;
  let stopped = false;
  let notBefore = 0;
  const stats = { ran: 0, waitedMs: 0, held429: 0, limited: 0 };

  function holdFor(ms) {
    const n = Number(ms);
    if (!(n > 0)) return;
    notBefore = Math.max(notBefore, now() + n);
  }

  function stop() {
    stopped = true;
    jobs.length = 0;
  }

  async function pump() {
    if (pumping || stopped) return;
    pumping = true;
    try {
      while (jobs.length && !stopped) {
        const wait = notBefore - now();
        if (wait > 0) { stats.waitedMs += wait; await sleep(wait); }
        const job = jobs.shift();
        try {
          if (limiter && typeof limiter.acquire === 'function') {
            const slot = await limiter.acquire(job.method || 'GET', job.path || '/');
            if (!slot || slot.ok === false) {
              stats.limited += 1;
              job.tries = (job.tries || 0) + 1;
              if (job.tries > 8) {
                job.reject(Object.assign(new Error('startup limiter'), { statusCode: 429 }));
                holdFor(gapMs || 50);
                continue;
              }
              holdFor(Math.max(50, (slot && slot.retryInMs) || gapMs || 50));
              jobs.unshift(job);
              continue;
            }
          }
          const result = await job.fn();
          stats.ran += 1;
          job.resolve(result);
        } catch (e) {
          if (e && e.statusCode === 429) {
            stats.held429 += 1;
            const ra = retryAfterFromError(e, now());
            holdFor(ra != null ? ra : gapMs);
          }
          job.reject(e);
        }
        holdFor(gapMs);
      }
    } finally {
      pumping = false;
      if (jobs.length) pump();
    }
  }

  function schedule(name, fn, meta = {}) {
    return new Promise((resolve, reject) => {
      jobs.push({ name, fn, resolve, reject, method: meta.method, path: meta.path });
      pump();
    });
  }

  return {
    schedule,
    holdFor,
    stop,
    stats: () => ({ ...stats, queued: jobs.length }),
  };
}

module.exports = {
  headerValue,
  retryAfterMs,
  retryAfterFromError,
  createPolyStartupRest,
};
