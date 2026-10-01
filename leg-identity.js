// Cross-venue sports-leg identity for Combo Locks (Kalshi tickers) vs
// Polymarket comboLegs (market metadata).
//
// Combo Locks in this worker only persist Kalshi `TICKER:yes|no` / legs[].ticker
// — there is no team/date column. Tickers encode series + ET date + teams +
// selection, so we derive identity from that rather than waiting on a
// site-side polymarket_symbol column.
//
// Polymarket identity comes from market metadata (market_sport_type,
// event_start_time, long/short_participant_id) when present. Production
// combo RFQs use game slugs `aec-{league}-{t1}-{t2}-{YYYY-MM-DD}` with
// BUY = first team and SELL = second; those parse without HTTP. Skip when
// the market type is not a full-game moneyline Combo Locks can price, or
// more than one parlay matches. TEAM:no canonicalizes to opponent:yes.
//
// NCAAF (college football): Kalshi KXNCAAF* and Poly cfb use DIFFERENT team codes, so
// every NCAAF team is translated through ncaaf-crosswalk.json (built from real Kalshi
// events + Poly team metadata, names AND ET date must agree). The canonical team in an
// NCAAF identity is the Polymarket abbreviation. Unknown team / ambiguous blob =>
// no identity. NCAAF is Poly-only (opts.lines): the Kalshi matcher never sees it.
//
// LINE LEGS (spread / total; NFL, MLB, NHL, NCAAF full game only). Both venues are
// canonicalized to ONE exact space and compared by exact string equality:
//   spread  canonical (first team alphabetically, line from ITS side, yes|no); the
//           other team's cover is the complement => same team/line with side NO
//           Kalshi KXNFLSPREAD-…-SEA7:yes  = SEA wins by over 6.5 = SEA -6.5
//           Kalshi …-SEA7:no               = opponent +6.5
//           Poly asc-nfl-lac-sea-…-pos-6pt5 BUY  = LAC +6.5 (long = FIRST slug team)
//           Poly …-pos-6pt5 SELL = SEA -6.5 ; …-neg-6pt5 BUY = LAC -6.5, SELL = SEA +6.5
//   total   selection=over|under line=<exact> side=yes
//           Kalshi KXNFLTOTAL-…-43:yes = Over 42.5, :no = Under 42.5 (ticker N => N-0.5)
//           Poly tsc-nfl-…-total-42pt5 (NHL/MLB: …-6pt5) BUY = Over, SELL = Under
// Half-point lines only (no pushes, so :no is exactly the opponent cover / Under).
// The line is part of the key: 42.5 never equals 43.5 (NO snapping). The Poly side
// is only trusted after the market metadata (GET /v1/market/slug) confirms the
// sportsMarketType, signed line, long/short team (or Over/Under) and ET game date;
// anything that disagrees or is missing => no identity => never quoted.
'use strict';
const { parseKalshiTickerStart, parseTs } = require('./started');
const NCAAF = require('./ncaaf-crosswalk');
const PROPX = require('./player-prop-crosswalk');

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const SERIES = {
  KXMLBGAME: { league: 'mlb', marketType: 'moneyline', period: 'full', teamLen: 3 },
  KXNBAGAME: { league: 'nba', marketType: 'moneyline', period: 'full', teamLen: 3 },
  KXNHLGAME: { league: 'nhl', marketType: 'moneyline', period: 'full', teamLen: null }, // LA/NJ/SJ/TB are 2 letters
  KXNFLGAME: { league: 'nfl', marketType: 'moneyline', period: 'full', teamLen: null },
};

const PRICEABLE_SPORT_TYPES = new Set([
  'baseball_team_full_game_winner',
  'basketball_team_full_game_winner',
  'football_team_full_game_winner',
  'hockey_team_full_game_winner',
]);

const SUBCATEGORY_LEAGUE = {
  BASEBALL: 'mlb',
  BASKETBALL: 'nba',
  FOOTBALL: 'nfl',
  HOCKEY: 'nhl',
};

// League-scoped aliases only — do not invent cross-league maps (CHI is Cubs, not Sox).
const TEAM_ALIASES = {
  mlb: {
    chw: 'cws', wsh: 'was', tbr: 'tb', sdp: 'sd', sfg: 'sf', sfo: 'sf',
    kcr: 'kc', oak: 'ath', ari: 'az',
  },
  nfl: { gnb: 'gb', jac: 'jax', wsh: 'was' },
  nba: { uta: 'utah', pho: 'phx', gsw: 'gs', nyk: 'ny', nop: 'no' },
  // Polymarket US slugs use mon/nas/veg/was; Kalshi KXNHLGAME uses MTL/NSH/VGK/WSH.
  nhl: { mon: 'mtl', nas: 'nsh', veg: 'vgk', was: 'wsh', utah: 'uta', lak: 'la', njd: 'nj', sjs: 'sj', tbl: 'tb', cal: 'cgy' },
};

const NFL_CODES = [
  'ari', 'atl', 'bal', 'buf', 'car', 'chi', 'cin', 'cle', 'dal', 'den', 'det',
  'gb', 'gnb', 'hou', 'ind', 'jac', 'jax', 'kc', 'lac', 'lar', 'lv', 'mia',
  'min', 'ne', 'no', 'nyg', 'nyj', 'phi', 'pit', 'sea', 'sf', 'tb', 'ten',
  'was', 'wsh',
].sort((a, b) => b.length - a.length);

// Kalshi MLB blobs are usually 3+3 (CWSDET) but often 2+3 / 3+2 / 2+2
// (TBTEX, PHIAZ, SDTB). 2-char codes used on KXMLBGAME: tb, sd, sf, kc, az.
const MLB_CODES = [
  'ari', 'ath', 'atl', 'az', 'bal', 'bos', 'chc', 'chw', 'cin', 'cle', 'col',
  'cws', 'det', 'hou', 'kc', 'kcr', 'laa', 'lad', 'mia', 'mil', 'min', 'nym',
  'nyy', 'oak', 'phi', 'pit', 'sd', 'sdp', 'sea', 'sf', 'sfg', 'sfo', 'stl',
  'tb', 'tbr', 'tex', 'tor', 'was', 'wsh',
].sort((a, b) => b.length - a.length);

// Kalshi KXNHLGAME codes (2026-09-30 live slate) plus the Polymarket variants.
// Two-letter clubs (LA, NJ, SJ, TB) make even-split parsing wrong: TBNYR, LASJ.
const NHL_CODES = [
  'ana', 'bos', 'buf', 'car', 'cbj', 'cgy', 'chi', 'col', 'dal', 'det', 'edm',
  'fla', 'la', 'min', 'mtl', 'nj', 'nsh', 'nyi', 'nyr', 'ott', 'phi', 'pit',
  'sea', 'sj', 'stl', 'tb', 'tor', 'uta', 'van', 'vgk', 'wpg', 'wsh',
].sort((a, b) => b.length - a.length);

const LEAGUE_TEAM_CODES = { nfl: NFL_CODES, mlb: MLB_CODES, nhl: NHL_CODES };

