#!/usr/bin/env node
// One-shot: book missed Polymarket Combo Lock maker fills onto combo_fills
// + combo_submissions using the same GetQuotes / GET order / activity
// / position rules as the worker reconcile loop.
//
// Always pages kaygosports TRADE/sold/cashed activity for every lock in
// lookback. Opaque Retail caoc-* slugs join to quote/order/fill ticker
// records — empty marketMetadata.title is not required.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, POLYMARKET_KEY_ID, POLYMARKET_SECRET_KEY
// Optional: TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID
// Optional: BACKFILL_PARLAY_ID (omit = all locks with poly quotes/fills in lookback)
// Optional: BACKFILL_LOOKBACK_HOURS (default 168)
// Optional: BACKFILL_DRY_RUN=1
// Does not deploy.
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { createPolymarketHttp } = require('../polymarket-client');
const { liveRunnerFillRow, claimFillKey } = require('../fills-attr');
const {
  reconcilePolymarketLockFills,
  reconcileLockActivityEvents,
} = require('../polymarket-fill-reconcile');
const { formatAlertStatus } = require('../venue-alert');
const { shortId } = require('../short-id');

const PARLAY_ID = String(process.env.BACKFILL_PARLAY_ID || '').trim();
const HOURS = parseInt(process.env.BACKFILL_LOOKBACK_HOURS || '168', 10);
const LOOKBACK_MS = (Number.isFinite(HOURS) && HOURS > 0 ? HOURS : 168) * 3600 * 1000;
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

function uniqueIds(rows, key) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const id = row && row[key];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function loadLocks(supabase, cutoff) {
  if (PARLAY_ID) {
    const q = await supabase
      .from('combo_parlays')
      .select('id,label,user_id,max_contracts,active,archived_at,created_at')
      .eq('id', PARLAY_ID)
      .maybeSingle();
    if (q.error) throw new Error(q.error.message);
    return q.data ? [q.data] : [];
  }
  const [quotedQ, fillQ] = await Promise.all([
    supabase.from('combo_submissions')
      .select('parlay_id')
      .eq('venue', 'polymarket')
      .not('quote_id', 'is', null)
      .gte('created_at', cutoff)
      .limit(5000),
    supabase.from('combo_fills')
      .select('parlay_id,ticker,raw')
      .eq('is_combo', true)
      .gte('recorded_at', cutoff)
      .limit(2000),
  ]);
  if (quotedQ.error) throw new Error(quotedQ.error.message);
  if (fillQ.error) throw new Error(fillQ.error.message);
  const ids = new Set(uniqueIds(quotedQ.data, 'parlay_id'));
  for (const row of fillQ.data || []) {
    const venue = row && row.raw && row.raw.venue;
    if (row && row.parlay_id && (venue === 'polymarket' || (row.ticker && /^caoc-/i.test(row.ticker)))) {
      ids.add(row.parlay_id);
    }
  }
  if (!ids.size) return [];
  const locksQ = await supabase
    .from('combo_parlays')
    .select('id,label,user_id,max_contracts,active,archived_at,created_at')
    .in('id', [...ids]);
  if (locksQ.error) throw new Error(locksQ.error.message);
  return locksQ.data || [];
}

