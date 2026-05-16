<div align="center">

# SheetSense AI

**A multi-agent sales-data analyst for Google Sheets. Ask a business question in plain English, watch four AI agents analyze your live sheet in pandas, and read the findings in a new tab written back to the same sheet.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Architecture](docs/architecture.md) · [Design system](docs/design.md)

</div>

---

SheetSense is a portfolio-grade demo of a production multi-agent
pipeline built on Mastra + Composio. The visitor picks a sample sheet
or connects their own Google account via OAuth, types a question like
*"which customers haven't bought in 60 days?"*, and watches a 4-agent
pipeline (Schema Detector → Query Planner → Analyst → Writer) work the
data. Findings stream into the chat UI and get written to a new
"SheetSense Insights" tab in the same sheet — the visitor's source
rows are never touched.

What makes it different from a "chat with your sheet" demo:

- **Real pandas in a sandboxed subprocess, not LLM-token math.** A
  FastAPI Python sidecar runs the Analyst's LLM-written pandas code
  against the full DataFrame under `RLIMIT_CPU=10`, `RLIMIT_AS=1024MB`,
  and a restricted import hook. Only the analysis *result* flows back
  to the LLM — the full DataFrame never re-enters the model context.
  This sidesteps the token-budget collapse that hits ChatGPT-with-CSV
  on sheets larger than a few hundred rows.
- **Multi-agent workflow, not a single super-agent.** Each step is a
  Mastra `createStep` with a strict Zod input/output schema. The
  Planner does the thinking, the Analyst executes, the Writer
  synthesizes. Each step is observable, testable, and replaceable.
- **Per-visitor Composio OAuth.** Session-scoped Composio user ids let
  each visitor connect their own Google account without an account
  system on our end. Sessions auto-expire and get revoked after 24h.
- **Human-in-the-loop on writes.** Adapted from the Clarilo reference
  architecture. Read tools (FETCH/LIST/GET/SEARCH/...) auto-approve;
  write tools (ADD_SHEET/BATCH_UPDATE/CREATE_DRAFT) block on a
  visible approval card. The visitor's source rows are never modified
  — the agent only adds new tabs.
- **Agents-as-code, no dashboard.** All four agent definitions (system
  prompt, model, tools, HITL flags) live in `services/mastra/src/mastra/agents/`
  as TypeScript files and ship at boot. Iterating is `git push` — no
  external dashboard to drift away from the codebase.
- **Production guardrails.** Cloudflare Turnstile gates the
  expensive workflow-run endpoint, Redis-backed per-IP rate limits
  and daily cost ceiling, trusted-proxy `X-Forwarded-For` validation,
  24h auto-delete of sessions + connections.

## Stack

```
Frontend         Next.js 16 (App Router) · React 19 · Tailwind · TypeScript
Agents           Mastra (TypeScript) · @composio/mastra · OpenAI gpt-4o + gpt-4o-mini via OpenRouter
Integrations     Composio Google Sheets + Gmail toolkits · per-visitor OAuth
Compute          FastAPI Python sandbox sidecar · pandas / numpy / matplotlib
                 subprocess + RLIMIT_CPU + RLIMIT_AS + audit hook
Persistence      Postgres (Mastra memory + workflow state + sessions) via @mastra/pg
Cache            Redis (sandbox sheet cache, rate limit, cost ceiling)
Guardrails       Cloudflare Turnstile · trusted proxy · per-IP daily cost ceiling · 24h auto-delete
Deploy           Docker Compose · Coolify auto-deploy on push to main
```

## The 4-agent pipeline

