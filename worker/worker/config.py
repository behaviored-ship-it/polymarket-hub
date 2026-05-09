"""Env-driven config. Loaded once at startup."""

from __future__ import annotations
import os
from dataclasses import dataclass

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv is optional; Railway sets env vars directly


@dataclass(frozen=True)
class Config:
    supabase_url: str
    service_key: str
    poll_trades_sec: int
    poll_resolution_sec: int
    scheduler_tick_sec: int
    poll_jitter_sec: float
    log_level: str


def get_config() -> Config:
    """Read env vars. Raises KeyError if SUPABASE_URL/SERVICE_KEY missing."""
    return Config(
        supabase_url=os.environ["SUPABASE_URL"],
        service_key=os.environ["SUPABASE_SERVICE_KEY"],
        poll_trades_sec=int(os.getenv("POLL_TRADES_SEC", "30")),
        poll_resolution_sec=int(os.getenv("POLL_RESOLUTION_SEC", "60")),
        scheduler_tick_sec=int(os.getenv("SCHEDULER_TICK_SEC", "10")),
        poll_jitter_sec=float(os.getenv("POLL_JITTER_SEC", "5")),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
    )
