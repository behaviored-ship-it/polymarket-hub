"""Mirror of src/paper/__tests__/resolvePosition.test.js."""

import pytest
from worker.resolver import resolve_position, AmbiguousResolutionError


YES_POS = {"conditionId": "c1", "outcome": "YES"}
NO_POS = {"conditionId": "c1", "outcome": "NO"}


# ─── primary (redeemable) ───────────────────────────────────────────────────
class TestPrimaryRedeemable:
    def test_redeemable_high_curprice_is_win(self):
        r = resolve_position(
            YES_POS,
            [{"conditionId": "c1", "outcome": "yes", "redeemable": True, "curPrice": 0.995}],
            None,
        )
        assert r == {"resolved": True, "price": 1.0, "source": "redeemable"}

    def test_redeemable_low_curprice_is_loss(self):
        r = resolve_position(
            YES_POS,
            [{"conditionId": "c1", "outcome": "yes", "redeemable": True, "curPrice": 0.005}],
            None,
        )
        assert r == {"resolved": True, "price": 0.0, "source": "redeemable"}

    def test_redeemable_middle_not_resolved(self):
        r = resolve_position(
            YES_POS,
            [{"conditionId": "c1", "outcome": "yes", "redeemable": True, "curPrice": 0.6}],
            None,
        )
        assert r["resolved"] is False

    def test_not_redeemable(self):
        r = resolve_position(
            YES_POS,
            [{"conditionId": "c1", "outcome": "yes", "redeemable": False, "curPrice": 0.99}],
            None,
        )
        assert r["resolved"] is False

    def test_case_insensitive_outcome_match(self):
        r = resolve_position(
            YES_POS,
            [{"conditionId": "c1", "outcome": "Yes", "redeemable": True, "curPrice": 1}],
            None,
        )
        assert r["resolved"] is True


# ─── secondary (Gamma outcomePrices) ───────────────────────────────────────
class TestSecondaryGamma:
    def test_yes_wins(self):
        r = resolve_position(YES_POS, None, {"outcomePrices": ["1", "0"]})
        assert r == {"resolved": True, "price": 1.0, "source": "outcomePrices"}

    def test_yes_loses(self):
        r = resolve_position(YES_POS, None, {"outcomePrices": ["0", "1"]})
        assert r == {"resolved": True, "price": 0.0, "source": "outcomePrices"}

    def test_no_wins(self):
        r = resolve_position(NO_POS, None, {"outcomePrices": ["0", "1"]})
        assert r == {"resolved": True, "price": 1.0, "source": "outcomePrices"}

    def test_not_yet_resolved(self):
        r = resolve_position(YES_POS, None, {"outcomePrices": ["0.5", "0.5"]})
        assert r["resolved"] is False

    def test_ambiguous_raises(self):
        with pytest.raises(AmbiguousResolutionError):
            resolve_position(YES_POS, None, {"outcomePrices": ["1", "1"]})

    def test_handles_numeric_outcome_prices(self):
        r = resolve_position(YES_POS, None, {"outcomePrices": [1, 0]})
        assert r["resolved"] is True


# ─── categorical markets ───────────────────────────────────────────────────
class TestCategorical:
    def test_match_by_outcome_string(self):
        r = resolve_position(
            {"conditionId": "c1", "outcome": "T1"},
            None,
            {"outcomes": ["T1", "FULL SENSE"], "outcomePrices": ["1", "0"]},
        )
        assert r == {"resolved": True, "price": 1.0, "source": "outcomePrices"}

    def test_losing_categorical(self):
        r = resolve_position(
            {"conditionId": "c1", "outcome": "T1"},
            None,
            {"outcomes": ["T1", "FULL SENSE"], "outcomePrices": ["0", "1"]},
        )
        assert r == {"resolved": True, "price": 0.0, "source": "outcomePrices"}

    def test_case_insensitive_trim(self):
        r = resolve_position(
            {"conditionId": "c1", "outcome": "  full sense  "},
            None,
            {"outcomes": ["T1", "FULL SENSE"], "outcomePrices": ["0", "1"]},
        )
        assert r["resolved"] is True
        assert r["price"] == 1.0

    def test_unknown_outcome(self):
        r = resolve_position(
            {"conditionId": "c1", "outcome": "GHOST TEAM"},
            None,
            {"outcomes": ["T1", "FULL SENSE"], "outcomePrices": ["1", "0"]},
        )
        assert r["resolved"] is False

    def test_three_way(self):
        r = resolve_position(
            {"conditionId": "c1", "outcome": "Carlos"},
            None,
            {"outcomes": ["Aria", "Boris", "Carlos"], "outcomePrices": ["0", "0", "1"]},
        )
        assert r["resolved"] is True
        assert r["price"] == 1.0


# ─── layered behavior ──────────────────────────────────────────────────────
class TestLayered:
    def test_falls_back_to_gamma_when_redeemable_missing_market(self):
        r = resolve_position(
            YES_POS,
            [{"conditionId": "c2", "redeemable": True, "curPrice": 1}],
            {"outcomePrices": ["0", "1"]},
        )
        assert r["source"] == "outcomePrices"
        assert r["price"] == 0.0

    def test_returns_unresolved_when_neither_resolves(self):
        assert resolve_position(YES_POS, [], {"outcomePrices": ["0.4", "0.6"]})["resolved"] is False
        assert resolve_position(YES_POS, None, None)["resolved"] is False
