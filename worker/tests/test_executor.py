"""Smoke tests for the executor. Mocks the supabase store + http layer.

We don't need exhaustive coverage here — the pure functions (fill simulator,
guards, resolver) already have 72 unit tests. These tests just exercise the
orchestration: make sure the right calls happen in the right order for a few
representative cases (happy path, skip, no token).
"""

from __future__ import annotations
from typing import Optional, List, Dict, Any
import pytest

from worker.constants import DEFAULT_SLIPPAGE_TOLERANCE


# ── Fake store + http for isolation ─────────────────────────────────────────
class FakeStore:
    def __init__(self, account=None, registries=None, positions=None):
        self.account = account or {"registryId": "r1", "cash": 100, "peakBalance": 100}
        self.registries = registries or {}
        self.positions = list(positions or [])
        self.trades = []
        self.market_cache: Dict[str, Dict[str, Any]] = {}
        self.last_poll_updates: List[tuple] = []
        self.account_updates: List[Dict] = []
        self.position_upserts: List[Dict] = []

    def list_active_registries(self):
        return [r for r in self.registries.values() if r.get("status") == "active"]

    def get_account(self, registry_id):
        return self.account if self.account and self.account["registryId"] == registry_id else None

    def update_account(self, account):
        self.account_updates.append(account)
        self.account = {**self.account, **account}

    def list_open_positions(self, registry_id):
        return [p for p in self.positions if p.get("registryId") == registry_id and not p.get("isResolved")]

    def list_trades_for_registry(self, registry_id, limit=1000):
        return [t for t in self.trades if t.get("registryId") == registry_id]

    def insert_trade(self, trade):
        self.trades.append(trade)

    def update_trade(self, trade):
        for i, t in enumerate(self.trades):
            if t["id"] == trade["id"]:
                self.trades[i] = trade
                return

    def get_position(self, position_id):
        for p in self.positions:
            if p.get("id") == position_id:
                return p
        return None

    def upsert_position(self, position):
        self.position_upserts.append(position)
        for i, p in enumerate(self.positions):
            if p.get("id") == position["id"]:
                self.positions[i] = position
                return
        self.positions.append(position)

    def update_registry(self, registry):
        self.registries[registry["id"]] = registry

    def update_registry_last_poll_ts(self, registry_id, ts):
        self.last_poll_updates.append((registry_id, ts))
        if registry_id in self.registries:
            self.registries[registry_id]["lastPollTs"] = ts

    def get_market_cache(self, key):
        return self.market_cache.get(key)

    def put_market_cache(self, key, data, ttl_sec=None):
        import time
        self.market_cache[key] = {"cacheKey": key, "data": data, "fetchedAt": int(time.time() * 1000), "ttlSec": ttl_sec}


def make_registry(**overrides):
    base = {
        "id": "r1",
        "walletAddr": "0xabc",
        "teamId": "team1",
        "status": "active",
        "copyMode": "buys_only",
        "newMarketsOnly": False,
        "sizingMode": "fixed",
        "fixedAmt": 10,
        "pctAmt": 50,
        "startBalance": 100,
        "slippageTolerance": DEFAULT_SLIPPAGE_TOLERANCE,
        "blockedCategories": [],
        "blockedMarkets": [],
        "autoPause": {},
        "lastPollTs": 0,
    }
    return {**base, **overrides}


def make_leader_trade(**overrides):
    base = {
        "conditionId": "0xc1",
        "outcome": "Yes",
        "avgPrice": 0.5,
        "totalBought": 100,
        "side": "BUY",
        "category": "politics",
        "title": "Will X happen?",
        "timestamp": 1700000000,
    }
    return {**base, **overrides}


# ── Tests ──────────────────────────────────────────────────────────────────
def test_executor_happy_path(monkeypatch):
    """Leader BUY → all guards pass → fill succeeds → trade + position written."""
    from worker import executor

    monkeypatch.setattr(executor, "fetch_token_ids_uncached", lambda cid: {
        "tokens": {"yes": "tok-yes", "no": "tok-no"},
        "outcomes": ["Yes", "No"],
    })
    monkeypatch.setattr(executor, "fetch_order_book", lambda tid: {
        "asks": [{"price": "0.50", "size": "100"}],
        "bids": [{"price": "0.49", "size": "100"}],
    })

    store = FakeStore()
    registry = make_registry()
    leader_trade = make_leader_trade()

    executor.execute_on_leader_trade(store, registry, leader_trade)

    assert len(store.trades) == 1
    assert store.trades[0]["status"] == "filled"
    assert store.trades[0]["entryPrice"] == 0.5
    assert store.trades[0]["tokenId"] == "tok-yes"
    assert len(store.position_upserts) == 1
    assert store.position_upserts[0]["shares"] > 0
    assert len(store.account_updates) == 1


