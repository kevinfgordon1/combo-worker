// Local / rollback: one process runs Combo Locks + Unhedged (old wiring).
// Do not use on production Railway — deploy two services instead.
'use strict';
process.env.WORKER_MODE = process.env.WORKER_MODE || 'all';
require('./start-live');
