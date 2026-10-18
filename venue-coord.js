// Cross-process confirm holds for Combo Locks (Kalshi in combo-worker,
// Polymarket in combo-poly).
//
// Each process keeps its own in-memory cap book. This module:
//   1. claim(): at confirm, atomically inserts this venue's hold into
//      combo_venue_holds under a per-lock advisory lock and returns the OTHER
//      venue's live holds. Two simultaneous confirms on one lock are serialized
//      by Postgres, so the second one always sees the first (no double fill).
//   2. mirrors reduce/release of local holds to the table (async, batched,
//      off the quote path; a late delete only over-counts, which is safe).
//   3. polls the other venue's holds every pollMs into memory so quote-time
//      exposure (book.sum) includes them without a DB round trip.
// A process restart drops its own rows (its in-memory holds are gone too).
// Rows older than the hard TTL (30 min) are ignored, matching cap-confirm.
'use strict';

const HOLD_TTL_MS = Number(process.env.COMBO_HOLD_HARD_TTL_MS) > 0
  ? Number(process.env.COMBO_HOLD_HARD_TTL_MS) : 30 * 60_000;

function num(n) { const x = Number(n); return Number.isFinite(x) && x > 0 ? x : 0; }

function createVenueCoordinator({
  supabase, venue, pollMs = 1000, flushMs = 500, failOpen = false,
  now = Date.now, log = console.log, alert = null,
} = {}) {
  if (!supabase || !venue) throw new Error('venue-coord: supabase and venue required');
  const other = new Map(); // parlayId -> sum of the other venue's holds
  let otherAt = 0;
  const writes = new Map(); // quoteId -> { op: 'del'|'set', parlayId, contracts }
  const timers = [];
  const stats = { claims: 0, claimFail: 0, crossRejects: 0, polls: 0, pollFail: 0, flushes: 0, flushFail: 0 };

  function otherSum(parlayId) {
    if (parlayId == null) return 0;
    return other.get(String(parlayId)) || 0;
  }

  async function claim({ parlayId, quoteId, size, meta }) {
    stats.claims++;
    const { data, error } = await supabase.rpc('combo_venue_claim', {
      p_parlay: String(parlayId),
      p_quote: String(quoteId),
      p_venue: venue,
      p_contracts: num(size),
      p_ttl_ms: HOLD_TTL_MS,
      p_meta: meta ? { label: meta.label || null, rfq_id: meta.rfqId || null } : null,
    });
    if (error) {
      stats.claimFail++;
      if (failOpen) {
        log(`[coord] claim failed (fail-open) lock=${parlayId} quote=${quoteId}: ${error.message}`);
        return { ok: true, other: otherSum(parlayId), degraded: true };
      }
      throw new Error(`venue claim failed: ${error.message}`);
    }
    const row = Array.isArray(data) ? data[0] : data;
    const o = num(row && (row.other_held != null ? row.other_held : row));
    other.set(String(parlayId), o);
    return { ok: true, other: o };
  }

  function queue(quoteId, w) {
    if (quoteId == null) return;
    writes.set(String(quoteId), w);
  }

  async function flush() {
    if (!writes.size) return;
    const batch = [...writes.entries()];
    writes.clear();
    const dels = batch.filter(([, w]) => w.op === 'del').map(([q]) => q);
    const sets = batch.filter(([, w]) => w.op === 'set');
    try {
      if (dels.length) {
        const { error } = await supabase.from('combo_venue_holds').delete().eq('venue', venue).in('quote_id', dels);
        if (error) throw error;
      }
      for (const [q, w] of sets) {
        const { error } = await supabase.from('combo_venue_holds')
          .update({ contracts: num(w.contracts), updated_at: new Date(now()).toISOString() })
          .eq('venue', venue).eq('quote_id', q);
        if (error) throw error;
      }
      stats.flushes++;
    } catch (e) {
      stats.flushFail++;
      // Re-queue unless superseded; stale rows over-count, which is safe.
      for (const [q, w] of batch) if (!writes.has(q)) writes.set(q, w);
      log(`[coord] flush failed: ${e && e.message}`);
    }
  }

  async function poll() {
    try {
      const since = new Date(now() - HOLD_TTL_MS).toISOString();
      const { data, error } = await supabase.from('combo_venue_holds')
        .select('parlay_id,contracts')
        .neq('venue', venue)
        .gte('created_at', since);
      if (error) throw error;
      const next = new Map();
      for (const r of data || []) {
        const k = String(r.parlay_id);
        next.set(k, (next.get(k) || 0) + num(r.contracts));
      }
      other.clear();
      for (const [k, v] of next) other.set(k, v);
      otherAt = now();
      stats.polls++;
    } catch (e) {
      stats.pollFail++;
      // Keep the last snapshot: dropping it would under-count the other venue.
      if (stats.pollFail % 30 === 1) log(`[coord] poll failed: ${e && e.message}`);
    }
  }

  // Wrap a cap book so it counts the other venue and mirrors our holds.
  function attach(book) {
    if (!book || book.remote) return book;
    const localSum = book.sum;
    const localRelease = book.release;
    const localReduce = book.reduce;
    book.localSum = (parlayId, exclude) => localSum(parlayId, exclude);
    book.sum = (parlayId, exclude) => localSum(parlayId, exclude) + otherSum(parlayId);
    book.release = (parlayId, quoteId, ...rest) => {
      const out = localRelease(parlayId, quoteId, ...rest);
      queue(quoteId, { op: 'del', parlayId });
      return out;
    };
    if (typeof localReduce === 'function') {
      book.reduce = (parlayId, quoteId, ...rest) => {
        const out = localReduce(parlayId, quoteId, ...rest);
        if (!(book.has && book.has(parlayId, quoteId))) queue(quoteId, { op: 'del', parlayId });
        else queue(quoteId, { op: 'set', parlayId, contracts: book.holdSize(parlayId, quoteId) });
        return out;
      };
    }
    book.remote = { claim, unclaim: (parlayId, quoteId) => queue(quoteId, { op: 'del', parlayId }) };
    return book;
  }

  async function start() {
    // Our in-memory holds died with the last process; so do our rows.
    try {
      const { error } = await supabase.from('combo_venue_holds').delete().eq('venue', venue);
      if (error) throw error;
    } catch (e) {
      log(`[coord] startup clear failed: ${e && e.message}`);
      if (alert) alert(`Combo Locks: could not clear stale ${venue} holds (${e && e.message})`);
    }
    await poll();
    timers.push(setInterval(poll, pollMs), setInterval(flush, flushMs));
    log(`[coord] venue=${venue} poll=${pollMs}ms flush=${flushMs}ms failOpen=${failOpen ? 'on' : 'off'}`);
  }

  function stop() { for (const t of timers) clearInterval(t); return flush(); }

  return {
    attach, start, stop, poll, flush, claim, otherSum,
    snapshot: () => ({ ...stats, otherLocks: other.size, otherAgeMs: otherAt ? now() - otherAt : null, pendingWrites: writes.size }),
  };
}

module.exports = { createVenueCoordinator, HOLD_TTL_MS };
