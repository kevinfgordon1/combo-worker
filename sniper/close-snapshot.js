// Closing-line snapshot (EV drift tracker): for every leg of an open live fill, record the sniper's own
// inverse-bet leg fair (best-of-venues, fees in, same legFairDepth the quote used) once, in the window just
// before that leg's kickoff. Written once per leg (upsert ignoreDuplicates). Fail-soft: a missing table
// (migration not applied) just disables the loop with one log line.
const { classifyLegs } = require('./engine');
const { legFairDepth } = require('./fair');

// Legs due for a close snapshot: kickoff within [ko − before, ko + after], not captured yet.
function dueLegs(fills, kickoffFor, nowMs, captured, { beforeMs = 10 * 60e3, afterMs = 2 * 60e3 } = {}) {
  const out = [];
  for (const f of fills || []) {
    const keys = (f.legs || []).map((k) => { const [t, s] = String(k).split(':'); return `${t.toUpperCase()}:${s || 'yes'}`; });
    keys.forEach((k, i) => {
      if (captured.has(k) || out.some((o) => o.key === k)) return;
      const ko = kickoffFor(k.split(':')[0]);
      if (!Number.isFinite(ko)) return;
      if (nowMs >= ko - beforeMs && nowMs <= ko + afterMs) out.push({ key: k, i, legKeys: keys, ko });
    });
  }
  return out;
}

function closeRows(due, books) {
  const rows = [];
  for (const d of due) {
    let f = { p: null };
    try {
      const cls = classifyLegs({ legKeys: d.legKeys }, { td: !!books.tdBook, ncaaf: !!books.ncaafBook, lines: !!books.linesBook, nba: !!books.nbaBook, ncaab: !!books.ncaabBook });
      if (cls.ok && cls.legs[d.i]) f = legFairDepth(cls.legs[d.i], books) || { p: null };
    } catch (_) { /* no price */ }
    const [ticker, side] = d.key.split(':');
    rows.push({ leg_key: d.key, ticker, side, kickoff_at: new Date(d.ko).toISOString(), fair_yes: f.p > 0 && f.p < 1 ? f.p : null, venue: f.venue || null, depth_usd: f.depthUsd != null ? Math.round(f.depthUsd) : null });
  }
  return rows;
}

function createCloseSnapshot({ supabase, kickoffFor, books, live = true, log = console.log, now = () => Date.now() }) {
  const captured = new Set(); let fills = []; let fillsAt = 0; let off = false;
  async function refreshFills() {
    const { data, error } = await supabase.from('sniper_ledger').select('rfq_id,legs').gt('filled_contracts', 0).neq('phase', 'settled').eq('dry_run', !live).limit(2000);
    if (error) throw new Error(error.message);
    fills = data || []; fillsAt = now();
  }
  async function tick() {
    if (off) return 0;
    if (now() - fillsAt > 5 * 60e3) await refreshFills();
    const rows = closeRows(dueLegs(fills, kickoffFor, now(), captured), books);
    if (!rows.length) return 0;
    const { error } = await supabase.from('sniper_leg_close').upsert(rows, { onConflict: 'leg_key', ignoreDuplicates: true });
    if (error) { if (/sniper_leg_close|does not exist|schema cache/i.test(error.message)) { off = true; log('[SNIPER] close snapshot off: table sniper_leg_close missing (apply migration 20261024b)'); return 0; } throw new Error(error.message); }
    for (const r of rows) captured.add(r.leg_key);
    log(`[SNIPER] close snapshot: ${rows.length} leg(s)`);
    return rows.length;
  }
  return { tick, _captured: captured };
}

module.exports = { dueLegs, closeRows, createCloseSnapshot };