| # | Agent | Model | Tools | What it does |
|---|---|---|---|---|
| 1 | Schema Detector | gpt-4o-mini | Composio Sheets read | Classifies columns (date / currency / text / category / ...). Confirmation card in own-sheet mode. |
| 2 | Query Planner | gpt-4o-mini | None (pure LLM) | Turns natural-language question into 1–3 structured pandas-operation specs. |
| 3 | Analyst | gpt-4o | `execute_pandas_analysis` (sandbox) | Writes pandas code for each task, calls the sandbox, returns the result. May iterate up to 3 times on errors. |
| 4 | Writer | gpt-4o-mini | Composio Sheets write + Gmail draft + sandbox chart | Synthesizes narrative, generates matplotlib chart, writes new "SheetSense Insights" tab. Optionally drafts a follow-up Gmail (never auto-sends). |

Full architectural detail is in [`docs/architecture.md`](docs/architecture.md).
The Sheets-native visual archetype (formula-bar input, agent-timeline
rail, live grid preview) is specified in [`docs/design.md`](docs/design.md).

## Repo layout

```
sheetsense-ai/
├── docs/                     architecture.md · design.md · upwork-case-study.md
├── web/                      Next.js 16 frontend
├── services/
│   ├── mastra/               Mastra agent service (TypeScript, Node 22)
│   └── sandbox/              Python pandas sandbox sidecar (FastAPI)
├── shared/types/             Zod schemas shared by Mastra and web
├── docker-compose.yml        production (no exposed ports, Traefik handles routing)
└── docker-compose.local.yml  local-dev overlay (port mappings)
```

## Run locally

```bash
git clone https://github.com/moazzam-qureshi/sheetsense-ai.git
cd sheetsense-ai
cp .env.example .env
# fill in OPENROUTER_API_KEY, COMPOSIO_API_KEY, TURNSTILE_*, etc.

# Both compose files MUST be passed (the .local overlay adds host port
# mappings — see workspace CLAUDE.md feedback memory).
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

After services come up:

- Web: <http://localhost:3000>
- Mastra Studio: <http://localhost:4111>
- Sandbox health: <http://localhost:8001/health>
- Postgres: `localhost:5434`
- Redis: `localhost:6381`

For local dev without Turnstile, use Cloudflare's test sitekey
`1x00000000000000000000AA` (always passes silently). Leave
`TURNSTILE_SECRET=""` and the server-side verifier short-circuits to
allow.

## Production deploy (Coolify)

The workspace standard:

1. Push to `main`. Coolify auto-deploys.
2. Production compose has no exposed ports — Traefik routes via the
   Coolify-assigned domains (one per service).
3. Add the assigned web domain to the Turnstile sitekey's allowed
   hostnames in Cloudflare's dashboard before testing prod.
4. After any env-var change, rebuild the web image (`NEXT_PUBLIC_*` is
   baked at build time — restart alone is not enough).
5. Run the pre-deploy Turnstile checklist from the workspace
   [`CLAUDE.md`](../CLAUDE.md#pre-deploy-turnstile-checklist).

## Production hardening notes (honest)

This is a portfolio demo. A few tradeoffs we made consciously and
would not ship as-is for a true multi-tenant SaaS:

- **Sandbox isolation.** We use a Python subprocess with rlimits and
  a restricted import hook. For a true multi-tenant SaaS the sandbox
  would run in an isolated container per request (E2B, Modal, or a
  Firecracker microVM). The current setup is acceptable behind
  Turnstile and a per-IP cost ceiling; it is a documented compromise.
- **Composio OAuth scope.** We request the minimum scopes needed
  (Sheets read/write, Gmail draft). Visitors can revoke at any time
  via their Google account settings. Sessions auto-expire after 24h
  and we revoke the Composio connection at that point.
- **No retention.** We don't store the visitor's data. The sheet is
  fetched on demand, cached in Redis for 15 minutes, and dropped.
  The agent timeline + findings live in Postgres only for the 24h
  session window.

## License

MIT — see [`LICENSE`](LICENSE).

---

Built by [Moazzam Qureshi](https://github.com/moazzam-qureshi). Part of a portfolio of 9 production-grade AI-agent demos.
[Hire on Upwork](https://www.upwork.com/freelancers/~01a4f3bc0bf7b3d3df).
