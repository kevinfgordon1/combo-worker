// Unhedged-only Supabase HTTP helpers.
// Combo Locks quoting keeps the stock createClient + Kalshi undici pools.
//
// Production symptom: TypeError: fetch failed (undici / Cloudflare 520/522)
// on every unhedged_rfqs write, which logged per-RFQ and dropped paper fills.
// This module: dedicated Agent (not Kalshi, not global dispatcher), retries
// with backoff for transient transport errors, rate-limited logs, persist
// concurrency gate so a flap cannot stampede PostgREST.
'use strict';

const TRANSIENT_RE = /fetch failed|TypeError|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ENETUNREACH|EAI_AGAIN|UND_ERR|socket|aborted|AbortError|network|timeout|ConnectTimeout|SocketError|other side closed|EPIPE|520|521|522|523|524|502|503|504|408|429|Cloudflare/i;
const FATAL_RE = /duplicate|unique|23505|Could not find the|schema cache|JWT|invalid api key|invalid claim|401|403|42501|permission denied|row-level security/i;
const RETRY_STATUSES = new Set([408, 429, 502, 503, 504, 520, 521, 522, 523, 524]);

const DEFAULT_RETRY = {
  maxAttempts: 3,
  delaysMs: [250, 1000, 3000],
};

function peekJwtRole(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return json.role || null;
  } catch (_) {
    return null;
  }
}

function inspectSupabaseEnv(env = process.env) {
  const urlRaw = env && env.SUPABASE_URL;
  const key = env && env.SUPABASE_SERVICE_KEY;
  const out = {
    ok: false,
    url: urlRaw,
    key,
    host: null,
    keyRole: null,
    keyLen: key ? String(key).length : 0,
    warnings: [],
    reason: null,
    summary: '',
  };
  if (!urlRaw || !String(urlRaw).trim()) {
    out.reason = 'missing SUPABASE_URL';
    return out;
  }
  if (!key || !String(key).trim()) {
    out.reason = 'missing SUPABASE_SERVICE_KEY';
    return out;
  }
  const url = String(urlRaw).trim().replace(/^['"]|['"]$/g, '');
  if (/^postgres(ql)?:\/\//i.test(url)) {
    out.warnings.push('SUPABASE_URL looks like a Postgres URI; need https://<ref>.supabase.co');
  }
  try {
    const u = new URL(url);
    out.host = u.hostname;
    if (u.protocol !== 'https:') {
      out.warnings.push(`SUPABASE_URL scheme is ${u.protocol} (expected https:)`);
    }
    if (!/\.supabase\.(co|net)$/i.test(u.hostname) && u.hostname !== 'localhost') {
      out.warnings.push(`SUPABASE_URL host ${u.hostname} is not *.supabase.co`);
    }
  } catch (_) {
    out.reason = 'invalid SUPABASE_URL';
    return out;
  }
  out.keyRole = peekJwtRole(key);
  if (out.keyRole && out.keyRole !== 'service_role') {
    out.warnings.push(`SUPABASE_SERVICE_KEY role=${out.keyRole} (expected service_role)`);
  }
  out.ok = true;
  out.url = url;
  out.summary = `host=${out.host} keyRole=${out.keyRole || 'unknown'} keyLen=${out.keyLen}`
    + (out.warnings.length ? ` warnings=${out.warnings.join('; ')}` : '');
  return out;
}

function failureText(err) {
  if (err == null) return '';
  if (typeof err === 'number') return String(err);
  if (typeof err === 'string') return err;
  const cause = err.cause;
  return [
    err.message,
    err.details,
    err.hint,
    err.code,
    err.status,
    err.statusCode,
    cause && cause.message,
    cause && cause.code,
    cause && cause.cause && cause.cause.message,
    cause && cause.cause && cause.cause.code,
  ].filter(Boolean).join(' ');
}

function isTransientSupabaseFailure(err) {
  if (err == null) return false;
  if (typeof err === 'number') return RETRY_STATUSES.has(err);
  const text = failureText(err);
  if (!text) return false;
  if (FATAL_RE.test(text)) return false;
  return TRANSIENT_RE.test(text);
}

function isRetryHttpStatus(status) {
  return RETRY_STATUSES.has(Number(status));
}

function formatSupabaseFailure(err) {
  if (err == null) return 'unknown';
  if (typeof err === 'string') return err;
  const msg = err.message || String(err);
  const code = err.code != null ? ` code=${err.code}` : '';
  const status = err.status != null || err.statusCode != null
    ? ` status=${err.status || err.statusCode}`
    : '';
  const cause = err.cause;
  const causeBits = cause
    ? ` cause=${cause.code || cause.message || cause}`
    : '';
  return `${msg}${code}${status}${causeBits}`;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRateLimitedLogger({
  intervalMs = 30_000,
  now = () => Date.now(),
  write = (...args) => console.error(...args),
} = {}) {
  const buckets = new Map();
  function log(key, message, extra) {
    const b = buckets.get(key) || { n: 0, lastAt: -Infinity };
    b.n += 1;
    const t = now();
    if (t - b.lastAt >= intervalMs) {
      const suffix = b.n > 1 ? ` (${b.n} in ${intervalMs}ms)` : '';
      if (extra !== undefined) write(`${message}${suffix}`, extra);
      else write(`${message}${suffix}`);
      b.lastAt = t;
      b.n = 0;
    }
    buckets.set(key, b);
  }
  return { log, buckets };
}

async function withTransientRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts != null ? opts.maxAttempts : DEFAULT_RETRY.maxAttempts;
  const delaysMs = opts.delaysMs || DEFAULT_RETRY.delaysMs;
  const sleep = opts.sleep || defaultSleep;
  const isTransient = opts.isTransient || isTransientSupabaseFailure;
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const out = await fn(attempt);
      if (out && out.ok === false && out.error && isTransient(out.error) && attempt < maxAttempts) {
        last = out;
        await sleep(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] || 0);
        continue;
      }
      return out;
    } catch (e) {
      last = e;
      if (!isTransient(e) || attempt >= maxAttempts) throw e;
      await sleep(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] || 0);
    }
  }
  if (last && last.ok === false) return last;
  throw last;
}

