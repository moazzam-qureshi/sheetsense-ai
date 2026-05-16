# sheetsense-sandbox

Python pandas sandbox sidecar for SheetSense AI. Runs LLM-written
pandas code in a subprocess with `RLIMIT_CPU` + `RLIMIT_AS` + a
restricted import hook + a PEP 578 audit hook.

This service is **internal-only** — the Mastra service is the sole
caller. There is no Traefik route from the public internet.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Readiness probe |
| `POST` | `/execute_pandas` | Fetch sheet, run code, return result. With `need_chart=true`, also returns the figure as PNG. |

### `POST /execute_pandas`

Request:
```json
{
  "code": "result = df[df['status'] == 'Cold'].head(5)",
  "session_user_id": "sheetsense_<uuid>",
  "sheet_id": "1AbC...",
  "need_chart": false,
  "force_refresh": false
}
```

Response (success):
```json
{
  "ok": true,
  "result": {
    "kind": "dataframe",
    "value": [{"name": "M. Chen", "status": "Cold", "ltv_usd": 1100}, ...],
    "columns": ["name", "status", "ltv_usd"],
    "shape": [5, 3],
    "truncated": false
  },
  "chart_png_b64": null,
  "sheet_meta": {"rows": 200, "columns": ["name", "email", ...]}
}
```

Response (sandbox error):
```json
{
  "ok": false,
  "error": {
    "type": "blocked_operation" | "blocked_import" | "timeout" | "memory_limit_exceeded" | "user_code_error" | "killed",
    "message": "...",
    "traceback_excerpt": "..."
  }
}
```

## Sandbox guarantees (and honest limits)

- **POSIX-only.** `resource.setrlimit` is Linux/macOS. The container is
  `python:3.13-slim` so this is fine. Running natively on Windows is
  blocked by `import resource` failing — fail loud rather than silently
  skip the security boundary.
- **CPU + memory caps.** `RLIMIT_CPU=10s` and `RLIMIT_AS=1024MB` set in the
  child. Kernel sends SIGXCPU then SIGKILL. Parent has a wall-clock
  timeout 1s longer so we get a clean envelope back on most timeouts.
- **No network, no subprocess spawn, no filesystem writes.** Enforced
  by an audit hook (PEP 578) installed before user code runs.
- **Restricted user-driven imports.** Allow-list: analytics libs
  (`pandas`, `numpy`, `matplotlib`, `scipy`) plus a small set of
  benign pure-Python stdlib modules (`math`, `statistics`, `datetime`,
  `re`, `json`, `collections`, `itertools`, `functools`, `copy`,
  `string`, `decimal`, `fractions`, `operator`, `typing`, `warnings`,
  `importlib`). Anything else raises `ImportError`. The audit hook is
  the real security boundary; the allow-list is defense in depth.
- **The full DataFrame never leaves the sandbox.** Results are capped
  to `MAX_RESULT_ROWS` (default 100) and stringified to ≤200 chars per
  cell. This is the architectural keystone — the LLM's context never
  swells with the user's data, only with the analysis result.
- **Honest limit:** this is a portfolio-demo sandbox, not a true
  multi-tenant SaaS sandbox. A determined attacker who finds a Python
  audit-hook bypass could still escape. For a real product the sandbox
  would run in an isolated container per request (E2B, Modal,
  Firecracker microVM). Behind a Turnstile gate + per-IP cost ceiling
  the residual risk is acceptable; we document it rather than hide it.

## Local development

```bash
cd services/sandbox

# Install uv if you don't have it: https://docs.astral.sh/uv/getting-started/installation/
uv sync

# Run the FastAPI app
uv run uvicorn sheetsense_sandbox.main:app --reload --port 8001

# Health check
curl http://localhost:8001/health
```

To exercise the sandbox without setting up Composio first, use the
unit test in `tests/test_sandbox.py` which bypasses the Sheets fetch
and pokes `run_sandbox()` directly with a synthetic DataFrame.

## Smoke test (after `docker compose up`)

```bash
# Trivial successful run
curl -s -X POST http://localhost:8001/execute_pandas \
  -H 'content-type: application/json' \
  -d '{
    "code": "result = df.head(3)",
    "session_user_id": "sheetsense_demo",
    "sheet_id": "<a-sheet-id-the-demo-user-has-access-to>",
    "need_chart": false
  }' | jq .

# Blocked syscall (should return ok=false, error.type=blocked_operation)
curl -s -X POST http://localhost:8001/execute_pandas \
  -H 'content-type: application/json' \
  -d '{
    "code": "import os; os.system(\"whoami\")",
    "session_user_id": "sheetsense_demo",
    "sheet_id": "<a-sheet-id-the-demo-user-has-access-to>"
  }' | jq .
```
