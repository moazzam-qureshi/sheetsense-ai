# SheetSense AI — Architecture

> Project 3 of the Upwork Domination portfolio. Multi-agent sales-data
> analyst for Google Sheets. Visitor picks a sample sheet or connects
> their own Google account, asks a business question in natural
> language, and watches a 4-agent pipeline analyze the data and write
> findings back into a new tab.
>
> This document is the **locked architecture** coming out of the
> pre-build huddle (captured in workspace `CLAUDE.md`). Read it before
> touching code. Companion: [`design.md`](./design.md).

---

## 1. Product framing

**One-line pitch.** "Ask a question about your Google Sheet in plain
English. Four AI agents read your data, analyze it, and write findings
back into a new tab of your sheet."

**Audience.** Sub-$5M-revenue businesses still running sales out of
Sheets — services/agencies, e-commerce sellers (Shopify/Etsy/Amazon),
B2B founders pre-CRM, construction/manufacturing distributors, real
estate teams. They have spreadsheet data and questions, no BI tool, no
CRM, no analyst headcount.

**The differentiator vs ChatGPT-with-CSV-upload.**
1. We work against the **live** sheet, not a snapshot. The visitor
   doesn't paste data — they grant OAuth.
2. We **write findings back** as a new "SheetSense Insights" tab in
   the same sheet. Results live where the work lives.
3. We never mutate source rows — the new tab is additive only. This
   eliminates the "AI broke my data" failure mode that blocks adoption.
4. Real pandas runs in a sandbox. The LLM writes code, the code
   executes against the full DataFrame, only the **result** flows back
   to the LLM. This sidesteps the token-budget collapse that hits
   ChatGPT on sheets larger than a few hundred rows.

**Why Mastra + Composio (vs LangGraph used in DocuAI).** The Clarilo
reference codebase at `D:\Personal\Projects\clarilo-ai-alpha\clarilo\`
is a production Mastra + Composio system. Mastra owns the agent
abstraction (`Agent`, `Memory`, `createWorkflow`). Composio owns the
800+ OAuth integration surface, including a stable Google Sheets
toolkit. Together they collapse weeks of integration plumbing into a
few hundred lines of TypeScript. We deliberately use a **different**
orchestration stack than DocuAI (LangGraph) and VoiceGen (Deepgram
Voice Agent + Settings JSON) so the portfolio shows breadth.

---

## 2. System diagram

```
                                            Visitor's Google Sheet
                                                     ▲
                                                     │ (write new tab)
                                                     │
   Browser (Next.js 16)                    Composio Google Sheets API
        │                                            ▲
        │ HTTPS                                      │
        ▼                                            │
   Mastra service (Node 22, TypeScript) ─────────────┘
        │
        │  sheetsense-pipeline workflow
        │   ├─ step 1: schema-detector agent  ──── Composio Sheets (read)
        │   ├─ step 2: query-planner agent    ──── (no tools, pure LLM)
        │   ├─ step 3: analyst agent          ──── HTTP POST /execute_pandas
        │   └─ step 4: writer agent           ──── Composio Sheets (write) + Gmail (draft)
        │
        ▼
   Python sandbox sidecar (FastAPI, port 8001, internal-only)
        │
        ├─ fetches sheet bytes via Composio (cached per session in Redis)
        ├─ spawns subprocess with RLIMIT_CPU=5, RLIMIT_AS=256MB
        ├─ restricted import hook (pandas/numpy/matplotlib/scipy only)
        └─ returns { result: jsonable, chart_png_b64: optional }

   Postgres (Mastra memory + workflow state + sessions)
   Redis (sandbox sheet cache, per-IP cost ceiling, rate limit)
