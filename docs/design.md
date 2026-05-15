# SheetSense AI — Design

> Visual and UX specification. Companion to
> [`architecture.md`](./architecture.md). The visual archetype is
> **Sheets-native** — distinct from DocuAI's Notion-warm and VoiceGen's
> dark-cyan-voice-orb. Each portfolio project must look like its own
> product, not one template.

---

## 1. Design intent

The visitor sees what they're already familiar with — a spreadsheet
interface — but with AI agents working alongside the data instead of in
a separate "chat with your data" sidebar. Cells, formula bar, and tab
strips are the metaphor. Agent activity is shown as a vertical
timeline pinned to the right edge so the data stays the hero.

Three things the design must achieve:
1. **Lower the activation cost.** Visitors see sample-sheet chips and
   sample-question chips first; they should be able to fire a real
   pipeline run within 10 seconds of landing, without typing anything.
2. **Make the agent work *visible*.** Each of the 4 agents lights up,
   streams partial output, and stamps a result card on the timeline.
   This is the differentiator — not "answer appears," but "watch four
   specialists analyze your data."
3. **Eliminate the "did it work?" question.** When the Writer finishes,
   the visitor sees a direct deep link: "Open the new SheetSense
   Insights tab in your sheet →". Click it, see the result in their
   own sheet. The proof is in their sheet, not in our UI.

---

## 2. Brand

| Element | Value |
|---|---|
| Product name | **SheetSense AI** |
| Wordmark | `SheetSenseAI` rendered italic, sentence-case stripped (no space) |
| Tagline | "AI Sales Data Analyst" |
| Value prop (long) | "Analyzes your live Google Sheets data and writes findings back" |
| Domain stake | "Multi-agent" is the technical hook; "Sheets-native sales analyst" is the business hook |

---

## 3. Color palette

Sheets-adjacent green with off-white canvas. Reads as familiar but not
a Google clone — saturation is lower, accents are warmer than Google's
crisp `#0F9D58`.

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#FAFAF7` | Canvas background (warm off-white) |
| `--bg-grid` | `#FFFFFF` | Cells, cards, sheet surface |
| `--grid-line` | `#E4E4DF` | 1px gridlines, card borders |
| `--ink` | `#1F2937` | Primary text |
| `--ink-soft` | `#6B7280` | Secondary text, labels |
| `--accent` | `#1B8753` | Primary green (CTA, agent-active state) |
| `--accent-soft` | `#E6F4EC` | Agent-active row tint, success cell highlight |
| `--accent-deep` | `#0F5C36` | Hover, active state |
| `--warn` | `#B45309` | Warning ribbon (rate limit warning, schema mismatch) |
| `--error` | `#B91C1C` | Error states |
| `--chart-1` | `#1B8753` | Primary chart line/bar |
| `--chart-2` | `#2563EB` | Secondary chart series |
| `--chart-3` | `#B45309` | Tertiary chart series |

---

## 4. Typography

| Use | Font | Weight | Size (desktop) |
|---|---|---|---|
| Wordmark | Inter, **italic** | 700 | 28px |
| Page H1 | Inter | 700 | 32px |
| Section H2 | Inter | 600 | 20px |
| Body | Inter | 400 | 15px |
| UI labels | Inter | 500 | 13px |
| Data/cells/code | **JetBrains Mono** | 400 | 13px |
| Formula bar input | JetBrains Mono | 400 | 15px |

Mono everywhere data lives. Inter everywhere UI lives. The contrast is
deliberate — it signals "this is a real spreadsheet surface" the
moment the visitor's eye crosses a data cell.

---

## 5. Page layout

Single-screen Next.js app. No routes, no auth wall, no signup. Three
states managed client-side: **idle**, **running**, **complete**.

