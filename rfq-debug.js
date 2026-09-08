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
// Wired inside kalshi-ws.js on every communications message. Console-only
// by default (Railway logs). Set RFQ_DEBUG_PERSIST=1 to also INSERT
// rfq_debug — skip that while Supabase is 522ing. Never quotes/cancels.
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

const DOLLAR_FIELDS = [
  'target_cost_dollars', 'rfq_target_cost_dollars', 'target_cost', 'cash_order_qty',
];

function pickDollar(m, nested) {
  for (const obj of [m, nested]) {
    if (!obj || typeof obj !== 'object') continue;
    for (const k of DOLLAR_FIELDS) {
      const v = obj[k];
      if (v == null || v === '') continue;
      return v;
    }
  }
  return null;
}

function formatRfqDebugLine({ rfqId, collection, contracts, dollar, legs }) {
  return (
    `[RFQ-DEBUG] rfq=${rfqId} collection=${collection || '(none)'} ` +
    `contracts=${contracts || '(none)'} dollar=${dollar != null && dollar !== '' ? dollar : '(none)'} ` +
    `legs=${JSON.stringify(legs)}`
  );
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

  const rfqId = m.id || m.rfq_id || nested.id || null;
  const contracts = m.contracts_fp != null ? String(m.contracts_fp)
    : (nested.contracts_fp != null ? String(nested.contracts_fp) : null);
  const dollar = pickDollar(m, nested);
  // Railway logs, not Supabase — xuolkiadmumtbksbyjzc 522s must not be the sample path.
  console.log(formatRfqDebugLine({ rfqId, collection, contracts, dollar, legs }));
  if (!/^(1|true|yes)$/i.test(String(process.env.RFQ_DEBUG_PERSIST || ''))) return;

  try {
    await client().from('rfq_debug').insert({
      rfq_id: rfqId,
      mve_collection_ticker: collection,
      mve_selected_legs: legs,
      contracts_fp: contracts,
      raw: env,
    });
  } catch (_) { /* debug only — never disrupt the worker */ }
}

module.exports = { captureRfq, pickLegs, pickDollar, formatRfqDebugLine };
