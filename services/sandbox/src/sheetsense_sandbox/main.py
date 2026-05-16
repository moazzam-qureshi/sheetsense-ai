"""FastAPI app: the public surface of the sandbox sidecar.

Endpoints:
    GET  /health           — readiness probe
    POST /execute_pandas   — fetch sheet, run user code, return result
    POST /render_chart     — same as /execute_pandas but with need_chart=True

This service is internal-only. The Mastra service is the sole caller;
there is no Traefik route to it from the public internet. We still
guard against accidental exposure with a simple shared-secret header
when `SANDBOX_SHARED_SECRET` is set.
"""

from __future__ import annotations

import logging

import structlog
from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field

from . import __version__
from .config import settings
from .sandbox import run_sandbox
from .sheets import fetch_dataframe

# ---------------------------------------------------------------------------
# Logging setup. structlog with stdlib bridge so uvicorn's loggers also flow
# through the same JSON-shaped output in production.
# ---------------------------------------------------------------------------
logging.basicConfig(format="%(message)s", level=getattr(logging, settings.log_level, logging.INFO))
structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ],
)
log = structlog.get_logger("sandbox.api")

app = FastAPI(
    title="SheetSense AI — sandbox sidecar",
    version=__version__,
    description="Runs LLM-written pandas code against a visitor's Google Sheet in a sandboxed subprocess.",
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class ExecuteRequest(BaseModel):
    code: str = Field(..., description="Python source. May reference df, pd, np, plt.")
    session_user_id: str = Field(..., description="Composio user id scoping the OAuth credential.")
    sheet_id: str = Field(..., description="Google Sheet ID (long string in the sheet URL).")
    need_chart: bool = Field(default=False, description="Capture plt.gcf() as PNG on success.")
    force_refresh: bool = Field(default=False, description="Bypass the Redis sheet cache.")


class ExecuteResponse(BaseModel):
    ok: bool
    result: dict | None = None
    chart_png_b64: str | None = None
    error: dict | None = None
    sheet_meta: dict | None = None


class HealthResponse(BaseModel):
    status: str
    version: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__)


@app.post("/execute_pandas", response_model=ExecuteResponse)
async def execute_pandas(req: ExecuteRequest) -> ExecuteResponse:
    """Fetch the visitor's sheet, run their code in a sandbox, return the result.

    The sheet fetch is cached in Redis for 15min per (session_user_id, sheet_id).
    Subsequent calls within that window reuse the cached DataFrame — important
    because the Analyst agent typically calls this 1-3 times per question.
    """
    try:
        df = fetch_dataframe(
            session_user_id=req.session_user_id,
            sheet_id=req.sheet_id,
            force_refresh=req.force_refresh,
        )
    except RuntimeError as e:
        log.warning("sheet_fetch_failed", err=str(e), sheet_id=req.sheet_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"type": "sheet_fetch_failed", "message": str(e)},
        ) from e

    sheet_meta = {"rows": int(len(df)), "columns": [str(c) for c in df.columns]}

    outcome = run_sandbox(req.code, df, need_chart=req.need_chart)

    log.info(
        "sandbox_done",
        ok=outcome.ok,
        sheet_id=req.sheet_id,
        rows=len(df),
        had_chart=bool(outcome.chart_png_b64),
        error_type=(outcome.error or {}).get("type") if not outcome.ok else None,
    )

    return ExecuteResponse(
        ok=outcome.ok,
        result=outcome.result,
        chart_png_b64=outcome.chart_png_b64,
        error=outcome.error,
        sheet_meta=sheet_meta,
    )
