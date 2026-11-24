"""A dependency-free Python client for the nostro HTTP API.

    from nostro_client import Client, ProblemError, verify_webhook

Amounts are exact decimal strings on the wire; use ``str``, ``Decimal`` or
``Money``, never a float. Lists are lazy iterators that follow the API's
``next`` cursor.
"""

from .client import Client
from .errors import ProblemError
from .money import Amount, Money, as_amount_str, money_to_str, parse_money, same_asset
from .webhooks import verify_webhook

__version__ = "0.1.0"

__all__ = [
    "Client",
    "ProblemError",
    "Money",
    "Amount",
    "as_amount_str",
    "parse_money",
    "money_to_str",
    "same_asset",
    "verify_webhook",
    "__version__",
]
