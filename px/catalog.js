// ProphetX sandbox catalog: full-game moneyline / spread / total strikes for NFL, MLB and
// college football. Sandbox events mirror real games, so each strike maps to a
// real team / opponent that we can price from public Kalshi / Polymarket /
// Novig books. Only these strikes are registered (POST /supported-strikes), so
// ProphetX only sends us RFQs we can price.
'use strict';

const TOURNAMENTS = [
  { id: 31, sport: 'americanfootball_nfl', league: 'nfl' },
  { id: 109, sport: 'baseball_mlb', league: 'mlb' },
  { id: 27653, sport: 'americanfootball_ncaaf', league: 'ncaaf' },
];
const REGISTER_BATCH = 50;

function fullGameMoneyline(markets) {
  return (markets || []).find((m) => m && m.type === 'moneyline' && m.sub_type === 'moneyline' && m.status !== 'inactive');
}

function fmtLine(x) {
  const n = Number(x);
  return n > 0 ? `+${n}` : `${n}`;
}

// Pure: event + markets → [{strikeId, eventId, kind, team, opp, label, oppLabel, line, game, sport, startMs}]
// Full-game only: moneyline (kind ML), spread (SPR), total (TOT). The opponent
// label is what the inverse method prices (other team; other side of the line).
function strikesFromEvent(ev, markets, t) {
  const comps = ev.competitors || [];
  const home = comps.find((c) => c.side === 'home');
  const away = comps.find((c) => c.side === 'away');
  if (!home || !away) return [];
  const nameOf = (c) => c.display_name || c.name;
  const startMs = Date.parse(ev.scheduled) || null;
  const game = `${nameOf(away)} @ ${nameOf(home)}`;
  const base = { eventId: ev.event_id, game, sport: t.sport, league: t.league, startMs };
  const out = [];
  const ml = fullGameMoneyline(markets);
  if (ml && Array.isArray(ml.selections)) {
    const pair = [];
    for (const side of ml.selections) {
      const sel = Array.isArray(side) ? side[0] : side;
      if (!sel || !sel.strike_id) continue;
      const isHome = sel.competitor_id === home.id || sel.outcome_id === 4;
      const team = isHome ? home : away;
      const opp = isHome ? away : home;
      pair.push({ ...base, strikeId: sel.strike_id, kind: 'ML', team: nameOf(team), opp: nameOf(opp), label: nameOf(team), oppLabel: nameOf(opp), line: null });
    }
    if (pair.length === 2) out.push(...pair);
  }
  for (const m of markets || []) {
    if (!m || (m.sub_type !== 'spread' && m.sub_type !== 'total') || m.status === 'inactive') continue;
    for (const ms of m.market_strikes || []) {
      if (!ms || ms.status === 'inactive' || !Array.isArray(ms.selections)) continue;
      const sels = ms.selections.map((x) => (Array.isArray(x) ? x[0] : x)).filter((x) => x && x.strike_id);
      if (sels.length !== 2) continue;
      for (const sel of sels) {
        const line = Number(sel.strike);
        if (!Number.isFinite(line)) continue;
        if (m.sub_type === 'total') {
          const over = sel.outcome_id === 12 || /^over/i.test(sel.name || '');
          out.push({ ...base, strikeId: sel.strike_id, kind: 'TOT', team: `${over ? 'Over' : 'Under'} ${line}`, opp: null,
            label: `${over ? 'o' : 'u'}${line}`, oppLabel: `${over ? 'u' : 'o'}${line}`, line });
        } else {
          const isHome = sel.competitor_id === home.id || sel.outcome_id === 1714;
          const team = isHome ? home : away;
          const opp = isHome ? away : home;
          out.push({ ...base, strikeId: sel.strike_id, kind: 'SPR', team: `${nameOf(team)} ${fmtLine(line)}`, opp: nameOf(opp),
            label: `${nameOf(team)} ${fmtLine(line)}`, oppLabel: `${nameOf(opp)} ${fmtLine(-line)}`, line });
        }
      }
    }
  }
  return out;
}

function createCatalog({ apiBase, parlayBase, session, fetch: f = globalThis.fetch, logger = console, horizonMs = 8 * 24 * 3600 * 1000 } = {}) {
  const known = new Map(); // strikeId → info
  let registered = new Set();

  async function getJson(url, tries = 3) {
    let res;
    for (let i = 0; ; i += 1) {
      try { res = await f(url, { headers: await session.authHeaders() }); break; } catch (e) {
        if (i + 1 >= tries) throw e;
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
    const j = await res.json().catch(() => null);
    if (res.status !== 200) throw new Error(`GET ${new URL(url).pathname} ${res.status}`);
    return j && j.data;
  }

  async function strikesCall(method, ids) {
    for (let i = 0; i < ids.length; i += REGISTER_BATCH) {
      const chunk = ids.slice(i, i + REGISTER_BATCH);
      const res = await f(`${parlayBase}/supported-strikes`, {
        method, headers: await session.authHeaders(), body: JSON.stringify({ supported_strikes: chunk }),
      });
      if (res.status !== 200) {
        const j = await res.json().catch(() => ({}));
        throw new Error(`${method} supported-strikes ${res.status} ${j.error || ''} ${String(j.message || '').slice(0, 120)}`);
      }
    }
  }

  async function refresh(nowMs = Date.now()) {
    const next = new Map();
    for (const t of TOURNAMENTS) {
      let events = [];
      try {
        const d = await getJson(`${apiBase}/mm/get_sport_events?tournament_id=${t.id}`);
        events = (d && d.sport_events) || [];
      } catch (e) { logger.warn(`[PX-CAT] events ${t.league}: ${e.message}`); continue; }
      for (const ev of events) {
        const start = Date.parse(ev.scheduled);
        if (ev.status !== 'not_started' || !(start > nowMs + 60_000) || start > nowMs + horizonMs) continue;
        try {
          const d = await getJson(`${apiBase}/v4/mm/get_markets?event_id=${ev.event_id}`);
          for (const s of strikesFromEvent(ev, d && d.markets, t)) next.set(s.strikeId, s);
        } catch (e) { logger.warn(`[PX-CAT] markets ${ev.event_id}: ${e.message}`); }
      }
    }
    known.clear();
    for (const [k, v] of next) known.set(k, v);
    const want = new Set(next.keys());
    const add = [...want].filter((x) => !registered.has(x));
    const drop = [...registered].filter((x) => !want.has(x));
    if (add.length) await strikesCall('POST', add);
    if (drop.length) await strikesCall('DELETE', drop).catch((e) => logger.warn(`[PX-CAT] ${e.message}`));
    registered = want;
    const kinds = {}; for (const v of next.values()) kinds[v.kind] = (kinds[v.kind] || 0) + 1;
    logger.log(`[PX-CAT] strikes=${want.size} ${JSON.stringify(kinds)} (+${add.length} −${drop.length})`);
    return { size: want.size, added: add.length, dropped: drop.length };
  }

  // On boot, drop anything registered by a previous process that we no longer price.
  async function syncRemote() {
    const ids = [];
    let token = '';
    for (let i = 0; i < 300; i += 1) {
      const d = await getJson(`${parlayBase}/supported-strikes?limit=100${token ? `&token=${encodeURIComponent(token)}` : ''}`);
      ids.push(...((d && d.supported_strikes) || []));
      token = d && d.token;
      if (!token) break;
    }
    registered = new Set(ids);
    return ids.length;
  }

  return { known, refresh, syncRemote, registeredCount: () => registered.size };
}

module.exports = { createCatalog, strikesFromEvent, fullGameMoneyline, TOURNAMENTS };
