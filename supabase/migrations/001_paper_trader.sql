-- Polymarket Hub — Paper Trader schema
-- Phase 2: shared team-code model. Every row is scoped by team_id.
-- Run once in your Supabase SQL editor (Database → SQL Editor → New query).
--
-- All tables use team-code-based RLS. Frontend sends `x-team-code` header on
-- every request; the policy compares it against the `teams.code` column.
-- The worker uses the SERVICE ROLE KEY which bypasses RLS — it can read/write
-- any team's rows.

-- ─── 1. teams ──────────────────────────────────────────────────────────────
create table if not exists teams (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null check (length(code) between 6 and 12),
  name        text,
  created_at  bigint not null default extract(epoch from now())::bigint
);
create index if not exists teams_code_idx on teams(code);

-- ─── 2. pt_registry ─────────────────────────────────────────────────────────
create table if not exists pt_registry (
  id                          uuid primary key default gen_random_uuid(),
  team_id                     uuid not null references teams(id) on delete cascade,
  wallet_addr                 text not null,
  nickname                    text,
  start_balance               numeric not null,

  -- Sizing
  sizing_mode                 text not null default 'fixed',
  fixed_amt                   numeric,
  pct_amt                     numeric,
  multiplier                  numeric default 1,

  -- Trade settings
  copy_mode                   text not null default 'buys_only',
  new_markets_only            boolean default false,
  safety_cap                  numeric,
  max_trades_day              int,

  -- Trade size filter
  min_trade_size              numeric,
  max_trade_size              numeric,
  min_price                   numeric,
  max_price                   numeric,

  -- Position & budget limits
  per_question_cap            numeric,
  per_event_cap               numeric,
  max_events_open             int,
  total_budget                numeric,
  daily_loss_limit            numeric,
  weekly_loss_limit           numeric,
  lifetime_loss_limit         numeric,

  -- Per-position risk (each: { enabled: bool, pct: number | null })
  per_position_stop_loss      jsonb default '{"enabled":false,"pct":null}'::jsonb,
  per_position_take_profit    jsonb default '{"enabled":false,"pct":null}'::jsonb,
  per_position_trailing_stop  jsonb default '{"enabled":false,"pct":null}'::jsonb,

  -- Auto-pause (trader-wide): { lossPct, lossUsd, profitPct, profitUsd }
  auto_pause                  jsonb default '{"lossPct":null,"lossUsd":null,"profitPct":null,"profitUsd":null}'::jsonb,

  -- Slippage tolerance per price tier (mirror GodEye 18c/40c boundaries)
  slippage_tolerance          jsonb default '{"above40c":4,"between18_40c":10,"below18c":25}'::jsonb,

  -- Blocklist
  blocked_categories          text[] default '{}',
  blocked_markets             text[] default '{}',

  -- State
  status                      text not null default 'active'
                              check (status in ('active','paused','stopped')),
  pause_reason                text,
  last_poll_ts                bigint default 0,
  created_at                  bigint not null default extract(epoch from now())::bigint
);
create index if not exists pt_registry_team_idx on pt_registry(team_id, status);
create index if not exists pt_registry_wallet_idx on pt_registry(wallet_addr);

-- ─── 3. pt_accounts ─────────────────────────────────────────────────────────
create table if not exists pt_accounts (
  registry_id   uuid primary key references pt_registry(id) on delete cascade,
  cash          numeric not null,
  peak_balance  numeric not null,
  created_at    timestamptz not null default now()
);

