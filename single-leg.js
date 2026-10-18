// Single-leg Combo Locks (1-leg locks, e.g. "Minnesota Wild ML").
//
// A 1-leg lock never matches a combo RFQ, so instead this module RESTS the
// hedge (the opposite side of the user's bet) as a plain limit order on BOTH
// venues the user has keys for:
//   Kalshi      single market, buy the other side (leg yes -> buy NO), priced
//               from the lock's fill odds net of the series maker fee
//               (quadratic 0 / maker 0.0175×m / combo-maker 0.035×m).
//   Polymarket  US single moneyline market (aec-{league}-{t1}-{t2}-{date}),
//               buy the other team. Maker fee is 0 and we assume NO rebate
//               (US rebates need $10M+ monthly maker volume from Oct 19), so
//               the price is just 1 - implied(fill), floored to the tick.
//
// Taker first: when the hedge side's best price on a venue is at or better
// than the lock's hedge price AFTER the taker fee, it is taken (IOC), sized
// to the depth at acceptable prices and capped at what is left to hedge.
// Otherwise it rests maker-only at the lock price, never crossing: if that
// price would cross the book it rests one tick behind the best price.
//
// Cross-venue cap: filled(K) + filled(P) + open(K) + open(P) never exceeds
// the lock size. The remaining size is SPLIT between venues (Kalshi gets
// ceil(remaining × SINGLE_LEG_KALSHI_SHARE, default 0.5), Polymarket the
// rest), so even if both venues fill at the same instant the total can't go
// past the cap. Every poll (default 1.5s) reads both orders; after a fill the
// targets shrink and the other venue is decreased/cancelled. Orders whose
// cancel failed stay tracked (and counted as open) until a later read shows
// them closed; nothing is placed on that venue meanwhile. If an over-hedge is
// ever detected anyway (e.g. a manual order), a CRITICAL Telegram alert goes
// out; the excess is NOT sold back automatically.
//
// Both orders are cancelled when the game starts, the lock is cancelled,
// paused, edited (price changes => cancel + re-rest), deactivated, or the
// user's kill switch / caps / credits block trading.
//
// Kalshi single markets clear on shard 0 (main cash), not the Combos bucket.
// bucket-manager / tester-funder already hold every Default->Combos transfer
// while shard 0 has resting orders, so these rests are never cancelled by an
// auto-transfer (but they do pause top-ups while they rest).
//
// Off unless SINGLE_LEG_LIVE=1 (log-only dry run with SINGLE_LEG_LIVE=dry).
'use strict';

const { kalshiTickerPieces, parseKalshiTicker, identityFromMarket, identityKey, TEAM_ALIASES, normTeam } = require('./leg-identity');
const { parseKalshiTickerStart, parseTs } = require('./started');

const impliedProb = (a) => (a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100));
const floorTo = (x, tick) => Math.floor(x / tick + 1e-9) * tick;
const round6 = (x) => Math.round(x * 1e6) / 1e6;

