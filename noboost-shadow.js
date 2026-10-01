// No-boost RFQ shadow quoter — classify, price, risk-check, LOG. NEVER sends.
//
// Contract: onRfq(rfq, {venue}) returns a decision object and (when a logger is
// supplied) prints one "[NOBOOST]" line per decision. There is no HTTP client,
// no createQuote, no confirm anywhere in this file or its imports. The master
// switch NOBOOST_SHADOW defaults OFF; NOBOOST_LIVE is read only to REFUSE to run.
//
// Scope (everything else is a counted skip):
//   • 2..maxLegs legs, every leg a full-game NFL MONEYLINE (Kalshi KXNFLGAME-… /
//     Polymarket aec-nfl-…),
//   • each leg in a DIFFERENT game (uncorrelated) — same game twice ⇒ skip,
//   • pregame only (kickoff from the book, ticker has no clock for NFL),
//   • priceable from fresh venue prices (never invents a price).
'use strict';
const { parseKalshiUnhedgedTicker, parsePmUnhedgedSlug } = require('./unhedged-rfq');
const { normTeam } = require('./leg-identity');
const { priceCombo, winsPrint, fmtAm, contractsFor, configFromEnv, isNoBoostShadow, isNoBoostLive } = require('./noboost-quote');
const { createRiskBook, riskConfigFromEnv } = require('./noboost-risk');

function splitKey(k) {
  const s = String(k || '');
  const i = s.lastIndexOf(':');
  if (i > 0 && /^(yes|no)$/i.test(s.slice(i + 1))) return { id: s.slice(0, i), side: s.slice(i + 1).toLowerCase() };
  return { id: s, side: 'yes' };
}

// Kalshi RFQ legs: normalizeRfq() gives legKeys 'TICKER:yes'. Raw API gives mve_selected_legs.
function kalshiLegInputs(rfq) {
  if (Array.isArray(rfq && rfq.legKeys) && rfq.legKeys.length) return rfq.legKeys.map(splitKey);
  const legs = (rfq && (rfq.legs || rfq.mve_selected_legs)) || [];
  return legs.map((l) => ({
    id: String(l.market_ticker || l.ticker || '').toUpperCase(),
    side: String(l.side || 'yes').toLowerCase() === 'no' ? 'no' : 'yes',
  }));
}

// Polymarket RFQ legs: aec-nfl-{a}-{b}-{date} with SIDE_BUY (long team = first slug team) / SIDE_SELL.
function polyLegInputs(rfq) {
  const legs = (rfq && (rfq.comboLegs || rfq.legs)) || [];
  return legs.map((l) => ({
    id: String(l.symbol || l.slug || '').toLowerCase(),
    side: /sell|no|short/i.test(String(l.side || '')) ? 'no' : 'yes',
  }));
}

// → { ok, legs:[{gameId,team,opp,id}], reason }
function classifyNfl(rfq, venue) {
  const inputs = venue === 'polymarket' ? polyLegInputs(rfq) : kalshiLegInputs(rfq);
  if (inputs.length < 2) return { ok: false, reason: 'not_combo' };
  const legs = [];
  const games = new Set();
  for (const inp of inputs) {
    const parsed = venue === 'polymarket'
      ? parsePmUnhedgedSlug(inp.id, 'yes')
      : parseKalshiUnhedgedTicker(inp.id, 'yes');
    if (!parsed) return { ok: false, reason: 'not_nfl_ml' };
    if (parsed.skip) return { ok: false, reason: parsed.reason || 'not_moneyline' };
    if (parsed.league !== 'nfl' || parsed.marketType !== 'moneyline') return { ok: false, reason: 'not_nfl_ml' };
    if (venue === 'kalshi' && !/^KXNFLGAME-/i.test(inp.id)) return { ok: false, reason: 'not_nfl_ml' };
    if (!parsed.gameId) return { ok: false, reason: 'no_game' };
    if (games.has(parsed.gameId)) return { ok: false, reason: 'correlated_same_game' };
    games.add(parsed.gameId);
    const teams = parsed.teams.map((t) => normTeam('nfl', t));
    let team;
    if (venue === 'polymarket') {
      // slug aec-nfl-{long}-{short}-date: BUY ⇒ long (first) team wins, SELL ⇒ the other.
      const toks = inp.id.split('-');
      const first = normTeam('nfl', toks[2]);
      const second = normTeam('nfl', toks[3]);
      team = inp.side === 'yes' ? first : second;
      if (!teams.includes(first) || !teams.includes(second)) return { ok: false, reason: 'poly_team_parse' };
    } else {
      const sel = normTeam('nfl', parsed.selection);
      const other = teams.find((t) => t !== sel);
      team = inp.side === 'yes' ? sel : other;
    }
    if (!team) return { ok: false, reason: 'team_parse' };
    legs.push({ gameId: parsed.gameId, team, id: inp.id });
  }
  return { ok: true, legs };
}