const DT_TIME_RE = /^(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{4})(.*)$/i;
// NFL GAME tickers are often date-only: 26SEP13ARILAC (no HHMM).
const DT_DATE_RE = /^(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(?!\d)(.*)$/i;

function normTeam(league, code) {
  const raw = String(code || '').trim().toLowerCase();
  if (!raw) return '';
  const aliases = TEAM_ALIASES[league] || {};
  return aliases[raw] || raw;
}

function participantCode(id) {
  const s = String(id || '').trim().toLowerCase();
  if (!s) return '';
  const i = s.lastIndexOf('-');
  return i === -1 ? s : s.slice(i + 1);
}

function leagueFromParticipant(id) {
  const s = String(id || '').trim().toLowerCase();
  const i = s.indexOf('-');
  if (i <= 0) return '';
  const prefix = s.slice(0, i);
  if (prefix === 'mlb' || prefix === 'nba' || prefix === 'nfl' || prefix === 'nhl') return prefix;
  return '';
}

function etDateFromYmd(year, month, day) {
  if (!year || !month || !day) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseKalshiDateRest(rest) {
  const timed = DT_TIME_RE.exec(String(rest || ''));
  if (timed) {
    const hour = parseInt(timed[4].slice(0, 2), 10);
    const minute = parseInt(timed[4].slice(2, 4), 10);
    if (hour <= 23 && minute <= 59) {
      const startMs = parseKalshiTickerStart(timed[1] + timed[2] + timed[3] + timed[4]);
      const date = etDateFromMs(startMs);
      if (date) return { date, teamsBlob: timed[5] || '', startMs };
    }
  }
  const dated = DT_DATE_RE.exec(String(rest || ''));
  if (!dated) return null;
  const year = 2000 + parseInt(dated[1], 10);
  const month = MONTHS[dated[2].toUpperCase()];
  const day = parseInt(dated[3], 10);
  const date = etDateFromYmd(year, month, day);
  if (!date) return null;
  return { date, teamsBlob: dated[4] || '' };
}

function etDateFromMs(ms) {
  if (!Number.isFinite(ms)) return null;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(ms));
}

function etDateFromValue(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
  const raw = typeof v === 'string' ? v.trim().replace(' ', 'T') : v;
  const ms = parseTs(raw);
  return etDateFromMs(ms);
}

function splitKnownCodes(s, league) {
  const codes = LEAGUE_TEAM_CODES[league];
  if (!codes) return null;
  for (const a of codes) {
    if (!s.startsWith(a)) continue;
    const rest = s.slice(a.length);
    if (codes.includes(rest)) return [a, rest];
  }
  return null;
}

function splitTeams(blob, league, teamLen) {
  const s = String(blob || '').toLowerCase();
  if (!s) return null;
  if (teamLen && s.length === teamLen * 2) {
    return [s.slice(0, teamLen), s.slice(teamLen)];
  }
  const known = splitKnownCodes(s, league);
  if (known) return known;
  if (s.length === 6) return [s.slice(0, 3), s.slice(3)];
  if (s.length === 4) return [s.slice(0, 2), s.slice(2)];
  return null;
}

function identityKey(id) {
  if (!id || !id.league || !id.date || !id.selection || !id.side || !id.marketType) return null;
  if (!Array.isArray(id.teams) || id.teams.length < 2) return null;
  const teams = id.teams.map((t) => normTeam(id.league, t)).filter(Boolean).sort();
  if (teams.length < 2) return null;
  const parts = [
    id.league,
    id.date,
    teams.join('+'),
    id.marketType,
    id.period || 'full',
    normTeam(id.league, id.selection),
    id.side,
  ];
  // Spread / total legs carry the EXACT line in the key (signed from the
  // selection's side for spreads, e.g. sea|-6.5 ; over|42.5 for totals). ML keys
  // keep their historical 7-part shape.
  if (id.line != null) parts.push(`L${id.line}`);
  return parts.join('|');
}

function makeIdentity(partial) {
  const id = {
    league: partial.league,
    date: partial.date,
    teams: (partial.teams || []).map((t) => normTeam(partial.league, t)).filter(Boolean),
    marketType: partial.marketType,
    period: partial.period || 'full',
    selection: normTeam(partial.league, partial.selection),
    side: partial.side,
  };
  if (partial.line != null) id.line = partial.line;
  // First-pitch / kickoff ms (Kalshi ticker HHMM, or Poly gameStartTime). NOT part
  // of the key; used only by startTimesAgree() to reject doubleheader mix-ups.
  if (partial.startMs != null && Number.isFinite(partial.startMs)) id.startMs = partial.startMs;
  if (id.teams.length >= 2) {
    const uniq = [...new Set(id.teams)].sort();
    id.teams = uniq;
  }
  // 2-way ML: TEAM:no is the opponent winning. Combo Locks keys are always
  // the winner at :yes so Kalshi TEX:yes matches a Poly game-slug SELL
  // (long=tb / first slug team, side=no).
  if (
    id.marketType === 'moneyline'
    && id.line == null
    && id.side === 'no'
    && id.teams.length === 2
    && id.selection
  ) {
    const other = id.teams.find((t) => t !== id.selection);
    if (other) {
      id.selection = other;
      id.side = 'yes';
    }
  }
  // Spread canonical form: (alphabetically-first team F, line from F's side, yes|no).
  // "S covers l" for the OTHER team S is the exact COMPLEMENT of "F covers -l" on a
  // half-point line (no push), so it becomes (F, -l, NO). It is NEVER the same key as
  // "F covers l" — that would turn a -6.5 favourite into the +6.5 dog (wrong side).
  if (id.marketType === 'spread' && id.teams.length === 2 && id.selection && id.line != null) {
    const first = id.teams[0];
    if (id.selection !== first && id.teams.includes(id.selection)) {
      id.selection = first;
      id.line = -id.line;
      id.side = id.side === 'yes' ? 'no' : 'yes';
    }
  }
  return identityKey(id) ? id : null;
}

// Raw ticker pieces before identity aliases / sort. Slug builders need the
// codes as they appear (wsh, cws), not spoken names and not always normTeam
// (mlb wsh → was). Combo Locks identity still goes through makeIdentity.
function kalshiTickerPieces(text, sideOverride) {
  if (text == null || text === '') return null;
  let raw = String(text).trim();
  let side = sideOverride ? String(sideOverride).toLowerCase() : '';
  const sideAt = raw.lastIndexOf(':');
  if (sideAt > 0) {
    const maybe = raw.slice(sideAt + 1).toLowerCase();
    if (maybe === 'yes' || maybe === 'no') {
      if (!side) side = maybe;
      raw = raw.slice(0, sideAt);
    }
  }
  if (!side) side = 'yes';
  if (side !== 'yes' && side !== 'no') return null;

  let series = '';
  let rest = raw;
  const dash = raw.indexOf('-');
  if (dash > 0 && /^KX[A-Z]+$/i.test(raw.slice(0, dash))) {
    series = raw.slice(0, dash).toUpperCase();
    rest = raw.slice(dash + 1);
  }
  const spec = SERIES[series];
  if (!spec) return null;

  const parsed = parseKalshiDateRest(rest);
  if (!parsed) return null;
  const date = parsed.date;

  let teamsBlob = parsed.teamsBlob || '';
  let selection = '';
  const selDash = teamsBlob.lastIndexOf('-');
  if (selDash > 0) {
    selection = teamsBlob.slice(selDash + 1);
    teamsBlob = teamsBlob.slice(0, selDash);
  }
  const pair = splitTeams(teamsBlob, spec.league, spec.teamLen);
  if (!pair) return null;
  if (!selection) selection = pair[0];

  return {
    series,
    league: spec.league,
    date,
    teams: [String(pair[0]).toLowerCase(), String(pair[1]).toLowerCase()],
    selection: String(selection).toLowerCase(),
    side,
    marketType: spec.marketType,
    period: spec.period,
  };
}

function parseKalshiTicker(text, sideOverride) {
  const pieces = kalshiTickerPieces(text, sideOverride);
  if (!pieces) return null;
  return makeIdentity({
    league: pieces.league,
    date: pieces.date,
    teams: pieces.teams,
    marketType: pieces.marketType,
    period: pieces.period,
    selection: pieces.selection,
    side: pieces.side,
  });
}

// ── Line legs (spread / total) ─────────────────────────────────────────────
const LINE_SERIES = {
  KXNFLSPREAD: { league: 'nfl', kind: 'spread', teamLen: null },
  KXNFLTOTAL: { league: 'nfl', kind: 'total', teamLen: null },
  KXMLBSPREAD: { league: 'mlb', kind: 'spread', teamLen: 3 },
  KXMLBTOTAL: { league: 'mlb', kind: 'total', teamLen: 3 },
  KXNHLSPREAD: { league: 'nhl', kind: 'spread', teamLen: null },
  KXNHLTOTAL: { league: 'nhl', kind: 'total', teamLen: null },
  // NCAAF: team codes only via the verified crosswalk (never even-split / guessed).
  KXNCAAFSPREAD: { league: 'ncaaf', kind: 'spread', teamLen: null, crosswalk: true },
  KXNCAAFTOTAL: { league: 'ncaaf', kind: 'total', teamLen: null, crosswalk: true },
};

// Poly full-game market types we map. `slugLeagues` = the Poly slug/team league
// token(s) allowed for that sportsMarketType: football is shared by NFL ("nfl") and
// college ("cfb"); the slug league decides, and team.league must agree with it.
const POLY_LINE_SPORT = {
  football_team_full_game_spread: { league: 'nfl', slugLeagues: ['nfl', 'cfb'], kind: 'spread' },
  football_team_full_game_total: { league: 'nfl', slugLeagues: ['nfl', 'cfb'], kind: 'total' },
  baseball_team_full_game_spread: { league: 'mlb', slugLeagues: ['mlb'], kind: 'spread' },
  baseball_team_full_game_total: { league: 'mlb', slugLeagues: ['mlb'], kind: 'total' },
  hockey_team_full_game_spread: { league: 'nhl', slugLeagues: ['nhl'], kind: 'spread' },
  hockey_team_full_game_total: { league: 'nhl', slugLeagues: ['nhl'], kind: 'total' },
};

// Poly slug league token -> identity league.
const POLY_SLUG_TO_LEAGUE = { nfl: 'nfl', mlb: 'mlb', nhl: 'nhl', cfb: 'ncaaf' };

const NCAAF_ML_SERIES = 'KXNCAAFGAME';
const POLY_LINE_SLUG_RE =
  /^(asc|tsc)-(nfl|mlb|nhl|cfb)-([a-z0-9]+)-([a-z0-9]+)-(\d{4})-(\d{2})-(\d{2})-(?:(neg|pos)-|(?:total-)?)(\d{1,3})pt(\d)$/;

function isPolyLineSlug(symbol) {
  return /^(asc|tsc)-/.test(String(symbol || '').trim().toLowerCase());
}

function isHalfPoint(n) {
  return Number.isFinite(n) && Math.abs(Math.abs(n) % 1 - 0.5) < 1e-9;
}

function parseLabelLine(label) {
  const m = String(label || '').match(/([+\-\u2212])?\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const mag = parseFloat(m[2]);
  if (!Number.isFinite(mag)) return null;
  const sign = m[1] === '-' || m[1] === '\u2212' ? '-' : (m[1] === '+' ? '+' : '');
  return { sign, mag };
}

// Kalshi spread / total ticker → canonical line identity (null if not exact).
// `label` (optional Combo Locks leg label such as "Seattle −6.5" / "Under 42.5")
// is a cross-check: any disagreement on side or line => null (never guess).
function parseKalshiLineTicker(text, sideOverride, label, opts) {
  const needLabel = !!(opts && opts.requireLabel);
  if (needLabel && (label == null || label === '')) return null;
  if (text == null || text === '') return null;
  let raw = String(text).trim();
  let side = sideOverride ? String(sideOverride).toLowerCase() : '';
  const sideAt = raw.lastIndexOf(':');
  if (sideAt > 0) {
    const maybe = raw.slice(sideAt + 1).toLowerCase();
    if (maybe === 'yes' || maybe === 'no') {
      if (!side) side = maybe;
      raw = raw.slice(0, sideAt);
    }
  }
  if (!side) side = 'yes';
  if (side !== 'yes' && side !== 'no') return null;
  const dash = raw.indexOf('-');
  if (dash <= 0) return null;
  const spec = LINE_SERIES[raw.slice(0, dash).toUpperCase()];
  if (!spec) return null;
  const parsed = parseKalshiDateRest(raw.slice(dash + 1));
  if (!parsed) return null;
  const selDash = parsed.teamsBlob.lastIndexOf('-');
  if (selDash <= 0) return null;
  const blob = parsed.teamsBlob.slice(0, selDash);
  const suffix = parsed.teamsBlob.slice(selDash + 1);
  let pair;
  let kcodes = null; // NCAAF: the two Kalshi codes behind `pair` (poly abbreviations)
  if (spec.crosswalk) {
    const sp = NCAAF.splitBlob(blob);
    if (!sp) return null; // unknown team / ambiguous blob => unmapped
    pair = sp.pair;
    kcodes = sp.codes;
    // The lock leg's own "A vs B" text must name exactly these two teams.
    if (needLabel && !NCAAF.gameNamesAgree(opts && opts.game, kcodes)) return null;
    if (!needLabel && opts && opts.game != null && !NCAAF.gameNamesAgree(opts.game, kcodes)) return null;
  } else {
    pair = splitTeams(blob, spec.league, spec.teamLen);
  }
  if (!pair) return null;
  const teams = [String(pair[0]).toLowerCase(), String(pair[1]).toLowerCase()];

  let selection;
  let line;
  let marketType;
  if (spec.kind === 'spread') {
    const m = /^([A-Za-z]+)(\d{1,3})$/.exec(suffix);
    if (!m) return null;
    let code;
    if (spec.crosswalk) {
      const kc = m[1].toUpperCase();
      if (!kcodes.includes(kc)) return null;
      code = NCAAF.teamByCode(kc).p;
    } else {
      code = normTeam(spec.league, m[1].toLowerCase());
    }
    const normTeams = teams.map((t) => normTeam(spec.league, t));
    if (!normTeams.includes(code)) return null;
    const mag = parseInt(m[2], 10) - 0.5;
    if (!isHalfPoint(mag) || mag <= 0) return null;
    // yes: <code> wins by over <mag> => <code> -mag. no: opponent +mag.
    // no: opponent +mag (exact complement, half-point line => no push).
    if (side === 'yes') { selection = code; line = -mag; } else {
      selection = normTeams.find((t) => t !== code);
      line = mag;
    }
    marketType = 'spread';
    if (label != null && label !== '') {
      const l = parseLabelLine(label);
      if (!l || l.mag !== mag || l.sign !== (line < 0 ? '-' : '+')) return null;
      if (spec.crosswalk) {
        // The label's team (the side actually being bought) must be that team by name.
        const t = NCAAF.teamByPoly(selection);
        const labelTeam = String(label).replace(/\s*[+\-\u2212]?\s*\d+(?:\.\d+)?\s*$/, '');
        if (!t || NCAAF.norm(labelTeam) !== NCAAF.norm(t.name)) return null;
      }
    }
  } else {
    if (!/^\d{1,3}$/.test(suffix)) return null;
    const mag = parseInt(suffix, 10) - 0.5;
    if (!isHalfPoint(mag) || mag <= 0) return null;
    selection = side === 'yes' ? 'over' : 'under';
    line = mag;
    marketType = 'total';
    if (label != null && label !== '') {
      const l = parseLabelLine(label);
      const hasOver = /\bover\b/i.test(label);
      const hasUnder = /\bunder\b/i.test(label);
      const word = hasOver && !hasUnder ? 'over' : (hasUnder && !hasOver ? 'under' : null);
      // The label must say Over or Under explicitly, and agree with :yes/:no.
      if (!l || l.mag !== mag || word !== selection) return null;
    }
  }
  return makeIdentity({
    league: spec.league,
    date: parsed.date,
    teams,
    marketType,
    period: 'full',
    selection,
    side: 'yes',
    line,
    startMs: parsed.startMs,
  });
}

// NCAAF moneyline (KXNCAAFGAME-26OCT03TXSTSDSU-TXST:yes). Poly-only (never added to
// SERIES, so the Kalshi matcher is untouched). Teams come ONLY from the verified
// crosswalk; the lock leg label must be the picked team's name and the leg's
// "A vs B" text must name both teams. :no is not mapped (label semantics unproven).
function parseKalshiNcaafMlTicker(text, sideOverride, label, opts) {
  const needLabel = !!(opts && opts.requireLabel);
  if (text == null || text === '') return null;
  let raw = String(text).trim();
  let side = sideOverride ? String(sideOverride).toLowerCase() : '';
  const sideAt = raw.lastIndexOf(':');
  if (sideAt > 0) {
    const maybe = raw.slice(sideAt + 1).toLowerCase();
    if (maybe === 'yes' || maybe === 'no') {
      if (!side) side = maybe;
      raw = raw.slice(0, sideAt);
    }
  }
  if (!side) side = 'yes';
  if (side !== 'yes') return null;
  const dash = raw.indexOf('-');
  if (dash <= 0 || raw.slice(0, dash).toUpperCase() !== NCAAF_ML_SERIES) return null;
  const parsed = parseKalshiDateRest(raw.slice(dash + 1));
  if (!parsed || parsed.startMs != null) return null;
  const selDash = parsed.teamsBlob.lastIndexOf('-');
  if (selDash <= 0) return null;
  const sp = NCAAF.splitBlob(parsed.teamsBlob.slice(0, selDash));
  if (!sp) return null;
  const kc = parsed.teamsBlob.slice(selDash + 1).toUpperCase();
  if (!sp.codes.includes(kc)) return null;
  const team = NCAAF.teamByCode(kc);
  if (!team) return null;
  if (needLabel) {
    if (label == null || label === '') return null;
    if (!NCAAF.gameNamesAgree(opts && opts.game, sp.codes)) return null;
  } else if (opts && opts.game != null && !NCAAF.gameNamesAgree(opts.game, sp.codes)) {
    return null;
  }
  if (label != null && label !== '' && NCAAF.norm(label) !== NCAAF.norm(team.name)) return null;
  return makeIdentity({
    league: 'ncaaf',
    date: parsed.date,
    teams: sp.pair,
    marketType: 'moneyline',
    period: 'full',
    selection: team.p,
    side: 'yes',
  });
}

// Poly asc-/tsc- slug (+ optional verified market metadata) → canonical identity.
// Without `market` the identity is slug-derived and marked unverified: usable
// only as a cheap candidate prefilter, never to quote. With `market`, every
// field is cross-checked against the metadata; any disagreement => no identity.
function identityFromPolymarketLine(symbol, rfqSide, market) {
  const s = String(symbol || '').trim().toLowerCase();
  const m = POLY_LINE_SLUG_RE.exec(s);
  if (!m) return { identity: null, reason: 'not_priceable' };
  const yesNo = polymarketYesNo(rfqSide);
  if (!yesNo) return { identity: null, reason: 'unmatched_leg' };
  const kind = m[1] === 'asc' ? 'spread' : 'total';
  const slugLeague = m[2]; // nfl | mlb | nhl | cfb (Poly team.league uses the same token)
  const league = POLY_SLUG_TO_LEAGUE[slugLeague];
  const t1 = m[3];
  const t2 = m[4];
  const date = `${m[5]}-${m[6]}-${m[7]}`;
  if (kind === 'spread' && !m[8]) return { identity: null, reason: 'not_priceable' };
  if (kind === 'total' && m[8]) return { identity: null, reason: 'not_priceable' };
  const mag = parseFloat(`${m[9]}.${m[10]}`);
  if (!isHalfPoint(mag) || mag <= 0) return { identity: null, reason: 'not_priceable' };
  const signed = kind === 'spread' ? (m[8] === 'neg' ? -mag : mag) : mag;

  let verified = false;
  if (market != null) {
    const mk = unwrapMarket(market);
    if (!mk || typeof mk !== 'object') return { identity: null, reason: 'missing_metadata' };
    const spec = POLY_LINE_SPORT[String(mk.sportsMarketType || mk.sports_market_type || '')];
    if (!spec || spec.kind !== kind || !spec.slugLeagues.includes(slugLeague)) {
      return { identity: null, reason: 'not_priceable' };
    }
    if (mk.slug && String(mk.slug).toLowerCase() !== s) return { identity: null, reason: 'meta_mismatch' };
    if (Number(mk.line) !== signed) return { identity: null, reason: 'meta_mismatch' };
    const metaDate = etDateFromValue(mk.gameStartTime || mk.game_start_time);
    if (!metaDate || metaDate !== date) return { identity: null, reason: 'meta_mismatch' };
    const sides = mk.marketSides || mk.market_sides;
    if (!Array.isArray(sides) || sides.length !== 2) return { identity: null, reason: 'meta_mismatch' };
    const longs = sides.filter((x) => x && x.long === true);
    const shorts = sides.filter((x) => x && x.long === false);
    if (longs.length !== 1 || shorts.length !== 1) return { identity: null, reason: 'meta_mismatch' };
    if (kind === 'spread') {
      const abbr = (x) => {
        const t = (x && x.team) || {};
        return normTeam(league, String(t.abbreviation || t.displayAbbreviation || '').toLowerCase());
      };
      if (abbr(longs[0]) !== normTeam(league, t1) || abbr(shorts[0]) !== normTeam(league, t2)) {
        return { identity: null, reason: 'meta_mismatch' };
      }
      if (String((longs[0].team || {}).league || '').toLowerCase() !== slugLeague
        || String((shorts[0].team || {}).league || '').toLowerCase() !== slugLeague) {
        return { identity: null, reason: 'meta_mismatch' };
      }
      // The long side's printed handicap must equal the signed slug/line.
      const ld = String(longs[0].description || '').trim();
      if (ld !== '' && Number(ld) !== signed) return { identity: null, reason: 'meta_mismatch' };
    } else {
      const d = (x) => String((x && x.description) || '').trim().toLowerCase();
      if (d(longs[0]) !== 'over' || d(shorts[0]) !== 'under') {
        return { identity: null, reason: 'meta_mismatch' };
      }
    }
    if (league === 'ncaaf') {
      // College: both slug abbreviations must be crosswalk teams and the metadata's
      // own team names (spread) / question (total) must name exactly those teams.
      const T1 = NCAAF.teamByPoly(t1);
      const T2 = NCAAF.teamByPoly(t2);
      if (!T1 || !T2 || t1 === t2) return { identity: null, reason: 'meta_mismatch' };
      if (kind === 'spread') {
        const nm = (x) => NCAAF.norm(((x && x.team) || {}).name);
        if (nm(longs[0]) !== NCAAF.norm(T1.pname) || nm(shorts[0]) !== NCAAF.norm(T2.pname)) {
          return { identity: null, reason: 'meta_mismatch' };
        }
      } else {
        const q = NCAAF.norm(mk.question);
        if (!q || !q.includes(NCAAF.norm(T1.pname)) || !q.includes(NCAAF.norm(T2.pname))) {
          return { identity: null, reason: 'meta_mismatch' };
        }
      }
    }
    verified = true;
  } else if (league === 'ncaaf' && !(NCAAF.teamByPoly(t1) && NCAAF.teamByPoly(t2) && t1 !== t2)) {
    return { identity: null, reason: 'not_priceable' };
  }

  let selection;
  let line;
  if (kind === 'spread') {
    // long (BUY) = first slug team at the signed line; short (SELL) = opponent, -line.
    if (yesNo === 'yes') { selection = t1; line = signed; } else { selection = t2; line = -signed; }
  } else {
    selection = yesNo === 'yes' ? 'over' : 'under';
    line = signed;
  }
  let startMs = null;
  if (verified) {
    const mk = unwrapMarket(market);
    const t = Date.parse(mk.gameStartTime || mk.game_start_time || '');
    if (Number.isFinite(t)) startMs = t;
  }
  const id = makeIdentity({
    league,
    date,
    teams: [t1, t2],
    marketType: kind,
    period: 'full',
    selection,
    side: 'yes',
    line,
    startMs,
  });
  if (!id) return { identity: null, reason: 'missing_metadata' };
  return { identity: id, reason: null, verified };
}

// ── Player props (anytime TD / MLB HR) ─────────────────────────────────────────
// Kalshi KXNFLTD-26OCT01PITCLE-CLEDWATSON4-1 : yes  <=>  Poly BUY astatc-nfl-pit-cle-2026-10-01-td-deswat-gte1
// (Kalshi :no is NOT mapped: no proven label form; a Poly SELL leg therefore never matches a
// lock). The player pairing comes ONLY from the verified crosswalk
// (player-prop-crosswalk.json: full name + team + game). The threshold is part of the key
// (1+ never equals 2+), :yes/:no is part of the key, and every cross-check below must hold
// or there is NO identity (fail closed). Poly-only (opts.lines); the Kalshi matcher never
// sees props. D/ST, passing/first TDs and other props are never mapped.
const PROP_SERIES = {
  KXNFLTD: { league: 'nfl', kind: 'td', polyType: 'football_player_touchdowns' },
  KXMLBHR: { league: 'mlb', kind: 'hr', polyType: 'baseball_player_home_runs' },
};
const POLY_PROP_SLUG_RE =
  /^astatc-(nfl|mlb)-([a-z0-9]+)-([a-z0-9]+)-(\d{4})-(\d{2})-(\d{2})-(td|hr)-([a-z0-9]+)-gte([1-9])$/;
const PROP_KIND_LEAGUE = { td: 'nfl', hr: 'mlb' };

function isPolyPropSlug(symbol) {
  return /^astatc-/.test(String(symbol || '').trim().toLowerCase());
}

function propLabelOk(label, name, n) {
  const l = String(label == null ? '' : label).trim();
  if (!l) return false;
  const m = /^(.*?):\s*(\d)\+\s*$/.exec(l);
  if (!m || Number(m[2]) !== n) return false;
  return PROPX.nname(m[1]) === PROPX.nname(name);
}

// idx: optional crosswalk index (tests); label REQUIRED (independent proof of player,
// threshold and side).
function parseKalshiPropTicker(text, sideOverride, label, opts) {
  if (text == null || text === '') return null;
  let raw = String(text).trim();
  let side = sideOverride ? String(sideOverride).toLowerCase() : '';
  const sideAt = raw.lastIndexOf(':');
  if (sideAt > 0) {
    const maybe = raw.slice(sideAt + 1).toLowerCase();
    if (maybe === 'yes' || maybe === 'no') { if (!side) side = maybe; raw = raw.slice(0, sideAt); }
  }
  if (!side) side = 'yes';
  // Only :yes ("Player: N+" bought) is mapped. A :no leg has no proven label form, so it
  // is not mapped (never guessed).
  if (side !== 'yes') return null;
  const dash = raw.indexOf('-');
  if (dash <= 0) return null;
  const series = raw.slice(0, dash).toUpperCase();
  const spec = PROP_SERIES[series];
  if (!spec) return null;
  const tm = /^(.+)-([1-9])$/.exec(raw);
  if (!tm) return null;
  const n = Number(tm[2]);
  const xw = PROPX.byKalshi(tm[1].toUpperCase(), opts && opts.idx);
  if (!xw || xw.league !== spec.league || xw.kind !== spec.kind) return null;
  if (!xw.kalshiThresholds.includes(n) || !xw.polyThresholds.includes(n)) return null;
  if (!propLabelOk(label, xw.name, n)) return null;
  const parsed = parseKalshiDateRest(raw.slice(dash + 1));
  if (!parsed) return null;
  const sm = new RegExp(`^${spec.league}-([a-z0-9]+)-([a-z0-9]+)-(\\d{4}-\\d{2}-\\d{2})$`).exec(xw.poly.stem);
  if (!sm || sm[3] !== parsed.date) return null;
  // The ticker's own game blob must be exactly the crosswalk game's two teams.
  const blob = parsed.teamsBlob.split('-')[0];
  const pair = splitTeams(blob, spec.league, null);
  if (!pair) return null;
  const A = [normTeam(spec.league, pair[0]), normTeam(spec.league, pair[1])].sort().join('+');
  const B = [normTeam(spec.league, sm[1]), normTeam(spec.league, sm[2])].sort().join('+');
  if (A !== B) return null;
  if (spec.league === 'mlb' && parsed.startMs == null) return null; // first pitch is required
  return makeIdentity({
    league: spec.league,
    date: parsed.date,
    teams: [sm[1], sm[2]],
    marketType: spec.kind,
    period: 'full',
    selection: `p.${xw.poly.abbr}`,
    side,
    line: n,
    startMs: parsed.startMs,
  });
}

// Poly astatc leg -> identity. Without `market` this is a slug-only PREFILTER candidate
// (still requires the player to be in the crosswalk); only verified:true identities may be
// quoted. BUY = Yes (long), SELL = No.
function identityFromPolymarketProp(symbol, rfqSide, market, opts) {
  const s = String(symbol || '').trim().toLowerCase();
  const m = POLY_PROP_SLUG_RE.exec(s);
  if (!m) return { identity: null, reason: 'not_priceable' };
  const yesNo = polymarketYesNo(rfqSide);
  if (!yesNo) return { identity: null, reason: 'unmatched_leg' };
  const league = m[1];
  const kind = m[7];
  if (PROP_KIND_LEAGUE[kind] !== league) return { identity: null, reason: 'not_priceable' };
  const date = `${m[4]}-${m[5]}-${m[6]}`;
  const abbr = m[8];
  const n = Number(m[9]);
  const stem = `${league}-${m[2]}-${m[3]}-${date}`;
  const xw = PROPX.byPoly(stem, abbr, opts && opts.idx);
  if (!xw || xw.league !== league || xw.kind !== kind) return { identity: null, reason: 'not_priceable' };
  if (!xw.polyThresholds.includes(n)) return { identity: null, reason: 'not_priceable' };
  let startMs = null;
  let verified = false;
  if (market != null) {
    const mk = unwrapMarket(market);
    if (!mk || typeof mk !== 'object') return { identity: null, reason: 'missing_metadata' };
    const md = mk.metadata && typeof mk.metadata === 'object' ? mk.metadata : null;
    const bad = { identity: null, reason: 'meta_mismatch' };
    if (!md) return { identity: null, reason: 'missing_metadata' };
    const spec = PROP_SERIES[league === 'nfl' ? 'KXNFLTD' : 'KXMLBHR'];
    if (String(mk.sportsMarketType || mk.sports_market_type || '') !== spec.polyType) return bad;
    if (!mk.slug || String(mk.slug).toLowerCase() !== s) return bad;
    if (Number(mk.line) !== n) return bad;
    if (md.playerAbbreviation !== abbr) return bad;
    if (PROPX.nname(md.playerName) !== PROPX.nname(xw.poly.name)) return bad;
    if (String(md.playerId) !== String(xw.poly.playerId) || String(md.teamId) !== String(xw.poly.teamId)) return bad;
    if (md.lineLabel != null && String(md.lineLabel) !== `${n}+`) return bad;
    const metaDate = etDateFromValue(mk.gameStartTime || mk.game_start_time);
    if (!metaDate || metaDate !== date) return bad;
    const sides = mk.marketSides || mk.market_sides;
    if (!Array.isArray(sides) || sides.length !== 2) return bad;
    const longs = sides.filter((x) => x && x.long === true);
    const shorts = sides.filter((x) => x && x.long === false);
    if (longs.length !== 1 || shorts.length !== 1) return bad;
    const d = (x) => String((x && x.description) || '').trim().toLowerCase();
    if (d(longs[0]) !== 'yes' || d(shorts[0]) !== 'no') return bad;
    const t = Date.parse(mk.gameStartTime || mk.game_start_time || '');
    if (!Number.isFinite(t)) return bad;
    if (new Date(t).toISOString() !== new Date(Date.parse(xw.poly.kickoff)).toISOString()) return bad;
    startMs = t;
    verified = true;
  }
  const id = makeIdentity({
    league,
    date,
    teams: [m[2], m[3]],
    marketType: kind,
    period: 'full',
    selection: `p.${abbr}`,
    side: yesNo,
    line: n,
    startMs,
  });
  if (!id) return { identity: null, reason: 'missing_metadata' };
  return { identity: id, reason: null, verified };
}

function identityFromLockFields(leg, sideFallback) {
  if (!leg || typeof leg !== 'object') {
    return typeof leg === 'string' ? parseKalshiTicker(leg, sideFallback) : null;
  }
  const side = (leg.side || sideFallback || 'yes').toString().toLowerCase();
  const league = String(leg.league || leg.sport || '').toLowerCase();
  const date = etDateFromValue(leg.date || leg.event_date || leg.commence_time || leg.starts_at);
  const selection = leg.selection || leg.team || leg.selected;
  const teams = [];
  if (Array.isArray(leg.teams)) teams.push(...leg.teams);
  if (leg.home) teams.push(leg.home);
  if (leg.away) teams.push(leg.away);
  if (league && date && selection && teams.length >= 2) {
    const marketType = String(leg.market_type || leg.marketType || 'moneyline').toLowerCase();
    if (marketType !== 'moneyline' && marketType !== 'ml') return null;
    return makeIdentity({
      league,
      date,
      teams,
      marketType: 'moneyline',
      period: 'full',
      selection,
      side,
    });
  }
  return parseKalshiTicker(
    leg.ticker || leg.market_ticker || leg.event_ticker || leg.gameKey || leg.game_key,
    side
  );
}

function lockLegLabel(parlay, key) {
  const legs = parlay && Array.isArray(parlay.legs) ? parlay.legs : null;
  if (!legs) return null;
  const base = String(key || '').replace(/:(yes|no)$/i, '').toUpperCase();
  const sideAt = String(key || '').lastIndexOf(':');
  const keySide = sideAt > 0 ? String(key).slice(sideAt + 1).toLowerCase() : '';
  const same = legs.filter((l) => l && typeof l === 'object'
    && String(l.ticker || l.market_ticker || '').toUpperCase() === base);
  if (!same.length) return null;
  // The stored leg side must agree with the key side (when both are present).
  const hit = same.find((l) => !l.side || !keySide || String(l.side).toLowerCase() === keySide);
  if (!hit) return { conflict: true };
  return { label: hit.label || null, game: hit.game || null };
}

// opts.lines (Poly only): also read KX{NFL,MLB,NHL}{SPREAD,TOTAL} legs as exact
// line identities. Default off so the Kalshi matcher (rfq.js) is unchanged.
function identitiesFromParlay(parlay, opts) {
  const out = [];
  const lines = !!(opts && opts.lines);
  const keys = parlay && (parlay.leg_keys || parlay.legKeys);
  if (Array.isArray(keys) && keys.length) {
    for (const k of keys) {
      let id = parseKalshiTicker(k);
      if (!id && lines) {
        const info = lockLegLabel(parlay, k);
        if (info && info.conflict) return { ok: false, identities: [], keys: [] };
        // Lock legs MUST carry their human label ("Seattle −6.5" / "Under 42.5"):
        // it is the independent proof that ticker N really means N-0.5 and which
        // side :yes/:no is. No label => the leg is not mapped.
        const o = { requireLabel: true, game: info && info.game };
        id = parseKalshiLineTicker(k, null, info && info.label, o)
          || parseKalshiNcaafMlTicker(k, null, info && info.label, o)
          || parseKalshiPropTicker(k, null, info && info.label, o);
      }
      id = id || identityFromLockFields(k);
      if (!id) return { ok: false, identities: [], keys: [] };
      out.push(id);
    }
    const idKeys = out.map(identityKey).filter(Boolean).sort();
    if (idKeys.length !== out.length) return { ok: false, identities: [], keys: [] };
    return { ok: true, identities: out, keys: idKeys };
  }
  if (parlay && Array.isArray(parlay.legs) && parlay.legs.length) {
    for (const leg of parlay.legs) {
      let id = identityFromLockFields(leg);
      if (!id && lines && leg && typeof leg === 'object') {
        const o = { requireLabel: true, game: leg.game };
        const tk = leg.ticker || leg.market_ticker;
        id = parseKalshiLineTicker(tk, leg.side, leg.label, o)
          || parseKalshiNcaafMlTicker(tk, leg.side, leg.label, o)
          || parseKalshiPropTicker(tk, leg.side, leg.label, o);
      }
      if (!id) return { ok: false, identities: [], keys: [] };
      out.push(id);
    }
    const idKeys = out.map(identityKey).filter(Boolean).sort();
    if (idKeys.length !== out.length) return { ok: false, identities: [], keys: [] };
    return { ok: true, identities: out, keys: idKeys };
  }
  return { ok: false, identities: [], keys: [] };
}

function unwrapMarket(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.metadata && typeof raw.metadata === 'object') return raw;
  if (raw.market && typeof raw.market === 'object') return raw.market;
  return raw;
}

function sportTypeOf(market) {
  const meta = market.metadata || {};
  return String(
    meta.market_sport_type || market.market_sport_type || ''
  ).trim();
}

function retailMoneyline(market) {
  const v2 = String(market.sportsMarketTypeV2 || market.sports_market_type_v2 || '').toUpperCase();
  if (v2 === 'SPORTS_MARKET_TYPE_MONEYLINE') return true;
  const v = String(market.sportsMarketType || market.sports_market_type || market.marketType || '').toLowerCase();
  return v === 'moneyline' || v === 'sports_market_type_moneyline';
}

function retailSpreadOrTotal(market) {
  const v2 = String(market.sportsMarketTypeV2 || '').toUpperCase();
  if (v2 === 'SPORTS_MARKET_TYPE_SPREAD' || v2 === 'SPORTS_MARKET_TYPE_TOTAL') return v2;
  const v = String(market.sportsMarketType || market.marketType || '').toLowerCase();
  if (v === 'spread' || v === 'spreads') return 'spread';
  if (v === 'total' || v === 'totals') return 'total';
  return null;
}

function classifySportType(st) {
  if (!st) return null;
  if (PRICEABLE_SPORT_TYPES.has(st)) return { marketType: 'moneyline', period: 'full' };
  if (/_full_game_spread$/.test(st) || /_full_game_total$/.test(st)) {
    return { marketType: st.endsWith('spread') ? 'spread' : 'total', period: 'full', priceable: false };
  }
  if (/_first_five_/.test(st) || /_winner$/.test(st) && !/_full_game_winner$/.test(st)) {
    return { marketType: 'other', period: 'other', priceable: false };
  }
  return { marketType: 'other', period: 'other', priceable: false };
}

function retailLeagueIsCfb(market) {
  const sides = market.marketSides || market.market_sides;
  return Array.isArray(sides) && sides.some((x) => x && x.team && String(x.team.league || '').toLowerCase() === 'cfb');
}

function teamsFromRetailSides(market) {
  const sides = market.marketSides || market.market_sides;
  if (!Array.isArray(sides)) return { teams: [], long: '', league: '' };
  const teams = [];
  let long = '';
  let league = '';
  for (const s of sides) {
    const team = s && (s.team || {});
    const abbr = team.abbreviation || team.displayAbbreviation || s.identifier;
    if (abbr) teams.push(String(abbr));
    if (s && s.long && abbr) long = String(abbr);
    if (team.league) league = String(team.league).toLowerCase();
  }
  return { teams, long, league };
}

// Poly cfb moneyline (aec-cfb-{long}-{short}-{ET date}) from retail market metadata.
// Everything is cross-checked; any disagreement => no identity (never a slug fallback).
function identityFromNcaafMlMarket(market, rfqSide) {
  const bad = (reason) => ({ identity: null, reason });
  const slug = String(market.slug || '').toLowerCase();
  const sm = /^aec-cfb-([a-z0-9]+)-([a-z0-9]+)-(\d{4})-(\d{2})-(\d{2})$/.exec(slug);
  if (!sm) return bad('not_priceable');
  const st = String(market.sportsMarketType || market.sports_market_type || '');
  if (st !== 'football_team_full_game_winner') return bad('not_priceable');
  const sides = market.marketSides || market.market_sides;
  if (!Array.isArray(sides) || sides.length !== 2) return bad('meta_mismatch');
  const longs = sides.filter((x) => x && x.long === true);
  const shorts = sides.filter((x) => x && x.long === false);
  if (longs.length !== 1 || shorts.length !== 1) return bad('meta_mismatch');
  const tl = longs[0].team || {};
  const ts = shorts[0].team || {};
  const lAbbr = String(tl.abbreviation || '').toLowerCase();
  const sAbbr = String(ts.abbreviation || '').toLowerCase();
  if (lAbbr !== sm[1] || sAbbr !== sm[2] || lAbbr === sAbbr) return bad('meta_mismatch');
  if (String(tl.league || '').toLowerCase() !== 'cfb' || String(ts.league || '').toLowerCase() !== 'cfb') {
    return bad('meta_mismatch');
  }
  const L = NCAAF.teamByPoly(lAbbr);
  const S = NCAAF.teamByPoly(sAbbr);
  if (!L || !S) return bad('not_priceable');
  if (NCAAF.norm(tl.name) !== NCAAF.norm(L.pname) || NCAAF.norm(ts.name) !== NCAAF.norm(S.pname)) {
    return bad('meta_mismatch');
  }
  const date = `${sm[3]}-${sm[4]}-${sm[5]}`;
  const metaDate = etDateFromValue(market.gameStartTime || market.game_start_time);
  if (!metaDate || metaDate !== date) return bad('meta_mismatch');
  const yesNo = polymarketYesNo(rfqSide);
  if (!yesNo) return bad('unmatched_leg');
  const id = makeIdentity({
    league: 'ncaaf',
    date,
    teams: [lAbbr, sAbbr],
    marketType: 'moneyline',
    period: 'full',
    selection: lAbbr, // BUY = long = first slug team
    side: yesNo,
    startMs: Date.parse(market.gameStartTime || market.game_start_time || ''),
  });
  return id ? { identity: id, reason: null } : bad('missing_metadata');
}

// opts.ncaaf (Poly combo path only): verify college ML through the crosswalk. Other
// callers (mm-paper, unhedged price cache) keep their historical behaviour.
function identityFromMarket(marketRaw, rfqSide, opts) {
  const market = unwrapMarket(marketRaw);
  if (!market) return { identity: null, reason: 'missing_metadata' };
  if (opts && opts.ncaaf && (/^aec-cfb-/i.test(String(market.slug || '')) || retailLeagueIsCfb(market))) {
    return identityFromNcaafMlMarket(market, rfqSide);
  }
  const meta = market.metadata && typeof market.metadata === 'object' ? market.metadata : {};
  const side = rfqSide === 'no' ? 'no' : 'yes';

  const st = sportTypeOf(market);
  let classified = st ? classifySportType(st) : null;
  if (!classified && retailMoneyline(market)) {
    classified = { marketType: 'moneyline', period: 'full' };
  }
  if (!classified) {
    const other = retailSpreadOrTotal(market);
    if (other) return { identity: null, reason: 'not_priceable' };
    return { identity: null, reason: 'missing_metadata' };
  }
  if (classified.priceable === false || classified.marketType !== 'moneyline') {
    return { identity: null, reason: 'not_priceable' };
  }

  const longId = meta.long_participant_id || market.long_participant_id;
  const shortId = meta.short_participant_id || market.short_participant_id;
  let league = leagueFromParticipant(longId) || leagueFromParticipant(shortId);
  if (!league && meta.event_id) league = leagueFromParticipant(String(meta.event_id).split('-').slice(0, 2).join('-'));
  if (!league && meta.event_series) league = String(meta.event_series).toLowerCase();
  if (!league && meta.event_subcategory) {
    league = SUBCATEGORY_LEAGUE[String(meta.event_subcategory).toUpperCase()] || '';
  }

  const retail = teamsFromRetailSides(market);
  if (!league) league = retail.league;
  if (!league && market.category === 'sports' && retail.league) league = retail.league;

  const date = etDateFromValue(
    meta.event_start_time || market.event_start_time
    || market.gameStartTime || market.game_start_time
    || market.startDate || market.start_date
  );

  const teams = [];
  const longCode = participantCode(longId) || retail.long;
  const shortCode = participantCode(shortId);
  if (longCode) teams.push(longCode);
  if (shortCode) teams.push(shortCode);
  for (const t of retail.teams) {
    if (t) teams.push(t);
  }

  const selection = longCode || retail.long;
  const id = makeIdentity({
    league,
    date,
    teams,
    marketType: 'moneyline',
    period: 'full',
    selection,
    side,
  });
  if (!id) return { identity: null, reason: 'missing_metadata' };
  return { identity: id, reason: null };
}

const SLUG_LEAGUE = {
  mlb: 'mlb',
  baseball: 'mlb',
  nfl: 'nfl',
  nba: 'nba',
  basketball: 'nba',
  nhl: 'nhl',
  hockey: 'nhl',
  ncaaf: 'ncaaf',
  cfb: 'ncaaf',
};

function polymarketYesNo(sideRaw) {
  const side = String(sideRaw == null ? 'yes' : sideRaw).toLowerCase().replace(/^side_/, '');
  if (side === 'sell' || side === 'no' || side === 'short') return 'no';
  if (side === 'buy' || side === 'yes' || side === 'long') return 'yes';
  return null;
}

// Production combo RFQs use game slugs `aec-{league}-{t1}-{t2}-{YYYY-MM-DD}`
// (no pick). BUY = first slug team; SELL = second. Suffixed `…-{pick}` slugs
// still appear in tests. astatc / asc / other prefixes are not Combo Locks ML.
function identityFromPolymarketSlug(symbol, rfqSide) {
  if (symbol == null || symbol === '') return null;
  const s = String(symbol).trim().toLowerCase();
  const tokens = s.split(/[-_./]/).filter(Boolean);
  if (!tokens.length || tokens[0] !== 'aec') return null;
  const yesNo = polymarketYesNo(rfqSide);
  if (!yesNo) return null;

  let league = null;
  let leagueIdx = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    if (SLUG_LEAGUE[tokens[i]]) {
      league = SLUG_LEAGUE[tokens[i]];
      leagueIdx = i;
      break;
    }
  }
  if (!league || leagueIdx < 0) return null;

  const dateM = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!dateM) return null;
  const date = `${dateM[1]}-${dateM[2]}-${dateM[3]}`;
  const dateIdx = tokens.indexOf(dateM[1]);
  if (dateIdx < 0 || dateIdx <= leagueIdx) return null;

  const teamTokens = tokens.slice(leagueIdx + 1, dateIdx).filter((t) => t && !/^\d+$/.test(t));
  const afterDate = tokens.slice(dateIdx + 3).filter((t) => t && !/^\d+$/.test(t));
  if (teamTokens.length < 2) return null;

  // dh1 / dh2 mark a doubleheader game, not a team pick. Production persist
  // used to store selection=dh1; Combo Locks must not treat that as a team.
  const dh = afterDate.find((t) => /^dh\d+$/i.test(t));
  const pick = afterDate.find((t) => teamTokens.includes(t)) || '';
  let selection;
  if (pick) {
    selection = yesNo === 'yes' ? pick : teamTokens.find((t) => t !== pick);
  } else {
    selection = yesNo === 'yes' ? teamTokens[0] : teamTokens[1];
  }
  if (!selection) return null;
  if (league === 'ncaaf') {
    // College teams are only trusted through the verified crosswalk.
    if (teamTokens.length !== 2 || teamTokens[0] === teamTokens[1]
      || !teamTokens.every((t) => NCAAF.teamByPoly(t))) return null;
    if (tokens[leagueIdx] !== 'cfb' || tokens.length !== dateIdx + 3 || afterDate.length) return null;
  }

  return makeIdentity({
    league,
    date,
    teams: teamTokens,
    marketType: 'moneyline',
    period: dh ? `full-${String(dh).toLowerCase()}` : 'full',
    selection,
    side: 'yes',
  });
}

