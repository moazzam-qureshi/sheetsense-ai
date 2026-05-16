"""Parent-side sandbox driver.

The FastAPI handler calls `run_sandbox()`, which spawns the runner
module in a fresh Python subprocess, feeds it the user code + pickled
DataFrame on stdin, waits with a wall-clock timeout, and parses the
JSON envelope from stdout.

The subprocess applies its own RLIMIT_CPU and RLIMIT_AS; if those fire
before the wall-clock timeout, the kernel sends SIGKILL and we get an
empty stdout — handled as a timeout-ish failure.

This module is the only place that knows how to spawn a runner. Tests
exercise it directly without touching FastAPI.
"""

from __future__ import annotations

import base64
import json
import pickle
import subprocess
import sys
from dataclasses import dataclass
from typing import Any

import pandas as pd
import structlog

from .config import settings

log = structlog.get_logger("sandbox.driver")


@dataclass
class SandboxResult:
    """Parent-visible result of one sandbox execution."""

    ok: bool
    result: dict[str, Any] | None
    chart_png_b64: str | None
    error: dict[str, Any] | None


def run_sandbox(
    code: str,
    df: pd.DataFrame,
    need_chart: bool = False,
    timeout_sec: float | None = None,
) -> SandboxResult:
    """Execute `code` in a fresh subprocess with `df` pre-bound as `df`.

    Args:
        code: Python source. May reference `df`, `pd`, `np`, `plt`.
            May assign `result = ...` OR leave the result as the last
            expression. Imports outside the allow-list raise ImportError.
        df: The pandas DataFrame to pre-bind in the subprocess namespace.
        need_chart: If True and the user called any `plt.*` plotting
            function, the figure is captured as PNG and returned as
            base64.
        timeout_sec: Wall-clock cap. Defaults to settings.timeout_sec.

    Returns:
        SandboxResult with ok=True and `result` populated on success,
        or ok=False and `error` populated on any failure mode
        (timeout, OOM, blocked syscall, user-code exception, etc.).
    """
    payload = json.dumps(
        {
            "code": code,
            "df_pickle_b64": base64.b64encode(pickle.dumps(df)).decode("ascii"),
            "need_chart": need_chart,
            "rlimit_cpu_sec": settings.rlimit_cpu_sec,
            "rlimit_as_mb": settings.rlimit_as_mb,
        }
    )

    wall_clock = timeout_sec if timeout_sec is not None else settings.timeout_sec

    log.info(
        "sandbox_spawn",
        code_len=len(code),
        df_rows=len(df),
        df_cols=len(df.columns),
        need_chart=need_chart,
        wall_clock_sec=wall_clock,
    )

    try:
        proc = subprocess.run(
            [sys.executable, "-m", "sheetsense_sandbox.runner"],
            input=payload,
            capture_output=True,
            text=True,
            timeout=wall_clock,
            check=False,
        )
    except subprocess.TimeoutExpired:
        log.warning("sandbox_timeout", wall_clock_sec=wall_clock)
        return SandboxResult(
            ok=False,
            result=None,
            chart_png_b64=None,
            error={
                "type": "timeout",
                "message": f"sandbox exceeded {wall_clock}s wall-clock limit",
                "traceback_excerpt": "",
            },
        )

    # SIGKILL from the kernel (RLIMIT_CPU/RLIMIT_AS overrun) → no stdout.
    if not proc.stdout:
        log.warning(
            "sandbox_no_stdout",
            returncode=proc.returncode,
            stderr_excerpt=proc.stderr[-500:] if proc.stderr else "",
        )
        return SandboxResult(
            ok=False,
            result=None,
            chart_png_b64=None,
            error={
                "type": "killed",
                "message": f"sandbox subprocess killed (returncode={proc.returncode}). "
                "Likely RLIMIT_CPU or RLIMIT_AS exceeded.",
                "traceback_excerpt": proc.stderr[-500:] if proc.stderr else "",
            },
        )

    try:
        envelope = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        log.error("sandbox_bad_json", stdout_excerpt=proc.stdout[:500], err=str(e))
        return SandboxResult(
            ok=False,
            result=None,
            chart_png_b64=None,
            error={
                "type": "bad_envelope",
                "message": "subprocess returned non-JSON stdout",
                "traceback_excerpt": proc.stdout[:500],
            },
        )

    if envelope.get("ok"):
        return SandboxResult(
            ok=True,
            result=envelope.get("result"),
            chart_png_b64=envelope.get("chart_png_b64"),
            error=None,
        )

    return SandboxResult(
        ok=False,
        result=None,
        chart_png_b64=None,
        error=envelope.get("error") or {"type": "unknown", "message": "", "traceback_excerpt": ""},
    )