function createNoBoostShadow({
  book, env = process.env, now = () => Date.now(), log = console.log, risk = null,
} = {}) {
  if (isNoBoostLive(env)) {
    throw new Error('NOBOOST_LIVE is set but the no-boost quoter is paper-only; refusing to start');
  }
  const cfg = configFromEnv(env);
  const rk = risk || createRiskBook(riskConfigFromEnv(env), { now });
  const counts = {
    rfqs: 0, combo: 0, scope: 0, priceable: 0, would_quote: 0, risk_blocked: 0,
    pulled: 0, started: 0, flag_off: 0,
  };
  const skips = new Map();
  const bumpSkip = (r) => skips.set(r, (skips.get(r) || 0) + 1);

  function onRfq(rfq, { venue = 'kalshi' } = {}) {
    if (!isNoBoostShadow(env)) { counts.flag_off += 1; return { action: 'skip', reason: 'flag_off' }; }
    counts.rfqs += 1;
    const cls = classifyNfl(rfq, venue);
    if (!cls.ok) { bumpSkip(cls.reason); return { action: 'skip', reason: cls.reason }; }
    counts.scope += 1;
    const nowMs = now();
    for (const l of cls.legs) {
      const ko = book.kickoffMs(l.gameId);
      if (ko == null) { bumpSkip('no_kickoff'); return { action: 'skip', reason: 'no_kickoff' }; }
      if (ko <= nowMs) { counts.started += 1; bumpSkip('game_started'); return { action: 'skip', reason: 'game_started' }; }
    }
    const legsForPrice = cls.legs.map((l) => ({ ...l }));
    const util = rk.utilization(cls.legs);
    const priced = priceCombo(legsForPrice, book.source, { cfg, util, venue });
    if (!priced.ok) { bumpSkip(`price:${priced.reason}`); return { action: 'skip', reason: `price:${priced.reason}`, priced }; }
    counts.priceable += 1;

    const contracts = contractsFor({
      contracts: rfq.contracts != null ? Number(rfq.contracts) : (rfq.qtyDecimal != null ? Number(rfq.qtyDecimal) : 0),
      targetCostDollars: rfq.targetCostDollars != null ? Number(rfq.targetCostDollars)
        : (rfq.cashOrderQty != null ? Number(rfq.cashOrderQty) : 0),
    }, priced.quoteYes);
    const chk = rk.check(cls.legs, priced.quoteYes, contracts);
    const rfqId = rfq.rfqId || rfq.id;
    if (!chk.ok) {
      counts.risk_blocked += 1;
      bumpSkip(`risk:${chk.reason}`);
      log(`[NOBOOST] SKIP rfq=${rfqId} ${venue} legs=${cls.legs.length} risk=${chk.reason} fair=${fmtAm(priced.fair_american)} would=${fmtAm(priced.quote_american)}`);
      return { action: 'skip', reason: `risk:${chk.reason}`, priced };
    }
    counts.would_quote += 1;
    rk.registerQuote(rfqId, {
      venue, legs: cls.legs, quoteYes: priced.quoteYes, fair: priced.fair, contracts,
      guardrail: cfg.guardrail === 'lock',
    });
    log(
      `[NOBOOST] WOULD_QUOTE rfq=${rfqId} ${venue} legs=${cls.legs.length} `
      + `fair=${fmtAm(priced.fair_american)} lock=${fmtAm(priced.lock_american)} `
      + `quote=${fmtAm(priced.quote_american)}${priced.binding ? '(lock-bound)' : ''} `
      + `contracts=${contracts} maxloss=$${chk.loss.toFixed(2)} util=${util.toFixed(2)}`
    );
    return { action: 'would_quote', priced, contracts, legs: cls.legs, risk: chk };
  }

  // Re-price every open paper quote with the CURRENT book; pull those that went stale.
  function sweep() {
    const pulled = rk.sweepQuotes((q) => {
      const p = priceCombo(q.legs.map((l) => ({ ...l })), book.source, { cfg, util: 0, venue: q.venue });
      return p.ok ? { fair: p.fair, yLock: p.yLock } : null;
    });
    for (const p of pulled) {
      counts.pulled += 1;
      log(`[NOBOOST] PULL rfq=${p.rfqId} reason=${p.reason} was=${fmtAm(require('./engine').americanFromProb(p.quote.quoteYes))}`);
    }
    return pulled;
  }

  // Paper fill hook (only used by the backtester / a future live wiring).
  function onPaperFill(rfqId, legs, price, contracts) { return rk.addFill(rfqId, legs, price, contracts); }

  function summary() {
    return { counts: { ...counts }, skips: Object.fromEntries(skips), risk: rk.snapshot() };
  }

  return { onRfq, sweep, onPaperFill, summary, cfg, risk: rk, counts };
}

module.exports = { classifyNfl, createNoBoostShadow, kalshiLegInputs, polyLegInputs };
