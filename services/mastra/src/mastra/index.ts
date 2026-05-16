/**
 * SheetSense AI — Mastra root configuration.
 *
 * Mirrors Clarilo's `src/mastra/index.ts` pattern with SheetSense's
 * trimmed surface (no scorers/evals, no better-auth — the Next.js
 * gateway in Phase 5 handles session minting via a thin route, and
 * the Mastra service itself stays an internal-only API).
 *
 * Phase 3 ships only the placeholder agent + the sandbox tool. Phase 4
 * replaces the placeholder with the 4 real agents and registers the
 * `sheetsense-pipeline` workflow.
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

import { placeholderAgent } from "./agents/placeholder-agent.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required (Postgres connection string)");
}

const langfuseEnabled = Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

export const mastra = new Mastra({
  agents: { placeholderAgent },
  // Workflows land in Phase 4.
  workflows: {},

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
