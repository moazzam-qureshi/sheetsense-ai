/**
 * SheetSense AI — Mastra root configuration.
 *
 * Registers the 4 production agents (Schema Detector, Query Planner,
 * Analyst, Writer) and the `sheetsense-pipeline` workflow that chains
 * them. Storage is Postgres via @mastra/pg. Observability ships
 * default + cloud exporters, plus Langfuse when keys are present.
 *
 * Mirrors Clarilo's `src/mastra/index.ts` pattern with SheetSense's
 * trimmed surface (no scorers/evals, no better-auth — the Next.js
 * gateway in Phase 5 handles session minting via a thin route, and
 * the Mastra service itself stays an internal-only API).
 */

import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { PostgresStore } from "@mastra/pg";
import {
  CloudExporter,
  DefaultExporter,
  Observability,
  SensitiveDataFilter,
} from "@mastra/observability";
import { LangfuseExporter } from "@mastra/langfuse";

import { schemaDetectorAgent } from "./agents/schema-detector.js";
import { queryPlannerAgent } from "./agents/query-planner.js";
import { analystAgent } from "./agents/analyst.js";
import { writerAgent } from "./agents/writer.js";
import { sheetsensePipeline } from "./workflows/sheetsense-pipeline.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required (Postgres connection string)");
}

const langfuseEnabled = Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

export const mastra = new Mastra({
  agents: {
    schemaDetectorAgent,
    queryPlannerAgent,
    analystAgent,
    writerAgent,
  },
  workflows: { sheetsensePipeline },

  storage: new PostgresStore({
    id: "sheetsense-mastra",
    connectionString: DATABASE_URL,
  }),

  logger: new PinoLogger({
    name: "sheetsense-mastra",
    level: (process.env.LOG_LEVEL ?? "info") as any,
  }),

  observability: new Observability({
    configs: {
      default: {
        serviceName: "sheetsense-mastra",
        exporters: [
          new DefaultExporter(),
          new CloudExporter(),
          ...(langfuseEnabled ? [new LangfuseExporter()] : []),
        ],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});
