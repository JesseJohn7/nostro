"""Errors returned by the API, as RFC 9457 problem details."""

from __future__ import annotations

import json
from typing import Any


class ProblemError(Exception):
    """A non-2xx response from the API.

    The server answers with ``application/problem+json``: a stable ``code``,
    a human-readable ``detail``, and the usual ``title``/``status``/``type``
    fields. Branch on ``code``, never on ``detail`` text.
    """

    def __init__(
        self,
        status: int,
        code: str,
        detail: str,
        title: str = "",
        type: str = "about:blank",  # noqa: A002 - the RFC field is named "type"
    ) -> None:
        self.status = status
        self.code = code
        self.detail = detail
        self.title = title
        self.type = type
        # The message deliberately contains only problem fields. The API key
        # lives in a request header and must never end up in an exception.
        super().__init__(f"HTTP {status} {code}: {detail}")

    @classmethod
    def from_body(cls, status: int, body: bytes, fallback: str = "") -> "ProblemError":
        """Build a ProblemError from a problem+json response body."""
        data: dict[str, Any] = {}
        try:
            parsed = json.loads(body.decode("utf-8"))
            if isinstance(parsed, dict):
                data = parsed
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass

        try:
            reported_status = int(data.get("status", status))
        except (TypeError, ValueError):
            reported_status = status

        return cls(
            status=reported_status,
            code=str(data.get("code") or "internal"),
            detail=str(data.get("detail") or fallback or f"HTTP {status}"),
            title=str(data.get("title") or ""),
            type=str(data.get("type") or "about:blank"),
        )
