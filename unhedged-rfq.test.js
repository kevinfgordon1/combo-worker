'use strict';
const assert = require('assert');
const { normalizeRfq } = require('./rfq');
const {
  isUnhedgedRfqShadow,
  classifyUnhedgedRfq,
  considerUnhedgedRfq,
  maybePersistUnhedged,
  parseKalshiUnhedgedTicker,
  parsePmUnhedgedSlug,
} = require('./unhedged-rfq');
const { createUnhedgedPriceCache, wouldQuoteYesRaw, wouldQuoteYesProb, makerFeeCoeff } = require('./unhedged-price-cache');

assert.strictEqual(isUnhedgedRfqShadow({}), true);
assert.strictEqual(isUnhedgedRfqShadow({ UNHEDGED_RFQ_SHADOW: '' }), true);
assert.strictEqual(isUnhedgedRfqShadow({ UNHEDGED_RFQ_SHADOW: 'true' }), true);
assert.strictEqual(isUnhedgedRfqShadow({ UNHEDGED_RFQ_SHADOW: '1' }), true);
assert.strictEqual(isUnhedgedRfqShadow({ UNHEDGED_RFQ_SHADOW: 'false' }), false);
assert.strictEqual(isUnhedgedRfqShadow({ UNHEDGED_RFQ_SHADOW: '0' }), false);
assert.strictEqual(isUnhedgedRfqShadow({ UNHEDGED_RFQ_SHADOW: 'off' }), false);

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

// Seeded cache: sell YES above fair. MLB 0.035 raises net vs NFL 0; Poly = NFL.
{
  const cache = createUnhedgedPriceCache();
  cache.seed('kalshi', 'KXNFLGAME-26SEP071330BUFKC-KC', 0.40);
  cache.seed('kalshi', 'KXNFLGAME-26SEP071330DALPHI-DAL', 0.40);
  cache.seed('kalshi', 'KXMLBGAME-26AUG141840CWSDET-CWS', 0.40);
  cache.seed('kalshi', 'KXMLBGAME-26AUG141840BOSPIT-PIT', 0.40);
  const nfl = classifyUnhedgedRfq(kalshiRfq('rfq-nfl-fee', [
    'KXNFLGAME-26SEP071330BUFKC-KC:yes',
    'KXNFLGAME-26SEP071330DALPHI-DAL:yes',
  ]), { venue: 'kalshi', now: Date.parse('2026-09-01T12:00:00Z'), priceCache: cache });
  const mlb = classifyUnhedgedRfq(kalshiRfq('rfq-mlb-fee', [
    'KXMLBGAME-26AUG141840CWSDET-CWS:yes',
    'KXMLBGAME-26AUG141840BOSPIT-PIT:yes',
  ]), { venue: 'kalshi', now: Date.parse('2026-08-14T20:00:00Z'), priceCache: cache });
  assert.strictEqual(nfl.persist, true);
  assert.strictEqual(mlb.persist, true);
  assert.ok(nfl.our_fair_american != null);
  assert.strictEqual(nfl.our_fair_american, mlb.our_fair_american);
  assert.ok(nfl.our_quote_american != null && mlb.our_quote_american != null);
  assert.ok(nfl.our_quote_american < nfl.our_fair_american, 'quote worse American than fair');
  assert.strictEqual(makerFeeCoeff('kalshi', nfl.legs), 0);
  assert.strictEqual(makerFeeCoeff('kalshi', mlb.legs), 0.035);
  const fairP = 0.16;
  const nflRaw = wouldQuoteYesRaw(fairP, { venue: 'kalshi', legs: nfl.legs });
  const mlbRaw = wouldQuoteYesRaw(fairP, { venue: 'kalshi', legs: mlb.legs });
  assert.ok(mlbRaw > nflRaw);
  assert.ok(nflRaw > fairP && mlbRaw > fairP);
  assert.strictEqual(wouldQuoteYesProb(0.10, { venue: 'kalshi', legs: nfl.legs }), 0.11);
  assert.strictEqual(wouldQuoteYesProb(0.10, { venue: 'kalshi', legs: mlb.legs }), 0.11);
}

// Poly maker cost 0 (same as NFL). Priced, above fair, no invent on a missing slug.
{
  const cache = createUnhedgedPriceCache();
  cache.seed('polymarket', 'aec-mlb-cws-det-2026-08-14-cws', 0.40);
  cache.seed('polymarket', 'aec-mlb-bos-pit-2026-08-14-pit', 0.40);
  const hit = classifyUnhedgedRfq(pmRfq('rfq-pm-priced', [
    'aec-mlb-cws-det-2026-08-14-cws',
    'aec-mlb-bos-pit-2026-08-14-pit',
  ]), { venue: 'polymarket', now: Date.parse('2026-08-14T20:00:00Z'), priceCache: cache });
  assert.strictEqual(hit.persist, true);
  assert.ok(hit.our_fair_american != null);
  assert.ok(hit.our_quote_american != null);
  assert.ok(hit.our_quote_american < hit.our_fair_american);
  assert.strictEqual(
    wouldQuoteYesRaw(0.10, { venue: 'polymarket', legs: hit.legs }),
    0.105
  );

  const miss = classifyUnhedgedRfq(pmRfq('rfq-pm-miss-price', [
    'aec-mlb-cws-det-2026-08-14-cws',
    'aec-mlb-nyy-bal-2026-08-14-nyy',
  ]), { venue: 'polymarket', now: Date.parse('2026-08-14T20:00:00Z'), priceCache: cache });
  assert.strictEqual(miss.persist, true);
  assert.strictEqual(miss.our_fair_american, null);
  assert.strictEqual(miss.our_quote_american, null);
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
    assert.strictEqual(rows[0].our_quote_american, null);

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

    console.log('unhedged-rfq.test.js ok');
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
