// Unhedged RFQ shadow logger — persist in-scope combo RFQs that do NOT match
// Combo Locks. Never POSTs, confirms, or fills. POLYMARKET_RFQ_LIVE and Kalshi
// lock quoting stay on their existing paths.
//
// In-scope (v1): pregame 2–4 legs, MLB/NFL full-game moneylines only,
// independent events (distinct games AND distinct teams). No SGP / spreads /
// totals / props / NCAAF. Tennis / LoL / CS2 / NCAAF / live (any started
// leg via findStartedEvent, same helper Combo Locks uses) are a silent skip
// (no insert, no fill patch, no price-cache watch). Kevin will not live-trade
// unhedged — do not record in-game RFQs even for paper/analytics.
//
// Fill-by-others: when an already-persisted pregame row's RFQ later fills
// (Kalshi status filled/executed/accepted, or Polymarket confirm/fill), UPDATE
// that row to status=filled. Keep taker_* as the original RFQ. Do not insert
// out-of-scope firehose just to count fills. No public-tape crawl of open RFQs.
// If findStartedEvent says a leg started, do not fill-update (no status=filled,
// no prices) — hydrate/onClosed/tick must not queue or patch started/live RFQs.
// blotter filled_at is the later of patch vs existing venue/tradeTs
// (true later tape print wins). If only one side has a timestamp, use that.
// If neither: RFQ created/closed, else null. Never Date.now()
// (restart would stamp the whole tape).
// Re-see of an already-filled RFQ must not flip status back to seen/started.
//
// Fair is inverse-bet ourTrue (Promo Builder / EV): convert opponent YES to
// a fee-included American with the series taker coeff (KXMLBGAME 0.035,
// KXNFLGAME/KXNCAAFGAME 0.07, Poly US 0.06). Best opponent American across
// Kalshi vs Polymarket, then sign-flip. Do not use same-side last.
// RFQ venue only selects the combo maker-fee wrap. Missing opponent → both
// Americans stay null.
// Each persisted leg also stores (null if missing, never invent, no backfill):
//   fair_american — invert of best fee-included opponent American (UI Fair)
//   kalshi_opponent_american / poly_opponent_american — venue opponent Americans
//   best_opponent_american — max of the two (more plus / less minus)
// Lookups reuse price-cache opponentQuotes. Do not bump RAM.
// Pricing is sync from the in-memory cache — never a per-RFQ HTTP call.
// Do not invent prices. Do not POST / confirm / fill.
//
// Env: UNHEDGED_RFQ_SHADOW default ON (collect tape). Set 0/false/off to idle.
//      UNHEDGED_RFQ_LIVE default OFF — posting is not wired on this path.
'use strict';
const { parseKalshiTicker } = require('./leg-identity');
const { findStartedEvent, parseTs } = require('./started');
const { americanFromProb } = require('./engine');
const { normalizeTrade, matchTapeTrades } = require('./tape');
const {
  isUnhedgedRfqLive,
  quoteMultFromEnv,
  priceUnhedgedCombo,
  annotateLegOdds,
} = require('./unhedged-quote');

const SCOPE_LEAGUES = new Set(['mlb', 'nfl']);
// Same pad as Combo Locks skip-tape / quote-watcher. Copied — do not import skip-tape.
const FILL_TAPE_PAD_MS = 45000;
const FILL_STATUSES = new Set(['filled', 'executed', 'accepted', 'confirmed']);
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

// Same findStartedEvent Combo Locks uses (ticker HHMM, explicit start keys).
function isUnhedgedStarted(rfq, extra, now) {
  const hit = findStartedEvent(rfq || null, null, extra || null, now);
  return !!(hit && hit.started);
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

  // Before price-cache watch — live RFQs must not bump RAM or persist.
  if (isUnhedgedStarted(rfq, opts.extra, opts.now)) return fail('game_started');

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

  const priced = priceClassified({
    venue,
    legs: legsJson,
    priceCache: opts.priceCache,
    getYesProb: opts.getYesProb,
    env: opts.env,
    margin: opts.margin,
  });
  const legs = Array.isArray(priced.legs) ? priced.legs : legsJson;
  return {
    persist: true,
    inScope: true,
    reason: null,
    status: 'seen',
    started: null,
    legs,
    size,
    taker,
    our_fair_american: priced.our_fair_american,
    our_quote_american: priced.our_quote_american,
    venue,
    rfqId: rfq.rfqId || rfq.id || null,
  };
}