function createPersistGate({ maxInFlight = 4, maxQueuedSeen = 80 } = {}) {
  let inFlight = 0;
  const waiting = [];
  let droppedSeen = 0;

  function pump() {
    while (inFlight < maxInFlight && waiting.length) {
      start(waiting.shift());
    }
  }

  function start(job) {
    inFlight += 1;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        inFlight -= 1;
        pump();
      });
  }

  function enqueue(kind, fn) {
    return new Promise((resolve, reject) => {
      const job = { kind, fn, resolve, reject };
      if (inFlight < maxInFlight) {
        start(job);
        return;
      }
      const queuedSeen = waiting.filter((j) => j.kind === 'seen').length;
      if (kind === 'seen' && queuedSeen >= maxQueuedSeen) {
        droppedSeen += 1;
        resolve({ ok: false, reason: 'persist_shed' });
        return;
      }
      waiting.push(job);
    });
  }

  return {
    enqueue,
    stats() {
      return { inFlight, queued: waiting.length, droppedSeen };
    },
  };
}

function createSupabaseFetch(opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch.bind(globalThis);
  const AgentImpl = opts.Agent;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 12_000;
  const maxAttempts = opts.maxAttempts != null ? opts.maxAttempts : DEFAULT_RETRY.maxAttempts;
  const delaysMs = opts.delaysMs || [150, 400, 1000];
  const sleep = opts.sleep || defaultSleep;
  const logger = opts.logger || createRateLimitedLogger({
    write: (...args) => console.error('[UNHEDGED]', ...args),
  });
  const forceIpv4 = opts.forceIpv4 === true;
  const agent = AgentImpl
    ? new AgentImpl({
      connections: opts.connections != null ? opts.connections : 8,
      pipelining: 1,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connectTimeout: 10_000,
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
      connect: {
        timeout: 10_000,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
        ...(forceIpv4 ? { family: 4 } : {}),
      },
    })
    : null;

  async function drain(res) {
    try {
      if (res && typeof res.arrayBuffer === 'function') await res.arrayBuffer();
    } catch (_) {}
  }

  async function supabaseFetch(input, init = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        if (init.signal) {
          if (init.signal.aborted) ac.abort();
          else init.signal.addEventListener('abort', () => ac.abort(), { once: true });
        }
        const nextInit = { ...init, signal: ac.signal };
        if (agent && nextInit.dispatcher == null) nextInit.dispatcher = agent;
        const res = await fetchImpl(input, nextInit);
        if (isRetryHttpStatus(res.status) && attempt < maxAttempts) {
          logger.log(
            'http',
            `supabase HTTP ${res.status} — retry ${attempt}/${maxAttempts}`
          );
          await drain(res);
          await sleep(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] || 0);
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (!isTransientSupabaseFailure(e) || attempt >= maxAttempts) {
          logger.log('fetch', `supabase fetch failed ${formatSupabaseFailure(e)}`);
          throw e;
        }
        logger.log(
          'fetch',
          `supabase fetch failed ${formatSupabaseFailure(e)} — retry ${attempt}/${maxAttempts}`
        );
        await sleep(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] || 0);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  supabaseFetch.agent = agent;
  return supabaseFetch;
}

function createUnhedgedSupabaseClient({
  createClient,
  env = process.env,
  fetch: fetchImpl,
  Agent,
  logger = console,
} = {}) {
  if (typeof createClient !== 'function') {
    throw new Error('createUnhedgedSupabaseClient requires createClient');
  }
  const inspected = inspectSupabaseEnv(env);
  if (!inspected.ok) {
    logger.error(`[UNHEDGED] supabase env ${inspected.reason}`);
  } else {
    logger.log(`[UNHEDGED] supabase ${inspected.summary}`);
    for (const w of inspected.warnings) logger.warn(`[UNHEDGED] supabase env ${w}`);
  }
  const forceIpv4 = /^(1|true|yes)$/i.test(String((env && env.SUPABASE_FETCH_IPV4) || ''));
  const fetchWithRetry = createSupabaseFetch({
    fetch: fetchImpl,
    Agent,
    forceIpv4,
  });
  return createClient(inspected.url || env.SUPABASE_URL, inspected.key || env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithRetry },
  });
}

module.exports = {
  TRANSIENT_RE,
  RETRY_STATUSES,
  DEFAULT_RETRY,
  peekJwtRole,
  inspectSupabaseEnv,
  isTransientSupabaseFailure,
  isRetryHttpStatus,
  formatSupabaseFailure,
  createRateLimitedLogger,
  withTransientRetry,
  createPersistGate,
  createSupabaseFetch,
  createUnhedgedSupabaseClient,
};
