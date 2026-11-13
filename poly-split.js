// Process split: Kalshi quoting vs Polymarket quoting vs the Novig RFQ maker.
//
// COMBO_ROLE:
//   all   (default) — one process quotes Kalshi AND Polymarket (today's setup).
//   poly            — Polymarket only (start-poly.js / the combo-poly service).
//                     Never opens a Kalshi WebSocket, never posts/cancels Kalshi
//                     quotes, no bucket manager, single-leg, desk fills, unhedged.
//   novig           — Novig RFQ only (start-novig.js). No Kalshi socket, no
//                     Polymarket client, no Kalshi or Polymarket keys. Reserves
//                     at quote time. COMBO_CAP_AT_CONFIRM does not apply.
// COMBO_POLY_ENABLED=0 (role all) — combo-worker skips the Polymarket RFQ loop,
//   so the Kalshi event loop never touches Polymarket streaming or REST polling.
//   Flip back to 1 (or unset) for instant rollback.
//
// When the two venues run in different processes, confirm-time cap checks are
// coordinated through the shared DB (venue-coord.js); that requires
// COMBO_CAP_AT_CONFIRM=1. Novig is the exception: it claims the full quote
// before sending, so the flag stays off and the hold row is still visible.
'use strict';

const OFF = /^(0|false|no|off)$/i;
const ON = /^(1|true|yes|on)$/i;

function resolveSplit(env = process.env) {
  const src = env || {};
  const raw = String(src.COMBO_ROLE || '').trim().toLowerCase();
  const role = raw === 'poly' ? 'poly' : raw === 'novig' ? 'novig' : 'all';
  const polyFlagOff = OFF.test(String(src.COMBO_POLY_ENABLED || '').trim());
  const runKalshi = role === 'all';
  const runPoly = role === 'poly' || (role === 'all' && !polyFlagOff);
  const runNovig = role === 'novig';
  // Venues live in different processes when either side is split out.
  const split = role !== 'all' || polyFlagOff || ON.test(String(src.COMBO_VENUE_COORD || '').trim());
  const coordOff = OFF.test(String(src.COMBO_VENUE_COORD || '').trim());
  return {
    role,
    runKalshi,
    runPoly,
    runNovig,
    coord: split && !coordOff,
    venue: role === 'poly' ? 'polymarket' : role === 'novig' ? 'novig' : 'kalshi',
    mode: role === 'poly' ? 'POLY' : role === 'novig' ? 'NOVIG' : 'LIVE',
  };
}

// Returns an error string when the configuration is unsafe, else null.
function splitConfigError(split, env = process.env) {
  if (!split || !split.coord) return null;
  // Novig reserves the whole quote before it is sent. Cap-at-confirm must not
  // apply, and the cross-venue hold does not need that flag.
  if (split.role === 'novig') return null;
  if (!ON.test(String((env || {}).COMBO_CAP_AT_CONFIRM || ''))) {
    return 'venue split needs COMBO_CAP_AT_CONFIRM=1 (cross-venue caps are enforced at confirm)';
  }
  return null;
}

module.exports = { resolveSplit, splitConfigError };
