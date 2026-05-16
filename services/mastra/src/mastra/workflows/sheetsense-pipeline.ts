/**
 * sheetsense-pipeline — the 4-agent workflow.
 *
 *   PipelineInput
 *      │ (sheet id, question, session user id, mode flag)
 *      ▼
 *   1. Schema Detector  ─── Composio Sheets read tool (per-session)
 *      │ + columns[]
 *      ▼
 *   2. Query Planner    ─── no tools, structured output
 *      │ + tasks[]
 *      ▼
 *   3. Analyst          ─── execute_pandas_analysis tool (sandbox)
 *      │ + results[]
 *      ▼
 *   4. Writer           ─── Composio Sheets write + Gmail draft (per-session, HITL-gated)
 *      │
 *      ▼
 *   WriterOutput (narrative + new-tab URL + optional email draft id)
 *
 * Per-session Composio tools (steps 1 + 4) are fetched at step
 * execution time via fetchComposioTools({ composioUserId, ... }) and
 * attached to the agent's call via Mastra's runtime `toolsets`
 * parameter. The agents themselves are constructed without those
 * tools, so per-visitor scoping doesn't require per-visitor agent
 * instances.
 *
 * Modeled after Clarilo's weather-workflow.ts (createStep + .then()
 * pattern) and verified against the installed @mastra/core v1.35.0
 * reference docs (services/mastra/node_modules/@mastra/core/dist/docs/
 * references/reference-workflows-step.md and
 * reference-workflows-workflow-methods-then.md).
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";

import { fetchComposioTools } from "../tools/composio-factory.js";
import {
  AnalystOutputSchema,
  type AnalystTaskResult,
  ColumnInfoSchema,
  PipelineInputSchema,
  PipelineOutputSchema,
  PlannerOutputSchema,
  PlannerTaskSchema,
  SchemaDetectedSchema,
  WriterOutputSchema,
} from "../schemas.js";

// ---------------------------------------------------------------------------
// Step 1 — Schema Detector
// ---------------------------------------------------------------------------
const detectSchemaStep = createStep({
  id: "detect-schema",
  description:
    "Reads the first 10 rows of the visitor's Google Sheet via Composio and classifies each column.",
  inputSchema: PipelineInputSchema,
  outputSchema: SchemaDetectedSchema,
  execute: async ({ inputData, mastra }) => {
    const { session_user_id, sheet_id, question, auto_approve_writes } = inputData;

    const agent = mastra?.getAgentById("schema-detector-agent");
    if (!agent) throw new Error("schema-detector-agent not registered");

    // Per-session Composio tool fetch. Sheets-read tools auto-approve;
    // we never gate reads behind HITL.
    const composioTools = await fetchComposioTools({
      composioUserId: session_user_id,
      toolkits: ["googlesheets"],
      autoApproveWrites: false,
    });

    const response = await agent.generate(
      [
        {
          role: "user",
          content:
            `Classify the columns of Google Sheet id "${sheet_id}". ` +
            `Read only the first 10 rows. Visitor's question (for context): "${question}".`,
        },
      ],
      {
        toolsets: { composio: composioTools },
        structuredOutput: {
          schema: SchemaDetectedSchema.pick({ columns: true, row_count: true, header_row: true }),
        },
      } as any,
    );

    const parsed = (response as any).object ?? {
      columns: [],
      row_count: 0,
      header_row: 0,
    };

    return {
      session_user_id,
      sheet_id,
      question,
      auto_approve_writes,
      columns: parsed.columns ?? [],
      row_count: parsed.row_count ?? 0,
      header_row: parsed.header_row ?? 0,
    };
  },
});

// ---------------------------------------------------------------------------
// Step 2 — Query Planner
// ---------------------------------------------------------------------------
const planQueryStep = createStep({
  id: "plan-query",
  description:
    "Turns the visitor's natural-language question + the detected schema into 1-3 structured pandas tasks. Pure LLM transformation, no tools.",
  inputSchema: SchemaDetectedSchema,
  outputSchema: PlannerOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const agent = mastra?.getAgentById("query-planner-agent");
    if (!agent) throw new Error("query-planner-agent not registered");

    const prompt = [
      `Visitor's question: "${inputData.question}"`,
      "",
      "Detected schema (columns):",
      JSON.stringify(inputData.columns, null, 2),
      "",
      "Produce 1-3 PlannerTask objects.",
    ].join("\n");

    const response = await agent.generate([{ role: "user", content: prompt }], {
      structuredOutput: {
        schema: PlannerOutputSchema.pick({ tasks: true }),
      },
    } as any);

    const tasks = (response as any).object?.tasks ?? [];
    return { ...inputData, tasks };
  },
});

// ---------------------------------------------------------------------------
// Step 3 — Analyst
//
// The agent iterates internally; we just loop over the planner's tasks
// at the workflow level so the agent's context per task is bounded.
// ---------------------------------------------------------------------------
const analyzeStep = createStep({
  id: "analyze",
  description:
    "For each Planner task, the Analyst writes pandas code and runs it via the Python sandbox. Iterates up to 3 times per task on errors.",
  inputSchema: PlannerOutputSchema,
  outputSchema: AnalystOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const agent = mastra?.getAgentById("analyst-agent");
    if (!agent) throw new Error("analyst-agent not registered");

    const results: AnalystTaskResult[] = [];

    for (const task of inputData.tasks) {
      const prompt = [
        `Execute this PlannerTask:`,
        JSON.stringify(task, null, 2),
        "",
        `Sheet context:`,
        `  session_user_id: "${inputData.session_user_id}"`,
        `  sheet_id: "${inputData.sheet_id}"`,
        `  columns: ${JSON.stringify(inputData.columns.map((c) => ({ name: c.name, type: c.type })))}`,
        "",
        `Return an AnalystTaskResult with task_description, code, ok, result, chart_png_b64, error_message, attempts.`,
      ].join("\n");

      let taskResult: AnalystTaskResult;
      try {
        const response = await agent.generate([{ role: "user", content: prompt }], {
          structuredOutput: {
            schema: PlannerTaskSchema.pick({}).extend({
              task_description: PlannerTaskSchema.shape.description,
            }).and(
              // Re-import full AnalystTaskResultSchema shape rather than
              // recompose; using a runtime extension keeps the type clear.
              AnalystOutputSchema.shape.results.element,
            ),
          },
        } as any);

        const obj = (response as any).object;
        taskResult = {
          task_description: obj?.task_description ?? task.description,
          code: obj?.code ?? "",
          ok: Boolean(obj?.ok),
          result: obj?.result ?? null,
          chart_png_b64: obj?.chart_png_b64 ?? null,
          error_message: obj?.error_message ?? null,
          attempts: obj?.attempts ?? 1,
        };
      } catch (err: any) {
        taskResult = {
          task_description: task.description,
          code: "",
          ok: false,
          result: null,
          chart_png_b64: null,
          error_message: `analyst agent threw: ${err?.message ?? String(err)}`,
          attempts: 1,
        };
      }

      results.push(taskResult);
    }

    return { ...inputData, results };
  },
});

// ---------------------------------------------------------------------------
// Step 4 — Writer
// ---------------------------------------------------------------------------
const writeFindingsStep = createStep({
  id: "write-findings",
  description:
    "Synthesizes a narrative, writes a new 'SheetSense Insights' tab in the visitor's sheet, optionally drafts a follow-up Gmail. HITL-gated in own-sheet mode.",
  inputSchema: AnalystOutputSchema,
  outputSchema: WriterOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const agent = mastra?.getAgentById("writer-agent");
    if (!agent) throw new Error("writer-agent not registered");

    const composioTools = await fetchComposioTools({
      composioUserId: inputData.session_user_id,
      toolkits: ["googlesheets", "gmail"],
      autoApproveWrites: inputData.auto_approve_writes,
    });

    const prompt = [
      `Visitor's original question: "${inputData.question}"`,
      `Sheet id: ${inputData.sheet_id}`,
      `auto_approve_writes: ${inputData.auto_approve_writes}`,
      "",
      `Detected schema:`,
      JSON.stringify(inputData.columns, null, 2),
      "",
      `Planner tasks:`,
      JSON.stringify(inputData.tasks, null, 2),
      "",
      `Analyst results:`,
      JSON.stringify(inputData.results, null, 2),
      "",
      `Now: synthesize a narrative, create the SheetSense Insights tab, and optionally draft a follow-up email (drafts only, never send).`,
    ].join("\n");

    const response = await agent.generate([{ role: "user", content: prompt }], {
      toolsets: { composio: composioTools },
      structuredOutput: { schema: WriterOutputSchema },
    } as any);

    const obj = (response as any).object;
    return {
      narrative: obj?.narrative ?? "(no narrative produced)",
      insights_tab_name: obj?.insights_tab_name ?? null,
      insights_tab_url: obj?.insights_tab_url ?? null,
      chart_count: obj?.chart_count ?? 0,
      email_draft_id: obj?.email_draft_id ?? null,
    };
  },
});

// ---------------------------------------------------------------------------
// Workflow assembly
// ---------------------------------------------------------------------------
export const sheetsensePipeline = createWorkflow({
  id: "sheetsense-pipeline",
  inputSchema: PipelineInputSchema,
  outputSchema: PipelineOutputSchema,
})
  .then(detectSchemaStep)
  .then(planQueryStep)
  .then(analyzeStep)
  .then(writeFindingsStep);

sheetsensePipeline.commit();

// Suppress an unused-import lint without altering the schema graph
// — these are exported types other modules may import, but TS marks
// the import as "value-only" inside this file.
const _refsForLint = [ColumnInfoSchema, PlannerTaskSchema];
void _refsForLint;
