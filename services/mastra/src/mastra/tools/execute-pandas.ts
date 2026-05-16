/**
 * `execute_pandas_analysis` — the Analyst agent's only tool.
 *
 * Posts the LLM-written pandas code to the Python sandbox sidecar at
 * `SANDBOX_URL`. The sidecar:
 *   1. Fetches the visitor's sheet via Composio (cached 15min in Redis).
 *   2. Spawns a fresh subprocess with RLIMIT_CPU=10s and RLIMIT_AS=1024MB.
 *   3. Installs a PEP 578 audit hook + restricted import hook.
 *   4. Runs the code with `df`, `pd`, `np`, `plt` pre-bound.
 *   5. Returns either the marshaled `result` (capped at 100 rows) and an
 *      optional chart PNG, OR a structured error envelope.
 *
 * The full DataFrame never enters the LLM context — only the analysis
 * result. This is the architectural keystone (see docs/architecture.md §3).
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const SANDBOX_URL = process.env.SANDBOX_URL ?? "http://sandbox:8001";
// Sandbox enforces ~12s wall-clock internally; HTTP client gives it 30s
// headroom for connect + JSON round-trip on Coolify's internal network.
const SANDBOX_HTTP_TIMEOUT_MS = 30_000;

const ExecuteInput = z.object({
  code: z
    .string()
    .describe(
      "Python pandas source code. The DataFrame is pre-bound as `df`. " +
        "pd, np, plt are available. Either set `result = <expr>` or end " +
        "with a bare expression — both are captured. Keep it tight, no " +
        "imports beyond pandas/numpy/matplotlib/scipy/datetime/re/math.",
    ),
  session_user_id: z
    .string()
    .describe(
      "Per-session Composio user id scoping the OAuth credential. Pass " +
        "the same id the Mastra service minted at /api/session/start.",
    ),
  sheet_id: z.string().describe("Google Sheet ID (long string in the sheet URL)."),
  need_chart: z
    .boolean()
    .default(false)
    .describe("Set true to capture the rendered matplotlib figure as PNG."),
  force_refresh: z
    .boolean()
    .default(false)
    .describe("Bypass the 15-min Redis sheet cache."),
});

const ExecuteOutput = z.object({
  ok: z.boolean(),
  result: z.unknown().nullable().describe("Marshaled DataFrame/Series/scalar/dict/list on success."),
  chart_png_b64: z.string().nullable().describe("Base64-encoded PNG when need_chart was true."),
  error: z
    .object({
      type: z.string(),
      message: z.string(),
      traceback_excerpt: z.string().optional(),
    })
    .nullable(),
  sheet_meta: z
    .object({ rows: z.number(), columns: z.array(z.string()) })
    .nullable()
    .optional(),
});

export const executePandasAnalysisTool = createTool({
  id: "execute_pandas_analysis",
  description:
    "Run pandas code against the visitor's Google Sheet in a sandboxed Python subprocess. " +
    "The full DataFrame stays in the sandbox; only the analysis result (capped at 100 rows) " +
    "is returned. Use this for filters, groupbys, aggregations, time series, ranking, etc. " +
    "Iterate up to 3 times on errors before reporting failure.",
  inputSchema: ExecuteInput,
  outputSchema: ExecuteOutput,
  execute: async (input) => {
    const payload = {
      code: input.code,
      session_user_id: input.session_user_id,
      sheet_id: input.sheet_id,
      need_chart: input.need_chart,
      force_refresh: input.force_refresh,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SANDBOX_HTTP_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${SANDBOX_URL}/execute_pandas`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timer);
      const isAbort = err?.name === "AbortError";
      return {
        ok: false,
        result: null,
        chart_png_b64: null,
        error: {
          type: isAbort ? "sandbox_http_timeout" : "sandbox_http_error",
          message: isAbort
            ? `sandbox call exceeded ${SANDBOX_HTTP_TIMEOUT_MS}ms`
            : String(err?.message ?? err),
        },
        sheet_meta: null,
      };
    }
    clearTimeout(timer);

    if (!response.ok) {
      // Sandbox returns 502 with a structured detail on sheet-fetch
      // failure (e.g. expired OAuth, sheet not accessible).
      let detail: unknown = null;
      try {
        detail = await response.json();
      } catch {
        detail = await response.text().catch(() => "");
      }
      return {
        ok: false,
        result: null,
        chart_png_b64: null,
        error: {
          type: "sandbox_http_status",
          message: `sandbox returned HTTP ${response.status}`,
          traceback_excerpt:
            typeof detail === "string" ? detail.slice(0, 500) : JSON.stringify(detail).slice(0, 500),
        },
        sheet_meta: null,
      };
    }

    const body = (await response.json()) as z.infer<typeof ExecuteOutput>;
    return body;
  },
});
