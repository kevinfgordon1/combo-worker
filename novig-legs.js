// Novig outcomeId -> Combo Locks leg identity.
//
// Main lines reuse the relay's matchup split and spread-name parser. Player
// props (anytime TD / home run) join through player-prop-crosswalk: same
// normalized name, same ET date, same two teams, threshold on the crosswalk.
// Anything missing or matched twice is left out. Callers ignore an RFQ whose
// legs are not an exact set for one active lock.
'use strict';

const { novigFeed } = require('./odds-relay');
const {
  normTeam,
  makeIdentity,
  identityKey,
  identitiesFromParlay,
  identityFromNovigThreeWay,
  etDateFromMs,
} = require('./leg-identity');
const PROPX = require('./player-prop-crosswalk');

const PROP_TYPES = {
  TOUCHDOWNS: { league: 'nfl', kind: 'td' },
  HOME_RUNS: { league: 'mlb', kind: 'hr' },
};

function outcomesOf(raw) {
  return (raw && raw.outcomes || []).map((o) => ({
    id: String(o.outcomeId || o.id || ''),
    name: String(o.name || ''),
  })).filter((o) => o.id);
}

function putOutcome(map, outcomeId, row) {
  if (!outcomeId || !row || !row.key) return;
  const prev = map.get(outcomeId);
  if (!prev) {
    map.set(outcomeId, row);
    return;
  }
  if (prev.ambiguous || prev.key !== row.key) map.set(outcomeId, { ambiguous: true });
}

function teamCodes(ev) {
  const codes = Object.keys(ev.codes || {})
    .map((c) => normTeam(ev.league, c))
    .filter(Boolean);
  const uniq = [...new Set(codes)];
  return uniq.length >= 2 ? uniq : null;
}

function legStarted(ev, now) {
  if (!ev) return false;
  if (String(ev.status || '').toUpperCase() === 'OPEN_INGAME') return true;
  return !!(ev.startsTs && ev.startsTs <= now);
}

function boardIdentity(ev, type, outcome, strike, now) {
  const date = etDateFromMs(ev.startsTs);
  const teams = teamCodes(ev);
  if (!date || !teams) return null;
  const base = {
    league: ev.league,
    date,
    teams,
    period: 'full',
    side: 'yes',
    startMs: ev.startsTs || undefined,
  };
  let partial = null;
  if (type === 'MONEY') {
    const selection = normTeam(ev.league, outcome.name);
    if (!selection || !teams.includes(selection)) return null;
    partial = { ...base, marketType: 'moneyline', selection };
  } else if (type === 'SPREAD') {
    const parsed = novigFeed.parseSpreadName(outcome.name);
    if (!parsed || !Number.isFinite(parsed.line)) return null;
    const selection = normTeam(ev.league, parsed.code);
    if (!selection || !teams.includes(selection)) return null;
    partial = { ...base, marketType: 'spread', selection, line: parsed.line };
  } else if (type === 'TOTAL') {
    const name = outcome.name.trim().toLowerCase();
    const selection = name.startsWith('over') ? 'over' : name.startsWith('under') ? 'under' : null;
    if (!selection || !Number.isFinite(strike)) return null;
    partial = { ...base, marketType: 'total', selection, line: strike };
  }
  if (!partial) return null;
  const identity = makeIdentity(partial);
  const key = identity && identityKey(identity);
  if (!key) return null;
  return { key, identity, started: legStarted(ev, now), eventId: ev.id };
}

function propLine(strike) {
  const n = Number(strike);
  if (!Number.isFinite(n) || Math.abs(n * 2 - Math.round(n * 2)) > 1e-6) return null;
  if (Math.abs(n - Math.round(n)) < 1e-6) return null;
  const line = Math.round(n + 0.5);
  return line >= 1 ? line : null;
}

function playerFromDescription(description, kind) {
  const word = kind === 'hr' ? 'HOME_RUNS' : 'TOUCHDOWNS';
  return String(description || '').replace(new RegExp(`\\s+[\\d.]+\\s+${word}\\s*$`, 'i'), '').trim();
}

function propIdentity(ev, player, spec, line, now) {
  const want = PROPX.nname(player);
  const date = etDateFromMs(ev.startsTs);
  const teams = teamCodes(ev);
  if (!want || !date || !teams || spec.league !== ev.league) return null;
  const teamKey = teams.slice().sort().join('+');
  const hits = [];
  for (const row of PROPX.current().byKalshi.values()) {
    if (!row || row.league !== spec.league || row.kind !== spec.kind) continue;
    const name = PROPX.nname(row.name);
    const polyName = PROPX.nname(row.poly && row.poly.name);
    if (name !== want && polyName !== want) continue;
    const thresholds = row.polyThresholds || row.kalshiThresholds || [];
    if (!thresholds.includes(line)) continue;
    const stem = row.poly && row.poly.stem;
    const sm = /^([a-z]+)-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d{2}-\d{2})$/.exec(String(stem || ''));
    if (!sm || sm[1] !== spec.league || sm[4] !== date) continue;
    const stemTeams = [normTeam(spec.league, sm[2]), normTeam(spec.league, sm[3])].filter(Boolean).sort().join('+');
    if (stemTeams !== teamKey) continue;
    hits.push(row);
  }
  if (hits.length !== 1 || !hits[0].poly || !hits[0].poly.abbr) return null;
  const identity = makeIdentity({
    league: spec.league,
    date,
    teams,
    marketType: spec.kind,
    period: 'full',
    selection: `p.${hits[0].poly.abbr}`,
    side: 'yes',
    line,
    startMs: ev.startsTs || undefined,
  });
  const key = identity && identityKey(identity);
  if (!key) return null;
  return { key, identity, started: legStarted(ev, now), eventId: ev.id };
}

