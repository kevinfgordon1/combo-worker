'use strict';
const assert = require('assert');
const H = require('./sniper-hook');
const S = require('../auto-sniper');
const src = (venue, cost, reason = 'ok', used = true) => ({ venue, cost, reason, used });
// best of four, top-only and stale/depth-failed ignored
const srcs = [src('kalshi', 0.60), src('polymarket', 0.55, 'top_only'), src('novig', 0.58), src('prophetx', 0.50, 'depth', false)];
assert.strictEqual(H.bestCost(srcs, H.ALL_VENUES).venue, 'novig');
assert.strictEqual(H.bestCost(srcs, ['kalshi']).venue, 'kalshi');
assert.strictEqual(H.bestCost([src('kalshi', 0.6, 'stale', false)], H.ALL_VENUES), null);
const pmLive = { legFair: (g, t) => ({ p: 0.4, sources: t === 'min' ? srcs : [src('kalshi', 0.7, 'depth', false)] }) };
const tdBook = { legMulti: (l) => ({ sources: l.side === 'yes' ? [src('kalshi', 0.72), src('polymarket', 0.70)] : [] }) };
const ml = H.legFairDepth({ gameId: 'g', team: 'min' }, { pmLive, tdBook, venues: H.ALL_VENUES });
assert.ok(Math.abs(ml.p - 0.42) < 1e-9);
assert.strictEqual(H.legFairDepth({ gameId: 'g', team: 'x' }, { pmLive, tdBook, venues: H.ALL_VENUES }).reason, 'no_venue_depth');
const td = H.legFairDepth({ kind: 'td', id: 'KXNFLTD-26OCT25INDMIN-MINJJEFFERSON18-1', side: 'yes' }, { pmLive, tdBook, venues: H.ALL_VENUES });
assert.ok(Math.abs(td.p - 0.30) < 1e-9); assert.strictEqual(td.best, 'polymarket');
assert.strictEqual(H.legFairDepth({ kind: 'td', id: 'x', side: 'no' }, { pmLive, tdBook, venues: H.ALL_VENUES }).reason, 'td_no_venue_depth');
// TD and ML on the same game share a game key (per-game cap; same-game skip)
assert.strictEqual(S.gameKey({ ticker: 'KXNFLTD-26OCT25INDMIN-MINJJEFFERSON18-1' }), S.gameKey({ ticker: 'KXNFLGAME-26OCT25INDMIN-MIN' }));
// onRfq: dry run, builds row and quotes; started skipped
(async () => {
  const logs = [];
  const sn = H.createNoboostSniper({ env: { SNIPER_ENABLED: '1' }, pmLive, tdBook, log: (m) => logs.push(m), feeCache: { prefetch: async () => ({ rate: 0 }) } });
  const rfq = { rfqId: 'r1', marketTicker: 'KXMVECROSSCATEGORY0-X-Y', legKeys: ['KXNFLGAME-26OCT25INDMIN-MIN:yes', 'KXNFLTD-26OCT25CINBAL-BALDHENRY22-1:yes'], contracts: 20 };
  const cls = { ok: true, legs: [{ gameId: 'g', team: 'min' }, { kind: 'td', id: 'KXNFLTD-26OCT25CINBAL-BALDHENRY22-1', side: 'yes' }] };
  const d = await sn.onRfq(rfq, cls, { action: 'skip', reason: 'margin' });
  assert.strictEqual(d.action, 'quote'); assert.ok(Math.abs(d.fairYes - 0.42 * 0.30) < 1e-9); assert.strictEqual(d.fee, 0);
  assert.ok(logs.some((l) => l.includes('WOULD_QUOTE')));
  assert.strictEqual(sn.onRfq({ ...rfq, rfqId: 'r2' }, cls, { reason: 'game_started' }), null);
  // tee: ingest fans out, reads stay on primary
  const calls = []; const a = { ingest: (x) => calls.push(['a', x]), size: () => 1 }; const b = { ingest: (x) => calls.push(['b', x]) };
  const t = H.teeIngest(a, b, ['ingest']); t.ingest(5);
  assert.deepStrictEqual(calls, [['b', 5], ['a', 5]]); assert.strictEqual(t.size(), 1);
  console.log('sniper-hook.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
