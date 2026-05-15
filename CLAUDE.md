# SheetSense AI — per-repo orientation

> Project 3 of the Upwork Domination portfolio. Read this before
> touching code. Workspace context: `../CLAUDE.md`.

## What this repo is

**SheetSense AI** — multi-agent sales-data analyst for Google Sheets.
Visitor picks a sample sheet OR connects their own Google account via
Composio OAuth, asks a business question, and a 4-agent pipeline
(Schema Detector → Query Planner → Analyst → Writer) analyzes the
sheet using real pandas in a sandboxed Python subprocess. Findings get
written back as a new "SheetSense Insights" tab in the visitor's sheet.

The full architecture is locked in [`docs/architecture.md`](docs/architecture.md)
and the visual archetype in [`docs/design.md`](docs/design.md). Read
both before touching code.

## Stack at a glance

- **Agents:** Mastra (TypeScript) — `@mastra/core`, `@mastra/memory`,
  `@mastra/pg`, `@composio/mastra`, `@composio/core`. Versions matched
  to the Clarilo reference (see §References below).
- **LLMs:** OpenRouter — `openai/gpt-4o` for the Analyst (writes
  pandas code), `openai/gpt-4o-mini` for the other 3 agents.
- **Compute:** FastAPI Python sidecar runs the Analyst's pandas code
  in a subprocess with `RLIMIT_CPU=5`, `RLIMIT_AS=256MB`, and a
  restricted import hook.
- **Frontend:** Next.js 16 (App Router), Tailwind, JetBrains Mono for
  data, Inter for UI. Sheets-native visual archetype.
- **Persistence:** Postgres (Mastra memory + workflow state +
  sessions) and Redis (sandbox sheet cache, rate limit, cost ceiling).
- **Deploy:** Coolify auto-deploy on push to `main`.

## Build phases (current state)

| Phase | What | Status |
|---|---|---|
| 1 | Repo scaffold + docs + GitHub repo | in progress |
| 2 | Python sandbox sidecar | pending |
| 3 | Mastra service skeleton + Composio factory (copy from Clarilo) | pending |
| 4 | 4 agents + `sheetsense-pipeline` workflow | pending |
| 5 | Next.js frontend (sheet picker, formula bar, agent timeline, OAuth) | pending |
| 6 | Coolify deploy + Turnstile checklist + Canva thumbnail + Upwork tile | pending |
| 7 | Per-project KB doc + Upwork case study | pending |

When you continue this build in a new session, the current phase will
have moved on — check this section's git history (`git log -- CLAUDE.md`)
to see what got shipped.

## Engineering invariants (locked, do not redesign without explicit user direction)

1. **Agents-as-code, no dashboard.** Every agent (system prompt, model,
   tools, HITL flag) is a `.ts` file in `services/mastra/src/mastra/agents/`.
   Iteration is `git push` — no Composio Studio, no Mastra Cloud
   dashboard the codebase can drift from.
2. **The sandbox is the security boundary.** The LLM never executes
   Python directly. It writes code that the sidecar runs in a
   subprocess with rlimits + audit hook. See §5 of architecture.md for
   the honest security disclosure.
3. **The full DataFrame never re-enters the LLM context.** Only the
   *result* of pandas analysis flows back. This is the architectural
   keystone that makes us better than ChatGPT-with-CSV.
4. **Write tools require approval (HITL).** Adopted verbatim from
   Clarilo's `tool-classification.ts` (verb-based: FETCH/LIST/GET/SEARCH
   auto-approve, everything else requires approval). The factory
   patches each write tool with `requireApproval = true`.
5. **Schema detection has a confirmation card in own-sheet mode.**
   This is the HITL checkpoint for reads — visitor confirms the
   agent's classification of column types before the pipeline
   advances. Sample-sheet mode auto-approves.
6. **Source rows are never modified.** Only new tabs get written.
   Eliminates the "agent broke my data" failure mode.
7. **Per-visitor Composio user ids.** Each session mints
   `sheetsense_<uuid>` and uses it for all Composio calls. Adapted
   from Clarilo's single-tenant `COMPOSIO_USER_ID` pattern.
8. **All workspace guardrails apply** (Turnstile, trusted proxy, per-IP
   cost ceiling, 24h auto-delete). See workspace `CLAUDE.md` for the
   locked Turnstile pattern and pre-deploy checklist.

## How to work in this repo

### Before any Mastra code: load the Mastra skill

`/mastra` — installed user-global at `~/.claude/skills/mastra/`. Then
check `services/mastra/node_modules/@mastra/core/dist/docs/SOURCE_MAP.json`
for the exact installed-version API signatures. Mastra APIs change
between versions; cached training-data knowledge is unreliable.

### Before any Composio code: read Clarilo's working implementation

`D:\Personal\Projects\clarilo-ai-alpha\clarilo\src\mastra\tools\composio-agent-factory.ts`
is the version-locked reference. The two helpers we copy verbatim:

- `patchToolSchemas` — wraps plain JSON Schema from Composio in the
  `{ jsonSchema: ... }` envelope Mastra Studio expects. Without this,
  Studio crashes with `Cannot read properties of undefined (reading 'def')`.
- `patchToolApproval` — marks write tools with `requireApproval = true`
  so Mastra's `network()` stream suspends for the HITL approval card.

### Before any guardrail code: copy from DocuAI

`d:/Personal/Projects/Upwork Domination/agentic-rag-platform/shared/guardrails/`
is the locked reference for trusted-proxy middleware, per-IP rate
limiter, daily cost ceiling, and Turnstile verifier. Don't re-derive —
copy + adapt the Python helpers to TypeScript where needed.

### Local dev quirks worth remembering

- Postgres on `localhost:5434` (NOT 5432 — collides with local installs;
  NOT 5433 — collides with DocuAI).
- Redis on `localhost:6381` (NOT 6379 — collides with DocuAI).
- Both compose files MUST be passed: `docker compose -f docker-compose.yml -f docker-compose.local.yml up`.
  Omitting the `.local` overlay strips host port mappings and breaks
  browser access (workspace memory: `feedback_docker_compose_local_overlay.md`).

## References (read these, in order, before contributing)

1. Workspace orientation: [`../CLAUDE.md`](../CLAUDE.md)
2. Architecture spec: [`docs/architecture.md`](docs/architecture.md)
3. Design spec: [`docs/design.md`](docs/design.md)
4. Clarilo reference codebase: `D:\Personal\Projects\clarilo-ai-alpha\clarilo\`
   - `src/mastra/agents/agent-registry.ts`
   - `src/mastra/tools/composio-agent-factory.ts` ← copy verbatim
   - `src/mastra/tools/tool-classification.ts` ← copy verbatim
   - `src/mastra/workflows/weather-workflow.ts` ← model for the pipeline
   - `src/mastra/index.ts` ← Mastra root config
5. DocuAI guardrails: `../agentic-rag-platform/shared/guardrails/`
6. DocuAI Turnstile (client + server): `../agentic-rag-platform/web/src/lib/turnstile.ts`
   + `../agentic-rag-platform/shared/guardrails/turnstile.py`
