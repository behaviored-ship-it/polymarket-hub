# Supabase setup — Phase 2 paper trader

**Status:** schema written, NOT yet applied. Frontend still uses IndexedDB until the worker + paperApi.js batches land.

This directory holds the Supabase migrations for the Phase 2 always-on paper trader. Run these once when you're ready to start Phase 2.

## What you need first

1. A Supabase project (free tier is fine — sign in at https://supabase.com → New Project)
2. The project's **URL** and **anon key** (Project Settings → API)
3. The project's **service role key** (same screen, "Reveal" — needed by the worker, never expose to frontend)

## How to apply the migration

**Option A — Supabase dashboard (recommended for first time):**

1. Open your project's Supabase dashboard
2. Database → SQL Editor → New query
3. Paste the contents of `migrations/001_paper_trader.sql`
4. Click "Run"
5. Verify: `select count(*) from teams;` should return `0`

**Option B — Supabase CLI:**

```bash
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

## What the schema gives you

Six tables:
- `teams` — the shared bucket. One row per team code.
- `pt_registry` — paper trader configs (one per wallet you're shadowing). All settings from the GodEye spec.
- `pt_accounts` — current cash balance per paper trader.
- `pt_trades` — append-only audit log of every fill + every skip with reason.
- `pt_positions` — current open + resolved positions, weighted-average entry price.
- `pt_market_cache` — shared token-id cache across all teams.

Plus row-level-security policies that filter every team-scoped query by an `x-team-code` header. The frontend sends that header on every Supabase REST call so your team's rows are invisible to other teams.

## Once applied

Continue with Phase 2 batches per [polyhub-paper-trader-buildspec.md §15.10](../../polyhub-paper-trader-buildspec.md):

- 2.2 — Build `src/paper/paperApi.js` to replace `usePaperDB.js`
- 2.3 — Add `TeamGate.jsx` so the app prompts for a team code on first visit
- 2.4 — Stand up the Python worker on Railway (talks to Supabase via service-role key)
- 2.5 — Worker polling loop ported from the JS engine
- 2.6 — In-app migration tool: import existing IndexedDB data to Supabase

## Rollback

If you need to wipe the schema and start over:

```sql
drop table if exists pt_positions cascade;
drop table if exists pt_trades cascade;
drop table if exists pt_accounts cascade;
drop table if exists pt_registry cascade;
drop table if exists pt_market_cache cascade;
drop table if exists teams cascade;
drop function if exists current_team_id;
```

This destroys all Phase 2 data. The Phase 1 IndexedDB version is untouched.
