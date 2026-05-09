"""Worker entry point. Runs as `python -m worker.main` on Railway."""

from __future__ import annotations
import logging
import signal
import sys

from .config import get_config
from .scheduler import Scheduler
from .supabase_client import SupabaseStore, get_client


def main() -> None:
    config = get_config()
    logging.basicConfig(
        level=getattr(logging, config.log_level, logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    log = logging.getLogger("worker")

    log.info("Polyhub paper trader worker starting")
    log.info("Supabase URL: %s", config.supabase_url)
    client = get_client(config)
    store = SupabaseStore(client)
    scheduler = Scheduler(store, config)

    def _shutdown(signum, _frame):
        log.info("Received signal %s, shutting down", signum)
        scheduler.stop()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    try:
        scheduler.run_forever()
    except KeyboardInterrupt:
        log.info("Interrupted, exiting")
    except Exception as e:
        log.exception("fatal error: %s", e)
        sys.exit(1)
    log.info("Worker stopped")


if __name__ == "__main__":
    main()
