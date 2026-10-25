// Opt-in CPU profile (SNIPER_CPU_PROF_SEC>0): after SNIPER_CPU_PROF_DELAY_SEC (default 120s),
// records SNIPER_CPU_PROF_SEC seconds with node:inspector and writes
// ${SNIPER_CPU_PROF_DIR:-/tmp}/sniper-<thread>-<iso>.cpuprofile (open in Chrome DevTools > Performance
// or speedscope). Each thread (main, intake worker) profiles itself.
'use strict';
const fs = require('fs');
const path = require('path');

function maybeStartCpuProfile(thread, env = process.env, log = console.log) {
  const sec = Number(env.SNIPER_CPU_PROF_SEC) || 0;
  if (!(sec > 0)) return false;
  const delay = (Number(env.SNIPER_CPU_PROF_DELAY_SEC) >= 0 ? Number(env.SNIPER_CPU_PROF_DELAY_SEC) : 120) * 1000;
  const dir = env.SNIPER_CPU_PROF_DIR || '/tmp';
  const t = setTimeout(() => {
    let inspector; try { inspector = require('inspector'); } catch (_) { return; }
    const s = new inspector.Session(); s.connect();
    s.post('Profiler.enable', () => s.post('Profiler.start', () => {
      log(`[SNIPER] cpu profile (${thread}) started for ${sec}s`);
      setTimeout(() => s.post('Profiler.stop', (err, res) => {
        if (err || !res) { log(`[SNIPER] cpu profile (${thread}) failed: ${err && err.message}`); return; }
        const f = path.join(dir, `sniper-${thread}-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
        try { fs.writeFileSync(f, JSON.stringify(res.profile)); log(`[SNIPER] cpu profile (${thread}) written ${f}`); } catch (e) { log(`[SNIPER] cpu profile write failed: ${e.message}`); }
        s.disconnect();
      }), sec * 1000);
    }));
  }, delay);
  if (t.unref) t.unref();
  return true;
}

module.exports = { maybeStartCpuProfile };
