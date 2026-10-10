// Telegram gate for the combo worker (Kevin, Oct 2026): Telegram carries
// matched / filled orders only, plus a short list of critical money events.
// Everything else (quotes, skips, rejections, low cash, status, WS, stalls)
// is console-only.
//
// Allowed:
//   fill     — "FILL CONFIRMED" (Kalshi + Polymarket Combo Locks),
//              "REAL FILL" (Kalshi fills reader), "DESK FILL" (Polymarket US
//              Live Trading Desk), "OVERFILL" (a fill bigger than quoted).
//   critical — Kalshi bucket transfer failed / not confirmed.
//
// Rate limiting (one bot, several processes share it):
//   - at most one sendMessage per TG_MIN_GAP_MS (default 3s) per process;
//   - messages that queue up are batched into one message (<= 3800 chars);
//   - a 429 sets a pause until retry_after, written to a shared file in the
//     OS temp dir so sibling processes (fills reader, desk protect) also stop;
//   - while paused nothing is sent. Fills queue (newest 40 kept); when the
//     pause ends they go out as one digest with a count of any dropped.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILL_RE = /FILL CONFIRMED|REAL FILL|DESK FILL|OVERFILL/i;
const CRITICAL_RE = /bucket transfer failed|bucket transfer not confirmed/i;

function classifyAlert(text) {
  // First line only: error text in a body must not promote a routine alert.
  const s = String(text == null ? '' : text).split('\n')[0];
  if (FILL_RE.test(s)) return 'fill';
  if (CRITICAL_RE.test(s)) return 'critical';
  return null;
}

const MAX_CHARS = 3800;
const MAX_QUEUE = 40;

function createTelegramGate(opts = {}) {
  const env = opts.env || process.env;
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chat = String(env.TELEGRAM_ALERT_CHAT_ID || '').trim();
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const now = opts.now || Date.now;
  const tag = opts.tag || 'TG';
  const log = opts.log || ((m) => console.log(`[${tag}] ${m}`));
  const minGapMs = Number(env.TG_MIN_GAP_MS) > 0 ? Number(env.TG_MIN_GAP_MS) : 3000;
  const pauseFile = opts.pauseFile !== undefined
    ? opts.pauseFile
    : path.join(os.tmpdir(), 'combo-worker-telegram-pause');
  const schedule = opts.setTimeout || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });

  const queue = [];
  let dropped = 0;
  let pausedUntil = 0;
  let lastSentAt = -Infinity;
  let timer = null;
  let sending = false;

  function sharedPause() {
    if (!pauseFile) return 0;
    try { return Number(fs.readFileSync(pauseFile, 'utf8')) || 0; } catch (_) { return 0; }
  }
  function setPause(untilMs) {
    pausedUntil = Math.max(pausedUntil, untilMs);
    if (!pauseFile) return;
    try { fs.writeFileSync(pauseFile, String(pausedUntil)); } catch (_) { /* best effort */ }
  }
  function pauseLeft() {
    const until = Math.max(pausedUntil, sharedPause());
    pausedUntil = until;
    return Math.max(0, until - now());
  }

  function arm(ms) {
    if (timer) return;
    timer = schedule(() => { timer = null; flush().catch(() => {}); }, Math.max(0, ms));
  }

  function takeBatch() {
    const parts = [];
    let len = 0;
    if (dropped > 0) {
      const note = `(${dropped} older alert${dropped === 1 ? '' : 's'} dropped while Telegram was rate-limited)`;
      parts.push(note);
      len += note.length;
    }
    while (queue.length) {
      const next = queue[0];
      if (parts.length && len + next.length + 2 > MAX_CHARS) break;
      parts.push(next.length > MAX_CHARS ? next.slice(0, MAX_CHARS) : next);
      len += next.length + 2;
      queue.shift();
    }
    return parts;
  }

  async function flush() {
    if (sending || !queue.length) return;
    const wait = pauseLeft();
    if (wait > 0) { arm(Math.min(wait, 60 * 60 * 1000)); return; }
    const gap = lastSentAt + minGapMs - now();
    if (gap > 0) { arm(gap); return; }
    sending = true;
    const batchDropped = dropped;
    const parts = takeBatch();
    dropped = 0;
    lastSentAt = now();
    try {
      const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: parts.join('\n\n') }),
      });
      if (r.status === 429) {
        let retry = 60;
        try {
          const j = await r.json();
          const ra = Number(j && j.parameters && j.parameters.retry_after);
          if (ra > 0) retry = ra;
        } catch (_) { /* default 60s */ }
        setPause(now() + retry * 1000 + 1000);
        // Put the batch back (fills only) so it goes out after the pause.
        const back = parts.filter((p) => !/^\(\d+ older alert/.test(p));
        queue.unshift(...back);
        dropped += batchDropped;
        trim();
        log(`telegram 429 — paused ${retry}s, ${queue.length} queued`);
      } else if (!r.ok) {
        log(`telegram send failed ${r.status}`);
      }
    } catch (e) {
      log(`telegram error ${e && e.message}`);
    } finally {
      sending = false;
    }
    if (queue.length) arm(Math.max(pauseLeft(), minGapMs));
  }

  function trim() {
    while (queue.length > MAX_QUEUE) { queue.shift(); dropped += 1; }
  }

  async function send(text) {
    const kind = classifyAlert(text);
    const flat = String(text).replace(/\n/g, ' | ');
    if (!kind) { log(`(console only) ${flat}`); return { sent: false, kind: null }; }
    if (!token || !chat) { log(`(telegram not configured) ${flat}`); return { sent: false, kind }; }
    queue.push(String(text));
    trim();
    await flush();
    return { sent: true, kind };
  }

  return { send, flush, _state: () => ({ queue: queue.slice(), dropped, pausedUntil }) };
}

module.exports = { createTelegramGate, classifyAlert };
