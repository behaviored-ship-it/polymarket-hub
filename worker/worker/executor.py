"""Orchestration: poll → guard → fill → write. Mirror of src/paper/tradeExecutor.js."""

from __future__ import annotations
import logging
import time
from datetime import datetime, timezone
from typing import Optional, Dict, Any
from zoneinfo import ZoneInfo

from .fill_simulator import simulate_buy_fill
from .guards import evaluate_pre_fill_guards, evaluate_fill_guards
from .resolver import resolve_position, AmbiguousResolutionError
from .polymarket_api import (
    fetch_activity,
    fetch_order_book,
    fetch_token_ids_uncached,
    fetch_open_positions,
    fetch_gamma_resolution,
)

log = logging.getLogger(__name__)

ET = ZoneInfo("America/New_York")
NEG_CACHE_TTL_SEC = 600  # 10 min — mirrors src/paper/api.js


# ── Time helpers (ET) ───────────────────────────────────────────────────────
def ts_to_et_date(unix_sec: float) -> str:
    d = datetime.fromtimestamp(unix_sec, tz=ET)
    return d.strftime("%Y-%m-%d")


def ts_to_et_hour(unix_sec: float) -> int:
    return datetime.fromtimestamp(unix_sec, tz=ET).hour


def today_et_string() -> str:
    return ts_to_et_date(time.time())


def et_day_start_unix(date_str: str) -> int:
    """Unix sec of midnight ET for a YYYY-MM-DD date."""
    naive = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=ET)
    return int(naive.timestamp())


# ── Token cache (Supabase-backed, with negative caching) ────────────────────
def get_or_fetch_tokens(store, condition_id: str) -> Dict[str, Any]:
    if not condition_id:
        return {"tokens": {}, "outcomes": []}

    cache_key = f"tokens_v2:{condition_id}"
    cached = store.get_market_cache(cache_key)
    if cached and cached.get("data"):
        ttl = cached.get("ttlSec")
        age_sec = (time.time() * 1000 - (cached.get("fetchedAt") or 0)) / 1000
        if ttl is None or age_sec < ttl:
            return cached["data"] if isinstance(cached["data"], dict) else {"tokens": {}, "outcomes": []}

    try:
        result = fetch_token_ids_uncached(condition_id)
    except Exception as e:
        log.warning("token fetch failed for %s: %s", condition_id, e)
        result = {"tokens": {}, "outcomes": []}

    if not result["tokens"]:
        # Negative-cache for 10 min
        store.put_market_cache(cache_key, result, ttl_sec=NEG_CACHE_TTL_SEC)
        return result

    store.put_market_cache(cache_key, result, ttl_sec=None)  # permanent
    return result


# ── Loss stats for guards (computed from existing trades) ───────────────────
def compute_loss_stats(store, registry_id: str) -> Dict[str, float]:
    trades = store.list_trades_for_registry(registry_id)
    today_str = today_et_string()
    today_cutoff = et_day_start_unix(today_str)
    week_cutoff = today_cutoff - 7 * 24 * 3600

    today_count = 0
    today_loss = 0.0
    week_loss = 0.0
    lifetime_loss = 0.0
    for t in trades:
        if t.get("status") == "skipped":
            continue
        if (t.get("openedAt") or 0) >= today_cutoff:
            today_count += 1
        if t.get("result") == "loss":
            loss = abs(t.get("pnl") or 0)
            lifetime_loss += loss
            if (t.get("resolvedAt") or 0) >= week_cutoff:
                week_loss += loss
            if (t.get("resolvedAt") or 0) >= today_cutoff:
                today_loss += loss
    return {
        "todayCount": today_count,
        "todayLossUsd": today_loss,
        "weekLossUsd": week_loss,
        "lifetimeLossUsd": lifetime_loss,
    }


