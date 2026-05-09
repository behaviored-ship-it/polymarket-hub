"""Mirror of src/paper/__tests__/useFillSimulator.test.js.

Locking in identical math between the JS engine (Phase 1) and the Python
worker (Phase 2). Same fee formula, same slippage in bps, same FOK/FAK.
"""

import math
import pytest

from worker.fill_simulator import (
    simulate_buy_fill,
    simulate_sell_fill,
    check_slippage_tolerance,
    compute_fee,
    compute_slippage_bps,
)
from worker.constants import DEFAULT_SLIPPAGE_TOLERANCE, FEE_MIN


# ─── compute_fee ─────────────────────────────────────────────────────────────
class TestComputeFee:
    def test_polymarket_formula(self):
        # bps=100, p=0.5, cost=$100 → 0.01 * 0.5 * 100 = 0.50
        assert math.isclose(compute_fee(0.5, 100), 0.5)

    def test_symmetric_around_half(self):
        assert math.isclose(compute_fee(0.2, 100), compute_fee(0.8, 100))

    def test_minimum_floor(self):
        # p=0.001, cost=$0.10 → 0.01 * 0.001 * 0.10 = tiny → floored to FEE_MIN
        assert compute_fee(0.001, 0.10) == FEE_MIN

    def test_zero_when_bps_zero(self):
        assert compute_fee(0.5, 100, 0) == 0

    def test_zero_for_non_positive_cost(self):
        assert compute_fee(0.5, 0) == 0
        assert compute_fee(0.5, -1) == 0


# ─── compute_slippage_bps ────────────────────────────────────────────────────
class TestComputeSlippageBps:
    def test_zero_when_at_midpoint(self):
        assert compute_slippage_bps(0.5, 0.5) == 0

    def test_positive_when_above_midpoint(self):
        assert math.isclose(compute_slippage_bps(0.51, 0.5), 200)

    def test_zero_when_midpoint_zero(self):
        assert compute_slippage_bps(0.5, 0) == 0


# ─── simulate_buy_fill ───────────────────────────────────────────────────────
class TestSimulateBuyFill:
    def test_empty_book_returns_none(self):
        assert simulate_buy_fill([], [], 100) is None

    def test_zero_or_negative_amount(self):
        assert simulate_buy_fill([{"price": "0.5", "size": "100"}], [], 0) is None
        assert simulate_buy_fill([{"price": "0.5", "size": "100"}], [], -10) is None

    def test_handles_string_prices_from_clob(self):
        r = simulate_buy_fill(
            [{"price": "0.50", "size": "100"}],
            [{"price": "0.49", "size": "100"}],
            10,
        )
        assert r is not None
        assert r["avg_price"] == 0.5
        assert r["total_shares"] == 20

    def test_fills_single_level(self):
        r = simulate_buy_fill(
            [{"price": 0.5, "size": 100}],
            [{"price": 0.49, "size": 100}],
            25,
        )
        assert r["total_cost"] == 25
        assert r["total_shares"] == 50
        assert r["avg_price"] == 0.5
        assert r["levels_filled"] == 1
        assert r["is_partial"] is False

    def test_walks_multiple_levels(self):
        r = simulate_buy_fill(
            [
                {"price": 0.5, "size": 100},
                {"price": 0.55, "size": 100},
            ],
            [{"price": 0.49, "size": 100}],
            70,
        )
        expected_shares = 100 + 20 / 0.55
        assert math.isclose(r["total_cost"], 70)
        assert math.isclose(r["total_shares"], expected_shares)
        assert math.isclose(r["avg_price"], 70 / expected_shares)
        assert r["levels_filled"] == 2

    def test_sorts_unsorted_asks(self):
        r = simulate_buy_fill(
            [
                {"price": 0.55, "size": 100},
                {"price": 0.50, "size": 100},
            ],
            [{"price": 0.49, "size": 100}],
            10,
        )
        assert r["avg_price"] == 0.5

    def test_fok_rejects_partial(self):
        r = simulate_buy_fill(
            [{"price": 0.5, "size": 50}],
            [{"price": 0.49, "size": 100}],
            100,
            "fok",
        )
        assert r is None

    def test_fak_accepts_partial(self):
        r = simulate_buy_fill(
            [{"price": 0.5, "size": 50}],
            [{"price": 0.49, "size": 100}],
            100,
            "fak",
        )
        assert r is not None
        assert r["total_cost"] == 25
        assert r["total_shares"] == 50
        assert r["is_partial"] is True

    def test_slippage_vs_midpoint(self):
        r = simulate_buy_fill(
            [{"price": 0.5, "size": 100}],
            [{"price": 0.48, "size": 100}],
            10,
        )
        assert r["midpoint"] == 0.49
        assert math.isclose(r["slippage_bps"], (0.5 - 0.49) / 0.49 * 10_000)

    def test_falls_back_to_best_ask_when_bids_empty(self):
        r = simulate_buy_fill([{"price": 0.5, "size": 100}], [], 10)
        assert r["midpoint"] == 0.5
        assert r["slippage_bps"] == 0

    def test_skips_zero_size_levels(self):
        r = simulate_buy_fill(
            [
                {"price": 0.5, "size": 0},
                {"price": 0.55, "size": 100},
            ],
            [{"price": 0.49, "size": 100}],
            10,
        )
        assert r["avg_price"] == 0.55


