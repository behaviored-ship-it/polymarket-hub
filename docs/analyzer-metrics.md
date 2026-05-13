# Analyzer Metrics Reference

How every metric in the **WALLET ANALYZER** tab and the **Paper Trader → LEADER** sub-tab is calculated, what its possible outputs are, and the colour thresholds used to flag it. Use this when:

- Tweaking a formula and you need to know what else depends on it
- Explaining a number to someone who's looking at the UI
- Adding a new metric and you want to keep the style consistent

Source files (all under `src/`):

- [`wallet-analyzer.jsx`](../src/wallet-analyzer.jsx) — `computeMetrics`, `classifyArchetype`, `scoreCopyability`, `scoreReverseEngineer`, `verdictLabel`, `buyPriceDistribution`, `maxDrawdown`, `buyVsSellSplit`, `holdTimeStats`, `computeExtendedMetrics`
- [`WalletAnalyzerTab.jsx`](../src/WalletAnalyzerTab.jsx) — top-level tab page (`ExtendedMetricsPanel` + wallet-input + dual fetch)
- [`paper/PaperLeaderAnalysis.jsx`](../src/paper/PaperLeaderAnalysis.jsx) — compact LEADER sub-tab inside the paper-trader detail view

## Data sources

Both surfaces pull two independent feeds in parallel on load:

| Feed | URL | Shape | Used for |
|---|---|---|---|
| **Closed positions** | `polymarket-hub.vercel.app/api/positions?wallet=X&type=closed` (proxied) | One row per fully resolved BUY. Has `realizedPnl`, `avgPrice`, `timestamp`, `conditionId`, `totalBought`, `result`. **No SELL rows. No separate open/close timestamps.** | All classifier metrics (`computeMetrics`), buy-price distribution, max drawdown |
| **Activity feed** | `data-api.polymarket.com/activity?user=X` (direct) | Raw fills. Each row has `side` (`BUY` / `SELL`), `avgPrice`, `totalBought` (shares), `timestamp`, `conditionId`, `outcome`. | Buy-vs-sell price split, hold time |

We fetch both with `Promise.allSettled`, so a slow / failing endpoint on one side never blanks the other. The status line under the wallet input shows how many rows came back per feed.

---

# Paper Trader → LEADER sub-tab

Compact "is this leader worth copying?" panel. Color-coded tiles so you can scan the verdict without reading.

## Wallet Address

Just `registry.walletAddr` from the paper trader's row. Static display.

## Closed Positions · Activity Rows (status line)

Counts of the two fetches above. Used for data-freshness sanity, not in any formula.

## Archetype

**Source:** `classifyArchetype(metrics)`. Closed-positions data.

**Gating:** If `tradeCount < 300` OR `daysActive < 3` → returns `Insufficient Data` (confidence 0) and the rest of the decision tree is skipped.

**Decision tree** (first match wins):

```text
inputs:
  winRate           = wins / (wins + losses)
  multiEntryPct     = fraction of markets entered more than once
  positionCV        = stdev / mean of trade sizes  (low = uniform = bot-ish)
  asymRatio         = avg win $ / avg loss $
  totalPnl          = sum of realized PnL

if winRate ≈ 0.50 (within ±3%) AND totalPnl > 0
   AND (multiEntryPct > 60% OR asymRatio ≥ 1.5 OR positionCV < 0.55):
     → "Scalper / MM-Skew"      confidence 0.9

elif winRate ≥ 55% AND totalPnl > 0:
     if winRate > 58% AND totalPnl > $500:
          → "Directional Alpha"        confidence 0.9
     else:
          → "Directional (weak edge)"  confidence 0.7

elif totalPnl < -$100:
     → "Losing"                  confidence 0.85

else:
     → "Mixed / Unclassified"    confidence 0.5
```

**Possible outputs:** `Insufficient Data`, `Scalper / MM-Skew`, `Directional Alpha`, `Directional (weak edge)`, `Losing`, `Mixed / Unclassified`.

**Confidence** is hard-coded per branch, not derived — it reflects how much trust the heuristic has in each label, not a statistical p-value.

**Tile color:** green for `directional`, red for `losing`, gold for `mm_skew`, white for the rest.

## Copyability Score

**Source:** `scoreCopyability(metrics, arch, backtest)`. Score clamped 0–100.

**Algorithm:**

```text
score = 50  (neutral start)

# Archetype:
if mm_skew:     score -= 35
if directional: score += 25
if losing:      score -= 40
if noise:       score -= 20

# Backtest (only fires when a backtest result is passed in — see note below):
if backtestROI <= -50%:  score -= 30
if backtestROI <= -10%:  score -= 15
if backtestROI >= +20%:  score += 20
if backtestROI >= +5%:   score += 10

# Statistical-power bonus:
if tradeCount > 1000 AND daysActive > 14:  score += 5

# Clamp to [0, 100], round.
```

