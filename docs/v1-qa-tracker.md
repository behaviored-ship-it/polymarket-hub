# Paper Trader V1 — QA rollup

Rolling tally of issues and additions surfaced during the V1 QA walkthrough. Everything in this doc is bundled into the `v1-qa-rollup` branch and ships as a single PR.

## Legend

- ✅ **done** — change is in this branch, ready for review
- 🚧 **in progress** — being implemented now
- 💬 **discuss** — needs a design call before implementing
- ⏳ **deferred** — captured for later (post-V1 or separate PR)

---

## ✅ Time filter now applies to Trade Comparison + Positions tabs

**Reported:** 2026-05-12 — time filter buttons (`7D / 30D / 90D / ALL TIME`) appeared to be "blank clicks." Root cause: filter only affected the Overview stats; Trade Comparison and Positions tabs received the unfiltered lists. Filter bar also rendered above Settings, which has nothing to filter.

**Changes:**
- `inWindow` exported from [src/paper/usePTStats.js](../src/paper/usePTStats.js).
- [src/paper/PaperTradeLog.jsx](../src/paper/PaperTradeLog.jsx) accepts `timeframe` prop; trades narrow by `openedAt`. Pill counts (`All / Success / Failed`) reflect the window.
- [src/paper/PaperPositions.jsx](../src/paper/PaperPositions.jsx) accepts `timeframe` prop; *resolved* positions narrow by `resolvedAt`. *Open* positions always show (no `opened_at` column on `pt_positions`; they represent current exposure). Pill counts reflect the window.
- [src/paper/PaperTraderDetail.jsx](../src/paper/PaperTraderDetail.jsx) passes `tf` to both tabs and hides the filter button row on Settings.

**Tests:** all 83 frontend tests pass.

---

## ✅ Batch A — 4 extended leader metrics (formulas + tests)

Four new exports in [src/wallet-analyzer.jsx](../src/wallet-analyzer.jsx), no changes to the existing tested `computeMetrics` / classifier:

- `buyPriceDistribution(trades)` — P10/P50/P90 of buy prices (from closed-positions feed). Captures spread traders that simple-mean hides.
- `maxDrawdown(trades)` — peak-to-trough on cumulative realized PnL ordered by timestamp. Returns $ and % of peak.
- `buyVsSellSplit(activity)` — USD-weighted avg buy vs avg sell price + per-side counts and volumes. Requires the activity (fills) feed.
- `holdTimeStats(activity)` — FIFO-pair BUYs with SELLs within each (conditionId, outcome). Returns plain mean, USD-weighted mean, median (all in hours), plus pair count.
- `computeExtendedMetrics({ trades, activity })` — wrapper returning all four.

