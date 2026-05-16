/**
 * Composio integration factory.
 *
 * Adapted from the Clarilo reference codebase
 * (D:\Personal\Projects\clarilo-ai-alpha\clarilo\src\mastra\tools\composio-agent-factory.ts).
 * Two adaptations vs Clarilo:
 *
 *   1. Multi-tenant by visitor. Clarilo uses a single COMPOSIO_USER_ID
 *      env var (one user, one set of credentials). SheetSense mints a
 *      per-session user id `sheetsense_<uuid>` and accepts it as a
 *      parameter on every `fetchComposioTools` call. This is the
 *      session-scoped OAuth pattern documented in
 *      docs/architecture.md §4.
 *
 *   2. No auto-discovery. Clarilo's agent-registry probes the user's
 *      connected toolkits at startup and creates one Agent per toolkit
 *      dynamically. SheetSense's 4 agents are pre-known (Schema
 *      Detector / Query Planner / Analyst / Writer), so we just need
 *      a helper that fetches and patches the Composio tools — no
 *      registry, no dynamic agent creation.
 *
 * The two verbatim-from-Clarilo helpers are `patchToolSchemas` (wraps
 * plain JSON Schema in the `{ jsonSchema }` envelope Mastra Studio
 * expects) and `patchToolApproval` (marks write tools with
 * `requireApproval: true` for HITL).
 */

import { Composio } from "@composio/core";
import { MastraProvider } from "@composio/mastra";
import { jsonSchema } from "@ai-sdk/provider-utils-v6";

import { classifyTools } from "./tool-classification.js";

// ---------------------------------------------------------------------------
// Lazy Composio client. We DON'T construct at module load — the SDK
// throws if COMPOSIO_API_KEY is empty, which would crash Mastra's
// `mastra build` step (which evaluates module-level code at bundle
// time) on any clone without a real .env. Per-visitor scoping happens
// via the `userId` argument passed to `composio.tools.get(...)`; the
// API key on the client itself is the account-level key.
// ---------------------------------------------------------------------------
// Typed as `any` to sidestep the Composio<TProvider> generic — the
// MastraProvider doesn't satisfy the default OpenAIProvider constraint
// in the Composio types as published, but the runtime works correctly.
// This is the same pattern Clarilo's `export const composio = new Composio(...)`
// implicitly relies on (TS-side widening of the module export).
let _composio: any = null;

export function getComposio(): any {
  if (_composio) return _composio;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "COMPOSIO_API_KEY is not set — required to fetch Composio tools at runtime.",
    );
  }
  _composio = new Composio({
    apiKey,
    provider: new MastraProvider(),
  });
  return _composio;
}

// ---------------------------------------------------------------------------
// Schema patching for Mastra Studio compatibility.
//
// Composio's MastraProvider emits tools whose `inputSchema` is a plain
// JSON Schema object. Mastra Studio's `getSerializedAgentTools` expects
// the schema to be wrapped in the `{ jsonSchema: ... }` envelope from
// `@ai-sdk/provider-utils-v6`. Without this wrap, Studio crashes with
// `Cannot read properties of undefined (reading 'def')` when trying to
// render the tool's schema in the inspector.
//
// Verified working in production by Clarilo (Bet 10). Re-used verbatim.
// ---------------------------------------------------------------------------
function patchToolSchemas(tools: Record<string, any>): Record<string, any> {
  for (const tool of Object.values(tools)) {
    if (tool.inputSchema && typeof tool.inputSchema === "object" && !("jsonSchema" in tool.inputSchema)) {
      tool.inputSchema = jsonSchema(tool.inputSchema);
    }
    if (tool.outputSchema && typeof tool.outputSchema === "object" && !("jsonSchema" in tool.outputSchema)) {
      tool.outputSchema = jsonSchema(tool.outputSchema);
    }
  }
  return tools;
}

// ---------------------------------------------------------------------------
// HITL patching: mark write tools with requireApproval = true.
//
// The verb-based classifier in tool-classification.ts is fail-safe:
// unknown verbs default to "needs approval". Read tools (FETCH/LIST/
// GET/SEARCH/...) pass through unmodified.
// ---------------------------------------------------------------------------
function patchToolApproval(tools: Record<string, any>): void {
  const { read, write } = classifyTools(Object.keys(tools));
  for (const name of write) {
    tools[name].requireApproval = true;
  }
  console.log(
    `[composio-factory] HITL: ${read.length} read (auto-approve), ${write.length} write (requireApproval)`,
  );
}

// ---------------------------------------------------------------------------
// Public API: fetch a toolkit's tools, patched for Studio + HITL.
// ---------------------------------------------------------------------------
export interface FetchToolsOptions {
  /** Per-session Composio user id (e.g. `sheetsense_<uuid>` or the demo id). */
  composioUserId: string;
  /** Composio toolkit slugs to fetch — e.g. `["googlesheets"]` or `["googlesheets", "gmail"]`. */
  toolkits: string[];
  /**
   * Sample-sheet mode shortcut: when true, override write tools' approval
   * requirement and let them auto-approve. The visitor explicitly picked
   * one of the 3 sample sheets knowing the agent would write to it, so
   * we don't gate writes there. Own-sheet mode (the default) keeps the
   * HITL gate intact.
   */
  autoApproveWrites?: boolean;
}

/**
 * Fetch a per-session-scoped Composio tool bundle, patched for Mastra Studio
 * compatibility and HITL safety. Returns a `{ name: tool }` map ready to
 * plug into `new Agent({ tools: ... })`.
 */
export async function fetchComposioTools(opts: FetchToolsOptions): Promise<Record<string, any>> {
  const { composioUserId, toolkits, autoApproveWrites = false } = opts;

  const rawTools: Record<string, any> = await getComposio().tools.get(composioUserId, {
    toolkits,
    important: false,
  });

  const tools = patchToolSchemas(rawTools);
  patchToolApproval(tools);

  if (autoApproveWrites) {
    const flipped: string[] = [];
    for (const t of Object.values(tools)) {
      if ((t as any).requireApproval === true) {
        (t as any).requireApproval = false;
        flipped.push((t as any).id ?? "<unknown>");
      }
    }
    if (flipped.length) {
      console.log(
        `[composio-factory] autoApproveWrites=true: cleared requireApproval on ${flipped.length} tools (sample-sheet mode)`,
      );
    }
  }

  return tools;
}
