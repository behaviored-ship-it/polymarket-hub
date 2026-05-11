# Polymarket Hub — Paper Trader

A walkthrough of what just shipped on **polymarket-hub.vercel.app** under the new **PAPER** tab.

---

## What it is

The Paper Trader is a **risk-free copy-trade simulator**. You point it at any Polymarket wallet and it watches that wallet in real time. When the wallet places a trade, the simulator opens an identical paper position with virtual funds — using the live Polymarket order book, the real Polymarket fee formula, and the actual market resolution. Over days and weeks, you build up a track record showing what *would have happened* if you'd actually been copying that wallet.

It's not a backtest. Backtesting replays history instantly. This runs forward in real time, building data as the wallet trades.

The headline feature: a **VS ACTUAL** comparison that shows what the real wallet made on those same trades vs what your paper portfolio captured at your stake size. That gap — the "copy friction" — tells you whether shadowing this wallet at your size is actually worthwhile.

---

## First-time setup — joining the team

Paper traders are stored on a shared backend, so two devices (or two people) can see and edit the same set. Access is controlled by a **6-character team code** — no password, no sign-in form, just a code that lives in your browser.

1. Go to **polymarket-hub.vercel.app** → click **PAPER** in the top nav.
2. First visit shows a gate with two options:
   - **CREATE TEAM** — generates a new 6-character code, copy and share it
   - **JOIN TEAM** — paste a code someone shared with you
3. The code is stored in your browser's localStorage. You don't enter it again on this device.
4. To add a third device or share with another person: open the team menu (the `team XXXXXX ▾` badge in the header) → COPY CODE → send it to them → they click JOIN TEAM and paste.

⚠ Anyone with the team code has full access to the team's paper traders — there's no per-user privacy within a team. Only share the code with people you trust to add/edit/delete shared paper traders.

## Adding a paper trader

1. Click **+ ADD PAPER TRADER**.
2. Fill in:
   - **Wallet address** — the 0x... address you want to shadow
   - **Nickname** (optional) — anything memorable like "Whale Alpha" or "Sports Guy"
   - **Starting balance** — your virtual bankroll (default $100)
   - **Sizing** — Fixed $ (same dollar amount every trade) or Percentage (scale with their bet size)
   - **Amount** — preset buttons for $5/$10/$50/$100/$200/$500 or type your own
3. Click **+ CREATE**. The paper trader appears in the registry. The backend worker starts polling that wallet within ~30 seconds.

A card appears in the registry grid with `UNRANKED` and `● ACTIVE` badges. As trades happen, stats update live — visible to everyone on the team.

---

## The registry view (PAPER tab home)

Once you have one or more paper traders set up, the PAPER tab shows them as a grid of cards. Each card has:

- **Rank badge** — `#1`, `#2`, `#3`... once a trader has at least 5 resolved trades. Until then it shows `UNRANKED`.
- **Wallet address** (truncated, like `0x428b...6b7a`) and your nickname
- **Status badge** — `● ACTIVE` (polling), `⏸ PAUSED` (you paused it OR auto-pause tripped), or `■ STOPPED`
- **5 stats**: ROI, Win Rate, Realized P&L, Trades Copied, Open Positions
- **Action buttons**: OPEN (detail view), PAUSE / RESUME, STOP
- **⋯ menu**: EXPORT CSV, RESET, DELETE

Cards are sorted by ROI descending — your best-performing paper trader is first.

A small `team XXXXXX ▾` badge in the header shows which team you're viewing. Click it to copy the code or switch teams.

---

## The detail view (click OPEN on any card)

Four sub-tabs across the top, plus a time filter (`7D · 30D · 90D · ALL TIME`) that filters every stat.

### Overview tab — the dashboard

Three panels stacked top to bottom:

**1. VS ACTUAL banner** (the unique feature)
Shows three numbers:
- **Wallet made** — what the leader actually made on the trades you tried to copy
- **You would have made** — what your paper portfolio captured at your stake size
- **Copy friction** — the difference. Negative = slippage and fees ate into your edge. Positive = you got lucky / the wallet had timing issues.

Plus matched-markets count, average slippage in bps, and total fees you've paid.

This banner is empty until at least one resolved trade exists in both your paper portfolio and the leader's wallet.

**2. Realized P&L hero panel**
Big green/red number showing your total realized P&L. Below it, an equity curve charting your cumulative balance over time. Dashed line = your starting balance.

To the right: **Win Rate** (e.g. `54.2%` with W/L count below) and **ROI** (percentage of starting balance).

**3. Stats grid (8 cells)**
- Volume (total $ stake)
- Trades Copied (count)
- Best Trade ($ won on best position)
- Worst Trade ($ lost on worst position)
- Profit Factor (gross wins / gross losses)
- Avg Slippage (basis points)
- Sharpe (annualized risk-adjusted return)
- Open Positions (count of unresolved)

