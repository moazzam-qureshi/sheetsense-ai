"""Direct tests of the sandbox driver — bypass FastAPI + Composio.

Skipped on Windows: the runner uses POSIX `resource.setrlimit`.
"""

from __future__ import annotations

import sys

import pandas as pd
import pytest

from sheetsense_sandbox.sandbox import run_sandbox

pytestmark = pytest.mark.skipif(
    sys.platform == "win32",
    reason="sandbox uses POSIX resource.setrlimit; run in Docker on Windows",
)


@pytest.fixture
def small_df() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "name": ["Anna", "Ben", "Cara", "Drew", "Eli"],
            "status": ["Active", "Cold", "Active", "Cold", "Churned"],
            "ltv_usd": [4200, 1100, 5500, 800, 200],
        }
    )


def test_returns_last_expression(small_df: pd.DataFrame) -> None:
    """If user code ends in an expression, that's the result."""
    out = run_sandbox("df.head(2)", small_df)
    assert out.ok, out.error
    assert out.result is not None
    assert out.result["kind"] == "dataframe"
    assert out.result["shape"] == [2, 3]


def test_returns_explicit_result_var(small_df: pd.DataFrame) -> None:
    """If user code sets `result = ...`, that wins over last expression."""
    out = run_sandbox("result = int(df['ltv_usd'].sum())", small_df)
    assert out.ok, out.error
    assert out.result == {"kind": "scalar", "value": 11800}


def test_blocks_os_system(small_df: pd.DataFrame) -> None:
    """`os` itself is off the import allow-list, the audit hook catches
    os.system at call time, OR the kernel SIGKILLs the subprocess on
    RLIMIT_AS. Any of those proves the boundary."""
    out = run_sandbox('import os\nos.system("whoami")', small_df)
    assert not out.ok
    assert out.error is not None
    assert out.error["type"] in {"blocked_operation", "blocked_import", "killed"}


def test_blocks_subprocess(small_df: pd.DataFrame) -> None:
    out = run_sandbox(
        'import subprocess\nsubprocess.Popen(["whoami"])',
        small_df,
    )
    assert not out.ok
    assert out.error is not None
    # Either blocked_operation (audit) or blocked_import (subprocess is
    # outside the allow-list). Either is acceptable defense.
    assert out.error["type"] in {"blocked_operation", "blocked_import"}


def test_blocks_disallowed_import(small_df: pd.DataFrame) -> None:
    """requests is not on the allow-list."""
    out = run_sandbox("import requests", small_df)
    assert not out.ok
    assert out.error is not None
    assert out.error["type"] == "blocked_import"


def test_blocks_file_write(small_df: pd.DataFrame) -> None:
    """Audit hook rejects open() in write mode."""
    out = run_sandbox('open("/tmp/x", "w").write("nope")', small_df)
    assert not out.ok
    assert out.error is not None
    assert out.error["type"] == "blocked_operation"


def test_user_code_exception_is_clean(small_df: pd.DataFrame) -> None:
    """Bad pandas code returns an error envelope, not a crash."""
    out = run_sandbox("df['nonexistent_column'].sum()", small_df)
    assert not out.ok
    assert out.error is not None
    assert out.error["type"] == "user_code_error"


def test_chart_capture(small_df: pd.DataFrame) -> None:
    """need_chart=True captures the matplotlib figure as PNG."""
    code = "df['ltv_usd'].plot(kind='bar')"
    out = run_sandbox(code, small_df, need_chart=True)
    assert out.ok, out.error
    assert out.chart_png_b64 is not None
    assert len(out.chart_png_b64) > 100  # not just an empty figure


def test_timeout(small_df: pd.DataFrame) -> None:
    """Infinite loop is caught by RLIMIT_CPU or wall-clock."""
    out = run_sandbox("while True:\n    x = 1", small_df, timeout_sec=2.0)
    assert not out.ok
    assert out.error is not None
    # Could be 'timeout' (wall-clock) or 'killed' (RLIMIT_CPU SIGKILL).
    assert out.error["type"] in {"timeout", "killed"}
