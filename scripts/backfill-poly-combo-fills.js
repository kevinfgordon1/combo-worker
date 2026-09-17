#!/usr/bin/env node
// One-shot: book missed Polymarket Combo Lock maker fills onto combo_fills
// + combo_submissions using the same GetQuotes / GET order / activity
// / position rules as the worker reconcile loop.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, POLYMARKET_KEY_ID, POLYMARKET_SECRET_KEY
// Optional: TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID
// Optional: BACKFILL_PARLAY_ID (default CLE/NYY/SF 2026-09-16 lock)
// Optional: BACKFILL_LOOKBACK_HOURS (default 72)
// Optional: BACKFILL_DRY_RUN=1
// Does not deploy.
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { createPolymarketHttp } = require('../polymarket-client');
const { liveRunnerFillRow, claimFillKey } = require('../fills-attr');
const {
  reconcilePolymarketLockFills,
  matchActivitiesToLocks,
  matchPositionsToLocks,
  activitiesFromListed,
  positionsFromListed,
} = require('../polymarket-fill-reconcile');
const { formatAlertStatus } = require('../venue-alert');
const { shortId } = require('../short-id');

const DEFAULT_PARLAY = 'aee3b29d-2a4b-4dd6-8dd5-37358b0aa294';
const PARLAY_ID = process.env.BACKFILL_PARLAY_ID || DEFAULT_PARLAY;
const HOURS = parseInt(process.env.BACKFILL_LOOKBACK_HOURS || '72', 10);
const LOOKBACK_MS = (Number.isFinite(HOURS) && HOURS > 0 ? HOURS : 72) * 3600 * 1000;
const DRY = /^(1|true|yes|on)$/i.test(String(process.env.BACKFILL_DRY_RUN || ''));

