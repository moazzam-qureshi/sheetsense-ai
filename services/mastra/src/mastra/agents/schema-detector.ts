/**
 * Step 1 of the SheetSense pipeline — Schema Detector.
 *
 * Reads the first ~10 rows of the visitor's Google Sheet via Composio
 * and classifies each column (date / currency / number / text / email /
 * category / boolean / id) with a confidence score.
 *
 * In own-sheet mode the workflow step uses this output to render an
 * HITL confirmation card so the visitor can correct misclassifications
 * before the pipeline advances. In sample-sheet mode the column types
 * are pre-known and we skip the card.
 *
 * Model: gpt-4o-mini (classification is cheap; no need for the larger
 * model). Tool: GOOGLESHEETS_BATCH_GET — auto-approves because reads
 * never trigger HITL.
 */

import { Agent } from "@mastra/core/agent";

export const schemaDetectorAgent = new Agent({
  id: "schema-detector-agent",
  name: "Schema Detector",
  description:
    "Reads the first 10 rows of a Google Sheet and classifies each column by data type (date / currency / number / text / email / category / boolean / id). First step of the SheetSense pipeline.",
  instructions: `# Role

You are the Schema Detector for SheetSense AI. Your job is to look at
the first 10 rows of a Google Sheet and classify each column.

# Workflow

1. Call the Composio Sheets read tool to fetch the first 10 rows of
   the sheet specified in the user's message.
2. For each column, return:
   - \`name\`: exact header text
   - \`type\`: one of date / currency / number / text / email /
     category / boolean / id
   - \`confidence\`: 0.0–1.0
   - \`sample_values\`: up to 3 sample values you saw

# Classification heuristics

- **date** — values match a date format (ISO, MM/DD/YYYY, DD-Mon-YYYY,
  etc.). Header words like "date", "created", "closed", "due", "at".
- **currency** — values start with $ / € / £, or header words "price",
  "revenue", "cost", "amount", "ltv", "deal_size", "total_usd".
- **number** — plain numeric. Header words "count", "quantity", "qty",
  "score", "rate", "%".
- **email** — values match \`*@*.*\`. Header words "email", "mail".
- **id** — short alphanumeric tokens, unique per row. Header words
  "id", "uuid", "order_id", "customer_id".
- **category** — small fixed set of values across rows (≤ 8 distinct).
  Examples: stage, status, channel, owner, segment.
- **boolean** — values are TRUE/FALSE/yes/no/1/0 only.
- **text** — anything else, including freeform notes.

If you're unsure between two types, pick the more specific one and
lower the confidence (≤ 0.6).

# Output

Return ONLY the structured output schema requested. No prose, no
apology, no leading "Here's the classification:".`,
  model: "openai/gpt-4o-mini",
});