```

---

## 3. The 4-agent pipeline

This is a **workflow** in the Mastra sense (`createWorkflow().then(...).then(...)`),
not a routing agent. Each step is deterministic in its position;
non-determinism lives inside the agent's tool calls and LLM output.
This is the right shape for SheetSense because the pipeline order
(schema → plan → analyze → write) is fixed; we're not deciding which
specialist to call based on user intent.

Modeled after Clarilo's `weather-workflow.ts` `createStep` /
`createWorkflow` pattern.

### Step 1 — Schema Detector

| | |
|---|---|
| **Model** | `openai/gpt-4o-mini` (cheap, classification only) |
| **Tools** | Composio Google Sheets read tool (`GOOGLESHEETS_BATCH_GET` or equivalent — first 10 rows) |
| **Input** | `{ sheetId: string, sessionId: string }` |
| **Output** | `{ columns: [{name, type: "date"|"currency"|"text"|"number"|"email"|"category", confidence: number}], rowCount: number, headerRow: number }` |
| **HITL** | Auto-approves (read-only). |

Reads the first 10 rows of the user's sheet and classifies each column.
For the 3 sample sheets, schema is pre-cached and this step is a no-op
return (still runs so the UI shows the agent activating — pedagogically
useful, the timeline is part of the demo).

For own-sheet mode, the output drives a **confirmation card** in the
UI before the workflow advances. Visitor can correct misclassifications
(e.g. "this isn't a date, it's a stage code"). This is the HITL
checkpoint, mirroring Clarilo's deny-by-default pattern but adapted to
"confirm the agent's read of your data" rather than "approve writes."

### Step 2 — Query Planner

| | |
|---|---|
| **Model** | `openai/gpt-4o-mini` |
| **Tools** | None — pure LLM transformation |
| **Input** | `{ question: string, schema: ColumnInfo[] }` |
| **Output** | `{ tasks: [{description, operation: "filter"|"groupby"|"timeseries"|"rank"|"aggregate", columns: string[], chartHint?: string}] }` |
| **HITL** | None — output is consumed by Analyst, visitor sees it as a "Plan" card in the timeline. |

Turns "which products are slowing down month-over-month?" into 1–3
structured operation specs. Output schema is strict (Zod) so the
Analyst can rely on it. This is what stops the Analyst from
free-styling — the Planner did the thinking, the Analyst just executes.

### Step 3 — Analyst

| | |
|---|---|
| **Model** | `openai/gpt-4o` (smarter — writes pandas code) |
| **Tools** | One tool: `execute_pandas_analysis({ code, sheetId })` → calls the Python sidecar |
| **Input** | `{ tasks: PlannerOutput, sheetId, schema }` |
| **Output** | `{ results: [{ taskDescription, value: jsonable, chartPngB64?: string }] }` |
| **HITL** | Auto-approves sandbox calls (no external side effects). |

For each task in the plan, writes pandas code, calls the sandbox, gets
back the result. May iterate up to 3 times per task if code errors or
returns empty. The full DataFrame **never re-enters the LLM context** —
only the analysis result does. This is the architectural keystone.

### Step 4 — Writer

| | |
|---|---|
| **Model** | `openai/gpt-4o-mini` |
| **Tools** | Composio Google Sheets write tools (`GOOGLESHEETS_ADD_SHEET`, `GOOGLESHEETS_BATCH_UPDATE`), Gmail draft tool (`GMAIL_CREATE_EMAIL_DRAFT`), one sandbox tool for chart rendering |
| **Input** | `{ originalQuestion, results: AnalystOutput, sheetId }` |
| **Output** | `{ insightsTabUrl: string, narrative: string, charts: string[], emailDraftId?: string }` |
| **HITL** | Writes block on approval in own-sheet mode. Sample-sheet mode auto-approves (visitor opted in by picking a sample). |

Synthesizes results into a narrative. Generates a matplotlib chart via
the sandbox (PNG bytes returned, embedded into the sheet via cell
formula or image insert depending on what the Sheets API allows).
Creates a new tab named `SheetSense Insights — <YYYY-MM-DD HH:mm>` in
the visitor's sheet and writes formatted findings. If the question is
reactivation-flavored ("who hasn't bought in 60 days?"), also drafts a
follow-up Gmail (does not send — draft only, deny-by-default).

---

## 4. Composio integration model

### Per-visitor OAuth scoping

Clarilo's reference pattern uses a single `COMPOSIO_USER_ID` env var —
single-tenant. SheetSense is **multi-tenant by visitor** (one demo
session per browser), so we adapt:

1. On `POST /api/session/start`, generate a session-scoped user id:
   `sheetsense_<uuid>`. Stored in Postgres `sessions` table with
   `expires_at = now() + 24h`.
2. Frontend calls `POST /api/session/connect-google` →
   server initiates Composio OAuth flow scoped to that session user id
   → redirects the visitor to Google's consent screen → callback URL
   resolves back to our app, Composio stores the credential keyed by
   that user id.
3. Every Composio call in the workflow passes the session's user id:
   `composio.tools.get(sessionUserId, { toolkits: ["googlesheets"] })`.
4. Cleanup actor (Mastra workflow, runs hourly) deletes any session
   older than 24h and revokes its Composio connection.

Sample-sheet mode uses a single shared **demo** user id with
pre-granted access to three Google Sheets we own. No OAuth required.

### Sandbox sheet caching

The sandbox sidecar fetches the sheet bytes **once** per session via
Composio (Sheets read API), parses to a pandas DataFrame, and caches
the pickled DataFrame in Redis under
`sandbox:sheet:<sessionUserId>:<sheetId>` with a 15-minute TTL. Every
subsequent `execute_pandas_analysis` call within that window reuses
the cached DataFrame — no repeated Sheets API hits, no token waste.

### Tool approval pattern (HITL)

Adopt Clarilo's verb-based classification (`tool-classification.ts`)
**verbatim**. Read verbs (`FETCH`, `LIST`, `GET`, `SEARCH`, etc.)
auto-approve; everything else requires approval. The factory
(`composio-agent-factory.ts`) patches each write tool with
`requireApproval = true` so Mastra's `network()` stream suspends for
the approval card.

For sample-sheet mode we add a per-session override: writes to a sample
sheet auto-approve (visitor picked the sample knowing it'd be written
to).

---

## 5. The Python sandbox sidecar (the critical security piece)

**Why a separate service vs in-process Node?** Three reasons:
1. **pandas is Python.** Node-side pandas-clones (danfo.js, etc.) don't
   handle real-world sheet messiness well — mixed types, dates,
   currency strings.
2. **Process isolation.** A subprocess is a real OS boundary. Setting
   `RLIMIT_CPU` and `RLIMIT_AS` from Python is one line. From Node
   it's awkward and platform-specific.
3. **Restricted imports work cleanly in Python.** We install an
   `audit_hook` that blocks `os`, `subprocess`, `sys.modules` mutation,
   `importlib`, `builtins.open` writes, network sockets. Cleaner than
   the Node sandbox-vm story.

### Service shape

```
FastAPI service, ~150 LOC, single endpoint POST /execute_pandas
Listens on internal port 8001 (no Traefik route — Mastra-only)

