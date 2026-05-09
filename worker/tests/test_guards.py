"""Mirror of src/paper/__tests__/evaluateGuards.test.js."""

import pytest
from worker.guards import (
    evaluate_pre_fill_guards,
    evaluate_fill_guards,
    compute_raw_stake,
)
from worker.constants import DEFAULT_SLIPPAGE_TOLERANCE


BASE_REGISTRY = {
    "id": "r1",
    "walletAddr": "0xabc",
    "status": "active",
    "copyMode": "buys_only",
    "newMarketsOnly": False,
    "sizingMode": "fixed",
    "fixedAmt": 10,
    "pctAmt": 50,
    "safetyCap": None,
    "maxTradesDay": None,
    "minTradeSize": None,
    "maxTradeSize": None,
    "minPrice": None,
    "maxPrice": None,
    "blockedCategories": [],
    "blockedMarkets": [],
    "perQuestionCap": None,
    "perEventCap": None,
    "maxEventsOpen": None,
    "totalBudget": None,
    "dailyLossLimit": None,
    "weeklyLossLimit": None,
    "lifetimeLossLimit": None,
    "slippageTolerance": DEFAULT_SLIPPAGE_TOLERANCE,
    "startBalance": 100,
}

BASE_ACCOUNT = {"cash": 100}

BASE_TRADE = {
    "conditionId": "cond-1",
    "outcome": "YES",
    "avgPrice": 0.5,
    "totalBought": 100,
    "side": "BUY",
    "category": "sports",
    "timestamp": 1700000000,
    "title": "Will X win?",
}


def base_ctx(**overrides):
    return {
        "leaderTrade": BASE_TRADE,
        "registry": BASE_REGISTRY,
        "account": BASE_ACCOUNT,
        "openPositions": [],
        "todayCount": 0,
        "todayLossUsd": 0,
        "weekLossUsd": 0,
        "lifetimeLossUsd": 0,
        "leaderHadPriorPosition": False,
        "eventId": None,
        **overrides,
    }


# ─── compute_raw_stake ──────────────────────────────────────────────────────
class TestComputeRawStake:
    def test_fixed_mode(self):
        assert compute_raw_stake(BASE_REGISTRY, BASE_TRADE) == 10

    def test_percentage_mode(self):
        r = {**BASE_REGISTRY, "sizingMode": "percentage", "pctAmt": 25}
        assert compute_raw_stake(r, BASE_TRADE) == 100 * 0.5 * 0.25

    def test_portfolio_falls_back_to_fixed(self):
        r = {**BASE_REGISTRY, "sizingMode": "portfolio"}
        assert compute_raw_stake(r, BASE_TRADE) == 10


# ─── pre-fill guards ───────────────────────────────────────────────────────
class TestPreFillPassCase:
    def test_returns_skip_false_with_stake(self):
        r = evaluate_pre_fill_guards(base_ctx())
        assert r["skip"] is False
        assert r["stake"] == 10


class TestStatusGuards:
    def test_paused_is_transient(self):
        r = evaluate_pre_fill_guards(base_ctx(registry={**BASE_REGISTRY, "status": "paused"}))
        assert r["skip"] is True and r["reason"] == "TRADER_PAUSED" and not r["is_permanent"]

    def test_stopped_is_permanent(self):
        r = evaluate_pre_fill_guards(base_ctx(registry={**BASE_REGISTRY, "status": "stopped"}))
        assert r["skip"] is True and r["reason"] == "TRADER_STOPPED" and r["is_permanent"]

    def test_no_balance(self):
        r = evaluate_pre_fill_guards(base_ctx(account={"cash": 0}))
        assert r["reason"] == "NO_BALANCE"


class TestSideFilter:
    def test_sell_filtered_in_buys_only(self):
        r = evaluate_pre_fill_guards(base_ctx(leaderTrade={**BASE_TRADE, "side": "SELL"}))
        assert r["skip"] is True and r["reason"] == "SELL_FILTERED" and r["is_permanent"]

    def test_passes_when_side_missing(self):
        trade = {**BASE_TRADE}
        del trade["side"]
        r = evaluate_pre_fill_guards(base_ctx(leaderTrade=trade))
        assert r["skip"] is False


class TestPositionDedup:
    def test_position_exists_same_outcome(self):
        opened = [{"conditionId": "cond-1", "outcome": "yes", "totalCost": 5}]
        r = evaluate_pre_fill_guards(base_ctx(openPositions=opened))
        assert r["reason"] == "POSITION_EXISTS"

    def test_passes_for_different_outcome(self):
        opened = [{"conditionId": "cond-1", "outcome": "no", "totalCost": 5}]
        r = evaluate_pre_fill_guards(base_ctx(openPositions=opened))
        assert r["skip"] is False


