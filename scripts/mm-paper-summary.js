#!/usr/bin/env node
// Summarize a paper market-making JSONL log.
//   node scripts/mm-paper-summary.js [path]
//   MM_LOG_PATH=mm-paper.jsonl node scripts/mm-paper-summary.js
//
// Fills and pairs are split pregame / ingame using the event phase, or the
// kickoff stamped on the tape (cutoff = kickoff - buffer). Unpaired lots are
// rebuilt from fills and pairs. When Kalshi has a final `result`, leftover
// contracts are settled into net P&L. Prices are American odds.
//   MM_PAPER_SETTLE=0 skips the Kalshi result lookup.
//   node scripts/mm-paper-summary.js --compare [path]
//     Rebuilds open lots from every fill and pair and prints them next to the
//     openPositions the live engine stamped on the latest event. Read-only.
//     When SUPABASE_URL and SUPABASE_SERVICE_KEY are set, the tape is read
//     from mm_paper_events (no writes). Otherwise the JSONL file is used.
'use strict';

const fs = require('fs');
const { priceView } = require('../mm-paper-math');
const {
  replayPaperEvents,
  countHistoryEvent,
  compareReplayToSnapshots,
  loadPaperHistory,
  isLegacyEvent,
} = require('../mm-paper-state');

const KALSHI_ORIGIN = 'https://api.elections.kalshi.com';

function readEvents(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const events = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); } catch (_) { /* skip a torn line */ }
  }
  return events;
}

function emptyPhase() {
  return { fills: 0, pairs: 0, locked: 0 };
}

function kickoffIndex(events) {
  const out = new Map();
  for (const ev of events || []) {
    if (!ev || !ev.gameId || ev.kickoffMs == null) continue;
    const ms = Number(ev.kickoffMs);
    if (!Number.isFinite(ms)) continue;
    if (!out.has(ev.gameId)) {
      out.set(ev.gameId, {
        kickoffMs: ms,
        bufferSec: ev.bufferSec != null ? Number(ev.bufferSec) : 60,
      });
    }
  }
  return out;
}

function phaseOf(ev, kickoffs) {
  if (!ev) return 'unknown';
  if (ev.phase === 'pregame' || ev.phase === 'ingame' || ev.phase === 'unknown') return ev.phase;
  const info = kickoffs.get(ev.gameId);
  const kick = ev.kickoffMs != null ? Number(ev.kickoffMs) : (info && info.kickoffMs);
  const bufferSec = ev.bufferSec != null
    ? Number(ev.bufferSec)
    : (info && info.bufferSec != null ? info.bufferSec : 60);
  const ts = ev.tradeTs != null ? Number(ev.tradeTs) : (ev.ts != null ? Number(ev.ts) : null);
  if (kick == null || ts == null || !Number.isFinite(kick) || !Number.isFinite(ts) || !Number.isFinite(bufferSec)) {
    return 'unknown';
  }
  return ts >= kick - bufferSec * 1000 ? 'ingame' : 'pregame';
}

function lotView(lot) {
  const view = priceView(lot.net);
  return {
    team: lot.team,
    venue: lot.venue,
    qty: lot.qty,
    net: lot.net,
    cents: view.cents,
    american: view.american,
    americanText: view.americanText,
    kalshiTicker: lot.kalshiTicker || null,
  };
}