Request:  { code: string, session_user_id: string, sheet_id: string,
            need_chart: bool }
Response: { result: <jsonable>, chart_png_b64?: string,
            error?: { type, message, traceback_excerpt } }

Behavior:
1. Resolve DataFrame:
   a. Check Redis sandbox:sheet:<sid>:<shid> → hit → load pickle.
   b. Miss → fetch via Composio Sheets read → parse → cache → use.
2. Spawn subprocess:
   - setrlimit(RLIMIT_CPU,  (5, 5))         # 5 sec wall + cpu cap
   - setrlimit(RLIMIT_AS,   (256MB, 256MB)) # 256MB virtual memory
   - audit hook blocks: os.system, subprocess.*, socket.*, open(w/a),
     ctypes, importlib.__import__ for non-allow-listed modules
   - allow-listed imports: pandas, numpy, matplotlib (Agg), scipy,
     datetime, math, statistics, re, json
   - exec(code) with df, np, pd, plt pre-bound in globals
   - capture: locals["result"] OR the value of the last expression
   - if need_chart: capture plt.gcf() as PNG, return base64
3. Marshal result:
   - If pd.DataFrame: return as records (cap 100 rows, columns trimmed)
   - If pd.Series: return as dict (cap 100 entries)
   - If scalar (int/float/str/bool): return directly
   - Else: str(result) (defensive cast)