# ── Skip recording ───────────────────────────────────────────────────────────
def record_skip(store, registry, leader_trade, reason, is_permanent) -> None:
    ts = leader_trade.get("timestamp") or 0
    poll_delay_ms = int(time.time() * 1000 - ts * 1000) if ts else None
    trade = {
        "id": f"pt_{registry['id']}_{leader_trade.get('conditionId', '')}_{ts}_skip",
        "registryId": registry["id"],
        "teamId": registry.get("teamId"),
        "conditionId": leader_trade.get("conditionId"),
        "tokenId": None,
        "title": leader_trade.get("title", ""),
        "category": leader_trade.get("category", ""),
        "outcome": leader_trade.get("outcome", ""),
        "entryPrice": None,
        "stake": None,
        "shares": None,
        "fee": None,
        "slippageBps": None,
        "midpointAtFill": None,
        "levelsFilled": None,
        "isPartial": False,
        "leaderStake": (leader_trade.get("totalBought") or 0) * (leader_trade.get("avgPrice") or 0),
        "leaderPrice": leader_trade.get("avgPrice"),
        "leaderTradeTs": ts,
        "openedAt": int(time.time()),
        "pollDelayMs": poll_delay_ms,
        "dateEt": today_et_string(),
        "hourEt": ts_to_et_hour(time.time()),
        "status": "skipped",
        "skipReason": reason,
        "isPermanentSkip": is_permanent,
        "exitPrice": None,
        "result": None,
        "pnl": None,
        "resolvedAt": None,
    }
    store.insert_trade(trade)
    log.info("[%s] SKIP %s: %s%s",
             registry.get("walletAddr", "?")[:10], leader_trade.get("conditionId", "")[:10], reason,
             " (permanent)" if is_permanent else "")


# ── Auto-pause check ─────────────────────────────────────────────────────────
def check_and_apply_auto_pause(store, registry) -> Optional[Dict[str, Any]]:
    account = store.get_account(registry["id"])
    if not account:
        return None
    ap = registry.get("autoPause") or {}
    realized_pnl = account["cash"] - registry["startBalance"]
    pct_of_start = (realized_pnl / registry["startBalance"]) * 100 if registry["startBalance"] else 0

    trip = None
    if ap.get("lossUsd") is not None and realized_pnl <= -ap["lossUsd"]:
        trip = f"loss_usd_{ap['lossUsd']}"
    elif ap.get("lossPct") is not None and pct_of_start <= -ap["lossPct"]:
        trip = f"loss_pct_{ap['lossPct']}"
    elif ap.get("profitUsd") is not None and realized_pnl >= ap["profitUsd"]:
        trip = f"profit_usd_{ap['profitUsd']}"
    elif ap.get("profitPct") is not None and pct_of_start >= ap["profitPct"]:
        trip = f"profit_pct_{ap['profitPct']}"

    if trip and registry.get("status") == "active":
        updated = {**registry, "status": "paused", "pauseReason": trip}
        store.update_registry(updated)
        log.info("[%s] AUTO-PAUSE tripped: %s", registry.get("walletAddr", "?")[:10], trip)
        return updated
    return None