def test_executor_skips_when_token_not_found(monkeypatch):
    """Categorical market where leader's outcome isn't in the token list."""
    from worker import executor

    monkeypatch.setattr(executor, "fetch_token_ids_uncached", lambda cid: {
        "tokens": {"team a": "tok-a", "team b": "tok-b"},
        "outcomes": ["Team A", "Team B"],
    })

    store = FakeStore()
    registry = make_registry()
    leader_trade = make_leader_trade(outcome="Yes")

    executor.execute_on_leader_trade(store, registry, leader_trade)

    assert len(store.trades) == 1
    assert store.trades[0]["status"] == "skipped"
    assert store.trades[0]["skipReason"] == "TOKEN_NOT_FOUND"
    assert store.trades[0]["isPermanentSkip"] is True


def test_executor_skips_pre_fill_block(monkeypatch):
    """Pre-fill guard rejects (e.g. blocked category) — no HTTP calls happen."""
    from worker import executor

    fetch_called = [False]
    def fake_fetch(*args, **kwargs):
        fetch_called[0] = True
        return {"tokens": {}, "outcomes": []}
    monkeypatch.setattr(executor, "fetch_token_ids_uncached", fake_fetch)

    store = FakeStore()
    registry = make_registry(blockedCategories=["politics"])
    leader_trade = make_leader_trade(category="politics")

    executor.execute_on_leader_trade(store, registry, leader_trade)

    assert len(store.trades) == 1
    assert store.trades[0]["status"] == "skipped"
    assert store.trades[0]["skipReason"] == "BLOCKED_CATEGORY"
    assert fetch_called[0] is False  # never reached the HTTP layer


def test_executor_skips_slippage_exceeded(monkeypatch):
    """Pre-fill passes, fill simulation has too much slippage → skip."""
    from worker import executor

    monkeypatch.setattr(executor, "fetch_token_ids_uncached", lambda cid: {
        "tokens": {"yes": "tok-yes"}, "outcomes": ["Yes"],
    })
    # Wide spread: ask 0.55, bid 0.45 → mid 0.50 → fill at 0.55 → 1000bps slippage
    monkeypatch.setattr(executor, "fetch_order_book", lambda tid: {
        "asks": [{"price": "0.55", "size": "100"}],
        "bids": [{"price": "0.45", "size": "100"}],
    })

    store = FakeStore()
    registry = make_registry()
    leader_trade = make_leader_trade()

    executor.execute_on_leader_trade(store, registry, leader_trade)

    assert len(store.trades) == 1
    assert store.trades[0]["status"] == "skipped"
    assert store.trades[0]["skipReason"] == "SLIPPAGE_EXCEEDED"


def test_poll_once_filters_non_buy_and_unrelated(monkeypatch):
    """poll_once should only execute on BUY trades with conditionId+outcome."""
    from worker import executor

    monkeypatch.setattr(executor, "fetch_activity", lambda addr, since: [
        {"conditionId": "c1", "outcome": "Yes", "side": "BUY", "avgPrice": 0.5,
         "totalBought": 100, "timestamp": 100, "title": "buy 1"},
        {"conditionId": "c2", "outcome": "No", "side": "SELL", "avgPrice": 0.5,
         "totalBought": 100, "timestamp": 101, "title": "sell"},  # filtered
        {"side": "BUY", "avgPrice": 0.5, "totalBought": 100, "timestamp": 102},  # no conditionId
    ])
    monkeypatch.setattr(executor, "fetch_token_ids_uncached", lambda cid: {
        "tokens": {"yes": "tok-yes"}, "outcomes": ["Yes"],
    })
    monkeypatch.setattr(executor, "fetch_order_book", lambda tid: {
        "asks": [{"price": "0.50", "size": "100"}],
        "bids": [{"price": "0.49", "size": "100"}],
    })

    store = FakeStore()
    registry = make_registry()

    executor.poll_once(store, registry)

    # Only the first entry should result in a trade row
    filled_count = sum(1 for t in store.trades if t["status"] == "filled")
    skipped_count = sum(1 for t in store.trades if t["status"] == "skipped")
    assert filled_count == 1
    assert skipped_count == 0
    assert len(store.last_poll_updates) == 1
    assert store.last_poll_updates[0][1] == 102  # max timestamp seen


# ── Sell-side tests ────────────────────────────────────────────────────────

def _book_with_bids():
    """Order book where a sell at any reasonable size fills cleanly at ~$0.70."""
    return {
        "asks": [{"price": "0.72", "size": "1000"}],
        "bids": [{"price": "0.70", "size": "1000"}],
    }


