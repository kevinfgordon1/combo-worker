-- Paper market-making tape. Not Combo Locks. Not desk-protect.
-- The worker inserts with SUPABASE_SERVICE_KEY. If this table does not
-- exist, mm-paper-log.js logs once and keeps the JSONL file only.
-- Safe to re-run.

create table if not exists public.mm_paper_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null,
  game_id text,
  venue text,
  team text,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists mm_paper_events_created_at_idx
  on public.mm_paper_events (created_at desc);

create index if not exists mm_paper_events_game_idx
  on public.mm_paper_events (game_id, created_at desc);

alter table public.mm_paper_events enable row level security;

-- No anon/authenticated policies. Service role bypasses RLS. Add a read
-- policy later if a dashboard should see the paper tape.
