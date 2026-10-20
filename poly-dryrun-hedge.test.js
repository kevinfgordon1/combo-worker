'use strict';
// poly-worker dry run: split single-leg hedges, NBA lines, dry-run guard.
const assert = require('assert');
process.env.POLY_NBA_LINES = '1';
const L = require('./leg-identity');
const { createSingleLegRunner } = require('./single-leg-runner');
const { isTelegramSend } = require('./dry-run-guard');

// NBA spread/total keys line up Kalshi <-> Polymarket
{
  const k = L.identityKey(L.parseKalshiLineTicker('KXNBASPREAD-26OCT20BOSDET-DET7:no'));
  assert.strictEqual(k, 'nba|2026-10-20|bos+det|spread|full|bos|yes|L6.5');
  const t = L.identityKey(L.parseKalshiLineTicker('KXNBATOTAL-26OCT20BOSDET-225:yes'));
  assert.strictEqual(t, 'nba|2026-10-20|bos+det|total|full|over|yes|L224.5');
  const mk = {
    slug: 'asc-nba-bos-det-2026-10-20-pos-6pt5', sportsMarketType: 'basketball_team_full_game_spread', line: 6.5,
    gameStartTime: '2026-10-20T19:00:00Z',
    marketSides: [
      { long: true, description: '+6.50', team: { abbreviation: 'bos', league: 'nba' } },
      { long: false, description: '-6.50', team: { abbreviation: 'det', league: 'nba' } },
    ],
  };
  const r = L.identitiesFromPolymarketLegs([{ symbol: mk.slug, side: 'SIDE_BUY' }], new Map([[mk.slug, mk]]));
  assert.ok(r.ok, r.reason);
  assert.deepStrictEqual(r.keys, [k]);
}

assert.ok(isTelegramSend('https://api.telegram.org/botX/sendMessage'));
assert.ok(!isTelegramSend('https://api.polymarket.us/v1/orders'));

// Split runner: Polymarket-only, dry, takes only its share and counts Kalshi rows.
(async () => {
  const lock = {
    id: 'L1', user_id: 'u', label: 'Test', fill_american: 120, max_contracts: 10, status: 'active',
    legs: [{ ticker: 'KXNBAGAME-26OCT20BOSDET-BOS', side: 'yes' }], starts_at: '2099-01-01T00:00:00Z',
  };
  const kalshiRows = [{ venue: 'kalshi', filled: 2, open: 3, size: 5, status: 'resting' }];
  const supabase = {
    from: () => {
      const q = {
        _venues: null,
        select() { return q; }, eq() { return q; },
        in(col, v) { if (col === 'venue') q._venues = v; return q; },
        then(res) {
          if (q._venues) return res({ data: kalshiRows.filter((r) => q._venues.includes(r.venue)), error: null });
          return res({ data: [], error: null });
        },
        upsert: async () => { throw new Error('dry run must not write'); },
        insert: async () => { throw new Error('dry run must not write'); },
      };
      return q;
    },
  };
  const logs = [];
  const placed = [];
  const polyHttp = {
    getMarketBySlug: async () => null,
    createOrder: async (b) => { placed.push(b); return { id: 'x' }; },
    cancelOrder: async () => { placed.push('cancel'); },
    getOrder: async () => null,
  };
  const r = createSingleLegRunner({
    env: {}, supabase, kalshiSigned: async () => { throw new Error('no kalshi'); }, polyHttp,
    fetchImpl: null, seriesFees: null, getParlays: () => [lock], isBlocked: () => false,
    sendAlert: async () => {}, log: (m) => logs.push(m), venues: ['polymarket'], forceDry: true,
  });
  assert.strictEqual(r.mode, 'dry');
  assert.strictEqual(r.split, true);
  await r.tick();
  assert.strictEqual(placed.length, 0, 'dry run never places');
  assert.ok(logs.some((m) => /other venue: kalshi filled 2 open 3/.test(m)), logs.join('\n'));
  console.log('poly-dryrun-hedge tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
