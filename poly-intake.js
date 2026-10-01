'use strict';
// ─────────────────────────────────────────────────────────────────────────
// poly-intake.js — Polymarket US RFQ intake coverage + observability.
//
// Problem: the 3s REST reconcile only reads the first page (100) of ~6,000
// open RFQs, and nothing recorded how many RFQs the Poly path actually sees.
//
//  • createPolyIntakeStats()  per-interval counters (seen / ws / rest /
//    rest_only / per-skip-reason / candidates / matched / quoted …).
//  • crawlOpenRfqs()          best-effort cursor pagination with a polite
//    inter-page delay + page cap. Polymarket's edge (Cloudflare) sometimes
//    answers 403 for a deep cursor; that is treated as a TRUNCATED crawl
//    (rows already collected are kept), never retried in a loop.
//  • createWsSeenSet()        bounded set of RFQ ids delivered by the WS, so
//    the REST crawl only has to do real work for RFQs the stream missed.
//  • prioritizeRfqs()         lock-candidate RFQs first.
//
// Observability / read-only: nothing here posts, cancels or sizes a quote.
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_CRAWL_MS = 30000;
const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_PAGE_DELAY_MS = 250; // ≈4 req/s, well under the documented 10 req/s
const DEFAULT_HEARTBEAT_MS = 60000;
const WS_SEEN_MAX = 30000;
const MAX_REASON_KEYS = 64;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const yieldLoop = () => new Promise((r) => setImmediate(r));

