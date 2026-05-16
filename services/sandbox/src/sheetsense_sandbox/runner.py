"""Sandbox runner: invoked as a fresh Python subprocess per request.

Lifecycle:
  1. Parent FastAPI process spawns `python -m sheetsense_sandbox.runner`.
  2. We read a JSON payload from stdin:
       { "code": "...", "df_pickle_b64": "...", "need_chart": bool }
  3. We apply RLIMIT_CPU and RLIMIT_AS to *ourselves* (the subprocess).
  4. We install an audit hook that blocks dangerous syscalls.
  5. We unpickle the DataFrame and exec the user code with `df`, `pd`,
     `np`, `plt` pre-bound in a fresh namespace.
  6. We capture either:
       - `result` (if user assigned to it), OR
       - the value of the last expression in the code
  7. We marshal the result and optionally capture a matplotlib chart.
  8. We write a JSON envelope to stdout and exit.

If anything goes wrong (timeout, OOM, blocked syscall, exception) we
write a structured error envelope and exit non-zero. The parent maps
the envelope back into the API response.

This file is `-m`-invoked, NEVER imported by the FastAPI app. That
isolation is intentional — see module docstring.
"""

from __future__ import annotations

import ast
import base64
import io
import json
import pickle
import sys
import traceback
from typing import Any


# ---------------------------------------------------------------------------
# Allow-listed imports inside the sandbox.
# ---------------------------------------------------------------------------
# These are modules the LLM-written pandas code is allowed to import.
# Anything else triggers ImportError. Note: pandas/numpy/matplotlib/scipy
# transitively import many stdlib modules at *their* import time — we
# can't sensibly block those because they happen before user code runs.
# The audit hook below blocks the syscalls that actually matter
# (network, filesystem writes, subprocess spawn) regardless of what
# module the user pretends to import from.
ALLOWED_TOPLEVEL = {
    # Analytics + plotting libraries the user code is expected to use.
    "pandas",
    "numpy",
    "matplotlib",
    "scipy",
    # Pure-Python utility stdlib modules with no security implications
    # of their own. The audit hook is the real boundary — these can
    # still be used in benign ways (math, dates, regex, json) but can't
    # spawn processes, open network sockets, or write files.
    "math",
    "statistics",
    "datetime",
    "re",
    "json",
    "collections",
    "itertools",
    "functools",
    "copy",
    "string",
    "decimal",
    "fractions",
    "operator",
    "typing",
    "warnings",
    # matplotlib calls importlib.metadata.version() on first pyplot use
    # to read its own version. The dangerous part of importlib is the
    # `set_loader` audit event, which is already on the BLOCKED_EVENTS
    # list above. Allowing the import itself is fine.
    "importlib",
}


# ---------------------------------------------------------------------------
# Audit hook (PEP 578). Fires on every privileged operation Python performs.
# ---------------------------------------------------------------------------
def _install_audit_hook() -> None:
    """Block the syscall-level events that matter for sandbox escape."""

    # Events we explicitly block. See https://docs.python.org/3/library/audit_events.html
    BLOCKED_EVENTS = {
        # Subprocess spawn (any form).
        "subprocess.Popen",
        "os.system",
        "os.exec",
        "os.spawn",
        "os.posix_spawn",
        "os.fork",
        "os.forkpty",
        # Network sockets.
        "socket.connect",
        "socket.bind",
        "socket.gethostname",
        "socket.gethostbyname",
        "urllib.Request",
        # Filesystem writes.
        # (os.remove / os.unlink / os.rmdir / os.rename / shutil.* go through
        #  the "open" event with write mode, plus their own audit events.)
        "os.remove",
        "os.rmdir",
        "os.rename",
        "os.replace",
        "os.link",
        "os.symlink",
        "os.chmod",
        "os.chown",
        # Module-system mutation that could replace allowed modules with
        # malicious ones.
        "importlib.set_loader",
        # ctypes — direct memory access, the classic Python sandbox break.
        "ctypes.dlopen",
        "ctypes.dlsym",
        "ctypes.dlsym/handle",
        # Note: we DON'T block "import" — pandas/numpy import dozens of
        # legitimate stdlib modules at startup. We rely on ALLOWED_TOPLEVEL
        # via the import hook below to restrict user-driven imports.
        #
        # Note: we DON'T block "compile" / "exec" / "eval". These events
        # fire from many legitimate places (Python's own importlib
        # bytecode handling, our own _exec_user_code path). They are
        # also useless as a security boundary on their own — even if
        # user code does `exec("import subprocess")`, the import still
        # goes through builtins.__import__ where our restriction lives.
        # The defenses that matter (subprocess spawn, network, file
        # writes, ctypes) are all listed above.
    }

    def _hook(event: str, args: tuple[Any, ...]) -> None:
        if event in BLOCKED_EVENTS:
            raise PermissionError(f"sandbox: blocked event '{event}'")
        # `open` with write/append mode → block.
        if event == "open" and len(args) >= 2:
            mode = args[1]
            if mode and isinstance(mode, str) and any(c in mode for c in ("w", "a", "x", "+")):
                raise PermissionError(f"sandbox: blocked file write (mode={mode!r})")

    sys.addaudithook(_hook)


