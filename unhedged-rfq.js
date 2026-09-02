// Unhedged RFQ shadow logger — persist in-scope combo RFQs that do NOT match
// Combo Locks. Never POSTs, confirms, or fills. POLYMARKET_RFQ_LIVE and Kalshi
// lock quoting stay on their existing paths.
//
// In-scope (v1): pregame 2–4 legs, MLB/NFL/NCAAF full-game moneylines only,
// independent events (distinct games AND distinct teams). No SGP / spreads /
// totals / props. Tennis / LoL / CS2 are a silent skip (no insert).
//
// Fair/quote Americans are set on insert when every leg maps to a cached
// full-game ML price (same venue as the RFQ). Otherwise both stay null.
// Pricing is sync from the in-memory cache — never a per-RFQ HTTP call.
// Do not invent prices. Do not POST / confirm / fill.
//
// Env: UNHEDGED_RFQ_SHADOW default ON (collect tape). Set 0/false/off to idle.
//      UNHEDGED_RFQ_LIVE default OFF — posting is not wired on this path.
'use strict';
const { parseKalshiTicker } = require('./leg-identity');
const { findStartedEvent } = require('./started');
const { americanFromProb } = require('./engine');
const {
  isUnhedgedRfqLive,
  cushionYesFromEnv,
  priceUnhedgedCombo,
} = require('./unhedged-quote');

const SCOPE_LEAGUES = new Set(['mlb', 'nfl', 'ncaaf']);
const SILENT_SKIP = new Set(['tennis', 'lol', 'cs2']);

