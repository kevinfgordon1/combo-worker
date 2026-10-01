'use strict';
const assert = require('assert');
const fs = require('fs');
const { classifyNfl, createNoBoostShadow } = require('./noboost-shadow');
const { makeBook } = require('./noboost-test-util');

const K = (...keys) => ({ rfqId: 'r', legKeys: keys, contracts: 20 });
const g = (game, team) => `KXNFLGAME-${game}-${team}:yes`;

// ── classifier
{
  assert.strictEqual(classifyNfl(K(g('26OCT04ARINYG', 'ARI'), g('26OCT04DENSF', 'DEN')), 'kalshi').ok, true);
  const c = classifyNfl(K(g('26OCT04ARINYG', 'ARI'), 'KXNFLGAME-26OCT04DENSF-DEN:no'), 'kalshi');
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.legs[1].team, 'sf', 'NO on DEN = SF wins');
  assert.strictEqual(classifyNfl(K(g('26OCT04ARINYG', 'ARI'), g('26OCT04ARINYG', 'NYG')), 'kalshi').reason, 'correlated_same_game');
  assert.strictEqual(classifyNfl(K(g('26OCT04ARINYG', 'ARI'), 'KXNFLSPREAD-26OCT04DENSF-DEN3:yes'), 'kalshi').ok, false);
  assert.strictEqual(classifyNfl(K(g('26OCT04ARINYG', 'ARI'), 'KXNFLTOTAL-26OCT04DENSF-45:yes'), 'kalshi').ok, false);
  assert.strictEqual(classifyNfl(K(g('26OCT04ARINYG', 'ARI'), 'KXNBAGAME-26OCT04LALBOS-LAL:yes'), 'kalshi').ok, false);
  assert.strictEqual(classifyNfl(K(g('26OCT04ARINYG', 'ARI')), 'kalshi').reason, 'not_combo');
  assert.strictEqual(classifyNfl(K(g('26OCT04ARINYG', 'ARI'), 'KXNFLANYTD-26OCT04DENSF-X:yes'), 'kalshi').ok, false);
  // raw API shape
  assert.strictEqual(classifyNfl({ mve_selected_legs: [
    { market_ticker: 'KXNFLGAME-26OCT04ARINYG-ARI', side: 'yes' }, { market_ticker: 'KXNFLGAME-26OCT04DENSF-SF', side: 'yes' }] }, 'kalshi').ok, true);
  // Poly BUY = first slug team wins, SELL = other
  const p = classifyNfl({ comboLegs: [
    { symbol: 'aec-nfl-jax-cin-2026-10-04', side: 'SIDE_BUY' },
    { symbol: 'aec-nfl-den-sf-2026-10-04', side: 'SIDE_SELL' }] }, 'polymarket');
  assert.strictEqual(p.ok, true);
  assert.deepStrictEqual(p.legs.map((l) => l.team), ['jax', 'sf']);
  assert.strictEqual(classifyNfl({ comboLegs: [
    { symbol: 'aec-nfl-jax-cin-2026-10-04', side: 'SIDE_BUY' },
    { symbol: 'aec-nfl-jax-cin-2026-10-04', side: 'SIDE_SELL' }] }, 'polymarket').reason, 'correlated_same_game');
}

