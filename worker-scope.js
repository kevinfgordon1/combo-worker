// Which account's exchange keys THIS process holds, and therefore whose locks
// it may quote, hedge and book fills for.
//
//   COMBO_WORKER_USER_ID unset  -> Kevin's main worker (his existing keys).
//                                  Scope = Kevin's own user ids. Unchanged path.
//   COMBO_WORKER_USER_ID=<uuid> -> a per-tester child started by start-testers.js
//                                  with THAT tester's keys. Scope = [uuid] only.
//
// Every DB read that could pick up another user's quotes/orders/fills is
// filtered to scope.userIds, and rows this process writes carry
// scope.writeUserId, so funds and fills never cross between users.
'use strict';

const { DEFAULT_LIVE_USER_IDS } = require('./live-users');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function resolveWorkerScope(env = process.env) {
  const raw = env && env.COMBO_WORKER_USER_ID;
  if (raw == null || String(raw).trim() === '') {
    return Object.freeze({
      userIds: Object.freeze([...DEFAULT_LIVE_USER_IDS]),
      writeUserId: null,
      isTester: false,
      invalid: false,
    });
  }
  const id = String(raw).trim().toLowerCase();
  if (!UUID_RE.test(id)) {
    // Fail closed: a garbled tester id must never fall back to Kevin's scope.
    return Object.freeze({ userIds: Object.freeze([]), writeUserId: null, isTester: true, invalid: true });
  }
  return Object.freeze({
    userIds: Object.freeze([id]),
    writeUserId: id,
    isTester: !DEFAULT_LIVE_USER_IDS.includes(id),
    invalid: false,
  });
}

function scopeLabel(scope) {
  if (!scope || scope.invalid) return 'INVALID COMBO_WORKER_USER_ID (nothing will be quoted)';
  if (!scope.isTester) return `owner worker (${scope.userIds.length} Kevin id(s))`;
  return `tester worker user=${scope.writeUserId}`;
}

module.exports = { resolveWorkerScope, scopeLabel, UUID_RE };