# ── Single-trade execution ──────────────────────────────────────────────────
def execute_on_leader_trade(store, registry, leader_trade) -> None:
    try:
        account = store.get_account(registry["id"])
        if not account:
            log.error("no account for registry %s — paper trader not initialized", registry["id"])
            return

        open_positions = store.list_open_positions(registry["id"])
        loss_stats = compute_loss_stats(store, registry["id"])
        leader_had_prior = any(p.get("conditionId") == leader_trade.get("conditionId") for p in open_positions)

        ctx = {
            "leaderTrade": leader_trade,
            "registry": registry,
            "account": account,
            "openPositions": open_positions,
            "leaderHadPriorPosition": leader_had_prior,
            "eventId": leader_trade.get("eventId"),
            **loss_stats,
        }

        pre = evaluate_pre_fill_guards(ctx)
        if pre["skip"]:
            record_skip(store, registry, leader_trade, pre["reason"], pre["is_permanent"])
            return

        token_info = get_or_fetch_tokens(store, leader_trade.get("conditionId"))
        outcome_key = str(leader_trade.get("outcome", "")).strip().lower()
        token_id = token_info["tokens"].get(outcome_key)
        if not token_id:
            record_skip(store, registry, leader_trade, "TOKEN_NOT_FOUND", True)
            return

        try:
            book = fetch_order_book(token_id)
        except Exception:
            record_skip(store, registry, leader_trade, "BOOK_FETCH_FAILED", False)
            return

        fill = simulate_buy_fill(book["asks"], book["bids"], pre["stake"])
        fill_check = evaluate_fill_guards(registry, fill)
        if fill_check["skip"]:
            record_skip(store, registry, leader_trade, fill_check["reason"], fill_check["is_permanent"])
            return

        # Successful fill
        ts = leader_trade.get("timestamp") or 0
        trade_row = {
            "id": f"pt_{registry['id']}_{leader_trade.get('conditionId', '')}_{ts}",
            "registryId": registry["id"],
            "teamId": registry.get("teamId"),
            "conditionId": leader_trade.get("conditionId"),
            "tokenId": token_id,
            "title": leader_trade.get("title", ""),
            "category": leader_trade.get("category", ""),
            "outcome": leader_trade.get("outcome", ""),
            "entryPrice": fill["avg_price"],
            "stake": fill["total_cost"],
            "shares": fill["total_shares"],
            "fee": fill["fee"],
            "slippageBps": fill["slippage_bps"],
            "midpointAtFill": fill["midpoint"],
            "levelsFilled": fill["levels_filled"],
            "isPartial": fill["is_partial"],
            "leaderStake": (leader_trade.get("totalBought") or 0) * (leader_trade.get("avgPrice") or 0),
            "leaderPrice": leader_trade.get("avgPrice"),
            "leaderTradeTs": ts,
            "openedAt": int(time.time()),
            "pollDelayMs": int(time.time() * 1000 - ts * 1000) if ts else None,
            "dateEt": today_et_string(),
            "hourEt": ts_to_et_hour(time.time()),
            "status": "filled",
            "skipReason": None,
            "isPermanentSkip": False,
            "exitPrice": None,
            "result": None,
            "pnl": None,
            "resolvedAt": None,
        }
        store.insert_trade(trade_row)

        # Upsert position (weighted-avg entry on duplicate market+outcome)
        pos_id = f"{registry['id']}_{leader_trade.get('conditionId')}_{outcome_key}"
        existing = store.get_position(pos_id)
        new_shares = (existing.get("shares") if existing else 0) + fill["total_shares"]
        new_cost = (existing.get("totalCost") if existing else 0) + fill["total_cost"] + fill["fee"]
        new_avg = new_cost / new_shares if new_shares else 0
        store.upsert_position({
            "id": pos_id,
            "registryId": registry["id"],
            "teamId": registry.get("teamId"),
            "conditionId": leader_trade.get("conditionId"),
            "tokenId": token_id,
            "title": leader_trade.get("title", ""),
            "outcome": leader_trade.get("outcome", ""),
            "shares": new_shares,
            "avgEntryPrice": new_avg,
            "totalCost": new_cost,
            "realizedPnl": (existing.get("realizedPnl") if existing else 0) or 0,
            "peakUnrealizedPct": (existing.get("peakUnrealizedPct") if existing else 0) or 0,
            "isResolved": False,
            "resolvedAt": None,
            "resolvedPrice": None,
            "resolutionSource": None,
            "curPrice": None,
            "lastPriceTs": None,
        })

        # Decrement cash
        new_cash = account["cash"] - fill["total_cost"] - fill["fee"]
        new_peak = max(account.get("peakBalance") or new_cash, new_cash)
        store.update_account({
            "registryId": registry["id"],
            "cash": new_cash,
            "peakBalance": new_peak,
        })

        log.info("[%s] BUY %s @ %.3f stake $%.2f",
                 registry.get("walletAddr", "?")[:10],
                 (leader_trade.get("title") or "")[:40],
                 fill["avg_price"], fill["total_cost"])

        check_and_apply_auto_pause(store, registry)

    except Exception as e:
        log.exception("execute_on_leader_trade failed for %s: %s", registry.get("id"), e)


