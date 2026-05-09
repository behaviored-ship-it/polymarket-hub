"""Pure-function order-book fill simulator. Ported from src/paper/useFillSimulator.js.

Math must match the JS side exactly — same fee formula, same slippage in bps,
same FOK/FAK semantics. The 28 JS tests in useFillSimulator.test.js have
mirror tests in tests/test_fill_simulator.py.
"""

from __future__ import annotations
from typing import Optional, Sequence, Mapping, Any

from .constants import FEE_RATE_BPS, FEE_MIN, SLIP_BOUNDARY_HIGH, SLIP_BOUNDARY_LOW


def _to_num(x) -> Optional[float]:
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, str):
        try:
            return float(x)
        except ValueError:
            return None
    return None


def _normalize_levels(levels) -> list[dict]:
    """CLOB returns price/size as strings. Coerce, drop empty levels."""
    if not isinstance(levels, (list, tuple)):
        return []
    out = []
    for lvl in levels:
        if not isinstance(lvl, Mapping):
            continue
        price = _to_num(lvl.get("price"))
        size = _to_num(lvl.get("size"))
        if price is None or size is None or size <= 0:
            continue
        out.append({"price": price, "size": size})
    return out


def compute_fee(avg_price: float, total_cost: float, fee_rate_bps: int = FEE_RATE_BPS) -> float:
    """Polymarket fee: (bps/10000) * min(p, 1-p) * cost, with floor of FEE_MIN."""
    if not (total_cost > 0) or fee_rate_bps <= 0:
        return 0.0
    raw = (fee_rate_bps / 10_000) * min(avg_price, 1 - avg_price) * total_cost
    return max(raw, FEE_MIN)


def compute_slippage_bps(avg_price: float, midpoint: float) -> float:
    if not (midpoint > 0):
        return 0.0
    return ((avg_price - midpoint) / midpoint) * 10_000


def simulate_buy_fill(
    asks_raw: Sequence[Any],
    bids_raw: Sequence[Any],
    amount_usd: float,
    order_type: str = "fak",
) -> Optional[dict]:
    """Walk ASKs from cheapest up. Returns None if no liquidity or FOK rejected.

    order_type: 'fak' (default, accepts partial) or 'fok' (reject if can't fill).
    """
    if not (amount_usd > 0):
        return None

    asks = sorted(_normalize_levels(asks_raw), key=lambda x: x["price"])
    bids = sorted(_normalize_levels(bids_raw), key=lambda x: -x["price"])
    if len(asks) == 0:
        return None

    remaining = float(amount_usd)
    total_shares = 0.0
    total_cost = 0.0
    fills: list[dict] = []

    for lvl in asks:
        if remaining <= 0:
            break
        level_cost = lvl["size"] * lvl["price"]
        if level_cost <= remaining:
            total_shares += lvl["size"]
            total_cost += level_cost
            remaining -= level_cost
            fills.append({"price": lvl["price"], "size": lvl["size"]})
        else:
            partial_shares = remaining / lvl["price"]
            total_shares += partial_shares
            total_cost += remaining
            fills.append({"price": lvl["price"], "size": partial_shares})
            remaining = 0
            break

    if not fills or total_shares <= 0:
        return None
    if order_type == "fok" and remaining > 0.01:
        return None

    avg_price = total_cost / total_shares
    best_ask = asks[0]["price"]
    best_bid = bids[0]["price"] if bids else 0
    midpoint = (best_ask + best_bid) / 2 if best_bid > 0 else best_ask
    slippage_bps = compute_slippage_bps(avg_price, midpoint)
    fee = compute_fee(avg_price, total_cost)

    return {
        "avg_price": avg_price,
        "total_shares": total_shares,
        "total_cost": total_cost,
        "fee": fee,
        "slippage_bps": slippage_bps,
        "midpoint": midpoint,
        "levels_filled": len(fills),
        "is_partial": remaining > 0.01,
        "fills": fills,
    }


def simulate_sell_fill(
    asks_raw: Sequence[Any],
    bids_raw: Sequence[Any],
    shares_to_sell: float,
    order_type: str = "fak",
) -> Optional[dict]:
    """Walk BIDs from highest down. Mirror of simulate_buy_fill, kept for v1.1."""
    if not (shares_to_sell > 0):
        return None

    asks = sorted(_normalize_levels(asks_raw), key=lambda x: x["price"])
    bids = sorted(_normalize_levels(bids_raw), key=lambda x: -x["price"])
    if len(bids) == 0:
        return None

    remaining_shares = float(shares_to_sell)
    total_shares = 0.0
    total_proceeds = 0.0
    fills: list[dict] = []

    for lvl in bids:
        if remaining_shares <= 0:
            break
        if lvl["size"] <= remaining_shares:
            total_shares += lvl["size"]
            total_proceeds += lvl["size"] * lvl["price"]
            remaining_shares -= lvl["size"]
            fills.append({"price": lvl["price"], "size": lvl["size"]})
        else:
            total_shares += remaining_shares
            total_proceeds += remaining_shares * lvl["price"]
            fills.append({"price": lvl["price"], "size": remaining_shares})
            remaining_shares = 0
            break

    if not fills or total_shares <= 0:
        return None
    if order_type == "fok" and remaining_shares > 0.0001:
        return None

    avg_price = total_proceeds / total_shares
    best_bid = bids[0]["price"]
    best_ask = asks[0]["price"] if asks else 1
    midpoint = (best_ask + best_bid) / 2 if best_ask < 1 else best_bid
    slippage_bps = compute_slippage_bps(midpoint, avg_price)
    fee = compute_fee(avg_price, total_proceeds)

    return {
        "avg_price": avg_price,
        "total_shares": total_shares,
        "total_proceeds": total_proceeds,
        "fee": fee,
        "slippage_bps": slippage_bps,
        "midpoint": midpoint,
        "levels_filled": len(fills),
        "is_partial": remaining_shares > 0.0001,
        "fills": fills,
    }


def check_slippage_tolerance(slippage_bps: float, avg_price: float, tolerance: Mapping[str, float]) -> bool:
    """Returns True if slippage is within the price-tier limit."""
    slip_pct = slippage_bps / 100  # bps → %
    if avg_price >= SLIP_BOUNDARY_HIGH:
        limit = tolerance["above40c"]
    elif avg_price >= SLIP_BOUNDARY_LOW:
        limit = tolerance["between18_40c"]
    else:
        limit = tolerance["below18c"]
    return slip_pct <= limit
