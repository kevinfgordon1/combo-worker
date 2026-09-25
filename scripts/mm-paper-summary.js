#!/usr/bin/env node
// Summarize a paper market-making JSONL log.
//   node scripts/mm-paper-summary.js [path]
//   MM_LOG_PATH=mm-paper.jsonl node scripts/mm-paper-summary.js
'use strict';

const fs = require('fs');

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

function summarize(events) {
  const games = new Map();
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
        openPositions: [],
        lockedPnl: 0,
        openPnl: null,
        hedges: 0,
      };
      games.set(key, g);
    }
    return g;
  }
  for (const ev of events || []) {
    if (!ev || typeof ev !== 'object') continue;
    const g = game(ev.gameId);
    if (ev.league) g.league = ev.league;
    if (ev.kind === 'quote') g.quotes += 1;
    else if (ev.kind === 'reprice') g.reprices += 1;
    else if (ev.kind === 'pull') g.pulls += 1;
    else if (ev.kind === 'fill') g.fills += 1;
    else if (ev.kind === 'pair') {
      g.pairs += 1;
      g.lockedProfit += Number(ev.lockedProfit) || 0;
    } else if (ev.kind === 'hedge') g.hedges += 1;
    if (ev.openPositions) g.openPositions = ev.openPositions;
    if (ev.lockedPnl != null && Number.isFinite(Number(ev.lockedPnl))) g.lockedPnl = Number(ev.lockedPnl);
    if (ev.kind === 'pair' || ev.kind === 'fill' || ev.kind === 'quote' || ev.kind === 'reprice' || ev.kind === 'pull') {
      g.openPnl = ev.openPnl == null ? g.openPnl : ev.openPnl;
    }
  }
  return [...games.values()];
}

function money(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'n/a';
  const v = Number(n);
  const body = `$${Math.abs(v).toFixed(2)}`;
  return v < 0 ? `-${body}` : body;
}

function formatReport(rows) {
  if (!rows.length) return 'mm-paper: no events';
  const lines = [];
  let quotes = 0;
  let fills = 0;
  let pairs = 0;
  let locked = 0;
  for (const g of rows) {
    quotes += g.quotes + g.reprices;
    fills += g.fills;
    pairs += g.pairs;
    locked += g.lockedProfit;
    const open = (g.openPositions || []).map((p) => {
      const am = p.americanText || (p.american > 0 ? `+${p.american}` : p.american);
      return `${p.team} ${p.qty} @ ${p.cents}c ${am || ''} net ${p.venue}`.trim();
    }).join('; ') || 'flat';
    lines.push(
      `${g.gameId}  quotes=${g.quotes} reprices=${g.reprices} pulls=${g.pulls} `
      + `fills=${g.fills} pairs=${g.pairs} locked=${money(g.lockedProfit)} `
      + `openPnl=${money(g.openPnl)} hedges=${g.hedges} open=${open}`
    );
  }
  lines.push(`TOTAL quotes=${quotes} fills=${fills} pairs=${pairs} locked=${money(locked)}`);
  return lines.join('\n');
}

function main(argv, env = process.env) {
  const filePath = argv[2] || env.MM_LOG_PATH || 'mm-paper.jsonl';
  const rows = summarize(readEvents(filePath));
  console.log(formatReport(rows));
  return rows;
}

if (require.main === module) main(process.argv);

module.exports = { summarize, formatReport, readEvents, main };
