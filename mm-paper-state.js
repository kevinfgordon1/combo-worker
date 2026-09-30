// Rebuild paper positions from the event tape.
//
// Supabase mm_paper_events is the durable copy. When that read succeeds it
// is the only source: JSONL is not merged in, because a content-key union
// drops repeated pair rows. JSONL is the fallback only when the Supabase
// read throws.
//
// Rows are paged until a short page. There is no offset ceiling. Fill and
// pair rows are replayed in insertion order (created_at, id), which is the
// order the live engine emitted them. Identical pair rows are kept. A second
// restore of the same tape does not apply them again.
'use strict';

const fs = require('fs');

const HISTORY_KINDS = new Set(['fill', 'pair', 'cutoff', 'exit', 'settle']);
const DB_HISTORY_KINDS = ['fill', 'pair', 'cutoff', 'exit', 'settle'];
const DEFAULT_PAGE = 1000;
const MAX_PAGES = 2000;

// Rows written before the kickoff-cutoff logic shipped (deploy ~Sep 28) carry
// no `phase`. They were quoted with no cutoff, so they can include in-game
// fills and pairs. They still consume inventory (lots stay correct) but their
// locked profit is suspect and stays out of headline totals.
function isLegacyEvent(ev) {
  if (!ev || (ev.kind !== 'fill' && ev.kind !== 'pair')) return false;
  if (ev.legacy === true) return true;
  if (ev.legacy === false) return false;
  return ev.phase == null;
}

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

// Identity for one restore pass. Row id and seq are unique. Fills fall back
// to the trade key. Pairs that share qty/ts/profit stay distinct via the
// occurrence count, which a second pass of the same tape reproduces.
function restoreIdentity(ev, counts) {
  if (!ev) return null;
  if (ev.id) return `row:${ev.id}`;
  if (ev.seq != null && Number.isFinite(Number(ev.seq))) return `seq:${Number(ev.seq)}`;
  if (ev.kind === 'fill') return paperEventKey(ev);
  if (ev.kind === 'cutoff') {
    return `cutoff:${ev.gameId}:${ev.ts}:${ev.kickoffMs == null ? '' : ev.kickoffMs}`;
  }
  if (ev.kind !== 'pair') return null;
  const key = paperEventKey(ev);
  if (!key) return null;
  const n = (counts.get(key) || 0) + 1;
  counts.set(key, n);
  return `${key}#${n}`;
}

function createdStamp(ev) {
  if (!ev) return '';
  const raw = ev.createdAt != null ? ev.createdAt : ev.created_at;
  if (raw == null || raw === '') return '';
  if (raw instanceof Date) return raw.toISOString();
  return String(raw);
}

// Insertion order. Payload ts must not pull every fill ahead of the pairs
// emitted in the same poll — that consumes a different FIFO lot than the
// live engine. Sort only when every history row carries created_at.
function orderPaperEvents(events) {
  const indexed = (events || []).map((ev, i) => ({ ev, i }));
  const history = indexed.filter(({ ev }) => ev && HISTORY_KINDS.has(ev.kind));
  const stamped = history.length > 0 && history.every(({ ev }) => createdStamp(ev));
  if (!stamped) return indexed.map(({ ev }) => ev);
  indexed.sort((a, b) => {
    const ca = createdStamp(a.ev);
    const cb = createdStamp(b.ev);
    if (ca !== cb) return ca < cb ? -1 : 1;
    const ia = String((a.ev && a.ev.id) || '');
    const ib = String((b.ev && b.ev.id) || '');
    if (ia !== ib) return ia < ib ? -1 : 1;
    return a.i - b.i;
  });
  return indexed.map(({ ev }) => ev);
}

function sortPaperEvents(events) {
  return orderPaperEvents(events);
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
    ts: Number.isFinite(Number(ev.tradeTs)) ? Number(ev.tradeTs) : (Number.isFinite(Number(ev.ts)) ? Number(ev.ts) : null),
    legacy: isLegacyEvent(ev),
  };
  game.lots.push(lot);
  return lot;
}

// FIFO reduce. Returns true when any consumed lot was legacy.
function reduceTeam(game, team, qty) {
  let left = Number(qty);
  let legacy = false;
  if (!team || !(left > 0)) return legacy;
  for (const lot of game.lots) {
    if (lot.team !== team || !(lot.qty > 0)) continue;
    const take = Math.min(lot.qty, left);
    lot.qty -= take;
    left -= take;
    if (lot.legacy) legacy = true;
    if (!(left > 1e-9)) break;
  }
  return legacy;
}

