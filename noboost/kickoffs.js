// Pure parsers: real NFL kickoff times for the no-boost book (background only, never on the RFQ path).
//   espnKickoffs(scoreboardJson)  -> [{ gameId, kickoffMs, state, source:'espn' }]
//     site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard (state pre|in|post)
//   oddsKickoffs(oddsCacheGames)  -> [{ gameId, kickoffMs, source:'odds_cache' }]
//     odds_cache.data[] (Odds-API shape: commence_time + h2h outcome names)
// gameId matches parseKalshiUnhedgedTicker: nfl|<ET date>|<codes sorted, joined by +>.
'use strict';
const { teamCode, etDate } = require('../mm-paper-odds');

function gid(iso, names) {
  const date = etDate(iso);
  const codes = names.map((n) => teamCode('nfl', n));
  if (!date || codes.length !== 2 || codes.some((c) => !c) || codes[0] === codes[1]) return null;
  return `nfl|${date}|${[...codes].sort().join('+')}`;
}

function espnKickoffs(j) {
  const out = [];
  for (const e of (j && j.events) || []) {
    const c = e.competitions && e.competitions[0];
    const names = ((c && c.competitors) || []).map((x) => x.team && (x.team.displayName || x.team.name));
    const iso = (c && c.date) || e.date;
    const ms = Date.parse(iso || '');
    const gameId = gid(iso, names);
    if (!gameId || !Number.isFinite(ms)) continue;
    const st = e.status && e.status.type;
    const state = st && ['pre', 'in', 'post'].includes(st.state) ? st.state : null;
    out.push({ gameId, kickoffMs: ms, state, source: 'espn' });
  }
  return out;
}

function oddsKickoffs(games) {
  const out = [];
  for (const g of games || []) {
    const ms = Date.parse(g.commence_time || '');
    let names = [g.home_team, g.away_team].filter(Boolean);
    if (names.length !== 2) {
      for (const b of g.bookmakers || []) {
        const h = (b.markets || []).find((m) => m.key === 'h2h');
        if (h && h.outcomes && h.outcomes.length === 2) { names = h.outcomes.map((o) => o.name); break; }
      }
    }
    const gameId = gid(g.commence_time, names);
    if (!gameId || !Number.isFinite(ms)) continue;
    out.push({ gameId, kickoffMs: ms, source: 'odds_cache' });
  }
  return out;
}

module.exports = { espnKickoffs, oddsKickoffs };
