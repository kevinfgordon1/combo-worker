// Shared Kalshi account limiter for Combo Locks (kaygo-combo-worker).
//
// Kevin's account is Advanced (GET /account/limits, recorded in fly/sniper.toml):
//   Read  300 tokens/s, bucket holds 3s (900 tokens)
//   Write 300 tokens/s, bucket holds 3s (900 tokens)
//   GET /portfolio/balance is its own bucket: 1/s, holds one second, no burst.
//     Basic and Advanced are 1/s; Expert and above are 5/s.
// Docs: https://docs.kalshi.com/getting_started/rate_limits
// Default request cost is 10 tokens. Quote create and cancel are 2.
// Confirm scoped to the RFQ id is 1 (same limits read, Oct 28).
// RFQ quote writes share the shard-1 write bucket. This process is the only
// writer while the sniper is off, so the budget is the whole account, not the
// slice reserved for the sniper. Headroom (default 0.9) stays under the
// published ceiling so clock skew cannot trip a 429.
//
// Quote POST and confirm (priority 2) are served ahead of other writes
// (cancels, transfers). Fills/order reads (priority 1) are served ahead of
// warm and other background GETs. Read and write do not share a bucket, so a
// warm burst cannot delay a quote. Balance never shares with either.
//
// A 429 backs off that bucket only, with jitter. Retry-After is honored when
// the response has one (Kalshi does not send it today). The sniper process
// has its own limiter and is not touched here.
'use strict';

const DEFAULT_COST = 10;
const TIERS = Object.freeze({
  basic: { readTok: 200, writeTok: 100, readBurstSec: 3, writeBurstSec: 1, balanceRps: 1 },
  advanced: { readTok: 300, writeTok: 300, readBurstSec: 3, writeBurstSec: 3, balanceRps: 1 },
  expert: { readTok: 600, writeTok: 600, readBurstSec: 1, writeBurstSec: 3, balanceRps: 5 },
  premier: { readTok: 1200, writeTok: 1200, readBurstSec: 1, writeBurstSec: 3, balanceRps: 5 },
  paragon: { readTok: 2400, writeTok: 2400, readBurstSec: 1, writeBurstSec: 3, balanceRps: 5 },
  prime: { readTok: 4800, writeTok: 4800, readBurstSec: 1, writeBurstSec: 3, balanceRps: 5 },
  prestige: { readTok: 12000, writeTok: 9600, readBurstSec: 1, writeBurstSec: 3, balanceRps: 5 },
});

function readTier(env = process.env) {
  const raw = String((env && env.KALSHI_TIER) || 'advanced').trim().toLowerCase();
  return TIERS[raw] ? raw : 'advanced';
}

function readHeadroom(env = process.env) {
  const raw = env && env.KALSHI_LIMIT_HEADROOM;
  const n = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(n)) return 0.9;
  return Math.min(1, Math.max(0.5, n));
}

function readBalanceCacheMs(env = process.env) {
  const raw = env && env.KALSHI_BALANCE_CACHE_MS;
  const n = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(n) || n < 0) return 20_000;
  return n;
}

function pathOnly(signPath) {
  return String(signPath || '').split('?')[0];
}

function isBalancePath(signPath) {
  return /\/portfolio\/balance$/.test(pathOnly(signPath));
}

function isTransferPost(method, signPath) {
  return String(method || '').toUpperCase() === 'POST'
    && /\/intra_exchange_instance_transfer$/.test(pathOnly(signPath));
}

// Documented non-default costs. Anything else is the 10-token default.
function classify(method, signPath) {
  const m = String(method || 'GET').toUpperCase();
  const p = pathOnly(signPath);
  if (isBalancePath(p)) return { bucket: 'balance', cost: 1, priority: 0, label: 'balance' };
  if (m === 'POST' && /\/communications\/quotes$/.test(p)) return { bucket: 'write', cost: 2, priority: 2, label: 'quote_post' };
  if (m === 'PUT' && /\/confirm$/.test(p)) return { bucket: 'write', cost: 1, priority: 2, label: 'confirm' };
  if (m === 'PUT' && /\/accept$/.test(p)) return { bucket: 'write', cost: 2, priority: 2, label: 'accept' };
  if (m === 'DELETE' && /\/quotes\//.test(p)) return { bucket: 'write', cost: 2, priority: 1, label: 'quote_delete' };
  if (m === 'GET' && /\/communications\/quotes/.test(p)) return { bucket: 'read', cost: 2, priority: 1, label: 'quote_read' };
  if (m === 'GET' && /\/portfolio\/fills$/.test(p)) return { bucket: 'read', cost: DEFAULT_COST, priority: 1, label: 'fills' };
  if (m === 'GET' && /\/portfolio\/orders\//.test(p)) return { bucket: 'read', cost: DEFAULT_COST, priority: 1, label: 'order_read' };
  if (m === 'DELETE' && /\/portfolio\//.test(p)) return { bucket: 'write', cost: 2, priority: 1, label: 'order_delete' };
  if (m === 'GET' && /\/exchange\/status$/.test(p)) return { bucket: 'read', cost: DEFAULT_COST, priority: 0, label: 'warm' };
  if (m === 'GET') return { bucket: 'read', cost: DEFAULT_COST, priority: 0, label: 'read_other' };
  return { bucket: 'write', cost: DEFAULT_COST, priority: 1, label: 'write_other' };
}

function headerGet(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    const v = headers.get(name);
    return v == null || v === '' ? null : String(v);
  }
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === want) {
      const v = headers[k];
      return v == null || v === '' ? null : String(v);
    }
  }
  return null;
}

