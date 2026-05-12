"""One-shot diagnostic for stuck "open" positions.

Walks every open position across every registry, calls the same resolver logic
the scheduler uses, and prints a verdict for each:

  RESOLVED-WOULD-MARK  — resolver returns resolved=True. The fact that this row
                        is still open means the sweep isn't running, or the
                        write is failing silently. Check Railway logs.

  LEADER-STILL-OPEN    — leader's positions endpoint still lists this market as
                        open and not redeemable. Market is genuinely live; we
                        wait. (Or leader sold and we're holding to resolution —
                        documented buys-only behavior.)

  GAMMA-LIVE           — Gamma says outcomePrices are still 50/50 or non-final.
                        Market not yet resolved on Polymarket.

  GAMMA-NO-DATA        — Gamma returned no market or empty outcomePrices.
                        Possibly a bad conditionId or an unusual market shape.

  AMBIGUOUS            — Multiple winners in Gamma; resolver refuses to choose.

  ERROR                — Something blew up fetching or resolving.

Run from the worker/ directory:

  python -m worker.diagnose
"""

from __future__ import annotations
import logging
import sys
from typing import Any, Dict, List

from .config import get_config
from .polymarket_api import fetch_gamma_resolution, fetch_open_positions
from .resolver import resolve_position, AmbiguousResolutionError
from .supabase_client import SupabaseStore, get_client


def all_open_positions(store: SupabaseStore) -> List[Dict[str, Any]]:
    rows = (
        store.client.table("pt_positions")
        .select("*")
        .eq("is_resolved", False)
        .execute()
        .data
    )
    if not isinstance(rows, list):
        return []
    from .supabase_client import camelize_many

    return camelize_many(rows)


def registry_wallet(store: SupabaseStore, registry_id: str) -> str | None:
    resp = (
        store.client.table("pt_registry")
        .select("wallet_addr,nickname,status")
        .eq("id", registry_id)
        .maybe_single()
        .execute()
    )
    return resp.data if resp and resp.data else None


def verdict_for(pos, leader_open_cache):
    wallet = pos.get("_wallet")
    leader_open = leader_open_cache.get(wallet) or []
    gamma = None

    try:
        res = resolve_position(pos, leader_open, None)
        if res["resolved"]:
            return "RESOLVED-WOULD-MARK", f"price={res['price']} src={res['source']}"

        gamma = fetch_gamma_resolution(pos.get("conditionId") or "")
        res = resolve_position(pos, leader_open, gamma)
        if res["resolved"]:
            return "RESOLVED-WOULD-MARK", f"price={res['price']} src={res['source']}"

        # Not resolved — diagnose why.
        leader_match = next(
            (
                p
                for p in leader_open
                if p.get("conditionId") == pos.get("conditionId")
            ),
            None,
        )
        if leader_match is not None and not leader_match.get("redeemable"):
            return "LEADER-STILL-OPEN", f"curPrice={leader_match.get('curPrice')}"

        if gamma is None or not gamma.get("outcomePrices"):
            return "GAMMA-NO-DATA", f"gamma={gamma!r}"

        prices = gamma.get("outcomePrices") or []
        return "GAMMA-LIVE", f"outcomePrices={prices} closed={gamma.get('closed')}"

    except AmbiguousResolutionError as e:
        return "AMBIGUOUS", str(e)
    except Exception as e:  # noqa: BLE001 — diagnostic catch-all
        return "ERROR", repr(e)


def main() -> int:
    logging.basicConfig(
        level=logging.WARNING,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    config = get_config()
    store = SupabaseStore(get_client(config))

    opens = all_open_positions(store)
    if not opens:
        print("No open positions across any registry. Nothing stuck.")
        return 0

    # Attach wallet to each pos and pre-fetch leader_open per wallet
    wallet_by_registry: Dict[str, str] = {}
    for p in opens:
        reg_id = p.get("registryId")
        if reg_id and reg_id not in wallet_by_registry:
            reg = registry_wallet(store, reg_id)
            wallet_by_registry[reg_id] = (reg or {}).get("wallet_addr") or ""
        p["_wallet"] = wallet_by_registry.get(reg_id, "")

    leader_open_cache: Dict[str, list] = {}
    for wallet in {p["_wallet"] for p in opens if p["_wallet"]}:
        try:
            leader_open_cache[wallet] = fetch_open_positions(wallet)
        except Exception as e:  # noqa: BLE001
            print(f"  [warn] could not fetch leader_open for {wallet}: {e}")
            leader_open_cache[wallet] = []

    print(f"\nFound {len(opens)} open position(s) across {len(wallet_by_registry)} registry/registries.\n")
    print(f"{'STATUS':<22}  {'CONDITION':<12}  {'OUTCOME':<8}  {'TITLE':<40}  DETAILS")
    print("-" * 120)

    counts: Dict[str, int] = {}
    for p in opens:
        status, detail = verdict_for(p, leader_open_cache)
        counts[status] = counts.get(status, 0) + 1
        cid = (p.get("conditionId") or "")[:10]
        outcome = (p.get("outcome") or "")[:8]
        title = (p.get("title") or "")[:40]
        print(f"{status:<22}  {cid:<12}  {outcome:<8}  {title:<40}  {detail}")

    print("\nSummary:")
    for status, n in sorted(counts.items(), key=lambda x: -x[1]):
        print(f"  {status}: {n}")

    print(
        "\nInterpretation:\n"
        "  RESOLVED-WOULD-MARK → sweep isn't running or writes are silently\n"
        "    failing. Check Railway logs for 'resolution failed' or restart\n"
        "    the worker.\n"
        "  LEADER-STILL-OPEN / GAMMA-LIVE → working as designed. Market is\n"
        "    actually live or leader hasn't redeemed. Buys-only means we hold.\n"
        "  GAMMA-NO-DATA → check the conditionId. May be a delisted/unusual\n"
        "    market or Gamma is rate-limiting.\n"
        "  AMBIGUOUS → manual call needed; resolver refuses to pick.\n"
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