function annotatePersistedLegs(legs, priceCache) {
  if (!Array.isArray(legs)) return [];
  const quotesFn = priceCache && typeof priceCache.opponentQuotes === 'function'
    ? (leg) => priceCache.opponentQuotes(leg)
    : () => [];
  return legs.map((leg) => annotateLegOdds(leg, quotesFn(leg)));
}

function priceClassified({ venue, legs, priceCache, getOurTrue, getYesProb, env, margin }) {
  if (priceCache && typeof priceCache.watch === 'function') {
    priceCache.watch(venue, legs);
  }
  const annotated = annotatePersistedLegs(legs, priceCache);
  const empty = { our_fair_american: null, our_quote_american: null, legs: annotated };
  const ourTrueFn = typeof getOurTrue === 'function'
    ? getOurTrue
    : (priceCache && typeof priceCache.getOurTrue === 'function'
      ? (leg) => priceCache.getOurTrue(leg)
      : null);
  // Inverse-bet path only. Do not fall back to same-side getYesProb from the
  // cache — that would quote the RFQ team's last instead of the opponent invert.
  const yesFn = ourTrueFn
    ? null
    : (typeof getYesProb === 'function' ? getYesProb : null);
  if (!ourTrueFn && !yesFn) return empty;
  const mult = margin != null ? margin : quoteMultFromEnv(env);
  const priced = priceUnhedgedCombo({
    venue,
    legs,
    getOurTrue: ourTrueFn || undefined,
    getYesProb: yesFn || undefined,
    margin: mult,
  });
  return {
    our_fair_american: priced.our_fair_american,
    our_quote_american: priced.our_quote_american,
    legs: annotated,
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

function isUniqueViolation(error) {
  if (!error) return false;
  if (error.code === '23505') return true;
  return /duplicate|unique/i.test(String(error.message || ''));
}

function oddsOnlyUnhedgedPatch(row) {
  return {
    legs: row.legs,
    our_fair_american: row.our_fair_american == null ? null : row.our_fair_american,
    our_quote_american: row.our_quote_american == null ? null : row.our_quote_american,
  };
}

// Seen upsert must not clobber status=filled (WS replay / re-see).
// Non-filled rows still get a full update. Filled rows keep status/fill and
// only refresh per-leg odds when present.
async function persistUnhedgedRfq(supabase, row) {
  if (!supabase || !row) return { ok: false, reason: 'no_client' };

  const { data: updated, error: updateError } = await supabase
    .from('unhedged_rfqs')
    .update(row)
    .eq('venue', row.venue)
    .eq('rfq_id', row.rfq_id)
    .neq('status', 'filled')
    .select('rfq_id');
  if (updateError) {
    console.error('[UNHEDGED] persist failed', updateError.message);
    return { ok: false, error: updateError };
  }
  if (updated && updated.length) return { ok: true };

  const { error: insertError } = await supabase.from('unhedged_rfqs').insert(row);
  if (!insertError) return { ok: true };
  if (!isUniqueViolation(insertError)) {
    console.error('[UNHEDGED] persist failed', insertError.message);
    return { ok: false, error: insertError };
  }

  const { error: oddsError } = await supabase
    .from('unhedged_rfqs')
    .update(oddsOnlyUnhedgedPatch(row))
    .eq('venue', row.venue)
    .eq('rfq_id', row.rfq_id)
    .eq('status', 'filled');
  if (oddsError) {
    console.error('[UNHEDGED] persist failed', oddsError.message);
    return { ok: false, error: oddsError };
  }
  return { ok: true, alreadyFilled: true };
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

// Do not console.log every seen/started RFQ — that was a 4s-interval log
// firehose. One count line per minute. Filled logs stay per-row.
const SEEN_STARTED_LOG_MS = 60_000;
const seenStartedCounts = { seen: 0, started: 0, timer: null };

function flushSeenStartedLog() {
  seenStartedCounts.timer = null;
  const seen = seenStartedCounts.seen;
  const started = seenStartedCounts.started;
  seenStartedCounts.seen = 0;
  seenStartedCounts.started = 0;
  if (seen || started) {
    console.log(`[UNHEDGED] ${seen} seen ${started} started /min`);
  }
}

function noteSeenStarted(status) {
  if (status === 'started') seenStartedCounts.started += 1;
  else if (status === 'seen') seenStartedCounts.seen += 1;
  else return;
  if (!seenStartedCounts.timer) {
    seenStartedCounts.timer = setTimeout(flushSeenStartedLog, SEEN_STARTED_LOG_MS);
    if (seenStartedCounts.timer.unref) seenStartedCounts.timer.unref();
  }
}

function shadowUnhedgedMiss(rfq, opts = {}) {
  maybePersistUnhedged(rfq, opts).then((out) => {
    if (out && out.reason === 'game_started') {
      noteSeenStarted('started');
      return;
    }
    if (out && out.persist && out.row) {
      if (typeof opts.onPersisted === 'function') {
        try { opts.onPersisted(out.row); } catch (_) {}
      }
      if (out.status === 'seen' || out.status === 'started') {
        noteSeenStarted(out.status);
        return;
      }
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

function normalizeFillStatus(v) {
  if (v == null || v === '') return '';
  return String(v).trim().toLowerCase().replace(/-/g, '_');
}

function bareFillStatus(v) {
  return normalizeFillStatus(v)
    .replace(/^rfq_status_/, '')
    .replace(/^quote_status_/, '');
}

function isUnhedgedFillStatus(status) {
  return FILL_STATUSES.has(bareFillStatus(status));
}

function eventTypeFilled(type) {
  const t = normalizeFillStatus(type);
  if (!t) return false;
  if (t === 'rfq_deleted' || t === 'rfq_expired' || t === 'rfq_closed' || t === 'rfqclosed') {
    return false;
  }
  return (
    t === 'quote_accepted' || t === 'quoteaccepted'
    || t === 'quote_executed' || t === 'quoteexecuted'
    || t === 'quote_confirmed' || t === 'quoteconfirmed'
    || t === 'rfq_filled' || t === 'rfqfilled'
  );
}

function pickNumFrom(src, keys) {
  if (!src || typeof src !== 'object') return null;
  for (const k of keys) {
    if (src[k] != null && src[k] !== '') {
      const n = numOrNull(src[k]);
      if (n != null) return n;
    }
  }
  return null;
}

function extractFillPrices(src) {
  const yes = pickNumFrom(src, [
    'fill_yes_price', 'fillYesPrice', 'executed_yes_price', 'executedYesPrice',
    'yes_price_dollars', 'yes_price', 'yesPrice', 'buyPrice', 'buy_price',
  ]);
  const no = pickNumFrom(src, [
    'fill_no_price', 'fillNoPrice', 'executed_no_price', 'executedNoPrice',
    'no_price_dollars', 'no_price', 'noPrice', 'sellPrice', 'sell_price',
  ]);
  let american = pickNumFrom(src, [
    'fill_american', 'fillAmerican', 'executed_american', 'american',
  ]);
  if (american == null && yes != null && yes > 0 && yes < 1) {
    american = americanFromProb(yes);
  }
  return { yes, no, american };
}

const VENUE_FILL_TS_KEYS = [
  'filled_at', 'filledAt', 'executed_ts', 'executedTs',
  'accepted_ts', 'acceptedTs', 'confirmed_ts', 'confirmedTs',
  'tradeTs', 'trade_ts',
];
const RFQ_CLOSED_TS_KEYS = [
  'closed_ts', 'closedTime', 'closedMs',
  'updated_ts', 'updatedTime',
  'deleted_ts', 'cancelled_ts',
];
const RFQ_CREATED_TS_KEYS = [
  'created_ts', 'createdTime', 'created_time', 'createdMs',
];

function firstIsoTs(src, keys) {
  if (!src || typeof src !== 'object' || !Array.isArray(keys)) return null;
  for (const k of keys) {
    if (src[k] == null || src[k] === '') continue;
    const ms = parseTs(src[k]);
    if (ms != null) return new Date(ms).toISOString();
  }
  return null;
}

// Venue fill/execute/tradeTs, else RFQ created/closed, else null.
// Never Date.now() — a restart would stamp every row the same minute.
function extractFilledAt(src) {
  return firstIsoTs(src, VENUE_FILL_TS_KEYS)
    || firstIsoTs(src, RFQ_CLOSED_TS_KEYS)
    || firstIsoTs(src, RFQ_CREATED_TS_KEYS)
    || null;
}

function collectFillSources(opts = {}) {
  const extra = opts.extra || {};
  const event = opts.event || extra;
  return [
    extra.msg, extra.rfq, extra.quote, extra.execution,
    opts.rfq, opts.quote,
    event && event.msg, event && event.rfq, event && event.quote,
    event, extra,
  ].filter((x) => x && typeof x === 'object');
}

function extractUnhedgedFill(opts = {}) {
  const sources = collectFillSources(opts);
  let filled = false;
  let yes = null;
  let no = null;
  let american = null;
  let filledAt = null;
  let status = null;

  const eventType = opts.type || (opts.extra && opts.extra.type) || (opts.event && opts.event.type);
  if (eventTypeFilled(eventType)) filled = true;

  for (const src of sources) {
    if (isUnhedgedFillStatus(src.status)) {
      filled = true;
      status = src.status;
    }
    if (eventTypeFilled(src.type)) filled = true;
    const px = extractFillPrices(src);
    if (yes == null && px.yes != null) yes = px.yes;
    if (no == null && px.no != null) no = px.no;
    if (american == null && px.american != null) american = px.american;
    if (!filledAt) filledAt = extractFilledAt(src);
  }
  if (american == null && yes != null && yes > 0 && yes < 1) american = americanFromProb(yes);
  return { filled, yes, no, american, filledAt, status };
}

function buildUnhedgedFillPatch(fill, { venue, rfqId } = {}) {
  if (!fill || !fill.filled || !rfqId || !venue) return null;
  return {
    rfq_id: String(rfqId),
    venue,
    status: 'filled',
    fill_yes_price: fill.yes == null ? null : fill.yes,
    fill_no_price: fill.no == null ? null : fill.no,
    fill_american: fill.american == null ? null : fill.american,
    filled_at: fill.filledAt || null,
  };
}

function rfqIdFromFillOpts(opts = {}) {
  const extra = opts.extra || {};
  const rfq = opts.rfq || extra.rfq || extra.msg || {};
  return opts.rfqId || opts.rfq_id
    || (rfq && (rfq.rfqId || rfq.rfq_id || rfq.id))
    || extra.rfqId || extra.rfq_id || extra.id
    || (opts.event && (opts.event.rfqId || (opts.event.rfq && (opts.event.rfq.id || opts.event.rfq.rfqId))))
    || null;
}

function knownKey(venue, rfqId) {
  return `${venue}:${rfqId}`;
}

function considerUnhedgedFill(opts = {}) {
  if (!isUnhedgedRfqShadow(opts.env)) return fail('flag_off');
  const venue = opts.venue;
  if (venue !== 'kalshi' && venue !== 'polymarket') return fail('bad_venue');
  const rfqId = rfqIdFromFillOpts(opts);
  if (!rfqId) return fail('bad_rfq');

  const rfq = opts.rfq;
  if (isUnhedgedStarted(rfq, opts.extra, opts.now)) return fail('game_started');
  const hasLegs = !!(rfq && (
    (Array.isArray(rfq.legs) && rfq.legs.length)
    || (Array.isArray(rfq.comboLegs) && rfq.comboLegs.length)
    || (Array.isArray(rfq.legKeys) && rfq.legKeys.length)
    || (Array.isArray(rfq.mve_selected_legs) && rfq.mve_selected_legs.length)
  ));
  if (hasLegs) {
    const classified = classifyUnhedgedRfq(rfq, opts);
    if (!classified.inScope || !classified.persist) {
      return fail(classified.reason || 'not_in_scope');
    }
  }

  const fill = extractUnhedgedFill(opts);
  if (!fill.filled) return fail('not_filled');
  const row = buildUnhedgedFillPatch(fill, { venue, rfqId });
  if (!row) return fail('bad_rfq');
  return { persist: true, inScope: true, reason: null, status: 'filled', row, fill };
}

async function lookupKnownUnhedgedRow(opts, venue, rfqId) {
  if (opts.existingRow) return opts.existingRow;
  if (opts.known === true) return { status: opts.knownStatus || null };
  if (opts.knownIds && typeof opts.knownIds.has === 'function') {
    return opts.knownIds.has(knownKey(venue, rfqId)) ? { status: null } : null;
  }
  if (opts.supabase) {
    const { data, error } = await opts.supabase
      .from('unhedged_rfqs')
      .select('rfq_id,status')
      .eq('venue', venue)
      .eq('rfq_id', rfqId)
      .limit(1);
    if (error) {
      console.error('[UNHEDGED] fill lookup failed', error.message);
      return null;
    }
    return (data && data[0]) || null;
  }
  return null;
}

function coalesceFillPrice(next, prev) {
  return next != null ? next : (prev != null ? prev : null);
}

function laterFilledAt(a, b) {
  if (a && !b) return a;
  if (b && !a) return b;
  if (!a && !b) return null;
  const am = parseTs(a);
  const bm = parseTs(b);
  if (am == null && bm == null) return a;
  if (am == null) return b;
  if (bm == null) return a;
  return bm > am ? b : a;
}

function coalesceFilledAt(next, prev) {
  const nextAt = next && next.filled_at;
  const prevAt = prev && prev.filled_at;
  if (nextAt || prevAt) return laterFilledAt(nextAt, prevAt);
  return firstIsoTs(prev, RFQ_CLOSED_TS_KEYS)
    || firstIsoTs(prev, RFQ_CREATED_TS_KEYS)
    || firstIsoTs(prev, ['created_at', 'closed_at'])
    || firstIsoTs(next, RFQ_CLOSED_TS_KEYS)
    || firstIsoTs(next, RFQ_CREATED_TS_KEYS)
    || firstIsoTs(next, ['created_at', 'closed_at'])
    || null;
}

// Later of next vs prev filled_at wins (true later tape print). If only one
// side has a timestamp, use that. Else created/closed, else null.
// Never Date.now(). Null fill prices do not clobber.
function mergeUnhedgedFillPatch(existing, patch) {
  const prev = existing || {};
  const next = patch || {};
  return {
    status: 'filled',
    fill_yes_price: coalesceFillPrice(next.fill_yes_price, prev.fill_yes_price),
    fill_no_price: coalesceFillPrice(next.fill_no_price, prev.fill_no_price),
    fill_american: coalesceFillPrice(next.fill_american, prev.fill_american),
    filled_at: coalesceFilledAt(next, prev),
  };
}

async function persistUnhedgedFill(supabase, patch) {
  if (!supabase || !patch || !patch.rfq_id || !patch.venue) {
    return { ok: false, reason: 'no_client' };
  }
  const { data: existingRows, error: lookupError } = await supabase
    .from('unhedged_rfqs')
    .select('filled_at,fill_yes_price,fill_no_price,fill_american,created_at,status')
    .eq('venue', patch.venue)
    .eq('rfq_id', patch.rfq_id)
    .limit(1);
  if (lookupError) {
    console.error('[UNHEDGED] fill update failed', lookupError.message);
    return { ok: false, error: lookupError };
  }
  if (existingRows && existingRows[0] && existingRows[0].status === 'started') {
    return { ok: false, reason: 'game_started', updated: false };
  }
  const body = mergeUnhedgedFillPatch(existingRows && existingRows[0], patch);
  const { error, data } = await supabase
    .from('unhedged_rfqs')
    .update(body)
    .eq('venue', patch.venue)
    .eq('rfq_id', patch.rfq_id)
    .neq('status', 'started')
    .select('rfq_id');
  if (error) {
    console.error('[UNHEDGED] fill update failed', error.message);
    return { ok: false, error };
  }
  return { ok: true, updated: !!(data && data.length) };
}

async function maybePersistUnhedgedFill(opts = {}) {
  const considered = considerUnhedgedFill(opts);
  if (!considered.persist || !considered.row) return considered;
  const known = await lookupKnownUnhedgedRow(opts, considered.row.venue, considered.row.rfq_id);
  if (!known) return { persist: false, inScope: false, reason: 'unknown_row', status: null, row: null };
  if (known.status === 'started') return fail('game_started');

  if (typeof opts.persist === 'function') {
    try { await opts.persist(considered.row, { mode: 'fill' }); } catch (e) {
      console.error('[UNHEDGED] fill persist failed', e && e.message);
    }
    return considered;
  }
  if (opts.supabase) {
    await persistUnhedgedFill(opts.supabase, considered.row);
  }
  return considered;
}

function isFillLookupReady({ status, closedMs, now, padMs = FILL_TAPE_PAD_MS }) {
  const s = bareFillStatus(status);
  if (s === 'open') return false;
  if (closedMs != null && now < closedMs + padMs) return false;
  if (status == null && closedMs == null) return false;
  return true;
}

function tickerOfFillRfq(rfq, row) {
  return (row && row.market_ticker)
    || (rfq && (rfq.market_ticker || rfq.ticker || rfq.symbol))
    || null;
}

function rfqClosedMsForFill(rfq) {
  if (!rfq) return null;
  return parseTs(rfq.updated_ts) || parseTs(rfq.updatedTime)
    || parseTs(rfq.cancelled_ts) || parseTs(rfq.closed_ts)
    || parseTs(rfq.deleted_ts) || parseTs(rfq.executed_ts) || null;
}

function rfqCountForFillTape(rfq, fallbackContracts) {
  const fromRfq = numOrNull(rfq && (rfq.contracts_fp != null ? rfq.contracts_fp : rfq.contracts));
  if (fromRfq > 0) return fromRfq;
  const stored = numOrNull(fallbackContracts);
  return stored > 0 ? stored : null;
}

// One RFQ GET (+ optional one trades GET for THAT ticker) after close.
// Never for open RFQs. Never for ids we did not already persist.
async function resolveUnhedgedFill(row, {
  fetchRfq, fetchTrades, now = Date.now(), padMs = FILL_TAPE_PAD_MS, extra,
} = {}) {
  if (!row || !row.rfq_id || !row.venue) {
    return { retry: false, patch: null, reason: 'bad_row' };
  }
  if (isUnhedgedStarted(row.rfq, extra || row.extra, now)) {
    return { retry: false, patch: null, reason: 'game_started' };
  }

  const fromEvent = extractUnhedgedFill({ extra, rfq: extra && extra.rfq, venue: row.venue, now });
  const eventComplete = fromEvent.filled && (fromEvent.yes != null || fromEvent.no != null || !fetchRfq);

  let rfq = null;
  if (typeof fetchRfq === 'function') {
    try { rfq = await fetchRfq(row.rfq_id); } catch (e) {
      if (!eventComplete) return { retry: true, error: e };
    }
  }
  if (isUnhedgedStarted(rfq, extra, now)) {
    return { retry: false, patch: null, reason: 'game_started' };
  }
  if (eventComplete) {
    return {
      retry: false,
      patch: buildUnhedgedFillPatch(fromEvent, { venue: row.venue, rfqId: row.rfq_id }),
      reason: 'event',
    };
  }
  if (rfq) {
    const restFill = extractUnhedgedFill({ rfq, extra: rfq, venue: row.venue, now });
    if (restFill.filled) {
      return {
        retry: false,
        patch: buildUnhedgedFillPatch(restFill, { venue: row.venue, rfqId: row.rfq_id }),
        reason: 'rfq',
      };
    }
  }

  const closedMs = rfqClosedMsForFill(rfq) || row.closedMs || null;
  const status = (rfq && rfq.status) || (row.status !== 'seen' && row.status !== 'started' ? row.status : null);
  if (!isFillLookupReady({ status, closedMs, now, padMs })) {
    return { retry: true };
  }

  if (typeof fetchTrades === 'function') {
    const ticker = tickerOfFillRfq(rfq, row);
    if (ticker) {
      const created = parseTs(rfq && (rfq.created_ts || rfq.createdTime)) || row.createdMs || null;
      const minTs = Math.max(0, Math.floor((created || closedMs || now) / 1000) - 1);
      const maxTs = Math.ceil(((closedMs || now) + padMs) / 1000);
      let trades;
      try { trades = await fetchTrades(ticker, minTs, maxTs); } catch (e) {
        return { retry: true, error: e };
      }
      const windowStart = created || 0;
      const windowEnd = (closedMs || now) + padMs;
      const normalized = (trades || []).map((t) => normalizeTrade(t, parseTs))
        .filter((t) => t.ts == null || (t.ts >= windowStart - 1000 && t.ts <= windowEnd + 1000));
      const result = matchTapeTrades(normalized, {
        rfqCount: rfqCountForFillTape(rfq, row.contracts),
        closedMs,
      });
      if (result && result.match === 'matched') {
        const yes = result.yesPrice != null ? result.yesPrice : null;
        const no = result.noPrice != null ? result.noPrice : null;
        const american = yes != null && yes > 0 && yes < 1 ? americanFromProb(yes) : null;
        const filledAt = result.tradeTs != null
          ? new Date(result.tradeTs).toISOString()
          : (extractFilledAt(rfq) || extractFilledAt(row) || null);
        return {
          retry: false,
          patch: buildUnhedgedFillPatch(
            { filled: true, yes, no, american, filledAt },
            { venue: row.venue, rfqId: row.rfq_id }
          ),
          reason: 'tape',
          result,
        };
      }
    }
  }

  return { retry: false, patch: null, reason: 'not_filled' };
}

function createUnhedgedFillTracker(opts = {}) {
  const known = new Set();
  const filled = new Set();
  const pending = new Map();
  const env = opts.env;
  const maxPerTick = opts.maxPerTick != null ? opts.maxPerTick : 5;

  function remember(row) {
    if (!row || !row.venue || !row.rfq_id) return;
    if (row.status === 'started') return;
    const key = knownKey(row.venue, row.rfq_id);
    known.add(key);
    if (row.status === 'filled') filled.add(key);
  }

  async function hydrateOpen() {
    const { data, error } = await opts.supabase
      .from('unhedged_rfqs')
      .select('venue,rfq_id,status,contracts')
      .eq('status', 'seen')
      .limit(500);
    if (error) {
      console.error('[UNHEDGED] fill hydrate failed', error.message);
      return;
    }
    for (const r of data || []) remember(r);
  }

  // IDs only — same 500 cap as open rows. Do not load fill payloads.
  async function hydrateFilled() {
    const { data, error } = await opts.supabase
      .from('unhedged_rfqs')
      .select('venue,rfq_id,status')
      .eq('status', 'filled')
      .order('filled_at', { ascending: false })
      .limit(500);
    if (error) {
      console.error('[UNHEDGED] fill hydrate failed', error.message);
      return;
    }
    for (const r of data || []) remember(r);
  }

  async function hydrate() {
    if (!opts.supabase) return;
    try {
      await hydrateOpen();
      await hydrateFilled();
    } catch (e) {
      console.error('[UNHEDGED] fill hydrate', e && e.message);
    }
  }

  async function applyPatch(patch) {
    if (!patch) return;
    remember(patch);
    if (typeof opts.persist === 'function') {
      await opts.persist(patch, { mode: 'fill' });
      return;
    }
    if (opts.supabase) await persistUnhedgedFill(opts.supabase, patch);
  }

  async function onClosed({ venue, rfqId, extra, rfq, now } = {}) {
    if (!isUnhedgedRfqShadow(env || opts.env)) return fail('flag_off');
    if (!rfqId || (venue !== 'kalshi' && venue !== 'polymarket')) return fail('bad_rfq');
    if (isUnhedgedStarted(rfq, extra, now)) return fail('game_started');
    const key = knownKey(venue, rfqId);
    if (!known.has(key)) return fail('unknown_row');
    if (filled.has(key)) return fail('already_filled');

    const immediate = considerUnhedgedFill({
      venue, rfqId, extra, rfq, env: env || opts.env, now, known: true,
    });
    if (immediate.reason === 'game_started') return immediate;
    if (immediate.persist && immediate.row) {
      await applyPatch(immediate.row);
      pending.delete(knownKey(venue, rfqId));
      return immediate;
    }

    pending.set(knownKey(venue, rfqId), {
      venue,
      rfq_id: rfqId,
      extra,
      rfq,
      closedMs: now != null ? now : Date.now(),
      contracts: rfq && (rfq.contracts != null ? rfq.contracts : rfq.contracts_fp),
      market_ticker: rfq && (rfq.market_ticker || rfq.ticker || rfq.symbol),
    });
    return { persist: false, reason: 'queued', status: null, row: null };
  }

  async function tick(now = Date.now()) {
    if (!pending.size) return;
    const fetchRfq = opts.fetchRfq;
    const fetchTrades = opts.fetchTrades;
    let looked = 0;
    for (const [key, row] of pending) {
      if (filled.has(key)) {
        pending.delete(key);
        continue;
      }
      if (isUnhedgedStarted(row.rfq, row.extra, now)) {
        pending.delete(key);
        continue;
      }
      if (looked >= maxPerTick) break;
      looked += 1;
      try {
        const out = await resolveUnhedgedFill(row, {
          fetchRfq, fetchTrades, now, extra: row.extra,
        });
        if (out.retry) continue;
        pending.delete(key);
        if (out.patch) {
          await applyPatch(out.patch);
          console.log(
            `[UNHEDGED] filled ${out.patch.venue} rfq=${out.patch.rfq_id}` +
            (out.patch.fill_american != null ? ` fill=${out.patch.fill_american}` : '') +
            (out.reason ? ` via=${out.reason}` : '')
          );
        }
      } catch (e) {
        console.error('[UNHEDGED] fill tick', row.rfq_id, e && e.message);
      }
    }
  }

  return { remember, hydrate, onClosed, tick, known, filled, pending };
}

function shadowUnhedgedFill(opts = {}) {
  const run = opts.tracker
    ? opts.tracker.onClosed(opts)
    : maybePersistUnhedgedFill(opts);
  Promise.resolve(run).then((out) => {
    if (out && out.persist && out.row) {
      console.log(
        `[UNHEDGED] filled ${out.row.venue} rfq=${out.row.rfq_id}` +
        (out.row.fill_american != null ? ` fill=${out.row.fill_american}` : '')
      );
    }
  }).catch((e) => {
    console.error('[UNHEDGED] fill', e && e.message);
  });
}

module.exports = {
  SCOPE_LEAGUES,
  FILL_TAPE_PAD_MS,
  isUnhedgedRfqShadow,
  isUnhedgedRfqLive,
  isUnhedgedFillStatus,
  classifyUnhedgedRfq,
  buildUnhedgedRow,
  buildUnhedgedFillPatch,
  considerUnhedgedRfq,
  considerUnhedgedFill,
  persistUnhedgedRfq,
  persistUnhedgedFill,
  mergeUnhedgedFillPatch,
  maybePersistUnhedged,
  maybePersistUnhedgedFill,
  shadowUnhedgedMiss,
  shadowUnhedgedFill,
  extractFilledAt,
  extractUnhedgedFill,
  resolveUnhedgedFill,
  createUnhedgedFillTracker,
  isUnhedgedStarted,
  parseKalshiUnhedgedTicker,
  parsePmUnhedgedSlug,
  priceClassified,
};
