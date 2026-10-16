// No-boost quoter risk book. PURE state machine, no I/O. PAPER ONLY.
//
// Position model: we SELL the parlay at price y (collect y, owe $1 if every leg
// wins). For c contracts: max loss = c·(1−y), max gain = c·y. Exposure is
// measured in max-loss dollars so caps are "worst case if the combos hit".
//   per-combo cap   : maxComboLoss      ($ max loss of a single fill)
//   per-game cap    : maxGameLoss       (Σ max loss of open combos touching a game)
//   per-selection   : maxSelectionLoss  (Σ max loss over combos that need TEAM X to win;
//                                        the real concentration, same team in many parlays)
//   total cap       : maxTotalLoss
//   daily loss limit: dailyLossLimit    (optional; realized+settled P&L ≤ −limit ⇒ halt)
//   inventory skew  : util() ∈ [0,1] = max(game, selection, total utilisation);
//                     the pricer widens margin by (1 + skew·util).
//   quote pull      : open paper quotes are re-priced on every price tick; pulled
//                     when edge vs the NEW fair < pullMinEdge, or the lock
//                     guardrail is breached, or the quote is older than ttlMs.
//                     A quote evicted by the maxOpenQuotes cap is reported as pulled
//                     (reason 'evicted'), never dropped silently.
'use strict';

const RISK_DEFAULTS = Object.freeze({
  maxComboLoss: 250,
  maxGameLoss: 1000,
  maxSelectionLoss: 750,
  maxTotalLoss: 5000,
  dailyLossLimit: 0, // 0 = off
  pullMinEdge: 0.03,
  ttlMs: 20000,
  maxOpenQuotes: 200,
});

function num(raw, fb, lo = 0, hi = Infinity) {
  if (raw == null || String(raw).trim() === '') return fb;
  const n = Number(raw);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fb;
}

function riskConfigFromEnv(env = process.env) {
  const e = env || {};
  return {
    maxComboLoss: num(e.NOBOOST_MAX_COMBO_LOSS, RISK_DEFAULTS.maxComboLoss),
    maxGameLoss: num(e.NOBOOST_MAX_GAME_LOSS, RISK_DEFAULTS.maxGameLoss),
    maxSelectionLoss: num(e.NOBOOST_MAX_SELECTION_LOSS, RISK_DEFAULTS.maxSelectionLoss),
    maxTotalLoss: num(e.NOBOOST_MAX_TOTAL_LOSS, RISK_DEFAULTS.maxTotalLoss),
    dailyLossLimit: num(e.NOBOOST_DAILY_LOSS_LIMIT, RISK_DEFAULTS.dailyLossLimit),
    pullMinEdge: num(e.NOBOOST_PULL_MIN_EDGE, RISK_DEFAULTS.pullMinEdge, -1, 5),
    ttlMs: num(e.NOBOOST_QUOTE_TTL_MS, RISK_DEFAULTS.ttlMs, 1000, 600000),
    maxOpenQuotes: Math.floor(num(e.NOBOOST_MAX_OPEN_QUOTES, RISK_DEFAULTS.maxOpenQuotes, 1, 5000)),
  };
}

function dayKey(ms) {
  // America/New_York trading day
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
}