function summarize(events) {
  const kickoffs = kickoffIndex(events);
  const replay = replayPaperEvents(events);
  const games = new Map();
  const counted = { ids: new Set(), fills: new Set() };
  function game(id) {
    const key = id || '(no game)';
    let g = games.get(key);
    if (!g) {
      g = {
        gameId: key,
        league: null,
        quotes: 0,
        reprices: 0,
        pulls: 0,
        fills: 0,
        pairs: 0,
        lockedProfit: 0,
        legacyPairs: 0,
        legacyLocked: 0,
        exitPnl: 0,
        exits: 0,
        realized: null,
        markouts: {},
        phases: { pregame: emptyPhase(), ingame: emptyPhase(), unknown: emptyPhase() },
        openPositions: [],
        lots: [],
        lockedPnl: 0,
        openPnl: null,
        hedges: 0,
        settledLeftover: null,
        openQty: 0,
        net: null,
      };
      games.set(key, g);
    }
    return g;
  }
  for (const ev of events || []) {
    if (!ev || typeof ev !== 'object') continue;
    if ((ev.kind === 'fill' || ev.kind === 'pair') && !countHistoryEvent(ev, counted)) continue;
    const g = game(ev.gameId);
    if (ev.league) g.league = ev.league;
    const phase = phaseOf(ev, kickoffs);
    if (ev.kind === 'quote') g.quotes += 1;
    else if (ev.kind === 'reprice') g.reprices += 1;
    else if (ev.kind === 'pull') g.pulls += 1;
    else if (ev.kind === 'fill') {
      g.fills += 1;
      g.phases[phase].fills += 1;
    } else if (ev.kind === 'pair') {
      const profit = Number(ev.lockedProfit) || 0;
      if (isLegacyEvent(ev)) {
        // Pre-cutoff-logic pairs are suspect. Counted apart, out of headline.
        g.legacyPairs += 1;
        g.legacyLocked += profit;
      } else {
        g.pairs += 1;
        g.lockedProfit += profit;
        g.phases[phase].pairs += 1;
        g.phases[phase].locked += profit;
      }
    } else if (ev.kind === 'exit') {
      g.exits += 1;
      if (ev.legacy !== true) g.exitPnl += Number(ev.pnl) || 0;
    } else if (ev.kind === 'settle') {
      g.realized = Number(ev.realizedPnl);
      g.legacyRealized = Number(ev.legacyPnl);
      g.settledWinner = ev.winner || null;
    } else if (ev.kind === 'markout' && ev.horizon && Number.isFinite(Number(ev.markoutUsd))) {
      const m = g.markouts[ev.horizon] || (g.markouts[ev.horizon] = { n: 0, usd: 0, adverse: 0 });
      m.n += 1;
      m.usd += Number(ev.markoutUsd);
      if (ev.adverse) m.adverse += 1;
    } else if (ev.kind === 'hedge') g.hedges += 1;
    if (ev.lockedPnl != null && Number.isFinite(Number(ev.lockedPnl))) g.lockedPnl = Number(ev.lockedPnl);
    if (ev.kind === 'pair' || ev.kind === 'fill' || ev.kind === 'quote' || ev.kind === 'reprice' || ev.kind === 'pull') {
      g.openPnl = ev.openPnl == null ? g.openPnl : ev.openPnl;
    }
  }
  for (const g of games.values()) {
    const replayed = replay.get(g.gameId);
    const lots = [];
    if (replayed) {
      for (const lot of replayed.lots) {
        if (!(lot.qty > 1e-9)) continue;
        lots.push(lot);
      }
    }
    g.lots = lots;
    g.openPositions = lots.map(lotView);
    g.openQty = lots.reduce((sum, lot) => sum + lot.qty, 0);
  }
  return [...games.values()];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function fetchKalshiMarket(ticker, fetchFn = fetch) {
  if (!ticker) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchFn(
      `${KALSHI_ORIGIN}/trade-api/v2/markets/${encodeURIComponent(ticker)}`,
      { signal: ctrl.signal, headers: { accept: 'application/json' } }
    );
    if (!res || !res.ok) return null;
    const body = await res.json();
    return (body && body.market) || body;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function resultOf(market) {
  const raw = market && (market.result != null ? market.result : market.market && market.market.result);
  const result = String(raw || '').trim().toLowerCase();
  if (result === 'yes' || result === 'no') return result;
  return null;
}

// Settle unpaired lots against Kalshi YES/NO. `fetchMarket(ticker)` returns
// a market object or { result }. Lots without a final result stay open.
async function settleRows(rows, fetchMarket) {
  const fetchOne = fetchMarket || ((ticker) => fetchKalshiMarket(ticker));
  const cache = new Map();
  async function lookup(ticker) {
    if (!ticker) return null;
    if (cache.has(ticker)) return cache.get(ticker);
    let result = null;
    try {
      result = resultOf(await fetchOne(ticker));
    } catch (_) {
      result = null;
    }
    cache.set(ticker, result);
    return result;
  }
  for (const row of rows || []) {
    let settled = 0;
    let openQty = 0;
    const open = [];
    const settledLots = [];
    for (const lot of row.lots || []) {
      if (!(lot.qty > 1e-9) || !Number.isFinite(Number(lot.net))) continue;
      const result = await lookup(lot.kalshiTicker);
      if (result === 'yes' || result === 'no') {
        const payout = result === 'yes' ? 1 : 0;
        settled += lot.qty * (payout - Number(lot.net));
        const view = priceView(Number(lot.net));
        settledLots.push({
          team: lot.team,
          qty: lot.qty,
          venue: lot.venue,
          result,
          americanText: view.americanText,
        });
      } else {
        openQty += lot.qty;
        open.push(lot);
      }
    }
    row.settledLots = settledLots;
    row.settledLeftover = round2(settled);
    row.openQty = openQty;
    row.openPositions = open.map(lotView);
    row.net = round2((Number(row.lockedProfit) || 0) + settled);
  }
  return rows;
}

function money(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'n/a';
  const v = Number(n);
  const body = `$${Math.abs(v).toFixed(2)}`;
  return v < 0 ? `-${body}` : body;
}

function phaseText(label, phase) {
  return `${label} fills=${phase.fills} pairs=${phase.pairs} locked=${money(phase.locked)}`;
}

function formatReport(rows) {
  if (!rows.length) return 'mm-paper: no events';
  const lines = [];
  let quotes = 0;
  let fills = 0;
  let pairs = 0;
  let locked = 0;
  let settled = 0;
  let settledKnown = true;
  let openQty = 0;
  let net = 0;
  let netKnown = true;
  const pre = emptyPhase();
  const ingame = emptyPhase();
  for (const g of rows) {
    quotes += g.quotes + g.reprices;
    fills += g.fills;
    pairs += g.pairs;
    locked += g.lockedProfit;
    pre.fills += g.phases.pregame.fills;
    pre.pairs += g.phases.pregame.pairs;
    pre.locked += g.phases.pregame.locked;
    ingame.fills += g.phases.ingame.fills;
    ingame.pairs += g.phases.ingame.pairs;
    ingame.locked += g.phases.ingame.locked;
    if (g.settledLeftover == null || g.net == null) {
      settledKnown = false;
      netKnown = false;
    } else {
      settled += g.settledLeftover;
      net += g.net;
    }
    openQty += Number(g.openQty) || 0;
    const open = (g.openPositions || []).map((p) => {
      const am = p.americanText || (p.american > 0 ? `+${p.american}` : (p.american != null ? String(p.american) : 'n/a'));
      return `${p.team} ${p.qty} @ ${am} ${p.venue || ''}`.trim();
    }).join('; ') || 'flat';
    const unknown = g.phases.unknown;
    const unknownText = (unknown.fills || unknown.pairs)
      ? ` ${phaseText('unknown', unknown)}`
      : '';
    const settledLots = (g.settledLots || []).map((p) => `${p.team} ${p.qty} @ ${p.americanText}`).join('; ');
    const settledText = settledLots ? ` settledLots=${settledLots}` : '';
    lines.push(
      `${g.gameId}  quotes=${g.quotes} reprices=${g.reprices} pulls=${g.pulls} `
      + `fills=${g.fills} pairs=${g.pairs} hedges=${g.hedges} `
      + `${phaseText('pregame', g.phases.pregame)} ${phaseText('ingame', g.phases.ingame)}${unknownText} `
      + `locked=${money(g.lockedProfit)} settledLeftover=${money(g.settledLeftover)} `
      + `open=${g.openQty} net=${money(g.net)}${settledText} openLots=${open}`
    );
  }
  lines.push(
    `TOTAL quotes=${quotes} fills=${fills} pairs=${pairs} legacyPairsExcluded=${rows.reduce((n, g) => n + (g.legacyPairs || 0), 0)} `
    + `${phaseText('pregame', pre)} ${phaseText('ingame', ingame)} `
    + `locked=${money(locked)} settledLeftover=${settledKnown ? money(settled) : 'n/a'} `
    + `open=${openQty} net=${netKnown ? money(net) : 'n/a'}`
  );
  return lines.join('\n');
}

function formatCompare(result, source) {
  const where = source ? ` source=${source}` : '';
  if (!result || result.ok) {
    return `[MM-PAPER] compare ok — restore matches live openPositions${where}`;
  }
  const lines = [`[MM-PAPER] compare mismatch${where}`];
  for (const diff of result.diffs || []) {
    const live = diff.live
      ? `${diff.live.team} ${diff.live.qty} net=${diff.live.net}`
      : 'none';
    const restored = diff.restored
      ? `${diff.restored.team} ${diff.restored.qty} net=${diff.restored.net}`
      : 'none';
    lines.push(`[MM-PAPER] compare ${diff.gameId} live=${live} restored=${restored}`);
  }
  return lines.join('\n');
}

function scriptArgs(argv) {
  const args = (argv || []).slice(2);
  const compare = args.includes('--compare');
  const filePath = args.find((arg) => arg && !arg.startsWith('--')) || null;
  return { compare, filePath };
}

async function loadCompareEvents(filePath, env) {
  const local = readEvents(filePath);
  const url = env && env.SUPABASE_URL;
  const key = env && env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { events: local, source: local.length ? 'jsonl' : 'none' };
  try {
    const { createClient } = require('@supabase/supabase-js');
    const history = await loadPaperHistory({
      supabase: createClient(url, key, { realtime: { transport: require('ws') } }),
      filePath,
    });
    if (history.remoteOk) return { events: history.events, source: history.source };
  } catch (err) {
    console.warn(`[MM-PAPER] compare supabase read failed — JSONL fallback: ${err && err.message ? err.message : err}`);
  }
  return { events: local, source: local.length ? 'jsonl' : 'none' };
}

async function main(argv, env = process.env, deps = {}) {
  const parsed = scriptArgs(argv);
  const filePath = parsed.filePath || (env && env.MM_LOG_PATH) || 'mm-paper.jsonl';
  let compareResult = null;
  let events = null;
  if (parsed.compare) {
    const loaded = deps.events
      ? { events: deps.events, source: deps.source || 'events' }
      : await loadCompareEvents(filePath, env);
    events = loaded.events;
    compareResult = compareReplayToSnapshots(events);
    console.log(formatCompare(compareResult, loaded.source));
  }
  const rows = summarize(events || readEvents(filePath));
  const settleOff = /^(0|false|no|off)$/i.test(String(env.MM_PAPER_SETTLE || '').trim());
  if (!settleOff) await settleRows(rows, deps.fetchMarket);
  const text = formatReport(rows);
  console.log(text);
  return { rows, compare: compareResult };
}

if (require.main === module) {
  main(process.argv).catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  summarize,
  formatReport,
  formatCompare,
  readEvents,
  settleRows,
  fetchKalshiMarket,
  phaseOf,
  scriptArgs,
  main,
};
