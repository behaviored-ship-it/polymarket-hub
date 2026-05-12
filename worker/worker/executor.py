"""Orchestration: poll → guard → fill → write. Mirror of src/paper/tradeExecutor.js."""

from __future__ import annotations
import logging
import time
from datetime import datetime, timezone
from typing import Optional, Dict, Any
from zoneinfo import ZoneInfo

from .fill_simulator import simulate_buy_fill, simulate_sell_fill
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

    # v3 bump: invalidates v2 negative-cached entries that wrongly said "no tokens"
    # back when we only checked the tokens field instead of clobTokenIds.
    cache_key = f"tokens_v3:{condition_id}"
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
    side_raw = str(leader_trade.get("side") or "BUY").upper()
    side = "sell" if side_raw == "SELL" else "buy"
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
        "side": side,
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
            "side": "buy",
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


# ── SELL handler ────────────────────────────────────────────────────────────
def _compute_sell_fraction(leader_open_positions, condition_id, outcome, leader_sell_shares):
    """How much of OUR position to close, given the leader's sell.

    leader_open_positions = the leader's positions *after* the sell. So their
    pre-sell holding for this market was current + sell_shares. The fraction
    they unloaded is sell_shares / (current + sell_shares). If they have no
    remaining position visible, treat as 100% exit.
    """
    if leader_sell_shares <= 0:
        return 0.0
    outcome_lc = str(outcome or "").lower()
    current = 0.0
    for p in leader_open_positions or []:
        if p.get("conditionId") != condition_id:
            continue
        if p.get("outcome") and str(p["outcome"]).lower() != outcome_lc:
            continue
        try:
            current = float(p.get("size") or p.get("totalBought") or 0)
        except (TypeError, ValueError):
            current = 0.0
        break
    prior = current + leader_sell_shares
    if prior <= 0:
        return 1.0
    return min(1.0, leader_sell_shares / prior)


