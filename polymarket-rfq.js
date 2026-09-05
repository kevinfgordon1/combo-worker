// Polymarket US Retail combo RFQ quoting loop.
//
// Maker only: subscribe / poll open RFQs, map comboLegs onto matchParlay,
// price from Combo Locks fill odds, share remaining with Kalshi via reserve.js.
// Production RFQs are game slugs; SIDE_SELL is the second team (TEX on tb-tex).
// Like Kalshi, only RFQs that could match the current parlays() snapshot
// hydrate extra HTTP, fetch market metadata, quote, or write verbose skip logs.
// Unmatched firehose RFQs are a cheap no-op — no seenRfqs / market-cache growth.
// Reconcile always prints a reason histogram. Near-miss no_lock_overlap
// (same games, wrong side / leg count) logs SKIP with a reason code.
// Live POSTs (create quote, confirm) require POLYMARKET_RFQ_LIVE to be truthy.
// quoteExecuted means paired orders were submitted — not a fill.
// START GATE: never quote or confirm once any lock leg has started (first pitch
// / kickoff <= now). Resting quotes for that lock are DELETE'd the same way
// Kalshi cancelStartedQuotes works. Date-only Polymarket slugs are not starts —
// findStartedEvent still uses combo_parlays.starts_at, per-leg start fields,
// and Kalshi ticker HHMM in leg_keys.
'use strict';
const { matchParlay } = require('./rfq');
const { decideAtFill } = require('./engine');
const { findStartedEvent } = require('./started');
const {
  RESERVE_TTL_MS,
  sumOutstanding,
  wouldExceedCap,
  dropPendingForRfq,
  listStaleUnaccepted,
  isReserveKey,
} = require('./reserve');
const {
  buildPolymarketQuote,
  shouldPostPolymarketQuote,
  shouldConfirmPolymarketAccept,
} = require('./polymarket-quote');
const { isPolymarketRfqLive } = require('./polymarket-auth');
const { createPolymarketHttp, createPolymarketRfqWs } = require('./polymarket-client');
const { createMarketCache } = require('./polymarket-market-cache');
const {
  identitiesFromParlay,
  identitiesFromPolymarketLegs,
  identitiesFromPolymarketSlugs,
  sameIdentitySet,
  TEAM_ALIASES,
  SERIES,
} = require('./leg-identity');
const {
  isUnhedgedRfqShadow,
  isUnhedgedRfqLive,
  isUnhedgedFillStatus,
  persistUnhedgedRfq,
  shadowUnhedgedMiss,
  createUnhedgedFillTracker,
} = require('./unhedged-rfq');

const MODE = 'POLY';
const RECONCILE_MS = 3000;
const SEEN_RFQS_MAX = 256;

const LEAGUE_SLUG_TOKENS = {
  mlb: ['mlb', 'baseball'],
  nfl: ['nfl', 'football', 'ncaaf', 'cfb'],
  nba: ['nba', 'basketball'],
  nhl: ['nhl', 'hockey'],
  ncaaf: ['ncaaf', 'cfb', 'football'],
};

function normalizePolymarketSide(side) {
  const raw = String(side == null ? '' : side).trim().toLowerCase();
  const s = raw.replace(/^side_/, '');
  if (s === 'buy' || s === 'yes' || s === 'long') return 'yes';
  if (s === 'sell' || s === 'no' || s === 'short') return 'no';
  return null;
}

function polymarketLegSymbol(leg) {
  if (leg == null) return '';
  if (typeof leg === 'string') return leg.trim();
  return String(
    leg.symbol || leg.slug || leg.market_slug || leg.polymarket_symbol || ''
  ).trim();
}

function polymarketLegKey(leg) {
  const symbol = polymarketLegSymbol(leg);
  if (!symbol) return null;
  const rawSide = (leg && typeof leg === 'object') ? (leg.side || 'SIDE_BUY') : 'SIDE_BUY';
  const side = normalizePolymarketSide(rawSide);
  if (!side) return null;
  return `${symbol.toUpperCase()}:${side}`;
}

function mapComboLegs(comboLegs) {
  if (!Array.isArray(comboLegs) || !comboLegs.length) {
    return { ok: false, reason: 'no_legs', legKeys: [], skipped: [] };
  }
  const legKeys = [];
  const skipped = [];
  for (const leg of comboLegs) {
    const key = polymarketLegKey(leg);
    if (!key) {
      skipped.push(leg);
      continue;
    }
    legKeys.push(key);
  }
  if (skipped.length) {
    return { ok: false, reason: 'unmatched_leg', legKeys, skipped };
  }
  if (legKeys.length < 2) {
    return { ok: false, reason: 'not_combo', legKeys, skipped };
  }
  return { ok: true, reason: null, legKeys: [...legKeys].sort(), skipped };
}

function normalizePolymarketRfq(raw) {
  const r = raw && raw.rfq && typeof raw.rfq === 'object' ? raw.rfq : raw;
  if (!r || typeof r !== 'object') return null;
  const legs = r.comboLegs || r.combo_legs || r.legs || null;
  const mapped = mapComboLegs(legs);
  return {
    rfqId: r.id || r.rfqId || r.rfq_id || null,
    symbol: r.symbol || null,
    status: r.status || null,
    qtyDecimal: r.qtyDecimal != null ? r.qtyDecimal : r.qty_decimal,
    cashOrderQty: r.cashOrderQty != null ? r.cashOrderQty : r.cash_order_qty,
    comboLegs: legs,
    legs,
    legKeys: mapped.legKeys,
    isCombo: mapped.ok,
    map: mapped,
    createdTime: r.createdTime || r.created_time || null,
    restRemainder: r.restRemainder === true || r.rest_remainder === true,
  };
}

function upperKeys(arr) {
  return (arr || []).map((k) => {
    const s = String(k);
    const i = s.lastIndexOf(':');
    if (i === -1) return s.toUpperCase();
    return `${s.slice(0, i).toUpperCase()}:${s.slice(i + 1).toLowerCase()}`;
  });
}

function splitLegKey(key) {
  const s = String(key || '');
  const i = s.lastIndexOf(':');
  if (i === -1) return { symbol: s, side: '' };
  return { symbol: s.slice(0, i), side: s.slice(i + 1).toLowerCase() };
}

function slugTokens(symbol) {
  const s = String(symbol || '').toLowerCase();
  const tokens = new Set();
  for (const p of s.split(/[-_./]/)) {
    if (p) tokens.add(p);
  }
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) tokens.add(`${m[1]}-${m[2]}-${m[3]}`);
  return tokens;
}

function rfqSlugTokenSet(rfq) {
  const tokens = new Set();
  const legs = (rfq && (rfq.comboLegs || rfq.legs)) || [];
  for (const leg of legs) {
    const sym = polymarketLegSymbol(leg);
    if (!sym) continue;
    for (const t of slugTokens(sym)) tokens.add(t);
  }
  for (const key of (rfq && rfq.legKeys) || []) {
    const { symbol } = splitLegKey(key);
    if (!symbol) continue;
    for (const t of slugTokens(symbol)) tokens.add(t);
  }
  return tokens;
}

function tokensHaveDate(tokens, date) {
  if (!date) return false;
  const d = String(date);
  if (tokens.has(d)) return true;
  const parts = d.split('-');
  if (parts.length === 3 && parts.every((p) => tokens.has(p))) return true;
  if (parts.length === 3 && tokens.has(parts.join(''))) return true;
  return false;
}

function teamInTokens(league, team, tokens) {
  const raw = String(team || '').toLowerCase();
  if (!raw) return false;
  if (tokens.has(raw)) return true;
  const aliases = TEAM_ALIASES[league] || {};
  for (const [from, to] of Object.entries(aliases)) {
    if (to === raw && tokens.has(from)) return true;
    if (from === raw && tokens.has(to)) return true;
  }
  return false;
}

