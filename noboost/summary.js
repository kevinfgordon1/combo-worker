#!/usr/bin/env node
// Report on the no-boost PAPER run from Supabase (noboost_paper_rfqs / noboost_paper_stats).
//   node noboost/summary.js [--since 2026-10-01T00:00:00Z] [--json]
//   (env: SUPABASE_URL, SUPABASE_SERVICE_KEY — e.g. `railway run -s noboost-paper -- node noboost/summary.js`)
// All prices are AMERICAN odds. Money is dollars. Ratios/counts are counts.
'use strict';
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SINCE = arg('since', null);
const AS_JSON = args.includes('--json');
const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('need SUPABASE_URL and SUPABASE_SERVICE_KEY'); process.exit(1); }
const H = { apikey: key, Authorization: `Bearer ${key}` };

async function fetchAll(path) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${url}/rest/v1/${path}&limit=1000&offset=${off}`, { headers: H });
    if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}`);
    const rows = await r.json(); out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
const bucket = (n) => (n <= 3 ? '2-3' : n <= 6 ? '4-6' : n <= 8 ? '7-8' : n <= 10 ? '9-10' : '11+');
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const am = (n) => (n == null ? '-' : n > 0 ? `+${Math.round(n)}` : String(Math.round(n)));
const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const med = (a) => pct(a, 0.5);

