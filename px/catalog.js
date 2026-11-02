// ProphetX sandbox catalog: full-game moneyline / spread / total strikes for NFL, NBA, MLB and
// college football. Sandbox events mirror real games, so each strike maps to a
// real team / opponent that we can price from public Kalshi / Polymarket /
// Novig books. Only these strikes are registered (POST /supported-strikes), so
// ProphetX only sends us RFQs we can price.
'use strict';

const TOURNAMENTS = [
  { id: 31, sport: 'americanfootball_nfl', league: 'nfl' },
  { id: 109, sport: 'baseball_mlb', league: 'mlb' },
  { id: 27653, sport: 'americanfootball_ncaaf', league: 'ncaaf' },
  { id: 132, sport: 'basketball_nba', league: 'nba' },
  // UFC: fight-winner moneyline only (2-way; draw / no contest void, as at Kalshi/books). No rounds/props.
  { id: 1500000003, sport: 'mma_mixed_martial_arts', league: 'ufc', mlOnly: true },
  // Soccer: venue sport keys as used by aibetbuilder book-depth (Odds API keys).
  { id: 17, sport: 'soccer_epl', league: 'epl', soccer: true },
  { id: 7, sport: 'soccer_uefa_champs_league', league: 'ucl', soccer: true },
  { id: 23, sport: 'soccer_italy_serie_a', league: 'seriea', soccer: true },
  { id: 8, sport: 'soccer_spain_la_liga', league: 'laliga', soccer: true },
  { id: 35, sport: 'soccer_germany_bundesliga', league: 'bundesliga', soccer: true },
  { id: 34, sport: 'soccer_france_ligue_one', league: 'ligue1', soccer: true },
  { id: 242, sport: 'soccer_usa_mls', league: 'mls', soccer: true },
  { id: 45, sport: 'soccer_england_league1', league: 'league1', soccer: true },
  { id: 55, sport: 'soccer_mexico_ligamx', league: 'ligamx', soccer: true },
  { id: 46, sport: 'soccer_argentina_primera_division', league: 'argentina', soccer: true },
];
const REGISTER_BATCH = 50;

function fullGameMoneyline(markets) {
  return (markets || []).find((m) => m && m.type === 'moneyline' && m.sub_type === 'moneyline' && m.status !== 'inactive');
}

function fmtLine(x) {
  const n = Number(x);
  return n > 0 ? `+${n}` : `${n}`;
}

// Soccer club names: ProphetX uses "Tottenham Hotspur FC" / "Fenerbahçe SK";
// venues match on "Tottenham Hotspur". Strip club-type tokens and accents.
const CLUB_TOKENS = /\b(FC|AFC|CF|SC|SK|CD|SSC|FK|AC|AS|CA|CLUB)\b\.?/gi;
function soccerName(n) {
  return String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\./g, '')
    .replace(CLUB_TOKENS, ' ').replace(/\s+/g, ' ').trim();
}

function isHalf(line) {
  const n = Number(line);
  return Number.isFinite(n) && Math.abs(Math.abs(n % 1) - 0.5) < 1e-9;
}

