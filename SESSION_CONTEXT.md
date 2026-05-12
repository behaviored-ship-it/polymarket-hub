# Session context — Paper Trader build (2026-05-11)

Recovered from session `local_4a673687…` after the conversation hit an API image-size limit and could no longer accept new messages. This is a recap of what shipped, where things stand, and the one open bug at the end of the session.

## What was built this session

### Phase 1 — Paper Trader (IndexedDB, browser-only)
- New `paper-trader` branch on the polymarket-hub repo.
- Node / npm / vitest installed and verified.
- Core modules written: `constants.js`, `usePaperDB.js`, `useFillSimulator.js` and tests.
- Full PAPER tab UI: registry grid (ROI-sorted cards), detail view with Overview / Trade Comparison / Positions / Settings sub-tabs.
- Engine: 30s polling of leader wallet, 23-guard copy logic, 60s resolution sweep, exact Polymarket fee formula, slippage tiers, auto-pause, blocklist, loss limits, per-position SL/TP/trailing.
- All data persisted to IndexedDB; one browser = one island.
- Merged to `main` (option A — single ship, no PK / multi-trader gating).
- See `docs/paper-trader-guide.md` for the user-facing walkthrough.

### Phase 2 — Supabase + Railway cutover (shared backend)
- Spun up a fresh Supabase project: `rcqnuahjwwlovyzjolbd`.
- SQL migrations applied (with RLS). Resolved along the way:
  - `42601` syntax error in initial migration → fixed.
  - `42804` default-for-column type mismatch → fixed.
  - `date/time field value out of range` on a seed insert → fixed.
  - RLS policy rejecting first insert → policy adjusted, then "Success. No rows returned".
- Supabase API keys captured:
  - Publishable key: `sb_publishable_IjheYJQSc4H5lT5nwb3QnQ_vd2r-oEV` (browser-safe, used as `VITE_SUPABASE_ANON_KEY`).
  - Secret key: stays on Railway only (never `VITE_*`).
- Project URL: `https://rcqnuahjwwlovyzjolbd.supabase.co`.
- Railway worker deployed (Metal builder build) and polling.
- Vercel cutover steps documented in `docs/phase-2-cutover.md` — `VITE_STORAGE_MODE=api`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, redeploy, verify TeamGate appears.
- Team model: shared 6-char code, full read/write across the team. Schema already has a `team_id` column ready to convert to `user_id` if/when real auth is added.
- Verified working in an incognito tab; an API error showed in the normal tab but cleared after redeploy.

### Tests on live data
- Added a real wallet, waited; the copy-results table wasn't spamming, which we read as "worker is running, just no fills yet."
- Then the bug below surfaced.

## Shipped 2026-05-12 — confirmed working in production

PR merged. Railway redeployed. Sweep cleared the entire backlog: all 156 stuck open positions resolved on the first pass. Dashboard now reflects real state, and the ranking system unlocked (was gated by `RANK_MIN_RESOLVED = 5` resolved positions per trader — see [src/paper/constants.js](src/paper/constants.js)).

## Root cause + fix — Gamma `closed=true` filter

**Root cause:** Polymarket's Gamma `/markets` endpoint excludes resolved markets by default. The wallet under test trades almost exclusively the 5-minute "Bitcoin Up or Down" markets, which resolve within minutes and immediately drop off the default query. So `fetch_gamma_resolution` got `[]` back from Gamma → returned `None` → resolver fell through to `{"resolved": False}` for every single sweep. The leader had also long since redeemed those positions, so the primary `redeemable` path returned nothing either. Result: 156 stuck open out of 189, growing by ~6/hour.

**Confirmation:** logs from the Railway worker showed scheduler + sweep both running, with plenty of `BUY Bitcoin Up or Down` lines but zero `WIN`/`LOSS`/`RESOLVED` lines in 24h. A direct `curl` against `gamma-api.polymarket.com/markets?condition_ids=…` returned `[]` for a known-resolved 5-min market; adding `&closed=true` returned the full market with `outcomePrices=["1","0"]` and `outcomes=["Up","Down"]`.

**Fix:** [worker/worker/polymarket_api.py](worker/worker/polymarket_api.py) and [src/paper/api.js](src/paper/api.js) — `fetch_gamma_resolution` / `fetchGammaResolution` now retry with `closed=true` when the default query returns nothing. `fetch_gamma_market_raw` / `fetchGammaMarketRaw` gained a `closed` kwarg; the live-market token-ID lookup (`fetch_token_ids_uncached`) still uses the default query.

