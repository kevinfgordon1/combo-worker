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
// Cross-venue cap: filled(K) + filled(P) never exceeds the lock size. Each
// venue rests at most `remaining = cap - totalFilled`. Every poll (default
// 1.5s) reads both orders; when anything filled, the other venue is shrunk to
// the new remaining (Kalshi: decrease; Polymarket: cancel + re-rest) or
// cancelled at 0. Both filling inside one poll is the only way to over-hedge;
// it is trimmed at once and sent as a CRITICAL Telegram alert.
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
function comboLocksOnly(parlays) {
  return (parlays || []).filter((p) => !isSingleLegLock(p));
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
function polyOrderBody({ slug, intent, cost, qty, tick = 0.01 }) {
  const yes = intent === 'ORDER_INTENT_BUY_SHORT' ? round6(1 - cost) : cost;
  const dec = Number(tick) < 0.01 ? 3 : 2;
  return {
    marketSlug: slug,
    type: 'ORDER_TYPE_LIMIT',
    price: { value: yes.toFixed(dec), currency: 'USD' },
    quantity: Math.floor(qty),
    tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
    intent,
    manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_MANUAL',
    participateDontInitiate: true,
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

// ── Pure cross-venue plan ──────────────────────────────────────────────────
// venues: { kalshi: { filled, open, price, wantPrice, enabled }, poly: {...} }
//   filled  contracts filled so far on that venue (this lock)
//   open    contracts still resting (0 = no live order)
//   price / wantPrice   current resting price vs the lock's price now
//   enabled venue configured + market found
// Returns { remaining, over, actions: [{ venue, op: place|resize|cancel, size }] }
function planCrossVenue({ cap, venues, active }) {
  const names = Object.keys(venues || {});
  const filled = names.reduce((n, v) => n + (Number(venues[v].filled) || 0), 0);
  const capN = Math.max(0, Math.floor(Number(cap) || 0));
  const remaining = Math.max(0, capN - filled);
  const over = Math.max(0, filled - capN);
  const actions = [];
  for (const v of names) {
    const s = venues[v];
    const open = Math.max(0, Number(s.open) || 0);
    if (!active || !s.enabled || remaining <= 0) {
      if (open > 0) actions.push({ venue: v, op: 'cancel', size: 0 });
      continue;
    }
    if (open > 0 && s.wantPrice != null && s.price != null && Number(s.price) !== Number(s.wantPrice)) {
      actions.push({ venue: v, op: 'cancel', size: 0, reprice: true });
      actions.push({ venue: v, op: 'place', size: remaining });
      continue;
    }
    if (open > remaining) actions.push({ venue: v, op: 'resize', size: remaining });
    else if (open === 0 && !s.done) actions.push({ venue: v, op: 'place', size: remaining });
  }
  // Shrinks/cancels first: never add exposure before removing it.
  const rank = { cancel: 0, resize: 1, place: 2 };
  actions.sort((a, b) => rank[a.op] - rank[b.op]);
  return { remaining, over, filled, actions };
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
};
