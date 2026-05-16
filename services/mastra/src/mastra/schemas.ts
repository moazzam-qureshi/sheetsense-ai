/**
 * Shared Zod schemas for the SheetSense pipeline.
 *
 * Every workflow step's input/output is declared here so the type
 * contracts between steps are single-sourced. Workflow data flows
 * left-to-right as: PipelineInput → SchemaDetected → PlannerOutput →
 * AnalystOutput → WriterOutput (= PipelineOutput).
 *
 * Each step extends its predecessor's output with its own contribution
 * so we don't lose context as the pipeline progresses.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Column classification (Schema Detector output piece)
// ---------------------------------------------------------------------------
export const ColumnTypeEnum = z.enum([
  "date",
  "currency",
  "number",
  "text",
  "email",
  "category",
  "boolean",
  "id",
]);
export type ColumnType = z.infer<typeof ColumnTypeEnum>;

export const ColumnInfoSchema = z.object({
  name: z.string().describe("Column header text as it appears in the sheet."),
  type: ColumnTypeEnum,
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("0–1 confidence in the classification. >0.8 = ship without asking."),
  sample_values: z
    .array(z.string())
    .max(3)
    .describe("Up to 3 sample values seen, for the confirmation card UI."),
});
export type ColumnInfo = z.infer<typeof ColumnInfoSchema>;

// ---------------------------------------------------------------------------
// Pipeline-wide context that every step needs.
// ---------------------------------------------------------------------------
export const PipelineContextSchema = z.object({
  session_user_id: z
    .string()
    .describe("Composio user id scoping the visitor's Google OAuth."),
  sheet_id: z.string().describe("Google Sheet ID."),
  question: z.string().describe("The natural-language question the visitor asked."),
  auto_approve_writes: z
    .boolean()
    .default(false)
    .describe(
      "True in sample-sheet mode (the visitor picked one of our demo sheets knowing it'd be written to). False in own-sheet mode — the Writer will pause for HITL approval before each write.",
    ),
});
export type PipelineContext = z.infer<typeof PipelineContextSchema>;

// ---------------------------------------------------------------------------
// Step 1 — Schema Detector
// ---------------------------------------------------------------------------
export const SchemaDetectedSchema = PipelineContextSchema.extend({
  columns: z.array(ColumnInfoSchema),
  row_count: z.number().describe("Total row count of the sheet (best-effort estimate)."),
  header_row: z.number().int().nonnegative().describe("0-indexed row holding column headers."),
});
export type SchemaDetected = z.infer<typeof SchemaDetectedSchema>;

// ---------------------------------------------------------------------------
// Step 2 — Query Planner
// ---------------------------------------------------------------------------
export const OperationEnum = z.enum([
  "filter",
  "groupby",
  "timeseries",
  "rank",
  "aggregate",
  "compare",
]);
export type Operation = z.infer<typeof OperationEnum>;

export const PlannerTaskSchema = z.object({
  description: z
    .string()
    .describe("One-line description of what this task computes, in plain English."),
  operation: OperationEnum,
  columns: z.array(z.string()).describe("Column names this task reads. Must match the schema."),
  chart_hint: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "If a visualization would help present this result, a short hint like 'bar chart of revenue by month'. Else null.",
    ),
});
export type PlannerTask = z.infer<typeof PlannerTaskSchema>;

export const PlannerOutputSchema = SchemaDetectedSchema.extend({
  tasks: z
    .array(PlannerTaskSchema)
    .min(1)
    .max(3)
    .describe("1–3 ordered pandas tasks that together answer the visitor's question."),
});
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

// ---------------------------------------------------------------------------
// Step 3 — Analyst
// ---------------------------------------------------------------------------
export const AnalystTaskResultSchema = z.object({
  task_description: z.string(),
  code: z.string().describe("The pandas code the Analyst wrote for this task."),
  ok: z.boolean(),
  result: z.unknown().nullable().describe("Sandbox-marshaled result (DataFrame/Series/scalar/dict/list, capped at 100 rows)."),
  chart_png_b64: z.string().nullable().describe("Base64 PNG if the planner asked for a chart on this task."),
  error_message: z.string().nullable(),
  attempts: z.number().int().min(1).max(3).describe("How many sandbox calls it took to converge (max 3)."),
});
export type AnalystTaskResult = z.infer<typeof AnalystTaskResultSchema>;

export const AnalystOutputSchema = PlannerOutputSchema.extend({
  results: z.array(AnalystTaskResultSchema),
});
export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;

// ---------------------------------------------------------------------------
// Step 4 — Writer (= final pipeline output)
// ---------------------------------------------------------------------------
export const WriterOutputSchema = z.object({
  narrative: z
    .string()
    .describe("Markdown narrative summarizing findings in business English. 3-6 bullet points."),
  insights_tab_name: z
    .string()
    .nullable()
    .describe(
      "Name of the new tab the Writer created in the visitor's sheet (e.g. 'SheetSense Insights — 2026-05-16'). Null if the write was declined or failed.",
    ),
  insights_tab_url: z
    .string()
    .nullable()
    .describe("Deep link to the new tab, or null."),
  chart_count: z.number().int().nonnegative().describe("Number of charts embedded in the tab."),
  email_draft_id: z
    .string()
    .nullable()
    .describe(
      "Gmail draft ID if a follow-up email was drafted (reactivation questions only). Never sent automatically.",
    ),
});
export type WriterOutput = z.infer<typeof WriterOutputSchema>;

// ---------------------------------------------------------------------------
// Workflow input + final output.
// ---------------------------------------------------------------------------
export const PipelineInputSchema = PipelineContextSchema;
export const PipelineOutputSchema = WriterOutputSchema;
