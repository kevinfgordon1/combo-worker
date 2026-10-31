#!/usr/bin/env node
// Live capture of every NCAAB (men's college basketball) team name source, for the canonical team table
// (ncaab-teams.json, scripts/gen-ncaab-teams.js) and the unmatched-name check (scripts/check-ncaab-teams.js).
// Read-only public endpoints, plus the Odds API key from env (ODDS_API_KEY, never printed) when present.
//   espn:      teams?groups=50 (D1 list) + groups=50 scoreboard for the next N days (tip-time context)
//   kalshi:    KXNCAAMBGAME / KXNCAAMBSPREAD / KXNCAAMBTOTAL events (team codes + names), KXMARMAD (champion)
//   polymarket US: /v2/leagues/cbb/events (games, team abbreviation + name) + the cbb-champ-* futures event
//   novig:     public catalog events (league NCAAB)
//   prophetx:  through the odds relay only (/stream?venue=prophetx&league=NCAAB); the key never leaves the relay
//   underdog:  CBB match_grouped_lines (games + teams)
//   oddsapi:   basketball_ncaab events (free) + participants; basketball_ncaab_championship_winner outrights
//              (sportsbook futures names, by bookmaker)
'use strict';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const POLY = 'https://gateway.polymarket.us';
const NOVIG = 'https://api.novig.com';
const UNDERDOG = 'https://api.underdogfantasy.com';
const ODDS = 'https://api.the-odds-api.com/v4';
const RELAY = process.env.ODDS_RELAY_URL || 'https://kaygo-odds-relay.fly.dev';

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const etYmd = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const redact = (u) => String(u).replace(/apiKey=[^&]+/, 'apiKey=***');

async function getJson(url, opts = {}) {
  for (let i = 0; i < 6; i += 1) {
    let r;
    try { r = await fetch(url, { headers: { accept: 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeoutMs || 20000) }); } catch (e) {
      if (i === 5) throw new Error(`${e.message} ${redact(url)}`);
      await sleep(1000 * (i + 1)); continue;
    }
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
    if (!r.ok) throw new Error(`${r.status} ${redact(url)}`);
    return r.json();
  }
  throw new Error(`retries exhausted ${redact(url)}`);
}

const slimEspnTeam = (t) => ({
  espnId: String(t.id), abbr: String(t.abbreviation || '').toUpperCase(), location: t.location || '',
  short: t.shortDisplayName || '', display: t.displayName || '', name: t.name || '',
  conferenceId: t.conferenceId != null ? String(t.conferenceId) : null,
});

async function captureEspn(days) {
  const list = await getJson(`${ESPN}/teams?groups=50&limit=500`);
  const teams = list.sports[0].leagues[0].teams.map(({ team }) => slimEspnTeam(team));
  const games = []; const scoreboardTeams = new Map();
  for (let d = -1; d < days; d += 1) {
    const ymd = etYmd(Date.now() + d * 864e5).replace(/-/g, '');
    const body = await getJson(`${ESPN}/scoreboard?groups=50&limit=500&dates=${ymd}`);
    for (const e of body.events || []) {
      const c = (e.competitions && e.competitions[0]) || {};
      const side = (ha) => (c.competitors || []).find((x) => x.homeAway === ha) || {};
      const h = side('home').team || {}; const a = side('away').team || {};
      for (const t of [h, a]) if (t.id && !scoreboardTeams.has(String(t.id))) scoreboardTeams.set(String(t.id), slimEspnTeam(t));
      games.push({ id: String(e.id), date: e.date, neutral: !!c.neutralSite, homeId: String(h.id || ''), awayId: String(a.id || ''), home: h.displayName || '', away: a.displayName || '' });
    }
  }
  return { teams, scoreboardTeams: [...scoreboardTeams.values()], games };
}

