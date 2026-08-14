// Start-time gate for combo RFQs. If ANY source says a leg/event has started
// (start <= now = first pitch, not archive +6h), the live runner must not quote.
//
// Sources (any one is enough to skip):
//   1. Explicit timestamps on the Kalshi RFQ / its legs, when present
//      (start_time, starts_at, commence_time, event_start_time, game_start_time, startTime).
//      RFQ payloads we have captured do not currently send these — we still read them.
//   2. combo_parlays.starts_at (Combo Locks "game start" / earliest first pitch).
//   3. Per-leg commence_time / start_time / starts_at on the lock (parlay.legs).
//   4. Kalshi sports ticker / gameKey encoding (e.g. KXMLBGAME-26AUG141840CWSDET):
//      YY + MON + DD + HHMM as America/New_York wall time — first pitch, not expiration.
'use strict';

const START_KEYS = [
  'start_time', 'starts_at', 'commence_time',
  'event_start_time', 'game_start_time', 'startTime',
];

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

// Kalshi sports event/market tickers and Combo Locks gameKeys embed first pitch:
//   KXMLBGAME-26AUG141840CWSDET-CWS  /  26AUG141840CWSDET
const TICKER_START_RE = /(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{4})/i;

function parseTs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return v < 1e12 ? v * 1000 : v;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function nthSunday(year, monthIndex, n) {
  const dow = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const firstSunday = dow === 0 ? 1 : 8 - dow;
  return firstSunday + (n - 1) * 7;
}

// US Eastern DST: 2nd Sunday of March 02:00 through 1st Sunday of November 02:00.
function easternOffsetHours(year, month, day, hour) {
  const mar = nthSunday(year, 2, 2);
  const nov = nthSunday(year, 10, 1);
  let dst = false;
  if (month > 3 && month < 11) dst = true;
  else if (month === 3) {
    if (day > mar) dst = true;
    else if (day === mar) dst = hour >= 2;
  } else if (month === 11) {
    if (day < nov) dst = true;
    else if (day === nov) dst = hour < 2;
  }
  return dst ? 4 : 5;
}

function parseKalshiTickerStart(text) {
  if (text == null) return null;
  const m = TICKER_START_RE.exec(String(text));
  if (!m) return null;
  const year = 2000 + parseInt(m[1], 10);
  const month = MONTHS[m[2].toUpperCase()];
  const day = parseInt(m[3], 10);
  const hhmm = m[4];
  const hour = parseInt(hhmm.slice(0, 2), 10);
  const minute = parseInt(hhmm.slice(2, 4), 10);
  if (!month || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const off = easternOffsetHours(year, month, day, hour);
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` +
    `T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-0${off}:00`;
  return parseTs(iso);
}

function pushTime(source, value, out) {
  const ms = parseTs(value);
  if (ms == null) return;
  out.push({ source, at: ms });
}

function pushTicker(source, value, out) {
  const ms = parseKalshiTickerStart(value);
  if (ms == null) return;
  out.push({ source, at: ms });
}

function collectFromObject(prefix, obj, out) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of START_KEYS) {
    if (obj[k] != null) pushTime(`${prefix}.${k}`, obj[k], out);
  }
}

function collectFromLegs(prefix, legs, out) {
  if (!Array.isArray(legs)) return;
  legs.forEach((leg, i) => {
    if (!leg || typeof leg !== 'object') {
      if (typeof leg === 'string') pushTicker(`${prefix}[${i}].ticker`, leg, out);
      return;
    }
    collectFromObject(`${prefix}[${i}]`, leg, out);
    pushTicker(`${prefix}[${i}].ticker`, leg.ticker || leg.market_ticker || leg.event_ticker, out);
    pushTicker(`${prefix}[${i}].gameKey`, leg.gameKey || leg.game_key, out);
  });
}

function collectStartTimes(rfq, parlay, extra) {
  const out = [];
  const msg = extra && extra.msg;

  if (msg) collectFromObject('rfq', msg, out);
  if (rfq) {
    collectFromObject('rfq', rfq, out);
    collectFromLegs('rfq.leg', rfq.legs || rfq.mve_selected_legs, out);
    pushTicker('rfq.marketTicker', rfq.marketTicker, out);
    if (Array.isArray(rfq.legKeys)) {
      rfq.legKeys.forEach((k, i) => pushTicker(`rfq.legKeys[${i}]`, k, out));
    }
  }
  if (msg) {
    collectFromLegs('rfq.leg', msg.mve_selected_legs || msg.selected_legs, out);
    pushTicker('rfq.event_ticker', msg.event_ticker, out);
    pushTicker('rfq.market_ticker', msg.market_ticker || msg.ticker, out);
  }

  if (parlay) {
    pushTime('parlay.starts_at', parlay.starts_at, out);
    collectFromLegs('parlay.leg', parlay.legs, out);
    if (Array.isArray(parlay.leg_keys)) {
      parlay.leg_keys.forEach((k, i) => pushTicker(`parlay.leg_keys[${i}]`, k, out));
    }
    if (Array.isArray(parlay.legKeys)) {
      parlay.legKeys.forEach((k, i) => pushTicker(`parlay.legKeys[${i}]`, k, out));
    }
  }
  return out;
}

// If ANY collected start is <= now, the parlay/RFQ is unquotable.
function findStartedEvent(rfq, parlay, extra, now) {
  const nowMs = now != null ? now : Date.now();
  const times = collectStartTimes(rfq, parlay, extra);
  let earliest = null;
  for (const t of times) {
    if (t.at <= nowMs && (!earliest || t.at < earliest.at)) earliest = t;
  }
  if (!earliest) return { started: false };
  return {
    started: true,
    reason: 'game_started',
    source: earliest.source,
    at: new Date(earliest.at).toISOString(),
    atMs: earliest.at,
  };
}

module.exports = {
  parseTs,
  parseKalshiTickerStart,
  collectStartTimes,
  findStartedEvent,
};
