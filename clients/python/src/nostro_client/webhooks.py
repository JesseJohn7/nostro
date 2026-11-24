"""Receiver-side verification of ``Nostro-Signature``.

The grammar and checks mirror ``verifyWebhook()`` in ``packages/core`` exactly,
so the shared vectors in ``fixtures/webhooks/signatures.json`` verify the same
way in both languages::

    Nostro-Signature: t=<unix seconds>,v1=<64 lowercase hex>

The signed payload is ``<t>.<raw body>`` (UTF-8), HMAC-SHA256 under the shared
secret. Verification happens *before* parsing the body; receivers should also
dedupe on ``Nostro-Event-Id`` because delivery is at least once.
"""

from __future__ import annotations

import hashlib
import hmac as _hmac
import math
import re
from datetime import datetime, timezone

_T_RE = re.compile(r"[0-9]{1,12}")
_V1_RE = re.compile(r"[0-9a-f]{64}")


def verify_webhook(
    secret: str,
    header: str | None,
    body: str | bytes,
    tolerance: int = 300,
    now: datetime | None = None,
) -> bool:
    """True only for a body signed with ``secret`` within ``tolerance`` seconds.

    ``body`` must be the raw bytes (or the exact decoded string) as received;
    re-serialising parsed JSON changes the bytes and breaks the signature.
    ``now`` exists for deterministic tests. Malformed, expired, tampered and
    wrong-secret requests all return ``False``.
    """
    if not isinstance(header, str):
        return False
    if isinstance(body, bytes):
        try:
            body = body.decode("utf-8")
        except UnicodeDecodeError:
            return False
    elif not isinstance(body, str):
        return False

    # Parse exactly like core: split on ',', then on the first '=' of each
    # part, trimming whitespace around both key and value. Later keys win.
    parts: dict[str, str] = {}
    for part in header.split(","):
        i = part.find("=")
        if i < 0:
            key, value = part[:-1].strip(), part[:].strip()
        else:
            key, value = part[:i].strip(), part[i + 1 :].strip()
        parts[key] = value

    t = parts.get("t")
    v1 = parts.get("v1")
    if t is None or v1 is None:
        return False
    if _T_RE.fullmatch(t) is None or _V1_RE.fullmatch(v1) is None:
        return False

    instant = now if now is not None else datetime.now(timezone.utc)
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    now_epoch = math.floor(instant.timestamp())
    if abs(now_epoch - int(t)) > tolerance:
        return False

    signed = f"{t}.{body}".encode("utf-8")
    expected = _hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return _hmac.compare_digest(expected, v1)