function lockById(locks) {
  const map = new Map();
  for (const lock of locks || []) {
    if (lock && lock.id) map.set(lock.id, lock);
  }
  return map;
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

  const locks = await loadLocks(supabase, cutoff);
  if (!locks.length) {
    console.error(PARLAY_ID ? `parlay ${PARLAY_ID} not found` : 'no locks with polymarket quotes/fills in lookback');
    process.exit(1);
  }
  const lockIds = locks.map((p) => p.id);
  const locksById = lockById(locks);

  const [subsQ, fillsQ] = await Promise.all([
    supabase.from('combo_submissions')
      .select('id,quote_id,order_id,rfq_id,parlay_id,label,contracts,user_id,status,created_at,venue,market_ticker')
      .in('parlay_id', lockIds)
      .eq('venue', 'polymarket')
      .not('quote_id', 'is', null)
      .gte('created_at', cutoff)
      .limit(5000),
    supabase.from('combo_fills')
      .select('fill_id,count,raw,parlay_id,ticker')
      .in('parlay_id', lockIds)
      .limit(5000),
  ]);
  if (subsQ.error) throw new Error(subsQ.error.message);
  if (fillsQ.error) throw new Error(fillsQ.error.message);

  const allSubs = subsQ.data || [];
  const submissions = allSubs.filter((s) => String(s.status || '').toLowerCase() !== 'filled');
  const existingPoly = (fillsQ.data || []).filter((f) => f.raw && f.raw.venue === 'polymarket');
  const slugRecords = allSubs.concat(
    (fillsQ.data || [])
      .filter((f) => f && f.parlay_id && (f.ticker || (f.raw && f.raw.venue === 'polymarket')))
      .map((f) => ({ ticker: f.ticker, market_ticker: f.ticker, parlay_id: f.parlay_id }))
  );
  console.log(
    `[BACKFILL] locks=${locks.length} unfilled_poly_quotes=${submissions.length} ` +
    `existing_poly_fills=${existingPoly.length} lookback_h=${LOOKBACK_MS / 3600000} dry=${DRY}` +
    (PARLAY_ID ? ` parlay=${PARLAY_ID}` : ' parlay=ALL')
  );

  const alreadyFilledByQuote = {};
  for (const row of fillsQ.data || []) {
    const qid = row.raw && row.raw.quote_id;
    if (qid) alreadyFilledByQuote[qid] = (alreadyFilledByQuote[qid] || 0) + Number(row.count || 0);
    if (row.fill_id) seen.add(row.fill_id);
  }

  const quoteEvents = await reconcilePolymarketLockFills(http, {
    submissions,
    alreadyFilledByQuote,
    allowExecutedWithoutOrder: true,
    maxPerTick: 400,
    hydrate: true,
  });
  console.log(`[BACKFILL] quote/order matches=${quoteEvents.length}`);

  let extra = [];
  try {
    extra = await reconcileLockActivityEvents(http, {
      locks,
      seenFillIds: seen,
      submissions: allSubs,
      slugRecords,
      maxPages: 20,
    });
  } catch (e) {
    console.error('[BACKFILL] activities', e.message);
  }
  console.log(`[BACKFILL] activity/position matches=${extra.length} (always scanned; quote hits do not hide cashouts)`);

  const events = quoteEvents.concat(extra).filter((evt) => claimFillKey(seen, evt.fillId || evt.orderId || evt.quoteId));
  let booked = 0;
  let contracts = 0;
  const byLock = new Map();
  for (const evt of events) {
    const parlayId = evt.parlayId || (evt.pending && evt.pending.parlayId) || PARLAY_ID || null;
    const parlay = (parlayId && locksById.get(parlayId)) || null;
    if (!parlay) {
      console.error(`[BACKFILL] skip unmatched parlay fill_id=${evt.fillId || '?'}`);
      continue;
    }
    const pending = evt.pending || {
      parlayId: parlay.id,
      userId: parlay.user_id,
      contracts: evt.contracts,
      label: parlay.label,
      rfqId: evt.rfqId,
    };
    const fillRow = liveRunnerFillRow({
      quoteId: evt.quoteId,
      orderId: evt.orderId,
      fillId: evt.fillId,
      parlayId: parlay.id,
      count: evt.contracts,
      ticker: evt.marketTicker,
      rfqId: pending.rfqId || evt.rfqId,
      label: parlay.label,
      venue: 'polymarket',
      source: evt.source || 'poly-backfill',
    });
    console.log(
      `[BACKFILL] ${DRY ? 'would book' : 'booking'} fill_id=${fillRow.fill_id} ` +
      `lock=${parlay.label} quote=${evt.quoteId || '—'} order=${evt.orderId || '—'} ` +
      `count=${evt.contracts} src=${evt.source} ticker=${evt.marketTicker || '—'}`
    );
    const summary = `${formatAlertStatus('✅ FILL CONFIRMED', 'polymarket')} — ${parlay.label}\n` +
      `order ${evt.orderId ? shortId(evt.orderId) : '(none)'} · ${evt.fillId || '(no fill id)'}\n` +
      `+${evt.contracts} contracts` +
      (DRY ? ' · dry-run' : ' · booked onto combo_fills');
    if (DRY) {
      booked += 1;
      contracts += Number(evt.contracts) || 0;
      byLock.set(parlay.id, (byLock.get(parlay.id) || 0) + 1);
      continue;
    }
    const { error: fillErr } = await supabase.from('combo_fills').upsert(fillRow, { onConflict: 'fill_id' });
    if (fillErr) {
      console.error('[BACKFILL] combo_fills', fillErr.message);
      continue;
    }
    const stamp = {
      status: 'filled',
      order_id: evt.orderId || evt.fillId,
      is_live: true,
    };
    if (evt.marketTicker) stamp.market_ticker = evt.marketTicker;
    if (evt.quoteId) {
      const { data: updated, error } = await supabase
        .from('combo_submissions')
        .update(stamp)
        .eq('quote_id', evt.quoteId)
        .select('id');
      if (error) console.error('[BACKFILL] stamp submission', error.message);
      if (!updated || !updated.length) {
        const { error: insErr } = await supabase.from('combo_submissions').insert({
          user_id: pending.userId || parlay.user_id,
          parlay_id: parlay.id,
          rfq_id: pending.rfqId || evt.rfqId,
          label: parlay.label,
          contracts: evt.contracts,
          status: 'filled',
          quote_id: evt.quoteId,
          order_id: evt.orderId || evt.fillId,
          is_live: true,
          venue: 'polymarket',
          market_ticker: evt.marketTicker || null,
        });
        if (insErr) console.error('[BACKFILL] insert submission', insErr.message);
      }
    } else {
      const { error: insErr } = await supabase.from('combo_submissions').insert({
        user_id: pending.userId || parlay.user_id,
        parlay_id: parlay.id,
        rfq_id: evt.rfqId,
        label: parlay.label,
        contracts: evt.contracts,
        status: 'filled',
        quote_id: evt.fillId,
        order_id: evt.orderId || evt.fillId,
        is_live: true,
        venue: 'polymarket',
        market_ticker: evt.marketTicker || null,
      });
      if (insErr) console.error('[BACKFILL] insert lock-match submission', insErr.message);
    }
    booked += 1;
    contracts += Number(evt.contracts) || 0;
    byLock.set(parlay.id, (byLock.get(parlay.id) || 0) + 1);
    await sendAlert(summary);
  }

  const lockBits = [...byLock.entries()].map(([id, n]) => {
    const lock = locksById.get(id);
    return `${(lock && lock.label) || id}:${n}`;
  });
  const headline = events.length
    ? `[BACKFILL] ${DRY ? 'would book' : 'booked'} ${booked} Poly fill(s) · +${contracts.toFixed(2)} contracts · ${lockBits.join(' · ') || 'none'}`
    : `[BACKFILL] no Polymarket quote/order/activity/position match across ${locks.length} lock(s)`;
  console.log(headline);
  if (!events.length) {
    console.log(
      '[BACKFILL] evidence: 0 EXECUTED self-quotes with fillable cumQuantity ' +
      'and 0 unique lock-matching trades/cashouts/positions for these keys. ' +
      'Kevin\'s CLE lots (YOU WON $2056.74→$2394.34, CASHED OUT $285.25, ' +
      '$47.58, $4.75 on caoc-1d16e8345207a66c) need kaygosports activity rows + slug map.'
    );
  }
  try { http.close && http.close(); } catch (_) {}
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
