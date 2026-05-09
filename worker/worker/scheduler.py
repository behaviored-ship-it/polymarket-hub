"""Long-running scheduler. Picks active registries every tick, dispatches polls
with per-trader jitter, runs resolution sweeps less often.

Sync code — fine at our scale (a handful of wallets, polled every 30s). If we
ever need true concurrency we can switch to httpx.AsyncClient + asyncio.
"""

from __future__ import annotations
import logging
import random
import time
from typing import Dict, Any

from .config import Config
from .executor import poll_once, resolve_open_for_registry
from .supabase_client import SupabaseStore

log = logging.getLogger(__name__)


class Scheduler:
    def __init__(self, store: SupabaseStore, config: Config):
        self.store = store
        self.config = config
        self.state: Dict[str, Dict[str, float]] = {}
        self._stop = False

    def _get_state(self, registry_id: str) -> Dict[str, float]:
        if registry_id not in self.state:
            self.state[registry_id] = {
                "last_poll_at": 0.0,
                "last_resolve_at": 0.0,
                "jitter": random.uniform(0, self.config.poll_jitter_sec),
            }
        return self.state[registry_id]

    def trade_tick(self) -> None:
        try:
            active = self.store.list_active_registries()
        except Exception as e:
            log.error("failed to list active registries: %s", e)
            return
        now = time.time()
        for r in active:
            s = self._get_state(r["id"])
            if now - s["last_poll_at"] < self.config.poll_trades_sec + s["jitter"]:
                continue
            s["last_poll_at"] = now
            try:
                poll_once(self.store, r)
            except Exception as e:
                log.error("poll_once failed for %s: %s", r.get("walletAddr"), e)

    def resolution_tick(self) -> None:
        try:
            active = self.store.list_active_registries()
        except Exception as e:
            log.error("failed to list active registries (resolution): %s", e)
            return
        now = time.time()
        for r in active:
            s = self._get_state(r["id"])
            if now - s["last_resolve_at"] < self.config.poll_resolution_sec:
                continue
            s["last_resolve_at"] = now
            try:
                resolve_open_for_registry(self.store, r)
            except Exception as e:
                log.error("resolution failed for %s: %s", r.get("walletAddr"), e)

    def stop(self) -> None:
        self._stop = True

    def run_forever(self) -> None:
        log.info(
            "scheduler running: poll_trades=%ds resolution=%ds tick=%ds",
            self.config.poll_trades_sec, self.config.poll_resolution_sec, self.config.scheduler_tick_sec,
        )
        last_resolve = 0.0
        while not self._stop:
            tick_start = time.time()
            self.trade_tick()
            # Run resolution roughly every poll_resolution_sec
            if time.time() - last_resolve >= self.config.poll_resolution_sec:
                self.resolution_tick()
                last_resolve = time.time()
            elapsed = time.time() - tick_start
            sleep_for = max(1.0, self.config.scheduler_tick_sec - elapsed)
            time.sleep(sleep_for)
