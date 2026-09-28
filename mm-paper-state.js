// Rebuild paper positions from the event tape.
// Supabase mm_paper_events is the durable copy. The JSONL file is the
// fallback when that read fails, and is merged in when it is present.
// Fill and pair rows are deduped so a restart cannot double-count.
'use strict';

const fs = require('fs');

function metaFromGameId(gameId, leagueHint) {
  const parts = String(gameId || '').split('|');
  if (parts.length < 3) return null;
  const teams = parts[2].split('+').filter(Boolean);
  if (!parts[0] || !parts[1] || teams.length < 2) return null;
  return {
    gameId: parts.join('|'),
    league: leagueHint || parts[0],
    date: parts[1],
    teams,
  };
}

function paperEventKey(ev) {
  if (!ev || (ev.kind !== 'fill' && ev.kind !== 'pair')) return null;
  if (ev.kind === 'fill') {
    if (ev.tradeKey) return `fill|${ev.tradeKey}`;
    if (ev.tradeId) return `fill|${ev.gameId}|${ev.venue}|${ev.team}|${ev.tradeId}`;
    return `fill|${ev.gameId}|${ev.venue}|${ev.team}|${ev.ts}|${ev.qty}|${ev.price}|${ev.net}`;
  }
  const legs = (Array.isArray(ev.legs) ? ev.legs : [])
    .map((leg) => (leg && leg.team) || '')
    .filter(Boolean)
    .join('+');
  return `pair|${ev.gameId}|${ev.ts}|${ev.qty}|${ev.lockedProfit}|${legs}`;
}

function eventRank(ev) {
  if (!ev) return 9;
  if (ev.kind === 'fill') return 1;
  if (ev.kind === 'pair') return 2;
  if (ev.kind === 'cutoff') return 0;
  return 5;
}

function sortPaperEvents(events) {
  return [...(events || [])].sort((a, b) => {
    const dt = (Number(a && a.ts) || 0) - (Number(b && b.ts) || 0);
    if (dt) return dt;
    return eventRank(a) - eventRank(b);
  });
}

function applyFill(game, ev) {
  const qty = Number(ev && ev.qty);
  const net = Number(ev && ev.net);
  if (!game || !(qty > 0) || !ev.team || !Number.isFinite(net)) return null;
  const price = Number(ev.price);
  const lot = {
    team: ev.team,
    venue: ev.venue || null,
    price: Number.isFinite(price) ? price : net,
    net,
    qty,
    kalshiTicker: ev.kalshiTicker || null,
  };
  game.lots.push(lot);
  return lot;
}

function reduceTeam(game, team, qty) {
  let left = Number(qty);
  if (!team || !(left > 0)) return;
  for (const lot of game.lots) {
    if (lot.team !== team || !(lot.qty > 0)) continue;
    const take = Math.min(lot.qty, left);
    lot.qty -= take;
    left -= take;
    if (!(left > 1e-9)) break;
  }
}

function applyPair(game, ev) {
  const qty = Number(ev && ev.qty);
  if (!game || !(qty > 0)) return null;
  const legs = Array.isArray(ev.legs) ? ev.legs : [];
  const teams = [];
  for (const leg of legs) {
    if (leg && leg.team && !teams.includes(leg.team)) teams.push(leg.team);
  }
  if (teams.length >= 2) {
    reduceTeam(game, teams[0], qty);
    reduceTeam(game, teams[1], qty);
  } else if ((game.teams || []).length >= 2) {
    reduceTeam(game, game.teams[0], qty);
    reduceTeam(game, game.teams[1], qty);
  }
  const profit = Number(ev.lockedProfit) || 0;
  game.pairedQty += qty;
  game.lockedPnl += profit;
  return { qty, profit };
}

function emptyReplayGame(meta) {
  return {
    gameId: meta.gameId,
    league: meta.league,
    date: meta.date,
    teams: meta.teams.slice(),
    lots: [],
    lockedPnl: 0,
    pairedQty: 0,
  };
}

function replayPaperEvents(events) {
  const games = new Map();
  const seen = new Set();
  for (const ev of sortPaperEvents(events)) {
    if (!ev || (ev.kind !== 'fill' && ev.kind !== 'pair')) continue;
    const key = paperEventKey(ev);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const meta = metaFromGameId(ev.gameId, ev.league);
    if (!meta) continue;
    let game = games.get(meta.gameId);
    if (!game) {
      game = emptyReplayGame(meta);
      games.set(meta.gameId, game);
    }
    if (ev.kind === 'fill') applyFill(game, ev);
    else applyPair(game, ev);
  }
  return games;
}

function eventFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.kind && row.payload == null) return row;
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  return {
    ...payload,
    kind: payload.kind || row.kind,
    gameId: payload.gameId || row.game_id || null,
    venue: payload.venue || row.venue || null,
    team: payload.team || row.team || null,
  };
}

function readJsonlEvents(filePath, readFile) {
  if (!filePath) return [];
  let text = '';
  if (readFile) {
    text = readFile(filePath) || '';
  } else if (!fs.existsSync(filePath)) {
    return [];
  } else {
    text = fs.readFileSync(filePath, 'utf8');
  }
  const events = [];
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); } catch (_) { /* torn line */ }
  }
  return events;
}

async function loadSupabasePaperEvents(supabase) {
  if (!supabase) return [];
  const out = [];
  const page = 1000;
  for (let from = 0; from < 50000; from += page) {
    const { data, error } = await supabase
      .from('mm_paper_events')
      .select('kind,game_id,venue,team,payload,created_at')
      .order('created_at', { ascending: true })
      .range(from, from + page - 1);
    if (error) {
      const err = new Error(error.message || 'mm_paper_events read failed');
      err.code = error.code;
      throw err;
    }
    const rows = data || [];
    for (const row of rows) {
      const ev = eventFromRow(row);
      if (ev) out.push(ev);
    }
    if (rows.length < page) break;
  }
  return out;
}

const HISTORY_KINDS = new Set(['fill', 'pair', 'cutoff']);

async function loadPaperHistory({ supabase, filePath, readFile, warn } = {}) {
  const log = warn || ((msg) => console.warn(msg));
  let remote = [];
  let remoteOk = false;
  if (supabase) {
    try {
      remote = await loadSupabasePaperEvents(supabase);
      remoteOk = true;
    } catch (err) {
      log(`[MM-PAPER] supabase history unavailable — JSONL fallback: ${err && err.message ? err.message : err}`);
    }
  }
  let local = [];
  try {
    local = readJsonlEvents(filePath, readFile);
  } catch (err) {
    log(`[MM-PAPER] JSONL history unreadable: ${err && err.message ? err.message : err}`);
  }
  const events = [];
  const seen = new Set();
  for (const ev of [...remote, ...local]) {
    if (!ev || !HISTORY_KINDS.has(ev.kind)) continue;
    const key = paperEventKey(ev);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    events.push(ev);
  }
  let source = 'none';
  if (remoteOk && local.length) source = 'supabase+jsonl';
  else if (remoteOk) source = 'supabase';
  else if (local.length) source = 'jsonl';
  return { source, events, remoteOk };
}

module.exports = {
  metaFromGameId,
  paperEventKey,
  sortPaperEvents,
  applyFill,
  applyPair,
  replayPaperEvents,
  eventFromRow,
  readJsonlEvents,
  loadSupabasePaperEvents,
  loadPaperHistory,
};
