// Per-user Combo Lock Telegram alerts (temporary, testers only — Oct 2026).
//
// A tester opts in by opening t.me/Kaygosports_bot?start=cl_<token>; the
// aibetbuilder Telegram webhook writes their chat_id onto their row in
// public.combo_tg_links. This poller (runs in the combo-testers supervisor,
// never in Kevin's combo-worker) then sends that chat short messages about
// THAT user's own locks only:
//   - quote sent  (combo_submissions rows with status unfilled/filled)
//   - fill        (combo_fills rows)
//
// Safety:
//   - off unless COMBO_USER_TG_ALERTS=1 and COMBO_USER_TG_BOT_TOKEN is set;
//   - a user is alerted only if they are in COMBO_USER_TG_USER_IDS AND have an
//     enabled, linked combo_tg_links row, and are not one of Kevin's ids;
//   - every query is filtered by that user_id, and each row's user_id is
//     re-checked before it is queued for that user's chat;
//   - never reads TELEGRAM_ALERT_CHAT_ID / TELEGRAM_BOT_TOKEN (Kevin's
//     fills-only channel is untouched).
// Throttle: at most one message per chat per COMBO_USER_TG_GAP_MS (default
// 30s); everything queued in between goes out as one batched message.
'use strict';

const { DEFAULT_LIVE_USER_IDS } = require('./live-users');

const MAX_CHARS = 3800;
const MAX_LINES = 30;

