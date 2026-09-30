#!/usr/bin/env node
// Read-only settled-P&L report from the mm_paper_events tape.
//   node scripts/mm-paper-backfill-report.js [--since=2026-09-25] [--json]
// Needs SUPABASE_URL + SUPABASE_SERVICE_KEY (read only) or MM_LOG_PATH JSONL.
// Rebuilds every game's lots from fills/pairs/exits, looks up final results
// (Kalshi finalized markets, Polymarket US resolution as fallback), and
// prints realized P&L split headline vs legacy (pre-cutoff-logic rows).
// Writes nothing. The live service writes `settle` rows on its own.
'use strict';

const { createClient } = require('@supabase/supabase-js');
const { loadPaperHistory, replayPaperEvents } = require('../mm-paper-state');
const { createKalshiReader, listKalshiSettled, createPolyReader } = require('../mm-paper-feed');
const { resultsByGame, polyResolution, winnerOf } = require('../mm-paper-settle');
const { polySlugCandidates } = require('../mm-paper-games');

const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;

async function run(argv = process.argv, env = process.env, deps = {}) {
  const args = argv.slice(2);
  const since = (args.find((a) => a.startsWith('--since=')) || '--since=2026-09-20').split('=')[1];
  const asJson = args.includes('--json');
  const supabase = deps.supabase !== undefined ? deps.supabase : (
    env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY
      ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
      : null
  );
  const history = await loadPaperHistory({ supabase, filePath: env.MM_LOG_PATH || 'mm-paper.jsonl' });
  const games = replayPaperEvents(history.events);
  const kalshi = deps.kalshi || createKalshiReader();
  const markets = await listKalshiSettled(kalshi, ['nfl'], { sinceMs: Date.parse(`${since}T00:00:00Z`) });
  const results = resultsByGame(markets, new Set(['nfl']));
  const poly = deps.poly !== undefined ? deps.poly : createPolyReader({});
  const rows = [];
  for (const g of games.values()) {
    if (g.settled) continue; // service already wrote a settle row
    let res = results.get(g.gameId);
    if (!res && poly) {
      for (const slug of polySlugCandidates(g)) {
        try {
          const r = polyResolution(await poly.market(slug), g);
          if (r) { res = r; break; }
        } catch (_) { /* next */ }
      }
    }
    let settle = 0;
    let legacySettle = 0;
    let open = 0;
    let known = !!res;
    if (res) {
      for (const lot of g.lots) {
        if (!(lot.qty > 1e-9)) continue;
        const pnl = lot.qty * ((res.payouts[lot.team] == null ? 0 : res.payouts[lot.team]) - lot.net);
        if (lot.legacy) legacySettle += pnl; else settle += pnl;
      }
    } else {
      open = g.lots.reduce((s, l) => s + Math.max(0, l.qty), 0);
    }
    rows.push({
      gameId: g.gameId,
      settled: known,
      winner: res ? winnerOf(res.payouts) : null,
      source: res ? res.source : null,
      locked: g.lockedPnl,
      exit: g.exitPnl,
      settle,
      realized: known ? g.lockedPnl + g.exitPnl + settle : null,
      legacy: g.legacyLockedPnl + g.legacyExitPnl + legacySettle,
      openQty: open,
    });
  }
  rows.sort((a, b) => a.gameId.localeCompare(b.gameId));
  const done = rows.filter((r) => r.settled);
  const tot = (k) => done.reduce((s, r) => s + r[k], 0);
  const summary = {
    games: rows.length,
    settledGames: done.length,
    unsettledGames: rows.length - done.length,
    headlineRealized: tot('realized'),
    headlineLocked: tot('locked'),
    headlineExit: tot('exit'),
    headlineSettle: tot('settle'),
    legacyRealized: tot('legacy'),
  };
  if (asJson) console.log(JSON.stringify({ summary, rows }, null, 2));
  else {
    for (const r of rows) {
      console.log(`${r.gameId} ${r.settled ? `winner=${r.winner}(${r.source})` : 'UNSETTLED'} locked=${money(r.locked)} `
        + `exit=${money(r.exit)} settle=${money(r.settle)} realized=${r.realized == null ? 'n/a' : money(r.realized)} legacy=${money(r.legacy)} open=${r.openQty}`);
    }
    console.log(`TOTAL settled=${summary.settledGames}/${summary.games} headlineRealized=${money(summary.headlineRealized)} `
      + `(locked ${money(summary.headlineLocked)} exit ${money(summary.headlineExit)} settle ${money(summary.headlineSettle)}) `
      + `legacyRealized(excluded)=${money(summary.legacyRealized)}`);
  }
  return { summary, rows };
}

if (require.main === module) {
  run().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
}

module.exports = { run };