// leg descriptor the book needs: { gameId, selection }
function createRiskBook(cfgIn = {}, { now = () => Date.now() } = {}) {
  const cfg = { ...RISK_DEFAULTS, ...cfgIn };
  const open = new Map(); // fillId -> { loss, gain, contracts, price, games[], sels[], day, ts }
  const gameLoss = new Map();
  const selLoss = new Map();
  let totalLoss = 0;
  let dayPnl = { day: dayKey(now()), pnl: 0 };
  const quotes = new Map(); // rfqId -> live paper quote

  function bump(map, key, d) {
    const v = (map.get(key) || 0) + d;
    if (v <= 1e-9) map.delete(key); else map.set(key, v);
  }
  function rollDay() {
    const d = dayKey(now());
    if (d !== dayPnl.day) dayPnl = { day: d, pnl: 0 };
  }

  function maxLoss(price, contracts) { return Math.max(0, contracts * (1 - price)); }

  function utilization(legs, extraLoss = 0) {
    let u = (totalLoss + extraLoss) / cfg.maxTotalLoss;
    for (const l of legs || []) {
      u = Math.max(u, ((gameLoss.get(l.gameId) || 0) + extraLoss) / cfg.maxGameLoss);
      u = Math.max(u, ((selLoss.get(`${l.gameId}:${(l.selection || l.team)}`) || 0) + extraLoss) / cfg.maxSelectionLoss);
    }
    return Math.max(0, Math.min(1, u));
  }

  function dailyHalted() {
    rollDay();
    return cfg.dailyLossLimit > 0 && dayPnl.pnl <= -cfg.dailyLossLimit;
  }

  // Check whether a prospective fill of `contracts` at `price` fits every cap.
  // Venues fill the FULL RFQ size (no partial quotes), so this is all-or-nothing.
  function check(legs, price, contracts) {
    if (dailyHalted()) return { ok: false, reason: 'daily_loss_limit' };
    const loss = maxLoss(price, contracts);
    if (!(loss > 0)) return { ok: false, reason: 'zero_size' };
    if (loss > cfg.maxComboLoss + 1e-9) return { ok: false, reason: 'combo_cap', loss };
    if (totalLoss + loss > cfg.maxTotalLoss + 1e-9) return { ok: false, reason: 'total_cap', loss };
    for (const l of legs || []) {
      if ((gameLoss.get(l.gameId) || 0) + loss > cfg.maxGameLoss + 1e-9) {
        return { ok: false, reason: 'game_cap', game: l.gameId, loss };
      }
      if ((selLoss.get(`${l.gameId}:${(l.selection || l.team)}`) || 0) + loss > cfg.maxSelectionLoss + 1e-9) {
        return { ok: false, reason: 'selection_cap', game: l.gameId, selection: l.selection, loss };
      }
    }
    return { ok: true, loss };
  }

  function addFill(id, legs, price, contracts) {
    if (open.has(id)) return false;
    const loss = maxLoss(price, contracts);
    const games = [...new Set((legs || []).map((l) => l.gameId))];
    const sels = (legs || []).map((l) => `${l.gameId}:${(l.selection || l.team)}`);
    open.set(id, { loss, gain: contracts * price, contracts, price, games, sels, ts: now() });
    totalLoss += loss;
    for (const g of games) bump(gameLoss, g, loss);
    for (const s of sels) bump(selLoss, s, loss);
    return true;
  }

  // hit=true → combo paid $1/contract (we lose), false → we keep premium.
  // push=true (every leg voided) → stake refunded, P&L 0; exposure released either way.
  function settle(id, hit, { push = false } = {}) {
    const f = open.get(id);
    if (!f) return null;
    open.delete(id);
    totalLoss -= f.loss;
    for (const g of f.games) bump(gameLoss, g, -f.loss);
    for (const s of f.sels) bump(selLoss, s, -f.loss);
    if (totalLoss < 1e-9) totalLoss = 0;
    const pnl = push ? 0 : (hit ? f.gain - f.contracts : f.gain);
    rollDay();
    dayPnl.pnl += pnl;
    return pnl;
  }

  // ── paper quotes (fast pull) ───────────────────────────────────────────
  // Quotes removed outside a sweep (TTL expiry found at register time, cap eviction) are
  // queued here and handed out by the next sweepQuotes() so the caller marks them PULLED
  // (with the exact time they stopped being live) instead of losing them silently.
  const pendingPulls = [];
  let evictions = 0;
  function expireQuotes(t) {
    for (const [id, q] of quotes) {
      if (t - q.at > cfg.ttlMs) { quotes.delete(id); pendingPulls.push({ rfqId: id, reason: 'ttl', quote: q, at: q.at + cfg.ttlMs }); }
    }
  }
  // Returns the quotes evicted to make room ([] normally).
  function registerQuote(rfqId, q) {
    const t = now();
    const evicted = [];
    if (quotes.size >= cfg.maxOpenQuotes) expireQuotes(t); // first drop anything already past its lifetime
    while (quotes.size >= cfg.maxOpenQuotes) {
      const [oldest, oq] = quotes.entries().next().value;
      quotes.delete(oldest);
      const p = { rfqId: oldest, reason: 'evicted', quote: oq, at: t };
      pendingPulls.push(p); evicted.push(p); evictions += 1;
    }
    quotes.set(rfqId, { ...q, rfqId, at: t, expiresAt: t + cfg.ttlMs });
    return evicted;
  }
  function dropQuote(rfqId) { return quotes.delete(rfqId); }
  function getQuote(rfqId) { return quotes.get(rfqId) || null; }

  // reprice(q) -> { fair, yLock } with CURRENT prices, or null if unpriceable.
  // Returns [{rfqId, reason, at, ...}] for quotes that must be pulled (at = when the quote stopped being live).
  function sweepQuotes(reprice) {
    const pulled = pendingPulls.splice(0, pendingPulls.length);
    const t = now();
    for (const [id, q] of [...quotes]) {
      let reason = null;
      let detail = {};
      if (t - q.at > cfg.ttlMs) { reason = 'ttl'; detail = { at: q.at + cfg.ttlMs }; }
      else {
        const cur = reprice(q);
        if (!cur || cur.fair == null) reason = 'unpriceable';
        else {
          const edge = q.quoteYes / cur.fair - 1;
          detail = { edge, fair: cur.fair, basisFair: q.fair };
          if (edge < cfg.pullMinEdge) reason = 'edge_gone';
          else if (q.guardrail && cur.yLock != null && q.quoteYes < cur.yLock - 1e-9) reason = 'below_lock';
        }
      }
      if (reason) { quotes.delete(id); pulled.push({ rfqId: id, reason, quote: q, at: t, ...detail }); }
    }
    return pulled;
  }

  function snapshot() {
    rollDay();
    return {
      totalLoss, openFills: open.size, openQuotes: quotes.size, evictions,
      dayPnl: dayPnl.pnl, halted: dailyHalted(),
      topGame: [...gameLoss].sort((a, b) => b[1] - a[1]).slice(0, 3),
      topSelection: [...selLoss].sort((a, b) => b[1] - a[1]).slice(0, 3),
    };
  }

  return {
    cfg, check, addFill, settle, utilization, dailyHalted,
    registerQuote, dropQuote, getQuote, sweepQuotes, snapshot,
    _open: open, _gameLoss: gameLoss, _selLoss: selLoss, _quotes: quotes,
    total: () => totalLoss,
  };
}

module.exports = { RISK_DEFAULTS, riskConfigFromEnv, createRiskBook, dayKey };