function readMode(env = process.env) {
  const v = String(env.SINGLE_LEG_LIVE || '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'live') return 'live';
  if (v === 'dry' || v === 'shadow') return 'dry';
  return 'off';
}

function legsOf(p) {
  return Array.isArray(p && p.legs) ? p.legs.filter((l) => l && l.ticker) : [];
}
function isSingleLegLock(p) {
  return legsOf(p).length === 1;
}
// Combo RFQ matching only ever sees 2+ leg locks.
// Oct 18 hotfix: cached per parlays array so matchParlay's per-array index is
// built once per refresh, not once per RFQ. The runner always replaces the array.
const comboOnlyMemo = new WeakMap();
function comboLocksOnly(parlays) {
  if (!parlays || typeof parlays !== 'object') return [];
  let out = comboOnlyMemo.get(parlays);
  if (!out) {
    out = parlays.filter((p) => !isSingleLegLock(p));
    comboOnlyMemo.set(parlays, out);
  }
  return out;
}

// Price the lock pays out net of the maker fee -> nominal price to rest at.
// Same quadratic solve the combo path uses (engine.fillView).
function nominalFromNet(sEff, k) {
  if (!(k > 0)) return sEff;
  const b = 1 - k;
  return (-b + Math.sqrt(b * b + 4 * k * sEff)) / (2 * k);
}

// Kalshi hedge: leg yes -> buy NO; leg no -> buy YES. Price in whole cents,
// floored so the user's net fill odds are never worse than the lock's.
function kalshiHedge(leg, fillAmerican, makerRate) {
  const a = Number(fillAmerican);
  if (!leg || !leg.ticker || !Number.isFinite(a) || a === 0) return null;
  const sNom = nominalFromNet(impliedProb(a), Number(makerRate) || 0);
  const cents = Math.floor((1 - sNom) * 100 + 1e-9);
  if (cents < 1 || cents > 99) return null;
  const legSide = String(leg.side || 'yes').toLowerCase() === 'no' ? 'no' : 'yes';
  return { ticker: String(leg.ticker), side: legSide === 'yes' ? 'no' : 'yes', priceCents: cents };
}

// Polymarket hedge cost (buy the other team) for a fill price, floored to tick.
function polyHedgeCost(fillAmerican, tick = 0.01) {
  const a = Number(fillAmerican);
  if (!Number.isFinite(a) || a === 0) return null;
  const t = Number(tick) > 0 ? Number(tick) : 0.01;
  const c = round6(floorTo(1 - impliedProb(a), t));
  return c > 0 && c < 1 ? c : null;
}

// Kalshi codes -> Polymarket US slug codes to try (inverse of TEAM_ALIASES).
function polyCodesFor(league, code) {
  const out = new Set([String(code).toLowerCase()]);
  const canon = normTeam(league, code);
  if (canon) out.add(canon);
  for (const [alias, to] of Object.entries(TEAM_ALIASES[league] || {})) {
    if (to === canon) out.add(alias);
  }
  return [...out];
}

// Candidate Poly game slugs for a Kalshi moneyline ticker (both team orders).
function polySlugCandidates(ticker) {
  const pc = kalshiTickerPieces(ticker);
  if (!pc || pc.marketType !== 'moneyline') return [];
  const [a, b] = pc.teams;
  const out = [];
  for (const x of polyCodesFor(pc.league, a)) {
    for (const y of polyCodesFor(pc.league, b)) {
      out.push(`aec-${pc.league}-${x}-${y}-${pc.date}`);
      out.push(`aec-${pc.league}-${y}-${x}-${pc.date}`);
    }
  }
  return [...new Set(out)].slice(0, 12);
}

// Given the Poly market (metadata verified) and the lock leg, which intent
// hedges the user. Lock identity is canonical "team T wins : yes".
// Returns { intent, longWinsForUser } or null if the market is not this game.
function polyHedgeIntent(leg, market) {
  const lockId = parseKalshiTicker(leg.ticker, String(leg.side || 'yes').toLowerCase());
  if (!lockId) return null;
  const asLong = identityFromMarket(market, 'yes');
  const asShort = identityFromMarket(market, 'no');
  const lk = identityKey(lockId);
  if (asLong.identity && identityKey(asLong.identity) === lk) {
    // user wins when LONG wins -> hedge buys SHORT
    return { intent: 'ORDER_INTENT_BUY_SHORT' };
  }
  if (asShort.identity && identityKey(asShort.identity) === lk) {
    return { intent: 'ORDER_INTENT_BUY_LONG' };
  }
  return null;
}

// Polymarket US limit body (same shape the Live Trading Desk sends).
// price.value is always the LONG (YES) price.
function polyOrderBody({ slug, intent, cost, qty, tick = 0.01, taker = false }) {
  const yes = intent === 'ORDER_INTENT_BUY_SHORT' ? round6(1 - cost) : cost;
  const dec = Number(tick) < 0.01 ? 4 : 2;
  return {
    marketSlug: slug,
    type: 'ORDER_TYPE_LIMIT',
    price: { value: yes.toFixed(dec), currency: 'USD' },
    quantity: Math.floor(qty),
    tif: taker ? 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL' : 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
    intent,
    manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_MANUAL',
    participateDontInitiate: !taker,
  };
}

// "Cancel open quotes" on a single-leg lock pulls both rests and keeps them
// pulled. Editing the fill odds stamps fill_edited_at == cancel_open_at, which
// cancels the old-price rests and re-rests at the new price.
function cancelHeld(p) {
  const c = parseTs(p && p.cancel_open_at);
  if (c == null) return false;
  const e = parseTs(p && p.fill_edited_at);
  return e == null || e < c;
}

function lockStartMs(p) {
  const leg = legsOf(p)[0];
  const times = [parseTs(p && p.starts_at), leg && parseTs(leg.starts_at), leg && parseKalshiTickerStart(leg.ticker)]
    .filter((t) => t != null && Number.isFinite(t));
  return times.length ? Math.min(...times) : null;
}

// ── Fees / odds ────────────────────────────────────────────────────────────
const KALSHI_TAKER_K = 0.07;
const POLY_TAKER_THETA = 0.0695; // Polymarket US taker: 0.0695 × C × p(1−p)
const takerFee = (k, q) => k * q * (1 - q);
// American odds for buying a contract at cost c (0..1).
function americanFromCost(c) {
  const x = Number(c);
  if (!(x > 0 && x < 1)) return null;
  return x >= 0.5 ? -Math.round((100 * x) / (1 - x)) : Math.round((100 * (1 - x)) / x);
}
const fmtAmerican = (a) => (a == null ? '?' : a > 0 ? `+${a}` : `${a}`);
// The hedge cost the lock can afford per contract, after fees.
const hedgeTarget = (fillAmerican) => {
  const a = Number(fillAmerican);
  return Number.isFinite(a) && a !== 0 ? 1 - impliedProb(a) : null;
};

// Kalshi orderbook_fp: yes_dollars / no_dollars are BIDS [[price, qty]].
// Buying side S takes the opposite side's bids: ask(S) = 1 − bid(other).
function kalshiAsks(fp, buySide) {
  const src = (fp && (fp.orderbook_fp || fp.orderbook || fp)) || {};
  const bids = buySide === 'no' ? (src.yes_dollars || src.yes || []) : (src.no_dollars || src.no || []);
  return bids.map((r) => {
    const px = Number(Array.isArray(r) ? r[0] : r && r.price);
    const qty = Number(Array.isArray(r) ? r[1] : r && r.count);
    const p = px > 1 ? px / 100 : px;
    return { cost: round6(1 - p), qty };
  }).filter((l) => l.cost > 0 && l.cost < 1 && l.qty > 0).sort((a, b) => a.cost - b.cost);
}
// Polymarket US book: bids/offers are LONG prices. BUY_SHORT takes long bids
// (cost 1−px); BUY_LONG takes offers (cost px).
function polyAsks(book, intent) {
  const d = (book && (book.marketData || book)) || {};
  const rows = intent === 'ORDER_INTENT_BUY_SHORT' ? (d.bids || []) : (d.offers || []);
  return rows.map((r) => {
    const px = Number(r && r.px && typeof r.px === 'object' ? r.px.value : r && r.px);
    const qty = Number(r && r.qty);
    return { cost: round6(intent === 'ORDER_INTENT_BUY_SHORT' ? 1 - px : px), qty };
  }).filter((l) => l.cost > 0 && l.cost < 1 && l.qty > 0).sort((a, b) => a.cost - b.cost);
}

// Walk asks while cost + taker fee <= target. Returns the IOC plan.
function takePlan(asks, target, takerK, maxQty) {
  let qty = 0; let spend = 0; let worst = null;
  const cap = Math.floor(Number(maxQty) || 0);
  for (const l of asks || []) {
    if (qty >= cap) break;
    if (l.cost + takerFee(takerK, l.cost) > target + 1e-9) break;
    const q = Math.min(Math.floor(l.qty), cap - qty);
    if (q < 1) continue;
    qty += q; spend += q * (l.cost + takerFee(takerK, l.cost)); worst = l.cost;
  }
  return qty > 0 ? { qty, worstCost: worst, avgNet: round6(spend / qty) } : null;
}

// Maker rest price: the lock price, or one tick behind the best ask if the
// lock price would cross (post-only would be rejected).
function restCost(lockCost, asks, tick) {
  if (lockCost == null) return null;
  const best = asks && asks.length ? asks[0].cost : null;
  if (best == null || lockCost < best - 1e-9) return lockCost;
  const c = round6(floorTo(best - tick, tick));
  return c > 0 && c < 1 ? Math.min(c, lockCost) : null;
}

// Split what is left to hedge across enabled venues (combined exposure cap).
function allocate(remaining, enabled, kalshiShare = 0.5) {
  const r = Math.max(0, Math.floor(remaining));
  const out = { kalshi: 0, polymarket: 0 };
  if (enabled.kalshi && enabled.polymarket) {
    const sh = Number(kalshiShare);
    out.kalshi = Math.min(r, Math.ceil(r * (sh >= 0 && sh <= 1 ? sh : 0.5)));
    out.polymarket = r - out.kalshi;
  } else if (enabled.kalshi) out.kalshi = r;
  else if (enabled.polymarket) out.polymarket = r;
  return out;
}

// ── Polymarket US player props (NHL goals, NFL TDs, MLB HRs) ───────────────
const PROP_SERIES = {
  KXNHLGOAL: { game: 'KXNHLGAME', kind: 'hockey_player_goals' },
  KXNFLTD: { game: 'KXNFLGAME', kind: 'football_player_touchdowns' },
  KXMLBHR: { game: 'KXMLBGAME', kind: 'baseball_player_home_runs' },
};
const nameTokens = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1);
// -> { eventSlugs, kind, threshold, name } or null
function propPolyRef(leg) {
  const parts = String((leg && leg.ticker) || '').toUpperCase().split('-');
  const spec = PROP_SERIES[parts[0]];
  if (!spec || parts.length < 4) return null;
  const threshold = Number(parts[parts.length - 1]);
  if (!(threshold >= 1)) return null;
  const name = String(leg.player || leg.label || '').split(':')[0].trim();
  if (nameTokens(name).length < 2) return null;
  const eventSlugs = [...new Set(polySlugCandidates(`${spec.game}-${parts[1]}`).map((s) => s.replace(/^aec-/, '')))];
  return eventSlugs.length ? { eventSlugs, kind: spec.kind, threshold, name } : null;
}
// Unique market in a Poly event for this player + line, else null.
function findPropMarket(event, ref) {
  const want = nameTokens(ref.name);
  const lineOk = (l) => { const n = Number(l); return n === ref.threshold || n === ref.threshold - 0.5; };
  const hits = ((event && event.markets) || []).filter((m) => m && (m.sportsMarketType || m.marketType) === ref.kind
    && m.closed !== true && m.active !== false && lineOk(m.line)
    && want.every((t) => nameTokens((m.metadata && m.metadata.playerName) || '').includes(t)));
  return hits.length === 1 ? hits[0] : null;
}
// LONG = player reaches the line. User on yes -> hedge buys SHORT.
const propIntent = (leg) => (String(leg.side || 'yes').toLowerCase() === 'no' ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_BUY_SHORT');

// ── Pure cross-venue plan ──────────────────────────────────────────────────
// venues: { kalshi: {...}, polymarket: {...} } each
//   filled   contracts filled so far on that venue (this lock)
//   open     contracts still resting or unconfirmed (incl. failed cancels)
//   pending  contracts on orders whose cancel failed (can't be touched)
//   price / wantPrice   current resting cost vs the cost we want now
//   enabled  venue configured + market found
// Returns { remaining, over, filled, targets, actions:[{venue, op, size}] }
// Invariant: filled + open across venues never goes above cap.
function planCrossVenue({ cap, venues, active, kalshiShare = 0.5 }) {
  const names = Object.keys(venues || {});
  const filled = names.reduce((n, v) => n + (Number(venues[v].filled) || 0), 0);
  const capN = Math.max(0, Math.floor(Number(cap) || 0));
  const remaining = Math.max(0, capN - filled);
  const over = Math.max(0, filled - capN);
  const enabled = {};
  for (const v of names) enabled[v] = !!(active && venues[v].enabled);
  const targets = allocate(remaining, enabled, kalshiShare);
  const actions = [];
  const after = {};
  for (const v of names) {
    const s = venues[v];
    const open = Math.max(0, Number(s.open) || 0);
    const pending = Math.max(0, Math.min(open, Number(s.pending) || 0));
    const movable = open - pending;
    const tgt = targets[v] || 0;
    after[v] = open;
    if (tgt <= 0) {
      if (movable > 0) { actions.push({ venue: v, op: 'cancel', size: 0 }); after[v] = pending; }
      continue;
    }
    const repriced = movable > 0 && s.wantPrice != null && s.price != null && Math.abs(Number(s.price) - Number(s.wantPrice)) > 1e-9;
    if (repriced) { actions.push({ venue: v, op: 'cancel', size: 0, reprice: true }); after[v] = pending; }
    else if (open > tgt && movable > 0) {
      const keep = Math.max(0, tgt - pending);
      actions.push(keep > 0 ? { venue: v, op: 'resize', size: keep } : { venue: v, op: 'cancel', size: 0 });
      after[v] = pending + keep;
    }
  }
  // Places only after every shrink, and only into room that is really free.
  let room = remaining - names.reduce((n, v) => n + after[v], 0);
  for (const v of names) {
    const s = venues[v];
    if (!(targets[v] > 0) || (Number(s.pending) || 0) > 0) continue;
    const gap = Math.min(targets[v] - after[v], room);
    // top-ups below 10% of target are not worth the churn
    if (gap >= 1 && (after[v] === 0 || gap >= Math.max(1, 0.1 * targets[v]))) {
      actions.push({ venue: v, op: 'place', size: Math.floor(gap) });
      room -= Math.floor(gap);
    }
  }
  const rank = { cancel: 0, resize: 1, place: 2 };
  actions.sort((a, b) => rank[a.op] - rank[b.op]);
  return { remaining, over, filled, targets, actions };
}

module.exports = {
  readMode,
  isSingleLegLock,
  comboLocksOnly,
  kalshiHedge,
  polyHedgeCost,
  polySlugCandidates,
  polyHedgeIntent,
  polyOrderBody,
  lockStartMs,
  cancelHeld,
  planCrossVenue,
  nominalFromNet,
  americanFromCost,
  fmtAmerican,
  hedgeTarget,
  kalshiAsks,
  polyAsks,
  takePlan,
  restCost,
  allocate,
  propPolyRef,
  findPropMarket,
  propIntent,
  takerFee,
  KALSHI_TAKER_K,
  POLY_TAKER_THETA,
};
