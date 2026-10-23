-- Manual sportsbook hedges (arb-outs) of Combo Sniper fills. ADDITIVE ONLY: new table, nothing
-- existing reads it until 20261023f (caps) is applied. Service role only (RLS on, no client
-- policies), same as sniper_ledger; the site writes it through /api/sniper-hedges (Kevin only).
create table if not exists public.sniper_hedges (
  id uuid primary key default gen_random_uuid(),
  rfq_id text not null references public.sniper_ledger(rfq_id) on delete cascade,
  book text not null check (length(book) between 1 and 40),
  american integer not null check (american >= 100 or american <= -100),
  stake numeric not null check (stake > 0 and stake <= 100000),
  placed_at timestamptz not null default now(),
  notes text check (notes is null or length(notes) <= 500),
  status text not null default 'active' check (status in ('active', 'void')),
  source text,           -- 'book_arb' when pre-filled from the arb suggestion, else 'manual'
  created_by text,       -- auth user id (owner)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sniper_hedges_rfq_idx on public.sniper_hedges (rfq_id) where status = 'active';
alter table public.sniper_hedges enable row level security;   -- service role only; no client policies
revoke all on table public.sniper_hedges from anon, authenticated;