**Verdict thresholds (and tile color):**

- ≥ 65 → **COPY** (green)
- 40–64 → **CAUTION** (gold)
- < 40 → **AVOID** (red)

**Note:** The LEADER sub-tab passes `backtest=null`, so only the archetype + statistical-power branches fire here. To get the full ROI-adjusted score, use the WALLET ANALYZER tab after running a backtest on the same wallet in the BACKTEST tab.

## Median Hold Time

**Source:** `holdTimeStats(activity)`. Needs the activity feed because the closed-positions feed has no separate buy/sell timestamps.

**Algorithm — FIFO buy/sell pairing inside each market:**

```text
1. Bucket activity events by (conditionId, outcome.toLowerCase())
2. Within each bucket, sort events ascending by timestamp
3. Walk:
     for each BUY:   push { ts, shares, dollars } onto FIFO queue
     for each SELL:
       remaining = sell_shares
       while remaining > 0 and queue not empty:
         pop from queue head
         take min(head.shares, remaining)
         record pair { holdHours = (sell_ts - buy_ts) / 3600,
                       usd      = prorated buy $ }
4. Aggregate across all matched pairs:
     plain mean         = sum(holdHours) / pairs
     USD-weighted mean  = sum(holdHours * usd) / sum(usd)
     median             = sorted middle value
```

Unmatched BUYs (still open or settled-without-sell) are excluded — they have no close timestamp.

**Verdict colors (based on median):**

- < 10 min → red, "scalper — likely uncopyable"
- 10 min – 1 hr → gold, "short hold — execution-sensitive"
- 1 – 30 hrs → green, "in copy-friendly range"
- > 30 hrs → gold, "long hold — bag-holder risk"

## Hedged Markets %

**Source:** `metrics.multiEntryPct` from `computeMetrics`. Closed-positions data.

**Algorithm:**

```text
1. Group trades by conditionId
2. Count unique conditionIds with > 1 entry
3. multiEntryPct = (markets with >1 entry) / (total unique markets)
```

**Caveat:** this is a *proxy* — closed positions don't reliably carry the outcome field, so "entered Yes twice" looks the same as "bought Yes and No." A scalper re-entering the same outcome counts here too.

**Tile colors:**

- > 50% → red
- 20–50% → gold
- < 20% → white

## Avg Buy Price

**Source:** prefers `buyVsSellSplit.avgBuyPrice` (activity feed) when present, falls back to `metrics.priceMean` (closed positions) when activity is empty.

```text
# Preferred (activity feed):  USD-weighted across BUY fills only
for each fill where side == 'BUY':
  weighted_sum += price * dollars
  total_dollars += dollars
avgBuyPrice = weighted_sum / total_dollars

# Fallback (closed positions): simple mean over all trades
priceMean = sum(avgPrice) / count
```

The USD-weighted version exposes spread traders that a simple mean hides (e.g. 1000 shares at $0.01 + 100 shares at $0.99: simple mean ≈ $0.50, USD-weighted ≈ $0.10).

**Sub-line** shows P10 / P90 from `buyPriceDistribution(trades)` — sort buy prices ascending, linear-interpolate percentiles. A wide P10–P90 band = bimodal / spread trader.

**Tile color:**

- avg > $0.85 → gold (expensive entries leave little copy headroom)

## Max Drawdown

**Source:** `maxDrawdown(trades)`. Closed-positions data.

**Algorithm:**

```text
1. Sort trades ascending by timestamp
2. Walk, maintaining:
     cum  = running sum of realizedPnl
     peak = max(peak, cum) so far
3. At each step:
     dd_at_step = peak - cum
     if dd_at_step > max_so_far:
       max_so_far = dd_at_step
       max_pct    = dd_at_step / peak   # only meaningful when peak > 0
4. Return { maxDrawdownUsd, maxDrawdownPct }
```

Edge case: net-negative the entire time (peak stays at 0) → % is reported as 0; the $ figure is the truth.

**Tile color:**

- maxDrawdownPct > 50% → gold (lost more than half of peak gains at the worst point)
- else white

---

# Wallet Analyzer tab (deep dive)

Three vertically stacked blocks:

1. Top banner — `ANALYZER` pill, archetype label, flag badge
2. Two score panels — Polygun Copyability + PolySignal Reverse-Engineer
3. Metrics grid (10 cells)
4. Extended Metrics panel (7 cards)