class TestNewMarketsOnly:
    def test_not_new_market(self):
        r = evaluate_pre_fill_guards(base_ctx(
            registry={**BASE_REGISTRY, "newMarketsOnly": True},
            leaderHadPriorPosition=True,
        ))
        assert r["reason"] == "NOT_NEW_MARKET"


class TestSizeAndPriceFilters:
    def test_trade_too_small(self):
        r = evaluate_pre_fill_guards(base_ctx(registry={**BASE_REGISTRY, "minTradeSize": 100}))
        assert r["reason"] == "TRADE_TOO_SMALL"

    def test_trade_too_large(self):
        r = evaluate_pre_fill_guards(base_ctx(registry={**BASE_REGISTRY, "maxTradeSize": 10}))
        assert r["reason"] == "TRADE_TOO_LARGE"

    def test_price_too_low(self):
        r = evaluate_pre_fill_guards(base_ctx(registry={**BASE_REGISTRY, "minPrice": 0.6}))
        assert r["reason"] == "PRICE_TOO_LOW"

    def test_price_too_high(self):
        r = evaluate_pre_fill_guards(base_ctx(registry={**BASE_REGISTRY, "maxPrice": 0.4}))
        assert r["reason"] == "PRICE_TOO_HIGH"


class TestBlocklist:
    def test_blocked_category(self):
        r = evaluate_pre_fill_guards(base_ctx(registry={**BASE_REGISTRY, "blockedCategories": ["sports"]}))
        assert r["reason"] == "BLOCKED_CATEGORY"

    def test_blocked_market(self):
        r = evaluate_pre_fill_guards(base_ctx(registry={**BASE_REGISTRY, "blockedMarkets": ["cond-1"]}))
        assert r["reason"] == "BLOCKED_MARKET"


class TestLimits:
    def test_daily_limit_is_transient(self):
        r = evaluate_pre_fill_guards(base_ctx(
            registry={**BASE_REGISTRY, "maxTradesDay": 5},
            todayCount=5,
        ))
        assert r["reason"] == "DAILY_LIMIT" and not r["is_permanent"]

    def test_lifetime_loss_is_permanent(self):
        r = evaluate_pre_fill_guards(base_ctx(
            registry={**BASE_REGISTRY, "lifetimeLossLimit": 50},
            lifetimeLossUsd=50,
        ))
        assert r["reason"] == "LIFETIME_LOSS" and r["is_permanent"]

    def test_budget_cap(self):
        r = evaluate_pre_fill_guards(base_ctx(
            registry={**BASE_REGISTRY, "totalBudget": 50},
            openPositions=[{"totalCost": 50, "conditionId": "x", "outcome": "yes"}],
        ))
        assert r["reason"] == "BUDGET_CAP"

    def test_question_cap(self):
        r = evaluate_pre_fill_guards(base_ctx(
            registry={**BASE_REGISTRY, "perQuestionCap": 5},
            openPositions=[{"totalCost": 10, "conditionId": "cond-1", "outcome": "no"}],
        ))
        assert r["reason"] == "QUESTION_CAP"


class TestSafetyCap:
    def test_safety_cap_is_permanent(self):
        r = evaluate_pre_fill_guards(base_ctx(
            registry={**BASE_REGISTRY, "fixedAmt": 50, "safetyCap": 25},
        ))
        assert r["reason"] == "SAFETY_CAP" and r["is_permanent"]


class TestCashTrim:
    def test_caps_stake_to_cash(self):
        r = evaluate_pre_fill_guards(base_ctx(
            account={"cash": 3},
            registry={**BASE_REGISTRY, "fixedAmt": 10},
        ))
        assert r["skip"] is False
        assert r["stake"] == 3


# ─── fill guards ───────────────────────────────────────────────────────────
class TestFillGuards:
    def test_no_liquidity(self):
        r = evaluate_fill_guards(BASE_REGISTRY, None)
        assert r["skip"] is True and r["reason"] == "NO_LIQUIDITY" and not r["is_permanent"]

    def test_slippage_exceeded(self):
        r = evaluate_fill_guards(BASE_REGISTRY, {"avg_price": 0.5, "slippage_bps": 500})
        assert r["reason"] == "SLIPPAGE_EXCEEDED"

    def test_passes_within_tolerance(self):
        r = evaluate_fill_guards(BASE_REGISTRY, {"avg_price": 0.5, "slippage_bps": 200})
        assert r["skip"] is False
