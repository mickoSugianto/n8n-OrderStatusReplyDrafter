# Order Status Reply Drafter

**A supervised n8n workflow that turns "where is my order?" emails into Gmail reply drafts, using verified order records from Google Sheets.**

It reads a labeled Gmail message, looks up the order, and saves a draft reply in the original email thread. A human reviews and sends every reply. **The workflow has no send operation.**

Built with n8n, Gmail, Google Sheets, PostgreSQL, Groq and OpenRouter.

> **Scope:** this is a supervised demonstration built on synthetic orders and two controlled email accounts. Use it to learn the pattern and evaluate it before adapting it to real customer support. It has not been tested in production.

## Contents

- [What it does](#what-it-does)
- [Example outcomes](#example-outcomes)
- [How it works](#how-it-works)
- [Safety design](#safety-design)
- [Recovery](#recovery)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Repository contents](#repository-contents)
- [Tested behavior](#tested-behavior)
- [Limitations](#limitations)
- [Customization](#customization)
- [Demo videos](#demo-videos)
- [Author](#author)

## What it does

Answering a "where is my order?" email means finding the right record, checking its status and writing a useful reply. This workflow does those steps and leaves the final decision to you.

- Reads a Gmail message marked with an input label.
- Extracts the request type and order number.
- Looks up the order in Google Sheets through a separate, deterministic sub-workflow.
- Checks that the sender matches the order's customer email before any order facts reach the language model.
- Writes a plain-text draft in the original thread, or routes the message to manual review.
- Applies Gmail labels so you can see what happened to each message.

## Example outcomes

| Incoming request | Outcome |
| --- | --- |
| "Where is order 1001?" | Draft with shipped status, exact tracking, and the supplied delivery estimate described as an estimate |
| "Has my order shipped?" | Fixed draft asking for the order number |
| "Where is order 9999?" | Fixed draft asking the sender to confirm the number |
| "Please refund order 1001." | Manual review, no reply draft |
| A different account asks about order 1001 | Manual review after the ownership check |
| "Where are orders 1001 and 1002?" | Manual review, no reply draft |
| The same completed message is seen again | Skipped: no lookup, model call or draft |

Duplicate prevention is scoped to the authenticated mailbox and source-message pair. A new message about the same order is a separate request.

## How it works

1. **Receive and claim.** Gmail polls every minute for the input label, excluding triaged messages, drafts, Spam and Trash. The workflow verifies the authenticated receiver and source IDs, then makes an atomic PostgreSQL claim on the mailbox/message key. Competing attempts skip business processing, and completed sources skip entirely.
2. **Validate and understand.** The sender is checked against a controlled-account allowlist, simple quoted lines are removed, and the request type and order number are extracted. Two distinct order numbers go to review; repeated identical numbers count as one.
3. **Look up the order.** A separate `GetOrder` sub-workflow does a deterministic Sheets lookup and validation. It distinguishes found, missing, duplicate and invalid records.
4. **Choose the reply path.** Missing and unknown order numbers use fixed templates. Known orders require the sender to match the order's customer email before facts reach the drafting model.
5. **Draft and check.** Groq writes from verified facts only. The workflow checks for empty text, missing supplied tracking and common URL patterns. Extraction and drafting each have an OpenRouter fallback for recognized provider failures. Invalid content follows the review path.
6. **Save and confirm.** The ledger records draft intent before Gmail creation and saves the returned draft ID before readback. The workflow checks the saved draft's identity, thread, subject, plain-text body and intended recipient, including no extra CC/BCC.
7. **Verify and finish.** Draft outcomes get the triaged label. Review outcomes get both review and triaged labels, with no draft. The workflow reads the source back, verifies the labels and completes the ledger. Interrupted work keeps its phase for supervised recovery.

The main canvas has nine numbered phase notes (00–08) to help you follow the flow and locate failures.

## Safety design

| Principle | How it is implemented |
| --- | --- |
| Human in the loop | Drafts only. There is no automatic send operation. |
| Deterministic facts | Order lookup is a separate sub-workflow. The model only extracts and drafts. |
| Ownership check | The sender must match the order's customer email before order facts reach the model. |
| Fail safely | Refunds, multiple orders, conflicting information and failed content checks go to manual review with no draft. |
| No duplicates | An atomic claim per mailbox/message, durable draft checkpoints and readback checks. |
| Honest recovery | If draft creation may have succeeded but its ID was not recorded, recovery refuses to create another and requires inspection. |

## Recovery

The included `RecoverOrderStatusRequest` workflow calls the main workflow's shared recovery entry. Before recovering a request, an operator inspects the exact ledger record, the prior execution and the Gmail state, stops the prior execution and reconciles any outstanding writes.

Recovery can:

- resume processing before draft creation,
- verify an already saved draft and finish its labels, or
- finish review labels without calling the models.

Missing, sent, deleted or changed drafts are never recreated automatically. An operator may supply a specifically inspected draft ID for verification and adoption.

There is no recovery scheduler or retry queue. See the [operator recovery guide](docs/order-status-recovery-guide.md).

## Requirements

- n8n with these nodes available: Gmail, Google Sheets, Postgres, HTTP Request, n8n API, Groq Chat Model, OpenRouter Chat Model, Information Extractor and Basic LLM Chain.
- Gmail OAuth2 and Google Sheets OAuth2 credentials.
- Groq and OpenRouter API credentials. Access, quotas and any charges are managed in your own accounts.
- Two controlled Gmail accounts and a Google Sheet of synthetic orders.
- A dedicated Supabase PostgreSQL ledger, the supplied SQL, and a restricted Postgres credential using SSL.
- An n8n API credential for recovery, to read prior execution evidence.

The accepted configuration uses Groq `qwen/qwen3.8-27b` and OpenRouter `openrouter/free`. Confirm model availability and compatibility in your account before running. The free router's underlying model may vary.

## Quick start

This is the short version. The full steps are in the [setup and rebinding guide](docs/setup-and-rebinding.md).

1. Set up the ledger with the [database setup guide](docs/ledger-database-setup.md), the supplied SQL and the read-only preflight checks.
2. Import `GetOrder`, the main workflow and `RecoverOrderStatusRequest`. Keep all three inactive during setup.
3. Connect and verify credentials on every relevant node, including each model subnode and ledger node.
4. Import the sample orders into an `Orders` tab. Keep order numbers and delivery dates as text, and replace the example customer email with your controlled sender.
5. Select the spreadsheet in `GetOrder`, select the imported child in main, and bind recovery to the imported main.
6. Replace the example sender and receiver in both allowlists, and set the expected receiver in `VerifyMailboxAndSource`. Keep the sender-to-customer comparison enabled.
7. Create these labels in the receiver account and update every ID binding:
   - `order-status-reply-drafter/demo-input`
   - `order-status-reply-drafter/triaged`
   - `order-status-reply-drafter/needs-review`
8. Set your store name and sign-off, confirm there are no test pins, and publish `GetOrder` before main needs it. Keep recovery manual.
9. Run a supervised test: send a fresh controlled message with the input label applied on arrival, then inspect the draft or review outcome, the source labels and the ledger completion. Stop or unpublish main afterwards.

The sample sheet has the columns `order_number`, `customer_email`, `status`, `item`, `tracking_number` and `estimated_delivery`. Supported statuses are `processing`, `shipped` and `delivered`.

## Repository contents

| Item | Description |
| --- | --- |
| [`deliverables/main-workflow.json`](deliverables/main-workflow.json) | Main workflow |
| [`deliverables/get-order.json`](deliverables/get-order.json) | GetOrder sub-workflow |
| [`deliverables/reliability/recover-order-status-request.json`](deliverables/reliability/recover-order-status-request.json) | Manual recovery workflow |
| [`deliverables/sample-orders.csv`](deliverables/sample-orders.csv) | Synthetic sample orders |
| [`database/order-status-ledger.sql`](database/order-status-ledger.sql) | Ledger setup SQL |
| [`database/verify-order-status-ledger.sql`](database/verify-order-status-ledger.sql) | Read-only preflight checks |
| [`docs/setup-and-rebinding.md`](docs/setup-and-rebinding.md) | Setup and rebinding guide |
| [`docs/ledger-database-setup.md`](docs/ledger-database-setup.md) | Database setup |
| [`docs/order-status-recovery-guide.md`](docs/order-status-recovery-guide.md) | Operator recovery guide |
| [`docs/idempotency-recovery-record.md`](docs/idempotency-recovery-record.md) | Current verification record |
| [`deliverables/reliability/verification-results.json`](deliverables/reliability/verification-results.json) | Sanitized verification results |
| [`docs/system-design.md`](docs/system-design.md) | As-built system design |
| [`deliverables/regression/`](deliverables/regression/README.md) | Optional policy/model tests and actual-main regression tools |
| [`client-handoff/`](client-handoff/README.md) | Self-contained handoff package: sanitized inactive exports, SQL, sample data, guides and reusable tests |

Main depends on `GetOrder` and the database, and recovery calls back into main. The regression and test workflows are optional and have extra bindings described in their own guide.

## Tested behavior

The final controlled regression passed **10/10 cases on 20 October 2026**: six drafts and four manual-review outcomes, with all six drafts confirmed usable. It covered:

- shipped, processing and delivered orders,
- missing and unknown order numbers,
- refund requests,
- an instruction-override request,
- sender mismatch,
- multiple orders,
- quoted email history.

Focused reliability proofs verified overlapping intake exclusion, recovery using the same saved draft, review-label recovery, completed-source skipping and refusal of uncertain creation. The uncertain-write proof used an actual Gmail draft creation with simulated loss of its returned-ID checkpoint. These proofs and the final regression used 13 fresh controlled sources and sent **zero customer replies**.

| Evidence layer | Result |
| --- | --- |
| Local logic cases | 246 cases plus three audits |
| Recovery checks | 57 |
| Observer/control checks | 107 |
| Real model-stage evaluation | 8 cases passed on the recorded model configuration |

These are different test layers, not additional live email scenarios. Actual fallback calls were verified in earlier component testing. The final regression used Groq and does not establish a new final-version provider-outage test.

## Limitations

- Plain-text English only, one order per message, no attachments.
- Quoted history removal is simple: it drops lines beginning with `>`.
- Sender matching checks consistency. **It is not customer authentication.**
- Draft checks catch specific patterns, not every unsupported claim or unsafe output. **Read every draft.**
- The ledger and Gmail are not one transaction, and the ledger cannot fence an already-running Gmail request. This is **not** a universal exactly-once guarantee.
- Technical failures stay as unfinished work until reconciled. There is no automatic recovery, monitoring dashboard or alerting service.
- Retain completed ledger keys and follow the recovery guide rather than deleting rows to retry.
- There is no live store API connection.
- Clean-room import into a fresh n8n instance and production deployment have not been tested.

## Customization

- Change the store name and sign-off without changing the routing.
- The separate lookup contract is a boundary for a future order-data integration. A replacement data source must return the same validated outcomes and be tested before use.

## Demo videos

Public links will be added here once they are hosted.


## Author

**Micko Sugianto**: automation engineer, n8n and AI workflows, e-commerce operations.

- GitHub: [mickoSugianto](https://github.com/mickoSugianto)
- LinkedIn: [micko-sugianto](https://linkedin.com/in/micko-sugianto)

Feedback on the routing, readability and setup experience is welcome. Open an issue or get in touch.

