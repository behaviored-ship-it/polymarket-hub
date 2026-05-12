"""Trade guards. Ported from src/paper/evaluateGuards.js.

23 guards split into pre-fill (cheap, runs before book fetch) and post-fill
(slippage / liquidity, runs after fill simulation). Each guard records
permanent vs transient — caller uses this to decide whether a skip should
prevent retry on later polls.
"""

from __future__ import annotations
from typing import Mapping, Any

from .fill_simulator import check_slippage_tolerance


def _perm(reason: str) -> dict:
    return {"skip": True, "reason": reason, "is_permanent": True}

def _trans(reason: str) -> dict:
    return {"skip": True, "reason": reason, "is_permanent": False}

def _pass(**extras) -> dict:
    return {"skip": False, **extras}


def compute_raw_stake(registry: Mapping[str, Any], leader_trade: Mapping[str, Any]) -> float:
    """Dollar stake before safety-cap or balance trimming."""
    dollars = (leader_trade.get("totalBought") or 0) * (leader_trade.get("avgPrice") or 0)
    sizing_mode = registry.get("sizingMode")
    if sizing_mode == "fixed":
        return registry.get("fixedAmt") or 0
    if sizing_mode == "percentage":
        return dollars * ((registry.get("pctAmt") or 0) / 100)
    if sizing_mode == "portfolio":
        # MVP fallback — same as JS engine
        return registry.get("fixedAmt") or 0
    return 0


def evaluate_pre_fill_guards(ctx: Mapping[str, Any]) -> dict:
    """Run cheap checks before fetching the CLOB book.

    ctx keys: leaderTrade, registry, account, openPositions, todayCount,
    todayLossUsd, weekLossUsd, lifetimeLossUsd, leaderHadPriorPosition, eventId.

    Returns either {skip: True, reason, is_permanent} or {skip: False, stake}.
    """
    leader_trade = ctx["leaderTrade"]
    registry = ctx["registry"]
    account = ctx.get("account") or {}
    open_positions = ctx.get("openPositions") or []
    r = registry

    if r.get("status") == "paused":
        return _trans("TRADER_PAUSED")
    if r.get("status") == "stopped":
        return _perm("TRADER_STOPPED")
    if not (account.get("cash", 0) > 0):
        return _trans("NO_BALANCE")

    # SELL events are handled by a separate code path (execute_on_leader_sell).
    # If a SELL somehow reached the BUY pre-fill guards, treat it as a permanent
    # skip rather than letting it through — this is only reachable on registries
    # explicitly set to buys_only.
    side = str(leader_trade.get("side") or "").upper()
    if side == "SELL" and r.get("copyMode") == "buys_only":
        return _perm("SELL_FILTERED")

    leader_outcome_lower = str(leader_trade.get("outcome", "")).lower()
    leader_cond = leader_trade.get("conditionId")
    dup = any(
        p.get("conditionId") == leader_cond
        and str(p.get("outcome", "")).lower() == leader_outcome_lower
        for p in open_positions
    )
    if dup:
        return _perm("POSITION_EXISTS")

    if r.get("newMarketsOnly") and ctx.get("leaderHadPriorPosition"):
        return _perm("NOT_NEW_MARKET")

    leader_dollars = (leader_trade.get("totalBought") or 0) * (leader_trade.get("avgPrice") or 0)
    if r.get("minTradeSize") is not None and leader_dollars < r["minTradeSize"]:
        return _perm("TRADE_TOO_SMALL")
    if r.get("maxTradeSize") is not None and leader_dollars > r["maxTradeSize"]:
        return _perm("TRADE_TOO_LARGE")
    avg_price = leader_trade.get("avgPrice") or 0
    if r.get("minPrice") is not None and avg_price < r["minPrice"]:
        return _perm("PRICE_TOO_LOW")
    if r.get("maxPrice") is not None and avg_price > r["maxPrice"]:
        return _perm("PRICE_TOO_HIGH")

    blocked_cats = r.get("blockedCategories") or []
    if blocked_cats and leader_trade.get("category") in blocked_cats:
        return _perm("BLOCKED_CATEGORY")
    blocked_markets = r.get("blockedMarkets") or []
    if blocked_markets and leader_cond in blocked_markets:
        return _perm("BLOCKED_MARKET")

    if r.get("maxTradesDay") is not None and ctx.get("todayCount", 0) >= r["maxTradesDay"]:
        return _trans("DAILY_LIMIT")
    if r.get("dailyLossLimit") is not None and ctx.get("todayLossUsd", 0) >= r["dailyLossLimit"]:
        return _trans("DAILY_LOSS")
    if r.get("weeklyLossLimit") is not None and ctx.get("weekLossUsd", 0) >= r["weeklyLossLimit"]:
        return _trans("WEEKLY_LOSS")
    if r.get("lifetimeLossLimit") is not None and ctx.get("lifetimeLossUsd", 0) >= r["lifetimeLossLimit"]:
        return _perm("LIFETIME_LOSS")

    if r.get("maxEventsOpen") is not None and ctx.get("eventId"):
        distinct_events = {p.get("eventId") for p in open_positions if p.get("eventId")}
        if ctx["eventId"] not in distinct_events and len(distinct_events) >= r["maxEventsOpen"]:
            return _trans("MAX_EVENTS")

    total_exposure = sum((p.get("totalCost") or 0) for p in open_positions)
    if r.get("totalBudget") is not None and total_exposure >= r["totalBudget"]:
        return _trans("BUDGET_CAP")

    if r.get("perQuestionCap") is not None:
        q_exposure = sum((p.get("totalCost") or 0) for p in open_positions if p.get("conditionId") == leader_cond)
        if q_exposure >= r["perQuestionCap"]:
            return _perm("QUESTION_CAP")
    if r.get("perEventCap") is not None and ctx.get("eventId"):
        e_exposure = sum((p.get("totalCost") or 0) for p in open_positions if p.get("eventId") == ctx["eventId"])
        if e_exposure >= r["perEventCap"]:
            return _perm("EVENT_CAP")

    raw_stake = compute_raw_stake(r, leader_trade)
    if not (raw_stake > 0):
        return _perm("STAKE_ZERO")

    stake = raw_stake
    if r.get("safetyCap") is not None and stake > r["safetyCap"]:
        return _perm("SAFETY_CAP")

    cash = account.get("cash", 0)
    if stake > cash:
        stake = cash
    if not (stake > 0):
        return _trans("NO_BALANCE")

    return _pass(stake=stake)


def evaluate_fill_guards(registry: Mapping[str, Any], fill_result) -> dict:
    """Run after fill simulation. Checks slippage and liquidity."""
    if fill_result is None:
        return _trans("NO_LIQUIDITY")
    ok = check_slippage_tolerance(
        fill_result["slippage_bps"],
        fill_result["avg_price"],
        registry["slippageTolerance"],
    )
    if not ok:
        return _trans("SLIPPAGE_EXCEEDED")
    return _pass()
