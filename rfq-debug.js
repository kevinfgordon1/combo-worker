// ─────────────────────────────────────────────────────────────────────────
// rfq-debug.js — TEMPORARY, read-only RFQ capture for diagnosing combo matching.
//
// OFF by default. Does nothing unless the env var RFQ_DEBUG_NEEDLE is set.
// When set (comma-separated substrings, e.g. "BOSTOR,BALMIN,HOUSF"), it records
// the RAW payload of any combo RFQ whose legs/collection contain one of those
// substrings into the rfq_debug table — so we can see exactly what Kalshi sends.
//
// It only READS the incoming message and INSERTS a debug row. It places,
// cancels, or modifies NOTHING, and it never touches the order path.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

let supa = null;
function client() {
  if (supa) return supa;
  const { createClient } = require('@supabase/supabase-js');
  supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return supa;
}

async function captureRfq(env) {
  const raw = process.env.RFQ_DEBUG_NEEDLE;
  if (!raw) return;                                   // disabled unless explicitly turned on
  if (!env || env.type !== 'rfq_created') return;
  const needles = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!needles.length) return;

  const m = env.msg || {};
  const legs = m.mve_selected_legs || m.selected_legs || null;
  const isCombo = !!(m.mve_collection_ticker || (Array.isArray(legs) && legs.length > 1));
  if (!isCombo) return;

  const hay = JSON.stringify(legs || '') + '|' + JSON.stringify(m.mve_collection_ticker || '');
  if (!needles.some((n) => hay.includes(n))) return;  // only combos related to your games

  try {
    await client().from('rfq_debug').insert({
      rfq_id: m.id || m.rfq_id || null,
      mve_collection_ticker: m.mve_collection_ticker || null,
      mve_selected_legs: legs,
      contracts_fp: m.contracts_fp != null ? String(m.contracts_fp) : null,
      raw: env,
    });
  } catch (_) { /* debug only — never disrupt the worker */ }
}

module.exports = { captureRfq };
