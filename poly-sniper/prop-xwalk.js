// Live NFL anytime-TD player crosswalk for the Polymarket sniper dry run.
// The checked-in player-prop-crosswalk.json is a one-time snapshot (Week 5), so this week's
// KXNFLTD tickers and astatc-nfl-…-td-… slugs were never in it -> every TD leg was unmatched.
// This rebuilds the SAME verified crosswalk (scripts/gen-prop-crosswalk.js buildPropCrosswalk:
// same game, same team, same full name, no duplicates) from PUBLIC data only:
//   Kalshi  GET /trade-api/v2/events?series_ticker=KXNFLTD&with_nested_markets=true (no key)
//   Poly US GET gateway.polymarket.us/v2/leagues/nfl/events + /v1/events/slug/{slug} (no key)
// Read-only GETs; no Polymarket key, no trading client.
'use strict';
const { buildPropCrosswalk } = require('../scripts/gen-prop-crosswalk');
const PROPX = require('../player-prop-crosswalk');

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const POLY_GW = 'https://gateway.polymarket.us';

function polyEventShape(e) {
  return {
    slug: e.slug, startTime: e.startTime,
    teams: (e.teams || []).map((t) => ({ id: t.id, abbreviation: t.abbreviation })),
    markets: (e.markets || []).filter((m) => m.sportsMarketType === 'football_player_touchdowns')
      .map((m) => ({ slug: m.slug, sportsMarketType: m.sportsMarketType, line: m.line, gameStartTime: m.gameStartTime, metadata: m.metadata })),
  };
}

// getJson(url) -> parsed JSON (caller supplies rate limiting). -> { idx, players, unmatchedKalshi }
async function fetchLiveTdCrosswalk(getJson) {
  const events = []; let cursor = '';
  for (let p = 0; p < 10; p += 1) {
    const j = await getJson(`${KALSHI}/events?series_ticker=KXNFLTD&status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    events.push(...((j && j.events) || [])); cursor = j && j.cursor; if (!cursor) break;
  }
  const kalshi = { KXNFLTD: events.map((e) => ({ event_ticker: e.event_ticker, markets: (e.markets || []).map((m) => ({ ticker: m.ticker, yes_sub_title: m.yes_sub_title })) })) };
  const poly = {};
  const l = await getJson(`${POLY_GW}/v2/leagues/nfl/events?limit=80&active=true&closed=false`);
  for (const ev of (l && l.events) || []) {
    try {
      const d = await getJson(`${POLY_GW}/v1/events/slug/${encodeURIComponent(ev.slug)}`);
      const e = d && (d.event || d);
      if (e && e.slug) poly[e.slug] = polyEventShape(e);
    } catch (_) { /* one game missing just leaves its players unmapped */ }
  }
  const xw = buildPropCrosswalk(kalshi, poly);
  const players = xw.players.filter((p) => p.league === 'nfl' && p.kind === 'td');
  return { idx: PROPX.index(players), players, unmatchedKalshi: xw.unmatchedKalshi.length, kalshiEvents: events.length, polyEvents: Object.keys(poly).length };
}

module.exports = { fetchLiveTdCrosswalk, polyEventShape };