function identityHitsTokens(id, tokens) {
  if (!id) return false;
  // Combo Locks only price full-game ML (`aec`). Player-prop prefixes
  // (astatc, …) share league/date tokens and emit 2-char stat suffixes
  // (`tb` = total bases) that collide with team codes (TB Rays).
  if (!tokens.has('aec')) return false;
  const leagueTokens = LEAGUE_SLUG_TOKENS[id.league] || (id.league ? [id.league] : []);
  if (!leagueTokens.some((t) => tokens.has(t))) return false;
  if (!tokensHaveDate(tokens, id.date)) return false;
  const teams = (id.teams || []).filter(Boolean);
  // Both clubs, not selection-only / one-token overlap. Prop `-tb-` must
  // not count as a Rays game unless the opponent is also in the slugs.
  if (teams.length < 2) return false;
  return teams.every((team) => teamInTokens(id.league, team, tokens));
}

function cheapDirectMatch(rfq, parlays) {
  if (!rfq || !rfq.legKeys || !rfq.legKeys.length || !Array.isArray(parlays)) return null;
  const asRfq = { ...rfq, legKeys: upperKeys(rfq.legKeys) };
  const withUpper = parlays.map((p) => {
    const lk = upperKeys(p.leg_keys || p.legKeys);
    return { ...p, leg_keys: lk, legKeys: lk };
  });
  const direct = matchParlay(asRfq, withUpper);
  if (direct) return parlays.find((x) => x.id === direct.id) || direct;

  const rewritten = [];
  for (const p of parlays) {
    const keys = [];
    for (const leg of p.legs || []) {
      const key = polymarketLegKey(leg);
      if (key) keys.push(key);
    }
    if (keys.length) rewritten.push({ ...p, leg_keys: keys, legKeys: keys });
  }
  if (!rewritten.length) return null;
  const viaLegs = matchParlay(asRfq, rewritten);
  if (!viaLegs) return null;
  return parlays.find((x) => x.id === viaLegs.id) || viaLegs;
}

function kalshiMlTickersFromParlay(parlay) {
  const out = [];
  const keys = parlay && (parlay.leg_keys || parlay.legKeys);
  if (Array.isArray(keys)) {
    for (const k of keys) {
      if (k != null && k !== '') out.push(String(k));
    }
  }
  if (parlay && Array.isArray(parlay.legs)) {
    for (const leg of parlay.legs) {
      if (typeof leg === 'string') out.push(leg);
      else if (leg && typeof leg === 'object') {
        const t = leg.ticker || leg.market_ticker || leg.event_ticker;
        if (t) out.push(String(t));
      }
    }
  }
  return out;
}

function isKalshiMoneylineLock(parlay) {
  return kalshiMlTickersFromParlay(parlay).some((text) => {
    const raw = String(text).trim();
    const series = raw.split('-')[0].split(':')[0].toUpperCase();
    return Boolean(SERIES[series]);
  });
}

// Active Kalshi ML locks that identitiesFromParlay cannot read (e.g. a
// previously unknown team blob) are otherwise a silent no_lock_overlap.
// Log once per reconcile — not per firehose RFQ — so silence is diagnosable.
function logActiveLockIdentityFails(parlays, log = console.log) {
  if (!Array.isArray(parlays) || !parlays.length) return 0;
  let n = 0;
  for (const p of parlays) {
    if (!isKalshiMoneylineLock(p)) continue;
    const lock = identitiesFromParlay(p);
    if (lock.ok) continue;
    const label = (p && (p.label || p.id)) || '?';
    log(`[${MODE}] lock-identity-fail label=${label}`);
    n += 1;
  }
  return n;
}

const NEAR_MISS_CODES = new Set(['leg_count', 'missing_team', 'same_games_no_match']);

function explainLockOverlapMiss(rfq, parlays) {
  const tokens = rfqSlugTokenSet(rfq);
  const keys = (rfq && rfq.legKeys) || [];
  if (!tokens.size && !keys.length) return { code: 'no_rfq_tokens' };

  const slugIds = identitiesFromPolymarketSlugs((rfq && (rfq.comboLegs || rfq.legs)) || []);

  for (const p of parlays || []) {
    const lock = identitiesFromParlay(p);
    if (!lock.ok || !lock.identities.length) continue;
    const label = (p && (p.label || p.id)) || '?';
    const shared = lock.identities.filter((id) => {
      const leagueTokens = LEAGUE_SLUG_TOKENS[id.league] || (id.league ? [id.league] : []);
      return leagueTokens.some((t) => tokens.has(t)) && tokensHaveDate(tokens, id.date);
    });
    if (!shared.length) continue;

    if (keys.length && keys.length !== lock.identities.length) {
      return {
        code: 'leg_count',
        lock: label,
        detail: `rfqLegs=${keys.length} lockLegs=${lock.identities.length}`,
      };
    }

    const missTeam = lock.identities.filter((id) => (
      !id.teams.every((team) => teamInTokens(id.league, team, tokens))
    ));
    if (missTeam.length && shared.length < lock.identities.length) {
      return {
        code: 'missing_team',
        lock: label,
        detail: `miss=${missTeam.map((id) => (id.teams || []).join('+')).join(',')}`,
      };
    }

    if (slugIds.ok && !sameIdentitySet(slugIds.keys, lock.keys)) {
      return {
        code: 'same_games_no_match',
        lock: label,
        detail: `rfq=${slugIds.keys.join(',')} lock=${lock.keys.join(',')}`,
      };
    }

    return { code: 'same_games_no_match', lock: label };
  }
  return { code: 'no_shared_game' };
}

function logUnpriceablePolyLocks(parlays, log = console.log) {
  if (!Array.isArray(parlays) || !parlays.length) return 0;
  let n = 0;
  for (const p of parlays) {
    const lock = identitiesFromParlay(p);
    if (lock.ok) continue;
    const tickers = kalshiMlTickersFromParlay(p);
    const series = tickers.map((t) => String(t).split('-')[0].split(':')[0].toUpperCase());
    if (!series.some((s) => /SPREAD|TOTAL|PROP/.test(s))) continue;
    const label = (p && (p.label || p.id)) || '?';
    log(`[${MODE}] lock-unpriceable-on-poly reason=not_moneyline label=${label}`);
    n += 1;
  }
  return n;
}

function tallyReason(reasons, key) {
  const k = key || 'unknown';
  reasons[k] = (reasons[k] || 0) + 1;
}

function formatReasonTally(reasons) {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
}

// Cheap over-approximation of evaluate/match: no HTTP, no metadata.
// True = this RFQ could be one of the current Combo Locks (exact PM keys,
// slug-derived identities including game-slug SELL = second team, or slug
// tokens covering each lock identity). False = firehose no-op.
// Do not compare raw BUY/SELL lists to Kalshi :yes — production game slugs
// express the short team as SIDE_SELL.
function couldMatchActiveLocks(rfq, parlays, { partial = false } = {}) {
  if (!rfq || !Array.isArray(parlays) || !parlays.length) return false;
  const keys = rfq.legKeys || [];
  if (!keys.length && !partial) return false;
  if (keys.length && cheapDirectMatch(rfq, parlays)) return true;

  const tokens = rfqSlugTokenSet(rfq);
  if (!tokens.size) return false;
  const slugIds = identitiesFromPolymarketSlugs(rfq.comboLegs || rfq.legs);

  for (const p of parlays) {
    const lock = identitiesFromParlay(p);
    if (!lock.ok || !lock.identities.length) continue;
    if (!partial && keys.length && keys.length !== lock.identities.length) continue;
    if (!partial && slugIds.ok && sameIdentitySet(slugIds.keys, lock.keys)) return true;
    const hits = partial
      ? lock.identities.some((id) => identityHitsTokens(id, tokens))
      : lock.identities.every((id) => identityHitsTokens(id, tokens));
    if (!hits) continue;
    if (!partial && slugIds.ok && !sameIdentitySet(slugIds.keys, lock.keys)) continue;
    return true;
  }
  return false;
}