def execute_on_leader_sell(store, registry, leader_trade) -> None:
    """Mirror a leader SELL on our matching open paper position.

    Bypasses entry guards (the position is already open — closing is risk
    management, not a new commitment). Slippage is recorded on the sell row
    for stats but never causes a skip. SELLs without a matching open position
    are silently ignored.
    """
    try:
        outcome_key = str(leader_trade.get("outcome", "")).strip().lower()
        cond_id = leader_trade.get("conditionId")
        if not cond_id or not outcome_key:
            return

        pos_id = f"{registry['id']}_{cond_id}_{outcome_key}"
        position = store.get_position(pos_id)
        if not position or position.get("isResolved") or (position.get("shares") or 0) <= 0:
            # No matching open paper position to close. Silently ignore.
            return

        account = store.get_account(registry["id"])
        if not account:
            log.error("no account for registry %s — skipping sell", registry["id"])
            return

        # How much of OUR position do we close?
        mirror_mode = registry.get("sellMirrorMode") or "proportional"
        our_shares = float(position.get("shares") or 0)
        if mirror_mode == "all_or_nothing":
            shares_to_sell = our_shares
            sell_fraction = 1.0
        else:
            leader_sell_shares = float(leader_trade.get("totalBought") or 0)
            try:
                leader_open = fetch_open_positions(registry["walletAddr"])
            except Exception:
                leader_open = []
            sell_fraction = _compute_sell_fraction(leader_open, cond_id, leader_trade.get("outcome"), leader_sell_shares)
            shares_to_sell = our_shares * sell_fraction

        if shares_to_sell <= 0:
            return

        # Need the order book to simulate the sell fill on real bids.
        token_info = get_or_fetch_tokens(store, cond_id)
        token_id = token_info["tokens"].get(outcome_key)
        if not token_id:
            log.warning("[%s] SELL aborted — no token for %s", registry.get("walletAddr", "?")[:10], cond_id[:10])
            return
        try:
            book = fetch_order_book(token_id)
        except Exception:
            log.warning("[%s] SELL aborted — book fetch failed for %s", registry.get("walletAddr", "?")[:10], cond_id[:10])
            return

        fill = simulate_sell_fill(book["asks"], book["bids"], shares_to_sell)
        if not fill:
            log.warning("[%s] SELL aborted — empty book or zero fill for %s",
                        registry.get("walletAddr", "?")[:10], cond_id[:10])
            return

        # Compute the cost basis of the shares we're closing (proportional to
        # the fraction of our position being closed). PnL is the net of
        # proceeds (after fee) minus that proportional cost.
        prior_shares = our_shares
        prior_total_cost = float(position.get("totalCost") or 0)
        cost_basis_closed = prior_total_cost * (fill["total_shares"] / prior_shares) if prior_shares > 0 else 0.0
        proceeds_net = fill["total_proceeds"] - fill["fee"]
        realized = proceeds_net - cost_basis_closed

        # Update the paper position: shrink shares + total_cost proportionally,
        # mark resolved if we sold all of it.
        new_shares = prior_shares - fill["total_shares"]
        # Float drift: snap near-zero to zero.
        if new_shares < 0.0001:
            new_shares = 0.0
        new_total_cost = prior_total_cost - cost_basis_closed
        if new_total_cost < 0:
            new_total_cost = 0.0
        fully_closed = new_shares <= 0
        store.upsert_position({
            **position,
            "shares": new_shares,
            "totalCost": new_total_cost,
            "realizedPnl": (position.get("realizedPnl") or 0) + realized,
            "isResolved": fully_closed,
            "resolvedAt": int(time.time()) if fully_closed else position.get("resolvedAt"),
            "resolvedPrice": fill["avg_price"] if fully_closed else position.get("resolvedPrice"),
            "resolutionSource": "sold" if fully_closed else position.get("resolutionSource"),
        })

        # Record the SELL as its own trade row. status='resolved' + exit_reason='sold'.
        ts = leader_trade.get("timestamp") or 0
        result = "win" if realized > 0 else "loss"
        store.insert_trade({
            "id": f"pt_{registry['id']}_{cond_id}_{ts}_sell",
            "registryId": registry["id"],
            "teamId": registry.get("teamId"),
            "conditionId": cond_id,
            "tokenId": token_id,
            "title": position.get("title") or leader_trade.get("title", ""),
            "category": leader_trade.get("category", ""),
            "outcome": leader_trade.get("outcome", ""),
            "entryPrice": position.get("avgEntryPrice"),
            "stake": cost_basis_closed,
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
            "status": "resolved",
            "skipReason": None,
            "isPermanentSkip": False,
            "exitPrice": fill["avg_price"],
            "result": result,
            "pnl": realized,
            "resolvedAt": int(time.time()),
            "exitReason": "sold",
            "side": "sell",
        })

        # Credit cash with the net proceeds.
        new_cash = account["cash"] + proceeds_net
        new_peak = max(account.get("peakBalance") or new_cash, new_cash)
        store.update_account({
            "registryId": registry["id"],
            "cash": new_cash,
            "peakBalance": new_peak,
        })

        log.info("[%s] SELL %s %.0f%% of pos @ %.3f pnl $%.2f%s",
                 registry.get("walletAddr", "?")[:10],
                 (position.get("title") or "")[:40],
                 sell_fraction * 100,
                 fill["avg_price"], realized,
                 " (full close)" if fully_closed else "")

        check_and_apply_auto_pause(store, registry)

    except Exception as e:
        log.exception("execute_on_leader_sell failed for %s: %s", registry.get("id"), e)


# ── Polling cycle for one registry ──────────────────────────────────────────
def poll_once(store, registry) -> None:
    if registry.get("status") != "active":
        return
    # Defensive floor: never look at trades older than createdAt, even if
    # lastPollTs got corrupted/reset to 0. Stops backfill spam on existing
    # rows where lastPollTs is stale.
    floor_ts = max(registry.get("lastPollTs") or 0, registry.get("createdAt") or 0)
    fresh = fetch_activity(registry["walletAddr"], floor_ts)
    copy_sells = registry.get("copyMode") != "buys_only"
    actionable = [
        t for t in fresh
        if t.get("conditionId") and t.get("outcome")
    ]
    # Process oldest-first so SELLs that follow a BUY in the same poll cycle
    # find the position they're meant to close.
    for t in actionable:
        side = str(t.get("side") or "BUY").upper()
        if side == "BUY":
            execute_on_leader_trade(store, registry, t)
        elif side == "SELL" and copy_sells:
            execute_on_leader_sell(store, registry, t)
        # Other sides (rare event types) are ignored.
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
                    "exitReason": "settled",
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