function identitiesFromPolymarketSlugs(legs) {
  if (!Array.isArray(legs) || !legs.length) {
    return { ok: false, reason: 'no_legs', identities: [], keys: [] };
  }
  const out = [];
  for (const leg of legs) {
    const symbol = (leg && (leg.symbol || leg.slug || leg.market_slug)) || (typeof leg === 'string' ? leg : '');
    const yesNo = polymarketYesNo(leg && typeof leg === 'object' ? (leg.side || 'SIDE_BUY') : 'yes');
    if (!yesNo) return { ok: false, reason: 'unmatched_leg', identities: out, keys: [] };
    // Unverified line identity: candidate prefilter only (never used to quote).
    let id;
    if (isPolyLineSlug(symbol)) id = identityFromPolymarketLine(symbol, yesNo, null).identity;
    else if (isPolyPropSlug(symbol)) id = identityFromPolymarketProp(symbol, yesNo, null).identity;
    else id = identityFromPolymarketSlug(symbol, yesNo);
    if (!id) return { ok: false, reason: 'unmatched_leg', identities: out, keys: [] };
    out.push(id);
  }
  const keys = out.map(identityKey).filter(Boolean).sort();
  if (keys.length !== out.length) return { ok: false, reason: 'unmatched_leg', identities: out, keys };
  return { ok: true, reason: null, identities: out, keys };
}