# ─── simulate_sell_fill ──────────────────────────────────────────────────────
class TestSimulateSellFill:
    def test_empty_bids_returns_none(self):
        assert simulate_sell_fill([{"price": 0.5, "size": 100}], [], 10) is None

    def test_walks_bids_descending(self):
        # 50 @ 0.50 + 50 @ 0.45 = $47.50 for 100 shares → avg 0.475
        r = simulate_sell_fill(
            [{"price": 0.55, "size": 100}],
            [
                {"price": 0.5, "size": 50},
                {"price": 0.45, "size": 100},
            ],
            100,
        )
        assert r["total_shares"] == 100
        assert math.isclose(r["total_proceeds"], 47.5)
        assert math.isclose(r["avg_price"], 0.475)

    def test_fok_rejects_partial(self):
        assert (
            simulate_sell_fill(
                [{"price": 0.55, "size": 100}],
                [{"price": 0.5, "size": 10}],
                100,
                "fok",
            )
            is None
        )


# ─── check_slippage_tolerance ────────────────────────────────────────────────
class TestCheckSlippageTolerance:
    def test_above40c_tier(self):
        tol = DEFAULT_SLIPPAGE_TOLERANCE
        assert check_slippage_tolerance(300, 0.5, tol) is True   # 3% < 4%
        assert check_slippage_tolerance(500, 0.5, tol) is False  # 5% > 4%

    def test_between18_40c_tier(self):
        tol = DEFAULT_SLIPPAGE_TOLERANCE
        assert check_slippage_tolerance(800, 0.25, tol) is True   # 8% < 10%
        assert check_slippage_tolerance(1100, 0.25, tol) is False # 11% > 10%

    def test_below18c_tier(self):
        tol = DEFAULT_SLIPPAGE_TOLERANCE
        assert check_slippage_tolerance(2000, 0.10, tol) is True   # 20% < 25%
        assert check_slippage_tolerance(3000, 0.10, tol) is False  # 30% > 25%

    def test_exact_40c_boundary(self):
        tol = DEFAULT_SLIPPAGE_TOLERANCE
        assert check_slippage_tolerance(400, 0.40, tol) is True
        assert check_slippage_tolerance(401, 0.40, tol) is False

    def test_exact_18c_boundary(self):
        tol = DEFAULT_SLIPPAGE_TOLERANCE
        assert check_slippage_tolerance(1000, 0.18, tol) is True
        assert check_slippage_tolerance(1001, 0.18, tol) is False
        assert check_slippage_tolerance(2400, 0.1799, tol) is True