const KALSHI_SERIES = {
  KXMLBGAME: 'mlb',
  KXNFLGAME: 'nfl',
  KXNCAAFGAME: 'ncaaf',
};

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const DT_TIME_RE = /^(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{4})(.*)$/i;
const DT_DATE_RE = /^(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(?!\d)(.*)$/i;

const PM_DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;
const PM_ML_PREFIX = new Set(['aec']);
const PM_SPREAD_PREFIX = new Set(['asc']);
const PM_TOTAL_PREFIX = new Set(['atc', 'ato']);

const NON_ML_SLUG = /(?:^|[-_./])(spread|spreads|total|totals|over|under|prop|props|1h|1q|f5|firstfive)(?:[-_./]|$)/i;

const LEAGUE_TOKENS = {
  mlb: 'mlb',
  baseball: 'mlb',
  nfl: 'nfl',
  ncaaf: 'ncaaf',
  cfb: 'ncaaf',
};

const SILENT_TOKENS = {
  atp: 'tennis',
  wta: 'tennis',
  tennis: 'tennis',
  lol: 'lol',
  leagueoflegends: 'lol',
  cs2: 'cs2',
  csgo: 'cs2',
};

function isUnhedgedRfqShadow(env = process.env) {
  const v = env && env.UNHEDGED_RFQ_SHADOW;
  if (v == null || String(v).trim() === '') return true;
  const s = String(v).trim().toLowerCase();
  return !(s === '0' || s === 'false' || s === 'no' || s === 'off');
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function splitSideKey(key) {
  const s = String(key || '');
  const i = s.lastIndexOf(':');
  if (i === -1) return { ticker: s, side: 'yes' };
  const side = s.slice(i + 1).toLowerCase();
  if (side === 'yes' || side === 'no') return { ticker: s.slice(0, i), side };
  return { ticker: s, side: 'yes' };
}

function slugTokens(symbol) {
  const s = String(symbol || '').toLowerCase();
  const tokens = [];
  for (const p of s.split(/[-_./]/)) {
    if (p) tokens.push(p);
  }
  return tokens;
}

function etDateFromYmd(year, month, day) {
  if (!year || !month || !day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function splitNcaafBlob(blob, selection) {
  const b = String(blob || '').toLowerCase();
  const sel = String(selection || '').toLowerCase();
  if (!b) return sel ? [sel] : [];
  if (sel && b.startsWith(sel) && b.length > sel.length) {
    return [sel, b.slice(sel.length)].filter(Boolean);
  }
  if (sel && b.endsWith(sel) && b.length > sel.length) {
    return [b.slice(0, -sel.length), sel].filter(Boolean);
  }
  return sel ? [sel] : [];
}

function parseKalshiUnhedgedTicker(text, sideOverride) {
  if (text == null || text === '') return null;
  const { ticker, side } = splitSideKey(text);
  const useSide = sideOverride || side;
  if (useSide !== 'yes' && useSide !== 'no') return null;

  const viaLock = parseKalshiTicker(`${ticker}:${useSide}`);
  if (viaLock && SCOPE_LEAGUES.has(viaLock.league) && viaLock.marketType === 'moneyline') {
    const gameId = `${viaLock.league}|${viaLock.date}|${(viaLock.teams || []).slice().sort().join('+')}`;
    return {
      league: viaLock.league,
      date: viaLock.date,
      teams: viaLock.teams.slice(),
      selection: viaLock.selection,
      side: viaLock.side,
      marketType: 'moneyline',
      ticker: ticker.toUpperCase(),
      gameId,
    };
  }

  let series = '';
  let rest = ticker;
  const dash = ticker.indexOf('-');
  if (dash > 0 && /^KX[A-Z]+$/i.test(ticker.slice(0, dash))) {
    series = ticker.slice(0, dash).toUpperCase();
    rest = ticker.slice(dash + 1);
  }
  if (/SPREAD|TOTAL|PROP|PLAYER|1H|1Q|F5/.test(series)) {
    return { skip: true, reason: 'not_moneyline', ticker: ticker.toUpperCase() };
  }
  const league = KALSHI_SERIES[series];
  if (!league) return null;

  let date = null;
  let teamsBlob = '';
  const timed = DT_TIME_RE.exec(rest);
  const dated = !timed ? DT_DATE_RE.exec(rest) : null;
  if (timed) {
    const year = 2000 + parseInt(timed[1], 10);
    date = etDateFromYmd(year, MONTHS[timed[2].toUpperCase()], parseInt(timed[3], 10));
    teamsBlob = timed[5] || '';
  } else if (dated) {
    const year = 2000 + parseInt(dated[1], 10);
    date = etDateFromYmd(year, MONTHS[dated[2].toUpperCase()], parseInt(dated[3], 10));
    teamsBlob = dated[4] || '';
  } else {
    return null;
  }

  let selection = '';
  const selDash = teamsBlob.lastIndexOf('-');
  if (selDash > 0) {
    selection = teamsBlob.slice(selDash + 1);
    teamsBlob = teamsBlob.slice(0, selDash);
  }
  if (!selection) return null;
  if (/\d/.test(selection)) return { skip: true, reason: 'not_moneyline', ticker: ticker.toUpperCase() };

  const teams = splitNcaafBlob(teamsBlob, selection);
  const uniq = [...new Set(teams.map((t) => t.toLowerCase()))].filter(Boolean).sort();
  if (!uniq.length) uniq.push(selection.toLowerCase());
  const gameId = `${league}|${date || ''}|${uniq.join('+') || teamsBlob.toLowerCase()}`;
  return {
    league,
    date,
    teams: uniq,
    selection: selection.toLowerCase(),
    side: useSide,
    marketType: 'moneyline',
    ticker: ticker.toUpperCase(),
    gameId,
  };
}

function parsePmUnhedgedSlug(symbol, sideOverride) {
  if (symbol == null || symbol === '') return null;
  const raw = String(symbol).trim();
  const s = raw.toLowerCase();
  const tokens = slugTokens(s);
  if (!tokens.length) return null;

  for (const t of tokens) {
    if (SILENT_TOKENS[t]) {
      return { skip: true, reason: SILENT_TOKENS[t], symbol: raw };
    }
  }
  if (NON_ML_SLUG.test(s)) {
    return { skip: true, reason: 'not_moneyline', symbol: raw };
  }

  const prefix = tokens[0];
  if (PM_SPREAD_PREFIX.has(prefix) || PM_TOTAL_PREFIX.has(prefix)) {
    return { skip: true, reason: 'not_moneyline', symbol: raw };
  }

  let league = null;
  for (const t of tokens) {
    if (LEAGUE_TOKENS[t]) {
      league = LEAGUE_TOKENS[t];
      break;
    }
  }
  if (!league) return null;
  if (!SCOPE_LEAGUES.has(league)) return null;
  if (prefix && !PM_ML_PREFIX.has(prefix) && prefix !== league) return null;

  const dateM = s.match(PM_DATE_RE);
  const date = dateM ? `${dateM[1]}-${dateM[2]}-${dateM[3]}` : null;
  const dateIdx = dateM ? tokens.indexOf(dateM[1]) : -1;
  let teamTokens = [];
  if (dateIdx > 0) {
    const leagueIdx = tokens.findIndex((t) => LEAGUE_TOKENS[t] === league);
    const start = leagueIdx >= 0 ? leagueIdx + 1 : 1;
    teamTokens = tokens.slice(start, dateIdx);
  } else {
    teamTokens = tokens.slice(2, -1);
  }
  const selection = tokens[tokens.length - 1] || '';
  const teams = [...new Set(teamTokens.filter((t) => t && !/^\d+$/.test(t)))].sort();
  if (selection && !teams.includes(selection) && !/^\d+$/.test(selection)) {
    // selection is a team; game identity uses the pair, not the pick
  }
  if (teams.length < 2 && selection) teams.push(selection);
  const uniq = [...new Set(teams)].filter(Boolean).sort();
  if (uniq.length < 1) return null;
  const gameId = `${league}|${date || ''}|${uniq.join('+')}`;
  const side = sideOverride === 'no' ? 'no' : 'yes';
  return {
    league,
    date,
    teams: uniq,
    selection: selection || uniq[0],
    side,
    marketType: 'moneyline',
    symbol: raw,
    gameId,
  };
}

function kalshiLegTicker(leg) {
  if (leg == null) return '';
  if (typeof leg === 'string') return splitSideKey(leg).ticker;
  return String(
    leg.market_ticker || leg.ticker || leg.event_ticker || leg.selected_market || ''
  ).trim();
}

function kalshiLegSide(leg) {
  if (leg == null) return 'yes';
  if (typeof leg === 'string') return splitSideKey(leg).side;
  const s = String(leg.side || leg.selected_side || 'yes').toLowerCase();
  return s === 'no' ? 'no' : 'yes';
}

function pmLegSymbol(leg) {
  if (leg == null) return '';
  if (typeof leg === 'string') return splitSideKey(leg).ticker;
  return String(leg.symbol || leg.slug || leg.market_slug || '').trim();
}

function pmLegSide(leg) {
  if (leg == null) return 'yes';
  if (typeof leg === 'string') return splitSideKey(leg).side;
  const raw = String(leg.side || 'yes').trim().toLowerCase().replace(/^side_/, '');
  if (raw === 'sell' || raw === 'no' || raw === 'short') return 'no';
  return 'yes';
}

function collectKalshiLegs(rfq) {
  const out = [];
  if (Array.isArray(rfq && rfq.legKeys) && rfq.legKeys.length) {
    for (const key of rfq.legKeys) {
      const { ticker, side } = splitSideKey(key);
      out.push({ ticker, side, raw: key });
    }
    return out;
  }
  const legs = (rfq && (rfq.legs || rfq.mve_selected_legs)) || [];
  for (const leg of legs) {
    const ticker = kalshiLegTicker(leg);
    if (!ticker) continue;
    out.push({ ticker, side: kalshiLegSide(leg), raw: leg });
  }
  return out;
}

function collectPmLegs(rfq) {
  const out = [];
  const legs = (rfq && (rfq.comboLegs || rfq.legs)) || [];
  if (legs.length) {
    for (const leg of legs) {
      const symbol = pmLegSymbol(leg);
      if (!symbol) continue;
      out.push({ symbol, side: pmLegSide(leg), raw: leg });
    }
    return out;
  }
  if (Array.isArray(rfq && rfq.legKeys) && rfq.legKeys.length) {
    for (const key of rfq.legKeys) {
      const { ticker, side } = splitSideKey(key);
      out.push({ symbol: ticker, side, raw: key });
    }
  }
  return out;
}

function fail(reason) {
  return { persist: false, inScope: false, reason, status: null, row: null };
}

function extractTakerPrice(rfq, extra) {
  const msg = (extra && extra.msg) || {};
  const src = rfq && typeof rfq === 'object' ? rfq : {};
  const pick = (...keys) => {
    for (const k of keys) {
      if (src[k] != null && src[k] !== '') return src[k];
      if (msg[k] != null && msg[k] !== '') return msg[k];
    }
    return null;
  };
  const yes = numOrNull(pick(
    'taker_yes_price', 'yes_price', 'yesPrice', 'yes_bid', 'yesBid',
    'buyPrice', 'buy_price', 'price'
  ));
  const no = numOrNull(pick(
    'taker_no_price', 'no_price', 'noPrice', 'no_bid', 'noBid',
    'sellPrice', 'sell_price'
  ));
  let american = numOrNull(pick(
    'taker_american', 'american', 'americanOdds', 'american_odds', 'priceAmerican'
  ));
  if (american == null && yes != null && yes > 0 && yes < 1) {
    american = americanFromProb(yes);
  }
  return { yes, no, american };
}

function extractSize(rfq) {
  const contracts = numOrNull(
    rfq && (rfq.contracts != null ? rfq.contracts : rfq.qtyDecimal != null ? rfq.qtyDecimal : rfq.qty_decimal)
  );
  const cash = numOrNull(
    rfq && (
      rfq.targetCostDollars != null ? rfq.targetCostDollars
        : rfq.cashOrderQty != null ? rfq.cashOrderQty
          : rfq.cash_order_qty != null ? rfq.cash_order_qty
            : rfq.cash_size
    )
  );
  return {
    contracts: contracts != null && contracts > 0 ? contracts : null,
    cash_size: cash != null && cash > 0 ? cash : null,
  };
}

function independenceCheck(parsed) {
  const games = new Set();
  const teams = new Set();
  for (const p of parsed) {
    if (!p.gameId) return 'same_game';
    if (games.has(p.gameId)) return 'same_game';
    games.add(p.gameId);
    const ts = p.teams && p.teams.length ? p.teams : [p.selection];
    for (const t of ts) {
      const key = String(t || '').toLowerCase();
      if (!key) continue;
      if (teams.has(key)) return 'shared_team';
      teams.add(key);
    }
  }
  return null;
}

function classifyUnhedgedRfq(rfq, opts = {}) {
  const venue = opts.venue;
  if (!rfq || !venue) return fail('bad_rfq');
  if (venue !== 'kalshi' && venue !== 'polymarket') return fail('bad_venue');

  const rawLegs = venue === 'kalshi' ? collectKalshiLegs(rfq) : collectPmLegs(rfq);
  if (rawLegs.length < 2) return fail('not_combo');
  if (rawLegs.length > 4) return fail('too_many_legs');

  const parsed = [];
  for (const leg of rawLegs) {
    const got = venue === 'kalshi'
      ? parseKalshiUnhedgedTicker(leg.ticker, leg.side)
      : parsePmUnhedgedSlug(leg.symbol, leg.side);
    if (!got) return fail('not_in_scope');
    if (got.skip) {
      if (SILENT_SKIP.has(got.reason)) return fail(got.reason);
      return fail(got.reason);
    }
    if (!SCOPE_LEAGUES.has(got.league) || got.marketType !== 'moneyline') {
      return fail('not_in_scope');
    }
    parsed.push(got);
  }

  const indep = independenceCheck(parsed);
  if (indep) return fail(indep);

  const started = findStartedEvent(rfq, null, opts.extra || null, opts.now);
  const size = extractSize(rfq);
  const taker = extractTakerPrice(rfq, opts.extra);
  const legsJson = parsed.map((p) => ({
    ticker: p.ticker || null,
    symbol: p.symbol || null,
    side: p.side,
    league: p.league,
    selection: p.selection,
    teams: p.teams,
    date: p.date || null,
  }));

  const status = started && started.started ? 'started' : 'seen';
  const priced = priceClassified({
    venue,
    legs: legsJson,
    priceCache: opts.priceCache,
    getYesProb: opts.getYesProb,
    env: opts.env,
    cushion: opts.cushion,
  });
  return {
    persist: true,
    inScope: true,
    reason: status === 'started' ? 'game_started' : null,
    status,
    started: started && started.started ? started : null,
    legs: legsJson,
    size,
    taker,
    our_fair_american: priced.our_fair_american,
    our_quote_american: priced.our_quote_american,
    venue,
    rfqId: rfq.rfqId || rfq.id || null,
  };
}

function priceClassified({ venue, legs, priceCache, getYesProb, env, cushion }) {
  const empty = { our_fair_american: null, our_quote_american: null };
  if (priceCache && typeof priceCache.watch === 'function') {
    priceCache.watch(venue, legs);
  }
  const lookup = typeof getYesProb === 'function'
    ? getYesProb
    : (priceCache && typeof priceCache.getYesProb === 'function'
      ? (v, key) => priceCache.getYesProb(v, key)
      : null);
  if (!lookup) return empty;
  const pad = cushion != null ? cushion : cushionYesFromEnv(env);
  const priced = priceUnhedgedCombo({
    venue,
    legs,
    getYesProb: lookup,
    cushion: pad,
  });
  return {
    our_fair_american: priced.our_fair_american,
    our_quote_american: priced.our_quote_american,
  };
}

function buildUnhedgedRow(classified, rfq) {
  if (!classified || !classified.persist || !classified.rfqId) return null;
  const size = classified.size || extractSize(rfq || {});
  const taker = classified.taker || { yes: null, no: null, american: null };
  return {
    rfq_id: String(classified.rfqId),
    venue: classified.venue,
    legs: classified.legs,
    contracts: size.contracts,
    cash_size: size.cash_size,
    taker_yes_price: taker.yes,
    taker_no_price: taker.no,
    taker_american: taker.american,
    our_fair_american: classified.our_fair_american == null ? null : classified.our_fair_american,
    our_quote_american: classified.our_quote_american == null ? null : classified.our_quote_american,
    status: classified.status,
    skip_reason: classified.reason || null,
  };
}

async function persistUnhedgedRfq(supabase, row) {
  if (!supabase || !row) return { ok: false, reason: 'no_client' };
  const { error } = await supabase.from('unhedged_rfqs').upsert(row, { onConflict: 'venue,rfq_id' });
  if (error) {
    console.error('[UNHEDGED] persist failed', error.message);
    return { ok: false, error };
  }
  return { ok: true };
}

function considerUnhedgedRfq(rfq, opts = {}) {
  if (!isUnhedgedRfqShadow(opts.env)) return fail('flag_off');
  const classified = classifyUnhedgedRfq(rfq, opts);
  if (!classified.persist) return classified;
  const row = buildUnhedgedRow(classified, rfq);
  if (!row) return fail('bad_rfq');
  return { ...classified, row };
}

async function maybePersistUnhedged(rfq, opts = {}) {
  const considered = considerUnhedgedRfq(rfq, opts);
  if (!considered.persist || !considered.row) return considered;
  if (typeof opts.persist === 'function') {
    try { await opts.persist(considered.row); } catch (e) {
      console.error('[UNHEDGED] persist failed', e && e.message);
    }
    return considered;
  }
  if (opts.supabase) {
    await persistUnhedgedRfq(opts.supabase, considered.row);
  }
  return considered;
}

function shadowUnhedgedMiss(rfq, opts = {}) {
  maybePersistUnhedged(rfq, opts).then((out) => {
    if (out && out.persist && out.row) {
      console.log(
        `[UNHEDGED] ${out.status} ${opts.venue || out.venue} rfq=${out.row.rfq_id} ` +
        `legs=${(out.row.legs || []).length}` +
        (out.row.our_quote_american != null ? ` quote=${out.row.our_quote_american}` : ' quote=null') +
        (out.reason ? ` reason=${out.reason}` : '')
      );
    }
  }).catch((e) => {
    console.error('[UNHEDGED] persist', e && e.message);
  });
}

module.exports = {
  SCOPE_LEAGUES,
  isUnhedgedRfqShadow,
  isUnhedgedRfqLive,
  classifyUnhedgedRfq,
  buildUnhedgedRow,
  considerUnhedgedRfq,
  persistUnhedgedRfq,
  maybePersistUnhedged,
  shadowUnhedgedMiss,
  parseKalshiUnhedgedTicker,
  parsePmUnhedgedSlug,
  priceClassified,
};
