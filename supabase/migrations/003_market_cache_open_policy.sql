-- Fix: Supabase auto-enables RLS on every new table, including pt_market_cache.
-- The 001 migration commented "intentionally not RLS" but never disabled it,
-- so RLS was on with no policies, blocking all writes. Engine errors:
--   "new row violates row-level security policy for table pt_market_cache"
--
-- pt_market_cache stores Gamma token-id lookups — public market metadata,
-- not user data. Safe to allow read/write from any team. RLS stays enabled
-- so Supabase doesn't flag the table as insecure; the policy is just open.

alter table pt_market_cache enable row level security;
drop policy if exists "cache_open" on pt_market_cache;
create policy "cache_open" on pt_market_cache for all
  using (true)
  with check (true);