# ---------------------------------------------------------------------------
# Restricted import hook: limits USER-driven imports to the allow-list.
#
# The hook only fires for imports initiated by user code itself. Library
# code (pandas, matplotlib, scipy, etc.) routinely lazy-imports stdlib
# C-extension modules at first use (`_io`, `_string`, `_decimal`, etc.) —
# these are safe and must be permitted. We distinguish caller intent by
# inspecting the import-call frame: user code carries the synthetic
# "<user_code>" filename we passed to compile() in _exec_user_code.
# ---------------------------------------------------------------------------
_USER_CODE_FILENAMES = {"<user_code>", "<user_code:last>"}


def _install_import_restrictions() -> None:
    """Block user-driven imports outside the allow-list. Library imports pass."""

    import builtins

    original_import = builtins.__import__

    def _restricted_import(name: str, globals=None, locals=None, fromlist=(), level=0):  # noqa: A002
        # Inspect the caller frame: is this import from user code or a
        # transitive library-internal import?
        frame = sys._getframe(1)
        # Walk a few frames up if needed (importlib machinery may sit
        # between us and the real caller).
        caller_is_user = False
        depth = 0
        while frame is not None and depth < 12:
            fname = frame.f_code.co_filename
            if fname in _USER_CODE_FILENAMES:
                caller_is_user = True
                break
            frame = frame.f_back
            depth += 1

        if caller_is_user:
            top = name.split(".", 1)[0]
            if top not in ALLOWED_TOPLEVEL:
                raise ImportError(f"sandbox: import '{name}' is not allowed")

        return original_import(name, globals, locals, fromlist, level)

    builtins.__import__ = _restricted_import


# ---------------------------------------------------------------------------
# Resource limits.
# ---------------------------------------------------------------------------
def _apply_rlimits(cpu_sec: int, as_mb: int) -> None:
    """Cap CPU time and address space for this process.

    Linux-only. The Dockerfile pins linux/amd64, so this is safe.
    Raises ImportError on Windows — fail loud rather than silently
    skipping the security boundary.
    """
    import resource  # POSIX only

    # Hard + soft both set: the kernel sends SIGXCPU at soft, SIGKILL at hard.
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_sec, cpu_sec))
    as_bytes = as_mb * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (as_bytes, as_bytes))


# ---------------------------------------------------------------------------
# Code execution.
# ---------------------------------------------------------------------------
def _exec_user_code(code: str, namespace: dict[str, Any]) -> Any:
    """Execute `code` and return the captured result.

    Capture rule (in order):
      1. If user explicitly set `result = ...`, return that.
      2. Else if the code's last top-level statement is an expression,
         eval it and return its value.
      3. Else return None.
    """
    tree = ast.parse(code, mode="exec")

    last_expr = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last_expr = tree.body.pop()

    if tree.body:
        exec(compile(tree, "<user_code>", "exec"), namespace)  # noqa: S102

    if last_expr is not None:
        last_value = eval(  # noqa: S307
            compile(ast.Expression(last_expr.value), "<user_code:last>", "eval"),
            namespace,
        )
        if "result" not in namespace:
            return last_value

    return namespace.get("result")


