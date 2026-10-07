// Bounded "seen" set with time-based expiry — PURE, no I/O.
// Two-generation rotation: lookups check the current and previous generation; every
// ttlMs the previous generation is dropped wholesale. An id added at time a is
// therefore remembered for AT LEAST ttlMs (and at most ~2·ttlMs), and memory is
// bounded by the arrival rate × 2·ttlMs (plus a hard per-generation cap that rotates
// early and is counted, never a silent clear of everything at once).
'use strict';

function createTtlSet({ ttlMs, maxPerGen = 1000000, now = () => Date.now() } = {}) {
  if (!(ttlMs > 0)) throw new Error('createTtlSet: ttlMs must be > 0');
  let cur = new Set();
  let prev = new Set();
  let genStart = now();
  const stats = { rotations: 0, early_rotations: 0 };

  function rotate(t) {
    const age = t - genStart;
    if (age >= 2 * ttlMs) { prev = new Set(); cur = new Set(); genStart = t; stats.rotations += 1; return; }
    if (age >= ttlMs) { prev = cur; cur = new Set(); genStart = t; stats.rotations += 1; }
  }
  function has(id) { rotate(now()); return cur.has(id) || prev.has(id); }
  function add(id) {
    const t = now();
    rotate(t);
    if (cur.size >= maxPerGen) { prev = cur; cur = new Set(); genStart = t; stats.early_rotations += 1; }
    cur.add(id);
  }
  // true when id was new (and is now remembered); false when already seen
  function addIfNew(id) { if (has(id)) return false; add(id); return true; }
  function size() { return cur.size + prev.size; }
  return { has, add, addIfNew, size, stats };
}

module.exports = { createTtlSet };
