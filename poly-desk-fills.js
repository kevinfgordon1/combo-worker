// Polymarket US fills outside Combo Locks (Live Trading Desk, manual orders)
// -> one Telegram "DESK FILL" per trade. Combo Lock trades (caoc-* slugs) are
// skipped here: live-runner already sends "FILL CONFIRMED (Polymarket)".
//
// Polls /v1/portfolio/activities (ACTIVITY_TYPE_TRADE, newest first). The
// first poll only records what is already there, so a restart never replays
// old fills. Trades created before the watcher started are ignored too.
'use strict';
const { listAllActivities, tradeFromActivity } = require('./polymarket-fill-reconcile');

function isComboSlug(slug) {
  return /^caoc-/i.test(String(slug || ''));
}

function fmtNum(n, d = 2) {
  const x = Number(n);
  return Number.isFinite(x) ? String(Number(x.toFixed(d))) : '?';
}

function formatDeskFillAlert(activity, trade) {
  const t = activity.trade || activity.order || activity;
  const side = String(t.side || t.action || t.intent || '').replace(/^.*_/, '').toLowerCase();
  const outcome = t.outcome || t.outcomeName || (t.marketMetadata && t.marketMetadata.outcome) || '';
  const px = trade.price ? `@ ${fmtNum(trade.price * 100, 1)}¢` : '';
  return `💰 DESK FILL (Polymarket US) — ${trade.title || trade.marketSlug || 'market'}\n` +
    [side, fmtNum(trade.qty), 'contracts', outcome, px].filter(Boolean).join(' ') +
    (trade.cost ? ` · $${fmtNum(trade.cost)}` : '') +
    (trade.marketSlug ? `\n${trade.marketSlug}` : '');
}

function createPolyDeskFillWatcher({ http, sendAlert, now = Date.now, log = console.log, maxPages = 1 } = {}) {
  const seen = new Set();
  const startedAt = now();
  let primed = false;
  let busy = false;

  function remember(id) {
    seen.add(id);
    if (seen.size > 5000) seen.delete(seen.values().next().value);
  }

  async function tick() {
    if (busy || !http) return [];
    busy = true;
    const alerts = [];
    try {
      const activities = await listAllActivities(http, { maxPages, limit: 50 });
      for (const a of activities.slice().reverse()) {
        const trade = tradeFromActivity(a);
        if (!trade || !trade.id) continue;
        const id = String(trade.id);
        if (seen.has(id)) continue;
        remember(id);
        if (!primed) continue;
        if (isComboSlug(trade.marketSlug)) continue;
        const ts = Date.parse(trade.createTime || '');
        if (Number.isFinite(ts) && ts < startedAt - 60000) continue;
        const text = formatDeskFillAlert(a, trade);
        alerts.push(text);
        log(`[DESK-FILL] ${text.replace(/\n/g, ' | ')}`);
        try { await sendAlert(text); } catch (_) { /* gate logs */ }
      }
      primed = true;
    } catch (e) {
      log(`[DESK-FILL] activities read failed ${e && e.message}`);
    } finally {
      busy = false;
    }
    return alerts;
  }

  return { tick, _seen: seen };
}

module.exports = { createPolyDeskFillWatcher, formatDeskFillAlert, isComboSlug };