# ---------------------------------------------------------------------------
# Entry point.
# ---------------------------------------------------------------------------
def main() -> None:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
        code = payload["code"]
        df_pickle_b64 = payload["df_pickle_b64"]
        need_chart = bool(payload.get("need_chart", False))
        rlimit_cpu = int(payload.get("rlimit_cpu_sec", 5))
        rlimit_as_mb = int(payload.get("rlimit_as_mb", 256))
    except Exception as e:
        _emit_error("bad_payload", str(e), traceback.format_exc())
        sys.exit(2)

    # Heavy imports BEFORE rlimits + audit hook — otherwise the imports
    # themselves trip the safeguards.
    import matplotlib

    matplotlib.use("Agg")  # headless backend, no GUI calls
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd

    # Pre-import the pandas matplotlib plotting backend so `df.plot(...)`
    # in user code doesn't try to dynamically import a module path
    # (`pandas.plotting._matplotlib`) that isn't on the user-import
    # allow-list. Without this, pandas plotting calls fail with a
    # confusing "matplotlib is required" ImportError that's actually
    # *our* import hook firing on pandas's internal lazy import.
    import pandas.plotting._matplotlib  # noqa: F401

    # Unpickle the DataFrame the parent sent us.
    try:
        df = pickle.loads(base64.b64decode(df_pickle_b64))
    except Exception as e:
        _emit_error("df_unpickle_failed", str(e), traceback.format_exc())
        sys.exit(3)

    # Pre-import everything WE need BEFORE locking down imports. The
    # restricted import hook would otherwise block our own internal
    # marshal module (top-level package `sheetsense_sandbox` isn't on
    # the allow-list — and shouldn't be, the user's pandas code has no
    # business importing it).
    from .marshal import marshal_result

    # NOW lock everything down.
    try:
        _apply_rlimits(rlimit_cpu, rlimit_as_mb)
    except Exception as e:
        _emit_error("rlimit_failed", str(e), traceback.format_exc())
        sys.exit(4)

    _install_audit_hook()
    _install_import_restrictions()

    # Build the user code namespace. No __builtins__ stripping — pandas
    # legitimately needs str/int/dict/etc. The audit hook is the boundary.
    namespace: dict[str, Any] = {
        "df": df,
        "pd": pd,
        "np": np,
        "plt": plt,
    }

    try:
        result = _exec_user_code(code, namespace)
        marshaled = marshal_result(result)

        chart_b64: str | None = None
        if need_chart and plt.get_fignums():
            buf = io.BytesIO()
            plt.savefig(buf, format="png", bbox_inches="tight", dpi=110)
            plt.close("all")
            png_bytes = buf.getvalue()
            chart_b64 = base64.b64encode(png_bytes).decode("ascii")

        envelope = {
            "ok": True,
            "result": marshaled,
            "chart_png_b64": chart_b64,
        }
        sys.stdout.write(json.dumps(envelope))
        sys.stdout.flush()
    except MemoryError:
        _emit_error("memory_limit_exceeded", "RLIMIT_AS exceeded", "")
        sys.exit(5)
    except PermissionError as e:
        # Raised by the audit hook on blocked syscalls. Treat as a
        # security incident — caller should be told plainly.
        _emit_error("blocked_operation", str(e), "")
        sys.exit(6)
    except ImportError as e:
        # Raised by the restricted import hook.
        _emit_error("blocked_import", str(e), "")
        sys.exit(7)
    except Exception as e:
        _emit_error("user_code_error", str(e), traceback.format_exc())
        sys.exit(1)


def _emit_error(error_type: str, message: str, traceback_text: str) -> None:
    """Write an error envelope to stdout and let the parent handle it."""
    envelope = {
        "ok": False,
        "error": {
            "type": error_type,
            "message": message,
            # Cap traceback length so we don't blow up the parent log.
            "traceback_excerpt": traceback_text[-2000:] if traceback_text else "",
        },
    }
    sys.stdout.write(json.dumps(envelope))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