**Tests:** 20 new tests in [src/__tests__/walletAnalyzerExtended.test.js](../src/__tests__/walletAnalyzerExtended.test.js). Full suite: 103/103 passing. Coverage includes: edge cases (empty / null inputs), spread-trader fixture verifying P10..P90 reveals what mean hides, scrambled-timestamp invariance for max-DD, FIFO pairing across multiple buys/sells, and outcome-isolation (Up buys don't pair with Down sells).

## 💬 Discussion queue

_(features and changes raised verbally but not yet decided — capture here, then move to a status section above once we agree.)_

### Leader-wallet evaluation stats (from friend's review, 2026-05-11)

Goal: answer "**should we even copy this wallet?**" before adding it to the paper trader. Different concern from the existing per-paper-trader stats which answer "how is OUR copy doing?".

**Already exists in [src/wallet-analyzer.jsx](../src/wallet-analyzer.jsx)** (`computeMetrics` + archetype classifier + copyability score):

- Markets traded (unique market count) — `windowCount`
- Trades count — `tradeCount`
- Days active — `daysActive`
- **Hedged markets %** — `multiEntryPct` (markets with both sides entered)
- Trades per market — `tradesPerWindow` (= "entries per market")
- Win rate, win/loss counts — `winRate`, `winCount`, `lossCount`
- Avg trade size $ — `positionMean`
- Trade-size variance — `positionStdev`, `positionCV` (uniformity ⇒ bot)
- Avg buy price — `priceMean` (combined; doesn't split buy vs sell yet)
- Price stdev — `priceStdev`
- Avg win / avg loss / asymmetry — `avgWin`, `avgLoss`, `asymRatio`
- Daily Sharpe — `sharpeDaily`
- Total PnL
- Archetype classification: MM-Skew/Scalper, Directional (Alpha/weak), Losing, Noise
- Copyability score (0–100) with reasoning
- Reverse-engineer score (whether you can derive their strategy)

**Truly new (would need to add):**

- **Avg buy price vs avg sell price separately** — current `priceMean` lumps them. Friend flagged this matters because spread traders distort averages.
- **Buy-price distribution** — friend's actual ask was "where do 80%+ trades happen, what's the range" rather than a single average. Suggest P10/P50/P90 or a small histogram.
- **Avg holding time** — minutes/hours per position from buy → sell/resolve. Friend's threshold: <10min = scalper (uncopyable), 1–30h = sweet spot, >30h = bag-holding.
- **Avg ROI per market** vs friction floor (~13% = 2% bot + 10% slip + 1% Polymarket).
- **Max drawdown** in $ and %.
- **Avg trade size as % of bank** — needs leader's bank size; not currently tracked. Open question whether we can derive this from Polymarket activity feed.
- **Bank-size-tiered sizing recommendations** — table mapping copier bank size → concurrent cap / per-trade size / strategy. (See friend's $100/$200/$500/$1000/$2500 table.)

**Design decisions:**

1. ✅ **Wallet Analyzer becomes its own top-level tab** (Option 1, 2026-05-12). Currently it renders unconditionally above the main tab row in [src/polymarket-hub.jsx:899](../src/polymarket-hub.jsx) and depends on whatever wallet the top wallet-fetch happened to load — so it's almost invisible from the PAPER tab. Promoting it gives the analyzer its own wallet-input field and decouples it from the top fetch. Paper Trader detail view gets a compact summary panel + "Open in Wallet Analyzer →" deep link.

2. ✅ **Hold time reported as both USD-weighted mean and median** (matches friend's analysis output style).

3. ✅ **Path C for data sourcing** (2026-05-12): existing classifier (`computeMetrics`) stays on aggregated closed-positions data — no regression risk. The 4 new metrics live in a sibling `computeExtendedMetrics(activity)` fed from `fetchActivity` (the BUY/SELL fills feed already used by the worker). Same wallet, two fetches, two panels.

   Constraint that forced this: the existing closed-positions shape has no SELL rows and no separate open/close timestamps. Buy-vs-sell prices and hold time both require the activity feed.

**Open questions:**

- Friction floor — hard-coded 13% or per-trader config based on actual slippage/fees?
- Bank-size table — static help panel, or auto-suggest settings based on the active paper trader's start balance?
- Hedged-markets %: existing `multiEntryPct` (any market entered twice), or strict two-sided buys (Up AND Down on same condition_id)? They overlap but aren't identical.

---

## 🚧 Batch C — sell-side copying

**Reported:** 2026-05-12. Carryover from original V1 ship — MVP launched as buys-only with sell-side on the v1.1 list. Audit on 2026-05-12 confirms the math is in place but the orchestration is not.

**State of the wiring:**
- ✅ Sell-fill math: [worker/worker/fill_simulator.py:120 simulate_sell_fill](../worker/worker/fill_simulator.py).
- ❌ Worker filters SELLs out at the activity boundary ([executor.py:319](../worker/worker/executor.py)).
- ❌ Defensive `SELL_FILTERED` skip guard in [guards.py:61](../worker/worker/guards.py).
- ❌ JS executor mirrors the same buy-only filter ([tradeExecutor.js:240](../src/paper/tradeExecutor.js)).
- ❌ SELL filter pill in PaperTradeLog returns nothing ([PaperTradeLog.jsx:115](../src/paper/PaperTradeLog.jsx)).

**Scope:**
- Stop filtering SELL events out (worker + JS).
- Remove or replace `SELL_FILTERED` guard.
- On SELL: find matching open paper position by (registry_id, condition_id, outcome), call `simulate_sell_fill` for proceeds, update position state, write a trade row with side='sell', credit account cash.
- New trade status: `'sold'` (vs `'resolved'` for settled-by-market). Or keep `'resolved'` and add `exit_reason: 'sold' | 'settled'` — design choice.
- UI: `SOLD` badge in PaperTradeLog and PaperPositions, distinct from `WIN`/`LOSS`.
- Partial sells: if leader sells 50%, mirror at 50% of our shares (proportional).

**Order:** runs after Batch A (formulas), before Batch B (UI). Reason: Batch B's Leader Analysis panel and per-trader stats should absorb the new SOLD state in one UI pass.

## ⏳ Deferred / future

_(things we noticed but explicitly want to handle in a later PR.)_

- _(none yet)_