function indexNovigCatalog(leagueRaw, eventsBody, marketsBody, at = Date.now()) {
  const leagueName = String(leagueRaw || '').toUpperCase();
  const league = leagueName.toLowerCase();
  const events = new Map();
  for (const ev of (eventsBody && eventsBody.items) || []) {
    if (!ev || !ev.eventId) continue;
    if (leagueName && String(ev.league || leagueName).toUpperCase() !== leagueName) continue;
    const status = String(ev.status || '').toUpperCase();
    if (status !== 'OPEN_PREGAME' && status !== 'OPEN_INGAME') continue;
    const teams = novigFeed.splitMatchup(ev.description);
    if (!teams) continue;
    events.set(String(ev.eventId), {
      id: String(ev.eventId),
      league,
      away: teams.away,
      home: teams.home,
      status,
      startsTs: Number(ev.startsTs) || null,
      codes: {},
    });
  }
  const markets = (marketsBody && marketsBody.items) || [];
  for (const raw of markets) {
    if (String(raw && raw.marketType || '').toUpperCase() !== 'MONEY') continue;
    if (String(raw.status || '').toUpperCase() !== 'OPEN') continue;
    const ev = events.get(String(raw.eventId || ''));
    const outs = outcomesOf(raw);
    if (!ev || outs.length !== 2) continue;
    ev.codes[outs[0].name.toUpperCase()] = ev.home;
    ev.codes[outs[1].name.toUpperCase()] = ev.away;
  }
  const byOutcome = new Map();
  for (const raw of markets) {
    if (!raw || String(raw.status || '').toUpperCase() !== 'OPEN') continue;
    const ev = events.get(String(raw.eventId || ''));
    if (!ev) continue;
    const type = String(raw.marketType || '').toUpperCase();
    const strike = Number(raw.strike);
    if (type === 'MONEY' || type === 'SPREAD' || type === 'TOTAL') {
      for (const outcome of outcomesOf(raw)) {
        putOutcome(byOutcome, outcome.id, boardIdentity(ev, type, outcome, strike, at));
      }
      continue;
    }
    const three = identityFromNovigThreeWay(raw, {
      away: ev.away,
      home: ev.home,
      date: etDateFromMs(ev.startsTs),
      side: 'yes',
      startsTs: ev.startsTs,
    });
    if (three) {
      const key = identityKey(three);
      const yes = outcomesOf(raw).filter((o) => /^yes$/i.test(o.name.trim()));
      if (key && yes.length === 1) {
        putOutcome(byOutcome, yes[0].id, { key, identity: three, started: legStarted(ev, at), eventId: ev.id });
      }
      continue;
    }
    const spec = PROP_TYPES[type];
    if (!spec) continue;
    const line = propLine(raw.strike);
    const player = playerFromDescription(raw.description, spec.kind);
    const over = outcomesOf(raw).find((o) => /^over\b/i.test(o.name.trim()));
    if (!line || !player || !over) continue;
    putOutcome(byOutcome, over.id, propIdentity(ev, player, spec, line, at));
  }
  return { league, events, byOutcome, at };
}

function indexLocks(parlays) {
  const bySig = new Map();
  for (const p of parlays || []) {
    if (!p) continue;
    const parsed = identitiesFromParlay(p, { lines: true });
    if (!parsed.ok || !parsed.keys || parsed.keys.length < 2) continue;
    const sig = parsed.keys.slice().sort().join('\n');
    const list = bySig.get(sig) || [];
    list.push(p);
    bySig.set(sig, list);
  }
  return bySig;
}

function matchOutcomes(outcomeIds, byOutcome, bySig) {
  if (!byOutcome || !bySig || !Array.isArray(outcomeIds) || outcomeIds.length < 2) {
    return { ok: false, reason: 'unknown' };
  }
  const keys = [];
  let started = false;
  for (const id of outcomeIds) {
    const row = byOutcome.get(String(id));
    if (!row || row.ambiguous || !row.key) return { ok: false, reason: 'unknown' };
    keys.push(row.key);
    if (row.started) started = true;
  }
  if (new Set(keys).size !== keys.length) return { ok: false, reason: 'ambiguous' };
  const locks = bySig.get(keys.slice().sort().join('\n')) || [];
  if (locks.length !== 1) return { ok: false, reason: locks.length ? 'ambiguous' : 'unknown' };
  return { ok: true, lock: locks[0], keys, started };
}

function leaguesForParlays(parlays) {
  const set = new Set();
  for (const p of parlays || []) {
    const keys = [].concat(p && p.leg_keys || [], p && p.legKeys || []);
    const blobs = keys.length ? keys : (p && p.legs || []);
    for (const k of blobs) {
      const t = String(k && k.ticker ? k.ticker : k).toUpperCase();
      if (t.includes('NCAAF') || t.includes('CFB')) set.add('NCAAF');
      else if (t.includes('NFL')) set.add('NFL');
      else if (t.includes('NBA')) set.add('NBA');
      else if (t.includes('MLB')) set.add('MLB');
      else if (t.includes('NHL')) set.add('NHL');
      else if (t.includes('UCL')) set.add('UCL');
    }
  }
  return [...set];
}

module.exports = {
  indexNovigCatalog,
  indexLocks,
  matchOutcomes,
  leaguesForParlays,
  legStarted,
  propLine,
};
