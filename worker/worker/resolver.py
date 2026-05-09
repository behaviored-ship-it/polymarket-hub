"""Position resolution. Ported from src/paper/resolvePosition.js.

Layered strategy:
1. Primary: redeemable + curPrice from leader's open positions endpoint
2. Secondary: Gamma outcomePrices array (matched by outcomes index)
3. Falls back to binary YES/NO assumption when outcomes array is missing
"""

from __future__ import annotations
from typing import Optional, Mapping, Any, Sequence

from .constants import WIN_PRICE_THRESHOLD, LOSS_PRICE_THRESHOLD


class AmbiguousResolutionError(Exception):
    def __init__(self, condition_id: str):
        super().__init__(f"Multiple winning outcomes for {condition_id}")
        self.condition_id = condition_id


def resolve_position(
    position: Mapping[str, Any],
    open_positions_resp: Optional[Sequence[Mapping[str, Any]]],
    gamma_resp: Optional[Mapping[str, Any]],
) -> dict:
    """Returns {resolved: True, price: 0.0|1.0, source: ...} or {resolved: False}.

    Raises AmbiguousResolutionError when Gamma reports multiple winners.
    """
    pos_outcome_lower = str(position.get("outcome", "")).lower()

    # Primary: redeemable + curPrice from leader's open positions endpoint
    if isinstance(open_positions_resp, (list, tuple)):
        for p in open_positions_resp:
            if p.get("conditionId") != position.get("conditionId"):
                continue
            if p.get("outcome") and str(p["outcome"]).lower() != pos_outcome_lower:
                continue
            if p.get("redeemable"):
                cur_price = p.get("curPrice", 0)
                try:
                    cur_price = float(cur_price)
                except (TypeError, ValueError):
                    cur_price = 0
                if cur_price >= WIN_PRICE_THRESHOLD:
                    return {"resolved": True, "price": 1.0, "source": "redeemable"}
                if cur_price <= LOSS_PRICE_THRESHOLD:
                    return {"resolved": True, "price": 0.0, "source": "redeemable"}
            break

    # Secondary: Gamma outcomePrices (use this NOT winningOutcome — unreliable)
    if gamma_resp and gamma_resp.get("outcomePrices"):
        prices_raw = gamma_resp["outcomePrices"]
        try:
            prices = [float(p) for p in prices_raw]
        except (TypeError, ValueError):
            prices = []

        winners = [(p, i) for i, p in enumerate(prices) if p >= WIN_PRICE_THRESHOLD]
        if len(winners) > 1:
            raise AmbiguousResolutionError(position.get("conditionId", ""))
        if len(winners) == 1:
            outcomes = gamma_resp.get("outcomes") or []
            our_outcome = str(position.get("outcome", "")).strip().lower()
            our_index = -1
            if isinstance(outcomes, (list, tuple)):
                for i, o in enumerate(outcomes):
                    if str(o).strip().lower() == our_outcome:
                        our_index = i
                        break
            if our_index == -1 and not outcomes:
                # Fallback: binary YES/NO assumption
                our_index = 0 if our_outcome == "yes" else 1 if our_outcome == "no" else -1
            if our_index == -1:
                return {"resolved": False}
            won = winners[0][1] == our_index
            return {"resolved": True, "price": 1.0 if won else 0.0, "source": "outcomePrices"}

        if prices and all(p == 0.5 for p in prices):
            return {"resolved": False}  # explicitly not yet resolved

    return {"resolved": False}
