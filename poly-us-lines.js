// Polymarket US full-game spreads + totals (NFL, college) for the odds relay. PUBLIC read-only
// gateway endpoints only (no keys, no orders):
//   GET /v2/leagues/{nfl|cfb}/events   -> event slugs (in window, not live)
//   GET /v1/events/slug/{slug}        -> every market of the event (spread / total ladders)
//   GET /v1/markets/{slug}/book       -> full book (bids / offers with qty)
// Slug semantics (verified against the market descriptions, same as leg-identity.js):
//   asc-…-pos-6pt5 (line +6.5): long (Yes) = FIRST slug team +6.5, short = second team −6.5
//   asc-…-neg-6pt5 (line −6.5): long = FIRST team −6.5,           short = second team +6.5
//   tsc-…-total-44pt5:          long = Over 44.5,                 short = Under 44.5
// Per event we keep the POLY_LINES_PER_EVENT (default 3) most balanced spread strikes and the same
// number of total strikes (closest mid to 0.5). is_alt=false only on the most balanced one;
// consumers (Combo Sniper) take the main line from Novig/ProphetX and use Polymarket only on the
// exact same number. Books are refreshed round-robin, soonest kickoff first, at POLY_LINES_RPS.
'use strict';
const GATEWAY = 'https://gateway.polymarket.us';
const LEAGUE_PATH = { NFL: 'nfl', NCAAF: 'cfb' };
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

function createPolyUsLines({ env = process.env, fetchFn = fetch, now = () => Date.now(), log = console.log } = {}) {
  // Public gateway rate-limits ~5+ req/s (429 seen at 10/s), so a full cycle of ~120 books takes ~30s+; books older than a consumer's staleness limit simply drop out there. A 429 pauses 30s.
  const perEvent = num(env.POLY_LINES_PER_EVENT, 1);
  const rps = num(env.POLY_LINES_RPS, 4);
  const days = num(env.POLY_LINES_DAYS, 3);
  const maxInflight = num(env.POLY_LINES_INFLIGHT, 2);
  let inflight = 0; let pausedUntil = 0;
  const discoverMs = num(env.POLY_LINES_DISCOVER_MS, 5 * 60 * 1000);
  const catalog = new Map(); // slug -> meta
  const quotes = new Map(); // slug -> { at, rows }
  const st = { discoveredAt: 0, events: { NFL: 0, NCAAF: 0 }, markets: { NFL: 0, NCAAF: 0 }, books: 0, errors: 0, lastError: null };
  let stopped = false; let timer = null; let order = []; let cursor = 0;
  const getJson = async (path) => {
    const r = await fetchFn(`${GATEWAY}${path}`, { headers: { accept: 'application/json' } });
    if (r.status === 429) { pausedUntil = now() + 30000; st.rateLimited = (st.rateLimited || 0) + 1; }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${path.split('?')[0]}`);
    return r.json();
  };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  async function discover() {
    const next = new Map();
    for (const league of Object.keys(LEAGUE_PATH)) {
      let evs = [];
      try { const j = await getJson(`/v2/leagues/${LEAGUE_PATH[league]}/events?limit=200&active=true&closed=false`); evs = (j && j.events) || []; } catch (e) { st.errors += 1; st.lastError = e.message; continue; }
      const slugs = evs.filter((ev) => ev && ev.slug && inWindow(ev, now(), days)).map((ev) => String(ev.slug));
      st.events[league] = slugs.length; let n = 0;
      for (const s of slugs) {
        if (stopped) return;
        try {
          const j = await getJson(`/v1/events/slug/${encodeURIComponent(s)}`);
          for (const m of lineMarketsFromEvent((j && j.event) || j, league, perEvent)) { next.set(m.slug, m); n += 1; }
        } catch (e) { st.errors += 1; st.lastError = e.message; }
        await sleep(250); // discovery is gentle (every 5 min)
      }
      st.markets[league] = n;
    }
    if (next.size) {
      catalog.clear(); for (const [k, v] of next) catalog.set(k, v);
      for (const k of [...quotes.keys()]) if (!catalog.has(k)) quotes.delete(k);
      order = [...catalog.values()].sort((a, b) => (Date.parse(a.start || '') || 0) - (Date.parse(b.start || '') || 0)).map((m) => m.slug);
      cursor = 0;
    }
    st.discoveredAt = now();
  }
  async function pollOne() {
    if (!order.length) return;
    const slug = order[cursor % order.length]; cursor += 1;
    const meta = catalog.get(slug); if (!meta) return;
    try {
      const j = await getJson(`/v1/markets/${encodeURIComponent(slug)}/book`);
      quotes.set(slug, { at: now(), rows: quotesFor(meta, laddersFromBook(j && j.marketData), now()) }); st.books += 1;
    } catch (e) { st.errors += 1; st.lastError = e.message; }
  }
  async function loop() {
    while (!stopped) {
      try {
        if (now() < pausedUntil) { await sleep(1000); continue; }
        if (!st.discoveredAt || now() - st.discoveredAt > discoverMs) await discover();
        if (inflight < maxInflight) { inflight += 1; pollOne().finally(() => { inflight -= 1; }); }
      } catch (e) { st.errors += 1; st.lastError = e.message; }
      await sleep(1000 / rps);
    }
  }
  return {
    start() { log(`[odds-relay] polymarket us lines ON (public gateway, ${rps} req/s, ${perEvent} strikes/event/type)`); loop(); return () => { stopped = true; if (timer) clearTimeout(timer); }; },
    rows(league) { const L = String(league || '').toUpperCase(); const out = []; for (const [slug, v] of quotes) { const m = catalog.get(slug); if (m && m.league === L) out.push(...v.rows); } return out; },
    status() { const c = { NFL: 0, NCAAF: 0 }; for (const m of catalog.values()) c[m.league] += 1; return { ...st, catalog: c, cycleMs: order.length ? Math.round(order.length * 1000 / rps) : null }; },
    _discover: discover, _pollOne: pollOne,
  };
}

module.exports = { createPolyUsLines, lineMarketsFromEvent, laddersFromBook, quotesFor, inWindow };
