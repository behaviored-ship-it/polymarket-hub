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

## 💬 Discussion queue

_(features and changes raised verbally but not yet decided — capture here, then move to a status section above once we agree.)_

- _(awaiting first batch)_

---

## ⏳ Deferred / future

_(things we noticed but explicitly want to handle in a later PR.)_

- _(none yet)_