function needsHydrate(rfq, parlays) {
  if (!rfq || (rfq.map && rfq.map.ok)) return false;
  if (!Array.isArray(parlays) || !parlays.length) return false;
  const keys = rfq.legKeys || [];
  if (!keys.length) return true;
  return couldMatchActiveLocks(rfq, parlays, { partial: true });
}

function matchPolymarketParlayDetailed(rfq, parlays, opts = {}) {
  if (!rfq || !Array.isArray(parlays)) {
    return { parlay: null, reason: 'unmatched', identityKeys: [] };
  }
  const direct = cheapDirectMatch(rfq, parlays);
  if (direct) {
    return { parlay: direct, reason: null, identityKeys: [] };
  }

  const pm = identitiesFromPolymarketLegs(rfq.comboLegs || rfq.legs, opts.markets);
  if (!pm.ok) {
    return { parlay: null, reason: pm.reason || 'unmatched', identityKeys: pm.keys || [] };
  }

  const hits = [];
  for (const p of parlays) {
    const lock = identitiesFromParlay(p);
    if (!lock.ok) continue;
    if (sameIdentitySet(pm.keys, lock.keys)) hits.push(p);
  }
  if (hits.length === 1) {
    return { parlay: hits[0], reason: null, identityKeys: pm.keys };
  }
  if (hits.length > 1) {
    return { parlay: null, reason: 'ambiguous', identityKeys: pm.keys };
  }
  return { parlay: null, reason: 'unmatched', identityKeys: pm.keys };
}

function matchPolymarketParlay(rfq, parlays, opts) {
  return matchPolymarketParlayDetailed(rfq, parlays, opts).parlay;
}

function evaluatePolymarketRfq({
  rfq: raw,
  parlays,
  filledSoFar = 0,
  outstanding = 0,
  now,
  startedFor,
  killEngaged,
  markets,
} = {}) {
  const rfq = raw && raw.map ? raw : normalizePolymarketRfq(raw);
  if (!rfq || !rfq.rfqId) return { action: 'skip', reason: 'bad_rfq' };
  if (rfq.status && rfq.status !== 'RFQ_STATUS_OPEN') {
    return { action: 'skip', reason: 'not_open', rfq };
  }
  if (!rfq.map || !rfq.map.ok) {
    return {
      action: 'skip',
      reason: (rfq.map && rfq.map.reason) || 'unmatched_leg',
      rfq,
    };
  }

  const hit = matchPolymarketParlayDetailed(rfq, parlays || [], { markets });
  const parlay = hit.parlay;
  if (!parlay) {
    return {
      action: 'skip',
      reason: hit.reason || 'unmatched',
      rfq,
      identityKeys: hit.identityKeys,
    };
  }

  const started = startedFor
    ? startedFor(parlay, rfq)
    : findStartedEvent(rfq, parlay, null, now);
  if (started && started.started) {
    return { action: 'skip', reason: 'game_started', rfq, parlay, started };
  }

  const quote = buildPolymarketQuote({
    fillAmerican: parlay.fill_american,
    cashOrderQty: rfq.cashOrderQty,
    qtyDecimal: rfq.qtyDecimal,
  });
  if (!shouldPostPolymarketQuote(quote)) {
    return { action: 'skip', reason: 'bad_size', rfq, parlay, quote };
  }

  const decision = decideAtFill({
    parlayStake: parlay.parlay_stake,
    parlayAmerican: parlay.parlay_american,
    fillAmerican: parlay.fill_american,
    fairAmerican: parlay.fair_american,
    rfqContracts: quote.estimatedContracts,
    hedgeMode: parlay.hedge_mode || '1x',
    maxContracts: parlay.max_contracts,
    filledSoFar,
    outstanding,
  });
  if (!decision.ok) {
    return {
      action: 'skip',
      reason: decision.reason || 'declined',
      rfq,
      parlay,
      quote,
      decision,
    };
  }

  const kill = typeof killEngaged === 'function' ? !!killEngaged(parlay.user_id) : false;
  return {
    action: 'quoteable',
    reason: kill ? 'kill' : null,
    rfq,
    parlay,
    quote,
    decision,
    kill,
  };
}

function shouldPostNow(evaluation, { live } = {}) {
  if (!evaluation || evaluation.action !== 'quoteable') {
    return { post: false, reason: (evaluation && evaluation.reason) || 'skip' };
  }
  if (evaluation.kill) return { post: false, reason: 'kill' };
  if (!live) return { post: false, reason: 'live_off' };
  return { post: true, reason: null };
}

function shouldConfirmNow(acceptedSide, { live, started } = {}) {
  if (!shouldConfirmPolymarketAccept(acceptedSide)) {
    return { confirm: false, reason: 'side_not_buy' };
  }
  if (!live) return { confirm: false, reason: 'live_off' };
  if (started && started.started) return { confirm: false, reason: 'game_started' };
  return { confirm: true, reason: null };
}

function parlayFromPending(pending, locks) {
  if (!pending) return null;
  const live = Array.isArray(locks) ? locks.find((x) => x.id === pending.parlayId) : null;
  if (live) return live;
  return {
    id: pending.parlayId,
    label: pending.label,
    starts_at: pending.starts_at,
    legs: pending.legs,
    leg_keys: pending.leg_keys,
  };
}

function quoteBodyFromEval(evaluation) {
  const q = evaluation && evaluation.quote;
  const rfq = evaluation && evaluation.rfq;
  if (!q || !rfq) return null;
  return {
    rfqId: rfq.rfqId,
    buyPrice: q.buyPrice,
    sellPrice: q.sellPrice,
    restRemainder: false,
  };
}

function pendingEntry(p, rfq, contracts, extra) {
  return {
    venue: 'polymarket',
    parlayId: p.id,
    userId: p.user_id,
    contracts,
    label: p.label,
    rfqId: rfq && rfq.rfqId,
    starts_at: p.starts_at,
    legs: p.legs,
    leg_keys: p.leg_keys || p.legKeys,
    maxContracts: p.max_contracts,
    postedAt: extra && extra.postedAt != null ? extra.postedAt : Date.now(),
    ...extra,
  };
}

function acceptedFromEvent(evt) {
  const q = (evt && evt.quote) || {};
  const r = (evt && evt.rfq) || {};
  return {
    quoteId: q.id || q.quoteId || q.quote_id || null,
    rfqId: q.rfqId || q.rfq_id || r.id || r.rfqId || null,
    acceptedSide: q.acceptedSide || q.accepted_side || r.acceptedSide || null,
    creatorOrderId: q.creatorOrderId || q.creator_order_id || null,
    confirmationDeadline: q.confirmationDeadline || q.confirmation_deadline || null,
  };
}