function fmtAmerican(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '?';
  return v > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`;
}

function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '?';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function legsText(parlay, fallbackLabel) {
  const legs = parlay && Array.isArray(parlay.legs) ? parlay.legs : null;
  if (legs && legs.length) {
    const names = legs.map((l) => (l && (l.label || l.ticker)) || '?');
    return names.join(' + ');
  }
  return (parlay && parlay.label) || fallbackLabel || 'Combo Lock';
}

function formatQuote(sub, parlay) {
  const venue = sub.venue && sub.venue !== 'kalshi' ? ` (${sub.venue})` : '';
  return `Quote sent${venue}: ${legsText(parlay, sub.label)} @ ${fmtAmerican(sub.fill_american)}, ${fmtNum(sub.contracts)} contracts`;
}

function formatFill(fill, parlay) {
  const px = fill.no_price != null && fill.outcome_side === 'no' ? fill.no_price : (fill.yes_price != null ? fill.yes_price : fill.no_price);
  const odds = parlay && parlay.fill_american != null ? ` @ ${fmtAmerican(parlay.fill_american)}` : '';
  const price = px != null && Number.isFinite(Number(px)) ? ` (price ${Number(px)})` : '';
  return `FILLED: ${legsText(parlay, null)}${odds}, ${fmtNum(fill.count)} contracts${price}`;
}

function parseIds(raw) {
  return new Set(String(raw || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function createUserTgAlerts({ supabase, env = process.env, fetchImpl, now = Date.now, log = console.log, excludeIds = DEFAULT_LIVE_USER_IDS } = {}) {
  const enabled = String(env.COMBO_USER_TG_ALERTS || '').trim() === '1';
  const token = String(env.COMBO_USER_TG_BOT_TOKEN || '').trim();
  const allow = parseIds(env.COMBO_USER_TG_USER_IDS);
  const gapMs = Number(env.COMBO_USER_TG_GAP_MS) > 0 ? Number(env.COMBO_USER_TG_GAP_MS) : 30_000;
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const exclude = new Set(excludeIds.map((s) => String(s).toLowerCase()));

  const users = new Map(); // userId -> { chatId, subCursor, fillCursor, queue: [], lastSentAt, pausedUntil }
  const parlayCache = new Map();
  const active = enabled && !!token && allow.size > 0;

  async function loadLinks() {
    const { data, error } = await supabase.from('combo_tg_links')
      .select('user_id,chat_id,enabled').eq('enabled', true).not('chat_id', 'is', null);
    if (error) { log(`[USER-TG] links read failed: ${error.message}`); return null; }
    const want = new Map();
    for (const r of data || []) {
      const id = String(r.user_id || '').toLowerCase();
      if (!id || exclude.has(id) || !allow.has(id) || r.chat_id == null) continue;
      want.set(id, String(r.chat_id));
    }
    for (const id of [...users.keys()]) if (!want.has(id)) { users.delete(id); log(`[USER-TG] ${id.slice(0, 8)} unlinked/disabled`); }
    const startIso = new Date(now()).toISOString();
    for (const [id, chatId] of want) {
      const u = users.get(id);
      if (u) { u.chatId = chatId; continue; }
      // Start from "now": no backlog of old quotes on link / restart.
      users.set(id, { chatId, subCursor: startIso, fillCursor: startIso, queue: [], lastSentAt: -Infinity, pausedUntil: 0 });
      log(`[USER-TG] ${id.slice(0, 8)} alerts on`);
    }
    return want.size;
  }

  async function parlaysFor(userId, ids) {
    const missing = [...new Set(ids.filter((x) => x && !parlayCache.has(x)))];
    if (missing.length) {
      const { data } = await supabase.from('combo_parlays').select('id,user_id,label,legs,fill_american').in('id', missing).eq('user_id', userId);
      for (const p of data || []) parlayCache.set(p.id, p);
    }
    const out = new Map();
    for (const id of ids) {
      const p = parlayCache.get(id);
      if (p && String(p.user_id).toLowerCase() === userId) out.set(id, p);
    }
    return out;
  }

  async function collect(userId, u) {
    const [subsQ, fillsQ] = await Promise.all([
      supabase.from('combo_submissions')
        .select('id,user_id,parlay_id,label,fill_american,contracts,status,venue,created_at')
        .eq('user_id', userId).in('status', ['unfilled', 'filled'])
        .gt('created_at', u.subCursor).order('created_at', { ascending: true }).limit(200),
      supabase.from('combo_fills')
        .select('fill_id,user_id,parlay_id,count,yes_price,no_price,outcome_side,recorded_at')
        .eq('user_id', userId)
        .gt('recorded_at', u.fillCursor).order('recorded_at', { ascending: true }).limit(200),
    ]);
    const subs = subsQ.error ? [] : (subsQ.data || []);
    const fills = fillsQ.error ? [] : (fillsQ.data || []);
    if (subsQ.error) log(`[USER-TG] quotes read failed: ${subsQ.error.message}`);
    if (fillsQ.error) log(`[USER-TG] fills read failed: ${fillsQ.error.message}`);
    const parlays = await parlaysFor(userId, [...subs, ...fills].map((r) => r.parlay_id));
    for (const s of subs) {
      u.subCursor = s.created_at > u.subCursor ? s.created_at : u.subCursor;
      if (String(s.user_id).toLowerCase() !== userId) continue;
      u.queue.push(formatQuote(s, parlays.get(s.parlay_id)));
    }
    for (const f of fills) {
      u.fillCursor = f.recorded_at > u.fillCursor ? f.recorded_at : u.fillCursor;
      if (String(f.user_id).toLowerCase() !== userId) continue;
      u.queue.push(formatFill(f, parlays.get(f.parlay_id)));
    }
  }

  function batchText(lines) {
    // Fills first so they never get cut.
    const fills = lines.filter((l) => l.startsWith('FILLED'));
    const quotes = lines.filter((l) => !l.startsWith('FILLED'));
    const ordered = fills.concat(quotes);
    const shown = ordered.slice(0, MAX_LINES);
    let text = shown.join('\n');
    if (ordered.length > shown.length) text += `\n(+${ordered.length - shown.length} more quotes)`;
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS - 1) + '…';
    return text;
  }

  async function flush(userId, u) {
    if (!u.queue.length) return false;
    const t = now();
    if (t < u.pausedUntil || t - u.lastSentAt < gapMs) return false;
    const lines = u.queue.splice(0);
    u.lastSentAt = t;
    try {
      const r = await doFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: u.chatId, text: batchText(lines), disable_web_page_preview: true }),
      });
      if (r.status === 429) {
        let retry = 60;
        try { const j = await r.json(); if (Number(j.parameters.retry_after) > 0) retry = Number(j.parameters.retry_after); } catch (_) {}
        u.pausedUntil = now() + retry * 1000;
        u.queue.unshift(...lines);
      } else if (r.status === 403) {
        log(`[USER-TG] ${userId.slice(0, 8)} blocked the bot; dropping ${lines.length}`);
      } else if (!r.ok) {
        log(`[USER-TG] ${userId.slice(0, 8)} send failed ${r.status}`);
      }
    } catch (e) {
      log(`[USER-TG] ${userId.slice(0, 8)} send error ${e && e.message}`);
      u.queue.unshift(...lines);
    }
    if (u.queue.length > 500) u.queue.splice(0, u.queue.length - 500);
    return true;
  }

  async function tick() {
    if (!active) return null;
    const n = await loadLinks();
    if (n == null) return null;
    for (const [id, u] of users) {
      try { await collect(id, u); } catch (e) { log(`[USER-TG] collect error ${e && e.message}`); }
      await flush(id, u);
    }
    return n;
  }

  return { tick, active, _users: users, _batchText: batchText };
}

module.exports = { createUserTgAlerts, formatQuote, formatFill, fmtAmerican };
