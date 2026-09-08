// ─────────────────────────────────────────────────────────────────────────
// rfq-debug.js — TEMPORARY, read-only RFQ capture for diagnosing combo matching.
//
// OFF by default. Does nothing unless the env var RFQ_DEBUG_NEEDLE is set.
// When set (comma-separated substrings), it records the RAW payload of any
// combo RFQ whose legs/collection contain one of those substrings into
// rfq_debug. NFL Combo Locks (2026-09):
//   NESEA,CHICAR,WASPHI,SFLAR,ARILAC,CLEJAC
// MLB-era BOSTOR,BALMIN,HOUSF will not hit current locks.
//
// Wired from live-runner Kalshi WS onEvent. It only READS the incoming
// message and INSERTS a debug row. It never places/cancels/quotes.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

let supa = null;
function client() {
  if (supa) return supa;
  const { createClient } = require('@supabase/supabase-js');
  supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return supa;
}

function pickLegs(m) {
  if (!m || typeof m !== 'object') return null;
  const fields = [
    'mve_selected_legs', 'selected_legs', 'legs', 'mve_legs',
    'mveSelectedLegs', 'selectedLegs',
  ];
  for (const k of fields) {
    if (Array.isArray(m[k]) && m[k].length) return m[k];
  }
  for (const nest of [m.rfq, m.data, m.payload]) {
    if (!nest || typeof nest !== 'object') continue;
    for (const k of fields) {
      if (Array.isArray(nest[k]) && nest[k].length) return nest[k];
    }
  }
  return null;
}

async function captureRfq(env) {
  const raw = process.env.RFQ_DEBUG_NEEDLE;
  if (!raw) return;                                   // disabled unless explicitly turned on
  if (!env || env.type !== 'rfq_created') return;
  const needles = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!needles.length) return;

  const m = env.msg || {};
  const nested = (m.rfq && typeof m.rfq === 'object') ? m.rfq : {};
  const legs = pickLegs(m);
  const collection = m.mve_collection_ticker || m.mveCollectionTicker
    || nested.mve_collection_ticker || nested.mveCollectionTicker || null;
  const isCombo = !!(collection || (Array.isArray(legs) && legs.length > 1));
  if (!isCombo) return;

  const hay = JSON.stringify(legs || '') + '|' + JSON.stringify(collection || '')
    + '|' + JSON.stringify(m.market_ticker || nested.market_ticker || '');
  if (!needles.some((n) => hay.includes(n))) return;

  try {
    await client().from('rfq_debug').insert({
      rfq_id: m.id || m.rfq_id || nested.id || null,
      mve_collection_ticker: collection,
      mve_selected_legs: legs,
      contracts_fp: m.contracts_fp != null ? String(m.contracts_fp)
        : (nested.contracts_fp != null ? String(nested.contracts_fp) : null),
      raw: env,
    });
  } catch (_) { /* debug only — never disrupt the worker */ }
}

module.exports = { captureRfq, pickLegs };