function logSkip(evaluation, extra) {
  const rfq = evaluation.rfq || {};
  const p = evaluation.parlay;
  const symbols = (rfq.comboLegs || []).map((l) => (l && l.symbol) || '?').join(',');
  const label = (p && p.label) || '(none)';
  const bits = [
    `[${MODE}] SKIP ${evaluation.reason} ${label} rfq=${rfq.rfqId || '?'}`,
  ];
  if (
    evaluation.reason === 'unmatched' || evaluation.reason === 'unmatched_leg'
    || evaluation.reason === 'no_legs' || evaluation.reason === 'missing_metadata'
    || evaluation.reason === 'not_priceable' || evaluation.reason === 'ambiguous'
    || evaluation.reason === 'no_lock_overlap'
  ) {
    bits.push(`legs=${symbols || '(none)'} keys=${(rfq.legKeys || []).join('|') || '(none)'}`);
    if (evaluation.identityKeys && evaluation.identityKeys.length) {
      bits.push(`id=${evaluation.identityKeys.join(',')}`);
    }
  }
  if (evaluation.decision) {
    bits.push(`want=${evaluation.quote && evaluation.quote.estimatedContracts} remaining=${evaluation.decision.remaining}/${evaluation.decision.totalLimit}`);
  }
  if (evaluation.reason === 'game_started' && evaluation.started) {
    bits.push(`source=${evaluation.started.source} at=${evaluation.started.at}`);
  }
  if (evaluation.overlap) {
    bits.push(`code=${evaluation.overlap.code || '?'}`);
    if (evaluation.overlap.lock) bits.push(`lock=${evaluation.overlap.lock}`);
    if (evaluation.overlap.detail) bits.push(evaluation.overlap.detail);
  }
  if (extra) bits.push(extra);
  console.log(bits.join(' '));
}

async function hydrateRfq(http, raw) {
  let rfq = normalizePolymarketRfq(raw);
  if (!rfq) return null;
  if (rfq.map && rfq.map.ok) return rfq;

  if (rfq.rfqId) {
    try {
      const listed = await http.listRfqs({ rfqId: rfq.rfqId });
      const rows = (listed && listed.rfqs) || [];
      const hit = rows.find((x) => (x.id || x.rfqId) === rfq.rfqId) || rows[0];
      if (hit) rfq = normalizePolymarketRfq(hit) || rfq;
    } catch (e) {
      console.error(`[${MODE}] GET rfq ${rfq.rfqId}`, e.message);
    }
  }
  if (rfq.map && rfq.map.ok) return rfq;

  if (rfq.symbol) {
    try {
      const listed = await http.getCombo(rfq.symbol);
      const combo = (listed && listed.combo)
        || ((listed && listed.combos && listed.combos[0]) || null);
      if (combo && Array.isArray(combo.legs) && combo.legs.length) {
        rfq = normalizePolymarketRfq({
          id: rfq.rfqId,
          symbol: rfq.symbol,
          status: rfq.status || 'RFQ_STATUS_OPEN',
          qtyDecimal: rfq.qtyDecimal,
          cashOrderQty: rfq.cashOrderQty,
          comboLegs: combo.legs,
        }) || rfq;
      }
    } catch (e) {
      console.error(`[${MODE}] GET combo ${rfq.symbol}`, e.message);
    }
  }
  return rfq;
}

const PM_QUOTE_FILL_STATUSES = [
  'QUOTE_STATUS_EXECUTED',
  'QUOTE_STATUS_CONFIRMED',
  'QUOTE_STATUS_ACCEPTED',
];

function isPmRfqClosed(status) {
  const s = String(status == null ? '' : status).trim().toLowerCase().replace(/-/g, '_');
  return s === 'closed' || s === 'rfq_status_closed';
}

function pickPolymarketRfqRow(rows, rfqId) {
  const list = Array.isArray(rows) ? rows : [];
  const matches = list.filter((x) => {
    if (!x || typeof x !== 'object') return false;
    const id = x.id || x.rfqId || x.rfq_id;
    return id == null || String(id) === String(rfqId);
  });
  const pool = matches.length ? matches : list;
  return pool.find((x) => x && (isUnhedgedFillStatus(x.status) || isPmRfqClosed(x.status)))
    || pool[0]
    || null;
}

function pickPmFillPrice(src, keys) {
  if (!src || typeof src !== 'object') return null;
  for (const k of keys) {
    if (src[k] != null && src[k] !== '') return src[k];
  }
  return null;
}

function pickPmFilledAt(src) {
  return pickPmFillPrice(src, [
    'filled_at', 'filledAt', 'acceptedTime', 'accepted_time',
    'confirmedTime', 'confirmed_time', 'executedTime', 'executed_time',
    'updatedTime', 'updated_ts',
  ]);
}

// Object extractUnhedgedFill can read as filled (status + buyPrice/sellPrice/filled_at).
// Polymarket RFQs are only OPEN/CLOSED — there is no RFQ_STATUS_FILLED.
// A closed RFQ that others filled is stamped via an accepted/confirmed/executed
// quote (when visible) or a combo last-trade in the RFQ window.
function polyUnhedgedFillObject(rfqId, rfq, quote) {
  const buy = pickPmFillPrice(quote, ['buyPrice', 'buy_price', 'price', 'yesPrice', 'yes_price', 'px'])
    ?? pickPmFillPrice(rfq, ['buyPrice', 'buy_price', 'yesPrice', 'yes_price', 'px']);
  const sell = pickPmFillPrice(quote, ['sellPrice', 'sell_price', 'noPrice', 'no_price'])
    ?? pickPmFillPrice(rfq, ['sellPrice', 'sell_price', 'noPrice', 'no_price']);
  const filledAt = pickPmFilledAt(quote) || pickPmFilledAt(rfq) || null;
  const status = (quote && isUnhedgedFillStatus(quote.status) && quote.status)
    || (rfq && isUnhedgedFillStatus(rfq.status) && rfq.status)
    || 'QUOTE_STATUS_EXECUTED';
  return {
    ...(rfq || {}),
    id: rfqId,
    rfqId,
    status,
    buyPrice: buy,
    sellPrice: sell,
    filled_at: filledAt,
  };
}

function quotesFromListed(listed) {
  if (!listed || typeof listed !== 'object') return [];
  const rows = listed.quotes || listed.data;
  return Array.isArray(rows) ? rows : [];
}

// Unfiltered GET often returns only ACTIVE quotes (empty after close).
// Retry terminal statuses. As a non-requester we may still see nothing —
// that is a venue visibility rule, not a skip of the lookup.
async function listPolymarketFillQuotes(http, rfqId) {
  if (!http || typeof http.listQuotes !== 'function' || rfqId == null || rfqId === '') {
    return [];
  }
  const queries = [
    { rfqId },
    ...PM_QUOTE_FILL_STATUSES.map((status) => ({ rfqId, status })),
  ];
  const found = [];
  for (const query of queries) {
    try {
      const quotes = quotesFromListed(await http.listQuotes(query));
      for (const q of quotes) {
        if (q && isUnhedgedFillStatus(q.status)) found.push(q);
      }
      if (found.length) return found;
    } catch (_) {}
  }
  return found;
}

function pickPmLastTrade(body) {
  const src = (body && (body.marketData || body.market || body)) || {};
  const last = src.lastTradePx || src.last_trade_px || src.lastPriceSample || src.last_price_sample;
  let px = null;
  let ts = null;
  if (last && typeof last === 'object') {
    px = last.value != null ? last.value
      : (last.longPx && last.longPx.value != null ? last.longPx.value : last.px);
    ts = last.ts || last.tradeTime || last.transactTime || last.updatedTime || null;
  } else if (last != null && last !== '') {
    px = last;
  }
  if (px == null) px = src.lastTradePx || src.currentPx || null;
  if (px && typeof px === 'object') px = px.value;
  return { px, ts };
}

function pmTradeInRfqWindow(trade, rfq) {
  if (!trade || trade.px == null) return false;
  const tradeMs = trade.ts != null && trade.ts !== '' ? Date.parse(trade.ts) : NaN;
  const createdMs = parseTsish(rfq && (rfq.createdTime || rfq.created_time || rfq.created_ts));
  const updatedMs = parseTsish(rfq && (rfq.updatedTime || rfq.updated_time || rfq.updated_ts));
  if (Number.isFinite(tradeMs)) {
    if (Number.isFinite(createdMs) && tradeMs < createdMs - 2000) return false;
    if (Number.isFinite(updatedMs) && tradeMs > updatedMs + 60000) return false;
    return true;
  }
  // No trade ts: only trust lastTradePx when the RFQ just closed (this tick).
  return Number.isFinite(updatedMs) && (Date.now() - updatedMs) < 5 * 60 * 1000;
}