// Milliseconds to wait. null when the header is absent or not a delay.
function retryAfterMs(headers, nowMs) {
  const raw = headerGet(headers, 'retry-after');
  if (raw == null) return null;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - nowMs);
  return null;
}

function createTokenBucket({ refillPerSec, capacity, now }) {
  let tokens = capacity;
  let last = now();
  function refill() {
    const t = now();
    const dt = Math.max(0, (t - last) / 1000);
    last = t;
    tokens = Math.min(capacity, tokens + dt * refillPerSec);
  }
  return {
    tryTake(cost) {
      refill();
      if (tokens + 1e-9 >= cost) { tokens -= cost; return true; }
      // A cost larger than the whole bucket would deadlock. Allow it once
      // the bucket is full and go negative so the next caller waits.
      if (cost > capacity && tokens + 1e-6 >= capacity) { tokens -= cost; return true; }
      return false;
    },
    waitMs(cost) {
      refill();
      if (tokens + 1e-9 >= cost) return 0;
      const need = (cost > capacity ? capacity : cost) - tokens;
      if (!(refillPerSec > 0)) return 50;
      return Math.max(1, Math.ceil((Math.max(0, need) / refillPerSec) * 1000));
    },
    level() { refill(); return tokens; },
  };
}

function createIntervalGate({ perSec, now }) {
  const gap = 1000 / perSec;
  let next = now();
  return {
    tryTake() {
      const t = now();
      if (t + 0.001 < next) return false;
      next = t + gap;
      return true;
    },
    waitMs() { return Math.max(0, Math.ceil(next - now())); },
    level() { return now() + 0.001 < next ? 0 : 1; },
  };
}

