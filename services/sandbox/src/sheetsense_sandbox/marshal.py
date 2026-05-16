"""Result marshaling: convert sandbox subprocess output into a JSON-safe payload bounded in size.

The architectural keystone: the full DataFrame never leaves the sandbox.
Only the analysis *result* flows back to the LLM. Everything here exists
to enforce that bound — caps on row counts, column widths, string lengths.
"""

from __future__ import annotations

import datetime as dt
import math
from typing import Any

import numpy as np
import pandas as pd

from .config import settings


def _cap_str(s: Any, limit: int = 200) -> str:
    """Cast to str and cap at `limit` chars (truncated with ellipsis)."""
    text = str(s)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _safe_scalar(val: Any) -> Any:
    """Convert numpy/pandas scalars and special floats to JSON-native types.

    - np.int*, np.float*, np.bool_ → Python int/float/bool
    - pd.Timestamp, datetime, date → ISO 8601 string
    - NaN, inf, -inf → None  (json.dumps cannot encode these)
    - Anything else stringified, capped at 200 chars
    """
    if val is None:
        return None
    if isinstance(val, (bool, np.bool_)):
        return bool(val)
    if isinstance(val, (int, np.integer)):
        return int(val)
    if isinstance(val, (float, np.floating)):
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    if isinstance(val, (pd.Timestamp, dt.datetime, dt.date)):
        return val.isoformat()
    if isinstance(val, (str, bytes)):
        return _cap_str(val)
    return _cap_str(val)


def marshal_result(value: Any) -> dict[str, Any]:
    """Convert a sandbox return value into a JSON-safe payload.

    The result envelope shape is stable across all return types so the
    Analyst agent and the Writer agent can pattern-match without
    type-sniffing:

        {
          "kind": "dataframe" | "series" | "scalar" | "dict" | "list" | "null",
          "value": <jsonable>,
          "shape": [rows, cols]  // dataframe only
          "truncated": bool,     // true if we capped row count
        }
    """
    # DataFrame → records (capped row count, capped column widths)
    if isinstance(value, pd.DataFrame):
        total_rows = len(value)
        cap = settings.max_result_rows
        df = value.head(cap)
        records: list[dict[str, Any]] = []
        for _, row in df.iterrows():
            records.append({str(col): _safe_scalar(row[col]) for col in df.columns})
        return {
            "kind": "dataframe",
            "value": records,
            "columns": [str(c) for c in df.columns],
            "shape": [int(total_rows), int(len(df.columns))],
            "truncated": total_rows > cap,
        }

    # Series → dict (capped entry count)
    if isinstance(value, pd.Series):
        total = len(value)
        cap = settings.max_result_rows
        s = value.head(cap)
        return {
            "kind": "series",
            "name": str(s.name) if s.name is not None else None,
            "value": {_cap_str(k, 80): _safe_scalar(v) for k, v in s.items()},
            "length": int(total),
            "truncated": total > cap,
        }

    # Dict — recurse on values, cap key count
    if isinstance(value, dict):
        cap = settings.max_result_rows
        items = list(value.items())[:cap]
        return {
            "kind": "dict",
            "value": {_cap_str(k, 80): _safe_scalar(v) for k, v in items},
            "length": len(value),
            "truncated": len(value) > cap,
        }

    # List/tuple/ndarray → list (capped, scalars normalized)
    if isinstance(value, (list, tuple, np.ndarray)):
        seq = list(value)
        cap = settings.max_result_rows
        return {
            "kind": "list",
            "value": [_safe_scalar(v) for v in seq[:cap]],
            "length": len(seq),
            "truncated": len(seq) > cap,
        }

    # Scalar (or None)
    if value is None:
        return {"kind": "null", "value": None}
    return {"kind": "scalar", "value": _safe_scalar(value)}