function parseTsish(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

async function fetchPolymarketComboLastTrade(http, symbol) {
  if (!http || !symbol) return null;
  if (typeof http.getMarketBbo === 'function') {
    try {
      const trade = pickPmLastTrade(await http.getMarketBbo(symbol));
      if (trade && trade.px != null) return { ...trade, symbol };
    } catch (_) {}
  }
  if (typeof http.request !== 'function') return null;
  const paths = [
    `/v1/markets/${encodeURIComponent(symbol)}/bbo`,
    `/v1/market/slug/${encodeURIComponent(symbol)}`,
  ];
  for (const path of paths) {
    try {
      const res = await http.request('GET', path);
      if (!res || res.statusCode === 404 || !(res.statusCode < 400)) continue;
      const trade = pickPmLastTrade(res.json);
      if (trade && trade.px != null) return { ...trade, symbol };
    } catch (_) {}
  }
  return null;
}

async function fetchPolymarketUnhedgedTrades(http, symbol, _minTs, _maxTs, row) {
  const rfq = row && (row.rfq || row);
  const slug = symbol || (rfq && (rfq.symbol || rfq.ticker || rfq.market_ticker)) || null;
  const trade = await fetchPolymarketComboLastTrade(http, slug);
  if (!trade || !pmTradeInRfqWindow(trade, rfq)) return [];
  return [{
    yesPrice: trade.px,
    buyPrice: trade.px,
    px: trade.px,
    tradeTs: trade.ts || null,
    symbol: slug,
  }];
}

// Concrete Poly fill lookup. Never Kalshi tape. Never POST/confirm.
// Polymarket RFQ status is only OPEN/CLOSED (no RFQ_STATUS_FILLED).
// 1) GET /v1/rfqs?rfqId= (documented). GET /v1/rfqs/:id is DELETE-only.
// 2) listQuotes({ rfqId }) plus ACCEPTED/CONFIRMED/EXECUTED — unfiltered
//    lists are often ACTIVE-only and empty after close. Observers may see
//    only their own quote (empty while UNHEDGED_RFQ_LIVE is off).
// 3) CLOSED + buyPrice on the RFQ, or combo last-trade in the RFQ window.
async function fetchPolymarketUnhedgedRfq(http, rfqId) {
  if (!http || rfqId == null || rfqId === '') return null;

  let rfq = null;
  if (typeof http.listRfqs === 'function') {
    try {
      const listed = await http.listRfqs({ rfqId });
      const rows = (listed && (listed.rfqs || listed.data)) || [];
      rfq = pickPolymarketRfqRow(rows, rfqId);
    } catch (_) {}
  }

  if (!rfq && typeof http.request === 'function') {
    try {
      const res = await http.request('GET', `/v1/rfqs/${encodeURIComponent(rfqId)}`);
      if (res && res.statusCode !== 404) {
        const j = res.json;
        const nested = j && j.rfq;
        const got = (nested && typeof nested === 'object' && !Array.isArray(nested))
          ? nested
          : (j && typeof j === 'object' && !Array.isArray(j) && (j.status || j.id || j.rfqId) && !j.rfqs
            ? j
            : null);
        if (got) rfq = got;
      }
    } catch (_) {}
  }

  if (rfq && isUnhedgedFillStatus(rfq.status)) {
    return polyUnhedgedFillObject(rfqId, rfq, null);
  }

  const quotes = await listPolymarketFillQuotes(http, rfqId);
  const q = quotes[0] || null;
  if (q) return polyUnhedgedFillObject(rfqId, rfq, q);

  if (rfq && isPmRfqClosed(rfq.status)) {
    const priced = pickPmFillPrice(rfq, ['buyPrice', 'buy_price', 'yesPrice', 'yes_price'])
      ?? pickPmFillPrice(rfq, ['sellPrice', 'sell_price', 'noPrice', 'no_price']);
    if (priced != null) return polyUnhedgedFillObject(rfqId, rfq, q);
    const symbol = rfq.symbol || rfq.ticker || rfq.market_ticker;
    const trade = await fetchPolymarketComboLastTrade(http, symbol);
    if (trade && pmTradeInRfqWindow(trade, rfq)) {
      return polyUnhedgedFillObject(rfqId, {
        ...rfq,
        buyPrice: trade.px,
        filled_at: trade.ts || rfq.updatedTime || rfq.updated_time || rfq.createdTime || null,
      }, q);
    }
  }

  return rfq;
}

function startPolymarketRfqLoop(ctx = {}) {
  const env = ctx.env || process.env;
  const keyId = env.POLYMARKET_KEY_ID;
  const secretKey = env.POLYMARKET_SECRET_KEY;
  const http = ctx.http || ((keyId && secretKey)
    ? createPolymarketHttp({ keyId, secretKey, requestFn: ctx.requestFn })
    : null);

  async function fetchUnhedgedPmRfq(rfqId) {
    if (typeof ctx.fetchUnhedgedRfq === 'function') return ctx.fetchUnhedgedRfq(rfqId);
    if (!http) return null;
    return fetchPolymarketUnhedgedRfq(http, rfqId);
  }

  async function fetchUnhedgedPmTrades(symbol, minTs, maxTs, row) {
    if (typeof ctx.fetchUnhedgedTrades === 'function') {
      return ctx.fetchUnhedgedTrades(symbol, minTs, maxTs, row);
    }
    if (!http) return [];
    return fetchPolymarketUnhedgedTrades(http, symbol, minTs, maxTs, row);
  }

  if (!keyId || !secretKey) {
    console.log(`[${MODE}] skipped — missing POLYMARKET_KEY_ID or POLYMARKET_SECRET_KEY`);
    return {
      stop() { try { http && http.close && http.close(); } catch (_) {} },
      fetchUnhedgedRfq: fetchUnhedgedPmRfq,
      fetchUnhedgedTrades: fetchUnhedgedPmTrades,
      unhedgedFills: ctx.unhedgedFills || null,
    };
  }

  const live = isPolymarketRfqLive(env);
  const pendingQuotes = ctx.pendingQuotes || new Map();
  const confirmingQuotes = ctx.confirmingQuotes || new Set();
  const seenRfqs = new Map();
  let reserveSeq = 0;
  let stopped = false;

  const marketCache = ctx.marketCache || createMarketCache({
    fetchMarket: ctx.fetchMarket || ((slug) => http.getMarketBySlug(slug)),
  });

  console.log(
    `[${MODE}] starting — live=${live}. ` +
    `POST create-quote / confirm only when POLYMARKET_RFQ_LIVE is truthy. ` +
    `Kalshi quoting keeps running. Remaining is shared via reserve.js. ` +
    `Unhedged RFQ shadow (UNHEDGED_RFQ_SHADOW=${isUnhedgedRfqShadow(env) ? 'on' : 'off'}, ` +
    `UNHEDGED_RFQ_LIVE=${isUnhedgedRfqLive(env) ? 'on' : 'off'}) ` +
    `persists in-scope unmatched MLB/NFL ML combos — never posts.`
  );

  const unhedgedPrices = ctx.unhedgedPrices || null;
  if (unhedgedPrices && typeof unhedgedPrices.setPmFetch === 'function') {
    unhedgedPrices.setPmFetch(ctx.fetchMarket || ((slug) => http.getMarketBySlug(slug)));
  }

  const ownFills = !ctx.unhedgedFills;
  const unhedgedFills = ctx.unhedgedFills || createUnhedgedFillTracker({
    supabase: ctx.supabase,
    persist: ctx.persistUnhedged,
    env,
    fetchRfq: fetchUnhedgedPmRfq,
    fetchTrades: fetchUnhedgedPmTrades,
  });
  if (ownFills && typeof unhedgedFills.hydrate === 'function') {
    unhedgedFills.hydrate().catch((e) => console.error('[UNHEDGED] fill hydrate', e && e.message));
  }

  function persistUnhedgedShadow(rfq) {
    shadowUnhedgedMiss(rfq, {
      venue: 'polymarket',
      supabase: ctx.supabase,
      persist: async (row, meta) => {
        unhedgedFills.remember(row);
        if (typeof ctx.persistUnhedged === 'function') await ctx.persistUnhedged(row, meta);
        else if (ctx.supabase) {
          const out = await persistUnhedgedRfq(ctx.supabase, row);
          if (out && out.alreadyFilled) {
            unhedgedFills.remember({ venue: row.venue, rfq_id: row.rfq_id, status: 'filled' });
          }
        }
      },
      env,
      priceCache: unhedgedPrices,
      onPersisted: (row) => unhedgedFills.remember(row),
    });
  }

  function parlays() {
    return typeof ctx.getParlays === 'function' ? (ctx.getParlays() || []) : (ctx.parlays || []);
  }

  function outstandingFor(parlayId, excludeQuoteId) {
    if (typeof ctx.getOutstanding === 'function') {
      return ctx.getOutstanding(parlayId, excludeQuoteId);
    }
    const self = sumOutstanding(pendingQuotes, parlayId, excludeQuoteId);
    const other = ctx.kalshiPendingQuotes
      ? sumOutstanding(ctx.kalshiPendingQuotes, parlayId, excludeQuoteId)
      : 0;
    return self + other;
  }

  function filledSoFarFor(id) {
    return typeof ctx.filledSoFarFor === 'function' ? ctx.filledSoFarFor(id) : 0;
  }

  function startedFor(p, rfq) {
    if (typeof ctx.startedFor === 'function') return ctx.startedFor(p, rfq);
    return findStartedEvent(rfq, p);
  }

  function killEngagedFor(userId) {
    return typeof ctx.killEngagedFor === 'function' ? ctx.killEngagedFor(userId) : false;
  }

  function bump(key) {
    if (ctx.counts && key in ctx.counts) ctx.counts[key] += 1;
  }

  function rememberSeen(rfqId) {
    if (!rfqId) return;
    if (seenRfqs.has(rfqId)) seenRfqs.delete(rfqId);
    seenRfqs.set(rfqId, Date.now());
    while (seenRfqs.size > SEEN_RFQS_MAX) {
      const oldest = seenRfqs.keys().next().value;
      if (oldest == null) break;
      seenRfqs.delete(oldest);
    }
  }

  async function handleRfq(raw) {
    const locks = parlays();
    let rfq = normalizePolymarketRfq(raw);
    if (!rfq || !rfq.rfqId) return { action: 'skip', reason: 'bad_rfq' };
    if (!locks.length) {
      persistUnhedgedShadow(rfq);
      return { action: 'skip', reason: 'no_locks' };
    }

    if (needsHydrate(rfq, locks)) {
      rfq = (await hydrateRfq(http, raw)) || rfq;
      if (!rfq || !rfq.rfqId) return { action: 'skip', reason: 'bad_rfq' };
    }

    if (!couldMatchActiveLocks(rfq, locks)) {
      persistUnhedgedShadow(rfq);
      const overlap = explainLockOverlapMiss(rfq, locks);
      const evaluation = {
        action: 'skip',
        reason: 'no_lock_overlap',
        rfq,
        overlap,
      };
      if (overlap && NEAR_MISS_CODES.has(overlap.code)) {
        logSkip(evaluation);
      }
      return evaluation;
    }

    if (seenRfqs.has(rfq.rfqId)) return { action: 'skip', reason: 'seen' };
    rememberSeen(rfq.rfqId);
    bump('polyRfqs');

    const direct = cheapDirectMatch(rfq, locks);
    const symbols = (rfq.comboLegs || []).map(polymarketLegSymbol).filter(Boolean);
    const markets = direct ? new Map() : await marketCache.getMany(symbols);
    const matched = matchPolymarketParlay(rfq, parlays(), { markets });
    const evaluation = evaluatePolymarketRfq({
      rfq,
      parlays: parlays(),
      markets,
      filledSoFar: matched ? filledSoFarFor(matched.id) : 0,
      outstanding: matched ? outstandingFor(matched.id) : 0,
      startedFor,
      killEngaged: killEngagedFor,
    });

    if (evaluation.action !== 'quoteable') {
      logSkip(evaluation);
      if (
        evaluation.reason === 'unmatched'
        || evaluation.reason === 'unmatched_leg'
        || evaluation.reason === 'no_legs'
        || evaluation.reason === 'no_locks'
      ) {
        persistUnhedgedShadow(evaluation.rfq || rfq);
      }
      if (evaluation.reason === 'game_started' && evaluation.parlay) {
        try {
          await cancelOpenQuotesForParlay(evaluation.parlay.id, evaluation.started);
        } catch (e) {
          console.error(`[${MODE}] cancel-on-start`, e.message);
        }
      }
      if (evaluation.parlay && ctx.logAsync) {
        ctx.logAsync(evaluation.parlay, { rfqId: rfq.rfqId, contracts: evaluation.quote && evaluation.quote.estimatedContracts }, evaluation.decision, 'declined');
      }
      return evaluation;
    }

    const gate = shouldPostNow(evaluation, { live });
    const p = evaluation.parlay;
    const q = evaluation.quote;
    const d = evaluation.decision;

    if (!gate.post) {
      console.log(
        `[${MODE}] WOULD-QUOTE ${p.label} rfq=${rfq.rfqId} ` +
        `buy=${q.buyPrice} sell=${q.sellPrice} contracts=${q.estimatedContracts} ` +
        `reserved=${outstandingFor(p.id)}/${d.totalLimit} reason=${gate.reason}`
      );
      if (ctx.logAsync) ctx.logAsync(p, { rfqId: rfq.rfqId, contracts: q.estimatedContracts }, d, 'shadow');
      return { ...evaluation, post: false, reason: gate.reason };
    }

    const reserveKey = `reserve:pm:${++reserveSeq}`;
    pendingQuotes.set(reserveKey, pendingEntry(p, rfq, d.contracts));
    try {
      const posted = await http.createQuote(quoteBodyFromEval(evaluation));
      const quoteId = posted && (posted.quoteId || posted.id);
      pendingQuotes.delete(reserveKey);
      if (quoteId) {
        pendingQuotes.set(quoteId, pendingEntry(p, rfq, d.contracts));
      }
      bump('polyPosted');
      console.log(
        `[${MODE}] QUOTED ${p.label} rfq=${rfq.rfqId} quote_id=${quoteId || '?'} ` +
        `buy=${q.buyPrice} sell=${q.sellPrice} contracts=${d.contracts} ` +
        `reserved=${outstandingFor(p.id)}/${d.totalLimit}`
      );
      if (ctx.logAsync) {
        ctx.logAsync(p, { rfqId: rfq.rfqId, contracts: d.contracts }, d, 'quoted', {
          quote_id: quoteId, is_live: true, contracts: d.contracts,
        });
      }
      return { ...evaluation, post: true, quoteId };
    } catch (e) {
      pendingQuotes.delete(reserveKey);
      console.error(`[${MODE}] POST FAILED ${p.label} rfq=${rfq.rfqId}`, e.message);
      if (ctx.logAsync) ctx.logAsync(p, { rfqId: rfq.rfqId, contracts: d.contracts }, d, 'unfilled');
      return { ...evaluation, post: false, reason: 'post_failed', error: e.message };
    }
  }

  function parlayOfPending(pending) {
    return parlayFromPending(pending, parlays());
  }

  async function deleteQuoteAndDrop(quoteId, pending, reason) {
    if (!quoteId) return;
    if (isReserveKey(quoteId)) {
      pendingQuotes.delete(quoteId);
      return;
    }
    const rfqId = pending && pending.rfqId;
    try {
      if (live && rfqId) await http.deleteQuote(rfqId, quoteId);
    } catch (e) {
      const failKind = (reason && reason.started) ? 'game started' : (reason && reason.kind) || '';
      console.error(
        `[${MODE}] CANCEL FAILED ${failKind} ${(pending && pending.label) || '(unknown)'} quote_id=${quoteId}`,
        e.message
      );
    }
    pendingQuotes.delete(quoteId);
    if (reason && reason.started) {
      console.log(
        `[${MODE}] CANCEL game started ${(pending && pending.label) || '(unknown)'} quote_id=${quoteId}` +
        (rfqId ? ` rfq=${rfqId}` : '') +
        ` source=${reason.source} at=${reason.at}`
      );
    }
  }

  async function cancelOpenQuotesForParlay(parlayId, started) {
    for (const [quoteId, pending] of pendingQuotes) {
      if (!pending || pending.parlayId !== parlayId) continue;
      await deleteQuoteAndDrop(quoteId, pending, started);
    }
  }

  async function cancelPendingIfStarted() {
    for (const [quoteId, pending] of pendingQuotes) {
      const p = parlayOfPending(pending);
      const started = startedFor(p);
      if (started && started.started) await deleteQuoteAndDrop(quoteId, pending, started);
    }
  }

  async function cancelStartedQuotes() {
    await cancelPendingIfStarted();
  }

  async function handleQuoteAccepted(evt) {
    const acc = acceptedFromEvent(evt);
    const { quoteId, rfqId, acceptedSide } = acc;
    const pending = quoteId ? pendingQuotes.get(quoteId) : null;
    if (pending) pending.accepted = true;
    const parlay = parlayOfPending(pending);
    const started = parlay ? startedFor(parlay) : { started: false };
    const gate = shouldConfirmNow(acceptedSide, { live, started });
    if (!gate.confirm) {
      if (gate.reason === 'game_started') {
        console.log(
          `[${MODE}] CONFIRM SKIPPED game started quote_id=${quoteId || '?'} ` +
          `rfq_id=${rfqId || '?'} label=${pending ? pending.label : '(unknown)'} ` +
          `source=${started.source} at=${started.at}`
        );
      } else {
        console.log(
          `[${MODE}] CONFIRM SKIPPED ${gate.reason} quote_id=${quoteId || '?'} ` +
          `rfq_id=${rfqId || '?'} side=${acceptedSide || '?'}`
        );
      }
      if (quoteId && pending && live && (gate.reason === 'side_not_buy' || gate.reason === 'game_started')) {
        try { await http.deleteQuote(rfqId, quoteId); } catch (e) {
          console.error(`[${MODE}] decline delete failed`, e.message);
        }
        pendingQuotes.delete(quoteId);
      }
      return { confirmed: false, reason: gate.reason, started: gate.reason === 'game_started' ? started : undefined };
    }
    if (!quoteId || !rfqId) {
      console.error(`[${MODE}] quoteAccepted missing ids`);
      return { confirmed: false, reason: 'missing_ids' };
    }
    if (confirmingQuotes.has(quoteId)) return { confirmed: false, reason: 'in_flight' };
    confirmingQuotes.add(quoteId);
    try {
      if (pending) {
        const maxContracts = pending.maxContracts;
        const filledSoFar = filledSoFarFor(pending.parlayId);
        const outstandingOthers = outstandingFor(pending.parlayId, quoteId);
        if (wouldExceedCap(maxContracts, filledSoFar, outstandingOthers, pending.contracts)) {
          console.log(
            `[${MODE}] CONFIRM SKIPPED cap exceeded quote_id=${quoteId} ` +
            `filled=${filledSoFar} reserved=${outstandingOthers} want=${pending.contracts} max=${maxContracts}`
          );
          try { await http.deleteQuote(rfqId, quoteId); } catch (_) {}
          pendingQuotes.delete(quoteId);
          return { confirmed: false, reason: 'cap_exceeded' };
        }
      }
      await http.confirmQuote(rfqId, quoteId);
      console.log(
        `[${MODE}] CONFIRMED quote_id=${quoteId} rfq_id=${rfqId} side=${acceptedSide} ` +
        `label=${pending ? pending.label : '(unknown)'}`
      );
      return { confirmed: true };
    } catch (e) {
      console.error(`[${MODE}] CONFIRM FAILED quote_id=${quoteId} rfq_id=${rfqId}`, e.message);
      return { confirmed: false, reason: 'confirm_failed', error: e.message };
    } finally {
      confirmingQuotes.delete(quoteId);
    }
  }

  function handleRfqClosed(evt) {
    const rfq = (evt && evt.rfq) || {};
    const rfqId = rfq.id || rfq.rfqId || (evt && evt.rfqId);
    if (!rfqId) return;
    seenRfqs.delete(rfqId);
    const dropped = dropPendingForRfq(pendingQuotes, rfqId, { confirming: confirmingQuotes });
    for (const { id, quote } of dropped) {
      console.log(
        `[${MODE}] RESERVE RELEASED closed ${quote.label || ''} quote_id=${id} rfq=${rfqId}`
      );
    }
    unhedgedFills.onClosed({
      venue: 'polymarket',
      rfqId,
      extra: evt,
      rfq,
      symbol: rfq.symbol || rfq.ticker,
    }).catch((e) => console.error('[UNHEDGED] fill close', e && e.message));
  }

  function noteUnhedgedFillEvent(evt) {
    const rfq = (evt && evt.rfq) || {};
    const quote = (evt && evt.quote) || {};
    const rfqId = rfq.id || rfq.rfqId || quote.rfqId || quote.rfq_id || (evt && evt.rfqId);
    if (!rfqId) return;
    unhedgedFills.onClosed({
      venue: 'polymarket',
      rfqId,
      extra: evt,
      rfq,
      symbol: rfq.symbol || quote.symbol || rfq.ticker,
    }).catch((e) => console.error('[UNHEDGED] fill event', e && e.message));
  }

  function handleQuoteExecuted(evt) {
    const q = (evt && evt.quote) || {};
    const quoteId = q.id || q.quoteId;
    const pending = quoteId ? pendingQuotes.get(quoteId) : null;
    if (pending) {
      pending.executed = true;
      pending.creatorOrderId = q.creatorOrderId || q.creator_order_id || null;
    }
    console.log(
      `[${MODE}] quoteExecuted orders submitted (not a fill) ` +
      `quote_id=${quoteId || '?'} rfq=${q.rfqId || (pending && pending.rfqId) || '?'} ` +
      `creatorOrderId=${q.creatorOrderId || q.creator_order_id || '?'}`
    );
  }

  function handleOrderExecution(ex) {
    if (!ex || typeof ex !== 'object') return;
    const typ = String(ex.type || '').toUpperCase();
    const order = ex.order || {};
    const orderId = order.id || ex.orderId || ex.order_id || null;
    let pending = null;
    let pendingId = null;
    pendingQuotes.forEach((q, id) => {
      if (q.creatorOrderId && q.creatorOrderId === orderId) {
        pending = q;
        pendingId = id;
      }
    });
    if (!pending) return;

    if (typ === 'EXECUTION_TYPE_FILL' || typ === 'EXECUTION_TYPE_PARTIAL_FILL') {
      const n = parseFloat(ex.lastShares || ex.last_shares || 0);
      const contracts = Number.isFinite(n) && n > 0 ? n : pending.contracts;
      if (typeof ctx.onFill === 'function') ctx.onFill(pending.parlayId, contracts);
      else if (ctx.sessionFilledByParlay) {
        ctx.sessionFilledByParlay[pending.parlayId] =
          (ctx.sessionFilledByParlay[pending.parlayId] || 0) + contracts;
      }
      if (typ === 'EXECUTION_TYPE_FILL') pendingQuotes.delete(pendingId);
      console.log(
        `[${MODE}] ORDER FILL ${pending.label} order_id=${orderId} contracts=${contracts}`
      );
      return;
    }
    if (
      typ === 'EXECUTION_TYPE_CANCELED' ||
      typ === 'EXECUTION_TYPE_REJECTED' ||
      typ === 'EXECUTION_TYPE_EXPIRED'
    ) {
      pendingQuotes.delete(pendingId);
      console.log(`[${MODE}] RESERVE RELEASED order ${typ} quote_id=${pendingId}`);
    }
  }

  async function reconcileOpenRfqs() {
    const locks = parlays();
    if (!locks.length) {
      console.log(`[${MODE}] reconcile open=0 locks=0 live=${live}`);
      return;
    }
    logActiveLockIdentityFails(locks);
    logUnpriceablePolyLocks(locks);
    try {
      const listed = await http.listRfqs({ status: 'RFQ_STATUS_OPEN', limit: 100 });
      const rows = (listed && listed.rfqs) || [];
      const reasons = {};
      for (const row of rows) {
        if (stopped) return;
        const out = await handleRfq(row);
        const key = (out && out.post) ? 'quoted' : ((out && out.reason) || (out && out.action) || 'unknown');
        tallyReason(reasons, key);
      }
      const hist = formatReasonTally(reasons);
      console.log(
        `[${MODE}] reconcile open=${rows.length} live=${live}` +
        (hist ? ` ${hist}` : '')
      );
    } catch (e) {
      console.error(`[${MODE}] reconcile rfqs`, e.message);
    }
  }

  async function cancelUnaccepted() {
    const stale = listStaleUnaccepted(pendingQuotes, Date.now(), RESERVE_TTL_MS, {
      confirming: confirmingQuotes,
    });
    for (const { id, quote } of stale) {
      if (isReserveKey(id)) {
        pendingQuotes.delete(id);
        continue;
      }
      try {
        if (live && quote.rfqId) await http.deleteQuote(quote.rfqId, id);
      } catch (e) {
        console.error(`[${MODE}] TTL delete failed`, e.message);
      }
      pendingQuotes.delete(id);
      console.log(`[${MODE}] CANCEL unaccepted quote_id=${id} rfq=${quote.rfqId || '?'}`);
    }
  }

  function onWsEvent(evt) {
    if (!evt || stopped) return;
    if (evt.type === 'rfqCreated') {
      handleRfq(evt.rfq || evt).catch((e) => console.error(`[${MODE}] onRfq`, e.message));
    } else if (evt.type === 'rfqClosed') {
      handleRfqClosed(evt);
    } else if (evt.type === 'quoteAccepted') {
      handleQuoteAccepted(evt).catch((e) => console.error(`[${MODE}] onAccept`, e.message));
      noteUnhedgedFillEvent(evt);
    } else if (evt.type === 'quoteConfirmed') {
      noteUnhedgedFillEvent(evt);
    } else if (evt.type === 'quoteExecuted') {
      handleQuoteExecuted(evt);
      noteUnhedgedFillEvent(evt);
    } else if (evt.type === 'quoteDeleted') {
      const q = evt.quote || {};
      const id = q.id || q.quoteId;
      if (id && pendingQuotes.has(id)) {
        pendingQuotes.delete(id);
        console.log(`[${MODE}] RESERVE RELEASED deleted quote_id=${id}`);
      }
    } else if (evt.type === 'orderExecution') {
      handleOrderExecution(evt.execution);
    }
  }

  let ws = null;
  if (!ctx.http || ctx.startWs !== false) {
    ws = ctx.ws || createPolymarketRfqWs({
      keyId,
      secretKey,
      onStatus: (s, i) => console.log(`[${MODE}] ws:${s}`, i && i.message ? i.message : (i && i.wait != null ? `wait=${i.wait}` : '')),
      onEvent: onWsEvent,
      subscribeOrders: live,
    });
    try { ws.start(); } catch (e) { console.error(`[${MODE}] ws start`, e.message); }
  }

  http.getUserId().then((j) => {
    const id = j && (j.rfqUserId || j.rfq_user_id);
    console.log(`[${MODE}] auth ok rfqUserId=${id || '(none)'} live=${live}`);
  }).catch((e) => {
    console.error(`[${MODE}] user-id failed`, e.message);
  });

  reconcileOpenRfqs().catch((e) => console.error(`[${MODE}] initial reconcile`, e.message));
  const reconcileTimer = setInterval(() => {
    reconcileOpenRfqs().catch((e) => console.error(`[${MODE}] reconcile`, e.message));
  }, ctx.reconcileMs != null ? ctx.reconcileMs : RECONCILE_MS);
  const ttlTimer = setInterval(() => {
    cancelUnaccepted().catch((e) => console.error(`[${MODE}] ttl`, e.message));
    cancelPendingIfStarted().catch((e) => console.error(`[${MODE}] cancel-on-start`, e.message));
  }, 2000);
  let fillTimer = null;
  if (ownFills) {
    fillTimer = setInterval(() => {
      unhedgedFills.tick().catch((e) => console.error('[UNHEDGED] fill tick', e && e.message));
    }, ctx.unhedgedFillMs != null ? ctx.unhedgedFillMs : (ctx.startWs === false ? 60 * 60 * 1000 : 15000));
    if (fillTimer.unref) fillTimer.unref();
  }
  if (reconcileTimer.unref) reconcileTimer.unref();
  if (ttlTimer.unref) ttlTimer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(reconcileTimer);
      clearInterval(ttlTimer);
      if (fillTimer) clearInterval(fillTimer);
      try { ws && ws.stop && ws.stop(); } catch (_) {}
      try { http.close && http.close(); } catch (_) {}
    },
    handleRfq,
    handleQuoteAccepted,
    handleRfqClosed,
    handleQuoteExecuted,
    handleOrderExecution,
    onWsEvent,
    cancelStartedQuotes,
    cancelPendingIfStarted,
    pendingQuotes,
    seenRfqs,
    live,
    marketCache,
    unhedgedFills,
    fetchUnhedgedRfq: fetchUnhedgedPmRfq,
    fetchUnhedgedTrades: fetchUnhedgedPmTrades,
  };
}

module.exports = {
  MODE,
  SEEN_RFQS_MAX,
  normalizePolymarketSide,
  polymarketLegSymbol,
  polymarketLegKey,
  mapComboLegs,
  normalizePolymarketRfq,
  cheapDirectMatch,
  couldMatchActiveLocks,
  logActiveLockIdentityFails,
  logUnpriceablePolyLocks,
  explainLockOverlapMiss,
  isKalshiMoneylineLock,
  matchPolymarketParlay,
  matchPolymarketParlayDetailed,
  evaluatePolymarketRfq,
  shouldPostNow,
  shouldConfirmNow,
  parlayFromPending,
  quoteBodyFromEval,
  acceptedFromEvent,
  startPolymarketRfqLoop,
  fetchPolymarketUnhedgedRfq,
  fetchPolymarketUnhedgedTrades,
  fetchPolymarketComboLastTrade,
  listPolymarketFillQuotes,
  isPmRfqClosed,
  PM_QUOTE_FILL_STATUSES,
};
