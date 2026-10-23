// Polymarket US full-game spreads + totals (NFL, college) for the odds relay: pure helpers.
// The relay (odds-relay.js startPolymarketUs, RELAY_POLY_LINES=1) finds strikes on the public event
// page (GET /v1/events/slug/{slug}, low rate) and streams their books over the SAME read-only
// market-data socket used for moneylines / TD. No orders, no new keys.
// Slug semantics (verified against the market descriptions, same as leg-identity.js):
//   asc-…-pos-6pt5 (line +6.5): long (Yes) = FIRST slug team +6.5, short = second team −6.5
//   asc-…-neg-6pt5 (line −6.5): long = FIRST team −6.5,           short = second team +6.5
//   tsc-…-total-44pt5:          long = Over 44.5,                 short = Under 44.5
// Per event we keep the POLY_LINES_PER_EVENT (default 3) most balanced spread strikes and the same
// number of total strikes (closest mid to 0.5). is_alt=false only on the most balanced one;
// consumers (Combo Sniper) take the main line from Novig/ProphetX and use Polymarket only on the
// exact same number.
'use strict';
const TYPES = { football_team_full_game_spread: 'spread', football_team_full_game_total: 'total' };
const DEPTH_LEVELS = 25;
const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const money = (q) => { const v = Number(q && (q.value != null ? q.value : q)); return Number.isFinite(v) ? v : null; };
const r4 = (x) => Math.round(x * 1e4) / 1e4;

function inWindow(ev, nowMs, days = 8) {
  const s = Date.parse(ev && (ev.startTime || ev.startDate || '')); if (!Number.isFinite(s)) return false;
  return ev.live !== true && ev.closed !== true && s > nowMs && s < nowMs + days * 864e5;
}

// event (from /v1/events/slug) -> [{ slug, league, betType, line, start, away, home, yes:{side,line,abbr}, no:{...}, mid }]
function lineMarketsFromEvent(ev, league, perEvent = 3) {
  const out = [];
  const start = (ev && (ev.startTime || ev.startDate)) || null;
  // Event teams (away/home) from any market side that carries a team (totals' sides do not).
  const evTeam = {};
  for (const m of (ev && ev.markets) || []) for (const s of (m && m.marketSides) || []) { const t = s && s.team; const o = String((t && t.ordering) || '').toLowerCase(); if (t && t.name && (o === 'away' || o === 'home') && !evTeam[o]) evTeam[o] = t; }
  // Fallback (college events carry no ordering): event slug {league}-{first}-{second}-date, first = away.
  const sm = /^[a-z]+-([a-z0-9]+)-([a-z0-9]+)-\d{4}-\d\d-\d\d$/.exec(String((ev && ev.slug) || ''));
  const byAbbr = (a) => ((ev && ev.teams) || []).find((t) => t && String(t.abbreviation || '').toLowerCase() === a);
  if (sm && byAbbr(sm[1]) && byAbbr(sm[2]) && sm[1] !== sm[2]) { evTeam.away = byAbbr(sm[1]); evTeam.home = byAbbr(sm[2]); }
  const first = evTeam.away; const second = evTeam.home;
  for (const m of (ev && ev.markets) || []) {
    const bt = TYPES[String(m && m.sportsMarketType || '').toLowerCase()];
    if (!bt || m.closed === true || m.active === false) continue;
    const line = Number(m.line); if (!Number.isFinite(line) || Math.abs((line * 2) % 2) !== 1) continue; // x.5 only
    const sides = m.marketSides || [];
    const L = sides.find((s) => s && s.long === true); const S = sides.find((s) => s && s.long === false);
    if (!L || !S) continue;
    const tm = (s) => (s && s.team) || {};
    const A = evTeam.away; const H = evTeam.home;
    if (!A || !H || A.name === H.name) continue;
    const bid = money(m.bestBidQuote); const ask = money(m.bestAskQuote);
    const mid = bid != null && ask != null ? (bid + ask) / 2 : (bid != null ? bid : ask);
    let yes; let no;
    if (bt === 'spread') {
      // long = FIRST slug team (asc-{lg}-{first}-{second}-date-pos|neg-…); team on the side wins when present.
      const lt = tm(L).name ? tm(L) : first; const stt = tm(S).name ? tm(S) : (lt === first ? second : first);
      if (!lt || !stt || !lt.name || !stt.name || lt.name === stt.name) continue;
      yes = { side: lt.name, abbr: lt.abbreviation || null, line };
      no = { side: stt.name, abbr: stt.abbreviation || null, line: -line };
    } else { yes = { side: 'Over', line }; no = { side: 'Under', line }; }
    out.push({ slug: String(m.slug), league, betType: bt, line, start: m.gameStartTime || start, away: A.name, home: H.name, awayAbbr: A.abbreviation || null, homeAbbr: H.abbreviation || null, yes, no, mid });
  }
  const pick = [];
  for (const bt of ['spread', 'total']) {
    const xs = out.filter((x) => x.betType === bt && x.mid != null).sort((a, b) => Math.abs(a.mid - 0.5) - Math.abs(b.mid - 0.5)).slice(0, perEvent);
    xs.forEach((x, i) => pick.push({ ...x, isAlt: i !== 0 }));
  }
  return pick;
}

// book (/v1/markets/{slug}/book marketData) -> { yes:[{odds,size}], no:[{odds,size}] } (cheapest first; size = contracts)
function laddersFromBook(md) {
  const rows = (a, flip) => (a || []).map((r) => ({ p: money(r && r.px), q: Number(r && r.qty) }))
    .filter(({ p, q }) => p > 0 && p < 1 && q > 0).map(({ p, q }) => ({ odds: flip ? r4(1 - p) : p, size: q }))
    .sort((a, b) => a.odds - b.odds).slice(0, DEPTH_LEVELS);
  return { yes: rows(md && md.offers, false), no: rows(md && md.bids, true) };
}

// meta + ladders -> two relay /board-shaped quotes
function quotesFor(meta, ld, atMs) {
  const updated = new Date(atMs).toISOString();
  const q = (s, lv, tag) => (lv.length ? {
    book: 'polymarket', league: meta.league, away: meta.away, home: meta.home, away_abbr: meta.awayAbbr, home_abbr: meta.homeAbbr,
    side: s.side, side_abbr: s.abbr || null, side_type: meta.betType === 'total' ? s.side : undefined, bet_type: meta.betType, line: s.line,
    odds: lv[0].odds, size: lv[0].size, depth: lv, is_alt: meta.isAlt, is_live: false, start: meta.start,
    updated_at: updated, token_id: `us:${meta.slug}:${tag}`, market_id: meta.slug, feed: 'polymarket-us-lines',
  } : null);
  return [q(meta.yes, ld.yes, 'yes'), q(meta.no, ld.no, 'no')].filter(Boolean);
}

module.exports = { lineMarketsFromEvent, laddersFromBook, quotesFor, inWindow };