// Pure: soccer markets → strikes. Only markets whose settlement is unambiguous:
//   * moneyline_3_way "X to Win (90 Min)" / "Draw (90 Min)" YES/NO
//     (inverse: YES's opponent is that outcome's NO, and vice versa)
//   * "Total Goals (Regular Time)" at .5 lines (no push possible)
//   * "Spread (Regular Time)" at .5 lines (no push possible). ±0.5 is the
//     3-way result: A −0.5 = A wins (opponent: A NO); A +0.5 = A wins or
//     draws (opponent: B wins YES). ±1.5+ priced as spreads.
// "Moneyline (2 Way)": ProphetX does not document draw handling; SANDBOX ONLY
// it is quoted as draw-no-bet (Kevin's call). NOT priced: whole / quarter
// lines (push / split), BTTS, props.
function soccerStrikes(ev, markets, t, base, home, away) {
  const H = soccerName(home.display_name || home.name);
  const A = soccerName(away.display_name || away.name);
  const out = [];
  const sb = { ...base, game: `${A} @ ${H}`, gameAlt: base.game, soccer: true };
  for (const m of markets || []) {
    if (!m || m.status === 'inactive') continue;
    // SANDBOX ONLY (Kevin 12:03 PM ET Oct 19): "Moneyline (2 Way)" quoted ASSUMING
    // a draw voids it (draw no bet). Fair = 1 − P(other team | no draw).
    if (m.sub_type === 'moneyline' && /2 Way/i.test(m.name || '')) {
      for (const side of m.selections || []) {
        const sel = Array.isArray(side) ? side[0] : side;
        if (!sel || !sel.strike_id) continue;
        const isHome = sel.competitor_id === home.id || sel.outcome_id === 4;
        const me = isHome ? H : A;
        const them = isHome ? A : H;
        out.push({ ...sb, strikeId: sel.strike_id, kind: 'DNB', market: '2way', team: `${me} 2-way (draw void)`, opp: them,
          oppLabel: them, drawLabel: 'Draw no', line: null });
      }
      continue;
    }
    if (m.sub_type === 'moneyline_3_way' && /\(90 Min\)/i.test(m.name || '')) {
      const nm = String(m.name).replace(/\s*\(90 Min\)\s*/i, '').trim();
      let who = null;
      if (/^draw$/i.test(nm)) who = 'Draw';
      else {
        const team = nm.replace(/\s+to Win$/i, '').trim();
        const st = soccerName(team);
        if (st === H) who = H; else if (st === A) who = A;
      }
      if (!who) continue;
      for (const side of m.selections || []) {
        const sel = Array.isArray(side) ? side[0] : side;
        if (!sel || !sel.strike_id) continue;
        const yes = sel.outcome_id === 1 || /^yes$/i.test(sel.name || '');
        const no = sel.outcome_id === 2 || /^no$/i.test(sel.name || '');
        if (!yes && !no) continue;
        out.push({ ...sb, strikeId: sel.strike_id, kind: 'ML', market: '3way',
          team: `${who === 'Draw' ? 'Draw' : `${who} win`} ${yes ? 'YES' : 'NO'}`, opp: null,
          oppLabel: yes ? `${who} no` : who, line: null });
      }
      continue;
    }
    if ((m.sub_type === 'total' || m.sub_type === 'spread') && /Regular Time/i.test(m.name || '')) {
      for (const ms of m.market_strikes || []) {
        if (!ms || ms.status === 'inactive' || !Array.isArray(ms.selections)) continue;
        const sels = ms.selections.map((x) => (Array.isArray(x) ? x[0] : x)).filter((x) => x && x.strike_id);
        if (sels.length !== 2) continue;
        for (const sel of sels) {
          const line = Number(sel.strike);
          if (!isHalf(line)) continue;
          if (m.sub_type === 'total') {
            const over = sel.outcome_id === 12 || /^over/i.test(sel.name || '');
            out.push({ ...sb, strikeId: sel.strike_id, kind: 'TOT', team: `${over ? 'Over' : 'Under'} ${line} goals`, opp: null,
              oppLabel: `${over ? 'u' : 'o'}${line}`, line });
          } else {
            const isHome = sel.competitor_id === home.id || sel.outcome_id === 1714;
            const me = isHome ? H : A;
            const them = isHome ? A : H;
            let kind = 'SPR';
            let oppLabel = `${them} ${fmtLine(-line)}`;
            if (line === -0.5) { kind = 'ML'; oppLabel = `${me} no`; }
            if (line === 0.5) { kind = 'ML'; oppLabel = them; }
            out.push({ ...sb, strikeId: sel.strike_id, kind, team: `${me} ${fmtLine(line)}`, opp: them, oppLabel, line });
          }
        }
      }
    }
  }
  return out;
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
  if (t.soccer) return soccerStrikes(ev, markets, t, base, home, away);
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
  if (t.mlOnly) return out;
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

module.exports = { createCatalog, strikesFromEvent, soccerStrikes, soccerName, isHalf, fullGameMoneyline, TOURNAMENTS };