4. Time out after 6 seconds wall-clock (1s margin over RLIMIT_CPU).
```

### Honest security disclosure

In-process Python sandboxes are an attack surface. A determined visitor
*could* attempt escape. For this portfolio demo, behind a Turnstile
gate and per-IP cost ceiling, the risk profile is acceptable. The
architecture doc and README explicitly disclose:

> **For a true multi-tenant SaaS the sandbox would run in an isolated
> container per request (E2B, Modal, or a Firecracker microVM). For
> this portfolio demo, in-process subprocess with rlimits + restricted
> imports + Turnstile + per-IP cost ceiling is a documented tradeoff.**

We mention this prominently in the README "Production hardening notes"
section. It demonstrates engineering honesty rather than hiding it.

---

## 6. Stack table (locked)

| Layer | Choice | Why |
|---|---|---|
| Agent orchestration | Mastra (TypeScript) | Matches Clarilo reference; modern AI framework; clean workflow API |
| Integrations | Composio per-user OAuth | 800+ platforms, Sheets toolkit is mature |
| Compute (analyst) | FastAPI Python sandbox sidecar | Real pandas + OS-level isolation |
| LLM (cheap agents) | `openai/gpt-4o-mini` via OpenRouter | Schema/Planner/Writer don't need o-class reasoning |
| LLM (Analyst) | `openai/gpt-4o` via OpenRouter | Writes pandas code — needs the better model |
| Persistence | Postgres via `@mastra/pg` | Clarilo pattern; workflow state + sessions + memory |
| Session cache | Redis | Sandbox sheet cache, per-IP cost ceiling, rate limit |
| Frontend | Next.js 16 (App Router) | Workspace standard; SSR for the timeline streaming |
| Streaming | Mastra `agent.stream()` + SSE | Per-agent activation events to the UI timeline |
| Auth (visitor) | None (session id in cookie) | 24h ephemeral session, no signup; matches DocuAI/VoiceGen invariant |
| Auth (Google) | Composio OAuth per session | Multi-tenant adaptation of Clarilo's pattern |
| Deploy | Coolify on the VPS, auto-deploy on `main` push | Workspace standard |

---

## 7. Repo layout

```
sheetsense-ai/
├── README.md
├── CLAUDE.md                 # per-repo orientation for future Claude sessions
├── LICENSE                   # MIT
├── docker-compose.yml        # production (no exposed ports)
├── docker-compose.local.yml  # local-dev overlay (port mappings)
├── .env.example              # all required env vars, dummy values
├── .gitignore                # .env, .env.local, node_modules, .next, __pycache__
├── docs/
│   ├── architecture.md       # this file
│   ├── design.md             # visual + UX spec
│   └── upwork-case-study.md  # written after deploy
├── web/                      # Next.js 16 frontend
│   ├── Dockerfile
│   ├── package.json
│   ├── next.config.ts
│   ├── tsconfig.json
│   ├── src/
│   │   ├── app/              # App Router pages
│   │   ├── components/
│   │   ├── lib/              # api client, turnstile, session
│   │   └── styles/
│   └── public/
├── services/
│   ├── mastra/               # Mastra agent service (TypeScript)
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts                          # entry
│   │       └── mastra/
│   │           ├── index.ts                      # Mastra config (storage, observability)
│   │           ├── agents/
│   │           │   ├── schema-detector.ts
│   │           │   ├── query-planner.ts
│   │           │   ├── analyst.ts
│   │           │   └── writer.ts
│   │           ├── tools/
│   │           │   ├── composio-factory.ts       # adapted from Clarilo
│   │           │   ├── tool-classification.ts    # copied from Clarilo
│   │           │   ├── execute-pandas.ts         # HTTP client to sidecar
│   │           │   └── render-chart.ts           # HTTP client to sidecar
│   │           └── workflows/
│   │               └── sheetsense-pipeline.ts
│   └── sandbox/              # Python pandas sidecar (FastAPI)
│       ├── Dockerfile
│       ├── pyproject.toml
│       ├── uv.lock
│       └── src/
│           ├── main.py       # FastAPI app
│           ├── sandbox.py    # subprocess + rlimits + audit hook
│           ├── sheets.py     # Composio Sheets fetch + cache
│           └── marshal.py    # result trimming + jsonification
└── shared/                   # cross-service config (env types, etc.)
    └── types/
        └── workflow.ts       # Zod schemas shared by Mastra and web (mirrored to web)
