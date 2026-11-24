"""A small, hand-written client for the nostro HTTP API.

Every method is named after an OpenAPI ``operationId`` in snake_case; a test
checks that nothing in ``packages/server/src/openapi.ts`` is missing. There is
no generated code and no third-party HTTP dependency: requests go through
``urllib.request``, so an existing ``OpenerDirector`` (proxy, TLS setup, test
double) can be injected with ``Client(..., opener=...)``.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from typing import Any

from .errors import ProblemError
from .money import Money, as_amount_str

_USER_AGENT = "nostro-python/0.1.0"

# Distinguishes "leave this field out" (the default) from an explicit null,
# which the amend route uses to clear muxedId/memo/dueAt/expiresAt.
_UNSET = object()


def _body(**fields: Any) -> dict[str, Any]:
    """A request body without optional fields the caller did not supply.

    The server rejects JSON null for fields whose schema says string, so an
    omitted keyword argument must not become ``"field": null`` on the wire.
    """
    return {key: value for key, value in fields.items() if value is not None}


def _normalize_amounts(value: Any) -> Any:
    """Convert every body field named ``amount`` to an exact decimal string.

    This is the single gate through which all request bodies pass, so no
    amount can reach ``json.dumps`` as a float or a JSON number.
    """
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            out[key] = as_amount_str(item) if key == "amount" and item is not None else _normalize_amounts(item)
        return out
    if isinstance(value, (list, tuple)):
        return [_normalize_amounts(item) for item in value]
    return value


def _asset_of(amount: Any, asset: str | None) -> str | None:
    """Use the asset carried by a Money when the caller did not pass one."""
    if asset is None and isinstance(amount, Money):
        return amount.asset
    return asset


class Client:
    """Talks to one nostro tenant, identified by ``api_key``.

    ``base_url`` is the root of the service, e.g. ``http://127.0.0.1:8080``;
    the client adds ``/v1/...`` itself. ``opener`` and ``timeout`` are optional.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        opener: urllib.request.OpenerDirector | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.opener = opener if opener is not None else urllib.request.build_opener()
        self.timeout = timeout

    # ---- transport --------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: Any = None,
        raw: bool = False,
    ) -> Any:
        url = self.base_url + path
        if params:
            query: dict[str, Any] = {}
            for key, value in params.items():
                if value is None:
                    continue
                query[key] = "true" if value is True else "false" if value is False else value
            encoded = urllib.parse.urlencode(query, doseq=True)
            if encoded:
                url += "?" + encoded

        data: bytes | None = None
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "text/csv" if raw else "application/json",
            "User-Agent": _USER_AGENT,
        }
        if body is not None:
            data = json.dumps(_normalize_amounts(body), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                payload = response.read()
                if raw:
                    return payload.decode("utf-8")
                if not payload:
                    return None
                return json.loads(payload.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                problem_body = exc.read()
            except Exception:
                problem_body = b""
            # Suppress the HTTPError: its str() includes the request URL, and
            # we want only problem fields in our messages.
            raise ProblemError.from_body(exc.code, problem_body, fallback=f"{method} {path} failed") from None

    def _paginate(self, page_fn: Any, **kwargs: Any) -> Iterator[dict[str, Any]]:
        """Yield rows from every page, feeding ``next`` back in as ``after``."""
        after = kwargs.pop("after", None)
        seen: set[int] = set()
        while True:
            page = page_fn(after=after, **kwargs)
            rows: list[dict[str, Any]] = []
            if isinstance(page, dict):
                rows = page.get("data") or page.get("items") or []
                nxt = page.get("next")
            else:
                nxt = None
            yield from rows
            if not isinstance(nxt, int) or nxt in seen:
                return
            seen.add(nxt)
            after = nxt

    # ---- liveness and the document ----------------------------------------

    def health(self) -> dict[str, Any]:
        """GET /v1/health -- liveness (no API key needed)."""
        return self._request("GET", "/v1/health")

    def openapi(self) -> dict[str, Any]:
        """GET /v1/openapi.json -- the server's OpenAPI 3.1 document."""
        return self._request("GET", "/v1/openapi.json")

    # ---- accounts ---------------------------------------------------------

    def list_accounts_page(self) -> dict[str, Any]:
        """GET /v1/accounts -- one page (the watch list is not paged)."""
        return self._request("GET", "/v1/accounts")

    def list_accounts(self) -> Iterator[dict[str, Any]]:
        """Iterate over watched accounts."""
        yield from (self.list_accounts_page().get("data") or [])

    def watch_account(self, account: str) -> dict[str, Any]:
        """POST /v1/accounts -- start watching a G... account (idempotent)."""
        return self._request("POST", "/v1/accounts", body={"account": account})

    def unwatch_account(self, account: str, *, force: bool | None = None) -> None:
        """DELETE /v1/accounts/{account} -- stop watching it."""
        return self._request("DELETE", f"/v1/accounts/{urllib.parse.quote(account, safe='')}", params={"force": force})

    # ---- movements and decisions ------------------------------------------

    def list_movements_page(
        self,
        *,
        after: int | None = None,
        limit: int | None = None,
        disposition: str | None = None,
        account: str | None = None,
        entityId: str | None = None,
        txHash: str | None = None,
        from_: str | None = None,
        to_: str | None = None,
        fromLedger: int | None = None,
        toLedger: int | None = None,
        counterparty: str | None = None,
        kind: str | None = None,
    ) -> dict[str, Any]:
        """GET /v1/movements -- one page. ``from_``/``to_`` map to ``from``/``to``."""
        return self._request(
            "GET",
            "/v1/movements",
            params={
                "after": after,
                "limit": limit,
                "disposition": disposition,
                "account": account,
                "entityId": entityId,
                "txHash": txHash,
                "from": from_,
                "to": to_,
                "fromLedger": fromLedger,
                "toLedger": toLedger,
                "counterparty": counterparty,
                "kind": kind,
            },
        )

    def list_movements(
        self,
        *,
        after: int | None = None,
        limit: int | None = None,
        disposition: str | None = None,
        account: str | None = None,
        entityId: str | None = None,
        txHash: str | None = None,
        from_: str | None = None,
        to_: str | None = None,
        fromLedger: int | None = None,
        toLedger: int | None = None,
        counterparty: str | None = None,
        kind: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Iterate over all movements in ingest order, following ``next``."""
        return self._paginate(
            self.list_movements_page,
            after=after,
            limit=limit,
            disposition=disposition,
            account=account,
            entityId=entityId,
            txHash=txHash,
            from_=from_,
            to_=to_,
            fromLedger=fromLedger,
            toLedger=toLedger,
            counterparty=counterparty,
            kind=kind,
        )

    def get_movement(self, id: str) -> dict[str, Any]:
        """GET /v1/movements/{id} -- a movement with its allocations and more."""
        return self._request("GET", f"/v1/movements/{urllib.parse.quote(id, safe='')}")

    def explain_movement(self, id: str) -> dict[str, Any]:
        """GET /v1/movements/{id}/explain -- recorded vs current decision."""
        return self._request("GET", f"/v1/movements/{urllib.parse.quote(id, safe='')}/explain")

    def replay_decisions(
        self,
        *,
        from_: str | None = None,
        to_: str | None = None,
        threshold: float | None = None,
        margin: float | None = None,
        strategy: str | list[str] | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        """GET /v1/decisions/replay -- read-only decision replay report."""
        return self._request(
            "GET",
            "/v1/decisions/replay",
            params={"from": from_, "to": to_, "threshold": threshold, "margin": margin, "strategy": strategy, "limit": limit},
        )

    # ---- schedules ---------------------------------------------------------

    def list_schedules_page(
        self, *, after: int | None = None, limit: int | None = None, activeOnly: str | None = None
    ) -> dict[str, Any]:
        """GET /v1/schedules -- one page."""
        return self._request(
            "GET", "/v1/schedules", params={"after": after, "limit": limit, "activeOnly": activeOnly}
        )

    def list_schedules(
        self, *, after: int | None = None, limit: int | None = None, activeOnly: str | None = None
    ) -> Iterator[dict[str, Any]]:
        """Iterate over schedules."""
        return self._paginate(
            self.list_schedules_page, after=after, limit=limit, activeOnly=activeOnly
        )

    def create_schedule(
        self,
        *,
        referencePattern: str,
        account: str,
        amount: Any,
        cadence: dict[str, Any],
        startAt: str,
        asset: str | None = None,
        direction: str | None = None,
        memo: dict[str, str] | None = None,
        payers: list[str] | None = None,
        endAt: str | None = None,
    ) -> dict[str, Any]:
        """POST /v1/schedules -- create a schedule. Amounts go out as strings."""
        return self._request(
            "POST",
            "/v1/schedules",
            body=_body(
                referencePattern=referencePattern,
                account=account,
                amount=amount,
                asset=_asset_of(amount, asset),
                direction=direction,
                memo=memo,
                payers=payers,
                cadence=cadence,
                startAt=startAt,
                endAt=endAt,
            ),
        )

    def get_schedule(self, id: str) -> dict[str, Any]:
        """GET /v1/schedules/{id}."""
        return self._request("GET", f"/v1/schedules/{urllib.parse.quote(id, safe='')}")

    def end_schedule(self, id: str) -> dict[str, Any]:
        """POST /v1/schedules/{id}/end."""
        return self._request("POST", f"/v1/schedules/{urllib.parse.quote(id, safe='')}/end")

    # ---- expectations ------------------------------------------------------

    def list_expectations_page(
        self,
        *,
        after: int | None = None,
        limit: int | None = None,
        status: str | None = None,
        account: str | None = None,
    ) -> dict[str, Any]:
        """GET /v1/expectations -- one page."""
        return self._request(
            "GET",
            "/v1/expectations",
            params={"after": after, "limit": limit, "status": status, "account": account},
        )

    def list_expectations(
        self,
        *,
        after: int | None = None,
        limit: int | None = None,
        status: str | None = None,
        account: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Iterate over expectations in creation order, following ``next``."""
        return self._paginate(
            self.list_expectations_page, after=after, limit=limit, status=status, account=account
        )

    def get_expectation(self, id: str) -> dict[str, Any]:
        """GET /v1/expectations/{id} -- with its allocations."""
        return self._request("GET", f"/v1/expectations/{urllib.parse.quote(id, safe='')}")

    def get_expectation_by_reference(self, reference: str) -> dict[str, Any]:
        """GET /v1/expectations/by-reference?reference=..."""
        return self._request("GET", "/v1/expectations/by-reference", params={"reference": reference})

    def create_expectation(
        self,
        *,
        reference: str,
        account: str,
        amount: Any,
        asset: str | None = None,
        direction: str | None = None,
        muxedId: str | None = None,
        memo: dict[str, str] | None = None,
        payers: list[str] | None = None,
        dueAt: str | None = None,
        expiresAt: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """POST /v1/expectations -- record what you are owed or will pay."""
        return self._request(
            "POST",
            "/v1/expectations",
            body=_body(
                reference=reference,
                account=account,
                amount=amount,
                asset=_asset_of(amount, asset),
                direction=direction,
                muxedId=muxedId,
                memo=memo,
                payers=payers,
                dueAt=dueAt,
                expiresAt=expiresAt,
                metadata=metadata,
            ),
        )

    def batch_create_expectations(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        """POST /v1/expectations/batch -- create or compare up to 1000 items."""
        return self._request("POST", "/v1/expectations/batch", body=items)

    def cancel_expectation(self, id: str, *, reason: str) -> dict[str, Any]:
        """POST /v1/expectations/{id}/cancel."""
        return self._request(
            "POST", f"/v1/expectations/{urllib.parse.quote(id, safe='')}/cancel", body={"reason": reason}
        )

    def amend_expectation(
        self,
        id: str,
        *,
        reason: str,
        amount: Any = _UNSET,
        muxedId: str | None = _UNSET,
        memo: dict[str, str] | None = _UNSET,
        payers: list[str] | None = _UNSET,
        dueAt: str | None = _UNSET,
        expiresAt: str | None = _UNSET,
        metadata: dict[str, str] | None = _UNSET,
    ) -> dict[str, Any]:
        """POST /v1/expectations/{id}/amend -- change an open expectation.

        A field left out is unchanged; pass ``None`` explicitly to clear
        ``muxedId``, ``memo``, ``dueAt`` or ``expiresAt``.
        """
        fields = {
            "reason": reason,
            "amount": amount,
            "muxedId": muxedId,
            "memo": memo,
            "payers": payers,
            "dueAt": dueAt,
            "expiresAt": expiresAt,
            "metadata": metadata,
        }
        body = {key: value for key, value in fields.items() if value is not _UNSET}
        return self._request(
            "POST", f"/v1/expectations/{urllib.parse.quote(id, safe='')}/amend", body=body
        )

    # ---- exceptions --------------------------------------------------------

    def list_exceptions_page(
        self,
        *,
        after: int | None = None,
        limit: int | None = None,
        status: str | None = None,
        code: str | None = None,
        movementId: str | None = None,
        expectationId: str | None = None,
    ) -> dict[str, Any]:
        """GET /v1/exceptions -- one page."""
        return self._request(
            "GET",
            "/v1/exceptions",
            params={
                "after": after,
                "limit": limit,
                "status": status,
                "code": code,
                "movementId": movementId,
                "expectationId": expectationId,
            },
        )

    def list_exceptions(
        self,
        *,
        after: int | None = None,
        limit: int | None = None,
        status: str | None = None,
        code: str | None = None,
        movementId: str | None = None,
        expectationId: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Iterate over exceptions in the order they were opened."""
        return self._paginate(
            self.list_exceptions_page,
            after=after,
            limit=limit,
            status=status,
            code=code,
            movementId=movementId,
            expectationId=expectationId,
        )

    def get_exception(self, id: str) -> dict[str, Any]:
        """GET /v1/exceptions/{id} -- with its movement and expectation."""
        return self._request("GET", f"/v1/exceptions/{urllib.parse.quote(id, safe='')}")

    def resolve_exception(self, id: str, *, decision: dict[str, Any]) -> dict[str, Any]:
        """POST /v1/exceptions/{id}/resolve -- apply, ignore or close.

        ``decision`` is the decision object itself, e.g.
        ``{"action": "ignore", "note": "..."}``. Allocation ``amount`` fields
        are sent as decimal strings.
        """
        return self._request(
            "POST", f"/v1/exceptions/{urllib.parse.quote(id, safe='')}/resolve", body=decision
        )

    def resolve_exceptions(self, *, mode: str, decisions: list[dict[str, Any]]) -> dict[str, Any]:
        """POST /v1/exceptions/resolve -- decide many exceptions at once."""
        return self._request("POST", "/v1/exceptions/resolve", body={"mode": mode, "decisions": decisions})

    # ---- events and rounds -------------------------------------------------

    def list_events_page(self, *, after: int | None = None, limit: int | None = None) -> dict[str, Any]:
        """GET /v1/events -- one page of the event log."""
        return self._request("GET", "/v1/events", params={"after": after, "limit": limit})

    def list_events(
        self, *, after: int | None = None, limit: int | None = None
    ) -> Iterator[dict[str, Any]]:
        """Iterate over the event log, the same events webhooks deliver."""
        return self._paginate(self.list_events_page, after=after, limit=limit)

    def trigger_round(self, *, account: str | None = None) -> dict[str, Any]:
        """POST /v1/rounds -- ask serve to run a sync/reconcile round now."""
        return self._request("POST", "/v1/rounds", body=_body(account=account))

    def get_round(self, id: str) -> dict[str, Any]:
        """GET /v1/rounds/{id} -- a round's status and summary."""
        return self._request("GET", f"/v1/rounds/{urllib.parse.quote(id, safe='')}")

    # ---- webhook delivery status -------------------------------------------

    def list_webhook_consumers_page(self) -> dict[str, Any]:
        """GET /v1/webhooks -- the consumer list (not paged)."""
        return self._request("GET", "/v1/webhooks")

    def list_webhook_consumers(self) -> Iterator[dict[str, Any]]:
        """GET /v1/webhooks -- iterate over consumers in this tenant."""
        yield from (self.list_webhook_consumers_page().get("data") or [])

    def webhook_status(self, consumer: str) -> dict[str, Any]:
        """GET /v1/webhooks/{consumer}/status -- position, lag and outcomes."""
        return self._request("GET", f"/v1/webhooks/{urllib.parse.quote(consumer, safe='')}/status")

    def webhook_attempts_page(
        self,
        consumer: str,
        *,
        after: int | None = None,
        limit: int | None = None,
        outcome: str | None = None,
    ) -> dict[str, Any]:
        """GET /v1/webhooks/{consumer}/attempts -- one page, newest first."""
        return self._request(
            "GET",
            f"/v1/webhooks/{urllib.parse.quote(consumer, safe='')}/attempts",
            params={"after": after, "limit": limit, "outcome": outcome},
        )

    def webhook_attempts(
        self,
        consumer: str,
        *,
        after: int | None = None,
        limit: int | None = None,
        outcome: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Iterate over a consumer's delivery attempts."""
        return self._paginate(
            lambda **kw: self.webhook_attempts_page(consumer, **kw),
            after=after,
            limit=limit,
            outcome=outcome,
        )

    def replay_webhook(self, consumer: str, *, expectedSeq: int, toSeq: int, actor: str) -> dict[str, Any]:
        """POST /v1/webhooks/{consumer}/replay -- rewind a consumer (CAS)."""
        return self._request(
            "POST",
            f"/v1/webhooks/{urllib.parse.quote(consumer, safe='')}/replay",
            body={"expectedSeq": expectedSeq, "toSeq": toSeq, "actor": actor},
        )

    # ---- journal -----------------------------------------------------------

    def list_journal_entries_page(
        self,
        *,
        after: int | None = None,
        limit: int | None = None,
        from_: str | None = None,
        to_: str | None = None,
        entityId: str | None = None,
    ) -> dict[str, Any]:
        """GET /v1/journal -- one page, in posting order."""
        return self._request(
            "GET",
            "/v1/journal",
            params={"after": after, "limit": limit, "from": from_, "to": to_, "entityId": entityId},
        )

    def list_journal_entries(
        self,
        *,
        after: int | None = None,
        limit: int | None = None,
        from_: str | None = None,
        to_: str | None = None,
        entityId: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Iterate over journal entries, following ``next``."""
        return self._paginate(
            self.list_journal_entries_page,
            after=after,
            limit=limit,
            from_=from_,
            to_=to_,
            entityId=entityId,
        )

    def post_manual_journal_entry(
        self,
        *,
        description: str,
        reason: str,
        lines: list[dict[str, Any]],
        note: str | None = None,
        postedBy: str | None = None,
        movementId: str | None = None,
        effectiveAt: str | None = None,
    ) -> dict[str, Any]:
        """POST /v1/journal -- post a balanced manual entry.

        Each line needs ``account``, ``role``, ``side`` and ``amount``. Amounts
        may be strings, ``Decimal`` or ``Money``; a ``Money`` also supplies the
        line's ``asset`` when it is omitted.
        """
        prepared = []
        for line in lines:
            item = dict(line)
            if "asset" not in item and isinstance(item.get("amount"), Money):
                item["asset"] = item["amount"].asset
            prepared.append(item)
        return self._request(
            "POST",
            "/v1/journal",
            body=_body(
                description=description,
                reason=reason,
                note=note,
                postedBy=postedBy,
                movementId=movementId,
                effectiveAt=effectiveAt,
                lines=prepared,
            ),
        )

    def export_journal(
        self, *, from_: str | None = None, to_: str | None = None, entityId: str | None = None
    ) -> str:
        """GET /v1/journal.csv -- the journal as RFC 4180 CSV text."""
        return self._request(
            "GET", "/v1/journal.csv", params={"from": from_, "to": to_, "entityId": entityId}, raw=True
        )

    # ---- reports and chart -------------------------------------------------

    def trial_balance(self, *, asOf: str | None = None, entityId: str | None = None) -> dict[str, Any]:
        """GET /v1/reports/trial-balance."""
        return self._request("GET", "/v1/reports/trial-balance", params={"asOf": asOf, "entityId": entityId})

    def account_ledger(
        self,
        *,
        account: str,
        asset: str,
        from_: str | None = None,
        to_: str | None = None,
        entityId: str | None = None,
    ) -> dict[str, Any]:
        """GET /v1/reports/ledger -- running balance for one account and asset."""
        return self._request(
            "GET",
            "/v1/reports/ledger",
            params={"account": account, "asset": asset, "from": from_, "to": to_, "entityId": entityId},
        )

    def balance_sheet(self, *, asOf: str | None = None, entityId: str | None = None) -> dict[str, Any]:
        """GET /v1/reports/balance-sheet."""
        return self._request("GET", "/v1/reports/balance-sheet", params={"asOf": asOf, "entityId": entityId})

    def income_statement(
        self, *, from_: str | None = None, to_: str | None = None, entityId: str | None = None
    ) -> dict[str, Any]:
        """GET /v1/reports/income."""
        return self._request(
            "GET", "/v1/reports/income", params={"from": from_, "to": to_, "entityId": entityId}
        )

    def move_account(self, *, from_: str, to_: str, note: str | None = None, effectiveAt: str | None = None) -> dict[str, Any]:
        """POST /v1/chart/move -- move all balances from one code to another.

        ``from_``/``to_`` map to the body fields ``from``/``to`` (Python
        keywords cannot be parameter names).
        """
        return self._request(
            "POST",
            "/v1/chart/move",
            body=_body(**{"from": from_, "to": to_, "note": note, "effectiveAt": effectiveAt}),
        )
