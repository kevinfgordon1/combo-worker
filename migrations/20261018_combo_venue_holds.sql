-- Cross-process confirm holds (combo-worker = kalshi, combo-poly = polymarket).
create table if not exists public.combo_venue_holds (
  quote_id   text not null,
  venue      text not null check (venue in ('kalshi','polymarket')),
  parlay_id  text not null,
  contracts  numeric not null default 0,
  meta       jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (venue, quote_id)
);
create index if not exists combo_venue_holds_parlay_idx on public.combo_venue_holds (parlay_id, venue);
alter table public.combo_venue_holds enable row level security; -- service role only

-- Insert this venue's hold and return the other venue's live holds, serialized
-- per lock so two venues confirming at once always see each other.
create or replace function public.combo_venue_claim(
  p_parlay text, p_quote text, p_venue text, p_contracts numeric,
  p_ttl_ms integer default 1800000, p_meta jsonb default null
) returns table (other_held numeric)
language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('combo_cap:' || p_parlay));
  insert into combo_venue_holds (quote_id, venue, parlay_id, contracts, meta)
  values (p_quote, p_venue, p_parlay, greatest(p_contracts, 0), p_meta)
  on conflict (venue, quote_id) do update
    set contracts = excluded.contracts, parlay_id = excluded.parlay_id, updated_at = now();
  return query
    select coalesce(sum(h.contracts), 0)::numeric
    from combo_venue_holds h
    where h.parlay_id = p_parlay and h.venue <> p_venue
      and h.created_at > now() - make_interval(secs => p_ttl_ms / 1000.0);
end $$;
revoke all on function public.combo_venue_claim(text,text,text,numeric,integer,jsonb) from public, anon, authenticated;
