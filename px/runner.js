// prophetx-worker runner (SANDBOX ONLY). Listens for parlay RFQs on the
// ProphetX parlay socket, prices them with the inverse bet method, quotes,
// confirms with leg probabilities, and logs. Unsupported / correlated / stale
// requests get NO quote (a quote we later reject counts toward suspension).
'use strict';
const { checkSandboxEnv, assertSandboxUrl } = require('./guard');
const { createSession } = require('./auth');
const { createPusher } = require('./pusher');
const { createCatalog } = require('./catalog');
const { createPricer } = require('./pricer');
const { createStore } = require('./store');
const Q = require('./quote');

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
}

function payloadOf(data) {
  if (data && typeof data === 'object' && data.payload && typeof data.payload === 'object') return data.payload;
  return data || {};
}

// Confirm request: ProphetX's field name for the price has varied (odds / price).
function confirmPriceOf(p) {
  for (const k of ['price', 'odds', 'confirmed_price', 'confirmed_odds']) {
    if (p[k] != null && Number.isFinite(Number(p[k]))) return Number(p[k]);
  }
  return null;
}

function createRunner({ env = process.env, logger = console, fetch: f = globalThis.fetch } = {}) {
  const g = checkSandboxEnv(env);
  if (!g.ok) throw new Error(`[PX-GUARD] refusing to start: ${g.problems.join('; ')}`);
  const cfg = {
    maxRisk: num(env.PX_MAX_RISK, 10),
    validMs: num(env.PX_VALID_MS, 15_000),
    priceTimeoutMs: num(env.PX_PRICE_TIMEOUT_MS, 5000),
    catalogEveryMs: num(env.PX_CATALOG_EVERY_MS, 10 * 60_000),
    // 'participant': offer price = the participant's American (e.g. +1180).
    // 'mm': offer price = the mirror (−1180). Set from the first sandbox confirms.
    offerSign: env.PX_OFFER_SIGN === 'mm' ? 'mm' : 'participant',
  };
  const session = createSession({ apiBase: g.apiBase, accessKey: env.PROPHETX_SANDBOX_API_KEY, secretKey: env.PROPHETX_SANDBOX_SECRET_KEY, fetch: f, logger });
  const catalog = createCatalog({ apiBase: g.apiBase, parlayBase: g.parlayBase, session, fetch: f, logger });
  const pricer = createPricer({ logger });
  const store = createStore({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY, fetch: f, logger });
  const quotes = new Map(); // parlay_id → { legs, priced, at }
  const firstSeen = new Set();
  const unsupported = new Map(); // tournament/market → leg count (log only, not DB)

  function logShapeOnce(kind, p) {
    if (firstSeen.has(kind)) return;
    firstSeen.add(kind);
    const redacted = JSON.parse(JSON.stringify(p, (k, v) => (k === 'callback_url' ? '<sandbox url>' : v)));
    logger.log(`[PX-SHAPE] first ${kind}: ${JSON.stringify(redacted).slice(0, 1200)}`);
  }

  async function postCallback(url, body) {
    assertSandboxUrl(url);
    const res = await f(url, { method: 'POST', headers: await session.authHeaders(), body: JSON.stringify(body) });
    const j = await res.json().catch(() => null);
    if (res.status === 403 || (j && /sp_banned|suspend/i.test(`${j.error} ${j.message}`))) {
      store.bump('suspended');
      logger.error(`[PX] SUSPENDED/BANNED signal status=${res.status} ${j && j.error}`);
    }
    return { status: res.status, body: j };
  }

  async function priceLegs(infos) {
    const got = await withTimeout(Promise.all(infos.map((i) => pricer.legPrice(i))), cfg.priceTimeoutMs);
    if (!got) return null;
    return infos.map((info, i) => ({ strike_id: info.strikeId, info, p: got[i] && got[i].p, at: got[i] && got[i].at, best: got[i] && got[i].best }));
  }

  async function onAsk(data) {
    const p = payloadOf(data);
    logShapeOnce('price.ask.new', p);
    store.bump('rfq');
    const lines = p.market_strikes || p.market_lines || p.lines || [];
    const reason = Q.screenLegs(lines, { known: catalog.known });
    if (reason) {
      store.bump(`decline_${reason}`);
      if (reason === 'unsupported_leg') {
        for (const l of lines) {
          if (catalog.known.has(l.strike_id || l.line_id)) continue;
          const k = `t${l.tournament_id}/m${l.market_id}`;
          unsupported.set(k, (unsupported.get(k) || 0) + 1);
        }
      }
      return;
    }
    const infos = lines.map((l) => catalog.known.get(l.strike_id || l.line_id));
    const legs = await priceLegs(infos);
    if (!legs) { store.bump('decline_price_timeout'); return; }
    const priced = Q.priceParlay(legs);
    if (priced.decline) { store.bump(`decline_${priced.decline}`); return; }
    const price = cfg.offerSign === 'mm' ? -priced.participantAmerican : priced.participantAmerican;
    const body = {
      parlay_id: p.parlay_id,
      offers: [{ valid_until: Number(Q.nsFromNow(cfg.validMs)), price, max_risk: cfg.maxRisk, estimated_price: priced.estimated }],
    };
    if (!p.callback_url) { store.bump('decline_no_callback'); return; }
    const r = await postCallback(p.callback_url, body);
    if (r.status !== 200) {
      store.bump('quote_http_error');
      logger.warn(`[PX] quote ${p.parlay_id} http=${r.status} ${r.body && r.body.error} ${String(r.body && r.body.message || '').slice(0, 160)}`);
      return;
    }
    store.bump('quoted');
    quotes.set(p.parlay_id, { legs, priced, price, at: Date.now() });
    const legTxt = legs.map((l) => `${l.info.team} ${Q.participantAmericanFloor(l.p) > 0 ? '+' : ''}${Q.participantAmericanFloor(l.p)}(${l.best.venue})`).join(' | ');
    logger.log(`[PX] QUOTE ${p.parlay_id} ${legs.length}L fair ${priced.fairAmerican > 0 ? '+' : ''}${priced.fairAmerican} → offer ${priced.participantAmerican > 0 ? '+' : ''}${priced.participantAmerican} max_risk $${cfg.maxRisk} qty $${p.quantity ?? p.stake} :: ${legTxt}`);
    store.insertQuote({
      parlay_id: p.parlay_id,
      n_legs: legs.length,
      legs: legs.map((l) => ({ s: l.strike_id, t: l.info.team, p: Number(l.p.toFixed(5)), v: l.best.venue, o: l.best.american })),
      stake: num(p.quantity != null ? p.quantity : p.stake, null),
      fair_american: priced.fairAmerican,
      quote_american: priced.participantAmerican,
      quote_p: Number(priced.quoteP.toFixed(6)),
      max_risk: cfg.maxRisk,
    });
  }

  async function onConfirm(data) {
    const p = payloadOf(data);
    logShapeOnce('price.confirm.new', p);
    store.bump('confirm_req');
    const q = quotes.get(p.parlay_id);
    const confirmed = confirmPriceOf(p);
    const qty = num(p.quantity != null ? p.quantity : (p.stake != null ? p.stake : p.confirmed_quantity), null);
    let action = 'accept';
    let why = null;
    let legsForProb = q && q.legs;
    if (!q) { action = 'reject'; why = 'unknown_parlay'; }
    if (q) {
      const fresh = await priceLegs(q.legs.map((l) => l.info));
      const fp = fresh && Q.priceParlay(fresh);
      if (!fp || fp.decline) { action = 'reject'; why = `reprice_${fp ? fp.decline : 'timeout'}`; }
      else if (fp.fairP > q.priced.quoteP) { action = 'reject'; why = `price_moved fair ${fp.fairAmerican} beyond offer ${q.priced.participantAmerican}`; }
      else legsForProb = fresh;
    }
    const target = Q.mirrorTarget(confirmed != null ? confirmed : (q && q.price));
    const strikes = legsForProb ? Q.legProbabilities(legsForProb.map((l) => ({ strike_id: l.strike_id, p: l.p })), target) : null;
    const body = {
      action,
      confirmed_price: confirmed != null ? confirmed : (q && q.price),
      confirmed_quantity: qty != null ? Math.min(qty, cfg.maxRisk) : null,
      price_probability: strikes ? [{ max_risk: cfg.maxRisk, strikes }] : [],
    };
    if (!p.callback_url) { logger.warn(`[PX] confirm ${p.parlay_id} has no callback_url`); return; }
    const r = await postCallback(p.callback_url, body);
    const errTxt = r.body ? `${r.body.error || ''} ${r.body.message || ''} ${r.body.warning || ''}`.trim() : '';
    const probErr = /probab/i.test(errTxt) ? errTxt.slice(0, 200) : null;
    store.bump(action === 'accept' ? 'confirm_accept' : 'confirm_reject');
    if (probErr) store.bump('prob_error');
    logger.log(`[PX] CONFIRM ${p.parlay_id} ${action}${why ? ` (${why})` : ''} confirmed_price=${body.confirmed_price} qty=${body.confirmed_quantity} target_p=${target && target.toFixed(5)} http=${r.status}${errTxt ? ` resp="${errTxt.slice(0, 200)}"` : ''}`);
    if (q) {
      store.patchQuote(p.parlay_id, {
        confirm_at: new Date().toISOString(), confirm_action: action, confirm_reason: why,
        confirmed_price: body.confirmed_price, confirmed_qty: body.confirmed_quantity,
        confirm_http: r.status, prob_error: probErr || (r.status !== 200 ? errTxt.slice(0, 200) || `http_${r.status}` : null),
      });
    }
  }

  async function onFinalized(data) {
    const p = payloadOf(data);
    logShapeOnce('order.finalized', p);
    store.bump(`finalized_${p.status || 'unknown'}`);
    logger.log(`[PX] FINALIZED ${p.parlay_id} status=${p.status} price=${p.confirmed_price ?? p.price} qty=${p.confirmed_quantity}`);
    if (quotes.has(p.parlay_id)) {
      store.patchQuote(p.parlay_id, { finalized_at: new Date().toISOString(), final_status: p.status || null, order_uuid: p.order_uuid || null });
    }
  }

  async function onSettled(data) {
    const p = payloadOf(data);
    logShapeOnce('order.settled', p);
    store.bump('settled');
    logger.log(`[PX] SETTLED ${p.parlay_id} ${p.settlement_status} profit=${p.profit}`);
    store.patchQuote(p.parlay_id, { settled_at: new Date().toISOString(), settlement: p.settlement_status || null, profit: num(p.profit, null) });
  }

  async function onEvent(ev, data) {
    const e = String(ev || '');
    if (e.endsWith('price.ask.new')) return onAsk(data);
    if (e.endsWith('price.confirm.new')) return onConfirm(data);
    if (e.endsWith('order.finalized')) return onFinalized(data);
    if (e.endsWith('order.settled')) return onSettled(data);
    if (e.endsWith('health_check')) { store.bump('health_check'); return undefined; }
    if (e.endsWith('order.matched')) { store.bump('public_order_matched'); logShapeOnce('order.matched', payloadOf(data)); return undefined; } // public broadcast: shows whether the bot takes anyone's offers
    store.bump(`event_${e}`);
    return undefined;
  }

  async function register(socketId) {
    const res = await f(`${g.parlayBase}/websocket/register`, { method: 'POST', headers: await session.authHeaders(), body: JSON.stringify({ socket_id: socketId }) });
    const j = await res.json().catch(() => null);
    if (res.status !== 200 || !j || !j.data) throw new Error(`register ${res.status}`);
    return j.data.authorized_channel || [];
  }

  let pusher = null;
  const timers = [];
  async function start() {
    logger.log(`[PX] prophetx-worker SANDBOX api=${new URL(g.apiBase).host} parlay=${new URL(g.parlayBase).host} max_risk=$${cfg.maxRisk} offer_sign=${cfg.offerSign} db=${store.enabled ? 'on' : 'off'}`);
    for (let i = 0; ; i += 1) {
      try { await session.token(); break; } catch (e) {
        if (i >= 8) throw e;
        logger.warn(`[PX-AUTH] ${e.message}; retry ${i + 1}`);
        await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * 2 ** i)));
      }
    }
    const prior = await catalog.syncRemote().catch(() => 0);
    logger.log(`[PX-CAT] previously registered strikes=${prior}`);
    await catalog.refresh();
    const wsCfg = await (await f(`${g.parlayBase}/websocket/connection-config`, { headers: await session.authHeaders() })).json();
    const c = wsCfg.data || wsCfg;
    const host = c.ws_host || `ws-${c.cluster}.pusher.com`;
    if (!/sandbox\.prophetx\.dev$/i.test(host) && !/pusher\.com$/i.test(host)) throw new Error('unexpected ws host');
    pusher = createPusher({ host, key: c.key, register, onEvent, logger });
    pusher.start();
    timers.push(setInterval(() => catalog.refresh().catch((e) => logger.warn(`[PX-CAT] ${e.message}`)), cfg.catalogEveryMs));
    timers.push(setInterval(() => session.token().catch((e) => logger.error(`[PX-AUTH] ${e.message}`)), 60_000));
    timers.push(setInterval(() => store.flushStats(), 5 * 60_000));
    timers.push(setInterval(() => {
      const now = Date.now();
      for (const [k, v] of quotes) if (now - v.at > 30 * 60_000) quotes.delete(k);
      logger.log(`[PX-STATS] ${JSON.stringify(store.counts())} ws=${pusher.state.connected ? 'up' : 'down'} reconnects=${pusher.state.reconnects} auth=${JSON.stringify({ logins: session.stats().logins, refreshes: session.stats().refreshes })} unsupported_top=${[...unsupported.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(',')}`);
    }, 60_000));
  }
  function stop() { timers.forEach(clearInterval); if (pusher) pusher.stop(); return store.flushStats(); }
  return { start, stop, onEvent, store, quotes, catalog, cfg };
}

module.exports = { createRunner, confirmPriceOf, payloadOf };