## Top banner

### `ANALYZER` pill

Static label. Always shown.

### `ARCHETYPE: <label>`

Same `classifyArchetype(metrics)` as the LEADER tab. See [Archetype](#archetype) above.

### Flag badge

**Source:** `verdictLabel(archetype, copy, reveng)`. Combines the three scores into a single suggested action.

**Decision order (first match wins):**

```text
if archetype == 'insufficient':                  → no badge
if copy.verdict == 'copy':                       → POLYGUN CANDIDATE   (green)
                                                   # ≥65 copyability, ship it
if reveng.verdict == 'high':                     → POLYSIGNAL TARGET   (gold)
                                                   # ≥65 reverse-engineer, study it
if copy.verdict == 'avoid' AND
   reveng.verdict != 'high':                     → IGNORE              (red)
                                                   # bad for both
otherwise:                                       → REVIEW              (muted)
```

So the flag is the "what action does this suggest" summary — copy it, study it, ignore it, or take a closer look.

## Polygun Copyability (left score panel)

Full version of the score described above for the LEADER tab. In this surface the backtest branch *does* fire when a backtest result is available in the same session.

```text
score = 50

# Archetype:
if mm_skew:     score -= 35
if directional: score += 25
if losing:      score -= 40
if noise:       score -= 20

# Backtest adjustments (first match wins):
if backtestROI <= -50%:  score -= 30
elif backtestROI <= -10%: score -= 15
elif backtestROI >= +20%: score += 20
elif backtestROI >= +5%:  score += 10

# Statistical-power bonus:
if tradeCount > 1000 AND daysActive > 14:  score += 5

# Clamp [0, 100], round.
```

**Verdict:** ≥ 65 = COPY, 40–64 = CAUTION, < 40 = AVOID. Panel shows up to 4 reasoning bullets — one per adjustment that fired, so you can see *why* it scored what it did.

## PolySignal Reverse-Engineer (right score panel)

Different question: *can I learn the strategy from this wallet?* Not *can I copy it?* A Scalper scores **75** here but only **15** for copyability — their edge is learnable but not directly copyable (taker fees destroy maker-skew profits).

**Source:** `scoreReverseEngineer(metrics, arch)`. Score clamped 0–100.

```text
score = 40  (lower starting bar than copyability)

# Archetype — note the inversion vs copyability:
if mm_skew:     score += 35   # rule-based, feature-extractable
if directional: score += 25   # observable feature → decision mapping
if losing:      score -= 30
if noise:       score -= 25

# Sample size:
if tradeCount > 2000:     score += 15
elif tradeCount > 500:    score += 8

# Profitability:
if totalPnl > $10,000:    score += 15
elif totalPnl > $500:     score += 8
elif totalPnl < 0:        score -= 20

# Consistency — high Sharpe = smooth equity curve = stable strategy:
if sharpeDaily > 1.0 AND dailySamples >= 5:  score += 10

# Clamp [0, 100], round.
```

**Verdict thresholds:** ≥ 65 = HIGH (green), 40–64 = MEDIUM (gold), < 40 = LOW (red).

## Metrics grid

10 raw or near-raw numbers from `computeMetrics(trades)`. No color-coding — these are inputs the scorers consume.

| Cell | Source | Calculation | Notes |
|---|---|---|---|
| Trades | `tradeCount` | `trades.length` | Below 300 → archetype reads `Insufficient Data` |
| Days Active | `daysActive` | `(max(ts) - min(ts)) / 86400` | Below 3 → `Insufficient Data` |
| Trades/Window | `tradesPerWindow` | `tradeCount / windowCount` where `windowCount` = unique conditionIds | High (> 3) = MM-ish / scalper signal. Lebandito's friend's report quoted **2.6** |
| Two-Sided % | `multiEntryPct` | markets with > 1 entry / total markets | Above 60% triggers MM-skew branch. Same proxy caveat as "Hedged Markets %" |
| Pos Size CV | `positionCV` | `stdev(trade sizes) / mean(trade sizes)` | Low = bot. < 0.55 triggers uniform-sizing branch of MM-skew |
| Win Rate | `winRate` | `wins / (wins + losses)` | Decided trades only. ±3% of 50% = coin-flip branch; > 55% = directional branch |
| Asym Ratio | `asymRatio` | `avg win $ / avg loss $` | > 1.5 = asymmetric edge — winners 1.5× bigger than losers. The signal that lets a 50% WR be profitable |
| Daily Sharpe | `sharpeDaily` | `mean(daily PnL) / stdev(daily PnL)` (not annualized) | > 0.8 called out in directional-alpha reasoning; > 1.0 contributes +10 to reverse-engineer score |
| Avg $/Side | `positionMean` | `mean(totalBought)` for trades with `totalBought > 0` | Lebandito's friend quoted this directly |
| Total PnL | `totalPnl` | `sum(realizedPnl)` across all trades | > 0 + 50% WR = MM-skew candidate; > $500 + > 58% WR = directional alpha; < -$100 = losing |

## Extended Metrics panel

Below the classifier. Same calculations as the LEADER tab's tiles — listed here for completeness.

| Card | Source | What it is |
|---|---|---|
| Median hold | `holdTimeStats.medianHoldHours` | Middle value of all matched BUY→SELL pairs (in hours). See [Median Hold Time](#median-hold-time) above. |
| USD-weighted hold | `holdTimeStats.usdWeightedMeanHoldHours` | Same pair set, mean weighted by pair dollar size. Tells you where the money sits — different from plain mean when scalp-sized pairs dominate count but big positions dominate exposure. |
| Max drawdown | `maxDrawdown.{maxDrawdownUsd, maxDrawdownPct}` | Peak-to-trough on cumulative PnL ordered by timestamp. $ + % of peak. Tile gold if > 50%. |
| Buy price · P50 | `buyPriceDistribution.p50` | 50th percentile of sorted buy prices (linear interpolation). Sub-line shows P10 / P90 — wide band exposes spread traders. |
| Buy price · range | `buyPriceDistribution.{min, max}` | Outright min and max across the sample. |
| Avg buy (vol-weighted) | `buyVsSellSplit.avgBuyPrice` | `sum(price * $) / sum($)` over BUY fills. |
| Avg sell (vol-weighted) | `buyVsSellSplit.avgSellPrice` | Same algorithm on SELL fills. Tile gold if > $0.90 — selling near resolution is a timing edge that doesn't survive copy-lag. |

## Footer

`Confidence: NN% · reasoning based on aggregated closed positions.` plus an instruction to run a backtest for ROI-adjusted copyability. The confidence number is the archetype's hard-coded confidence (0.9, 0.7, 0.85, 0.5).

---

# What's intentionally not built yet

Captured here so you don't think we missed them — they're tracked under "Open questions" in `docs/v1-qa-tracker.md`.

- **Avg ROI per market vs ~13% friction floor** — pending a design call on whether the floor is a hard-coded constant or per-trader derived from observed slippage + fees.
- **Avg trade size as % of leader's bank** — Polymarket doesn't expose the leader's bank balance over time. Would require reconstructing their cash curve from full activity history.

# Where each surface is referenced from

- LEADER sub-tab rendered from [`PaperTraderDetail.jsx`](../src/paper/PaperTraderDetail.jsx) (`sub === 'leader'`). Component: [`PaperLeaderAnalysis.jsx`](../src/paper/PaperLeaderAnalysis.jsx).
- WALLET ANALYZER tab mounted from [`polymarket-hub.jsx`](../src/polymarket-hub.jsx) (`mainTab === 'wa'`). Component: [`WalletAnalyzerTab.jsx`](../src/WalletAnalyzerTab.jsx), which renders [`WalletAnalyzer`](../src/wallet-analyzer.jsx) (banner + scores + grid) above its own `ExtendedMetricsPanel`.
- Deep-link "Analyze Leader →" button: callback `onAnalyzeWallet` threaded from App → PaperTab → PaperTraderDetail → PaperLeaderAnalysis. Sets `walletAnalyzerSeed` in App and flips `mainTab` to `'wa'`; the analyzer tab's `initialWallet` effect auto-fetches.

# Conventions to keep when adding new metrics

- **One-formula-per-function in `wallet-analyzer.jsx`.** Each metric is its own exported function (e.g. `buyPriceDistribution`, `maxDrawdown`). Aggregators are wrappers (`computeMetrics`, `computeExtendedMetrics`). Easier to unit-test, easier to compose differently.
- **Defensive on field shape.** Activity feed has historically shifted field names — use the `activityPrice`, `activityShares`, etc. helpers and fall back gracefully.
- **No throws on missing data.** Empty input → `null` or `{ ...flags-only, count: 0 }`. The UI guards against `null` everywhere; throws would blank the whole panel.
- **Color thresholds live in the consuming component, not the metric.** `maxDrawdown` returns raw numbers; `PaperLeaderAnalysis` decides what's gold. Keeps the formula reusable in places that want different visual conventions.
- **Tests in `src/__tests__/walletAnalyzerExtended.test.js`.** Hand-crafted fixtures with answers computable by hand. Spread-trader fixtures verify that the metric exposes what a simple mean hides.