def _open_position(**overrides):
    """A paper position from an earlier BUY: 100 shares @ $0.50 entry, $50 total cost."""
    base = {
        "id": "r1_0xc1_yes",
        "registryId": "r1",
        "teamId": "team1",
        "conditionId": "0xc1",
        "outcome": "Yes",
        "title": "Will X happen?",
        "tokenId": "tok-yes",
        "shares": 100,
        "avgEntryPrice": 0.5,
        "totalCost": 50.0,
        "realizedPnl": 0,
        "isResolved": False,
    }
    return {**base, **overrides}


def test_sell_all_or_nothing_closes_full_position(monkeypatch):
    """all_or_nothing mode: any leader SELL fully closes our position."""
    from worker import executor

    monkeypatch.setattr(executor, "fetch_token_ids_uncached", lambda cid: {
        "tokens": {"yes": "tok-yes"}, "outcomes": ["Yes"],
    })
    monkeypatch.setattr(executor, "fetch_order_book", lambda tid: _book_with_bids())
    # Should not be called in all_or_nothing mode, but stub safely just in case.
    monkeypatch.setattr(executor, "fetch_open_positions", lambda addr: [])

    store = FakeStore(positions=[_open_position()])
    registry = make_registry(copyMode="buys_and_sells", sellMirrorMode="all_or_nothing")
    leader_sell = make_leader_trade(side="SELL", avgPrice=0.70, totalBought=10)  # 10 shares — small trim

    executor.execute_on_leader_sell(store, registry, leader_sell)

    # Position is fully closed despite leader only selling 10 of (effectively their) shares
    pos = store.position_upserts[-1]
    assert pos["shares"] == 0
    assert pos["isResolved"] is True
    assert pos["resolutionSource"] == "sold"

    # Sell trade row recorded with exit_reason='sold' and side='sell'
    sell_trade = next(t for t in store.trades if t.get("side") == "sell")
    assert sell_trade["exitReason"] == "sold"
    assert sell_trade["status"] == "resolved"
    assert sell_trade["pnl"] > 0  # sold at $0.70 from $0.50 entry → win

    # Cash credited (~$70 proceeds minus fee)
    assert store.account_updates[-1]["cash"] > 100  # started at $100, sold for ~$70 net gain on top of remaining


def test_sell_proportional_mirrors_leader_fraction(monkeypatch):
    """proportional mode: leader sells 25% (50 of 200 shares), so we sell 25% of our 100."""
    from worker import executor

    monkeypatch.setattr(executor, "fetch_token_ids_uncached", lambda cid: {
        "tokens": {"yes": "tok-yes"}, "outcomes": ["Yes"],
    })
    monkeypatch.setattr(executor, "fetch_order_book", lambda tid: _book_with_bids())
    # Leader's open-positions snapshot AFTER the sell: 150 shares remain.
    # Pre-sell holding was 150 + 50 = 200. Fraction = 50/200 = 25%.
    monkeypatch.setattr(executor, "fetch_open_positions", lambda addr: [
        {"conditionId": "0xc1", "outcome": "Yes", "size": 150}
    ])

    store = FakeStore(positions=[_open_position()])
    registry = make_registry(copyMode="buys_and_sells", sellMirrorMode="proportional")
    leader_sell = make_leader_trade(side="SELL", avgPrice=0.70, totalBought=50)

    executor.execute_on_leader_sell(store, registry, leader_sell)

    pos = store.position_upserts[-1]
    # We had 100 shares; sold 25 (25% of 100); 75 remain
    assert pos["shares"] == pytest.approx(75, abs=0.5)
    assert pos["isResolved"] is False  # partial close — still open
    # totalCost shrunk proportionally too: $50 * (1 - 0.25) = $37.50
    assert pos["totalCost"] == pytest.approx(37.5, abs=0.5)


def test_sell_proportional_full_exit_when_leader_has_no_remaining(monkeypatch):
    """proportional mode: leader's open-positions show zero remaining → 100% close."""
    from worker import executor

    monkeypatch.setattr(executor, "fetch_token_ids_uncached", lambda cid: {
        "tokens": {"yes": "tok-yes"}, "outcomes": ["Yes"],
    })
    monkeypatch.setattr(executor, "fetch_order_book", lambda tid: _book_with_bids())
    monkeypatch.setattr(executor, "fetch_open_positions", lambda addr: [])  # nothing left

    store = FakeStore(positions=[_open_position()])
    registry = make_registry(copyMode="buys_and_sells", sellMirrorMode="proportional")
    leader_sell = make_leader_trade(side="SELL", avgPrice=0.70, totalBought=100)

    executor.execute_on_leader_sell(store, registry, leader_sell)

    pos = store.position_upserts[-1]
    assert pos["shares"] == 0
    assert pos["isResolved"] is True


