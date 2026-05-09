# Polyhub Paper Trader — Python Worker

The always-on backend engine for the Phase 2 paper trader. Runs on Railway, polls Polymarket every 30s for each active paper trader in Supabase, simulates fills against the real CLOB book, and writes trades + positions back. Same logic as the Phase 1 JS engine, just rewritten in Python so it runs 24/7 without anyone's browser tab open.

## Status

**Batch 2.4 (current):** scaffold + pure functions ported with pytest tests
- `worker/constants.py` — fee model, slippage tiers, API endpoints
- `worker/fill_simulator.py` — `simulate_buy_fill`, `simulate_sell_fill`, `check_slippage_tolerance`, `compute_fee`
- `worker/guards.py` — `evaluate_pre_fill_guards`, `evaluate_fill_guards`, `compute_raw_stake`
- `worker/resolver.py` — `resolve_position`, `AmbiguousResolutionError`

**Batch 2.5 (next):** API layer + scheduler + Railway deploy
- `worker/polymarket_api.py` — async HTTP client for Polymarket endpoints
- `worker/supabase_client.py` — Supabase service-role wrapper
- `worker/executor.py` — orchestration: poll → guard → fill → write
- `worker/scheduler.py` — polling loop with jitter
- `worker/main.py` — entry point

## Local development

```bash
cd polymarket-hub/worker
python -m venv .venv
.venv\Scripts\activate     # Windows
# source .venv/bin/activate # Linux/Mac
pip install -e ".[dev]"
pytest
```

## Configuration (set on Railway as env vars)

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_KEY=<sb_secret_... or eyJ...service_role>
POLL_INTERVAL_SEC=30
RESOLUTION_INTERVAL_SEC=60
SCHEDULER_TICK_SEC=10
```

The **service key** bypasses RLS — it's how the worker can read/write rows for any team. Never put it in the frontend.

## Deploy to Railway

1. Push this directory to your GitHub repo (already done if you're seeing this in the polymarket-hub repo)
2. Create a new Railway project → "Deploy from GitHub repo"
3. Set the root directory to `worker/`
4. Add env vars above
5. Railway uses `railway.json` to know how to build + start

That's covered in Batch 2.5 step-by-step.
