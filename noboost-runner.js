// No-boost RFQ shadow runner — PAPER ONLY, READ-ONLY (HTTP GETs only).
//
// Own process (npm run start:noboost-paper). Does NOT open the Kalshi
// communications WebSocket (one per key — that belongs to combo-worker), does not
// create/confirm/cancel quotes, and never touches Combo Locks. It polls
//   GET /communications/rfqs?status=open   (every NOBOOST_RFQ_POLL_MS, default 1500)
//   GET /markets?series_ticker=KXNFLGAME   (every NOBOOST_MARKETS_POLL_MS, default 5000)
// feeds each new RFQ to noboost-shadow, and logs "[NOBOOST] WOULD_QUOTE|SKIP|PULL" lines.
// Master switch NOBOOST_SHADOW defaults OFF: with it off the process idles and logs once.
'use strict';
const { normalizePem, authHeaders } = require('./kalshi-auth');
const { normalizeRfq } = require('./rfq');
const { createNflBook } = require('./noboost-book');
const { createNoBoostShadow } = require('./noboost-shadow');
const { isNoBoostShadow, isNoBoostLive } = require('./noboost-quote');

const ORIGIN = 'https://api.elections.kalshi.com';

function createGetter(env = process.env, fetchImpl = fetch) {
  const keyId = env.KALSHI_KEY_ID;
  const pem = normalizePem(env.Kalshi_combo_key || env.KALSHI_PRIVATE_KEY || '');
  return async function get(path) {
    const h = authHeaders({ keyId, pem, method: 'GET', signPath: path.split('?')[0] });
    const r = await fetchImpl(ORIGIN + path, { headers: h });
    if (!r.ok) throw new Error(`GET ${path.split('?')[0]} -> ${r.status}`);
    return r.json();
  };
}

async function main(env = process.env) {
  if (isNoBoostLive(env)) { console.error('[NOBOOST] NOBOOST_LIVE set — paper-only service refuses to start'); process.exit(1); }
  if (!isNoBoostShadow(env)) {
    console.log('[NOBOOST] NOBOOST_SHADOW is off (default) — idle. Set NOBOOST_SHADOW=1 to log paper quotes.');
    setInterval(() => {}, 1 << 30);
    return;
  }
  const get = createGetter(env);
  const book = createNflBook();
  const shadow = createNoBoostShadow({ book, env, log: (l) => console.log(l) });
  const seen = new Set();
  const pollMs = Number(env.NOBOOST_RFQ_POLL_MS) || 1500;
  const mktMs = Number(env.NOBOOST_MARKETS_POLL_MS) || 5000;
  console.log(`[NOBOOST] shadow on: margin=${shadow.cfg.margin} mode=${shadow.cfg.marginMode} fair=${shadow.cfg.fairMethod} guardrail=${shadow.cfg.guardrail} (paper only, GET only)`);

  async function refreshMarkets() {
    let cursor = '';
    for (let i = 0; i < 5; i += 1) {
      const j = await get(`/trade-api/v2/markets?series_ticker=KXNFLGAME&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      book.ingestKalshiMarkets(j.markets || []);
      cursor = j.cursor || '';
      if (!cursor) break;
    }
  }
  async function pollRfqs() {
    const j = await get('/trade-api/v2/communications/rfqs?status=open&limit=1000');
    for (const r of j.rfqs || []) {
      if (!r.id || seen.has(r.id)) continue;
      seen.add(r.id);
      if (seen.size > 200000) seen.clear();
      const legs = r.mve_selected_legs || [];
      if (!legs.length) continue;
      const rfq = {
        rfqId: r.id,
        marketTicker: r.market_ticker,
        legKeys: legs.map((l) => `${String(l.market_ticker).toUpperCase()}:${l.side || 'yes'}`),
        contracts: r.contracts_fp != null ? Number(r.contracts_fp) : null,
        targetCostDollars: r.target_cost_dollars != null ? Number(r.target_cost_dollars) : null,
      };
      shadow.onRfq(rfq, { venue: 'kalshi' });
    }
  }
  const guard = (fn, name) => async () => { try { await fn(); } catch (e) { console.log(`[NOBOOST] ${name} error: ${e.message}`); } };
  await guard(refreshMarkets, 'markets')();
  setInterval(guard(refreshMarkets, 'markets'), mktMs);
  setInterval(guard(pollRfqs, 'rfqs'), pollMs);
  setInterval(() => { try { shadow.sweep(); } catch (e) { console.log(`[NOBOOST] sweep error: ${e.message}`); } }, 1000);
  setInterval(() => console.log(`[NOBOOST] SUMMARY ${JSON.stringify(shadow.summary())}`), 60000);
}

if (require.main === module) main();
module.exports = { main, createGetter };
