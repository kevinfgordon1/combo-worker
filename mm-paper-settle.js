// Paper settlement. Turns a finished game into per-team payouts (1, 0, or a
// push value) from Kalshi market results, with Polymarket US resolution as a
// fallback. Pure helpers plus one read-only fetch. No orders.
'use strict';

const { groupKalshiMarkets } = require('./mm-paper-games');
const { identityFromMarket, normTeam } = require('./leg-identity');

function kalshiPayout(market) {
  if (!market) return null;
  const status = String(market.status || '').toLowerCase();
  if (status && status !== 'finalized' && status !== 'settled') return null;
  const result = String(market.result || '').trim().toLowerCase();
  if (result === 'yes') return 1;
  if (result === 'no') return 0;
  if (result === 'scalar') {
    const v = Number(market.settlement_value_dollars);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
  }
  return null;
}

// markets: finalized Kalshi markets. Returns Map gameId -> { payouts, source }.
function resultsByGame(markets, leagues) {
  const byTicker = new Map();
  for (const m of markets || []) if (m && m.ticker) byTicker.set(String(m.ticker).toUpperCase(), m);
  const out = new Map();
  for (const g of groupKalshiMarkets(markets || [], leagues)) {
    const payouts = {};
    let ok = true;
    for (const team of g.teams) {
      const t = g.kalshi[team];
      const payout = t ? kalshiPayout(byTicker.get(String(t.ticker).toUpperCase())) : null;
      if (payout == null) { ok = false; break; }
      payouts[team] = payout;
    }
    if (!ok) continue;
    const sum = g.teams.reduce((s, t) => s + payouts[t], 0);
    if (Math.abs(sum - 1) > 1e-6) continue; // inconsistent; do not settle on it
    out.set(g.gameId, { payouts, source: 'kalshi' });
  }
  return out;
}

function winnerOf(payouts) {
  const teams = Object.keys(payouts || {});
  const won = teams.filter((t) => payouts[t] === 1);
  if (won.length === 1) return won[0];
  return teams.length ? 'push' : null;
}

// Polymarket US market object -> { payouts, source } or null.
function polyResolution(market, game) {
  if (!market) return null;
  const resolved = String(market.status || '') === 'MARKET_STATUS_RESOLVED';
  if (!resolved) return null;
  let prices = market.outcomePrices;
  if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch (_) { prices = null; } }
  if (!Array.isArray(prices) || prices.length < 2) return null;
  const p = prices.slice(0, 2).map(Number);
  if (!p.every(Number.isFinite) || Math.abs(p[0] + p[1] - 1) > 1e-6) return null;
  const got = identityFromMarket(market, 'yes');
  const longTeam = got && got.identity ? normTeam(game.league, got.identity.selection) : null;
  if (!longTeam || !(game.teams || []).includes(longTeam)) return null;
  const shortTeam = game.teams.find((t) => t !== longTeam);
  return { payouts: { [longTeam]: p[0], [shortTeam]: p[1] }, source: 'polymarket' };
}

module.exports = { kalshiPayout, resultsByGame, winnerOf, polyResolution };
