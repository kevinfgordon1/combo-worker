// Standalone canonical schedule sync (local / one-off). In production it runs inside the sniper process
// (sniper/runner.js, GAME_SCHEDULE_SYNC=0 turns it off) so no new machine is needed.
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { createAppAlerts } = require('./app-alerts');
const { createScheduleSync } = require('./schedule-sync');
const env = process.env;
const alerts = env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY ? createAppAlerts({ client: createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }) }) : null;
const s = createScheduleSync({ env, alerts });
if (process.argv.includes('--once')) s.tick().then(() => { console.log(JSON.stringify(s.stats())); process.exit(0); });
else s.start();
