// Shared Telegram headline helper for Combo Locks quote-lifecycle alerts.
// Kaygosports sees both Kalshi and Polymarket; the venue must be in the
// first line so QUOTED / LATE / FAIL / FILL are not interchangeable.
'use strict';

const VENUE_LABELS = Object.freeze({
  kalshi: 'Kalshi',
  polymarket: 'Polymarket',
});

function venueLabel(venue) {
  if (venue == null || venue === '') return '';
  const key = String(venue).trim().toLowerCase();
  return VENUE_LABELS[key] || '';
}

// "✅ QUOTED" + "kalshi" → "✅ QUOTED (Kalshi)"
function formatAlertStatus(status, venue) {
  const name = venueLabel(venue);
  const base = status == null ? '' : String(status);
  return name ? `${base} (${name})` : base;
}

module.exports = {
  VENUE_LABELS,
  venueLabel,
  formatAlertStatus,
};
