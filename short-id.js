'use strict';

// Last 5 chars for Telegram display only. Never use in logs, DB, maps, or API calls.
function shortId(id) {
  if (id == null || id === '') return '?';
  const s = String(id);
  return s.length <= 5 ? s : s.slice(-5);
}

module.exports = { shortId };
