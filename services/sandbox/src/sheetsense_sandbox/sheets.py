"""Composio Google Sheets fetcher with Redis-backed pickle cache.

The sandbox needs a `pd.DataFrame` to run user code against. We fetch
once via Composio's Sheets read tool, parse to DataFrame, pickle, and
cache in Redis for `SHEET_CACHE_TTL_SEC` (default 15 min). Follow-up
questions in the same session reuse the cached DataFrame — no repeated
Sheets API calls, no token waste.

Cache key shape:
    sandbox:sheet:<session_user_id>:<sheet_id>

`session_user_id` is the per-visitor Composio user id minted by the
Mastra service on /api/session/start. For the 3 demo sample sheets,
it's the shared `COMPOSIO_DEMO_USER_ID`.
"""

from __future__ import annotations

import pickle
from typing import Any

import pandas as pd
import redis
import structlog
from composio import Composio

from .config import settings

log = structlog.get_logger("sandbox.sheets")


# Module-level Composio client + Redis client. Created lazily on first use
# so import-time issues (missing env vars in tests, etc.) surface only
# when the endpoint is actually called.
_composio: Composio | None = None
_redis: redis.Redis | None = None


def _composio_client() -> Composio:
    global _composio
    if _composio is None:
        if not settings.composio_api_key:
            raise RuntimeError("COMPOSIO_API_KEY not set")
        _composio = Composio(api_key=settings.composio_api_key)
    return _composio


def _redis_client() -> redis.Redis:
    global _redis
    if _redis is None:
        _redis = redis.from_url(settings.redis_url)
    return _redis


def _cache_key(session_user_id: str, sheet_id: str) -> str:
    return f"sandbox:sheet:{session_user_id}:{sheet_id}"


def fetch_dataframe(
    session_user_id: str,
    sheet_id: str,
    *,
    force_refresh: bool = False,
) -> pd.DataFrame:
    """Return the visitor's sheet as a DataFrame, caching on hit.

    Args:
        session_user_id: Composio user id scoping the OAuth credential.
        sheet_id: Google Sheet ID (the long string in the sheet URL).
        force_refresh: Skip the cache and re-fetch.

    Raises:
        RuntimeError: If Composio is misconfigured or the Sheets call fails.
    """
    rds = _redis_client()
    key = _cache_key(session_user_id, sheet_id)

    if not force_refresh:
        cached = rds.get(key)
        if cached is not None:
            log.info("sheet_cache_hit", session_user_id=session_user_id, sheet_id=sheet_id)
            df = pickle.loads(cached)
            assert isinstance(df, pd.DataFrame)
            return df

    log.info("sheet_cache_miss_fetching", session_user_id=session_user_id, sheet_id=sheet_id)

    df = _fetch_via_composio(session_user_id, sheet_id)

    # Cache (TTL prevents stale data after the visitor edits the sheet).
    rds.setex(key, settings.sheet_cache_ttl_sec, pickle.dumps(df))
    log.info(
        "sheet_cached",
        session_user_id=session_user_id,
        sheet_id=sheet_id,
        rows=len(df),
        cols=len(df.columns),
        ttl_sec=settings.sheet_cache_ttl_sec,
    )
    return df


def _fetch_via_composio(session_user_id: str, sheet_id: str) -> pd.DataFrame:
    """Call Composio's Sheets read tool and parse the response to DataFrame.

    Composio's Google Sheets tool returns rows as `list[list[Any]]`
    when called via `composio.tools.execute`. We assume row 0 is the
    header row.
    """
    client = _composio_client()

    # Tool slug taken from Composio's published catalogue. If the
    # toolkit's tool name changes between versions, this is the line
    # that needs updating.
    response = client.tools.execute(
        "GOOGLESHEETS_BATCH_GET",
        user_id=session_user_id,
        arguments={
            "spreadsheet_id": sheet_id,
            # No `ranges` → return all cells of the first sheet.
            "value_render_option": "UNFORMATTED_VALUE",
            "date_time_render_option": "FORMATTED_STRING",
        },
    )

    if not response or not response.get("successful"):
        err = response.get("error") if response else "no_response"
        raise RuntimeError(f"composio sheets fetch failed: {err}")

    data = response.get("data") or {}
    # Composio's response shape: {"valueRanges": [{"range": "...", "values": [[...]]}, ...]}
    value_ranges = data.get("valueRanges") or data.get("value_ranges") or []
    if not value_ranges:
        raise RuntimeError("sheet has no value ranges")

    rows: list[list[Any]] = value_ranges[0].get("values") or []
    if len(rows) < 2:
        raise RuntimeError("sheet has fewer than 2 rows (need at least header + 1 row)")

    header = [str(c).strip() for c in rows[0]]
    body = rows[1:]

    # Right-pad short rows to header width so DataFrame is rectangular.
    width = len(header)
    body = [r + [None] * (width - len(r)) if len(r) < width else r[:width] for r in body]

    df = pd.DataFrame(body, columns=header)

    # Best-effort type inference. The Schema Detector agent is the source
    # of truth for column types; this is just a clean default so e.g. a
    # currency column doesn't stay as object/string for trivial
    # arithmetic.
    for col in df.columns:
        df[col] = pd.to_numeric(df[col], errors="ignore")

    return df


def evict(session_user_id: str, sheet_id: str) -> None:
    """Manually drop a cached sheet (used by the 24h cleanup actor)."""
    _redis_client().delete(_cache_key(session_user_id, sheet_id))