### Idle state (the landing — first 10 seconds)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  SheetSenseAI                                          Built by Moazzam  │ <- top bar (60px)
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   AI Sales Data Analyst                                                  │ <- H1 hero
│   Watch 4 AI agents analyze your Google Sheet and write                  │ <- subhead
│   findings back as a new tab.                                            │
│                                                                          │
│   ┌────────────────────────────────────────────────────────────────┐    │
│   │  Pick a sample sheet to analyze                                 │    │
│   │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │    │ <- 3 sample
│   │  │  📋 Customers   │  │  💼 Deal       │  │  🛒 E-commerce  │  │    │    sheet
│   │  │  ~200 rows      │  │  Pipeline       │  │  Orders         │  │    │    chips
│   │  │  CRM-style data │  │  ~50 rows       │  │  ~500 rows      │  │    │
│   │  └─────────────────┘  └─────────────────┘  └─────────────────┘  │    │
│   │                                                                  │    │
│   │  ── or ──                                                       │    │
│   │                                                                  │    │
│   │  [ 🔐 Connect your Google Sheets account ]                      │    │ <- OAuth CTA
│   └────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│   How it works                                                           │ <- 4 capability
│   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐                    │    cards
│   │ Schema  │  │ Plan    │  │ Analyze │  │ Write   │                    │
│   │ Detect  │  │ Query   │  │ in pandas│  │ findings│                    │
│   └─────────┘  └─────────┘  └─────────┘  └─────────┘                    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

When a sheet is selected, the layout transitions to the **running**
state (no page navigation — same screen, content swap).

