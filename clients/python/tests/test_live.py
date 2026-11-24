"""Optional smoke tests against a real ``nostro serve``.

Set both NOSTRO_TEST_API_URL (e.g. http://127.0.0.1:18080) and
NOSTRO_TEST_API_KEY to run them; otherwise they skip. The bearer token is the
key part of ``NOSTRO_API_KEYS=tenant:key``.
"""

import itertools
import os
import uuid

import pytest

from nostro_client import Client, ProblemError

API_URL = os.environ.get("NOSTRO_TEST_API_URL")
API_KEY = os.environ.get("NOSTRO_TEST_API_KEY")
live = pytest.mark.skipif(
    not (API_URL and API_KEY),
    reason="set NOSTRO_TEST_API_URL and NOSTRO_TEST_API_KEY to test against a live server",
)

ACCOUNT = "G" + "A" * 55


def live_client() -> Client:
    assert API_URL is not None and API_KEY is not None
    return Client(API_URL, API_KEY)


@live
def test_health_and_openapi():
    client = live_client()
    assert client.health() == {"ok": True}
    assert client.openapi()["openapi"].startswith("3.")


@live
def test_problem_code_surfaces_on_a_409():
    """A duplicate reference is refused with a stable problem code.

    A fresh test server has no movements or exceptions, so a genuine
    ``resolution_refused`` cannot be produced deterministically here; that
    exact code is checked with a fake opener in test_client.py. A duplicate
    expectation reference gives us a deterministic 409 on the live server to
    prove ProblemError carries the code from the problem document.
    """
    client = live_client()
    client.watch_account(ACCOUNT)
    reference = f"py-client-{uuid.uuid4().hex}"
    expectation = {"reference": reference, "account": ACCOUNT, "amount": "1.5", "asset": "native"}
    client.create_expectation(**expectation)

    with pytest.raises(ProblemError) as caught:
        client.create_expectation(**expectation)

    assert caught.value.status == 409
    assert caught.value.code == "reference_taken"
    assert caught.value.detail
    assert API_KEY not in str(caught.value)


@live
def test_paging_iterator_runs_against_the_live_api():
    client = live_client()
    client.watch_account(ACCOUNT)
    rows = list(itertools.islice(client.list_movements(limit=2), 5))
    assert isinstance(rows, list)
    assert all(isinstance(row, dict) for row in rows)
