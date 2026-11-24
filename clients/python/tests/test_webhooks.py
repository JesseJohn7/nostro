"""The Python verifier must accept exactly the shared core vectors."""

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from nostro_client import verify_webhook

# clients/python/tests -> ../../../ = repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures" / "webhooks" / "signatures.json"


def _now(epoch: int) -> datetime:
    return datetime.fromtimestamp(epoch, tz=timezone.utc)


def test_shared_signature_vectors():
    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    secret = data["secret"]
    tolerance = data["tolerance"]
    assert {v["name"] for v in data["vectors"]} >= {
        "valid",
        "expired",
        "tampered",
        "malformed-header",
        "wrong-secret",
        "missing-header",
    }
    for vector in data["vectors"]:
        result = verify_webhook(
            secret,
            vector["header"],
            vector["body"],
            tolerance=tolerance,
            now=_now(vector["now"]),
        )
        assert result is vector["valid"], vector["name"]


def test_bytes_body_and_tolerance_boundaries():
    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    good = data["vectors"][0]
    body = good["body"].encode("utf-8")
    assert verify_webhook(data["secret"], good["header"], body, now=_now(good["now"]))
    # Exactly at the tolerance is accepted; one second beyond is not.
    assert verify_webhook(data["secret"], good["header"], body, tolerance=100, now=_now(good["t"] + 100))
    assert not verify_webhook(data["secret"], good["header"], body, tolerance=100, now=_now(good["t"] + 101))
    assert not verify_webhook(data["secret"], good["header"], b"\xff", now=_now(good["now"]))


@pytest.mark.parametrize(
    "header",
    [
        "",
        "v1=268e6007cb988e40a35bd93e8c80caa0dbd1665d4c6e62535e611178bf5862d0",
        "t=1700000000",
        "t=1700000000000,v1=268e6007cb988e40a35bd93e8c80caa0dbd1665d4c6e62535e611178bf5862d0",
        "t=abc,v1=268e6007cb988e40a35bd93e8c80caa0dbd1665d4c6e62535e611178bf5862d0",
        "t=1700000000,v1=268E6007CB988E40A35BD93E8C80CAA0DBD1665D4C6E62535E611178BF5862D0",
    ],
)
def test_malformed_headers_are_refused(header):
    assert not verify_webhook("0123456789abcdef0123456789abcdef", header, "{}", now=_now(1700000100))
