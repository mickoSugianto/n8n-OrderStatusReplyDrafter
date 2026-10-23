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
- [Supervised Recovery](#supervised-recovery)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Package Contents](#package-contents)
- [Offline Verification](#offline-verification)
- [Tested Behavior](#tested-behavior)
- [Known Limitations](#known-limitations)
- [Customization](#customization)
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

The main workflow canvas is organized into nine numbered phases (`00`–`08`):

1. **Receive & Claim (`01`)** — Polls Gmail every minute for messages with the input label (excluding `triaged`, drafts, Spam, and Trash). Verifies the authenticated receiver mailbox via the Gmail profile API and acquires an atomic PostgreSQL lock on `(mailbox, source_message_id)`. Competing or already-completed claims exit immediately.
2. **Validate & Clean Input (`02`)** — Checks that the sender is a single valid address in the controlled allowlist, strips quoted lines starting with `>`, and ensures the cleaned question is non-empty.
3. **Extract & Route (`03`)** — Uses Groq (`qwen/qwen3.8-27b`, with OpenRouter fallback on operational errors) to classify the request (`order_update` vs. `manual_review`) and extract digit-only order numbers. Deduplicates repeated identical numbers; routes two or more distinct order numbers to manual review.
4. **Look Up Order (`04`)** — Calls the `GetOrder` sub-workflow for exact string matching and schema validation against Google Sheets (`found`, `not_found`, `duplicate`, or `invalid_data`). Checks that the sender matches `customer_email`.
5. **Prepare Reply (`05`)** — Uses fixed templates for missing or unknown order numbers. For verified owned orders, calls Groq (with OpenRouter fallback) using only verified order fields, then runs deterministic checks (non-empty text, required tracking number present, no URLs).
6. **Save & Confirm Draft (`06`)** — Re-verifies the recipient against the allowlist, records draft intent (`DraftIntentRecorded`) in PostgreSQL before calling Gmail, creates the draft, checkpoints the returned `draft_id` and `draft_message_id` (`DraftSaved`), and reads the draft back from Gmail to confirm recipient, thread, subject, body, and absence of extra `CC`/`BCC`.
7. **Apply & Verify Labels (`07`)** — Checkpoints `LabelsPending`, applies `triaged` (and `needs-review` for manual-review outcomes), reads the source message back to confirm the labels are present, and marks the ledger row `Completed`.
8. **Retain Unfinished Work (`08`) & Supervised Recovery (`00`)** — If a handled failure occurs after claim, records `NeedsRecovery` or `NeedsInspection` at the current ledger phase and stops visibly so an operator can inspect and recover via `RecoverOrderStatusRequest`.

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

## Supervised Recovery

If an execution fails or stops mid-flight, the operator uses `RecoverOrderStatusRequest` after inspecting the ledger row, confirming the prior n8n execution is terminal, and verifying Gmail state:

- **`Processing`** — Re-runs validation, extraction, lookup, and drafting under the new owner token.
- **`DraftSaved` / `LabelsPending` (draft)** — Reads back and verifies the existing Gmail draft, then completes missing labels without calling models or creating a second draft.
- **`LabelsPending` (manual review)** — Applies and verifies the `needs-review` and `triaged` labels without calling models.
- **`DraftIntentRecorded` (uncertain write)** — Refuses to create a new draft (`UncertainWriteNeedsInspection`) unless the operator inspects Gmail and supplies the exact existing `inspectedDraftId` to verify and adopt.

See the [Operator Recovery Guide](docs/order-status-recovery-guide.md) for step-by-step instructions.

---

## Requirements

- **n8n** with built-in nodes: `Gmail`, `Google Sheets`, `Postgres`, `HTTP Request`, `n8n API`, `Groq Chat Model`, `OpenRouter Chat Model`, `Information Extractor`, and `Basic LLM Chain`.
- **Google OAuth2 credentials** for Gmail and Google Sheets (plus Google Drive API enabled if required for sheet discovery).
- **Two controlled email accounts** (one customer test sender, one support receiver mailbox) and a Google Sheet containing the synthetic `Orders` tab.
- **Supabase PostgreSQL database** configured with [`database/order-status-ledger.sql`](database/order-status-ledger.sql) and connected via SSL using the restricted `order_status_ledger` role.
- **Groq API** (`qwen/qwen3.8-27b`) and **OpenRouter API** (`openrouter/free`) credentials.
- **n8n API credential** (used by the main workflow during recovery to verify that the prior execution has stopped).

---

## Quick Start

Follow the full instructions in [Setup and Rebinding](docs/setup-and-rebinding.md) and the placeholder checklist in [Rebinding Map](docs/rebinding-map.md).

1. **Database Setup:** Run [`database/order-status-ledger.sql`](database/order-status-ledger.sql) in a dedicated Supabase project, set the password for `order_status_ledger`, create the `OrderStatusLedger` Postgres credential in n8n (with SSL), and run [`database/verify-order-status-ledger.sql`](database/verify-order-status-ledger.sql). See [Ledger Database Setup](docs/ledger-database-setup.md).
2. **Import Workflows (Inactive):** Import [`deliverables/get-order.json`](deliverables/get-order.json), [`deliverables/main-workflow.json`](deliverables/main-workflow.json), and [`deliverables/reliability/recover-order-status-request.json`](deliverables/reliability/recover-order-status-request.json). Keep them inactive while configuring.
3. **Prepare Orders Sheet:** Import [`deliverables/sample-orders.csv`](deliverables/sample-orders.csv) into an `Orders` tab with **all 6 columns formatted as plain text** (`order_number`, `customer_email`, `status`, `item`, `tracking_number`, `estimated_delivery`). Replace the sample `customer_email` values with your controlled sender address.
4. **Create Gmail Labels:** In the receiver Gmail account, create:
   - `order-status-reply-drafter/demo-input`
   - `order-status-reply-drafter/triaged`
   - `order-status-reply-drafter/needs-review`
5. **Rebind Placeholders & Credentials:** Bind credentials on all nodes (including the 4 model subnodes and HTTP profile read). Replace all `<...>` placeholders and reserved example addresses (`controlled-sender@example.com`, `controlled-receiver@example.com`) using [`docs/rebinding-map.md`](docs/rebinding-map.md).
6. **Publish Callable Sub-Workflow:** Validate and publish `GetOrder` before activating the main workflow.
7. **Supervised Test:** Send a test email from your controlled sender with the `demo-input` label applied, activate `DraftOrderStatusReply` for one supervised poll cycle, verify the resulting Gmail draft, labels, and `Completed` ledger row, then deactivate the main workflow.

---

## Package Contents

| Path | Description |
| --- | --- |
| [`deliverables/main-workflow.json`](deliverables/main-workflow.json) | Main workflow (`DraftOrderStatusReply`) |
| [`deliverables/get-order.json`](deliverables/get-order.json) | Deterministic order lookup sub-workflow (`GetOrder`) |
| [`deliverables/reliability/recover-order-status-request.json`](deliverables/reliability/recover-order-status-request.json) | Supervised manual recovery caller (`RecoverOrderStatusRequest`) |
| [`deliverables/sample-orders.csv`](deliverables/sample-orders.csv) | Synthetic sample orders (import all columns as plain text) |
| [`database/order-status-ledger.sql`](database/order-status-ledger.sql) | PostgreSQL table, constraints, RLS, role, and RPC functions |
| [`database/verify-order-status-ledger.sql`](database/verify-order-status-ledger.sql) | Read-only preflight verification SQL |
| [`docs/system-design.md`](docs/system-design.md) | Full as-built architecture, data contracts, state machines, and sequence diagrams |
| [`docs/setup-and-rebinding.md`](docs/setup-and-rebinding.md) | Step-by-step installation and credential/resource binding guide |
| [`docs/rebinding-map.md`](docs/rebinding-map.md) | Complete checklist of placeholders across all 7 workflows |
| [`docs/ledger-database-setup.md`](docs/ledger-database-setup.md) | Supabase PostgreSQL setup and security instructions |
| [`docs/order-status-recovery-guide.md`](docs/order-status-recovery-guide.md) | Operator runbook for recovering interrupted executions |
| [`docs/demo-test-cases.md`](docs/demo-test-cases.md) | Specification of the 10 end-to-end functional scenarios (`S01`–`S10`) |
| [`deliverables/regression/`](deliverables/regression/README.md) | Offline policy test suite, source-linkage checks, and model evaluation workflow |
| [`deliverables/regression/end-to-end/`](deliverables/regression/end-to-end/README.md) | Live end-to-end regression runner, observer, and fixture sender workflows |
| [`tests/`](tests/) | CLI entrypoints for recovery checks (`check-recovery.js`) and source linkage (`check-source-linkage.js`) |
| [`MANIFEST.json`](MANIFEST.json) | File inventory with byte sizes and SHA-256 checksums |

---

## Offline Verification

Requires Node.js (built-in modules only; no `npm install` or network access needed). Run from this directory:

```sh
node deliverables/regression/run-regression.js
node tests/check-recovery.js
node tests/check-source-linkage.js deliverables/main-workflow.json deliverables/get-order.json
```

- `run-regression.js` runs **246 unit/policy test cases** and **3 static audits**.
- `check-recovery.js` runs **57 offline recovery, guard, and snapshot checks**.
- `check-source-linkage.js` verifies that **15 inline runtime expressions** and **both model stage prompts/schemas/settings** in the workflow JSON exports match the shared policy libraries.

---

## Tested Behavior

Recorded verification in the controlled source environment (October 20, 2026):

| Verification Layer | Recorded Result |
| --- | --- |
| **Offline Policy & Validator Suite** | **246 / 246 passed** + 3 static/source audits |
| **Offline Recovery & Guard Checks** | **57 / 57 passed** (plus 107 observer/control checks) |
| **Native Model-Stage Evaluation** | **8 / 8 passed** on Groq `qwen/qwen3.8-27b` (5 extraction, 3 drafting; 8 calls, 3,892 total tokens) |
| **End-to-End Functional Regression** | **10 / 10 passed** (`S01`–`S10`: 6 verified drafts, 4 manual reviews, 0 customer emails sent, initial workflow state restored) |
| **Focused Reliability Proofs** | Overlapping concurrent claim exclusion, same-draft recovery, review-label recovery, completed-source skip, and uncertain-write refusal (`DraftIntentRecorded` with simulated checkpoint loss) |

---

## Known Limitations

- **Input scope:** Plain-text English only, at most one order per email, no attachment parsing.
- **Quote stripping:** Strips lines starting with `>` (after optional whitespace); does not parse arbitrary localized/HTML reply headers.
- **Weak sender identity:** Matching the `From` address to `customer_email` is a consistency check, not cryptographic or session-based customer authentication.
- **Bounded output checks:** Deterministic checks catch empty text, missing tracking numbers, and URLs (`http`/`www.`), but cannot guarantee absence of every subtle hallucination. **A human must review every draft before sending.**
- **External API boundary:** PostgreSQL and Gmail do not share an atomic distributed transaction, and the ledger cannot cancel an in-flight Gmail HTTP request. Recovery relies on confirming the prior execution has stopped and inspecting Gmail when a write outcome is uncertain.
- **Operations:** No automated retry queue, background scheduler, monitoring dashboard, or automated ledger purge is included. Completed ledger keys must be retained to prevent reprocessing old emails.

---

## Customization

- **Store branding:** Update `store_name` (`Sample Shop`) and `sign_off` (`Sample Shop Support`) in `PrepareSourceContext`.
- **Order data source:** `GetOrder` isolates Google Sheets behind a narrow `{ order_number } -> { lookup_status, order }` contract so you can swap in a database or e-commerce API without changing main routing logic.

---

## Author

**Micko Sugianto** — Automation Engineer (n8n, AI workflows, e-commerce operations)

- GitHub: [mickoSugianto](https://github.com/mickoSugianto)
- LinkedIn: [micko-sugianto](https://linkedin.com/in/micko-sugianto)