function identitiesFromPolymarketLegs(legs, markets) {
  if (!Array.isArray(legs) || !legs.length) {
    return { ok: false, reason: 'no_legs', identities: [], keys: [] };
  }
  const out = [];
  for (const leg of legs) {
    const symbol = (leg && (leg.symbol || leg.slug || leg.market_slug)) || '';
    const yesNo = polymarketYesNo(leg && (leg.side || 'SIDE_BUY'));
    if (!yesNo) return { ok: false, reason: 'unmatched_leg', identities: out, keys: [] };

    const market = (leg && (leg.market || (leg.metadata && { metadata: leg.metadata })))
      || (markets && ((markets.get && markets.get(symbol)) || markets[symbol]));
    if (isPolyPropSlug(symbol)) {
      // Player props: ONLY with verified market metadata + a crosswalk player. No fallback.
      if (!market) return { ok: false, reason: 'missing_metadata', identities: out, keys: [] };
      const pr = identityFromPolymarketProp(symbol, yesNo, market);
      if (!pr.identity || !pr.verified) {
        return { ok: false, reason: pr.reason || 'missing_metadata', identities: out, keys: [] };
      }
      out.push(pr.identity);
      continue;
    }
    if (isPolyLineSlug(symbol)) {
      // Spread / total: ONLY with verified market metadata. No slug fallback.
      if (!market) return { ok: false, reason: 'missing_metadata', identities: out, keys: [] };
      const line = identityFromPolymarketLine(symbol, yesNo, market);
      if (!line.identity || !line.verified) {
        return { ok: false, reason: line.reason || 'missing_metadata', identities: out, keys: [] };
      }
      out.push(line.identity);
      continue;
    }
    const got = identityFromMarket(market, yesNo, { ncaaf: true });
    if (!got.identity) {
      if (got.reason === 'not_priceable') {
        return { ok: false, reason: 'not_priceable', identities: out, keys: [] };
      }
      // College ML is only ever trusted through verified market metadata.
      if (/^aec-(cfb|ncaaf)-/i.test(String(symbol))) {
        return { ok: false, reason: got.reason || 'missing_metadata', identities: out, keys: [] };
      }
      const fromSlug = identityFromPolymarketSlug(symbol, yesNo);
      if (fromSlug) {
        out.push(fromSlug);
        continue;
      }
      return { ok: false, reason: got.reason || 'missing_metadata', identities: out, keys: [] };
    }
    out.push(got.identity);
  }
  const keys = out.map(identityKey).filter(Boolean).sort();
  if (keys.length !== out.length) return { ok: false, reason: 'missing_metadata', identities: out, keys };
  return { ok: true, reason: null, identities: out, keys };
}

