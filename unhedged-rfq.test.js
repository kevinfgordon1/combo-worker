'use strict';
const assert = require('assert');
const { normalizeRfq } = require('./rfq');
const fs = require('fs');
const path = require('path');
const {
  SCOPE_LEAGUES,
  isUnhedgedRfqShadow,
  isUnhedgedRfqLive,
  isUnhedgedFillStatus,
  classifyUnhedgedRfq,
  considerUnhedgedRfq,
  considerUnhedgedFill,
  maybePersistUnhedged,
  maybePersistUnhedgedFill,
  persistUnhedgedRfq,
  persistUnhedgedFill,
  mergeUnhedgedFillPatch,
  shadowUnhedgedMiss,
  extractFilledAt,
  extractUnhedgedFill,
  createUnhedgedFillTracker,
  resolveUnhedgedFill,
  parseKalshiUnhedgedTicker,
  parsePmUnhedgedSlug,
} = require('./unhedged-rfq');
const { createUnhedgedPriceCache } = require('./unhedged-price-cache');
const { americanFromProb } = require('./engine');
const {
  ourTrueFromOpponentYes,
  ourTrueFromOpponents,
  ourTrueProb,
  invertAmerican,
  bestOpponentAmerican,
  quoteYesFromFair,
  productFair,
  feeIncludedAmerican,
  KALSHI_MLB_TAKER_THETA,
  KALSHI_TAKER_THETA,
  POLY_TAKER_THETA,
} = require('./unhedged-quote');

assert.strictEqual(isUnhedgedRfqShadow({}), true);
assert.strictEqual(isUnhedgedRfqShadow({ UNHEDGED_RFQ_SHADOW: '' }), true);
assert.strictEqual(isUnhedgedRfqShadow({ UNHEDGED_RFQ_SHADOW: 'true' }), true);
assert.strictEqual(isUnhedgedRfqShadow({ UNHEDGED_RFQ_SHADOW: '1' }), true);
assert.strictEqual(isUnhedgedRfqShadow({ UNHEDGED_RFQ_SHADOW: 'false' }), false);
assert.strictEqual(isUnhedgedRfqShadow({ UNHEDGED_RFQ_SHADOW: '0' }), false);
assert.strictEqual(isUnhedgedRfqShadow({ UNHEDGED_RFQ_SHADOW: 'off' }), false);
assert.strictEqual(isUnhedgedRfqLive({}), false);
assert.strictEqual(isUnhedgedRfqLive({ UNHEDGED_RFQ_LIVE: 'true' }), true);
assert.ok(SCOPE_LEAGUES.has('mlb'));
assert.ok(SCOPE_LEAGUES.has('nfl'));
assert.ok(!SCOPE_LEAGUES.has('ncaaf'));
assert.ok(isUnhedgedFillStatus('filled'));
assert.ok(isUnhedgedFillStatus('RFQ_STATUS_EXECUTED'));
assert.ok(isUnhedgedFillStatus('accepted'));
assert.ok(!isUnhedgedFillStatus('open'));
assert.ok(!isUnhedgedFillStatus('closed'));

