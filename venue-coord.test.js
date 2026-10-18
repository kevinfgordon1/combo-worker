'use strict';
const assert = require('assert');
const { createVenueCoordinator } = require('./venue-coord');
const { createCapBook, confirmAgainstCap } = require('./cap-confirm');

// In-memory stand-in for combo_venue_holds + combo_venue_claim. The RPC runs
// claims one at a time, like the per-lock advisory lock in Postgres.
function fakeDb({ failRpc = false } = {}) {
  const rows = new Map(); // venue|quote -> row
  let chain = Promise.resolve();
  const key = (v, q) => `${v}|${q}`;
  function query(table) {
    const f = { op: 'select', eq: {}, neq: {}, in: null, patch: null };
    const api = {
      select() { f.op = f.op === 'select' ? 'select' : f.op; return api; },
      delete() { f.op = 'delete'; return api; },
      update(p) { f.op = 'update'; f.patch = p; return api; },
      eq(c, v) { f.eq[c] = v; return api; },
      neq(c, v) { f.neq[c] = v; return api; },
      in(c, v) { f.in = [c, v]; return api; },
      gte() { return api; },
      then(res, rej) {
        const match = [...rows.values()].filter((r) =>
          Object.entries(f.eq).every(([c, v]) => r[c] === v)
          && Object.entries(f.neq).every(([c, v]) => r[c] !== v)
          && (!f.in || f.in[1].includes(r[f.in[0]])));
        if (f.op === 'delete') for (const r of match) rows.delete(key(r.venue, r.quote_id));
        if (f.op === 'update') for (const r of match) Object.assign(r, f.patch);
        return Promise.resolve({ data: f.op === 'select' ? match : null, error: null }).then(res, rej);
      },
    };
    assert.strictEqual(table, 'combo_venue_holds');
    return api;
  }
  return {
    rows,
    from: query,
    rpc(name, a) {
      assert.strictEqual(name, 'combo_venue_claim');
      const run = async () => {
        await new Promise((r) => setTimeout(r, 2));
        if (failRpc) return { data: null, error: { message: 'db down' } };
        rows.set(key(a.p_venue, a.p_quote), {
          venue: a.p_venue, quote_id: a.p_quote, parlay_id: a.p_parlay, contracts: a.p_contracts,
        });
        let other = 0;
        for (const r of rows.values()) if (r.parlay_id === a.p_parlay && r.venue !== a.p_venue) other += r.contracts;
        return { data: [{ other_held: other }], error: null };
      };
      const p = chain.then(run);
      chain = p.catch(() => {});
      return p;
    },
  };
}

function side(db, venue) {
  const coord = createVenueCoordinator({ supabase: db, venue, log: () => {} });
  const book = coord.attach(createCapBook({ enabled: true }));
  return { coord, book };
}

(async () => {
  // Race: lock cap 100, nothing filled. Kalshi and Polymarket both get a
  // 60-contract accept at the same instant. Exactly one may confirm.
  {
    const db = fakeDb();
    const k = side(db, 'kalshi');
    const p = side(db, 'polymarket');
    const confirmed = [];
    const go = (s, venue, quoteId) => confirmAgainstCap(s.book, {
      parlayId: 'L1', quoteId, maxContracts: 100, size: 60,
      getFilled: () => 0,
      confirm: async () => { confirmed.push(venue); },
    });
    const [a, b] = await Promise.all([go(k, 'kalshi', 'qk'), go(p, 'polymarket', 'qp')]);
    assert.strictEqual(confirmed.length, 1, 'only one venue confirms');
    assert.strictEqual([a, b].filter((x) => x.ok).length, 1);
    const loser = a.ok ? b : a;
    assert.strictEqual(loser.reason, 'cap_exceeded');
    assert.strictEqual(loser.crossVenue, true);
    await k.coord.flush(); await p.coord.flush();
    assert.strictEqual(db.rows.size, 1, 'the rejected claim row is removed');
  }

  // Both fit: 40 + 50 under 100 confirm on both venues.
  {
    const db = fakeDb();
    const k = side(db, 'kalshi');
    const p = side(db, 'polymarket');
    const base = { parlayId: 'L2', maxContracts: 100, getFilled: () => 0, confirm: async () => {} };
    const [a, b] = await Promise.all([
      confirmAgainstCap(k.book, { ...base, quoteId: 'a', size: 40 }),
      confirmAgainstCap(p.book, { ...base, quoteId: 'b', size: 50 }),
    ]);
    assert.ok(a.ok && b.ok);
    // Quote-time exposure sees the other venue after a poll, without a DB call.
    await k.coord.poll();
    assert.strictEqual(k.book.sum('L2'), 90);
    assert.strictEqual(k.book.localSum('L2'), 40);
    // Fill booked -> release -> row deleted on flush -> other side stops counting it.
    p.book.release('L2', 'b');
    await p.coord.flush();
    await k.coord.poll();
    assert.strictEqual(k.book.sum('L2'), 40);
    // Partial booked fill reduces the mirrored row.
    k.book.reduce('L2', 'a', 15);
    await k.coord.flush();
    await p.coord.poll();
    assert.strictEqual(p.book.sum('L2'), 25);
  }

  // DB down at confirm: fail closed — no confirm, no local hold.
  {
    const db = fakeDb({ failRpc: true });
    const k = side(db, 'kalshi');
    let confirmed = false;
    await assert.rejects(confirmAgainstCap(k.book, {
      parlayId: 'L3', quoteId: 'x', maxContracts: 100, size: 10,
      getFilled: () => 0, confirm: async () => { confirmed = true; },
    }), /venue claim failed/);
    assert.strictEqual(confirmed, false);
    assert.strictEqual(k.book.localSum('L3'), 0);
  }

  // Confirm failure at the venue releases the mirrored hold.
  {
    const db = fakeDb();
    const k = side(db, 'kalshi');
    await assert.rejects(confirmAgainstCap(k.book, {
      parlayId: 'L4', quoteId: 'y', maxContracts: 100, size: 10,
      getFilled: () => 0, confirm: async () => { throw new Error('409'); },
    }));
    await k.coord.flush();
    assert.strictEqual(db.rows.size, 0);
  }

  // Startup clears this venue's stale rows only.
  {
    const db = fakeDb();
    db.rows.set('kalshi|old', { venue: 'kalshi', quote_id: 'old', parlay_id: 'L5', contracts: 5 });
    db.rows.set('polymarket|keep', { venue: 'polymarket', quote_id: 'keep', parlay_id: 'L5', contracts: 7 });
    const k = createVenueCoordinator({ supabase: db, venue: 'kalshi', log: () => {}, pollMs: 1e9, flushMs: 1e9 });
    k.attach(createCapBook({ enabled: true }));
    await k.start();
    assert.ok(!db.rows.has('kalshi|old') && db.rows.has('polymarket|keep'));
    assert.strictEqual(k.otherSum('L5'), 7);
    await k.stop();
  }

  // No coordinator attached: confirmAgainstCap is unchanged (single process).
  {
    const book = createCapBook({ enabled: true });
    const r = await confirmAgainstCap(book, {
      parlayId: 'L6', quoteId: 'z', maxContracts: 100, size: 60, getFilled: () => 50, confirm: async () => {},
    });
    assert.strictEqual(r.ok, false);
    assert.ok(!r.crossVenue);
  }
  console.log('venue-coord tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