function envInt(name, def, env = process.env) {
  const raw = env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function emptyInterval() {
  return {
    seen: 0,          // every RFQ handed to handleRfq
    ws: 0,            // …delivered by the WS stream
    rest: 0,          // …delivered by REST (fast poll + crawl)
    rest_only: 0,     // crawl rows the WS had not delivered
    rest_dup: 0,      // crawl rows already delivered by WS (skipped)
    crawl_runs: 0,
    crawl_pages: 0,
    crawl_rows: 0,
    crawl_truncated: 0,
    crawl_ms: 0,
    open_max: 0,      // largest open-RFQ snapshot seen by a crawl
    candidates: 0,    // passed the lock-overlap prefilter
    matched: 0,       // matched an active lock (reached evaluation)
    quoted: 0,
    would_quote: 0,
    declined: 0,      // candidate that evaluated to a skip
    reasons: {},      // per-skip-reason counts
  };
}

function createPolyIntakeStats({ now = () => Date.now() } = {}) {
  let cur = emptyInterval();
  let startedAt = now();
  let last = null;
  const total = emptyInterval();

  function addReason(obj, reason) {
    const k = reason || 'unknown';
    if (!(k in obj) && Object.keys(obj).length >= MAX_REASON_KEYS) {
      obj.other = (obj.other || 0) + 1;
      return;
    }
    obj[k] = (obj[k] || 0) + 1;
  }

  function bump(key, n = 1) {
    cur[key] = (cur[key] || 0) + n;
    total[key] = (total[key] || 0) + n;
  }

  function addBoth(reason) {
    addReason(cur.reasons, reason);
    addReason(total.reasons, reason);
  }

  // out = handleRfq() result, src = 'ws' | 'rest' | other
  function recordOutcome(out, src) {
    bump('seen');
    if (src === 'ws') bump('ws');
    else if (src === 'rest') bump('rest');
    const reason = (out && out.reason) || (out && out.action) || 'unknown';
    if (out && out.post) {
      bump('candidates');
      bump('matched');
      bump('quoted');
      addBoth('quoted');
      return;
    }
    if (reason === 'no_lock_overlap' || reason === 'no_locks' || reason === 'bad_rfq') {
      addBoth(reason);
      if (reason === 'no_lock_overlap' && out.overlap && out.overlap.code) {
        addBoth(`overlap:${out.overlap.code}`);
      }
      return;
    }
    if (reason === 'seen') { addBoth('seen'); return; }
    // reached lock evaluation (same-game / leg-count candidate)
    bump('candidates');
    if (out && out.parlay) bump('matched');
    if (out && out.action === 'quoteable' && !out.error) bump('would_quote');
    else bump('declined');
    addBoth(reason);
  }

  // Bulk, cheap accounting for crawled RFQs that cannot touch any lock
  // (never run through handleRfq). They still count as seen + a reason.
  function noteBulkNoOverlap(n) {
    if (!(n > 0)) return;
    bump('seen', n);
    bump('rest', n);
    bump('rest_only', n);
    for (const k of ['no_lock_overlap', 'overlap:no_shared_game']) {
      cur.reasons[k] = (cur.reasons[k] || 0) + n;
      total.reasons[k] = (total.reasons[k] || 0) + n;
    }
  }

  function recordCrawl(res, ms) {
    bump('crawl_runs');
    bump('crawl_pages', res.pages || 0);
    bump('crawl_rows', (res.rows || []).length);
    bump('crawl_ms', ms || 0);
    if (res.truncated) bump('crawl_truncated');
    const n = (res.rows || []).length;
    if (n > cur.open_max) cur.open_max = n;
    if (n > total.open_max) total.open_max = n;
  }

  // Close the interval: returns the finished snapshot and starts a new one.
  function rollInterval() {
    const t = now();
    const snap = { ...cur, reasons: { ...cur.reasons }, interval_s: Math.round((t - startedAt) / 1000) };
    last = snap;
    cur = emptyInterval();
    startedAt = t;
    return snap;
  }

  return {
    bump,
    recordOutcome,
    noteBulkNoOverlap,
    recordCrawl,
    rollInterval,
    peek: () => ({ ...cur, reasons: { ...cur.reasons } }),
    lastInterval: () => last,
    totals: () => ({ ...total, reasons: { ...total.reasons } }),
  };
}

function formatPolyHeartbeat(snap) {
  const s = snap || emptyInterval();
  const reasons = Object.entries(s.reasons || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([k, n]) => `${k}=${n}`)
    .join(',');
  return (
    `[POLY] heartbeat interval=${s.interval_s != null ? s.interval_s : '?'}s ` +
    `seen=${s.seen} ws=${s.ws} rest=${s.rest} rest_only=${s.rest_only} ` +
    `crawl_runs=${s.crawl_runs} crawl_pages=${s.crawl_pages} crawl_rows=${s.crawl_rows} ` +
    `crawl_truncated=${s.crawl_truncated} open_max=${s.open_max} ` +
    `candidates=${s.candidates} matched=${s.matched} quoted=${s.quoted} ` +
    `would_quote=${s.would_quote} declined=${s.declined}` +
    (reasons ? ` reasons=${reasons}` : '')
  );
}

// Bounded insertion-ordered id set (Map keeps order; evict oldest).
function createWsSeenSet(max = WS_SEEN_MAX) {
  const m = new Map();
  return {
    add(id) {
      if (!id) return;
      if (m.has(id)) m.delete(id);
      m.set(id, 1);
      while (m.size > max) m.delete(m.keys().next().value);
    },
    has: (id) => m.has(id),
    delete: (id) => m.delete(id),
    get size() { return m.size; },
  };
}

function isForbidden(err) {
  return !!err && (err.statusCode === 403 || /\b403\b/.test(String(err.message || '')));
}

// Best-effort cursor crawl of all open RFQs. Never throws for a mid-crawl
// failure once at least one page was read: returns { truncated:true, error }.
// If page 1 fails the error is rethrown so the caller's auth logging runs.
async function crawlOpenRfqs(http, {
  limit = DEFAULT_PAGE_LIMIT,
  maxPages = DEFAULT_MAX_PAGES,
  pageDelayMs = DEFAULT_PAGE_DELAY_MS,
  sleep = sleepMs,
  isStopped = () => false,
  firstPage = null,
} = {}) {
  const rows = [];
  const seenIds = new Set();
  let cursor;
  let pages = 0;
  let truncated = false;
  let error = null;
  let pending = firstPage;
  for (;;) {
    if (isStopped()) { truncated = true; break; }
    let listed;
    try {
      if (pending) { listed = pending; pending = null; }
      else {
        const q = { status: 'RFQ_STATUS_OPEN', limit };
        if (cursor) q.cursor = cursor;
        listed = await http.listRfqs(q);
      }
    } catch (e) {
      if (pages === 0) throw e;
      truncated = true;
      error = { statusCode: e && e.statusCode, forbidden: isForbidden(e), message: String((e && e.message) || e).slice(0, 120) };
      break;
    }
    pages += 1;
    const page = (listed && listed.rfqs) || [];
    for (const r of page) {
      const id = r && (r.id || r.rfqId || (r.rfq && r.rfq.id));
      if (id) { if (seenIds.has(id)) continue; seenIds.add(id); }
      rows.push(r);
    }
    const next = listed && listed.cursor;
    if (!page.length || !next || next === cursor) break;
    if (pages >= maxPages) { truncated = true; break; }
    cursor = next;
    if (pageDelayMs > 0) await sleep(pageDelayMs);
  }
  return { rows, pages, truncated, error };
}

// Candidates first; otherwise stable. `classify(row)` returns 2 (exact lock
// candidate), 1 (shares a game / near miss) or 0 (noise) and must be cheap and
// side-effect free. Yields to the event loop every `batch` rows so classifying
// thousands of RFQs never starves the Kalshi WS.
async function prioritizeRfqs(rows, classify, { batch = 100, yieldFn = yieldLoop } = {}) {
  const exact = [];
  const near = [];
  const noise = [];
  let n = 0;
  for (const r of rows || []) {
    const c = classify(r);
    (c >= 2 ? exact : c === 1 ? near : noise).push(r);
    if (++n % batch === 0) await yieldFn();
  }
  return { exact, near, noise };
}

module.exports = {
  DEFAULT_CRAWL_MS,
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_DELAY_MS,
  DEFAULT_HEARTBEAT_MS,
  WS_SEEN_MAX,
  envInt,
  yieldLoop,
  createPolyIntakeStats,
  createWsSeenSet,
  formatPolyHeartbeat,
  crawlOpenRfqs,
  prioritizeRfqs,
  isForbidden,
};