// Combo Locks Miss tape / quote path stay unwired from this module.
{
  const src = fs.readFileSync(path.join(__dirname, 'unhedged-rfq.js'), 'utf8');
  assert.ok(!/require\(['"]\.\/skip-tape['"]\)/.test(src));
  assert.ok(!src.includes('combo_submissions'));
  assert.ok(!/filledAt = extractFilledAt\(null/.test(src));
  assert.ok(!/new Date\(now\)\.toISOString\(\)/.test(src));
  assert.ok(
    !/filled_at:\s*prev\.filled_at\s*\|\|\s*next\.filled_at/.test(src),
    'later tape tradeTs must win over a stale filled_at'
  );
  const skipSrc = fs.readFileSync(path.join(__dirname, 'skip-tape.js'), 'utf8');
  assert.ok(!skipSrc.includes('unhedged_rfqs'));
  const engineSrc = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
  assert.ok(!engineSrc.includes('unhedged_rfqs'));
}

const mlbCws = parseKalshiUnhedgedTicker('KXMLBGAME-26AUG141840CWSDET-CWS:yes');
assert.ok(mlbCws);
assert.strictEqual(mlbCws.league, 'mlb');
assert.deepStrictEqual(mlbCws.teams, ['cws', 'det']);

const ncaafOsu = parseKalshiUnhedgedTicker('KXNCAAFGAME-26SEP12OSUTEX-OSU:yes');
assert.ok(ncaafOsu);
assert.strictEqual(ncaafOsu.league, 'ncaaf');
assert.ok(ncaafOsu.teams.includes('osu'));
assert.ok(ncaafOsu.teams.includes('tex'));

const pmMlb = parsePmUnhedgedSlug('aec-mlb-cws-det-2026-08-14-cws', 'yes');
assert.ok(pmMlb);
assert.strictEqual(pmMlb.league, 'mlb');
assert.deepStrictEqual(pmMlb.teams, ['cws', 'det']);

assert.strictEqual(parsePmUnhedgedSlug('aec-atp-djokovic-alcaraz-2026-08-14-djokovic').reason, 'tennis');
assert.strictEqual(parsePmUnhedgedSlug('asc-mlb-cws-det-2026-08-14-cws').reason, 'not_moneyline');

function kalshiRfq(id, tickers, extra = {}) {
  return normalizeRfq({
    type: 'rfq_created',
    msg: {
      id,
      contracts_fp: extra.contracts != null ? extra.contracts : '10.00',
      target_cost_dollars: extra.targetCost,
      yes_price: extra.yesPrice,
      no_price: extra.noPrice,
      mve_collection_ticker: 'KXMVE-X',
      mve_selected_legs: tickers.map((t) => {
        const i = t.lastIndexOf(':');
        const ticker = i === -1 ? t : t.slice(0, i);
        const side = i === -1 ? 'yes' : t.slice(i + 1);
        return { side, market_ticker: ticker };
      }),
    },
  });
}

function createMemSupabase(initRows = []) {
  const rows = new Map();
  for (const r of initRows) rows.set(`${r.venue}:${r.rfq_id}`, { ...r });

  function matches(row, state) {
    for (const [k, v] of state.eq) {
      if (row[k] !== v) return false;
    }
    for (const [k, v] of state.neq) {
      if (row[k] === v) return false;
    }
    for (const [k, arr] of state.in) {
      if (!arr.includes(row[k])) return false;
    }
    return true;
  }

  function exec(state) {
    if (state.op === 'insert') {
      const row = state.payload;
      const key = `${row.venue}:${row.rfq_id}`;
      if (rows.has(key)) {
        return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      rows.set(key, { ...row });
      return { data: [row], error: null };
    }
    const found = [];
    for (const r of rows.values()) {
      if (matches(r, state)) found.push(r);
    }
    if (state.op === 'update') {
      const updated = [];
      for (const r of found) {
        Object.assign(r, state.payload);
        updated.push({ rfq_id: r.rfq_id });
      }
      return { data: updated, error: null };
    }
    const limited = state.limit != null ? found.slice(0, state.limit) : found;
    return { data: limited, error: null };
  }

  return {
    _rows: rows,
    from() {
      const state = { op: 'select', payload: null, eq: [], neq: [], in: [], limit: null };
      const q = {
        select() { return q; },
        insert(row) { state.op = 'insert'; state.payload = row; return q; },
        update(body) { state.op = 'update'; state.payload = body; return q; },
        eq(k, v) { state.eq.push([k, v]); return q; },
        neq(k, v) { state.neq.push([k, v]); return q; },
        in(k, arr) { state.in.push([k, arr]); return q; },
        order() { return q; },
        limit(n) { state.limit = n; return q; },
        then(resolve, reject) {
          try { resolve(exec(state)); } catch (e) { (reject || ((err) => { throw err; }))(e); }
        },
      };
      return q;
    },
  };
}

function findLeg(legs, needle) {
  const n = String(needle).toLowerCase();
  return (legs || []).find((l) => {
    const t = String(l.ticker || l.symbol || '').toLowerCase();
    const s = String(l.selection || '').toLowerCase();
    return t.includes(n) || s === n;
  });
}

function assertNullLegOdds(leg) {
  assert.ok(leg);
  assert.strictEqual(leg.fair_american, null);
  assert.strictEqual(leg.fair_yes, null);
  assert.strictEqual(leg.kalshi_opponent_american, null);
  assert.strictEqual(leg.poly_opponent_american, null);
  assert.strictEqual(leg.best_opponent_american, null);
}

function pmRfq(id, symbols, extra = {}) {
  const comboLegs = symbols.map((s) => ({ symbol: s, side: 'SIDE_BUY' }));
  return {
    rfqId: id,
    status: extra.status || 'RFQ_STATUS_OPEN',
    qtyDecimal: extra.qty != null ? extra.qty : '10',
    cashOrderQty: extra.cash,
    buyPrice: extra.buyPrice,
    comboLegs,
    legs: comboLegs,
    isCombo: comboLegs.length > 1,
  };
}

// 3-leg MLB ML pass (Kalshi)
{
  const rfq = kalshiRfq('rfq-mlb-3', [
    'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
    'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
    'KXMLBGAME-26AUG141840NYYBAL-NYY:yes',
  ]);
  const out = classifyUnhedgedRfq(rfq, { venue: 'kalshi', now: Date.parse('2026-08-14T20:00:00Z') });
  assert.strictEqual(out.persist, true, '3-leg MLB ML should persist');
  assert.strictEqual(out.inScope, true);
  assert.strictEqual(out.status, 'seen');
  assert.strictEqual(out.legs.length, 3);
  assert.strictEqual(out.size.contracts, 10);
  assert.strictEqual(out.our_fair_american, null);
  assert.strictEqual(out.our_quote_american, null);
  assert.strictEqual(out.legs[0].fair_american, null);
  assert.strictEqual(out.legs[1].fair_american, null);
  assert.strictEqual(out.legs[2].fair_american, null);
  assertNullLegOdds(out.legs[0]);
}

// 3-leg MLB ML pass (Polymarket slugs — cheap, no metadata)
{
  const rfq = pmRfq('rfq-pm-mlb-3', [
    'aec-mlb-cws-det-2026-08-14-cws',
    'aec-mlb-bos-pit-2026-08-14-pit',
    'aec-mlb-nyy-bal-2026-08-14-nyy',
  ]);
  const out = classifyUnhedgedRfq(rfq, { venue: 'polymarket', now: Date.parse('2026-08-14T20:00:00Z') });
  assert.strictEqual(out.persist, true, '3-leg PM MLB ML should persist');
  assert.strictEqual(out.status, 'seen');
  assert.strictEqual(out.legs.length, 3);
}

// same-game skip (SGP — both sides of one MLB game)
{
  const rfq = kalshiRfq('rfq-sgp', [
    'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
    'KXMLBGAME-26AUG141840CWSDET-DET:yes',
  ]);
  const out = classifyUnhedgedRfq(rfq, { venue: 'kalshi' });
  assert.strictEqual(out.persist, false);
  assert.strictEqual(out.reason, 'same_game');
}

{
  const rfq = pmRfq('rfq-pm-sgp', [
    'aec-mlb-cws-det-2026-08-14-cws',
    'aec-mlb-cws-det-2026-08-14-det',
  ]);
  const out = classifyUnhedgedRfq(rfq, { venue: 'polymarket' });
  assert.strictEqual(out.persist, false);
  assert.strictEqual(out.reason, 'same_game');
}

// 5-leg skip
{
  const rfq = kalshiRfq('rfq-5', [
    'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
    'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
    'KXMLBGAME-26AUG141840NYYBAL-NYY:yes',
    'KXMLBGAME-26AUG141840LADSFO-LAD:yes',
    'KXMLBGAME-26AUG141840HOUTEX-HOU:yes',
  ]);
  const out = classifyUnhedgedRfq(rfq, { venue: 'kalshi' });
  assert.strictEqual(out.persist, false);
  assert.strictEqual(out.reason, 'too_many_legs');
}

{
  const rfq = pmRfq('rfq-pm-5', [
    'aec-mlb-cws-det-2026-08-14-cws',
    'aec-mlb-bos-pit-2026-08-14-pit',
    'aec-mlb-nyy-bal-2026-08-14-nyy',
    'aec-mlb-lad-sf-2026-08-14-lad',
    'aec-mlb-hou-tex-2026-08-14-hou',
  ]);
  const out = classifyUnhedgedRfq(rfq, { venue: 'polymarket' });
  assert.strictEqual(out.persist, false);
  assert.strictEqual(out.reason, 'too_many_legs');
}

// tennis skip (no persist)
{
  const rfq = pmRfq('rfq-tennis', [
    'aec-atp-djokovic-alcaraz-2026-08-14-djokovic',
    'aec-atp-sinner-medvedev-2026-08-14-sinner',
  ]);
  const out = classifyUnhedgedRfq(rfq, { venue: 'polymarket' });
  assert.strictEqual(out.persist, false);
  assert.strictEqual(out.reason, 'tennis');
}

{
  const rfq = pmRfq('rfq-lol', [
    'aec-lol-t1-geng-2026-08-14-t1',
    'aec-lol-hlei-blg-2026-08-14-hlei',
  ]);
  assert.strictEqual(classifyUnhedgedRfq(rfq, { venue: 'polymarket' }).reason, 'lol');
}

{
  const rfq = pmRfq('rfq-cs2', [
    'aec-cs2-navi-faze-2026-08-14-navi',
    'aec-cs2-vitality-mouz-2026-08-14-vitality',
  ]);
  assert.strictEqual(classifyUnhedgedRfq(rfq, { venue: 'polymarket' }).reason, 'cs2');
}

// spread / total skip
{
  const rfq = kalshiRfq('rfq-spread', [
    'KXMLBSPREAD-26AUG141840CWSDET-CWS:yes',
    'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
  ]);
  const out = classifyUnhedgedRfq(rfq, { venue: 'kalshi' });
  assert.strictEqual(out.persist, false);
  assert.ok(out.reason === 'not_moneyline' || out.reason === 'not_in_scope');
}

{
  const rfq = pmRfq('rfq-pm-spread', [
    'asc-mlb-cws-det-2026-08-14-cws',
    'aec-mlb-bos-pit-2026-08-14-pit',
  ]);
  assert.strictEqual(classifyUnhedgedRfq(rfq, { venue: 'polymarket' }).persist, false);
}

// NFL independent 2-leg pass; NCAAF is out of scope (no insert, no fill)
{
  const rfq = kalshiRfq('rfq-nfl-2', [
    'KXNFLGAME-26SEP071330BUFKC-KC:yes',
    'KXNFLGAME-26SEP071330DALPHI-PHI:yes',
  ]);
  const out = classifyUnhedgedRfq(rfq, { venue: 'kalshi', now: Date.parse('2026-09-01T12:00:00Z') });
  assert.strictEqual(out.persist, true);
  assert.strictEqual(out.status, 'seen');
}

{
  const rfq = kalshiRfq('rfq-ncaaf', [
    'KXNCAAFGAME-26SEP12OSUTEX-OSU:yes',
    'KXNCAAFGAME-26SEP12ALAUGA-ALA:yes',
  ]);
  const out = classifyUnhedgedRfq(rfq, { venue: 'kalshi', now: Date.parse('2026-09-01T12:00:00Z') });
  assert.strictEqual(out.persist, false);
  assert.ok(out.reason === 'not_in_scope' || out.reason === 'not_moneyline');
}

{
  const rfq = kalshiRfq('rfq-nfl-ncaaf', [
    'KXNFLGAME-26SEP071330BUFKC-KC:yes',
    'KXNCAAFGAME-26SEP12OSUTEX-OSU:yes',
  ]);
  const out = classifyUnhedgedRfq(rfq, { venue: 'kalshi', now: Date.parse('2026-09-01T12:00:00Z') });
  assert.strictEqual(out.persist, false);
}

{
  const rfq = pmRfq('rfq-pm-ncaaf', [
    'aec-ncaaf-osu-tex-2026-09-12-osu',
    'aec-ncaaf-ala-uga-2026-09-12-ala',
  ]);
  assert.strictEqual(classifyUnhedgedRfq(rfq, { venue: 'polymarket' }).persist, false);
}

// Date-only PM slugs are not midnight starts
{
  const rfq = pmRfq('rfq-pm-date-only', [
    'aec-mlb-cws-det-2026-08-14-cws',
    'aec-mlb-bos-pit-2026-08-14-pit',
  ]);
  const afterMidnight = Date.parse('2026-08-14T07:00:00Z');
  const out = classifyUnhedgedRfq(rfq, { venue: 'polymarket', now: afterMidnight });
  assert.strictEqual(out.persist, true);
  assert.strictEqual(out.status, 'seen');
  assert.ok(!out.started);
}

// Kalshi ticker HHMM after first pitch → silent skip (no insert, no price watch)
{
  const rfq = kalshiRfq('rfq-started', [
    'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
    'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
  ]);
  let watched = 0;
  const out = classifyUnhedgedRfq(rfq, {
    venue: 'kalshi',
    now: Date.parse('2026-08-14T23:44:00Z'),
    priceCache: { watch() { watched += 1; } },
  });
  assert.strictEqual(out.persist, false);
  assert.strictEqual(out.inScope, false);
  assert.strictEqual(out.reason, 'game_started');
  assert.strictEqual(out.row, null);
  assert.strictEqual(watched, 0, 'started RFQ must not watch price cache');
  const fillSkip = considerUnhedgedFill({
    venue: 'kalshi',
    rfq,
    extra: { status: 'filled', yes_price: 0.92 },
    now: Date.parse('2026-08-14T23:44:00Z'),
    known: true,
  });
  assert.strictEqual(fillSkip.persist, false);
  assert.strictEqual(fillSkip.reason, 'game_started');
}

// Taker price present → store it; still do not invent our quote
{
  const rfq = kalshiRfq('rfq-priced', [
    'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
    'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
  ], { yesPrice: '0.18' });
  const out = classifyUnhedgedRfq(rfq, {
    venue: 'kalshi',
    extra: { msg: { yes_price: '0.18' } },
    now: Date.parse('2026-08-14T20:00:00Z'),
  });
  assert.strictEqual(out.persist, true);
  assert.strictEqual(out.taker.yes, 0.18);
  assert.ok(out.taker.american != null);
  assert.strictEqual(out.our_quote_american, null);
}

// Flag off → no persist
{
  const rfq = kalshiRfq('rfq-flag', [
    'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
    'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
  ]);
  const out = considerUnhedgedRfq(rfq, {
    venue: 'kalshi',
    env: { UNHEDGED_RFQ_SHADOW: 'false' },
    now: Date.parse('2026-08-14T20:00:00Z'),
  });
  assert.strictEqual(out.persist, false);
  assert.strictEqual(out.reason, 'flag_off');
}

// persist helper is called only when in-scope
{
  const rows = [];
  const pass = pmRfq('rfq-persist-pass', [
    'aec-mlb-cws-det-2026-08-14-cws',
    'aec-mlb-bos-pit-2026-08-14-pit',
    'aec-mlb-nyy-bal-2026-08-14-nyy',
  ]);
  return maybePersistUnhedged(pass, {
    venue: 'polymarket',
    now: Date.parse('2026-08-14T20:00:00Z'),
    persist: async (row) => { rows.push(row); },
  }).then(async (passOut) => {
    assert.strictEqual(passOut.persist, true);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].venue, 'polymarket');
    assert.strictEqual(rows[0].rfq_id, 'rfq-persist-pass');
    assert.strictEqual(rows[0].status, 'seen');
    assert.strictEqual(rows[0].our_fair_american, null);
    assert.strictEqual(rows[0].legs.length, 3);
    assertNullLegOdds(rows[0].legs[0]);
    assertNullLegOdds(rows[0].legs[1]);
    assertNullLegOdds(rows[0].legs[2]);

    const tennis = pmRfq('rfq-persist-tennis', [
      'aec-atp-djokovic-alcaraz-2026-08-14-djokovic',
      'aec-atp-sinner-medvedev-2026-08-14-sinner',
    ]);
    const tennisOut = await maybePersistUnhedged(tennis, {
      venue: 'polymarket',
      persist: async (row) => { rows.push(row); },
    });
    assert.strictEqual(tennisOut.persist, false);
    assert.strictEqual(rows.length, 1);

    // Started MLB GAME is not inserted (same silent family as tennis).
    const startedIns = await maybePersistUnhedged(kalshiRfq('rfq-started-no-insert', [
      'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
      'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
    ]), {
      venue: 'kalshi',
      now: Date.parse('2026-08-14T23:44:00Z'),
      persist: async (row) => { rows.push(row); },
    });
    assert.strictEqual(startedIns.persist, false);
    assert.strictEqual(startedIns.reason, 'game_started');
    assert.strictEqual(rows.length, 1);
    assert.ok(!rows.some((r) => r.rfq_id === 'rfq-started-no-insert'));

    // Kevin: opponent +118 → our -118 (not -114); opponent -140 → our +140.
    assert.strictEqual(invertAmerican(118), -118);
    assert.notStrictEqual(invertAmerican(118), -114);
    assert.strictEqual(invertAmerican(-140), 140);
    assert.strictEqual(americanFromProb(ourTrueProb(118)), -118);
    assert.notStrictEqual(americanFromProb(ourTrueProb(118)), -114);
    assert.strictEqual(americanFromProb(ourTrueProb(-140)), 140);
    assert.strictEqual(bestOpponentAmerican([{ american: 118 }, { american: -140 }]), 118);
    assert.strictEqual(
      americanFromProb(ourTrueFromOpponents([{ american: 118 }, { american: -140 }])),
      -118
    );

    // Inverse fair: WSH = sign-flip of fee-included ATL, not WSH last. Missing opponent → nulls.
    const wshOur = ourTrueFromOpponentYes(0.42, KALSHI_MLB_TAKER_THETA);
    const cwsOur = ourTrueFromOpponentYes(0.50, KALSHI_MLB_TAKER_THETA);
    const mlbFair = productFair([wshOur, cwsOur]);
    const mlbQuoteYes = quoteYesFromFair(mlbFair, { feeRate: 0.035 });
    const mlbCache = createUnhedgedPriceCache({
      seed: {
        kalshi: {
          'KXMLBGAME-26AUG141840WSHATL-WSH': 0.60,
          'KXMLBGAME-26AUG141840WSHATL-ATL': 0.42,
          'KXMLBGAME-26AUG141840CWSDET-CWS': 0.55,
          'KXMLBGAME-26AUG141840CWSDET-DET': 0.50,
        },
      },
    });
    const mlbPriced = classifyUnhedgedRfq(kalshiRfq('rfq-mlb-priced', [
      'KXMLBGAME-26AUG141840WSHATL-WSH:yes',
      'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
    ]), {
      venue: 'kalshi',
      priceCache: mlbCache,
      now: Date.parse('2026-08-14T20:00:00Z'),
    });
    assert.strictEqual(mlbPriced.our_fair_american, americanFromProb(mlbFair));
    assert.strictEqual(mlbPriced.our_quote_american, americanFromProb(mlbQuoteYes));
    assert.ok(mlbPriced.our_fair_american !== americanFromProb(0.60 * 0.55));
    const wshLeg = findLeg(mlbPriced.legs, 'WSH');
    const cwsLeg = findLeg(mlbPriced.legs, 'CWS');
    assert.ok(wshLeg && cwsLeg);
    const wshKalshiAm = feeIncludedAmerican(0.42, KALSHI_MLB_TAKER_THETA);
    const cwsKalshiAm = feeIncludedAmerican(0.50, KALSHI_MLB_TAKER_THETA);
    assert.strictEqual(wshLeg.kalshi_opponent_american, wshKalshiAm);
    assert.strictEqual(wshLeg.poly_opponent_american, null);
    assert.strictEqual(wshLeg.best_opponent_american, wshKalshiAm);
    assert.strictEqual(wshLeg.fair_american, invertAmerican(wshKalshiAm));
    assert.strictEqual(wshLeg.fair_american, americanFromProb(wshOur));
    assert.strictEqual(wshLeg.fair_yes, wshOur);
    assert.strictEqual(cwsLeg.kalshi_opponent_american, cwsKalshiAm);
    assert.strictEqual(cwsLeg.poly_opponent_american, null);
    assert.strictEqual(cwsLeg.best_opponent_american, cwsKalshiAm);
    assert.strictEqual(cwsLeg.fair_american, invertAmerican(cwsKalshiAm));
    assert.strictEqual(cwsLeg.fair_yes, cwsOur);
    assert.ok(mlbPriced.our_fair_american !== wshLeg.fair_american);

    const nflOurA = ourTrueFromOpponentYes(0.50, KALSHI_TAKER_THETA);
    const nflOurB = ourTrueFromOpponentYes(0.50, KALSHI_TAKER_THETA);
    const nflFair = productFair([nflOurA, nflOurB]);
    const nflQuoteYes = quoteYesFromFair(nflFair, { feeRate: 0 });
    const nflCache = createUnhedgedPriceCache({
      seed: {
        kalshi: {
          'KXNFLGAME-26SEP071330BUFKC-KC': 0.48,
          'KXNFLGAME-26SEP071330BUFKC-BUF': 0.50,
          'KXNFLGAME-26SEP071330DALPHI-PHI': 0.47,
          'KXNFLGAME-26SEP071330DALPHI-DAL': 0.50,
        },
      },
    });
    const nflRfq = kalshiRfq('rfq-nfl-priced', [
      'KXNFLGAME-26SEP071330BUFKC-KC:yes',
      'KXNFLGAME-26SEP071330DALPHI-PHI:yes',
    ]);
    const nflOut = await maybePersistUnhedged(nflRfq, {
      venue: 'kalshi',
      priceCache: nflCache,
      now: Date.parse('2026-09-01T12:00:00Z'),
      persist: async (row) => { rows.push(row); },
    });
    assert.strictEqual(nflOut.persist, true);
    assert.strictEqual(nflOut.our_fair_american, americanFromProb(nflFair));
    assert.strictEqual(nflOut.our_quote_american, americanFromProb(nflQuoteYes));
    const nflKc = findLeg(nflOut.row.legs, 'KC');
    const nflPhi = findLeg(nflOut.row.legs, 'PHI');
    assert.ok(nflKc && nflPhi);
    const nflOppAm = feeIncludedAmerican(0.50, KALSHI_TAKER_THETA);
    assert.notStrictEqual(
      feeIncludedAmerican(0.50, KALSHI_MLB_TAKER_THETA),
      nflOppAm,
      'NFL GAME uses θ=0.07, not MLB 0.035'
    );
    assert.strictEqual(nflKc.kalshi_opponent_american, nflOppAm);
    assert.strictEqual(nflKc.poly_opponent_american, null);
    assert.strictEqual(nflKc.best_opponent_american, nflOppAm);
    assert.strictEqual(nflKc.fair_american, invertAmerican(nflOppAm));
    assert.strictEqual(nflKc.fair_american, americanFromProb(nflOurA));
    assert.strictEqual(nflPhi.fair_american, americanFromProb(nflOurB));

    // Same inverse fair: NFL maker 0 vs MLB 0.035 still changes net / quote.
    const sameFairNfl = quoteYesFromFair(0.25, { feeRate: 0 });
    const sameFairMlb = quoteYesFromFair(0.25, { feeRate: 0.035 });
    assert.strictEqual(sameFairNfl, 0.27);
    assert.strictEqual(sameFairMlb, 0.27);
    const { netCostFromFair } = require('./unhedged-quote');
    assert.strictEqual(netCostFromFair(0.25, 0), 0.25);
    assert.ok(netCostFromFair(0.25, 0.035) > 0.25);

    const polyOurA = ourTrueFromOpponentYes(0.50, POLY_TAKER_THETA);
    const polyOurB = ourTrueFromOpponentYes(0.50, POLY_TAKER_THETA);
    const polyFair = productFair([polyOurA, polyOurB]);
    const polyQuoteYes = quoteYesFromFair(polyFair, { feeRate: 0 });
    const polyCache = createUnhedgedPriceCache({
      seed: {
        polymarket: {
          'aec-mlb-cws-det-2026-08-14-cws': 0.61,
          'aec-mlb-cws-det-2026-08-14-det': 0.50,
          'aec-mlb-bos-pit-2026-08-14-pit': 0.62,
          'aec-mlb-bos-pit-2026-08-14-bos': 0.50,
        },
      },
    });
    const polyPriced = classifyUnhedgedRfq(pmRfq('rfq-pm-priced', [
      'aec-mlb-cws-det-2026-08-14-cws',
      'aec-mlb-bos-pit-2026-08-14-pit',
    ]), {
      venue: 'polymarket',
      priceCache: polyCache,
      now: Date.parse('2026-08-14T20:00:00Z'),
    });
    assert.strictEqual(polyPriced.our_fair_american, americanFromProb(polyFair));
    assert.strictEqual(polyPriced.our_quote_american, americanFromProb(polyQuoteYes));
    const polyCws = findLeg(polyPriced.legs, 'cws');
    const polyPit = findLeg(polyPriced.legs, 'pit');
    assert.ok(polyCws && polyPit);
    const polyOppAm = feeIncludedAmerican(0.50, POLY_TAKER_THETA);
    assert.strictEqual(polyCws.kalshi_opponent_american, null, 'missing Kalshi venue → null');
    assert.strictEqual(polyCws.poly_opponent_american, polyOppAm);
    assert.strictEqual(polyCws.best_opponent_american, polyOppAm);
    assert.strictEqual(polyCws.fair_american, invertAmerican(polyOppAm));
    assert.strictEqual(polyCws.fair_american, americanFromProb(polyOurA));
    assert.strictEqual(polyPit.fair_american, americanFromProb(polyOurB));
    assert.strictEqual(polyPit.kalshi_opponent_american, null);

    const bestCache = createUnhedgedPriceCache({
      seed: {
        kalshi: {
          'KXMLBGAME-26AUG141840WSHATL-WSH': 0.60,
          'KXMLBGAME-26AUG141840WSHATL-ATL': 0.50,
          'KXMLBGAME-26AUG141840CWSDET-CWS': 0.55,
          'KXMLBGAME-26AUG141840CWSDET-DET': 0.50,
        },
        polymarket: {
          'aec-mlb-wsh-atl-2026-08-14-atl': 0.40,
        },
      },
    });
    const bestPriced = classifyUnhedgedRfq(kalshiRfq('rfq-best-opp', [
      'KXMLBGAME-26AUG141840WSHATL-WSH:yes',
      'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
    ]), {
      venue: 'kalshi',
      priceCache: bestCache,
      now: Date.parse('2026-08-14T20:00:00Z'),
    });
    const bestWsh = ourTrueFromOpponentYes(0.40, POLY_TAKER_THETA);
    const bestFair = productFair([bestWsh, cwsOur]);
    assert.strictEqual(bestPriced.our_fair_american, americanFromProb(bestFair));
    assert.ok(bestPriced.our_fair_american !== mlbPriced.our_fair_american);
    const bestWshLeg = findLeg(bestPriced.legs, 'WSH');
    const bestCwsLeg = findLeg(bestPriced.legs, 'CWS');
    assert.ok(bestWshLeg && bestCwsLeg);
    const bestKalshiAm = feeIncludedAmerican(0.50, KALSHI_MLB_TAKER_THETA);
    const bestPolyAm = feeIncludedAmerican(0.40, POLY_TAKER_THETA);
    assert.ok(bestPolyAm > bestKalshiAm);
    assert.strictEqual(bestWshLeg.kalshi_opponent_american, bestKalshiAm);
    assert.strictEqual(bestWshLeg.poly_opponent_american, bestPolyAm);
    assert.strictEqual(bestWshLeg.best_opponent_american, bestPolyAm);
    assert.strictEqual(bestWshLeg.fair_american, invertAmerican(bestPolyAm));
    assert.strictEqual(bestWshLeg.fair_american, americanFromProb(bestWsh));
    assert.strictEqual(bestCwsLeg.kalshi_opponent_american, cwsKalshiAm);
    assert.strictEqual(bestCwsLeg.poly_opponent_american, null);
    assert.strictEqual(bestCwsLeg.best_opponent_american, cwsKalshiAm);
    assert.strictEqual(bestCwsLeg.fair_american, invertAmerican(cwsKalshiAm));

    // 3-leg insert: each legs jsonb object stores invert + venue opponent Americans.
    const detOpp = 0.45;
    const bosOpp = 0.42;
    const balOpp = 0.50;
    const cwsLegOur = ourTrueFromOpponentYes(detOpp, KALSHI_MLB_TAKER_THETA);
    const pitLegOur = ourTrueFromOpponentYes(bosOpp, KALSHI_MLB_TAKER_THETA);
    const nyyLegOur = ourTrueFromOpponentYes(balOpp, KALSHI_MLB_TAKER_THETA);
    const threeFair = productFair([cwsLegOur, pitLegOur, nyyLegOur]);
    const threeQuoteYes = quoteYesFromFair(threeFair, { feeRate: 0.035 });
    const threeCache = createUnhedgedPriceCache({
      seed: {
        kalshi: {
          'KXMLBGAME-26AUG141840CWSDET-CWS': 0.55,
          'KXMLBGAME-26AUG141840CWSDET-DET': detOpp,
          'KXMLBGAME-26AUG141840BOSPIT-PIT': 0.60,
          'KXMLBGAME-26AUG141840BOSPIT-BOS': bosOpp,
          'KXMLBGAME-26AUG141840NYYBAL-NYY': 0.58,
          'KXMLBGAME-26AUG141840NYYBAL-BAL': balOpp,
        },
      },
    });
    const threeRfq = kalshiRfq('rfq-mlb-3-leg-fair', [
      'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
      'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
      'KXMLBGAME-26AUG141840NYYBAL-NYY:yes',
    ]);
    const threeOut = await maybePersistUnhedged(threeRfq, {
      venue: 'kalshi',
      priceCache: threeCache,
      now: Date.parse('2026-08-14T20:00:00Z'),
      persist: async (row) => { rows.push(row); },
    });
    assert.strictEqual(threeOut.persist, true);
    const threeRow = threeOut.row;
    assert.strictEqual(threeRow.legs.length, 3);
    const threeCws = findLeg(threeRow.legs, 'CWS');
    const threePit = findLeg(threeRow.legs, 'PIT');
    const threeNyy = findLeg(threeRow.legs, 'NYY');
    assert.ok(threeCws && threePit && threeNyy);
    const threeCwsOpp = feeIncludedAmerican(detOpp, KALSHI_MLB_TAKER_THETA);
    const threePitOpp = feeIncludedAmerican(bosOpp, KALSHI_MLB_TAKER_THETA);
    const threeNyyOpp = feeIncludedAmerican(balOpp, KALSHI_MLB_TAKER_THETA);
    assert.strictEqual(threeCwsOpp, 118);
    assert.notStrictEqual(feeIncludedAmerican(detOpp, KALSHI_TAKER_THETA), 118);
    assert.strictEqual(threeCws.kalshi_opponent_american, threeCwsOpp);
    assert.strictEqual(threeCws.poly_opponent_american, null);
    assert.strictEqual(threeCws.best_opponent_american, threeCwsOpp);
    assert.strictEqual(threeCws.fair_american, invertAmerican(threeCwsOpp));
    assert.strictEqual(threeCws.fair_american, americanFromProb(cwsLegOur));
    assert.strictEqual(threeCws.fair_yes, cwsLegOur);
    assert.strictEqual(threePit.fair_american, invertAmerican(threePitOpp));
    assert.strictEqual(threePit.fair_american, americanFromProb(pitLegOur));
    assert.strictEqual(threePit.fair_yes, pitLegOur);
    assert.strictEqual(threeNyy.fair_american, invertAmerican(threeNyyOpp));
    assert.strictEqual(threeNyy.fair_american, americanFromProb(nyyLegOur));
    assert.strictEqual(threeNyy.fair_yes, nyyLegOur);
    assert.strictEqual(threeRow.our_fair_american, americanFromProb(threeFair));
    assert.strictEqual(threeRow.our_quote_american, americanFromProb(threeQuoteYes));
    assert.ok(threeRow.our_fair_american !== threeCws.fair_american);
    assert.ok(threeRow.our_fair_american !== americanFromProb(0.55 * 0.60 * 0.58));

    const halfCache = createUnhedgedPriceCache({
      seed: { kalshi: { 'KXMLBGAME-26AUG141840CWSDET-CWS': 0.5 } },
    });
    const missingPx = classifyUnhedgedRfq(kalshiRfq('rfq-missing-px', [
      'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
      'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
    ]), {
      venue: 'kalshi',
      priceCache: halfCache,
      now: Date.parse('2026-08-14T20:00:00Z'),
    });
    assert.strictEqual(missingPx.persist, true);
    assert.strictEqual(missingPx.our_fair_american, null);
    assert.strictEqual(missingPx.our_quote_american, null);
    assertNullLegOdds(missingPx.legs[0]);
    assertNullLegOdds(missingPx.legs[1]);

    const halfOppCache = createUnhedgedPriceCache({
      seed: {
        kalshi: {
          'KXMLBGAME-26AUG141840CWSDET-CWS': 0.55,
          'KXMLBGAME-26AUG141840CWSDET-DET': 0.45,
        },
      },
    });
    const halfOpp = classifyUnhedgedRfq(kalshiRfq('rfq-half-opp', [
      'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
      'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
    ]), {
      venue: 'kalshi',
      priceCache: halfOppCache,
      now: Date.parse('2026-08-14T20:00:00Z'),
    });
    assert.strictEqual(halfOpp.persist, true);
    assert.strictEqual(halfOpp.our_fair_american, null);
    assert.strictEqual(halfOpp.our_quote_american, null);
    const halfCws = findLeg(halfOpp.legs, 'CWS');
    const halfPit = findLeg(halfOpp.legs, 'PIT');
    const halfCwsOpp = feeIncludedAmerican(0.45, KALSHI_MLB_TAKER_THETA);
    assert.strictEqual(halfCws.kalshi_opponent_american, halfCwsOpp);
    assert.strictEqual(halfCws.poly_opponent_american, null);
    assert.strictEqual(halfCws.best_opponent_american, halfCwsOpp);
    assert.strictEqual(halfCws.fair_american, invertAmerican(halfCwsOpp));
    assertNullLegOdds(halfPit);

    const sameSideOnly = createUnhedgedPriceCache({
      seed: {
        kalshi: {
          'KXMLBGAME-26AUG141840WSHATL-WSH': 0.60,
          'KXMLBGAME-26AUG141840CWSDET-CWS': 0.55,
        },
      },
    });
    const noOpp = classifyUnhedgedRfq(kalshiRfq('rfq-no-opp', [
      'KXMLBGAME-26AUG141840WSHATL-WSH:yes',
      'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
    ]), {
      venue: 'kalshi',
      priceCache: sameSideOnly,
      now: Date.parse('2026-08-14T20:00:00Z'),
    });
    assert.strictEqual(noOpp.persist, true);
    assert.strictEqual(noOpp.our_fair_american, null);
    assert.strictEqual(noOpp.our_quote_american, null);
    assertNullLegOdds(noOpp.legs[0]);
    assertNullLegOdds(noOpp.legs[1]);

    // Insert seen, then a later fill updates the same row (taker_* stays).
    const store = new Map();
    const persist = async (row, meta) => {
      const key = `${row.venue}:${row.rfq_id}`;
      if (meta && meta.mode === 'fill') {
        const prev = store.get(key);
        if (!prev) return;
        store.set(key, { ...prev, ...row });
        return;
      }
      store.set(key, { ...row });
    };
    const seenRfq = kalshiRfq('rfq-seen-then-fill', [
      'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
      'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
    ], { yesPrice: '0.18' });
    const seenOut = await maybePersistUnhedged(seenRfq, {
      venue: 'kalshi',
      extra: { msg: { yes_price: '0.18' } },
      now: Date.parse('2026-08-14T20:00:00Z'),
      persist,
    });
    assert.strictEqual(seenOut.persist, true);
    assert.strictEqual(seenOut.status, 'seen');
    const seenRow = store.get('kalshi:rfq-seen-then-fill');
    assert.strictEqual(seenRow.status, 'seen');
    assert.strictEqual(seenRow.taker_yes_price, 0.18);
    assert.ok(!('fill_yes_price' in seenRow) || seenRow.fill_yes_price == null);

    const fillOut = await maybePersistUnhedgedFill({
      venue: 'kalshi',
      rfqId: 'rfq-seen-then-fill',
      extra: { status: 'filled', yes_price: 0.22, no_price: 0.78, filled_at: '2026-08-14T20:05:00Z' },
      persist,
      known: true,
    });
    assert.strictEqual(fillOut.persist, true);
    assert.strictEqual(fillOut.status, 'filled');
    const filledRow = store.get('kalshi:rfq-seen-then-fill');
    assert.strictEqual(filledRow.status, 'filled');
    assert.strictEqual(filledRow.taker_yes_price, 0.18, 'taker_* stays the original RFQ');
    assert.strictEqual(filledRow.fill_yes_price, 0.22);
    assert.strictEqual(filledRow.fill_no_price, 0.78);
    assert.ok(filledRow.fill_american != null);
    assert.strictEqual(Date.parse(filledRow.filled_at), Date.parse('2026-08-14T20:05:00Z'));

    // Out-of-scope (tennis / NCAAF) still not inserted, even on a fill event.
    const tennisFill = await maybePersistUnhedgedFill({
      venue: 'polymarket',
      rfq: pmRfq('rfq-tennis-fill', [
        'aec-atp-djokovic-alcaraz-2026-08-14-djokovic',
        'aec-atp-sinner-medvedev-2026-08-14-sinner',
      ]),
      extra: { status: 'RFQ_STATUS_FILLED', buyPrice: 0.31 },
      persist,
      known: true,
    });
    assert.strictEqual(tennisFill.persist, false);
    assert.ok(!store.has('polymarket:rfq-tennis-fill'));

    const ncaafFill = await maybePersistUnhedgedFill({
      venue: 'kalshi',
      rfq: kalshiRfq('rfq-ncaaf-fill', [
        'KXNCAAFGAME-26SEP12OSUTEX-OSU:yes',
        'KXNCAAFGAME-26SEP12ALAUGA-ALA:yes',
      ]),
      extra: { status: 'executed', yes_price: 0.40 },
      persist,
      known: true,
    });
    assert.strictEqual(ncaafFill.persist, false);
    assert.ok(!store.has('kalshi:rfq-ncaaf-fill'));

    // Fill event on a started MLB RFQ does not insert or patch unhedged_rfqs.
    const startedFillEvent = await maybePersistUnhedgedFill({
      venue: 'kalshi',
      rfq: kalshiRfq('rfq-live-tigers', [
        'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
        'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
      ]),
      extra: { status: 'filled', yes_price: 0.92, filled_at: '2026-08-14T23:50:00Z' },
      now: Date.parse('2026-08-14T23:44:00Z'),
      persist,
      known: true,
    });
    assert.strictEqual(startedFillEvent.persist, false);
    assert.strictEqual(startedFillEvent.reason, 'game_started');
    assert.ok(!store.has('kalshi:rfq-live-tigers'));

    const startedDb = createMemSupabase([{
      venue: 'kalshi',
      rfq_id: 'rfq-started-no-fill',
      status: 'started',
      skip_reason: 'game_started',
      legs: [{ ticker: 'KXMLBGAME-26AUG141840CWSDET-CWS' }],
      our_fair_american: -1192,
      fill_yes_price: null,
      fill_no_price: null,
      fill_american: null,
    }]);
    const startedRowFill = await persistUnhedgedFill(startedDb, {
      venue: 'kalshi',
      rfq_id: 'rfq-started-no-fill',
      status: 'filled',
      fill_yes_price: 0.92,
      fill_no_price: 0.08,
      fill_american: -1192,
      filled_at: '2026-08-14T23:50:00Z',
    });
    assert.strictEqual(startedRowFill.ok, false);
    assert.strictEqual(startedRowFill.reason, 'game_started');
    const stillStarted = startedDb._rows.get('kalshi:rfq-started-no-fill');
    assert.strictEqual(stillStarted.status, 'started');
    assert.strictEqual(stillStarted.fill_yes_price, null);
    assert.strictEqual(stillStarted.fill_american, null);
    assert.strictEqual(stillStarted.our_fair_american, -1192);

    const startedKnownFill = await maybePersistUnhedgedFill({
      venue: 'kalshi',
      rfqId: 'rfq-started-no-fill',
      extra: { status: 'filled', yes_price: 0.92 },
      persist,
      supabase: startedDb,
    });
    assert.strictEqual(startedKnownFill.persist, false);
    assert.strictEqual(startedKnownFill.reason, 'game_started');
    assert.strictEqual(startedDb._rows.get('kalshi:rfq-started-no-fill').status, 'started');

    // Unknown id (never persisted) is not inserted from a fill event.
    const unknownFill = await maybePersistUnhedgedFill({
      venue: 'kalshi',
      rfqId: 'rfq-never-seen',
      extra: { status: 'filled', yes_price: 0.50 },
      persist,
    });
    assert.strictEqual(unknownFill.persist, false);
    assert.strictEqual(unknownFill.reason, 'unknown_row');
    assert.ok(!store.has('kalshi:rfq-never-seen'));

    // Tracker: close event without fill status queues; REST filled updates after pad.
    const trackerRows = [];
    const tracker = createUnhedgedFillTracker({
      persist: async (row, meta) => {
        if (meta && meta.mode === 'fill') trackerRows.push(row);
      },
      fetchRfq: async (id) => {
        assert.strictEqual(id, 'rfq-seen-then-fill');
        return { id, status: 'executed', yes_price: 0.25, no_price: 0.75 };
      },
      fetchTrades: async () => { throw new Error('must not tape-crawl unless needed'); },
    });
    tracker.remember(seenRow);
    const closed = await tracker.onClosed({
      venue: 'kalshi',
      rfqId: 'rfq-seen-then-fill',
      extra: { type: 'rfq_deleted', msg: { id: 'rfq-seen-then-fill' } },
      now: Date.parse('2026-08-14T20:06:00Z'),
    });
    assert.strictEqual(closed.reason, 'queued');
    assert.strictEqual(trackerRows.length, 0);
    await tracker.tick(Date.parse('2026-08-14T20:07:00Z'));
    assert.strictEqual(trackerRows.length, 1);
    assert.strictEqual(trackerRows[0].status, 'filled');
    assert.strictEqual(trackerRows[0].fill_yes_price, 0.25);

    // Unknown close does not GET / tape.
    let fetchedUnknown = 0;
    const idle = createUnhedgedFillTracker({
      persist: async (row) => { trackerRows.push(row); },
      fetchRfq: async () => { fetchedUnknown += 1; return { status: 'filled' }; },
    });
    const skip = await idle.onClosed({
      venue: 'kalshi',
      rfqId: 'rfq-tennis-firehose',
      extra: { type: 'rfq_deleted', msg: { id: 'rfq-tennis-firehose', status: 'filled' } },
    });
    assert.strictEqual(skip.reason, 'unknown_row');
    assert.strictEqual(fetchedUnknown, 0);

    const padClosed = Date.parse('2026-08-14T20:10:00Z');
    const tapeResolve = await resolveUnhedgedFill({
      venue: 'kalshi',
      rfq_id: 'rfq-tape-one',
      contracts: 10,
      market_ticker: 'KXMVE-X',
      closedMs: padClosed,
    }, {
      now: padClosed + 1000,
      fetchRfq: async () => ({ id: 'rfq-tape-one', status: 'closed', updated_ts: padClosed, market_ticker: 'KXMVE-X', contracts: 10 }),
      fetchTrades: async () => [{
        count_fp: '10.00',
        yes_price_dollars: '0.19',
        no_price_dollars: '0.81',
        created_time: padClosed,
        is_block_trade: true,
      }],
    });
    assert.strictEqual(tapeResolve.retry, true, '45s pad must elapse');
    const tapeReady = await resolveUnhedgedFill({
      venue: 'kalshi',
      rfq_id: 'rfq-tape-one',
      contracts: 10,
      market_ticker: 'KXMVE-X',
      closedMs: padClosed,
    }, {
      now: padClosed + 45000,
      fetchRfq: async () => ({ id: 'rfq-tape-one', status: 'closed', updated_ts: padClosed, market_ticker: 'KXMVE-X', contracts: 10 }),
      fetchTrades: async () => [{
        count_fp: '10.00',
        yes_price_dollars: '0.19',
        no_price_dollars: '0.81',
        created_time: padClosed,
        is_block_trade: true,
      }],
    });
    assert.strictEqual(tapeReady.retry, false);
    assert.ok(tapeReady.patch);
    assert.strictEqual(tapeReady.patch.status, 'filled');
    assert.strictEqual(tapeReady.patch.fill_yes_price, 0.19);

    assert.strictEqual(considerUnhedgedFill({
      venue: 'kalshi',
      rfqId: 'rfq-open',
      extra: { status: 'open' },
    }).reason, 'not_filled');

    // Never use Date.now() / opts.now as blotter filled_at when the tape has no ts.
    const restartStamp = Date.parse('2026-09-02T17:25:00Z');
    const noTsFill = extractUnhedgedFill({
      extra: { status: 'filled', yes_price: 0.22 },
      now: restartStamp,
    });
    assert.strictEqual(noTsFill.filled, true);
    assert.strictEqual(noTsFill.filledAt, null);
    assert.strictEqual(extractFilledAt({ status: 'filled' }), null);
    assert.strictEqual(
      extractFilledAt({ status: 'filled', created_ts: '2026-08-14T20:00:00Z' }),
      '2026-08-14T20:00:00.000Z'
    );

    const tapeNoTsNow = padClosed + 45000;
    const tapeNoTs = await resolveUnhedgedFill({
      venue: 'kalshi',
      rfq_id: 'rfq-tape-no-ts',
      contracts: 10,
      market_ticker: 'KXMVE-X',
      closedMs: padClosed,
    }, {
      now: tapeNoTsNow,
      fetchRfq: async () => ({
        id: 'rfq-tape-no-ts',
        status: 'closed',
        created_ts: '2026-08-14T20:00:00Z',
        market_ticker: 'KXMVE-X',
        contracts: 10,
      }),
      fetchTrades: async () => [{
        count_fp: '10.00',
        yes_price_dollars: '0.19',
        no_price_dollars: '0.81',
        is_block_trade: true,
      }],
    });
    assert.strictEqual(tapeNoTs.retry, false);
    assert.ok(tapeNoTs.patch);
    assert.notStrictEqual(tapeNoTs.patch.filled_at, new Date(tapeNoTsNow).toISOString());
    assert.strictEqual(Date.parse(tapeNoTs.patch.filled_at), Date.parse('2026-08-14T20:00:00Z'));

    // Filled row is not overwritten back to seen on WS re-see; odds may refresh.
    const keepFilledDb = createMemSupabase([{
      venue: 'kalshi',
      rfq_id: 'rfq-keep-filled',
      status: 'filled',
      filled_at: '2026-08-14T20:05:00Z',
      fill_yes_price: 0.22,
      fill_no_price: 0.78,
      fill_american: -355,
      legs: [{ selection: 'cws' }],
      our_fair_american: -110,
      our_quote_american: -105,
    }]);
    const resee = await persistUnhedgedRfq(keepFilledDb, {
      rfq_id: 'rfq-keep-filled',
      venue: 'kalshi',
      status: 'seen',
      skip_reason: null,
      legs: [{ selection: 'cws', fair_american: -118 }],
      our_fair_american: -200,
      our_quote_american: -180,
    });
    assert.strictEqual(resee.ok, true);
    assert.strictEqual(resee.alreadyFilled, true);
    const keptFilled = keepFilledDb._rows.get('kalshi:rfq-keep-filled');
    assert.strictEqual(keptFilled.status, 'filled');
    assert.strictEqual(keptFilled.filled_at, '2026-08-14T20:05:00Z');
    assert.strictEqual(keptFilled.fill_yes_price, 0.22);
    assert.strictEqual(keptFilled.our_fair_american, -200);
    assert.strictEqual(keptFilled.legs[0].fair_american, -118);

    // Hydrate remembers already-filled ids so restart does not re-queue them.
    const hydrateDb = createMemSupabase([
      { venue: 'kalshi', rfq_id: 'rfq-open-hydrate', status: 'seen', contracts: 10 },
      {
        venue: 'kalshi',
        rfq_id: 'rfq-already-filled',
        status: 'filled',
        filled_at: '2026-08-14T20:05:00Z',
      },
    ]);
    const hydratePatches = [];
    const hydrateTracker = createUnhedgedFillTracker({
      supabase: hydrateDb,
      persist: async (row) => { hydratePatches.push(row); },
    });
    await hydrateTracker.hydrate();
    assert.ok(hydrateTracker.known.has('kalshi:rfq-open-hydrate'));
    assert.ok(hydrateTracker.known.has('kalshi:rfq-already-filled'));
    assert.ok(hydrateTracker.filled.has('kalshi:rfq-already-filled'));
    assert.ok(!hydrateTracker.filled.has('kalshi:rfq-open-hydrate'));
    const skipFilled = await hydrateTracker.onClosed({
      venue: 'kalshi',
      rfqId: 'rfq-already-filled',
      extra: { status: 'filled', yes_price: 0.33, filled_at: '2026-09-02T17:25:00Z' },
      now: restartStamp,
    });
    assert.strictEqual(skipFilled.persist, false);
    assert.strictEqual(skipFilled.reason, 'already_filled');
    assert.strictEqual(hydratePatches.length, 0);

    // Hydrate/onClosed/tick must not queue or patch started/live RFQs.
    const startedHydrateDb = createMemSupabase([
      {
        venue: 'kalshi',
        rfq_id: 'rfq-started-hydrate',
        status: 'started',
        skip_reason: 'game_started',
        contracts: 10,
        our_fair_american: -1192,
      },
      { venue: 'kalshi', rfq_id: 'rfq-seen-hydrate', status: 'seen', contracts: 10 },
    ]);
    const startedPatches = [];
    let startedFetched = 0;
    const startedTracker = createUnhedgedFillTracker({
      supabase: startedHydrateDb,
      persist: async (row) => { startedPatches.push(row); },
      fetchRfq: async () => {
        startedFetched += 1;
        return { status: 'filled', yes_price: 0.92 };
      },
    });
    await startedTracker.hydrate();
    assert.ok(!startedTracker.known.has('kalshi:rfq-started-hydrate'));
    assert.ok(startedTracker.known.has('kalshi:rfq-seen-hydrate'));
    startedTracker.remember({
      venue: 'kalshi',
      rfq_id: 'rfq-started-hydrate',
      status: 'started',
    });
    assert.ok(!startedTracker.known.has('kalshi:rfq-started-hydrate'));
    const startedClosed = await startedTracker.onClosed({
      venue: 'kalshi',
      rfqId: 'rfq-started-hydrate',
      rfq: kalshiRfq('rfq-started-hydrate', [
        'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
        'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
      ]),
      extra: { status: 'filled', yes_price: 0.92, filled_at: '2026-08-14T23:50:00Z' },
      now: Date.parse('2026-08-14T23:44:00Z'),
    });
    assert.strictEqual(startedClosed.persist, false);
    assert.strictEqual(startedClosed.reason, 'game_started');
    assert.strictEqual(startedPatches.length, 0);
    assert.ok(!startedTracker.pending.has('kalshi:rfq-started-hydrate'));
    await startedTracker.tick(Date.parse('2026-08-14T23:50:00Z'));
    assert.strictEqual(startedFetched, 0);
    assert.strictEqual(startedPatches.length, 0);
    const hydratedStarted = startedHydrateDb._rows.get('kalshi:rfq-started-hydrate');
    assert.strictEqual(hydratedStarted.status, 'started');
    assert.strictEqual(hydratedStarted.our_fair_american, -1192);

    // Known pregame row + later started fill event: do not patch.
    startedTracker.remember({ venue: 'kalshi', rfq_id: 'rfq-seen-then-live', status: 'seen' });
    const liveClose = await startedTracker.onClosed({
      venue: 'kalshi',
      rfqId: 'rfq-seen-then-live',
      rfq: kalshiRfq('rfq-seen-then-live', [
        'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
        'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
      ]),
      extra: { status: 'filled', yes_price: 0.92 },
      now: Date.parse('2026-08-14T23:44:00Z'),
    });
    assert.strictEqual(liveClose.persist, false);
    assert.strictEqual(liveClose.reason, 'game_started');
    assert.strictEqual(startedPatches.length, 0);
    assert.ok(!startedTracker.pending.has('kalshi:rfq-seen-then-live'));

    const startedResolve = await resolveUnhedgedFill({
      venue: 'kalshi',
      rfq_id: 'rfq-started-resolve',
      rfq: kalshiRfq('rfq-started-resolve', [
        'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
        'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
      ]),
    }, {
      now: Date.parse('2026-08-14T23:44:00Z'),
      extra: { status: 'filled', yes_price: 0.92 },
      fetchRfq: async () => ({ status: 'filled', yes_price: 0.92 }),
    });
    assert.strictEqual(startedResolve.retry, false);
    assert.strictEqual(startedResolve.patch, null);
    assert.strictEqual(startedResolve.reason, 'game_started');

    // REST fetch of a started ticker must not fill-patch either.
    const startedRest = await resolveUnhedgedFill({
      venue: 'kalshi',
      rfq_id: 'rfq-started-rest',
    }, {
      now: Date.parse('2026-08-14T23:44:00Z'),
      extra: { status: 'filled', yes_price: 0.92 },
      fetchRfq: async () => kalshiRfq('rfq-started-rest', [
        'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
        'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
      ], { yesPrice: '0.92' }),
    });
    assert.strictEqual(startedRest.patch, null);
    assert.strictEqual(startedRest.reason, 'game_started');

    startedTracker.pending.set('kalshi:rfq-pending-started', {
      venue: 'kalshi',
      rfq_id: 'rfq-pending-started',
      rfq: kalshiRfq('rfq-pending-started', [
        'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
        'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
      ]),
      extra: { status: 'filled', yes_price: 0.92 },
    });
    await startedTracker.tick(Date.parse('2026-08-14T23:50:00Z'));
    assert.ok(!startedTracker.pending.has('kalshi:rfq-pending-started'));
    assert.strictEqual(startedFetched, 0);
    assert.strictEqual(startedPatches.length, 0);

    // Existing restart/created stamp + later tape tradeTs → store the print.
    const restartFilledAt = '2026-09-02T17:57:00.000Z'; // 1:57 PM ET
    const tapeFilledAt = '2026-09-02T18:28:00.000Z'; // 2:28 PM ET
    assert.deepStrictEqual(mergeUnhedgedFillPatch(
      { filled_at: restartFilledAt, fill_yes_price: 0.22, fill_no_price: 0.78, fill_american: -355 },
      { filled_at: tapeFilledAt, fill_yes_price: 0.19, fill_no_price: 0.81, fill_american: -426 }
    ), {
      status: 'filled',
      fill_yes_price: 0.19,
      fill_no_price: 0.81,
      fill_american: -426,
      filled_at: tapeFilledAt,
    });

    // Patch without a timestamp keeps existing filled_at; null prices do not clobber.
    assert.deepStrictEqual(mergeUnhedgedFillPatch(
      { filled_at: restartFilledAt, fill_yes_price: 0.22, fill_no_price: 0.78, fill_american: -355 },
      { filled_at: null, fill_yes_price: null, fill_no_price: null, fill_american: null }
    ), {
      status: 'filled',
      fill_yes_price: 0.22,
      fill_no_price: 0.78,
      fill_american: -355,
      filled_at: restartFilledAt,
    });

    // No Date.now() fallback — empty patch stays null unless created/closed exists.
    const beforeMerge = Date.now();
    const noTsMerge = mergeUnhedgedFillPatch({}, { fill_yes_price: 0.22 });
    assert.strictEqual(noTsMerge.filled_at, null);
    assert.ok(noTsMerge.filled_at == null || Date.parse(noTsMerge.filled_at) < beforeMerge);
    assert.strictEqual(mergeUnhedgedFillPatch(
      { created_at: restartFilledAt },
      { fill_yes_price: 0.22 }
    ).filled_at, restartFilledAt);

    // First fill: venue/tradeTs stamped when the row has none yet.
    assert.strictEqual(mergeUnhedgedFillPatch(
      { created_at: restartFilledAt },
      { filled_at: tapeFilledAt }
    ).filled_at, tapeFilledAt);

    const tapeOverRestartDb = createMemSupabase([{
      venue: 'kalshi',
      rfq_id: 'rfq-second-fill',
      status: 'filled',
      filled_at: restartFilledAt,
      created_at: restartFilledAt,
      fill_yes_price: 0.22,
      fill_no_price: 0.78,
      fill_american: -355,
    }]);
    const tapeOverRestart = await persistUnhedgedFill(tapeOverRestartDb, {
      venue: 'kalshi',
      rfq_id: 'rfq-second-fill',
      status: 'filled',
      fill_yes_price: 0.19,
      fill_no_price: 0.81,
      fill_american: -426,
      filled_at: tapeFilledAt,
    });
    assert.strictEqual(tapeOverRestart.ok, true);
    const afterTape = tapeOverRestartDb._rows.get('kalshi:rfq-second-fill');
    assert.strictEqual(afterTape.filled_at, tapeFilledAt);
    assert.strictEqual(afterTape.fill_yes_price, 0.19);

    const keepExistingDb = createMemSupabase([{
      venue: 'kalshi',
      rfq_id: 'rfq-keep-ts',
      status: 'filled',
      filled_at: restartFilledAt,
      fill_yes_price: 0.22,
      fill_no_price: 0.78,
      fill_american: -355,
    }]);
    const keepExisting = await persistUnhedgedFill(keepExistingDb, {
      venue: 'kalshi',
      rfq_id: 'rfq-keep-ts',
      status: 'filled',
      fill_yes_price: null,
      fill_no_price: null,
      fill_american: null,
      filled_at: null,
    });
    assert.strictEqual(keepExisting.ok, true);
    const keptExisting = keepExistingDb._rows.get('kalshi:rfq-keep-ts');
    assert.strictEqual(keptExisting.filled_at, restartFilledAt);
    assert.strictEqual(keptExisting.fill_yes_price, 0.22);
    assert.strictEqual(keptExisting.fill_no_price, 0.78);
    assert.strictEqual(keptExisting.fill_american, -355);

    // seen/started persist is a 1-line count, not a log per RFQ. Filled stays per-row.
    {
      const logs = [];
      const origLog = console.log;
      console.log = (...args) => { logs.push(args.map(String).join(' ')); };
      try {
        for (let i = 0; i < 3; i += 1) {
          shadowUnhedgedMiss(kalshiRfq(`rfq-quiet-${i}`, [
            'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
            'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
          ]), {
            venue: 'kalshi',
            now: Date.parse('2026-08-14T20:00:00Z'),
            persist: async () => {},
          });
        }
        shadowUnhedgedMiss(kalshiRfq('rfq-quiet-started', [
          'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
          'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
        ]), {
          venue: 'kalshi',
          now: Date.parse('2026-08-14T23:44:00Z'),
          persist: async () => { throw new Error('must not persist started'); },
        });
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        assert.ok(!logs.some((l) => /\[UNHEDGED\] seen kalshi rfq=/.test(l)));
        assert.ok(!logs.some((l) => /\[UNHEDGED\] started kalshi rfq=/.test(l)));
        assert.ok(!logs.some((l) => /game_started/.test(l)));
      } finally {
        console.log = origLog;
      }
    }

    console.log('unhedged-rfq.test.js ok');
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