**4. Bottom row**
- Left: Cumulative balance chart (same as above) plus cash-on-hand and total fees
- Right: **COPY RESULTS** live feed — every event scrolls in here as it happens:
  - `BUY` — fill executed (with stake + entry price)
  - `SKIP` — leader trade rejected (with reason like SLIPPAGE_EXCEEDED, BLOCKED_CATEGORY, NO_LIQUIDITY)
  - `WIN` / `LOSS` — position resolved
  - `PAUSE` — auto-pause tripped
  - `ERROR` — fetch failure

### Trade Comparison tab

A table showing every leader trade we tried to copy, including the ones we skipped. Each row:

- Market title
- Outcome (Yes/No or team name in colored badge)
- Leader's price (what they paid)
- Your fill price (what you actually got)
- **Slippage in bps** — turns amber when above 50bps
- Your stake
- P&L
- Status (OPEN / WIN / LOSS / SKIP)
- When

Skipped trades show inline with the reason ("↳ SLIPPAGE_EXCEEDED" or "↳ BLOCKED_CATEGORY (permanent)") so you can see exactly why a leader trade wasn't copied.

Filter pills at top: All / Success / Failed × All Sides / BUY / SELL. (SELL is locked for v1.1 — we're buys-only for now.)

### Positions tab

Same shape as Trade Comparison but at the position level (a position can have multiple trades aggregated into it).

Filter pills with live counts: `All (n) · Open (n) · Closed (n) · Resolved (n)`

Right side controls:
- **Search markets** — type-ahead filter on title
- **Sort dropdown** — Recent / P&L / Alphabetical
- **Position counter**
- **◉ LIVE PRICES toggle** — when ON, polls Polymarket every 30 seconds to update current prices on your open positions, recomputing unrealized P&L in real time. The "last updated 5s ago" timestamp tells you how fresh the data is.

For each position:
- Market title, outcome, entry price, current/exit price, P&L, shares, stake, when, status badge

Resolved positions show their final exit price (1.0 = won, 0.0 = lost) and a `WIN` / `LOSS` badge.

### Settings tab

The full configuration form. Read-only wallet address (you can't change which wallet a paper trader shadows after creation), but everything else is editable. Each section is collapsible and shows a `N SET` badge when you've changed it from defaults.

The seven sections:

#### 1. Trade Settings
- **What to Copy** — Buys & Sells (locked for v1.1) or Buys Only (default for now)
- **New Markets Only** toggle — only enter when the leader is opening a fresh position, ignore adds
- **Safety cap $** — hard ceiling on your stake per single trade
- **Max trades/day** — cap copies per ET day

#### 2. Risk Management (per-position)
Three independent toggles — when enabled, each reveals a `%` input:
- **Stop Loss** — close this position when its unrealized P&L falls past `-X%`
- **Take Profit** — close when it gains `+X%`
- **Trailing Stop** — close when it falls `X%` below its peak

These act on each open position individually.

#### 3. Position & Budget Limits
- **Per question $** — max exposure on any one market
- **Per event $** — max exposure on any one Polymarket event (multi-market group)
- **Max events open** — cap on simultaneous events
- **Total budget $** — overall exposure cap
- **Loss Limits** (Daily / Weekly / Lifetime) — when realized losses hit these thresholds, skip new trades for the rest of that period

#### 4. Trade Size Filter
Decides which leader trades are even worth copying:
- **Min/Max trade size** — only copy when leader stakes between $X and $Y
- **Min/Max share price** — skip trades at extreme prices (near 0¢ or 99¢) where liquidity is thin

#### 5. Blocklist
- **Blocked categories** — comma-separated category names to skip (e.g. "sports, politics")
- **Blocked markets** — line-separated specific market conditionIds to never copy

#### 6. Slippage Tolerance
Three tiers based on the token's price (cheaper tokens = wider spreads = more tolerance):
- **40c+** — default 4% max slippage
- **18-40c** — default 10%
- **Under 18c** — default 25%

If a fill simulation would exceed the tier's limit, we skip that trade with `SLIPPAGE_EXCEEDED`.

#### 7. Auto-Pause on P&L
Trader-wide kill switch (vs the per-position one above). Two thresholds each for loss and profit, in either `%` or `$`:
- **Pause on Loss** — `% of invested` and/or `Dollar amount`
- **Pause on Profit** — same

Either threshold tripping will pause the entire trader. You manually resume it via the card's RESUME button.

Hit `✦ UPDATE CONFIG` at the bottom to save. The engine picks up new settings on the next poll cycle (usually within 30s).

---

## The card menu (⋯)

Three actions:

- **EXPORT CSV** — downloads two files: `paper-trades-<nickname>-<date>.csv` and `paper-positions-<nickname>-<date>.csv`. Open in Excel / Google Sheets to slice the data however you want.
- **RESET** — wipes all trades and positions for this trader, restores starting balance, and resumes polling. The wallet address and settings stay. Useful if you want a fresh start without re-creating the trader.
- **DELETE** — removes the trader entirely. All data gone. Confirms first.

Both RESET and DELETE prompt for confirmation.

---

## How the engine actually works

When polling is active:

1. **Every 30 seconds** the engine fetches the wallet's recent activity from the Polymarket API
2. For each new BUY trade it finds:
   - Fetches the live order book for that market
   - **Simulates a fill** by walking the asks from cheapest up — exactly like a real Polymarket order would
   - Applies the **exact Polymarket fee formula**: `(100/10000) × min(price, 1-price) × stake`
   - Computes **slippage in bps** vs the midpoint
3. **Runs 23 guards** to decide whether to actually copy the trade:
   - Position dedup (don't double up on a market we're already in)
   - Size and price filters
   - Daily/weekly/lifetime loss limits
   - Per-question / per-event / total budget caps
   - Slippage tolerance tier
   - Blocklist match
   - ...and more
4. **If passes**: opens a paper position, deducts from your virtual cash, records the trade with full audit (slippage, fee, levels filled, leader's price for comparison)
5. **If fails**: records a SKIP row with the reason — visible in the COPY RESULTS feed and Trade Comparison table

**Every 60 seconds** a separate sweep checks open positions for resolution. When a market resolves:
- Position marked WIN or LOSS
- P&L credited to your virtual cash
- Auto-pause check (if a big loss tripped your threshold)

All data lives in your browser's IndexedDB — survives refreshes, but each browser is its own island for now.

---

## Important caveats (read this!)

### Sells aren't copied yet
Currently MVP is buys-only. If the leader sells out of a position, your paper position holds until the market resolves (WIN or LOSS at 1.0 / 0.0). Sell-side copying is on the v1.1 list — the engine has the math ready, just hasn't been wired into the UI.

### Portfolio-weighted sizing falls back to fixed
"Scale with their portfolio" sizing requires knowing the leader's portfolio size at the moment of the trade, which we don't currently track in real time. If you pick portfolio sizing in settings, it falls back to your fixed amount. Phase 2 will add proper portfolio tracking.

### The latency you see is polling delay, not real lag
The "Avg poll delay" number in the cumulative panel shows the gap between when the leader traded and when our poller picked it up. It's not real copy lag — even a real bot running this fast would see roughly the same numbers because of the polling cadence. We label it honestly so you know what it is.

---

### Anyone on the team can change anything
Team members share full read/write access. Your friend can pause, edit settings on, or delete any paper trader you've added — and vice versa. No private "your traders" view. Only invite people you'd be fine with sharing a Google Doc with.

If you outgrow this trust model, the schema already has a `team_id` column ready to convert into a real `user_id` system with email login.

## Roadmap

**Coming next (v1.1+):**
- Sell-side copying (the engine fully tracks the leader's exits, not just entries)
- Portfolio-weighted sizing with proper leader balance tracking
- Head-to-head paper trader comparison ("PK mode")
- Shareable performance cards
- Real per-user auth (Supabase Auth) for teams that want privacy between members

---

## Troubleshooting

**"I added a wallet but no trades are showing up"**
Check that:
1. The wallet has actually traded recently — paste the address into [polymarket.com/profile/0x...](https://polymarket.com) and look at recent activity
2. The PAPER tab is open in your browser (polling stops when it isn't)
3. The card status badge shows `● ACTIVE` (not PAUSED or STOPPED)
4. Open browser console (F12 → Console) and look for any errors

**"Lots of SKIPs in the COPY RESULTS feed"**
Normal at first — the engine is filtering aggressively by default. If most skips are `SLIPPAGE_EXCEEDED`, loosen the slippage tier in Settings. If they're `BLOCKED_CATEGORY` or `BLOCKED_MARKET`, check your Blocklist. If they're `NO_LIQUIDITY` or `RESOLVED_BEFORE_COPY`, those are unavoidable — the market just couldn't be traded at that moment.

**"My data disappeared after clearing browser cache"**
Clearing localStorage drops your team code. Re-enter it via JOIN TEAM on the next visit and the data comes right back — it lives on the backend, not in your browser.

**"I joined the team but I don't see anything"**
Confirm the code in the header badge matches your friend's. Codes are case-sensitive (the input auto-uppercases). If it still doesn't show, ask your friend to look at the registry grid on their device — if they see traders there, refresh your page.

**"The paper trader is paused and I don't know why"**
Open Settings → check Auto-Pause on P&L. If a threshold tripped, either raise it or click RESUME on the card. The pause reason is also stored on the registry — visible in the EXPORT CSV.

---

## Where to ping us

- Bugs / weird behavior: open an issue in the GitHub repo
- Feature requests: same place
- "I'm using it and X is annoying": save it up, we'll fix in Phase 2 polish

That's it. Have fun finding good wallets to shadow.
