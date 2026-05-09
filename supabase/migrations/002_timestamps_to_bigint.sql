-- Fix: 001 declared created_at / fetched_at as timestamptz, but the JS engine
-- (Phase 1 IndexedDB) stores them as Unix integers (seconds for created_at,
-- milliseconds for fetched_at). Frontend writes were failing with
-- "date/time field value out of range".
--
-- This script converts the existing columns in-place. Safe to run on a project
-- with existing rows — it casts current timestamptz values to Unix seconds/ms
-- so no data is lost.

alter table teams
  alter column created_at type bigint using extract(epoch from created_at)::bigint,
  alter column created_at set default extract(epoch from now())::bigint;

alter table pt_registry
  alter column created_at type bigint using extract(epoch from created_at)::bigint,
  alter column created_at set default extract(epoch from now())::bigint;

alter table pt_accounts
  alter column created_at type bigint using extract(epoch from created_at)::bigint,
  alter column created_at set default extract(epoch from now())::bigint;

alter table pt_trades
  alter column created_at type bigint using extract(epoch from created_at)::bigint,
  alter column created_at set default extract(epoch from now())::bigint;

-- pt_market_cache stores fetched_at in MILLISECONDS (Date.now() in JS),
-- not seconds — the cache TTL math depends on this.
alter table pt_market_cache
  alter column fetched_at type bigint using (extract(epoch from fetched_at)::bigint * 1000),
  alter column fetched_at set default (extract(epoch from now()) * 1000)::bigint;

-- Done. Try adding a paper trader again — the insert should now succeed.
