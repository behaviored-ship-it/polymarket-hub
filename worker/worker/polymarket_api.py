"""HTTP client for Polymarket public APIs. Sync httpx — fine at our scale."""

from __future__ import annotations
import json
import logging
from typing import Optional, List, Dict, Any

import httpx

from .constants import (
    ACTIVITY_URL,
    CLOB_BOOK_URL,
    GAMMA_MARKETS_URL,
    POSITIONS_URL_TEMPLATE,
    ACTIVITY_PAGE_LIMIT,
)

log = logging.getLogger(__name__)

# Module-level client for connection reuse. Configurable timeout.
_client: Optional[httpx.Client] = None


def get_client() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(timeout=15.0, follow_redirects=True)
    return _client


def close_client() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None


# ── Activity (paginated) ─────────────────────────────────────────────────────
def fetch_activity(wallet_addr: str, since_ts: int = 0, max_pages: int = 10) -> List[Dict[str, Any]]:
    """Returns trades newer than since_ts, ascending. Pages backwards until oldest <= since_ts."""
    client = get_client()
    collected: List[Dict[str, Any]] = []
    offset = 0
    for _ in range(max_pages):
        url = (
            f"{ACTIVITY_URL}?user={wallet_addr.lower()}"
            f"&limit={ACTIVITY_PAGE_LIMIT}&offset={offset}"
            f"&sortBy=TIMESTAMP&sortDirection=DESC"
        )
        try:
            resp = client.get(url)
            resp.raise_for_status()
            batch = resp.json()
        except httpx.HTTPError as e:
            log.warning("activity fetch failed for %s: %s", wallet_addr, e)
            break
        if not isinstance(batch, list) or not batch:
            break
        collected.extend(batch)
        oldest_ts = batch[-1].get("timestamp", 0)
        if oldest_ts <= since_ts:
            break
        if len(batch) < ACTIVITY_PAGE_LIMIT:
            break
        offset += ACTIVITY_PAGE_LIMIT

    fresh = [t for t in collected if (t.get("timestamp", 0) > since_ts)]
    fresh.sort(key=lambda t: t.get("timestamp", 0))
    return fresh


# ── CLOB order book ──────────────────────────────────────────────────────────
def fetch_order_book(token_id: str) -> Dict[str, list]:
    if not token_id:
        return {"asks": [], "bids": []}
    client = get_client()
    try:
        resp = client.get(f"{CLOB_BOOK_URL}?token_id={token_id}")
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPError as e:
        log.warning("book fetch failed for %s: %s", token_id, e)
        return {"asks": [], "bids": []}
    return {
        "asks": data.get("asks") or [],
        "bids": data.get("bids") or [],
    }


# ── Gamma market metadata ────────────────────────────────────────────────────
def _safe_json_parse_array(s: str) -> list:
    try:
        parsed = json.loads(s)
        return parsed if isinstance(parsed, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def fetch_gamma_market_raw(condition_id: str) -> Optional[dict]:
    if not condition_id:
        return None
    client = get_client()
    try:
        resp = client.get(f"{GAMMA_MARKETS_URL}?condition_ids={condition_id}")
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPError as e:
        log.warning("gamma fetch failed for %s: %s", condition_id, e)
        return None
    if isinstance(data, list):
        return data[0] if data else None
    return data


def fetch_token_ids_uncached(condition_id: str) -> Dict[str, Any]:
    """Returns { tokens: { outcome_lower: token_id }, outcomes: [...] }.
    Caching is the executor's job (passes through SupabaseStore.market_cache).
    """
    market = fetch_gamma_market_raw(condition_id)
    if not market or not market.get("tokens"):
        return {"tokens": {}, "outcomes": []}
    tokens_raw = market["tokens"] if isinstance(market["tokens"], list) else []
    tokens: Dict[str, str] = {}
    outcomes: list = []
    for t in tokens_raw:
        outcome = str(t.get("outcome", "")).strip()
        token_id = t.get("token_id")
        if not outcome or not token_id:
            continue
        tokens[outcome.lower()] = token_id
        outcomes.append(outcome)
    return {"tokens": tokens, "outcomes": outcomes}


def fetch_gamma_resolution(condition_id: str) -> Optional[dict]:
    market = fetch_gamma_market_raw(condition_id)
    if not market:
        return None
    op = market.get("outcomePrices")
    if isinstance(op, str):
        op = _safe_json_parse_array(op)
    elif not isinstance(op, list):
        op = []
    o = market.get("outcomes")
    if isinstance(o, str):
        o = _safe_json_parse_array(o)
    elif not isinstance(o, list):
        o = []
    return {"outcomePrices": op, "outcomes": o, "closed": bool(market.get("closed"))}


# ── Open positions for a wallet ──────────────────────────────────────────────
def fetch_open_positions(wallet_addr: str) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        resp = client.get(f"{POSITIONS_URL_TEMPLATE}?user={wallet_addr}&sizeThreshold=0.01")
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPError as e:
        log.warning("open positions fetch failed for %s: %s", wallet_addr, e)
        return []
    return data if isinstance(data, list) else []
