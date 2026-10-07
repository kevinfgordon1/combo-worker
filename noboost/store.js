// Supabase REST writer for the no-boost paper tape. GET/POST/PATCH to OUR OWN
// Supabase tables only (noboost_paper_rfqs / noboost_paper_stats). Never touches Kalshi.
'use strict';
const { toRow } = require('./paper');

function createStore({ url, key, fetchImpl = fetch, log = console.log, flushMs = 5000, batch = 200, runId = null } = {}) {
  const base = String(url || '').replace(/\/$/, '');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const upserts = new Map();
  const patches = [];
  const stats = [];
  let warned = 0;
  let timer = null;
  const warn = (m) => { if (Date.now() - warned > 30000) { warned = Date.now(); log(`[NOBOOST] store error: ${m}`); } };

  function persist(rec, kind) {
    if (!base || !key) return;
    if (kind === 'patch') patches.push(rec);
    else upserts.set(rec.rfq_id, toRow(rec));
  }
  function persistStats(payload) { if (base && key) stats.push(payload); }

  async function call(method, path, body, extra = {}) {
    const r = await fetchImpl(`${base}/rest/v1/${path}`, { method, headers: { ...headers, ...extra }, body: body == null ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${r.status} ${(await r.text()).slice(0, 120)}`);
    return r;
  }
  async function flush() {
    try {
      if (upserts.size) {
        const rows = [...upserts.values()]; upserts.clear();
        for (let i = 0; i < rows.length; i += batch) {
          await call('POST', 'noboost_paper_rfqs?on_conflict=rfq_id', rows.slice(i, i + batch), { Prefer: 'resolution=merge-duplicates,return=minimal' });
        }
      }
      while (patches.length) {
        const p = patches.shift();
        const { rfq_id: id, ...rest } = p;
        await call('PATCH', `noboost_paper_rfqs?rfq_id=eq.${encodeURIComponent(id)}`, rest, { Prefer: 'return=minimal' });
      }
      while (stats.length) {
        await call('POST', 'noboost_paper_stats', { payload: stats[0], ...(runId ? { run_id: runId } : {}) }, { Prefer: 'return=minimal' });
        stats.shift();
      }
    } catch (e) { warn(e.message); }
  }
  function start() { if (!timer) timer = setInterval(flush, flushMs); return flush; }
  // Only THIS run's open fills: a new run_id starts with empty paper risk books (old runs' rows stay for reference).
  async function loadOpenFills() {
    try {
      const runFilter = runId ? `run_id=eq.${encodeURIComponent(runId)}&` : '';
      const r = await call('GET', `noboost_paper_rfqs?${runFilter}settled=eq.false&or=(primary_fill.eq.true,lock_fill.eq.true,promo_fill.eq.true)&select=*&limit=5000`);
      return await r.json();
    } catch (e) { warn(e.message); return []; }
  }
  return { persist, persistStats, flush, start, loadOpenFills, _q: { upserts, patches, stats } };
}
module.exports = { createStore };
