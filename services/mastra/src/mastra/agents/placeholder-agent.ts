/**
 * Placeholder agent (Phase 3).
 *
 * The 4 real agents (Schema Detector, Query Planner, Analyst, Writer)
 * land in Phase 4. This placeholder gives the Mastra service something
 * to register at boot so the server starts cleanly and Studio has a
 * tool to render, which lets us verify the scaffold + Postgres + the
 * sandbox-HTTP tool wiring before any LLM agent logic is involved.
 *
 * It also exercises the `execute_pandas_analysis` tool end-to-end —
 * if Studio can call it against a sample sheet, the Phase 3 stack is
 * proven to work for Phase 4.
 */

import { Agent } from "@mastra/core/agent";

import { executePandasAnalysisTool } from "../tools/execute-pandas.js";

export const placeholderAgent = new Agent({
  id: "placeholder-agent",
  name: "Placeholder Agent",
  description:
    "Phase 3 scaffolding placeholder. Wires the sandbox tool so Studio can exercise the full Mastra → sandbox → pandas path end-to-end. Replaced by the 4 real agents in Phase 4.",
  instructions: `# Role

You are a temporary scaffolding agent. Your only job is to demonstrate
that the Mastra service can reach the Python sandbox sidecar.

# Behavior

When asked anything about a Google Sheet, you may call
\`execute_pandas_analysis\` with a small piece of pandas code (e.g.
\`result = df.head(3)\`) against the sample sheet the user references.

Do not pretend to be a real analyst — defer all serious analysis to
the four production agents that ship in Phase 4 (Schema Detector,
Query Planner, Analyst, Writer).

Keep responses short. One sentence per turn unless the user explicitly
asks for more.`,
  model: "openai/gpt-4o-mini",
  tools: { executePandasAnalysisTool },
});