async function kalshiSeries(series, status = 'open', maxPages = 30) {
  const out = []; let cursor = '';
  for (let p = 0; p < maxPages; p += 1) {
    const j = await getJson(`${KALSHI}/events?series_ticker=${series}&status=${status}&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...(j.events || []).map((e) => ({
      series, event_ticker: e.event_ticker, title: e.title, sub_title: e.sub_title || '',
      markets: (e.markets || []).map((m) => ({ ticker: m.ticker, yes_sub_title: m.yes_sub_title || '', no_sub_title: m.no_sub_title || '', occ: m.expected_expiration_time || m.occurrence_datetime || null, teamId: (m.custom_strike && m.custom_strike.basketball_team) || null })),
    })));
    cursor = j.cursor; if (!cursor) break;
    await sleep(500);
  }
  return out;
}

async function kalshiSettledMarkets(series, maxPages = 30) {
  const byEvent = new Map(); let cursor = '';
  for (let p = 0; p < maxPages; p += 1) {
    const j = await getJson(`${KALSHI}/historical/markets?series_ticker=${series}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const m of j.markets || []) {
      const e = byEvent.get(m.event_ticker) || byEvent.set(m.event_ticker, { event_ticker: m.event_ticker, markets: [] }).get(m.event_ticker);
      e.markets.push({ ticker: m.ticker, yes_sub_title: m.yes_sub_title || '', teamId: (m.custom_strike && m.custom_strike.basketball_team) || null });
    }
    cursor = j.cursor; if (!cursor) break;
    await sleep(400);
  }
  return [...byEvent.values()];
}

async function capturePoly() {
  const games = new Map();
  for (let off = 0; off < 3000; off += 80) {
    const j = await getJson(`${POLY}/v2/leagues/cbb/events?limit=80&offset=${off}&active=true&closed=false`);
    for (const e of j.events || []) {
      if (!/^cbb-/.test(String(e.slug || '')) || /^cbb-champ/.test(e.slug)) continue;
      const m = (e.markets || []).find((x) => x.sportsMarketType === 'basketball_team_full_game_winner') || (e.markets || [])[0];
      const sides = ((m && m.marketSides) || []).map((s) => ({
        name: s.team && s.team.name, safeName: s.team && s.team.safeName, alias: s.team && s.team.alias, abbreviation: s.team && s.team.abbreviation,
        displayAbbreviation: s.team && s.team.displayAbbreviation, teamId: s.team && s.team.id != null ? String(s.team.id) : null, ordering: s.team && s.team.ordering,
      }));
      games.set(e.slug, { slug: e.slug, title: e.title, startTime: (m && m.gameStartTime) || e.startTime || null, sides });
    }
    if ((j.events || []).length < 80) break;
    await sleep(1200);
  }
  let champ = [];
  try {
    const list = await getJson(`${POLY}/v2/leagues/cbb/events?type=futures&limit=100&active=true&closed=false`);
    const ev = (list.events || []).find((e) => /^cbb-champ-/.test(e.slug || '') && !e.closed);
    if (ev) {
      const full = await getJson(`${POLY}/v1/events/slug/${encodeURIComponent(ev.slug)}`);
      champ = ((full.event || full).markets || []).map((m) => {
        const s = (m.marketSides || []).find((x) => x.long) || {}; const t = s.team || {};
        return { slug: m.slug, name: t.name || null, safeName: t.safeName || null, alias: t.alias || null, abbreviation: t.abbreviation || null, teamId: t.id != null ? String(t.id) : null, question: m.question || m.title || null };
      });
    }
  } catch (e) { champ = { error: e.message }; }
  return { games: [...games.values()], champ };
}

async function captureNovig() {
  const out = []; let after = '';
  for (let p = 0; p < 20; p += 1) {
    const j = await getJson(`${NOVIG}/v3/public/catalog/events?league=NCAAB&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    const items = j.items || [];
    out.push(...items.map((e) => ({ eventId: e.eventId, description: e.description, startsTs: e.startsTs, status: e.status })));
    after = j.nextCursor || j.cursor || (j.pageInfo && j.pageInfo.endCursor) || '';
    if (!after || items.length < 100) break;
  }
  return out;
}

// SSE snapshot read from the relay (first quote packet), then disconnect.
async function relaySnapshot(venue, league, timeoutMs = 8000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${RELAY}/stream?venue=${venue}&league=${league}`, { signal: ctl.signal });
    if (!r.ok) return { error: `${r.status}` };
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      const m = buf.match(/event: quote\ndata: (.+)\n/);
      if (m) { ctl.abort(); const d = JSON.parse(m[1]); return { quotes: ((d.payload && d.payload.quotes) || []).map((q) => ({ away: q.away, home: q.home, side: q.side, start: q.start, ticker: q.ticker || null })) }; }
    }
    return { quotes: [] };
  } catch (e) { return ctl.signal.aborted ? { quotes: [], note: 'no snapshot within timeout' } : { error: e.message }; } finally { clearTimeout(t); }
}