function applyPair(game, ev) {
  const qty = Number(ev && ev.qty);
  if (!game || !(qty > 0)) return null;
  const legs = Array.isArray(ev.legs) ? ev.legs : [];
  const teams = [];
  for (const leg of legs) {
    if (leg && leg.team && !teams.includes(leg.team)) teams.push(leg.team);
  }
  let usedLegacy = false;
  if (teams.length >= 2) {
    usedLegacy = reduceTeam(game, teams[0], qty) || usedLegacy;
    usedLegacy = reduceTeam(game, teams[1], qty) || usedLegacy;
  } else if ((game.teams || []).length >= 2) {
    usedLegacy = reduceTeam(game, game.teams[0], qty) || usedLegacy;
    usedLegacy = reduceTeam(game, game.teams[1], qty) || usedLegacy;
  }
  const profit = Number(ev.lockedProfit) || 0;
  // A pair that consumed a legacy lot is as suspect as the lot.
  const legacy = ev.legacy === false && !usedLegacy ? false : (isLegacyEvent(ev) || usedLegacy);
  game.pairedQty += qty;
  if (legacy) {
    game.legacyPairedQty = (game.legacyPairedQty || 0) + qty;
    game.legacyLockedPnl = (game.legacyLockedPnl || 0) + profit;
  } else {
    game.lockedPnl += profit;
  }
  return { qty, profit, legacy };
}

// A simulated exit sells `qty` of one team at ev.price. FIFO, like a pair.
function applyExit(game, ev) {
  const qty = Number(ev && ev.qty);
  if (!game || !ev || !ev.team || !(qty > 0)) return null;
  const usedLegacy = reduceTeam(game, ev.team, qty);
  const pnl = Number(ev.pnl) || 0;
  const legacy = ev.legacy === true || usedLegacy;
  if (legacy) game.legacyExitPnl = (game.legacyExitPnl || 0) + pnl;
  else game.exitPnl = (game.exitPnl || 0) + pnl;
  return { qty, pnl, legacy };
}

function applySettle(game, ev) {
  if (!game || !ev) return null;
  for (const lot of game.lots) lot.qty = 0;
  game.settled = true;
  game.settlement = {
    winner: ev.winner || null,
    realizedPnl: Number(ev.realizedPnl) || 0,
    legacyPnl: Number(ev.legacyPnl) || 0,
  };
  return game.settlement;
}

function emptyReplayGame(meta) {
  return {
    gameId: meta.gameId,
    league: meta.league,
    date: meta.date,
    teams: meta.teams.slice(),
    lots: [],
    lockedPnl: 0,
    legacyLockedPnl: 0,
    pairedQty: 0,
    legacyPairedQty: 0,
    exitPnl: 0,
    legacyExitPnl: 0,
    settled: false,
    settlement: null,
  };
}

const REPLAY_KINDS = new Set(['fill', 'pair', 'exit', 'settle']);

function replayPaperEvents(events) {
  const games = new Map();
  const seenIds = new Set();
  const seenFills = new Set();
  for (const ev of orderPaperEvents(events)) {
    if (!ev || !REPLAY_KINDS.has(ev.kind)) continue;
    if (ev.id) {
      if (seenIds.has(ev.id)) continue;
      seenIds.add(ev.id);
    }
    if (ev.kind === 'fill') {
      const key = paperEventKey(ev);
      if (key && seenFills.has(key)) continue;
      if (key) seenFills.add(key);
    }
    const meta = metaFromGameId(ev.gameId, ev.league);
    if (!meta) continue;
    let game = games.get(meta.gameId);
    if (!game) {
      game = emptyReplayGame(meta);
      games.set(meta.gameId, game);
    }
    if (ev.kind === 'fill') applyFill(game, ev);
    else if (ev.kind === 'pair') applyPair(game, ev);
    else if (ev.kind === 'exit') applyExit(game, ev);
    else if (ev.kind === 'settle') applySettle(game, ev);
  }
  return games;
}