# ── Polling cycle for one registry ──────────────────────────────────────────
def poll_once(store, registry) -> None:
    if registry.get("status") != "active":
        return
    # Defensive floor: never look at trades older than createdAt, even if
    # lastPollTs got corrupted/reset to 0. Stops backfill spam on existing
    # rows where lastPollTs is stale.
    floor_ts = max(registry.get("lastPollTs") or 0, registry.get("createdAt") or 0)
    fresh = fetch_activity(registry["walletAddr"], floor_ts)
    buys = [
        t for t in fresh
        if t.get("conditionId") and t.get("outcome")
        and (not t.get("side") or str(t["side"]).upper() == "BUY")
    ]
    for t in buys:
        execute_on_leader_trade(store, registry, t)
    if fresh:
        max_ts = max(t.get("timestamp", 0) for t in fresh)
        if max_ts > (registry.get("lastPollTs") or 0):
            store.update_registry_last_poll_ts(registry["id"], max_ts)


# ── Resolution sweep for one registry ───────────────────────────────────────
def resolve_open_for_registry(store, registry) -> None:
    open_positions = store.list_open_positions(registry["id"])
    if not open_positions:
        return
    leader_open = []
    try:
        leader_open = fetch_open_positions(registry["walletAddr"])
    except Exception:
        pass

    for pos in open_positions:
        gamma = None
        try:
            res = resolve_position(pos, leader_open, None)
            if not res["resolved"]:
                gamma = fetch_gamma_resolution(pos["conditionId"])
                res = resolve_position(pos, leader_open, gamma)
        except AmbiguousResolutionError:
            log.warning("ambiguous resolution for %s — skipping", pos.get("conditionId"))
            continue
        except Exception as e:
            log.warning("resolution check failed for %s: %s", pos.get("conditionId"), e)
            continue
        if not res["resolved"]:
            continue

        proceeds = pos["shares"] * res["price"]
        realized = proceeds - pos["totalCost"]
        store.upsert_position({
            **pos,
            "isResolved": True,
            "resolvedAt": int(time.time()),
            "resolvedPrice": res["price"],
            "resolutionSource": res["source"],
            "realizedPnl": (pos.get("realizedPnl") or 0) + realized,
        })

        # Mark related trades as resolved
        all_trades = store.list_trades_for_registry(registry["id"])
        for t in all_trades:
            if (t.get("conditionId") == pos["conditionId"]
                    and t.get("status") == "filled" and not t.get("resolvedAt")):
                trade_proceeds = (t.get("shares") or 0) * res["price"]
                trade_pnl = trade_proceeds - (t.get("stake") or 0) - (t.get("fee") or 0)
                store.update_trade({
                    **t,
                    "status": "resolved",
                    "exitPrice": res["price"],
                    "result": "win" if res["price"] >= 0.99 else "loss",
                    "pnl": trade_pnl,
                    "resolvedAt": int(time.time()),
                })

        # Credit proceeds
        account = store.get_account(registry["id"])
        if account:
            new_cash = account["cash"] + proceeds
            new_peak = max(account.get("peakBalance") or new_cash, new_cash)
            store.update_account({
                "registryId": registry["id"],
                "cash": new_cash,
                "peakBalance": new_peak,
            })

        result_label = "WIN" if res["price"] >= 0.99 else "LOSS"
        log.info("[%s] %s %s pnl $%.2f",
                 registry.get("walletAddr", "?")[:10], result_label,
                 (pos.get("title") or "")[:40], realized)

        check_and_apply_auto_pause(store, registry)
