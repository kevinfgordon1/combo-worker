-- Same as migrations/20260925_mm_paper_events.sql.
-- Run in the Supabase SQL editor. Paper mode keeps working from the
-- JSONL log if you skip this.

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
