# Order Status Reply Drafter

A supervised n8n workflow that turns incoming *"Where is my order?"* emails into Gmail reply drafts using verified order records from Google Sheets.

The workflow reads a labeled Gmail message, validates and looks up the order, and saves a plain-text draft reply in the original thread for a human to review and send. **The workflow never sends customer emails automatically.**

Built with **n8n**, **Gmail**, **Google Sheets**, **Supabase PostgreSQL**, **Groq**, and **OpenRouter**.

> **Scope:** Supervised reference implementation built on synthetic order data and two controlled Gmail accounts. Designed for evaluation and adaptation before connecting to live customer support.

---

## Contents

- [What It Does](#what-it-does)
- [Example Outcomes](#example-outcomes)
- [How It Works](#how-it-works)
- [Safety & Reliability Design](#safety--reliability-design)
- [Automated & Manual Recovery](#automated--manual-recovery)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Package Contents](#package-contents)
- [Offline Verification](#offline-verification)
- [Tested Behavior](#tested-behavior)
- [Known Limitations](#known-limitations)
- [Customization](#customization)
- [Demo Videos](#demo-videos)
- [Author](#author)

---

## What It Does

- **Watches a Gmail label** (`order-status-reply-drafter/demo-input`) for incoming order-status inquiries.
- **Extracts the request intent and order number** from the cleaned plain-text email.
- **Looks up the order deterministically** in Google Sheets via a separate `GetOrder` sub-workflow.
- **Verifies sender ownership** (sender email must match the order's `customer_email`) before any order facts are passed to the drafting model.
- **Creates a reply draft** in the original Gmail thread—or routes unsupported/ambiguous requests to **manual review** (`order-status-reply-drafter/needs-review`).
- **Prevents duplicate processing** using an atomic PostgreSQL ledger keyed by `(mailbox, source_message_id)`.

---

## Example Outcomes

| Incoming Request | Outcome |
| --- | --- |
| *"Where is order 1001?"* (shipped order) | Draft created with `shipped` status, tracking `TRK1001`, and `2026-10-20` explicitly stated as an estimate |
| *"When will order 1002 ship?"* (processing order) | Draft created stating `processing` status and noting that dispatch timing is not yet available |
| *"Has order 1003 been delivered?"* (delivered order) | Draft created with `delivered` status and tracking `TRK1003` (no invented delivery date) |
| *"Has my order shipped?"* (missing order number) | Fixed clarification draft asking for the order number (no lookup or drafting model call) |
| *"Where is order 9999?"* (unknown order number) | Fixed confirmation draft asking the customer to double-check the order number (no drafting model call) |
| *"Please refund order 1001."* | Routed to manual review (`needs-review` + `triaged` labels); no draft created |
| Different sender asks about order `1001` | Routed to manual review (`sender_mismatch`); order facts are withheld from the model and no draft is created |
| *"Where are orders 1001 and 1002?"* | Routed to manual review (`multiple_orders`); no lookup or draft created |
| Same completed message is polled again | Skipped immediately via the PostgreSQL ledger (`AlreadyCompleted`) |

*Note: Idempotency is scoped to `(mailbox, source_message_id)`. A new email asking about the same order number is treated as a new request.*

---

## How It Works

The main workflow canvas is organized into **6 Business Stages** (`Stage 1`–`Stage 6`), bookended by `RecoveryLane` at the top and `ErrorLane` at the bottom:

1. **Stage 1 — Receive Inquiry (`Stage1Lane`)** — Polls Gmail every minute for messages with the input label (excluding `triaged`, drafts, Spam, and Trash). Verifies the authenticated receiver mailbox via the Gmail profile API and acquires an atomic PostgreSQL lock on `(mailbox, source_message_id)`. Competing or already-completed claims exit immediately.
2. **Stage 2 — Classify & Extract (`Stage2Lane`)** — Strips quoted lines starting with `>`, checks that the sender is a single valid address in the controlled allowlist and the cleaned question is non-empty, then uses Groq (`qwen/qwen3.8-27b`, with OpenRouter fallback on operational errors) to classify the request (`order_update` vs. `manual_review`) and extract digit-only order numbers. Deduplicates repeated identical numbers; routes two or more distinct order numbers to manual review.
3. **Stage 3 — Lookup Order (`Stage3Lane`)** — Calls the `GetOrder` sub-workflow for exact string matching and schema validation against Google Sheets (`found`, `not_found`, `duplicate`, or `invalid_data`). Checks that the sender matches `customer_email`.
4. **Stage 4 — Prepare Reply (`Stage4Lane`)** — Uses fixed templates for missing or unknown order numbers. For verified owned orders, calls Groq (with OpenRouter fallback) using only verified order fields, then runs deterministic checks (non-empty text, required tracking number present, no URLs).
5. **Stage 5 — Save Gmail Draft (`Stage5Lane`)** — Re-verifies the recipient against the allowlist, records draft intent (`DraftIntentRecorded`) in PostgreSQL before calling Gmail, creates the draft, checkpoints the returned `draft_id` and `draft_message_id` (`DraftSaved`), and reads the draft back from Gmail to confirm recipient, thread, subject, body, and absence of extra `CC`/`BCC`.
6. **Stage 6 — Triage Source Email (`Stage6Lane`)** — Checkpoints `LabelsPending`, applies `triaged` (and `needs-review` for manual-review outcomes), reads the source message back to confirm the labels are present, and marks the ledger row `Completed`.
7. **Error Handling (`ErrorLane`) & Automated / Manual Recovery (`RecoveryLane`)** — If a handled failure occurs after claim, `ErrorLane` records `NeedsRecovery` or `NeedsInspection` at the current ledger phase (suppressing immediate alerts on first-time transient failures and stopping visibly on terminal issues), while `RecoveryLane` reconciles evidence and resumes at the recorded phase when invoked by `RecoverOrderStatusRequest`.

---

## Safety & Reliability Design

| Principle | Implementation |
| --- | --- |
| **Human in the loop** | Creates Gmail drafts only. No workflow node sends replies to customers. |
| **Deterministic facts** | Order lookup and validation happen in code (`GetOrder`). LLMs only extract intent and draft prose from verified facts. |
| **Sender consistency gate** | Sender address must match the order's `customer_email` before order details are exposed to the drafting prompt. |
| **Fail closed to review** | Refunds, prompt overrides, multiple orders, malformed sheet rows, and failed draft checks route to `needs-review` with no draft. |
| **Idempotent intake** | Composite primary key `(mailbox, source_message_id)` with `INSERT ... ON CONFLICT DO NOTHING` prevents duplicate drafts across overlapping polls. |
| **Write-intent checkpointing** | Draft intent is persisted to PostgreSQL before calling Gmail's draft creation API, and returned draft IDs are saved before readback verification. |

---

## Automated & Manual Recovery

First-time transient post-claim failures (`status = 'NeedsRecovery'`, `recovery_attempts = 0`) exit quietly so `RecoverOrderStatusRequest` can self-heal them on its 5-minute schedule. When human intervention is required—such as terminal `NeedsInspection` / quarantine transitions, pre-claim/trigger failures, or sweeper outages—`NotifyOrderStatusError` posts a sanitized Slack alert to `#order-status-drafter-alerts` and the operator uses `RecoverOrderStatusRequest` after inspecting the ledger row, confirming the prior n8n execution is terminal, and verifying Gmail state:

- **`Processing`** — Re-runs validation, extraction, lookup, and drafting under the new owner token.
- **`DraftSaved` / `LabelsPending` (draft)** — Reads back and verifies the existing Gmail draft, then completes missing labels without calling models or creating a second draft.
- **`LabelsPending` (manual review)** — Applies and verifies the `needs-review` and `triaged` labels without calling models.
- **`DraftIntentRecorded` (uncertain write)** — In `mode = 'auto'`, `RecoveryLane` reconciles the thread and mailbox draft list (`ReconcileUncertainDraft`): it adopts 1 matching draft, or recreates the draft from persisted `record.intent` (`RestoreRecordedIntent`, 0 LLM/Sheets calls) when 0 drafts and 0 post-source messages exist, or quarantines on ambiguity. In `mode = 'manual'`, `CheckRecoveryRequest` refuses uninspected creation (`UncertainWriteNeedsInspection`) unless the operator inspects Gmail and supplies the exact `inspectedDraftId` to verify and adopt.

See the [Operator Recovery Guide](docs/order-status-recovery-guide.md) for step-by-step instructions.

---

## Requirements

- **n8n** with built-in nodes: `Gmail`, `Google Sheets`, `Postgres`, `Slack`, `HTTP Request`, `n8n API`, `Schedule Trigger`, `Error Trigger`, `Groq Chat Model`, `OpenRouter Chat Model`, `Information Extractor`, and `Basic LLM Chain`.
- **Google OAuth2 credentials** for Gmail and Google Sheets (plus Google Drive API enabled if required for sheet discovery).
- **Two controlled email accounts** (one customer test sender, one support receiver mailbox) and a Google Sheet containing the synthetic `Orders` tab.
- **Supabase PostgreSQL database** configured with [`database/order-status-ledger.sql`](database/order-status-ledger.sql) (or upgraded with [`database/migrate-automated-recovery.sql`](database/migrate-automated-recovery.sql)) and connected via SSL using the restricted `order_status_ledger` role.
- **Groq API** (`qwen/qwen3.8-27b`) and **OpenRouter API** (`openrouter/free`) credentials.
- **Slack API credential** (`slackApi`, used by `NotifyOrderStatusError` to post sanitized error alerts to `#order-status-drafter-alerts`).
- **n8n API credential** (used by the main workflow during recovery to verify that the prior execution has stopped).

---

## Quick Start

Follow the full instructions in [Setup and Rebinding](docs/setup-and-rebinding.md) and the placeholder checklist in [Rebinding Map](docs/rebinding-map.md).

1. **Database Setup:** Run [`database/order-status-ledger.sql`](database/order-status-ledger.sql) in a dedicated Supabase project (or [`database/migrate-automated-recovery.sql`](database/migrate-automated-recovery.sql) when upgrading an existing deployment), set the password for `order_status_ledger`, create the `OrderStatusLedger` Postgres credential in n8n (with SSL), and run [`database/verify-order-status-ledger.sql`](database/verify-order-status-ledger.sql). See [Ledger Database Setup](docs/ledger-database-setup.md).
2. **Import Workflows (Inactive):** Import [`workflows/get-order.json`](workflows/get-order.json), [`workflows/notify-order-status-error.json`](workflows/notify-order-status-error.json), [`workflows/main-workflow.json`](workflows/main-workflow.json), and [`workflows/recover-order-status-request.json`](workflows/recover-order-status-request.json). Keep them inactive while configuring.
3. **Prepare Orders Sheet:** Import [`database/sample-orders.csv`](database/sample-orders.csv) into an `Orders` tab with **all 6 columns formatted as plain text** (`order_number`, `customer_email`, `status`, `item`, `tracking_number`, `estimated_delivery`). Replace the sample `customer_email` values with your controlled sender address.
4. **Create Gmail Labels:** In the receiver Gmail account, create:
   - `order-status-reply-drafter/demo-input`
   - `order-status-reply-drafter/triaged`
   - `order-status-reply-drafter/needs-review`
5. **Rebind Placeholders & Credentials:** Bind credentials on all nodes (including the 4 model subnodes, the HTTP profile read, `FindRecoverableRequests` in `RecoverOrderStatusRequest`, and `SendSlackErrorAlert` in `NotifyOrderStatusError`). Fill in the 5 fields on `WorkflowConfig` (`customerEmail`, `receiverEmail`, `inputLabelId`, `triagedLabelId`, `reviewLabelId`), the 2 fields on `GetOrderConfig` (`spreadsheetId`, `sheetGid`), `slackChannelId` on `ErrorAlertConfig`, and `receiverEmail` on `SelectUnresolvedRequest`, then select the sub-workflows from the dropdowns on `GetOrderDeterministically` and `RecoverThroughMain` using [`docs/rebinding-map.md`](docs/rebinding-map.md).
6. **Publish Dependencies & Attach Error Workflow:** Validate and publish `GetOrder`, activate/publish `NotifyOrderStatusError`, and select `NotifyOrderStatusError` under **Workflow Settings → Error Workflow** on both `DraftOrderStatusReply` and `RecoverOrderStatusRequest` before activating the main workflow or recovery sweeper.
7. **Supervised Test:** Send a test email from your controlled sender with the `demo-input` label applied, activate `DraftOrderStatusReply` for one supervised poll cycle, verify the resulting Gmail draft, labels, and `Completed` ledger row, then deactivate the main workflow.

---

## Package Contents

| Path | Description |
| --- | --- |
| [`workflows/main-workflow.json`](workflows/main-workflow.json) | Main workflow (`DraftOrderStatusReply`) |
| [`workflows/get-order.json`](workflows/get-order.json) | Deterministic order lookup sub-workflow (`GetOrder`) |
| [`workflows/recover-order-status-request.json`](workflows/recover-order-status-request.json) | Automated 5-minute recovery sweeper and manual recovery caller (`RecoverOrderStatusRequest`) |
| [`workflows/notify-order-status-error.json`](workflows/notify-order-status-error.json) | Stateless Slack error-alerting workflow (`NotifyOrderStatusError`) |
| [`database/sample-orders.csv`](database/sample-orders.csv) | Synthetic sample orders (import all columns as plain text) |
| [`database/order-status-ledger.sql`](database/order-status-ledger.sql) | PostgreSQL table, constraints, RLS, role, and RPC functions |
| [`database/migrate-automated-recovery.sql`](database/migrate-automated-recovery.sql) | Idempotent migration SQL adding `recovery_attempts` and automated recovery RPCs to existing deployments |
| [`database/verify-order-status-ledger.sql`](database/verify-order-status-ledger.sql) | Read-only preflight verification SQL (18 boolean checks) |
| [`docs/system-design.md`](docs/system-design.md) | Full as-built architecture, data contracts, state machines, and sequence diagrams |
| [`docs/setup-and-rebinding.md`](docs/setup-and-rebinding.md) | Step-by-step installation and credential/resource binding guide |
| [`docs/rebinding-map.md`](docs/rebinding-map.md) | Complete checklist of placeholders across all 8 workflows |
| [`docs/ledger-database-setup.md`](docs/ledger-database-setup.md) | Supabase PostgreSQL setup and security instructions |
| [`docs/order-status-recovery-guide.md`](docs/order-status-recovery-guide.md) | Operator runbook for recovering interrupted executions |
| [`docs/demo-test-cases.md`](docs/demo-test-cases.md) | Specification of the 10 end-to-end functional scenarios (`S01`–`S10`) |
| [`workflows/harness/`](workflows/harness/) | Optional model-evaluation and live end-to-end regression harness workflows |
| [`src/`](src/) | Shared deterministic policy modules, order validator, and model/expression contracts |
| [`tests/`](tests/) | Offline unit/policy suite (`run-regression.js`), recovery checks (`check-recovery.js`), source-linkage audit (`check-source-linkage.js`), harness checks (`check-harness.js`), and test fixtures |
| [`docs/testing-guide.md`](docs/testing-guide.md) | Consolidated offline, model-evaluation, and live end-to-end testing guide |

---

## Offline Verification

Requires Node.js (built-in modules only; no `npm install` or network access needed). Run from this directory:

```sh
npm test
```

Or run each suite individually:

```sh
node tests/run-regression.js
node tests/check-recovery.js
node tests/check-source-linkage.js workflows/main-workflow.json workflows/get-order.json workflows/notify-order-status-error.json
node tests/check-harness.js
```

- `run-regression.js` runs **264 unit/policy test cases** and **3 static audits**.
- `check-recovery.js` runs **75 offline recovery, guard, and snapshot checks**.
- `check-source-linkage.js` verifies that **16 inline runtime expressions** across `main-workflow.json`, `get-order.json`, and `notify-order-status-error.json` and **both model stage prompts/schemas/settings** match the shared policy libraries.
- `check-harness.js` verifies **10 offline E2E harness checks** covering structural, expression, safety-gate, Data Table mappings, and swimlane-layout invariants across all 4 harness workflows in `workflows/harness/` (`run-order-status-regression.json`, `observe-order-status-case.json`, `sender-callable.json`, `evaluation-workflow.json`).

---

## Tested Behavior

Recorded verification in the controlled source environment:

| Verification Layer | Recorded Result |
| --- | --- |
| **Offline Policy & Validator Suite** | **264 / 264 passed** + 3 static/source audits |
| **Offline Recovery & Guard Checks** | **75 / 75 passed** (plus 107 observer/control checks) |
| **Offline Source-Linkage & E2E Harness Audits** | **16 / 16 expressions + both model definitions matched** · **10 / 10 harness checks passed** |
| **Native Model-Stage Evaluation** | **8 / 8 passed** on Groq `qwen/qwen3.8-27b` (5 extraction, 3 drafting; 8 calls, 3,892 total tokens) |
| **End-to-End Functional Regression** | **10 / 10 passed** (`S01`–`S10`: 6 verified drafts, 4 manual reviews, 0 customer emails sent, initial workflow state restored) |
| **Focused Reliability Proofs** | Overlapping concurrent claim exclusion, same-draft recovery, review-label recovery, completed-source skip, and manual uncertain-write refusal (`DraftIntentRecorded` with simulated checkpoint loss) |

---

## Known Limitations

- **Input scope:** Plain-text English only, at most one order per email, no attachment parsing.
- **Quote stripping:** Strips lines starting with `>` (after optional whitespace); does not parse arbitrary localized/HTML reply headers.
- **Weak sender identity:** Matching the `From` address to `customer_email` is a consistency check, not cryptographic or session-based customer authentication.
- **Bounded output checks:** Deterministic checks catch empty text, missing tracking numbers, and URLs (`http`/`www.`), but cannot guarantee absence of every subtle hallucination. **A human must review every draft before sending.**
- **External API boundary:** PostgreSQL and Gmail do not share an atomic distributed transaction, and the ledger cannot cancel an in-flight Gmail HTTP request. Recovery relies on confirming the prior execution has stopped (plus a 60-second write-settle window in auto mode) and reconciling or inspecting Gmail when a write outcome is uncertain.
- **Operations:** While `RecoverOrderStatusRequest` (`ScheduleRecoverySweep`) provides a bounded 5-minute automated recovery sweep (`max_attempts = 1`) and `NotifyOrderStatusError` provides sanitized Slack failure alerting, no general-purpose job queue, external monitoring dashboard, or automated ledger purge is included. Completed ledger keys must be retained to prevent reprocessing old emails.

---

## Customization

- **Store branding:** Update `store_name` (`Sample Shop`) and `sign_off` (`Sample Shop Support`) in `PrepareSourceContext`.
- **Order data source:** `GetOrder` isolates Google Sheets behind a narrow `{ order_number } -> { lookup_status, order }` contract so you can swap in a database or e-commerce API without changing main routing logic.

---

## Demo Videos

Two captioned recordings accompany this package:

| Recording | Video Link |
| --- | --- |
| **Order Status Reply Drafter — Product Demo** (`3m 20s`, test data) — end-to-end processing of labeled test emails into verified Gmail drafts and manual-review routing | [Watch on YouTube](https://youtu.be/QH3z75VQRNs) |
| **Order Status Reply Drafter — Engineering Walkthrough** (`4m 49s`, test data) — live walkthrough of the 6-stage pipeline with dedicated Recovery and Error sections, PostgreSQL idempotency ledger, bounded recovery, Slack alerts, and verification suites | [Watch on YouTube](https://youtu.be/sZgAU6DDK90) |

---

## Author

**Micko Sugianto** — Automation Engineer (n8n, AI workflows, e-commerce operations)

- GitHub: [mickoSugianto](https://github.com/mickoSugianto)
- LinkedIn: [micko-sugianto](https://linkedin.com/in/micko-sugianto)
