"""Money is exact; floats are never accepted; assets match on the full id."""

from decimal import Decimal

import pytest

from nostro_client import Money, as_amount_str, money_to_str, parse_money, same_asset

ASSET = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"


def test_float_is_refused_everywhere():
    with pytest.raises(TypeError):
        as_amount_str(1.25)
    with pytest.raises(TypeError):
        as_amount_str(1)
    with pytest.raises(TypeError):
        as_amount_str(True)
    with pytest.raises(TypeError):
        parse_money(1.5, "native")
    with pytest.raises(TypeError):
        parse_money(Decimal("1.5") + 0.0, "native")


def test_value_beyond_uint64_stays_exact():
    huge = 2**64 + 123456789
    text = str(huge)
    assert as_amount_str(Decimal(text)) == text
    money = parse_money(text, ASSET)
    assert isinstance(money, Money)
    assert money.amount == Decimal(text)
    assert money_to_str(money) == text
    # A float would have lost the last digits; Decimal did not.
    assert Decimal(float(text)) != money.amount


def test_strings_keep_their_exact_spelling():
    assert as_amount_str("0.0000001") == "0.0000001"
    assert money_to_str(Money(Decimal("1E+3"), "native")) == "1000"
    assert as_amount_str(Money(Decimal("12.50"), ASSET)) == "12.50"


def test_same_asset_uses_full_id_only():
    other = "USDC:GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
    assert same_asset(ASSET, ASSET)
    assert same_asset(Money(Decimal("1"), ASSET), ASSET)
    assert not same_asset("USDC", ASSET)
    assert not same_asset(ASSET, other)
    assert not same_asset("native", "NATIVE")