function createKalshiAccountLimiter({
  env = process.env,
  tier = null,
  headroom = null,
  budgets = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
} = {}) {
  const tierName = tier || readTier(env);
  const spec = budgets || TIERS[tierName] || TIERS.advanced;
  const room = headroom == null ? readHeadroom(env) : Math.min(1, Math.max(0.5, Number(headroom) || 0.9));
  const readRefill = spec.readTok * room;
  const writeRefill = spec.writeTok * room;
  const readCap = Math.max(DEFAULT_COST, spec.readTok * spec.readBurstSec * room);
  const writeCap = Math.max(DEFAULT_COST, spec.writeTok * spec.writeBurstSec * room);
  const balanceRps = spec.balanceRps * room;
  const buckets = {
    read: createTokenBucket({ refillPerSec: readRefill, capacity: readCap, now }),
    write: createTokenBucket({ refillPerSec: writeRefill, capacity: writeCap, now }),
    balance: createIntervalGate({ perSec: balanceRps, now }),
  };
  const waiting = { read: [0, 0, 0], write: [0, 0, 0], balance: [0, 0, 0] };
  const backoffUntil = { read: 0, write: 0, balance: 0 };
  const penalty = { read: 0, write: 0, balance: 0 };
  const stats = {
    read: { ok: 0, taken: 0, r429: 0, waitedMs: 0, tokens: 0 },
    write: { ok: 0, taken: 0, r429: 0, waitedMs: 0, tokens: 0 },
    balance: { ok: 0, taken: 0, r429: 0, waitedMs: 0, tokens: 0, cacheHits: 0 },
    labels: {},
  };

  function higherWaiting(bucket, prio) {
    const w = waiting[bucket];
    for (let i = prio + 1; i < w.length; i += 1) if (w[i] > 0) return true;
    return false;
  }

  function bumpLabel(label) {
    stats.labels[label] = (stats.labels[label] || 0) + 1;
  }

  async function acquire(method, signPath, { priority = null } = {}) {
    const cls = classify(method, signPath);
    const prio = priority == null ? cls.priority : Math.max(0, Math.min(2, priority | 0));
    const name = cls.bucket;
    const gate = buckets[name];
    waiting[name][prio] += 1;
    try {
      for (;;) {
        const t = now();
        if (t < backoffUntil[name]) {
          const w = backoffUntil[name] - t;
          stats[name].waitedMs += w;
          await sleep(w);
          continue;
        }
        if (higherWaiting(name, prio)) {
          stats[name].waitedMs += 10;
          await sleep(10);
          continue;
        }
        const cost = name === 'balance' ? 1 : cls.cost;
        if (gate.tryTake(cost)) {
          stats[name].taken += 1;
          stats[name].tokens += cls.cost;
          bumpLabel(cls.label);
          return cls;
        }
        const w = Math.max(5, Math.min(250, gate.waitMs(cost)));
        stats[name].waitedMs += w;
        await sleep(w);
      }
    } finally {
      waiting[name][prio] -= 1;
    }
  }

  function note429(method, signPath, headers) {
    const name = classify(method, signPath).bucket;
    stats[name].r429 += 1;
    const ra = retryAfterMs(headers, now());
    let wait;
    if (ra != null) {
      // Never retry before Retry-After. A little extra jitter avoids a stampede.
      wait = ra + Math.round(ra * 0.25 * random());
    } else {
      const base = name === 'balance' ? 1000 : 100;
      const exp = Math.min(8000, penalty[name] ? penalty[name] * 2 : base);
      penalty[name] = exp;
      wait = Math.round(exp * (0.75 + random() * 0.5));
    }
    const until = now() + wait;
    if (until > backoffUntil[name]) backoffUntil[name] = until;
    return wait;
  }

  function noteOk(method, signPath) {
    const name = classify(method, signPath).bucket;
    stats[name].ok += 1;
    penalty[name] = 0;
  }

  function noteCacheHit() { stats.balance.cacheHits += 1; }

  function describe() {
    return `tier=${tierName} headroom=${room} read=${Math.round(readRefill)}tok/s cap=${Math.round(readCap)} ` +
      `write=${Math.round(writeRefill)}tok/s cap=${Math.round(writeCap)} balance=${balanceRps.toFixed(2)}/s`;
  }

  function rollStats() {
    const out = {
      tier: tierName,
      headroom: room,
      readTokPerSec: Math.round(readRefill),
      writeTokPerSec: Math.round(writeRefill),
      balancePerSec: Math.round(balanceRps * 100) / 100,
      read: { ...stats.read },
      write: { ...stats.write },
      balance: { ...stats.balance },
      labels: { ...stats.labels },
    };
    for (const k of ['read', 'write', 'balance']) {
      stats[k].ok = 0; stats[k].taken = 0; stats[k].r429 = 0; stats[k].waitedMs = 0; stats[k].tokens = 0;
    }
    stats.balance.cacheHits = 0;
    stats.labels = {};
    return out;
  }

  return {
    acquire, note429, noteOk, noteCacheHit, classify, describe, rollStats,
    tier: tierName, headroom: room, balanceRps, readRefill, writeRefill,
  };
}

function balanceShard(path) {
  const m = /(?:\?|&)exchange_index=(\d+)/.exec(String(path || ''));
  return m ? m[1] : 'none';
}

function createKalshiBalanceCache({ ttlMs = 20_000, now = () => Date.now() } = {}) {
  const rows = new Map();
  const inflight = new Map();

  function lookup(path) {
    if (!(ttlMs > 0)) return null;
    const row = rows.get(balanceShard(path));
    if (!row || row.stale) return null;
    if (now() - row.at >= ttlMs) return null;
    return { statusCode: 200, headers: {}, text: row.text };
  }

  function store(path, text) {
    if (!(ttlMs > 0) || text == null) return;
    rows.set(balanceShard(path), { text: String(text), at: now(), stale: false });
  }

  // Keep the last body so a failed refresh cannot invent a higher balance.
  // The next read misses and goes to the exchange.
  function markStale() {
    for (const row of rows.values()) row.stale = true;
  }

  function coalesce(path, fetcher) {
    const key = balanceShard(path);
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = Promise.resolve().then(fetcher).finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
    inflight.set(key, p);
    return p;
  }

  return { lookup, store, markStale, coalesce, shardOf: balanceShard, ttlMs };
}

module.exports = {
  TIERS,
  DEFAULT_COST,
  readTier,
  readHeadroom,
  readBalanceCacheMs,
  isBalancePath,
  isTransferPost,
  classify,
  retryAfterMs,
  createKalshiAccountLimiter,
  createKalshiBalanceCache,
  balanceShard,
};