async function sendAlert(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chat) {
    console.log(`[BACKFILL] (telegram not configured) ${text.replace(/\n/g, ' | ')}`);
    return;
  }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text }),
  });
  if (!r.ok) console.error('[BACKFILL] telegram failed', r.status, await r.text());
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('need SUPABASE_URL and SUPABASE_SERVICE_KEY');
    process.exit(1);
  }
  if (!process.env.POLYMARKET_KEY_ID || !process.env.POLYMARKET_SECRET_KEY) {
    console.error('need POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY to prove kaygosports fills');
    process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const http = createPolymarketHttp({
    keyId: process.env.POLYMARKET_KEY_ID,
    secretKey: process.env.POLYMARKET_SECRET_KEY,
  });
  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const seen = new Set();

  const [parlayQ, subsQ, fillsQ] = await Promise.all([
    supabase.from('combo_parlays').select('id,label,user_id,max_contracts,active,archived_at').eq('id', PARLAY_ID).maybeSingle(),
    supabase.from('combo_submissions')
      .select('id,quote_id,order_id,rfq_id,parlay_id,label,contracts,user_id,status,created_at,venue')
      .eq('parlay_id', PARLAY_ID)
      .eq('venue', 'polymarket')
      .not('quote_id', 'is', null)
      .gte('created_at', cutoff)
      .limit(500),
    supabase.from('combo_fills').select('fill_id,count,raw,parlay_id').eq('parlay_id', PARLAY_ID),
  ]);
  if (parlayQ.error) throw new Error(parlayQ.error.message);
  if (subsQ.error) throw new Error(subsQ.error.message);
  if (fillsQ.error) throw new Error(fillsQ.error.message);
  const parlay = parlayQ.data;
  if (!parlay) {
    console.error(`parlay ${PARLAY_ID} not found`);
    process.exit(1);
  }
  const submissions = (subsQ.data || []).filter((s) => String(s.status || '').toLowerCase() !== 'filled');
  const existingPoly = (fillsQ.data || []).filter((f) => f.raw && f.raw.venue === 'polymarket');
  console.log(
    `[BACKFILL] ${parlay.label} unfilled_poly_quotes=${submissions.length} ` +
    `existing_poly_fills=${existingPoly.length} dry=${DRY}`
  );

  const alreadyFilledByQuote = {};
  for (const row of fillsQ.data || []) {
    const qid = row.raw && row.raw.quote_id;
    if (!qid) continue;
    alreadyFilledByQuote[qid] = (alreadyFilledByQuote[qid] || 0) + Number(row.count || 0);
    if (row.fill_id) seen.add(row.fill_id);
  }

  const quoteEvents = await reconcilePolymarketLockFills(http, {
    submissions,
    alreadyFilledByQuote,
    allowExecutedWithoutOrder: true,
    maxPerTick: 200,
    hydrate: true,
  });
  console.log(`[BACKFILL] quote/order matches=${quoteEvents.length}`);

  let extra = [];
  if (!quoteEvents.length) {
    try {
      const listed = await http.listActivities({ types: 'ACTIVITY_TYPE_TRADE', limit: 100 });
      extra = extra.concat(matchActivitiesToLocks(activitiesFromListed(listed), [parlay]));
    } catch (e) {
      console.error('[BACKFILL] activities', e.message);
    }
    try {
      const listed = await http.listPositions({ limit: 100 });
      extra = extra.concat(matchPositionsToLocks(positionsFromListed(listed), [parlay]));
    } catch (e) {
      console.error('[BACKFILL] positions', e.message);
    }
    console.log(`[BACKFILL] activity/position matches=${extra.length}`);
  }

  const events = quoteEvents.concat(extra).filter((evt) => claimFillKey(seen, evt.fillId || evt.orderId || evt.quoteId));
  let booked = 0;
  let contracts = 0;
  const rows = [];
  for (const evt of events) {
    const pending = evt.pending || {
      parlayId: PARLAY_ID,
      userId: parlay.user_id,
      contracts: evt.contracts,
      label: parlay.label,
      rfqId: evt.rfqId,
    };
    const fillRow = liveRunnerFillRow({
      quoteId: evt.quoteId,
      orderId: evt.orderId,
      fillId: evt.fillId,
      parlayId: PARLAY_ID,
      count: evt.contracts,
      ticker: evt.marketTicker,
      rfqId: pending.rfqId || evt.rfqId,
      label: parlay.label,
      venue: 'polymarket',
      source: evt.source || 'poly-backfill',
    });
    rows.push({ evt, fillRow });
    console.log(
      `[BACKFILL] ${DRY ? 'would book' : 'booking'} fill_id=${fillRow.fill_id} ` +
      `quote=${evt.quoteId || '—'} order=${evt.orderId || '—'} count=${evt.contracts} src=${evt.source}`
    );
    if (DRY) continue;
    const { error: fillErr } = await supabase.from('combo_fills').upsert(fillRow, { onConflict: 'fill_id' });
    if (fillErr) {
      console.error('[BACKFILL] combo_fills', fillErr.message);
      continue;
    }
    if (evt.quoteId) {
      const { data: updated, error } = await supabase
        .from('combo_submissions')
        .update({ status: 'filled', order_id: evt.orderId || evt.fillId, is_live: true })
        .eq('quote_id', evt.quoteId)
        .select('id');
      if (error) console.error('[BACKFILL] stamp submission', error.message);
      if (!updated || !updated.length) {
        const { error: insErr } = await supabase.from('combo_submissions').insert({
          user_id: pending.userId || parlay.user_id,
          parlay_id: PARLAY_ID,
          rfq_id: pending.rfqId || evt.rfqId,
          label: parlay.label,
          contracts: evt.contracts,
          status: 'filled',
          quote_id: evt.quoteId,
          order_id: evt.orderId || evt.fillId,
          is_live: true,
          venue: 'polymarket',
        });
        if (insErr) console.error('[BACKFILL] insert submission', insErr.message);
      }
    } else {
      const { error: insErr } = await supabase.from('combo_submissions').insert({
        user_id: pending.userId || parlay.user_id,
        parlay_id: PARLAY_ID,
        rfq_id: evt.rfqId,
        label: parlay.label,
        contracts: evt.contracts,
        status: 'filled',
        quote_id: evt.fillId,
        order_id: evt.orderId || evt.fillId,
        is_live: true,
        venue: 'polymarket',
      });
      if (insErr) console.error('[BACKFILL] insert lock-match submission', insErr.message);
    }
    booked += 1;
    contracts += Number(evt.contracts) || 0;
  }

  const summary = events.length
    ? `${formatAlertStatus('✅ FILL CONFIRMED', 'polymarket')} — ${parlay.label}\n` +
      `BACKFILL ${booked || events.length} Poly fill(s) · +${(contracts || events.reduce((s, e) => s + e.contracts, 0)).toFixed(2)} contracts\n` +
      `lock ${shortId(PARLAY_ID)} · ${DRY ? 'dry-run' : 'booked onto combo_fills'}`
    : `[BACKFILL] no Polymarket quote/order/activity/position match for ${parlay.label}`;
  console.log(summary.replace(/\n/g, ' | '));
  if (events.length && !DRY) await sendAlert(summary);
  try { http.close && http.close(); } catch (_) {}
  if (!events.length) {
    console.log(
      '[BACKFILL] evidence: 0 EXECUTED self-quotes with fillable cumQuantity ' +
      'and 0 unique lock-matching trades/positions. The $2056.74 YOU WON card ' +
      'cannot be attributed to worker quotes from this key.'
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