-- ─── 4. pt_trades ───────────────────────────────────────────────────────────
create table if not exists pt_trades (
  id                  text primary key,
  registry_id         uuid not null references pt_registry(id) on delete cascade,
  team_id             uuid not null references teams(id) on delete cascade,
  condition_id        text not null,
  token_id            text,
  title               text,
  category            text,
  outcome             text,
  entry_price         numeric,
  stake               numeric,
  shares              numeric,
  fee                 numeric,
  slippage_bps        numeric,
  midpoint_at_fill    numeric,
  levels_filled       int,
  is_partial          boolean default false,
  leader_stake        numeric,
  leader_price        numeric,
  leader_trade_ts     bigint,
  opened_at           bigint not null,
  poll_delay_ms       int,
  date_et             text,
  hour_et             int,
  status              text not null check (status in ('filled','resolved','skipped')),
  skip_reason         text,
  is_permanent_skip   boolean,
  exit_price          numeric,
  result              text check (result in ('win','loss') or result is null),
  pnl                 numeric,
  resolved_at         bigint,
  created_at          bigint not null default extract(epoch from now())::bigint
);
create index if not exists pt_trades_registry_idx on pt_trades(registry_id, opened_at desc);
create index if not exists pt_trades_team_idx on pt_trades(team_id);

-- ─── 5. pt_positions ────────────────────────────────────────────────────────
create table if not exists pt_positions (
  id                   text primary key,
  registry_id          uuid not null references pt_registry(id) on delete cascade,
  team_id              uuid not null references teams(id) on delete cascade,
  condition_id         text not null,
  token_id             text,
  title                text,
  outcome              text,
  shares               numeric,
  avg_entry_price      numeric,
  total_cost           numeric,
  realized_pnl         numeric default 0,
  peak_unrealized_pct  numeric default 0,
  is_resolved          boolean default false,
  resolved_at          bigint,
  resolved_price       numeric,
  resolution_source    text,
  cur_price            numeric,
  last_price_ts        bigint
);
create index if not exists pt_positions_registry_idx on pt_positions(registry_id, is_resolved);
create unique index if not exists pt_positions_unique_idx on pt_positions(registry_id, condition_id, outcome);

-- ─── 6. pt_market_cache (shared across all teams) ──────────────────────────
create table if not exists pt_market_cache (
  cache_key   text primary key,
  data        jsonb not null,
  fetched_at  bigint not null default (extract(epoch from now()) * 1000)::bigint,
  ttl_sec     int
);

-- ─── 7. RLS — team-code-based row scoping ──────────────────────────────────
-- Helper function: extract team_id from the request header `x-team-code`.
-- The frontend sets this header on every Supabase REST call.
create or replace function current_team_id() returns uuid as $$
  select id from teams
  where code = nullif(
    current_setting('request.headers', true)::json->>'x-team-code',
    ''
  );
$$ language sql stable;

alter table pt_registry  enable row level security;
alter table pt_accounts  enable row level security;
alter table pt_trades    enable row level security;
alter table pt_positions enable row level security;
alter table teams        enable row level security;

-- A team is visible to anyone holding its code (so the frontend can verify
-- a code on join). New teams can be created freely (no auth gate).
drop policy if exists "team_visible_by_code" on teams;
create policy "team_visible_by_code" on teams for select
  using (code = nullif(current_setting('request.headers', true)::json->>'x-team-code', ''));
drop policy if exists "team_create_open" on teams;
create policy "team_create_open" on teams for insert with check (true);

drop policy if exists "team_scope" on pt_registry;
create policy "team_scope" on pt_registry  for all
  using (team_id = current_team_id())
  with check (team_id = current_team_id());

drop policy if exists "team_scope" on pt_accounts;
create policy "team_scope" on pt_accounts  for all
  using (registry_id in (select id from pt_registry where team_id = current_team_id()))
  with check (registry_id in (select id from pt_registry where team_id = current_team_id()));

drop policy if exists "team_scope" on pt_trades;
create policy "team_scope" on pt_trades    for all
  using (team_id = current_team_id())
  with check (team_id = current_team_id());

drop policy if exists "team_scope" on pt_positions;
create policy "team_scope" on pt_positions for all
  using (team_id = current_team_id())
  with check (team_id = current_team_id());

-- pt_market_cache is intentionally NOT RLS — token IDs are public market data
-- and shared across all teams to avoid duplicate Gamma fetches.

-- ─── DONE. Verify with: select count(*) from teams; (should be 0) ──────────
