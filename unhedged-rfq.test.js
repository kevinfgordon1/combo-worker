'use strict';
const assert = require('assert');
const { normalizeRfq } = require('./rfq');
const {
  isUnhedgedRfqShadow,
  isUnhedgedRfqLive,
  classifyUnhedgedRfq,
  considerUnhedgedRfq,
  maybePersistUnhedged,
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

// NFL + NCAAF independent 2-leg pass
{
  const rfq = kalshiRfq('rfq-nfl-ncaaf', [
    'KXNFLGAME-26SEP071330BUFKC-KC:yes',
    'KXNCAAFGAME-26SEP12OSUTEX-OSU:yes',
  ]);
  const out = classifyUnhedgedRfq(rfq, { venue: 'kalshi', now: Date.parse('2026-09-01T12:00:00Z') });
  assert.strictEqual(out.persist, true);
  assert.strictEqual(out.status, 'seen');
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

// Kalshi ticker HHMM after first pitch → mark started (still persist)
{
  const rfq = kalshiRfq('rfq-started', [
    'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
    'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
  ]);
  const out = classifyUnhedgedRfq(rfq, { venue: 'kalshi', now: Date.parse('2026-08-14T23:44:00Z') });
  assert.strictEqual(out.persist, true);
  assert.strictEqual(out.status, 'started');
  assert.strictEqual(out.reason, 'game_started');
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
    const wshOur = ourTrueFromOpponentYes(0.42, KALSHI_TAKER_THETA);
    const cwsOur = ourTrueFromOpponentYes(0.50, KALSHI_TAKER_THETA);
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

    console.log('unhedged-rfq.test.js ok');
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
