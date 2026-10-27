-- Canonical game schedule (one source of truth for start times). Run once in the Supabase SQL editor.
-- Written by combo-worker's schedule sync (service role); read by aibetbuilder (needle, Combo Locks, Promo) and the sniper.
create table if not exists public.game_schedule (
  league          text        not null,               -- NFL, NCAAF, NBA, WNBA, NHL, MLB, MLS, EPL, NCAAMB
  espn_id         text        not null,
  sport           text        not null,               -- football, basketball, hockey, baseball, soccer
  start_time_utc  timestamptz not null,
  time_valid      boolean     not null default true,  -- false = ESPN lists the date but time is TBD
  et_date         date        not null,               -- America/New_York calendar date of start_time_utc
  home_abbr       text        not null,
  away_abbr       text        not null,
  home_name       text,
  away_name       text,
  home_location   text,
  away_location   text,
  state           text,                               -- pre | in | post
  status          text,                               -- STATUS_SCHEDULED, STATUS_POSTPONED, ...
  sources         text[]      not null default '{espn}',
  confidence      text        not null default 'official', -- official | official_disputed | date_only
  disagreement_min integer,                           -- worst |venue − official| in minutes, when known
  previous_start_utc timestamptz,                     -- last different start (time change / postponement)
  first_seen      timestamptz not null default now(),
  last_verified   timestamptz not null default now(),
  primary key (league, espn_id)
);
create index if not exists game_schedule_date_idx on public.game_schedule (league, et_date);
create index if not exists game_schedule_start_idx on public.game_schedule (start_time_utc);

alter table public.game_schedule enable row level security;
-- Schedule is public sports data: anyone signed in may read; only the service role writes.
drop policy if exists game_schedule_read on public.game_schedule;
create policy game_schedule_read on public.game_schedule for select to anon, authenticated using (true);
