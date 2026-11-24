"""Client behaviour: auth, exact amounts, errors, paging, and API coverage."""

import io
import json
import re
import urllib.error
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from nostro_client import Client, ProblemError, parse_money

API_KEY = "super-secret-key"
ACCOUNT = "G" + "A" * 55


class FakeResponse:
    def __init__(self, payload: bytes, status: int = 200, content_type: str = "application/json") -> None:
        self.payload = payload
        self.status = status
        self.headers = {"Content-Type": content_type}

    def read(self) -> bytes:
        return self.payload

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: Any) -> bool:
        return False


class FakeOpener:
    """Minimal ``OpenerDirector`` stand-in that records requests."""

    def __init__(self, *responses: Any) -> None:
        self.responses = list(responses)
        self.requests: list[Any] = []

    def open(self, request: Any, timeout: float | None = None) -> FakeResponse:
        self.requests.append(request)
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def problem(status: int, code: str, detail: str) -> urllib.error.HTTPError:
    payload = json.dumps(
        {"type": "about:blank", "title": "Conflict", "status": status, "code": code, "detail": detail}
    ).encode("utf-8")
    return urllib.error.HTTPError(
        "http://example.test/v1/exceptions/ex-1/resolve", status, "err", {}, io.BytesIO(payload)
    )


def test_sends_bearer_key_and_amounts_as_strings():
    opener = FakeOpener(FakeResponse(b'{"id":"e1"}', status=201))
    client = Client("http://example.test/", API_KEY, opener=opener)
    huge = "123456789012345678901234567890123456789"

    result = client.create_expectation(reference="inv-1", account=ACCOUNT, amount=Decimal(huge))

    assert result == {"id": "e1"}
    request = opener.requests[0]
    assert request.full_url == "http://example.test/v1/expectations"
    assert request.get_header("Authorization") == f"Bearer {API_KEY}"
    assert request.get_header("Content-type") == "application/json"
    body = json.loads(request.data)
    assert body["amount"] == huge
    assert isinstance(body["amount"], str)
    assert "asset" not in body  # omitted optional fields are not sent as null
    assert all(not isinstance(v, float) for v in body.values())


def test_float_amount_is_refused_before_any_request():
    opener = FakeOpener(FakeResponse(b"{}"))
    client = Client("http://example.test", API_KEY, opener=opener)
    with pytest.raises(TypeError):
        client.create_expectation(reference="inv-1", account=ACCOUNT, amount=1.5)
    assert opener.requests == []


def test_amounts_in_nested_bodies_are_strings():
    opener = FakeOpener(FakeResponse(b'{"applied":1}'))
    client = Client("http://example.test", API_KEY, opener=opener)
    client.resolve_exception(
        "ex-1",
        decision={
            "action": "apply",
            "note": "paid",
            "allocations": [{"reference": "inv-1", "amount": Decimal("0.10000000000000001")}],
        },
    )
    body = json.loads(opener.requests[0].data)
    assert body["allocations"][0]["amount"] == "0.10000000000000001"


def test_money_supplies_the_full_asset_when_omitted():
    opener = FakeOpener(FakeResponse(b"{}", status=201))
    client = Client("http://example.test", API_KEY, opener=opener)
    money = parse_money("10.25", "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")
    client.create_expectation(reference="inv-2", account=ACCOUNT, amount=money)
    body = json.loads(opener.requests[0].data)
    assert body["asset"] == money.asset
    assert body["amount"] == "10.25"


def test_409_resolution_refusal_surfaces_the_code_without_leaking_the_key():
    opener = FakeOpener(problem(409, "resolution_refused", "A lookalike asset cannot be applied."))
    client = Client("http://example.test", API_KEY, opener=opener)
    with pytest.raises(ProblemError) as caught:
        client.resolve_exception("ex-1", decision={"action": "close", "note": "nope"})
    err = caught.value
    assert err.status == 409
    assert err.code == "resolution_refused"
    assert err.detail == "A lookalike asset cannot be applied."
    assert err.title == "Conflict"
    assert err.type == "about:blank"
    assert API_KEY not in str(err)


def test_paging_follows_next_past_one_page():
    pages = [
        FakeResponse(json.dumps({"data": [{"seq": 1}, {"seq": 2}], "next": 2}).encode()),
        FakeResponse(json.dumps({"data": [{"seq": 3}, {"seq": 4}], "next": 4}).encode()),
        FakeResponse(json.dumps({"data": [{"seq": 5}], "next": None}).encode()),
    ]
    opener = FakeOpener(*pages)
    client = Client("http://example.test", API_KEY, opener=opener)

    rows = list(client.list_movements(limit=2))

    assert [row["seq"] for row in rows] == [1, 2, 3, 4, 5]
    queries = [request.full_url for request in opener.requests]
    assert queries == [
        "http://example.test/v1/movements?limit=2",
        "http://example.test/v1/movements?after=2&limit=2",
        "http://example.test/v1/movements?after=4&limit=2",
    ]


def test_paging_supports_items_pages_and_stops_on_a_repeated_cursor():
    opener = FakeOpener(
        FakeResponse(json.dumps({"items": [{"id": "a"}], "next": 7}).encode()),
        FakeResponse(json.dumps({"items": [{"id": "b"}], "next": 7}).encode()),
    )
    client = Client("http://example.test", API_KEY, opener=opener)
    assert list(client.list_schedules()) == [{"id": "a"}, {"id": "b"}]


def test_query_names_match_openapi_including_reserved_words():
    opener = FakeOpener(FakeResponse(b"{}"))
    client = Client("http://example.test", API_KEY, opener=opener)
    list(client.list_movements(from_="2026-01-01T00:00:00Z", entityId="tenant-1", limit=5))
    query = opener.requests[0].full_url
    assert "from=2026-01-01T00%3A00%3A00Z" in query
    assert "entityId=tenant-1" in query

    opener = FakeOpener(FakeResponse(b"{}"))
    client = Client("http://example.test", API_KEY, opener=opener)
    client.move_account(from_="expenses:old", to_="expenses:new")
    assert json.loads(opener.requests[0].data) == {"from": "expenses:old", "to": "expenses:new"}


def test_export_journal_returns_csv_text():
    opener = FakeOpener(FakeResponse(b"sequence,date\r\n1,2026-01-01\r\n", content_type="text/csv"))
    client = Client("http://example.test", API_KEY, opener=opener)
    assert client.export_journal() == "sequence,date\r\n1,2026-01-01\r\n"
    assert opener.requests[0].get_header("Accept") == "text/csv"


def test_every_openapi_operation_id_has_a_client_method():
    """Hand-written methods must cover the server's whole operation surface."""
    root = Path(__file__).resolve().parents[3]
    source = (root / "packages" / "server" / "src" / "openapi.ts").read_text(encoding="utf-8")
    operation_ids = set(re.findall(r"operationId:\s*'([A-Za-z0-9]+)'", source))
    assert len(operation_ids) >= 39

    def snake(name: str) -> str:
        name = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
        name = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
        return name.lower()

    expected = {snake(op) for op in operation_ids}
    missing = sorted(name for name in expected if not hasattr(Client, name))
    assert missing == [], f"Client is missing operationIds: {missing}"