function positionsFromLots(game) {
  if (!game) return [];
  const teams = [];
  for (const lot of game.lots || []) {
    if (lot && lot.team && !teams.includes(lot.team)) teams.push(lot.team);
  }
  for (const team of game.teams || []) {
    if (team && !teams.includes(team)) teams.push(team);
  }
  return teams.map((team) => {
    const lots = (game.lots || []).filter((lot) => lot.team === team && lot.qty > 1e-9);
    const qty = lots.reduce((sum, lot) => sum + lot.qty, 0);
    if (!(qty > 0)) return null;
    const cost = lots.reduce((sum, lot) => sum + lot.qty * lot.net, 0);
    return {
      team,
      qty,
      net: cost / qty,
      venue: lots[lots.length - 1].venue || null,
    };
  }).filter(Boolean);
}

function near(a, b) {
  return Math.abs(Number(a) - Number(b)) <= 1e-6;
}

// Compare a full replay to the openPositions the live engine stamped on the
// latest event for each game. Read-only.
function compareReplayToSnapshots(events) {
  const replay = replayPaperEvents(events);
  const liveByGame = new Map();
  for (const ev of orderPaperEvents(events)) {
    if (!ev || !ev.gameId || !Array.isArray(ev.openPositions)) continue;
    liveByGame.set(ev.gameId, ev.openPositions);
  }
  const ids = new Set([...replay.keys(), ...liveByGame.keys()]);
  const diffs = [];
  for (const gameId of [...ids].sort()) {
    const restored = positionsFromLots(replay.get(gameId));
    const live = (liveByGame.get(gameId) || []).filter((pos) => pos && pos.qty > 1e-9);
    const teams = new Set([
      ...restored.map((pos) => pos.team),
      ...live.map((pos) => pos.team),
    ]);
    for (const team of teams) {
      const left = live.find((pos) => pos.team === team) || null;
      const right = restored.find((pos) => pos.team === team) || null;
      if (!left && !right) continue;
      if (!left || !right || !near(left.qty, right.qty) || !near(left.net, right.net)) {
        diffs.push({ gameId, team, live: left, restored: right });
      }
    }
  }
  return { ok: diffs.length === 0, diffs };
}

function eventFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.kind && row.payload == null && row.gameId) return row;
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  return {
    ...payload,
    kind: payload.kind || row.kind,
    gameId: payload.gameId || row.game_id || null,
    venue: payload.venue || row.venue || null,
    team: payload.team || row.team || null,
    id: row.id || payload.id || null,
    createdAt: row.created_at || payload.createdAt || null,
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

function historyQuery(supabase) {
  let query = supabase.from('mm_paper_events');
  if (!query || typeof query.select !== 'function') {
    throw new Error('mm_paper_events client has no select');
  }
  query = query.select('id,kind,game_id,venue,team,payload,created_at');
  if (typeof query.in === 'function') query = query.in('kind', DB_HISTORY_KINDS);
  if (typeof query.order === 'function') query = query.order('created_at', { ascending: true });
  if (typeof query.order === 'function') query = query.order('id', { ascending: true });
  if (typeof query.range !== 'function') throw new Error('mm_paper_events client has no range');
  return query;
}

async function loadSupabasePaperEvents(supabase, { pageSize } = {}) {
  if (!supabase) return { events: [], rowsRead: 0, pages: 0 };
  const page = Number.isFinite(Number(pageSize)) && Number(pageSize) > 0
    ? Math.floor(Number(pageSize))
    : DEFAULT_PAGE;
  const out = [];
  const seenIds = new Set();
  let rowsRead = 0;
  let pages = 0;
  let from = 0;
  for (;;) {
    if (pages >= MAX_PAGES) {
      throw new Error(`mm_paper_events exceeded ${MAX_PAGES} pages — refusing a partial restore`);
    }
    const { data, error } = await historyQuery(supabase).range(from, from + page - 1);
    if (error) {
      const err = new Error(error.message || 'mm_paper_events read failed');
      err.code = error.code;
      throw err;
    }
    const rows = data || [];
    pages += 1;
    rowsRead += rows.length;
    for (const row of rows) {
      if (row && row.id) {
        if (seenIds.has(row.id)) continue;
        seenIds.add(row.id);
      }
      const ev = eventFromRow(row);
      if (!ev || !HISTORY_KINDS.has(ev.kind)) continue;
      out.push(ev);
    }
    if (rows.length < page) break;
    from += page;
  }
  return { events: out, rowsRead, pages };
}

function keepHistory(events) {
  const seenIds = new Set();
  const seenFills = new Set();
  const out = [];
  for (const ev of orderPaperEvents(events)) {
    if (!ev || !HISTORY_KINDS.has(ev.kind)) continue;
    if (ev.id) {
      if (seenIds.has(ev.id)) continue;
      seenIds.add(ev.id);
    }
    if (ev.kind === 'fill') {
      const key = paperEventKey(ev);
      if (key && seenFills.has(key)) continue;
      if (key) seenFills.add(key);
    }
    out.push(ev);
  }
  return out;
}

function countHistoryEvent(ev, state) {
  if (!ev || (ev.kind !== 'fill' && ev.kind !== 'pair')) return true;
  if (ev.id) {
    if (state.ids.has(ev.id)) return false;
    state.ids.add(ev.id);
  }
  if (ev.kind === 'fill') {
    const key = paperEventKey(ev);
    if (key && state.fills.has(key)) return false;
    if (key) state.fills.add(key);
  }
  return true;
}

async function loadPaperHistory({ supabase, filePath, readFile, warn, pageSize } = {}) {
  const log = warn || ((msg) => console.warn(msg));
  let remote = [];
  let remoteOk = false;
  let rowsRead = 0;
  let pages = null;
  if (supabase) {
    try {
      const loaded = await loadSupabasePaperEvents(supabase, { pageSize });
      remote = loaded.events;
      rowsRead = loaded.rowsRead;
      pages = loaded.pages;
      remoteOk = true;
    } catch (err) {
      log(`[MM-PAPER] supabase history unavailable — JSONL fallback: ${err && err.message ? err.message : err}`);
    }
  }
  if (remoteOk) {
    return {
      source: 'supabase',
      events: keepHistory(remote),
      remoteOk,
      rowsRead,
      pages,
    };
  }
  let local = [];
  try {
    local = readJsonlEvents(filePath, readFile);
  } catch (err) {
    log(`[MM-PAPER] JSONL history unreadable: ${err && err.message ? err.message : err}`);
  }
  const events = keepHistory(local);
  let source = 'none';
  if (events.length) source = 'jsonl';
  return {
    source,
    events,
    remoteOk,
    rowsRead: local.length,
    pages: null,
  };
}

function formatQty(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 10000) / 10000);
}

