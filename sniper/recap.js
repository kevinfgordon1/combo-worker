// Nightly Telegram recap for the sniper (~11:59 PM ET). Always sends, even with no fills.
'use strict';
const etParts = (ms) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { day: `${o.year}-${o.month}-${o.day}`, hh: Number(o.hour), mm: Number(o.minute) };
};
const usd = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;

function summarize({ quotes, rows }, dayStartIso) {
  let fills = 0; let filledRisk = 0; let wins = 0; let losses = 0; let pushes = 0; let pnl = 0;
  for (const r of rows) {
    const filledToday = Number(r.filled_contracts) > 0 && (r.updated_at >= dayStartIso || r.created_at >= dayStartIso) && (r.phase === 'filled' || r.phase === 'settled');
    if (filledToday && r.created_at >= dayStartIso) { fills += 1; filledRisk += (Number(r.filled_cost) || 0) + (Number(r.filled_fee) || 0); }
    if (r.phase === 'settled' && r.settled_at && r.settled_at >= dayStartIso && r.realized_pnl != null) {
      const p = Number(r.realized_pnl) || 0; pnl += p;
      if (p > 0) wins += 1; else if (p < 0) losses += 1; else pushes += 1;
    }
  }
  return { quotes, fills, filledRisk, wins, losses, pushes, pnl };
}

function formatRecap(day, s, openRisk, live) {
  return [
    `🎯 SNIPER (not Combo Locks) — nightly recap ${day} (${live ? 'LIVE' : 'TEST MODE, no real orders'})`,
    `Quotes: ${s.quotes}`,
    `Fills: ${s.fills}${s.fills ? ` (${usd(s.filledRisk)} at risk)` : ''}`,
    `Settled: ${s.wins}W / ${s.losses}L${s.pushes ? ` / ${s.pushes} void` : ''}`,
    `P&L today: ${usd(s.pnl)}`,
    `Open risk now: ${usd(openRisk)}`,
  ].join('\n');
}

function createNightlyRecap({ store, send, dayStartIso, live = false, openRisk = () => 0, now = () => Date.now(), hour = 23, minute = 59, log = () => {} }) {
  let sentFor = null;
  async function tick() {
    const t = now(); const p = etParts(t);
    if (p.hh !== hour || p.mm < minute || sentFor === p.day) return false;
    sentFor = p.day;
    const start = dayStartIso(t);
    let s;
    try { s = summarize(await store.dayRecap(start, { live }), start); } catch (e) {
      log(`[SNIPER] recap read failed: ${e.message}`);
      send(`🎯 SNIPER (not Combo Locks) — nightly recap ${p.day}: could not read ledger (${e.message}). Open risk now: ${usd(openRisk())}`);
      return true;
    }
    send(formatRecap(p.day, s, openRisk(), live));
    return true;
  }
  return { tick };
}

module.exports = { createNightlyRecap, summarize, formatRecap, etParts };