### Running state (during pipeline execution)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  SheetSenseAI    │ Customers sheet • 200 rows • 8 cols      Live ●      │ <- top bar
├──────────────────┴──────────────────────────────────────────┬───────────┤
│                                                              │           │
│   fx  [ Which customers haven't bought in 60 days? ▸  ] Ask  │  Pipeline │ <- formula bar
│                                                              │           │
│   Sample questions for this sheet:                           │  ┌──────┐ │
│   • Who hasn't been followed up in 60 days?                  │  │ 1  ● │ │ <- Schema
│   • Which customers are at risk of churning?                 │  │ Schema│ │    detector
│   • What's my average LTV?                                   │  │   ✓  │ │    (done)
│                                                              │  └──────┘ │
│   ┌──────────────────────────────────────────────────────┐  │  ┌──────┐ │
│   │ Sheet preview (live grid, first 10 rows)              │  │  │ 2  ● │ │ <- Planner
│   │ ┌──┬─────────┬──────────┬─────────┬──────┬────────┐  │  │  │ Plan  │ │    (active)
│   │ │  │ Name    │ Last buy │ LTV     │ Notes│ Status │  │  │  │ ...  │ │
│   │ │1 │ J. Park │ 2025-11  │ $4,200  │ ...  │ Active │  │  │  └──────┘ │
│   │ │2 │ M. Chen │ 2025-08  │ $1,100  │ ...  │ Cold   │  │  │  ┌──────┐ │
│   │ │…                                                 │  │  │  │ 3  ○ │ │ <- Analyst
│   │ └──────────────────────────────────────────────────┘  │  │  │       │ │    (queued)
│   └──────────────────────────────────────────────────────┘  │  └──────┘ │
│                                                              │  ┌──────┐ │
│                                                              │  │ 4  ○ │ │ <- Writer
│                                                              │  │       │ │    (queued)
│                                                              │  └──────┘ │
└──────────────────────────────────────────────────────────────┴───────────┘
```

Right rail is the **agent timeline**: 4 numbered cards stacked
vertically. Each card has three states:

- ○ **Queued** — neutral gray, no animation
- ● **Active** — `--accent` ring with breathing pulse (1.5s loop),
  partial streaming output visible inside the card
- ✓ **Complete** — solid green check, condensed result summary visible,
  click to expand

Active cards tint the sheet preview below with `--accent-soft` on rows
the agent is currently reading (when the agent is the Schema Detector
or Analyst). This makes the agent's *attention* visible — not just its
output.

### Complete state

```
┌─────────────────────────────────────────────────────────────────────────┐
│  SheetSenseAI    │ Customers sheet                          Complete ✓  │
├──────────────────┴──────────────────────────────────────────────────────┤
│                                                                          │
│   ┌──────────────────────────────────────────────────────────────────┐  │
│   │  ✓ Analysis complete                                              │  │
│   │                                                                   │  │
│   │  Wrote findings to a new tab: "SheetSense Insights — 2026-05-16" │  │
│   │  [ 🔗 Open in your Google Sheet ]   [ Run another question ]     │  │
│   └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│   ┌──────────────────────────────────────────────────────────────────┐  │
│   │  Findings                                                         │  │
│   │                                                                   │  │
│   │  • 42 customers (21%) haven't bought in 60+ days                  │  │
│   │  • Of those, 18 have LTV > $1,000 — high-value reactivation tier  │  │
│   │  • Most common stall point: post-product-A purchase (12 cust.)    │  │
│   │                                                                   │  │
│   │  [ chart: bar chart of stalled customers by category ]            │  │
│   │                                                                   │  │
│   │  Suggested next step: drafted a follow-up email template for the  │  │
│   │  high-value tier — open Gmail Drafts to review.                   │  │
│   └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

The deep link `🔗 Open in your Google Sheet` is the proof point — it
opens the visitor's actual sheet at the new "SheetSense Insights" tab
in a new browser tab. They see the agent's work in the place they
already trust.

---

## 6. The formula-bar input

The question input is styled as a **formula bar**, not a chat box.
This is the single most distinctive UI choice and it's deliberate:

- Width: full content width
- Height: 44px
- Left badge: `fx` in `--ink-soft`, JetBrains Mono
- Input: JetBrains Mono 15px, `--ink` text on `--bg-grid` background
- Right CTA: `Ask` button in `--accent`
- Hover: 1px `--accent` border (the cell-selected ring from Sheets)
- Disabled state during pipeline run: `--ink-soft` placeholder
  "Pipeline running — wait for completion or cancel ↗"

When the visitor focuses the input, sample-question chips appear below
it (specific to the picked sheet — see §7).

---

## 7. The three sample sheets

Each ships as a real Google Sheet on a service account we own,
pre-shared with the demo Composio user. The visitor picks one, the
pipeline runs against it, the new "SheetSense Insights" tab is written
back to the same sheet.

### 7.1 Customer list (~200 rows)

| Column | Type |
|---|---|
| `customer_id` | ID |
| `name` | text |
| `email` | email |
| `last_purchase_date` | date |
| `lifetime_value_usd` | currency |
| `products_bought` | comma-separated text |
| `notes` | text |
| `status` | category (Active / Cold / Churned) |

Sample-question chips:
- "Who haven't I followed up with in 60 days?"
- "Which customers are at risk of churning?"
- "What's my average customer LTV?"
- "Find my top 10 highest-value customers"
- "Which products attract the highest-LTV customers?"

### 7.2 B2B deal pipeline (~50 rows)

| Column | Type |
|---|---|
| `company` | text |
| `contact` | text |
| `deal_size_usd` | currency |
| `stage` | category (Discovery / Demo / Proposal / Negotiation / Closed Won / Closed Lost) |
| `owner` | text |
| `expected_close_date` | date |
| `last_activity_date` | date |

Sample-question chips:
- "Which deals haven't moved in 30 days?"
- "What's my forecast for this quarter?"
- "Find deals at risk based on the last_activity_date column"
- "Which rep has the highest win rate?"
- "What's the average days-to-close per stage?"

### 7.3 E-commerce orders log (~500 rows)

| Column | Type |
|---|---|
| `order_date` | date |
| `order_id` | ID |
| `product` | text |
| `quantity` | number |
| `revenue_usd` | currency |
| `customer_email` | email |
| `channel` | category (Shopify / Etsy / Amazon) |
| `refunded` | boolean |

Sample-question chips:
- "Which products are slowing down month-over-month?"
- "Find my top 10 repeat customers"
- "Which channel has the best margin?"
- "What's my refund rate by product?"
- "Show monthly revenue trend by channel"

---

## 8. Components inventory

| Component | Purpose | Notes |
|---|---|---|
| `SheetPicker` | 3-chip + OAuth CTA on idle state | Chip is `--bg-grid` with `--grid-line`, hover lifts shadow + `--accent` border |
| `FormulaBar` | Question input | Distinctive — formula-bar styling, not chat |
| `SampleQuestionChips` | Below formula bar on focus | One chip per sample question, fills input on click |
| `SheetPreview` | Live grid of first 10 rows | Real grid (CSS Grid), monospace cells, gridlines |
| `AgentTimeline` | Right-rail vertical 4-card stack | Each card states queued / active / complete |
| `AgentCard` | One entry on the timeline | Streaming text inside when active; collapsed summary when complete |
| `SchemaConfirmCard` | HITL checkpoint for own-sheet mode | Shows detected types, lets visitor correct |
| `FindingsPanel` | Final result block | Narrative + embedded chart PNG + email-draft suggestion |
| `OpenInSheetButton` | Deep link to the new Insights tab | Opens in new tab, `target="_blank"`, `rel="noopener"` |
| `TurnstileGate` | Invisible Turnstile widget on the workflow-run call | Modal backdrop for visible challenge |
| `RateLimitBanner` | Top banner when per-IP rate limit or cost ceiling hits | `--warn` ribbon |

---

## 9. Motion + state transitions

Restraint over flash. The pipeline running is the show; the UI doesn't
need to compete with it.

| Transition | Spec |
|---|---|
| Sheet chip hover | 150ms `--accent` border fade-in + 2px lift |
| Idle → Running | 250ms cross-fade between hero and split layout |
| Agent card queued → active | Ring pulse begins, 1.5s breathing loop (opacity 0.4 ↔ 1.0) |
| Agent card active → complete | Pulse stops, check icon scales in over 200ms |
| Streaming text inside active card | Token-by-token append, no typewriter delay |
| Row highlight on schema/analyst | `--accent-soft` background fades in on the rows the agent reads |
| Complete state reveal | 400ms slide-up + fade-in of findings panel |

No bouncy springs. No confetti. The product should feel like a serious
analyst tool, not a toy.

---

## 10. Mobile

Below 900px:
- Sheet picker chips stack vertically
- Sheet preview hides; the formula bar and timeline take the full width
- Agent timeline collapses to a horizontal 4-step progress bar at the
  top, with a "tap to expand" sheet that brings up the streaming
  detail
- Findings panel renders full-width
- The "Open in your Google Sheet" deep link is the primary CTA below
  findings (mobile users will most often complete the loop by jumping
  to the Sheets mobile app)

---

## 11. Brand thumbnail (Canva)

Matches the locked template from DocuAI and VoiceGen. Same layout
grid, different content:

| Slot | Content |
|---|---|
| Display name | `SheetSenseAI` (italic, Inter Black) |
| Subhead | `AI Sales Data Analyst` |
| Value prop | `Analyzes your live Google Sheets data and writes findings back` |
| Stack chips (6) | `Mastra` · `Composio` · `OpenAI` · `Google Sheets` · `FastAPI` · `OpenRouter` |
| Background tint | Light off-white with subtle green accent stripe (matches `--bg` and `--accent-soft`) |

Saved at the same Canva resolution as DocuAI/VoiceGen tiles so the
Upwork portfolio reads as a consistent set.

---

## 12. Differentiation map (vs DocuAI and VoiceGen)

A reader scrolling Moazzam's Upwork portfolio sees three tiles. They
must look like three different products.

| Project | Archetype | Hero color | Primary font | Distinctive UI element |
|---|---|---|---|---|
| DocuAI | Notion document workspace | Warm off-white `#FBFBFA` | Inter + **Lora** for headings | Three-pane: sidebar / chat / retrieval trace |
| VoiceGen AI | Dark voice console | Near-black with cyan `#22D3EE` | Inter throughout | Centerpiece pulsing **Orb** with state-driven animation |
| **SheetSense AI** | **Spreadsheet surface** | **Warm off-white with green `#1B8753`** | **Inter + JetBrains Mono for data** | **Formula bar input + live grid + 4-agent timeline rail** |

Same author, three distinct products. That's the portfolio thesis.

---

## 13. Implementation notes for the frontend engineer

- All colors live in `web/src/styles/globals.css` as CSS custom
  properties under `:root`. Tailwind extended via `theme.extend.colors`
  to reference the CSS vars (so dark mode could be added later without
  touching components — though dark mode is out of scope for v1).
- `JetBrains Mono` from Google Fonts, self-hosted via
  `next/font/google` (no CLS, no third-party request).
- The agent timeline streams via SSE from `/api/workflow/stream`. The
  client uses the native `EventSource` API. Each event has shape
  `{ agent: "schema" | "plan" | "analyze" | "write", phase: "start" |
  "delta" | "complete", payload: any }`. Drives the agent-card state
  machine.
- The "Open in your Google Sheet" link is constructed as
  `https://docs.google.com/spreadsheets/d/<sheetId>/edit#gid=<newTabGid>`.
  The Writer agent returns `newTabGid` in its output; the frontend
  composes the URL.
- Sample sheets are loaded as fixtures from
  `web/src/lib/sample-sheets.ts` so we don't pay the Composio call on
  every page load — the Sheets API is only hit when the pipeline
  actually runs.
- Turnstile widget mounts in a 300×65 px container on the page even in
  invisible mode (see workspace `CLAUDE.md` Turnstile gotcha #2).
