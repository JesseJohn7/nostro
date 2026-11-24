"""Exact amounts and full asset ids.

There are no floats here. An amount is either a string of decimal digits, a
``decimal.Decimal``, or a :class:`Money` bundling it with its asset. Everything
is put on the wire as a decimal string -- never a JSON number, which would
already have lost precision in ``json.loads`` on the server.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Union

Amount = Union[str, Decimal, "Money"]


@dataclass(frozen=True)
class Money:
    """An exact amount and the full asset it is denominated in.

    ``asset`` is ``"native"`` or the complete ``CODE:ISSUER`` id. Never the
    code alone: a lookalike issuer is a different asset.
    """

    amount: Decimal
    asset: str


def as_amount_str(value: Amount) -> str:
    """Return an amount as an exact decimal string.

    Accepts only ``str``, ``Decimal`` and :class:`Money`. Floats (and ints,
    bools and anything else) are refused: a float has already lost precision
    before this function is called.
    """
    if isinstance(value, float):
        raise TypeError("floats are not allowed for amounts: use a decimal string, Decimal or Money")
    if isinstance(value, Money):
        value = value.amount
    if isinstance(value, str):
        # Validate syntax without changing the caller's spelling of the value.
        try:
            parsed = Decimal(value)
        except InvalidOperation as exc:
            raise ValueError(f"not a decimal amount: {value!r}") from exc
        if not parsed.is_finite():
            raise ValueError(f"not a finite amount: {value!r}")
        return value
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError(f"not a finite amount: {value!r}")
        return format(value, "f")
    raise TypeError(
        f"amounts must be str, Decimal or Money, not {type(value).__name__}; "
        "floats are never accepted"
    )


def parse_money(value: Amount, asset: str) -> Money:
    """Parse an amount into a :class:`Money` with a full asset id."""
    if not isinstance(asset, str) or not asset:
        raise ValueError("asset must be a non-empty string: 'native' or CODE:ISSUER")
    return Money(Decimal(as_amount_str(value)), asset)


def money_to_str(money: Money) -> str:
    """Return the decimal string of a :class:`Money` amount."""
    if not isinstance(money, Money):
        raise TypeError("money_to_str expects a Money")
    return as_amount_str(money.amount)


def same_asset(a: Union[str, Money], b: Union[str, Money]) -> bool:
    """Compare two assets by their complete id.

    ``"USDC"`` and ``"USDC:GABC..."`` are *not* the same asset. This is plain
    string equality on the full id (or on ``Money.asset``), with no prefix or
    code-only matching.
    """
    left = a.asset if isinstance(a, Money) else a
    right = b.asset if isinstance(b, Money) else b
    if not isinstance(left, str) or not isinstance(right, str):
        raise TypeError("asset ids must be strings ('native' or CODE:ISSUER)")
    return left == right