```

---

## 8. Engineering invariants (per workspace `CLAUDE.md`)

These are **locked** for the project. Don't redesign without explicit
user direction.

### Guardrails (apply to every public endpoint)

| Guardrail | Mount point in this project |
|---|---|
| Trusted-proxy middleware | Next.js middleware (anti `X-Forwarded-For` spoof) |
| Redis per-IP rate limiter | `/api/workflow/run` (the expensive endpoint), 5/min |
| Per-IP daily cost ceiling | `/api/workflow/run`, $0.50/IP/day (covers ~50 questions at gpt-4o pricing) |
| **Cloudflare Turnstile** | `/api/workflow/run` — non-negotiable, gates the most expensive endpoint |
| 24h auto-delete | Cleanup actor runs hourly, deletes sessions + revokes Composio connections + drops Redis keys |

### Turnstile (the locked pattern — copy from DocuAI verbatim)

- Server verifier: `services/mastra/src/lib/turnstile.ts`
- Client widget: `web/src/lib/turnstile.ts`
- Sitekey: `appearance: "interaction-only"` + `execution: "execute"`
  (NOT the dead `size: "invisible"`)
- Container reserves 300×65 px even when invisible
- Visible challenge renders as centered modal with dimmed backdrop
- `setTimeout(() => turnstile.execute(id), 0)` defers execute one tick
- Log `error-callback(code)` for diagnostics
- Both `TURNSTILE_SECRET` (server) AND `NEXT_PUBLIC_TURNSTILE_SITEKEY`
  (client, baked at build time) must be set
- Add Coolify-assigned domain to sitekey's allowed hostnames in
  Cloudflare dashboard before testing prod
- Pre-deploy: rebuild web image after env changes (NEXT_PUBLIC_* is
  baked at build time, restart alone does nothing)

### Agents-as-code (LOCKED, applies to all future portfolio projects)

The agent definitions — prompts, tool wirings, model choices — live in
the repo as `.ts` files and ship at boot. **No dashboard.** No
agent-as-config-in-a-cloud-UI. This was decided after VoiceGen and is
now an invariant.

### Repo + deploy invariants

- Public on `github.com/moazzam-qureshi`
- `gh repo create moazzam-qureshi/sheetsense-ai --public --source=. --remote=origin --push`
- Coolify auto-deploys on push to `main`
- No exposed ports in production `docker-compose.yml` — Traefik handles
  routing
- `docker-compose.local.yml` overlay exposes ports for local dev; both
  files MUST be passed: `docker compose -f docker-compose.yml -f docker-compose.local.yml up`
- Real commit history (multi-step build, not one-shot dump)

---

## 9. Build phases (in order)

Per the user's "no v1, build everything end-to-end" directive, but
broken into commit-sized phases for reviewability per workspace style
preferences.

### Phase 1 — Repo scaffold + docs (this commit)

- Create `sheetsense-ai/` (done)
- Write `docs/architecture.md` and `docs/design.md` (this PR)
- Create `README.md`, `LICENSE`, `.gitignore`, `.env.example`
- Empty `docker-compose.yml` + `docker-compose.local.yml` placeholders
- Initialize git, first commit, `gh repo create`, push

### Phase 2 — Python sandbox sidecar

The architecturally critical piece. Built first because everything
downstream depends on it.

- `services/sandbox/` scaffolded with uv
- FastAPI app with `POST /execute_pandas`
- Subprocess + rlimits + audit hook implementation
- Composio Sheets fetch helper with Redis cache
- Result marshaling (DataFrame → records, Series → dict, etc.)
- Dockerfile, integrated into compose
- **Done when:** `curl POST /execute_pandas` with a sample sheet id and
  trivial code (`result = df.head()`) returns the expected JSON.

### Phase 3 — Mastra service skeleton

- `services/mastra/` scaffolded
- Copy + adapt `composio-agent-factory.ts` and `tool-classification.ts`
  from Clarilo
- Postgres connection + Mastra config in `src/mastra/index.ts`
- Health endpoint, session table migration
- Dockerfile + compose
- **Done when:** Mastra service boots, connects to Postgres, exposes
  health check.

### Phase 4 — The 4 agents + workflow

In order:
1. Schema Detector (Composio Sheets read tool)
2. Query Planner (no tools, structured Zod output)
3. Analyst (sandbox tool wired)
4. Writer (Composio write tools + sandbox chart tool + Gmail draft)
5. `sheetsense-pipeline.ts` workflow chaining all four
- **Done when:** Running the workflow against a sample sheet with a
  test question produces a new tab in the sheet with findings.

### Phase 5 — Next.js frontend

- Sheet picker (3 sample chips + "connect your Google account")
- Composio OAuth flow + callback handler
- Question input with sample-question chips
- Live agent-execution timeline (SSE from Mastra `agent.stream()`)
- Results panel with "view in your sheet" deep link
- Turnstile widget on the workflow-run endpoint
- **Done when:** Full end-to-end through the UI on local dev.

### Phase 6 — Deploy + brand

- `gh repo create` + push to GitHub
- Coolify project setup, env vars, domain assignment
- Add domain to Turnstile sitekey's allowed hostnames
- Verify Turnstile pre-deploy checklist (workspace CLAUDE.md)
- End-to-end smoke test on production URL from incognito
- Create Canva thumbnail matching DocuAI/VoiceGen template
- Upload to Upwork portfolio

### Phase 7 — Polish + case study

- Per-project KB doc written and indexed (markdown describing the
  build, stack choices, tradeoffs)
- `docs/upwork-case-study.md` written
- Final commit, final push

---

## 10. Open questions (resolved at handoff)

| Question | Decision |
|---|---|
| Should the agent definitions live in a dashboard like Composio Studio? | **No.** Agents-as-code locked. |
| Multi-sheet / cross-sheet joins in v1? | **No.** One sheet per session. |
| User accounts / saved history? | **No.** 24h ephemeral session, fresh visit each time. |
| Should writes to the user's sheet ask for approval? | **Yes for own-sheet mode, no for sample-sheet mode.** Sample-pickers opted in. |
| Tavily web enrichment in v1? | **Stretch.** Wire the tool but only invoke it if the question explicitly mentions external lookup. |
| Gmail draft sending? | **Draft only.** Never auto-send. Deny-by-default for any send action. |
| Mastra Studio (`mastra dev` on :4111) exposed in production? | **No.** Internal-only. Production routes through the Next.js API gateway. |

---

## 11. References

- Clarilo reference codebase: `D:\Personal\Projects\clarilo-ai-alpha\clarilo\`
  - `src/mastra/agents/agent-registry.ts` — auto-discovery pattern (we
    won't use the *auto*-discovery part since SheetSense pre-registers
    its 4 known agents, but the registry shape is reusable)
  - `src/mastra/tools/composio-agent-factory.ts` — `createComposioAgent`,
    `patchToolSchemas`, `patchToolApproval` — **copy verbatim**
  - `src/mastra/tools/tool-classification.ts` — `isWriteTool` /
    `classifyTools` — **copy verbatim**
  - `src/mastra/workflows/weather-workflow.ts` — `createStep` /
    `createWorkflow` shape — model for `sheetsense-pipeline.ts`
  - `src/mastra/index.ts` — Mastra root config with Postgres + observability
- Workspace orientation: `d:/Personal/Projects/Upwork Domination/CLAUDE.md`
- DocuAI guardrails reference: `agentic-rag-platform/shared/guardrails/`
- DocuAI Turnstile reference: `agentic-rag-platform/web/src/lib/turnstile.ts`
  + `agentic-rag-platform/shared/guardrails/turnstile.py`