(async () => {
  const q = `noboost_paper_rfqs?select=*&order=rfq_created_ts.asc${SINCE ? `&rfq_created_ts=gte.${SINCE}` : ''}`;
  const rows = await fetchAll(q);
  const statsRows = await fetchAll(`noboost_paper_stats?select=created_at,payload${SINCE ? `&created_at=gte.${SINCE}` : ''}&order=created_at.asc`);
  const rep = { rows: rows.length, since: SINCE, by_legs: {}, variants: {} };

  // latency / staleness (per-RFQ rows are persisted only for traded + sampled RFQs; the stats histograms cover ALL)
  const dec = rows.map((r) => Number(r.decision_ms)).filter(Number.isFinite);
  const age = rows.map((r) => r.max_leg_age_ms).filter((x) => x != null);
  const hist = { dec: null, age: null, detect: null };
  if (statsRows.length) {
    const E = statsRows[0].payload.hist_edges;
    const sum = (k) => statsRows.reduce((a, s) => a.map((v, i) => v + ((s.payload[k] || [])[i] || 0)), new Array(E.length + 1).fill(0));
    const pc = (h, p) => { const t = h.reduce((a, b) => a + b, 0); if (!t) return null; let c = 0; for (let i = 0; i < h.length; i += 1) { c += h[i]; if (c >= t * p) return i < E.length ? E[i] : `>${E[E.length - 1]}`; } return null; };
    const mk = (k) => { const h = sum(k); return { n: h.reduce((a, b) => a + b, 0), p50_le: pc(h, 0.5), p99_le: pc(h, 0.99) }; };
    hist.dec = mk('dec_ms'); hist.age = mk('leg_age_ms'); hist.detect = mk('detect_lag_ms');
    rep.seen = statsRows.reduce((a, s) => a + (s.payload.seen || 0), 0);
    rep.out_of_scope = statsRows.reduce((a, s) => a + (s.payload.out_of_scope || 0), 0);
    rep.counts_by_legs = {};
    for (const s of statsRows) for (const [b, c] of Object.entries(s.payload.by_legs || {})) for (const [k, v] of Object.entries(c)) { rep.counts_by_legs[b] = rep.counts_by_legs[b] || {}; rep.counts_by_legs[b][k] = (rep.counts_by_legs[b][k] || 0) + v; }
    rep.last_positions = statsRows[statsRows.length - 1].payload.positions;
  }
  rep.latency = {
    decision_ms_persisted_rows: { n: dec.length, p50: pct(dec, 0.5), p99: pct(dec, 0.99) },
    decision_ms_all_rfqs_histogram_upper_bounds: hist.dec,
    leg_price_age_ms_persisted_rows: { n: age.length, p50: pct(age, 0.5), p99: pct(age, 0.99) },
    leg_price_age_ms_all_rfqs_histogram_upper_bounds: hist.age,
    rfq_detect_lag_ms_histogram_upper_bounds: hist.detect,
  };

  // per-variant results on traded RFQs (taker bought YES, after our RFQ)
  const traded = rows.filter((r) => r.outcome === 'traded');
  for (const [name, beat, fill, pos, act] of [['primary (10% over mid, lock OFF)', 'primary_beat', 'primary_fill', 'primary_position', 'primary_action'], ['counterfactual (lock ON)', 'lock_beat', 'lock_fill', 'lock_position', 'lock_action']]) {
    const v = { traded: traded.length, quoted: 0, wins: 0, ties: 0, fills: 0, cap_blocked: 0, premium: 0, ev_vs_mid: 0, settled: 0, pnl: 0, by_legs: {} };
    for (const r of traded) {
      const b = bucket(r.n_legs); const o = v.by_legs[b] || (v.by_legs[b] = { traded: 0, quoted: 0, wins: 0, fills: 0, ev_vs_mid: 0, pnl: 0, traded_am: [], quote_am: [], mid_am: [], premium_am: [] });
      o.traded += 1;
      const p = r[pos];
      const qa = act === 'primary_action' ? r.quote_primary_american : r.quote_lock_american;
      const qy = act === 'primary_action' ? r.quote_primary_yes : r.quote_lock_yes;
      if (r[act] === 'would_quote') { v.quoted += 1; o.quoted += 1; }
      if (r[beat] === 'win') {
        v.wins += 1; o.wins += 1;
        if (p && p.caps_ok === false) v.cap_blocked += 1;
        o.traded_am.push(r.traded_american); o.quote_am.push(qa); o.mid_am.push(r.fair_mid_american);
        if (r.traded_yes && qy) o.premium_am.push(r.traded_yes / qy - 1);
      } else if (r[beat] === 'tie') v.ties += 1;
      if (r[fill]) {
        v.fills += 1; o.fills += 1; v.premium += p.premium || 0; v.ev_vs_mid += p.ev_vs_mid || 0; o.ev_vs_mid += p.ev_vs_mid || 0;
        const pl = act === 'primary_action' ? r.primary_pnl : r.lock_pnl;
        if (pl != null) { v.settled += 1; v.pnl += Number(pl); o.pnl += Number(pl); }
      }
    }
    v.win_rate_of_quoted = v.quoted ? +(v.wins / v.quoted).toFixed(3) : null;
    v.ev_per_fill_vs_mid = v.fills ? +(v.ev_vs_mid / v.fills).toFixed(2) : null;
    rep.variants[name] = v;
  }
  // exposure: peak from stats snapshots + from fills' running totals
  const peak = (k) => rows.reduce((a, r) => Math.max(a, (r[k] && r[k].total_after) || 0), 0);
  rep.exposure = {
    primary_peak_total_max_loss: peak('primary_position'), lock_peak_total_max_loss: peak('lock_position'),
    primary_peak_game: rows.reduce((a, r) => Math.max(a, (r.primary_position && r.primary_position.top_game_after) || 0), 0),
    primary_peak_selection: rows.reduce((a, r) => Math.max(a, (r.primary_position && r.primary_position.top_selection_after) || 0), 0),
    primary_cap_blocked_wins: rows.filter((r) => r.primary_position && r.primary_position.caps_ok === false).length,
  };

  if (AS_JSON) { console.log(JSON.stringify(rep, null, 1)); return; }
  console.log(`=== NO-BOOST PAPER RUN${SINCE ? ` since ${SINCE}` : ''} — ${rows.length} persisted RFQ rows (traded + 2% sample of untraded) ===`);
  if (rep.seen != null) console.log(`RFQs seen ${rep.seen}, out of scope ${rep.out_of_scope}; in-scope by legs: ${JSON.stringify(rep.counts_by_legs)}`);
  const L = rep.latency;
  console.log(`\n-- Decision latency (RFQ in -> would-quote out; in-memory lookup + multiply + caps) --`);
  console.log(`   persisted rows: p50 ${L.decision_ms_persisted_rows.p50} ms, p99 ${L.decision_ms_persisted_rows.p99} ms (n=${L.decision_ms_persisted_rows.n})`);
  if (hist.dec) console.log(`   all in-scope RFQs (histogram, upper bound): p50 <= ${hist.dec.p50_le} ms, p99 <= ${hist.dec.p99_le} ms (n=${hist.dec.n})`);
  console.log(`-- Leg price staleness at decision --`);
  console.log(`   persisted rows: p50 ${L.leg_price_age_ms_persisted_rows.p50} ms, p99 ${L.leg_price_age_ms_persisted_rows.p99} ms`);
  if (hist.age) console.log(`   all in-scope RFQs (upper bound): p50 <= ${hist.age.p50_le} ms, p99 <= ${hist.age.p99_le} ms`);
  if (hist.detect) console.log(`-- Time from RFQ creation to our poller seeing it (polling; a WS would be ~ms): p50 <= ${hist.detect.p50_le} ms, p99 <= ${hist.detect.p99_le} ms`);
  for (const [name, v] of Object.entries(rep.variants)) {
    console.log(`\n== ${name} ==`);
    console.log(`traded combos observed ${v.traded} | quoted ${v.quoted} | would WIN (strictly cheaper than print) ${v.wins} (+${v.ties} ties) | win rate of quoted ${v.win_rate_of_quoted}`);
    console.log(`simulated fills (within caps) ${v.fills}, cap-blocked wins ${v.cap_blocked} | premium ${money(v.premium)} | expected profit vs mid ${money(v.ev_vs_mid)} (${v.ev_per_fill_vs_mid == null ? '-' : money(v.ev_per_fill_vs_mid)}/fill) | settled ${v.settled}, realized P&L ${money(v.pnl)}`);
    console.log('legs | traded | quoted | wins | fills | median traded | median our quote | median true mid | median taker premium over our quote | EV vs mid | settled P&L');
    for (const b of ['2-3', '4-6', '7-8', '9-10', '11+']) {
      const o = v.by_legs[b]; if (!o) continue;
      console.log(`${b} | ${o.traded} | ${o.quoted} | ${o.wins} | ${o.fills} | ${am(med(o.traded_am))} | ${am(med(o.quote_am))} | ${am(med(o.mid_am))} | ${o.premium_am.length ? `${(med(o.premium_am) * 100).toFixed(0)}% of price` : '-'} | ${money(o.ev_vs_mid)} | ${money(o.pnl)}`);
    }
  }
  console.log(`\n== Exposure (simulated, primary) vs caps ==`);
  console.log(`peak total max-loss ${money(rep.exposure.primary_peak_total_max_loss)} | peak per-game ${money(rep.exposure.primary_peak_game)} | peak per-team ${money(rep.exposure.primary_peak_selection)} | wins blocked by caps ${rep.exposure.primary_cap_blocked_wins}`);
  if (rep.last_positions) console.log(`latest snapshot: ${JSON.stringify(rep.last_positions)}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