async function captureUnderdog() {
  const q = new URLSearchParams({
    include_live: 'true', match_limit: '500', product: 'fantasy', product_experience_id: 'b34dfd93-d0e8-4da3-8bf4-45c15c548dec',
    show_more_picks_cta: 'false', sport_id: 'CBB', state_config_id: 'f8996742-f10c-4d32-955a-dcbcaa5dc5c0',
  });
  q.append('market_categories[]', 'core');
  const j = await getJson(`${UNDERDOG}/v1/lobbies/content/match_grouped_lines?${q}`, { headers: { 'client-type': 'web', 'client-version': '20260918170103' } });
  const teams = Object.values(j.teams || {}).map((t) => ({ id: t.id, abbr: t.abbr, locality: t.locality || '', name: t.name || '', sport_id: t.sport_id }));
  const games = (Array.isArray(j.games) ? j.games : Object.values(j.games || {})).filter((g) => String(g.sport_id).toUpperCase() === 'CBB')
    .map((g) => ({ id: g.id, title: g.title, full: g.full_team_names_title, scheduled_at: g.scheduled_at, home_team_id: g.home_team_id, away_team_id: g.away_team_id }));
  return { teams, games };
}

async function captureOddsApi() {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { error: 'ODDS_API_KEY not set' };
  const out = {};
  const ev = await getJson(`${ODDS}/sports/basketball_ncaab/events?apiKey=${key}`);
  out.events = ev.map((e) => ({ id: e.id, home: e.home_team, away: e.away_team, commence: e.commence_time }));
  try { out.participants = (await getJson(`${ODDS}/sports/basketball_ncaab/participants?apiKey=${key}`)).map((p) => p.full_name); } catch (e) { out.participants = { error: e.message }; }
  try {
    const fut = await getJson(`${ODDS}/sports/basketball_ncaab_championship_winner/odds?apiKey=${key}&regions=us,us2&markets=outrights&oddsFormat=american`);
    const books = {};
    for (const e of fut) for (const b of e.bookmakers || []) for (const m of b.markets || []) for (const o of m.outcomes || []) (books[b.key] = books[b.key] || []).push(o.name);
    out.futures = books;
  } catch (e) { out.futures = { error: e.message }; }
  return out;
}

async function captureAll(opts = {}) {
  const { days = 21, log = () => {} } = opts;
  const at = new Date().toISOString();
  const step = async (name, fn) => { try { const v = await fn(); log(`${name}: ok`); return v; } catch (e) { log(`${name}: ${e.message}`); return { error: e.message }; } };
  const espn = await step('espn', () => captureEspn(days));
  const kalshi = {};
  for (const s of ['KXNCAAMBGAME', 'KXNCAAMBSPREAD', 'KXNCAAMBTOTAL', 'KXMARMAD']) kalshi[s] = await step(`kalshi ${s}`, () => kalshiSeries(s));
  // last season's settled games (Kalshi moves them to /historical/markets): Kalshi codes for teams
  // with no open game yet
  if (!opts.noHistory) kalshi.KXNCAAMBGAME_settled = await step('kalshi KXNCAAMBGAME settled', () => kalshiSettledMarkets('KXNCAAMBGAME'));
  const polymarket = await step('polymarket', capturePoly);
  const novig = await step('novig', captureNovig);
  const prophetx = await step('prophetx(relay)', () => relaySnapshot('prophetx', 'NCAAB'));
  const underdog = await step('underdog', captureUnderdog);
  const oddsapi = await step('oddsapi', captureOddsApi);
  return { capturedAt: at, espn, kalshi, polymarket, novig, prophetx, underdog, oddsapi };
}

module.exports = { captureAll, getJson };

if (require.main === module) {
  const fs = require('fs');
  const outPath = (process.argv.find((a) => a.startsWith('--out=')) || '--out=/tmp/ncaab-capture.json').split('=')[1];
  captureAll({ log: (m) => console.error(m) }).then((c) => { fs.writeFileSync(outPath, JSON.stringify(c)); console.error(`wrote ${outPath}`); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
