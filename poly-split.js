// Process split: Kalshi quoting vs Polymarket quoting.
//
// COMBO_ROLE:
//   all   (default) — one process quotes Kalshi AND Polymarket (today's setup).
//   poly            — Polymarket only (start-poly.js / the combo-poly service).
//                     Never opens a Kalshi WebSocket, never posts/cancels Kalshi
//                     quotes, no bucket manager, single-leg, desk fills, unhedged.
// COMBO_POLY_ENABLED=0 (role all) — combo-worker skips the Polymarket RFQ loop,
//   so the Kalshi event loop never touches Polymarket streaming or REST polling.
//   Flip back to 1 (or unset) for instant rollback.
//
// When the two venues run in different processes, confirm-time cap checks are
// coordinated through the shared DB (venue-coord.js); that requires
// COMBO_CAP_AT_CONFIRM=1.
'use strict';

const OFF = /^(0|false|no|off)$/i;
const ON = /^(1|true|yes|on)$/i;

function resolveSplit(env = process.env) {
  const src = env || {};
  const role = String(src.COMBO_ROLE || '').trim().toLowerCase() === 'poly' ? 'poly' : 'all';
  const polyFlagOff = OFF.test(String(src.COMBO_POLY_ENABLED || '').trim());
  const runKalshi = role !== 'poly';
  const runPoly = role === 'poly' || !polyFlagOff;
  // Venues live in different processes when either side is split out.
  const split = role === 'poly' || polyFlagOff || ON.test(String(src.COMBO_VENUE_COORD || '').trim());
  const coordOff = OFF.test(String(src.COMBO_VENUE_COORD || '').trim());
  return {
    role,
    runKalshi,
    runPoly,
    coord: split && !coordOff,
    venue: role === 'poly' ? 'polymarket' : 'kalshi',
    mode: role === 'poly' ? 'POLY' : 'LIVE',
  };
}

// Returns an error string when the configuration is unsafe, else null.
function splitConfigError(split, env = process.env) {
  if (!split.coord) return null;
  if (!ON.test(String((env || {}).COMBO_CAP_AT_CONFIRM || ''))) {
    return 'venue split needs COMBO_CAP_AT_CONFIRM=1 (cross-venue caps are enforced at confirm)';
  }
  return null;
}

module.exports = { resolveSplit, splitConfigError };