def test_sell_with_no_matching_position_is_silent(monkeypatch):
    """SELL of a market we never bought → no trade row written, no error raised."""
    from worker import executor

    monkeypatch.setattr(executor, "fetch_token_ids_uncached", lambda cid: {
        "tokens": {"yes": "tok-yes"}, "outcomes": ["Yes"],
    })

    store = FakeStore()  # no positions
    registry = make_registry(copyMode="buys_and_sells")
    leader_sell = make_leader_trade(side="SELL", totalBought=50)

    executor.execute_on_leader_sell(store, registry, leader_sell)

    assert len(store.trades) == 0
    assert len(store.position_upserts) == 0


def test_sell_realized_pnl_reflects_actual_basis(monkeypatch):
    """A losing sell: bought at $0.50, sells at $0.40 → realized loss minus fees."""
    from worker import executor

    monkeypatch.setattr(executor, "fetch_token_ids_uncached", lambda cid: {
        "tokens": {"yes": "tok-yes"}, "outcomes": ["Yes"],
    })
    monkeypatch.setattr(executor, "fetch_order_book", lambda tid: {
        "asks": [{"price": "0.42", "size": "1000"}],
        "bids": [{"price": "0.40", "size": "1000"}],
    })
    monkeypatch.setattr(executor, "fetch_open_positions", lambda addr: [])

    store = FakeStore(positions=[_open_position()])
    registry = make_registry(copyMode="buys_and_sells", sellMirrorMode="all_or_nothing")
    leader_sell = make_leader_trade(side="SELL", avgPrice=0.40, totalBought=100)

    executor.execute_on_leader_sell(store, registry, leader_sell)

    sell_trade = next(t for t in store.trades if t.get("side") == "sell")
    # 100 shares * $0.40 = $40 gross proceeds; minus fee; minus $50 cost basis
    # → ~-$10 realized loss (allowing for the small fee)
    assert sell_trade["pnl"] < 0
    assert sell_trade["pnl"] > -11
    assert sell_trade["result"] == "loss"
    assert sell_trade["exitReason"] == "sold"


def test_poll_once_routes_sells_when_copy_mode_allows(monkeypatch):
    """copy_mode=buys_and_sells: SELL events reach execute_on_leader_sell."""
    from worker import executor

    monkeypatch.setattr(executor, "fetch_activity", lambda addr, since: [
        {"conditionId": "0xc1", "outcome": "Yes", "side": "SELL", "avgPrice": 0.7,
         "totalBought": 100, "timestamp": 200, "title": "leader sell"},
    ])
    monkeypatch.setattr(executor, "fetch_token_ids_uncached", lambda cid: {
        "tokens": {"yes": "tok-yes"}, "outcomes": ["Yes"],
    })
    monkeypatch.setattr(executor, "fetch_order_book", lambda tid: _book_with_bids())
    monkeypatch.setattr(executor, "fetch_open_positions", lambda addr: [])

    store = FakeStore(positions=[_open_position()])
    registry = make_registry(copyMode="buys_and_sells", sellMirrorMode="proportional")

    executor.poll_once(store, registry)

    sell_trades = [t for t in store.trades if t.get("side") == "sell"]
    assert len(sell_trades) == 1
    assert sell_trades[0]["exitReason"] == "sold"


def test_poll_once_ignores_sells_when_buys_only(monkeypatch):
    """copy_mode=buys_only: SELL events are dropped at the poll boundary."""
    from worker import executor

    monkeypatch.setattr(executor, "fetch_activity", lambda addr, since: [
        {"conditionId": "0xc1", "outcome": "Yes", "side": "SELL", "avgPrice": 0.7,
         "totalBought": 100, "timestamp": 200, "title": "leader sell"},
    ])

    store = FakeStore(positions=[_open_position()])
    registry = make_registry(copyMode="buys_only")

    executor.poll_once(store, registry)

    assert len(store.trades) == 0
    assert len(store.position_upserts) == 0


def test_poll_once_skips_paused_trader():
    """Paused trader's poll_once should be a no-op (no fetch)."""
    from worker import executor

    fetched = [False]
    def fake_fetch(*args, **kwargs):
        fetched[0] = True
        return []
    import worker.executor as exec_mod
    original = exec_mod.fetch_activity
    exec_mod.fetch_activity = fake_fetch
    try:
        store = FakeStore()
        registry = make_registry(status="paused")
        executor.poll_once(store, registry)
        assert fetched[0] is False
    finally:
        exec_mod.fetch_activity = original
