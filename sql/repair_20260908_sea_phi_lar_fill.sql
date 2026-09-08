-- One-shot: 2026-09-08 ~11:34 AM ET SEA/PHI/LAR Combo Lock fill.
-- Kalshi confirmed ~98 contracts (Telegram quoted 105 @ +290, order …cd403,
-- quote …52a8e1). fills-reader stored the fill unattributed because the ticker
-- is KXMVECROSSCATEGORY0-SHARD1-… (no KXMVESPORTSMULTIGAMEEXTENDED match) and
-- +280 / +290 no_bids are within a cent of $0.74. live-runner FILL CONFIRMED
-- did not stamp combo_submissions (status stayed unfilled, order_id null).
--
-- Safe: exact fill_id / submission id; no-ops if already repaired.
-- Combo Locks UI keys Filled off combo_fills.parlay_id and History off
-- combo_submissions status=filled + order_id.
--
-- Run in the Supabase SQL editor, or:
--   supabase db query -f sql/repair_20260908_sea_phi_lar_fill.sql

update public.combo_fills
set parlay_id = '2a01055d-4fcb-446e-be1b-19e98984ca3c'
where fill_id = '07228709-6229-8235-5047-44b3103ff56b'
  and parlay_id is null;

update public.combo_submissions
set status = 'filled',
    order_id = '01a081a8-4a08-7823-a57f-2273007cd403',
    is_live = true
where id = 'bfde99f4-1b12-4244-a84e-a706b439a108'
  and order_id is null
  and status <> 'filled';