function formatRestoreLog({ openQty, lockedPnl, source, events, rowsRead, pages, lots } = {}) {
  const nEvents = Number.isFinite(Number(events)) ? Number(events) : 0;
  const nRows = rowsRead != null ? rowsRead : nEvents;
  const pageText = pages != null ? `, ${pages} pages` : '';
  const lines = [
    `[MM-PAPER] restored open=${formatQty(openQty)} locked=${lockedPnl} `
    + `from ${source || 'none'} (${nEvents} events, ${nRows} rows read${pageText})`,
  ];
  const byGame = new Map();
  for (const lot of lots || []) {
    if (!lot || !(lot.qty > 1e-9) || !lot.gameId) continue;
    if (!byGame.has(lot.gameId)) byGame.set(lot.gameId, []);
    byGame.get(lot.gameId).push(lot);
  }
  if (!byGame.size) {
    lines.push('[MM-PAPER] restored lots (none)');
    return lines;
  }
  for (const gameId of [...byGame.keys()].sort()) {
    const gameLots = byGame.get(gameId);
    const sum = gameLots.reduce((total, lot) => total + lot.qty, 0);
    const text = gameLots.map((lot) => {
      const am = lot.americanText || 'n/a';
      return `${lot.team} ${formatQty(lot.qty)} @ ${am} ${lot.venue || ''}`.trim();
    }).join('; ');
    lines.push(`[MM-PAPER] restored lot ${gameId} open=${formatQty(sum)} ${text}`);
  }
  return lines;
}

module.exports = {
  HISTORY_KINDS,
  metaFromGameId,
  paperEventKey,
  restoreIdentity,
  orderPaperEvents,
  sortPaperEvents,
  applyFill,
  applyPair,
  applyExit,
  applySettle,
  isLegacyEvent,
  replayPaperEvents,
  positionsFromLots,
  compareReplayToSnapshots,
  eventFromRow,
  readJsonlEvents,
  loadSupabasePaperEvents,
  loadPaperHistory,
  countHistoryEvent,
  formatRestoreLog,
  formatQty,
};