function sameIdentitySet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return false;
  const A = [...a].sort();
  const B = [...b].sort();
  return A.every((x, i) => x === B[i]);
}

// Same date + same teams can still be two games (MLB doubleheaders / playoff
// series). Kalshi MLB tickers carry first pitch (HHMM, ET); Poly carries
// gameStartTime. For every line leg: if both clocks are known they must agree
// within slack, and an MLB line leg whose lock side has no clock is rejected.
function startTimesAgree(lockIds, polyIds, slackMs = 45 * 60 * 1000) {
  const by = new Map();
  for (const id of polyIds || []) {
    const k = identityKey(id);
    if (k) by.set(k, id);
  }
  for (const id of lockIds || []) {
    if (id.line == null) continue;
    const k = identityKey(id);
    const p = k && by.get(k);
    if (!p) return false;
    if (id.startMs == null || p.startMs == null) {
      if (id.league === 'mlb') return false;
      continue;
    }
    if (Math.abs(p.startMs - id.startMs) > slackMs) return false;
  }
  return true;
}

module.exports = {
  SERIES,
  startTimesAgree,
  LINE_SERIES,
  POLY_LINE_SPORT,
  parseKalshiLineTicker,
  parseKalshiNcaafMlTicker,
  PROP_SERIES,
  parseKalshiPropTicker,
  identityFromPolymarketProp,
  isPolyPropSlug,
  identityFromPolymarketLine,
  isPolyLineSlug,
  PRICEABLE_SPORT_TYPES,
  TEAM_ALIASES,
  normTeam,
  participantCode,
  teamsFromRetailSides,
  unwrapMarket,
  identityKey,
  makeIdentity,
  parseKalshiTicker,
  kalshiTickerPieces,
  splitKnownCodes,
  identityFromLockFields,
  identitiesFromParlay,
  identityFromMarket,
  identityFromPolymarketSlug,
  identitiesFromPolymarketSlugs,
  identitiesFromPolymarketLegs,
  polymarketYesNo,
  sameIdentitySet,
  etDateFromValue,
  etDateFromMs,
};
