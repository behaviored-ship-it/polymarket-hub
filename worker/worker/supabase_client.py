"""Supabase wrapper. Handles snake_case ↔ camelCase translation at the boundary
so the executor/guards code can keep using camelCase like the JS engine.

Uses the SERVICE ROLE KEY which bypasses RLS — the worker can read/write rows
for any team. Never expose this key to the frontend.
"""

from __future__ import annotations
import logging
import re
import time
from typing import Optional, List, Dict, Any

from supabase import create_client, Client

from .config import Config

log = logging.getLogger(__name__)


def get_client(config: Config) -> Client:
    return create_client(config.supabase_url, config.service_key)


# ── Snake/camel converters ──────────────────────────────────────────────────
_SNAKE_RE = re.compile(r"_([a-z0-9])")
_CAMEL_RE = re.compile(r"([A-Z0-9]+)")


def to_snake(s: str) -> str:
    return _CAMEL_RE.sub(lambda m: ("_" if m.start() > 0 else "") + m.group(1).lower(), s)


def to_camel(s: str) -> str:
    return _SNAKE_RE.sub(lambda m: m.group(1).upper(), s)


def camelize_row(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not row:
        return row
    return {to_camel(k): v for k, v in row.items()}


def snakeify_row(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not row:
        return row
    return {to_snake(k): v for k, v in row.items()}


def camelize_many(rows) -> list:
    if not isinstance(rows, list):
        return []
    return [camelize_row(r) for r in rows]


# ── Store (typed wrapper around the supabase client) ─────────────────────────
class SupabaseStore:
    def __init__(self, client: Client):
        self.client = client

    # -- registry --
    def list_active_registries(self) -> List[Dict[str, Any]]:
        resp = self.client.table("pt_registry").select("*").eq("status", "active").execute()
        return camelize_many(resp.data)

    def update_registry_last_poll_ts(self, registry_id: str, ts: int) -> None:
        self.client.table("pt_registry").update({"last_poll_ts": ts}).eq("id", registry_id).execute()

    def update_registry(self, registry: Dict[str, Any]) -> None:
        snake = snakeify_row(registry)
        self.client.table("pt_registry").update(snake).eq("id", registry["id"]).execute()

    # -- accounts --
    def get_account(self, registry_id: str) -> Optional[Dict[str, Any]]:
        resp = self.client.table("pt_accounts").select("*").eq("registry_id", registry_id).maybe_single().execute()
        return camelize_row(resp.data) if resp and resp.data else None

    def update_account(self, account: Dict[str, Any]) -> None:
        snake = snakeify_row(account)
        self.client.table("pt_accounts").update(snake).eq("registry_id", account["registryId"]).execute()

    # -- trades --
    def insert_trade(self, trade: Dict[str, Any]) -> None:
        snake = snakeify_row(trade)
        self.client.table("pt_trades").upsert(snake).execute()

    def list_trades_for_registry(self, registry_id: str, limit: int = 1000) -> List[Dict[str, Any]]:
        resp = (
            self.client.table("pt_trades")
            .select("*")
            .eq("registry_id", registry_id)
            .order("opened_at", desc=True)
            .limit(limit)
            .execute()
        )
        return camelize_many(resp.data)

    def update_trade(self, trade: Dict[str, Any]) -> None:
        snake = snakeify_row(trade)
        self.client.table("pt_trades").update(snake).eq("id", trade["id"]).execute()

    # -- positions --
    def list_open_positions(self, registry_id: str) -> List[Dict[str, Any]]:
        resp = (
            self.client.table("pt_positions").select("*")
            .eq("registry_id", registry_id).eq("is_resolved", False).execute()
        )
        return camelize_many(resp.data)

    def list_positions_for_registry(self, registry_id: str) -> List[Dict[str, Any]]:
        resp = self.client.table("pt_positions").select("*").eq("registry_id", registry_id).execute()
        return camelize_many(resp.data)

    def get_position(self, position_id: str) -> Optional[Dict[str, Any]]:
        resp = self.client.table("pt_positions").select("*").eq("id", position_id).maybe_single().execute()
        return camelize_row(resp.data) if resp and resp.data else None

    def upsert_position(self, position: Dict[str, Any]) -> None:
        snake = snakeify_row(position)
        self.client.table("pt_positions").upsert(snake).execute()

    # -- market_cache --
    def get_market_cache(self, cache_key: str) -> Optional[Dict[str, Any]]:
        resp = self.client.table("pt_market_cache").select("*").eq("cache_key", cache_key).maybe_single().execute()
        return camelize_row(resp.data) if resp and resp.data else None

    def put_market_cache(self, cache_key: str, data: Any, ttl_sec: Optional[int] = None) -> None:
        import json
        row = {
            "cache_key": cache_key,
            "data": data if isinstance(data, (dict, list)) else json.loads(data) if isinstance(data, str) else data,
            "fetched_at": int(time.time() * 1000),  # ms — matches IDB convention
            "ttl_sec": ttl_sec,
        }
        self.client.table("pt_market_cache").upsert(row).execute()