// ── shadow
const G1 = { game: '26OCT04ARINYG', a: 'ARI', b: 'NYG', askA: 0.52, bidA: 0.50, askB: 0.50, bidB: 0.48 };
const G2 = { game: '26OCT04DENSF', a: 'DEN', b: 'SF', askA: 0.40, bidA: 0.38, askB: 0.62, bidB: 0.60 };
{
  const book = makeBook([G1, G2]);
  const lines = [];
  const log = (l) => lines.push(l);
  // flag OFF by default: nothing priced, nothing logged
  const off = createNoBoostShadow({ book, env: {}, log });
  const r0 = off.onRfq(K(g(G1.game, 'ARI'), g(G2.game, 'DEN')));
  assert.deepStrictEqual([r0.action, r0.reason], ['skip', 'flag_off']);
  assert.strictEqual(lines.length, 0);

  // refuses to run if NOBOOST_LIVE is set
  assert.throws(() => createNoBoostShadow({ book, env: { NOBOOST_LIVE: '1' } }), /paper-only/);

  const on = createNoBoostShadow({ book, env: { NOBOOST_SHADOW: '1', NOBOOST_GUARDRAIL: 'off' }, log });
  const r1 = on.onRfq(K(g(G1.game, 'ARI'), g(G2.game, 'DEN')));
  assert.strictEqual(r1.action, 'would_quote');
  assert.ok(/WOULD_QUOTE/.test(lines[0]));
  assert.ok(!/%/.test(lines[0]), 'American odds only, no percentages');
  assert.ok(/fair=[+-]\d+ lock=[+-]\d+ quote=[+-]\d+/.test(lines[0]), lines[0]);

  // out of scope + correlated are skipped, not quoted
  assert.strictEqual(on.onRfq(K(g(G1.game, 'ARI'), g(G1.game, 'NYG'))).reason, 'correlated_same_game');
  assert.strictEqual(on.onRfq(K(g(G1.game, 'ARI'), 'KXNFLSPREAD-26OCT04DENSF-DEN3:yes')).action, 'skip');
  // unpriceable (game not in book)
  assert.ok(/price:unpriceable_leg|no_kickoff/.test(on.onRfq(K(g(G1.game, 'ARI'), g('26OCT04KCLV', 'KC'))).reason));

  // fast pull when leg price moves: opponent (NYG) gets cheaper => our fair drops.. and when DEN opp (SF) ask rises, fair falls => edge huge (stay);
  // make ARI's opponent NYG ask jump to .60 => ARI true prob falls... instead lower to .30: ARI true rises => edge gone
  const rid = 'pull-me';
  on.onRfq({ ...K(g(G1.game, 'ARI'), g(G2.game, 'DEN')), rfqId: rid });
  const stamp = lines.length;
  const { ingest } = { ingest: (m) => book.ingestKalshiMarkets(m) };
  const occ = new Date(Date.now() + 27 * 3600e3).toISOString();
  ingest([{ ticker: 'KXNFLGAME-26OCT04ARINYG-NYG', yes_ask_dollars: '0.30', yes_bid_dollars: '0.28', occurrence_datetime: occ }]);
  const pulled = on.sweep();
  assert.ok(pulled.some((p) => p.rfqId === rid && p.reason === 'edge_gone'), JSON.stringify(pulled.map((p) => p.reason)));
  assert.ok(lines.slice(stamp).some((l) => /PULL rfq=pull-me reason=edge_gone/.test(l)));

  // game already started
  const book2 = makeBook([{ ...G1, occ: new Date(Date.now() + 3 * 3600e3 - 60e3).toISOString() }, G2]);
  const s2 = createNoBoostShadow({ book: book2, env: { NOBOOST_SHADOW: '1' }, log });
  assert.strictEqual(s2.onRfq(K(g(G1.game, 'ARI'), g(G2.game, 'DEN'))).reason, 'game_started');

  // risk cap blocks (tiny combo cap)
  const s3 = createNoBoostShadow({ book: makeBook([G1, G2]), env: { NOBOOST_SHADOW: '1', NOBOOST_MAX_COMBO_LOSS: '1' }, log });
  assert.strictEqual(s3.onRfq(K(g(G1.game, 'ARI'), g(G2.game, 'DEN'))).reason, 'risk:combo_cap');
  assert.ok(s3.summary().counts.risk_blocked === 1);
}

// ── safety: no network / order code anywhere in the module graph
for (const f of ['noboost-quote.js', 'noboost-risk.js', 'noboost-book.js', 'noboost-shadow.js']) {
  const src = fs.readFileSync(`${__dirname}/${f}`, 'utf8');
  assert.ok(!/fetch\(|https?\.request|createQuote|confirmQuote|\/quotes|WebSocket|\.post\(/.test(src.replace(/\/\/.*$/gm, '')), `${f} must not send anything`);
}
{
  const src = fs.readFileSync(`${__dirname}/noboost-runner.js`, 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/method:\s*'(POST|PUT|DELETE)'|createQuote|confirm|WebSocket|createKalshiWs/.test(src), 'runner is GET-only');
}
console.log('noboost-shadow.test.js ok');
