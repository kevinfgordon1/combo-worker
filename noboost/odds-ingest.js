// Pure parser: Odds-API-shaped games (from the odds_cache row, a BACKGROUND source) ->
// per-team per-book raw quotes for book.setBooks. No I/O. Never used on the RFQ path.
'use strict';
const { teamCode, etDate } = require('../mm-paper-odds');
const { TRUSTED_BOOKS, EXCHANGES, EXCLUDED } = require('./promo-fair');

function gameEntries(games, { now = Date.now() } = {}) {
  const out = [];
  for (const g of games || []) {
    const date = etDate(g.commence_time);
    if (!date) continue;
    const per = new Map(); // team -> quotes
    let codes = null;
    for (const b of g.bookmakers || []) {
      const key = String(b.key).toLowerCase();
      if (EXCLUDED.includes(key) || !(TRUSTED_BOOKS[key] || EXCHANGES[key])) continue;
      const h2h = (b.markets || []).find((m) => m.key === 'h2h');
      if (!h2h || !h2h.outcomes || h2h.outcomes.length !== 2) continue;
      const cs = h2h.outcomes.map((o) => teamCode('nfl', o.name));
      if (cs.some((c) => !c) || cs[0] === cs[1]) continue;
      codes = codes || cs;
      const at = Date.parse(h2h.last_update || b.last_update || '') || now;
      h2h.outcomes.forEach((o, i) => {
        const a = Number(o.price); const oa = Number(h2h.outcomes[1 - i].price);
        if (!Number.isFinite(a) || !Number.isFinite(oa) || a === 0 || oa === 0) return;
        if (!per.has(cs[i])) per.set(cs[i], []);
        per.get(cs[i]).push({ book: key, american: a, oppAmerican: oa, at });
      });
    }
    if (!codes) continue;
    const gameId = `nfl|${date}|${[...codes].sort().join('+')}`;
    for (const [team, quotes] of per) out.push({ gameId, team, quotes });
  }
  return out;
}
module.exports = { gameEntries };
