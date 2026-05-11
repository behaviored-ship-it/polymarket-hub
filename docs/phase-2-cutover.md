# Phase 2 cutover — flipping production from IndexedDB to Supabase

Once the Railway worker is running and writing to Supabase cleanly, the last step is pointing the live `polymarket-hub.vercel.app` site at the Supabase backend. After this, your friend can join the team from any device.

## What changes

| | Before cutover | After cutover |
|---|---|---|
| Data storage | Browser IndexedDB (per-device) | Supabase Postgres (shared via team code) |
| Polling | Browser tab while open | Railway worker, 24/7 |
| Sign-in | None | TeamGate prompts for code on first visit |
| Multi-device | Each browser is its own island | Same data on every device |
| Existing IndexedDB data | Visible | Hidden (still in your browser, just not used) |

## Steps

### 1. Add three env vars in Vercel

Go to **vercel.com** → your `polymarket-hub` project → **Settings** → **Environment Variables**. Add these to the **Production** environment:

| Name | Value |
|---|---|
| `VITE_STORAGE_MODE` | `api` |
| `VITE_SUPABASE_URL` | `https://rcqnuahjwwlovyzjolbd.supabase.co` (your project URL) |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_...` (your **publishable** key, NOT the secret one) |

⚠ Use the **publishable** key here, not the secret. The secret key is only on Railway. Anything starting with `VITE_` ends up in the browser bundle, which means anyone visiting the site can read it — that's safe for the publishable key (it's designed for it) but a leak for the secret.

### 2. Trigger a redeploy

`VITE_*` variables are inlined at build time, so Vercel needs to rebuild for the change to take effect. Two ways:

- **Vercel dashboard**: Deployments tab → latest deployment → ⋯ menu → **Redeploy**
- **Or push any commit**: triggers a new build automatically

Wait ~1 minute for Vercel to finish.

### 3. Verify

Open `polymarket-hub.vercel.app` (use an incognito window if your normal browser has cached old data). Click PAPER:

- ✅ Shows the **TeamGate** with CREATE / JOIN options → cutover worked
- ❌ Shows the registry grid (with old paper traders or empty state) → env vars didn't load — check spelling and redeploy

Click **JOIN TEAM** → paste your team code (e.g. `B4E2NUW`) → you should land in the registry view with all the team's paper traders. The header should show the `team XXXXXX ▾` badge.

### 4. Tell your friend to join

Send them:
- The URL: `polymarket-hub.vercel.app`
- The team code

They click PAPER → JOIN TEAM → paste code → they're in.

## What about old IndexedDB data?

The paper trader you had in IndexedDB before cutover (e.g. the original test wallet) is still in your browser's IndexedDB — it's just not visible because the app reads from Supabase now.

Two options:

- **Re-add the wallet manually** — easiest. The Phase 2 site has full add-trader UI; takes 30 seconds. Stats won't carry over but the worker starts polling immediately.
- **Use the migration tool** (if we build it later — Batch 2.6 was deferred) — would import the old IDB data into Supabase under your team code.

If you wipe browser cache, the IndexedDB data is gone. Not really a loss since Phase 1 was test data anyway.

## Rollback

If something's wrong with Phase 2 and you need to revert:

1. Vercel → Settings → Environment Variables → set `VITE_STORAGE_MODE=idb`
2. Redeploy
3. Site goes back to IndexedDB-only mode (the original Phase 1 behavior)

Your Supabase data is untouched. You can flip back to `api` whenever you're ready.

## After cutover

The Railway worker keeps running on its own. You can:

- Monitor it in Railway → Deployments → View Logs
- See trade activity directly in Supabase: `select * from pt_trades order by opened_at desc limit 20;`
- Pause polling for a specific trader via the UI's PAUSE button (the worker honors `status='active'` only)
