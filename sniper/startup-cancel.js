// Fix 4 (Oct 28 2026, SNIPER_STARTUP_CANCEL_OPEN, default on in live): on boot, cancel every OPEN quote a
// previous sniper process left on Kalshi. The DB startup sweep only knows rows the old process wrote;
// on Oct 28 a restart left 51 quotes open on live RFQs for up to an hour.
// Safety:
//   - sniper subaccount only: refuses unless subaccount >= 1, and each quote's creator_subaccount must
//     equal it (missing => skipped). Combo Locks quotes / other subaccounts are never touched.
//   - status 'open' only (an accepted quote is not open) and created before `cutoffMs` (Kalshi server ms,
//     taken before this process posts anything), so this process's own quotes are never cancelled.
//   - complete snapshot only (every page read); a partial or failed read cancels nothing.
//   - paced at rps (own pacing on top of the shared write limiter).
'use strict';

function selectStartupCancels(quotes, { subaccount, cutoffMs }) {
  const out = []; const skipped = { other_subaccount: 0, not_open: 0, too_new: 0, no_created: 0 };
  if (!(Number(subaccount) >= 1)) return { ids: out, skipped, refused: 'no_subaccount' };
  for (const q of quotes || []) {
    if (!q || !q.id) continue;
    if (q.creator_subaccount == null || Number(q.creator_subaccount) !== Number(subaccount)) { skipped.other_subaccount += 1; continue; }
    if (String(q.status || '').toLowerCase() !== 'open') { skipped.not_open += 1; continue; }
    const c = Date.parse(q.created_ts || '');
    if (!Number.isFinite(c)) { skipped.no_created += 1; continue; }
    if (!(c < cutoffMs)) { skipped.too_new += 1; continue; }
    out.push(q.id);
  }
  return { ids: out, skipped, refused: null };
}

async function startupCancelOpen({ trader, subaccount, cutoffMs, rps = 8, urgent = true, maxPages = 10, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), snapshot = null, onTargets = () => {} }) {
  const res = { listed: 0, targets: 0, cancelled: 0, gone: 0, failed: 0, skipped: null, refused: null, complete: null };
  if (!(Number(subaccount) >= 1)) { res.refused = 'no_subaccount'; log('[SNIPER] startup open-quote cancel refused: no sniper subaccount'); return res; }
  const snap = snapshot || await trader.openQuotesSnapshot({ maxPages });
  res.complete = !!snap.complete; res.listed = snap.count || 0;
  if (!snap.complete) { res.refused = 'partial_snapshot'; log(`[SNIPER] startup open-quote cancel skipped: partial snapshot (${res.listed} listed)`); return res; }
  const sel = selectStartupCancels(snap.quotes || [], { subaccount, cutoffMs });
  res.skipped = sel.skipped; res.targets = sel.ids.length;
  try { onTargets(sel.ids); } catch (_) { /* untracked sweep dedupe only */ }
  const gap = rps > 0 ? 1000 / rps : 0;
  for (const id of sel.ids) {
    try { const r = await trader.cancel(id, { urgent }); if (r && r.statusCode === 404) res.gone += 1; else res.cancelled += 1; } catch (e) { res.failed += 1; if (res.failed <= 5) log(`[SNIPER] startup cancel ${id} failed: ${String(e.message || e).slice(0, 160)}`); }
    if (gap) await sleep(gap);
  }
  log(`[SNIPER] startup open-quote cancel: listed=${res.listed} targets=${res.targets} cancelled=${res.cancelled} gone=${res.gone} failed=${res.failed} skipped=${JSON.stringify(res.skipped)}`);
  return res;
}

module.exports = { selectStartupCancels, startupCancelOpen };