**Verified locally** by calling `fetch_gamma_resolution` on the stuck conditionId and feeding the result into `resolve_position`: returns `{resolved: True, price: 1.0, source: 'outcomePrices'}` for `Up`, `{resolved: True, price: 0.0}` for `Down`.

**Deploy steps:**
1. Commit the changes to `paper-trader` (or `main`).
2. Push — Railway redeploys the worker; Vercel rebuilds the frontend.
3. Within ~60s of the worker restart, the resolution sweep starts clearing the 156 stuck positions. Watch Railway logs for the `WIN`/`LOSS` lines.
4. No DB backfill needed — the existing sweep handles them.

**Previous (now stale) writeup of the issue is preserved below for context.**

---

## Original open issue (now fixed)

**"It says there are 4 open positions but they should all be closed."**

The Open Positions count (registry card stat + Positions tab `Open (n)` pill) is showing 4, but every one of those markets has resolved. Code audit on 2026-05-12 narrowed it to three plausible causes — the diagnostic below tells us which.

Code reviewed and ruled out:
- Snake/camel translation is correct on both sides (`worker/worker/supabase_client.py` and `src/paper/paperApi.js`).
- Frontend filters consistently on `isResolved` in both the registry-card stats (`src/paper/usePTStats.js`) and the Positions tab (`src/paper/PaperPositions.jsx`).
- Resolver logic in JS (`src/paper/resolvePosition.js`) and Python (`worker/worker/resolver.py`) is identical.

Three plausible causes that remain:
1. **Railway worker's resolution sweep is silently failing** — `resolve_open_for_registry` in `worker/worker/executor.py` either isn't being scheduled, or its writes are dropping. Check Railway → Deployments → View Logs for `resolution failed` lines.
2. **Markets are still genuinely live on Polymarket** — leader sold but we hold to resolution (documented buys-only). Working as designed; the user expectation is the bug, not the code.
3. **Gamma `outcomePrices` isn't populated** for the conditionId in question — resolver returns `resolved: false`. Common for unusual or delisted markets.

### Diagnostic — run this first

A self-contained module exists at [worker/worker/diagnose.py](worker/worker/diagnose.py). It walks every open position, runs the same resolver the scheduler uses, and prints a per-position verdict (`RESOLVED-WOULD-MARK`, `LEADER-STILL-OPEN`, `GAMMA-LIVE`, `GAMMA-NO-DATA`, `AMBIGUOUS`, or `ERROR`).

Run it from `worker/`:

```powershell
$env:SUPABASE_URL = "https://rcqnuahjwwlovyzjolbd.supabase.co"
$env:SUPABASE_SERVICE_KEY = "<paste service role key from Railway env vars>"
.\.venv\Scripts\python.exe -m worker.diagnose
```

Interpretation:
- All 4 say `RESOLVED-WOULD-MARK` → sweep on Railway isn't writing. Cause #1. Restart the worker or check logs.
- All 4 say `LEADER-STILL-OPEN` or `GAMMA-LIVE` → markets actually still live. Cause #2. No bug.
- All 4 say `GAMMA-NO-DATA` → bad conditionIds or Gamma rate-limit. Cause #3. Inspect the rows manually.
- Mixed → handle each cause separately.

### Fallback diagnostic — pure SQL (if you can't run the Python script)

```sql
select id, condition_id, title, outcome, is_resolved, resolved_at, resolved_price
from pt_positions
where is_resolved = false
order by id;
```

If those rows have a `resolved_at` already, the UI filter is wrong (unlikely given code audit). If they don't, the worker sweep is the issue.

## Decisions made this session (so we don't re-debate them)

- **Shipped paper trader in one bundled PR** to `main`, not feature-flagged. Option A.
- **Buys-only for v1.1.** Sell-side copying is on the roadmap; engine math is ready but UI not wired.
- **Team-code model** instead of per-user auth. Trust-based; anyone with the code has full access. Acceptable because it's two people for now.
- **Publishable Supabase key in the browser bundle.** Designed for it. Secret key never leaves Railway.
- **Phase 2 deferred Batch 2.6** (an IDB → Supabase migration tool). Old IDB data stays in the user's browser; re-adding the wallet is the supported path.

## File pointers

- `docs/paper-trader-guide.md` — user-facing feature walkthrough.
- `docs/phase-2-cutover.md` — Vercel env-var + redeploy steps for the cutover.
- `SESSION_CONTEXT.md` — this file.

## How to resume

1. Open Supabase → run the diagnostic SQL above.
2. Open Railway → Deployments → View Logs → search for resolution-sweep errors.
3. Once root cause is known, fix in the worker (resolution sweep) or in the frontend Positions query, whichever is wrong.
4. Then sanity-check the registry card stats refresh after a resolved position.
